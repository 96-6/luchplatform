import { fixturePassword, fixturePasswordHash, passwordLogin } from './helpers/password.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentPackageSchema,
  diagnosticViewSchema,
  profileViewSchema,
  runViewSchema,
  submitResultSchema,
  type Answer,
  type RunView,
  type Questionnaire,
  type User,
} from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings, projectRoot } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { AccountCrypto, createTotp } from '../src/modules/auth/crypto.js';
import { publicUser, type UserRow } from '../src/modules/accounts/repository.js';
import { seedDemoContent } from '../src/modules/content/bootstrap.js';
import { ContentService } from '../src/modules/content/service.js';
import { LuchEngine } from '../src/modules/engine/service.js';
import type { Actor } from '../src/modules/auth/service.js';

const settings = parseSettings({
  APP_ENV: 'test',
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
  LOG_LEVEL: 'silent',
});
if (
  process.env.TEST_DATABASE_URL &&
  !new URL(process.env.TEST_DATABASE_URL).pathname.includes('test')
)
  throw new Error('Use an isolated test database.');
const crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
let db: Database,
  app: Awaited<ReturnType<typeof buildApp>>,
  demo: ReturnType<typeof contentPackageSchema.parse>;
beforeAll(async () => {
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db);
  demo = contentPackageSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, 'content/demo/luch-demo.json'), 'utf8')),
  );
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE users,content_packages CASCADE; INSERT INTO security_policy (id,captcha_enabled) VALUES (1,false)',
  );
  await seedDemoContent(db);
});
afterAll(async () => {
  await db.exec('UPDATE security_policy SET captcha_enabled=true');
  await app.close();
});
type Login = {
  headers: { cookie: string; 'x-csrf-token': string };
  actor: Actor;
  secret: string;
  email: string;
};
async function active(role: User['role'] = 'student'): Promise<Login> {
  const id = randomUUID(),
    email = `diagnostic-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  const user = (
    await db.query<UserRow>(
      'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES ($1,$2,$3,$4,now(),now(),$5,true,$6,now()) RETURNING *',
      [id, email, 'Диагностика', role, crypto.encrypt(secret), await fixturePasswordHash(crypto)],
    )
  ).rows[0]!;
  const response = await passwordLogin(app, {
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: createTotp(email, secret).generate() },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    headers: {
      cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
      'x-csrf-token': response.json().data.csrfToken,
    },
    actor: { user: publicUser(user), tokenHash: 'test', sessionId: randomUUID() },
    email,
    secret,
  };
}
const questionnaire: Questionnaire = {
  language: 'ru',
  goal: 'daily_life',
  experience: 'none',
  minutesPerDay: 20,
};
async function save(user: Login, data = questionnaire, revision = 0, userId?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/learning/profile',
    headers: user.headers,
    payload: { ...data, revision, ...(userId ? { userId } : {}) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return profileViewSchema.parse(response.json().data);
}
async function start(user: Login, restart = false, profileRevision = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/diagnostics',
    headers: user.headers,
    payload: { profileRevision, restart },
  });
  expect(response.statusCode, response.body).toBe(200);
  return diagnosticViewSchema.parse(response.json().data);
}
async function view(user: Login, runId: string) {
  const response = await app.inject({ url: `/api/v1/engine/runs/${runId}`, headers: user.headers });
  expect(response.statusCode, response.body).toBe(200);
  return runViewSchema.parse(response.json().data);
}
function answerFor(run: RunView, correct: boolean): Answer {
  const exercise = demo.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (exercise.response.type !== 'choice' || exercise.solution.type !== 'choice')
    throw new Error('Choice bank required.');
  return {
    type: 'choice',
    optionId: exercise.response.options.find(
      (o) =>
        exercise.solution.type === 'choice' &&
        exercise.solution.correctOptionIds.includes(o.id) === correct,
    )!.id,
  };
}
async function submit(user: Login, run: RunView, correct: boolean) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${run.run.id}/answer`,
    headers: user.headers,
    payload: {
      turnId: run.current!.turn.id,
      operationId: randomUUID(),
      answer: answerFor(run, correct),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return submitResultSchema.parse(response.json().data).view;
}
async function next(user: Login, run: RunView) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${run.run.id}/next`,
    headers: user.headers,
    payload: { turnId: run.current!.turn.id },
  });
  expect(response.statusCode, response.body).toBe(200);
  return runViewSchema.parse(response.json().data);
}
async function finish(user: Login, id: string, answers: boolean[]) {
  let run = await view(user, id);
  while (run.current) {
    run = await submit(user, run, answers[run.current.position] ?? false);
    run = await next(user, run);
  }
  return run;
}
async function result(user: Login, id: string) {
  const response = await app.inject({ url: `/api/v1/diagnostics/${id}`, headers: user.headers });
  expect(response.statusCode, response.body).toBe(200);
  return diagnosticViewSchema.parse(response.json().data);
}

describe('questionnaire and entry diagnostics', () => {
  it('saves all questionnaire fields, rejects invalid values and preserves previous data', async () => {
    const student = await active();
    expect(
      (await app.inject({ url: '/api/v1/learning/profile', headers: student.headers })).json().data
        .profile,
    ).toBeNull();
    const saved = await save(student, {
      language: 'en',
      goal: 'travel',
      experience: 'some',
      minutesPerDay: 35,
    });
    expect(saved.profile).toMatchObject({
      language: 'en',
      goal: 'travel',
      experience: 'some',
      minutesPerDay: 35,
      revision: 1,
    });
    for (const fields of [
      { language: 'de' },
      { goal: 'unknown' },
      { experience: 'fluent' },
      { minutesPerDay: 0 },
      { minutesPerDay: 121 },
      { minutesPerDay: 5.5 },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/learning/profile',
            headers: student.headers,
            payload: { ...questionnaire, revision: 1, ...fields },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (await app.inject({ url: '/api/v1/learning/profile', headers: student.headers })).json().data
        .profile,
    ).toEqual(saved.profile);
  });
  it('handles duplicate saves and stale/concurrent profile changes without lost updates', async () => {
    const student = await active();
    await save(student);
    await save(student);
    expect((await db.query('SELECT * FROM student_profile_revisions')).rows).toHaveLength(1);
    const changes = await Promise.all(
      [30, 45].map((minutesPerDay) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/learning/profile',
          headers: student.headers,
          payload: { ...questionnaire, revision: 1, minutesPerDay },
        }),
      ),
    );
    expect(changes.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await db.query('SELECT * FROM student_profile_revisions')).rows).toHaveLength(2);
  });
  it('requires a saved current profile and server authorization for starting diagnostics', async () => {
    const student = await active(),
      teacher = await active('teacher');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/diagnostics',
          headers: student.headers,
          payload: { profileRevision: 1 },
        })
      ).statusCode,
    ).toBe(409);
    await save(student);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/diagnostics',
          headers: student.headers,
          payload: { profileRevision: 2 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/diagnostics',
          headers: { cookie: student.headers.cookie },
          payload: { profileRevision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/learning/profile', headers: teacher.headers })).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: '/api/v1/diagnostics' })).statusCode).toBe(401);
  });
  it('different answers produce different persisted results for six separate skills', async () => {
    const successful = await active(),
      struggling = await active();
    await save(successful);
    await save(struggling);
    const a = await start(successful),
      b = await start(struggling);
    expect((await view(successful, a.diagnostic.runId)).run.diagnosticId).toBe(a.diagnostic.id);
    await finish(successful, a.diagnostic.runId, [true, true, true, true, true, true]);
    await finish(struggling, b.diagnostic.runId, [false, false, false, false, false, false]);
    const good = (await result(successful, a.diagnostic.id)).result!,
      poor = (await result(struggling, b.diagnostic.id)).result!;
    expect(good).toMatchObject({ preliminary: true, correct: 6, percent: 100 });
    expect(poor).toMatchObject({ preliminary: true, correct: 0, percent: 0 });
    expect(good.skills).toHaveLength(6);
    expect(good.strengthIds).toHaveLength(6);
    expect(poor.difficultyIds).toHaveLength(6);
    expect(good.skills.every((s) => s.independentCorrect === 1)).toBe(true);
    expect((await db.query('SELECT * FROM diagnostic_skill_results')).rows).toHaveLength(12);
    expect(await result(successful, a.diagnostic.id)).toEqual(
      await result(successful, a.diagnostic.id),
    );
  });
  it('keeps partial grades private and exposes only permitted students to teachers/admin', async () => {
    const student = await active(),
      other = await active(),
      teacher = await active('teacher'),
      admin = await active('superadmin');
    await save(student);
    const d = await start(student);
    let run = await view(student, d.diagnostic.runId);
    run = await submit(student, run, false);
    expect(run.attempts[0]!.evaluation).toBeNull();
    expect((await result(student, d.diagnostic.id)).result).toBeNull();
    expect(
      (await app.inject({ url: `/api/v1/diagnostics/${d.diagnostic.id}`, headers: other.headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/diagnostics?userId=${student.actor.user.id}`,
          headers: teacher.headers,
        })
      ).statusCode,
    ).toBe(404);
    await db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      student.actor.user.id,
    ]);
    expect((await result(teacher, d.diagnostic.id)).writable).toBe(false);
    expect((await result(admin, d.diagnostic.id)).writable).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/learning/profile',
          headers: teacher.headers,
          payload: { ...questionnaire, revision: 1, userId: student.actor.user.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/learning/profile?userId=${other.actor.user.id}`,
          headers: teacher.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('resumes answers/drafts after logout and produces a mixed English diagnostic', async () => {
    const student = await active();
    await save(student, { ...questionnaire, language: 'en', goal: 'work' });
    const d = await start(student);
    let run = await view(student, d.diagnostic.runId);
    run = await submit(student, run, true);
    run = await next(student, run);
    const draft = answerFor(run, false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${run.run.id}/save`,
          headers: student.headers,
          payload: { turnId: run.current!.turn.id, revision: 1, draftAnswer: draft, paused: true },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: student.headers,
      payload: {},
    });
    const logged = await passwordLogin(app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: student.email,
        code: createTotp(student.email, student.secret).generate({ timestamp: Date.now() + 30000 }),
      },
    });
    expect(logged.statusCode, logged.body).toBe(200);
    student.headers = {
      cookie: `luch_session=${logged.cookies.find((c) => c.name === 'luch_session')!.value}`,
      'x-csrf-token': logged.json().data.csrfToken,
    };
    expect((await start(student)).diagnostic.id).toBe(d.diagnostic.id);
    run = await view(student, run.run.id);
    expect(run.current!.position).toBe(1);
    expect(run.current!.turn.draftAnswer).toEqual(draft);
    expect(run.attempts).toHaveLength(1);
    await finish(student, run.run.id, [true, false, true, false, true, false]);
    const report = (await result(student, d.diagnostic.id)).result!;
    expect(report.correct).toBe(3);
    expect(report.strengthIds).toHaveLength(3);
    expect(report.difficultyIds).toHaveLength(3);
  });
  it('deduplicates simultaneous starts and repeated final transitions', async () => {
    const student = await active();
    await save(student);
    const starts = await Promise.all([start(student), start(student), start(student)]);
    expect(new Set(starts.map((s) => s.diagnostic.id)).size).toBe(1);
    const d = starts[0]!;
    let run = await view(student, d.diagnostic.runId),
      lastTurn = '';
    while (run.current) {
      run = await submit(student, run, true);
      lastTurn = run.current!.turn.id;
      run = await next(student, run);
    }
    const original = await result(student, d.diagnostic.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${run.run.id}/next`,
          headers: student.headers,
          payload: { turnId: lastTurn },
        })
      ).statusCode,
    ).toBe(200);
    expect(await result(student, d.diagnostic.id)).toEqual(original);
    expect((await db.query('SELECT * FROM diagnostic_sessions')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM diagnostic_skill_results')).rows).toHaveLength(6);
  });
  it('preserves questionnaire snapshots through language changes and new cycles', async () => {
    const student = await active();
    await save(student);
    const ru = await start(student);
    await save(student, { ...questionnaire, language: 'en', goal: 'study' }, 1);
    const en = await start(student, false, 2);
    expect(en.diagnostic.questionnaire).toMatchObject({ language: 'en', goal: 'study' });
    expect((await result(student, ru.diagnostic.id)).diagnostic.questionnaire).toEqual(
      questionnaire,
    );
    await finish(student, ru.diagnostic.runId, [true, true, true, true, true, true]);
    await save(student, { ...questionnaire, goal: 'travel' }, 2);
    expect((await start(student, false, 3)).diagnostic.id).toBe(ru.diagnostic.id);
    const fresh = await start(student, true, 3);
    expect(fresh.diagnostic.id).not.toBe(ru.diagnostic.id);
    expect(fresh.diagnostic.questionnaire.goal).toBe('travel');
    await finish(student, fresh.diagnostic.runId, [false, false, false, false, false, false]);
    expect((await result(student, ru.diagnostic.id)).result!.correct).toBe(6);
    expect((await result(student, fresh.diagnostic.id)).result!.correct).toBe(0);
  });
  it('pins the diagnostic bank while newer content revisions are published', async () => {
    const student = await active();
    await save(student);
    const old = await start(student);
    const newer = structuredClone(demo);
    newer.package.version = 2;
    const changed = newer.exercises.find((e) => e.id === 'rki-01-diagnostic')!;
    changed.version++;
    changed.rubric.version++;
    changed.explanation += ' Редакция 2.';
    await new ContentService(db).import(newer);
    await finish(student, old.diagnostic.runId, [true, true, true, true, true, true]);
    const report = await result(student, old.diagnostic.id);
    expect(report.diagnostic.packageVersion).toBe(1);
    expect(report.result!.correct).toBe(6);
    const fresh = await start(student, true);
    expect(fresh.diagnostic.packageVersion).toBe(2);
  });
  it('rolls back lesson completion if saving the diagnostic result fails', async () => {
    const student = await active();
    await save(student);
    const d = await start(student);
    let run = await view(student, d.diagnostic.runId);
    while (run.current!.position < 5) {
      run = await submit(student, run, true);
      run = await next(student, run);
    }
    run = await submit(student, run, true);
    const failing: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: async (sql, params) => {
              if (sql.includes('INSERT INTO diagnostic_skill_results'))
                throw new Error('temporary storage failure');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(
      new LuchEngine(failing).next(student.actor, run.run.id, run.current!.turn.id),
    ).rejects.toThrow('temporary storage failure');
    expect((await view(student, run.run.id)).run.status).toBe('active');
    expect((await result(student, d.diagnostic.id)).result).toBeNull();
    expect((await db.query('SELECT * FROM diagnostic_skill_results')).rows).toHaveLength(0);
    await next(student, run);
    expect((await result(student, d.diagnostic.id)).result!.correct).toBe(6);
  });
});
