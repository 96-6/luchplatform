import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  contentPackageSchema,
  integrityStatsSchema,
  runViewSchema,
  startRunSchema,
  submitResultSchema,
  type Answer,
  type ContentPackage,
  type Exercise,
  type RunView,
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
import { evaluate } from '../src/modules/engine/evaluator.js';
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
let db: Database, app: Awaited<ReturnType<typeof buildApp>>, demo: ContentPackage;
beforeAll(async () => {
  demo = contentPackageSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, 'content/demo/luch-demo.json'), 'utf8')),
  );
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db);
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE users CASCADE; INSERT INTO security_policy (id,captcha_enabled) VALUES (1,false)',
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
  email: string;
  secret: string;
};
async function active(
  role: User['role'] = 'student',
  database = db,
  application = app,
): Promise<Login> {
  const id = randomUUID(),
    email = `engine-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  const result = await database.query<UserRow>(
    'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true) RETURNING *',
    [id, email, `Engine ${role}`, role, crypto.encrypt(secret)],
  );
  const response = await application.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: createTotp(email, secret).generate() },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    headers: {
      cookie: `luch_session=${response.cookies.find((cookie) => cookie.name === 'luch_session')!.value}`,
      'x-csrf-token': response.json().data.csrfToken,
    },
    actor: { user: publicUser(result.rows[0]!), sessionId: randomUUID(), tokenHash: 'test' },
    email,
    secret,
  };
}
async function start(user: Login, lessonId = 'rki-01', purpose = 'practice', application = app) {
  const response = await application.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: user.headers,
    payload: {
      packageId: 'luch-demo',
      packageVersion: 1,
      source: { type: 'lesson', id: lessonId, purpose },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return runViewSchema.parse(response.json().data);
}
const exerciseOf = (view: RunView) =>
  demo.exercises.find((exercise) => exercise.id === view.current!.exercise.id)!;
const correct = (exercise: Exercise): Answer =>
  exercise.solution.type === 'choice'
    ? { type: 'choice', optionId: exercise.solution.correctOptionIds[0]! }
    : { type: 'short_text', text: exercise.solution.accepted[0]! };
const wrong = (exercise: Exercise): Answer =>
  exercise.response.type === 'choice'
    ? {
        type: 'choice',
        optionId: exercise.response.options.find(
          (option) =>
            exercise.solution.type === 'choice' &&
            !exercise.solution.correctOptionIds.includes(option.id),
        )!.id,
      }
    : { type: 'short_text', text: 'incorrect answer' };
async function answer(
  user: Login,
  view: RunView,
  value = correct(exerciseOf(view)),
  application = app,
) {
  const response = await application.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${view.run.id}/answer`,
    headers: user.headers,
    payload: { turnId: view.current!.turn.id, operationId: randomUUID(), answer: value },
  });
  expect(response.statusCode, response.body).toBe(200);
  return submitResultSchema.parse(response.json().data);
}
async function action(user: Login, view: RunView, kind = 'next', application = app) {
  const response = await application.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${view.run.id}/${kind}`,
    headers: user.headers,
    payload: { turnId: view.current!.turn.id },
  });
  expect(response.statusCode, response.body).toBe(200);
  return runViewSchema.parse(response.json().data);
}
async function count(table: string) {
  return Number(
    (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]!
      .count,
  );
}

describe('luch engine acceptance', () => {
  it('checks choice and text on the server and completes both language lessons', async () => {
    const user = await active();
    for (const lesson of ['rki-01', 'english-01']) {
      let view = await start(user, lesson);
      expect(view.material.length).toBeGreaterThan(0);
      expect(view.debug).toBeNull();
      expect(JSON.stringify(view)).not.toMatch(/"(?:solution|explanation|rubric)":/);
      const rejected = await answer(user, view, wrong(exerciseOf(view)));
      expect(rejected.attempt.evaluation?.correct).toBe(false);
      expect(rejected.attempt.evaluation?.explanation).toBe(exerciseOf(view).explanation);
      view = await action(user, rejected.view, 'retry');
      const retried = await answer(user, view);
      expect(retried.attempt.evaluation?.correct).toBe(true);
      expect(retried.attempt.hadPriorFeedback).toBe(true);
      expect(retried.attempt.independent).toBe(false);
      view = await action(user, retried.view);
      expect(view.current!.exercise.response.type).toBe('short_text');
      const accepted = await answer(user, view);
      expect(accepted.attempt.evaluation?.correct).toBe(true);
      view = await action(user, accepted.view);
      expect(view.run.status).toBe('completed');
      expect(view.current).toBeNull();
      expect(view.attempts).toHaveLength(3);
      expect((await start(user, lesson)).run.id).toBe(view.run.id);
    }
    expect(await count('engine_attempts')).toBe(6);
    expect(await count('engine_events')).toBe(6);
  });
  it('stores a hint once, records help and separates server timing from a paused break', async () => {
    const user = await active();
    let now = Date.now();
    const engine = new LuchEngine(db, () => now);
    let view = await engine.start(
      user.actor,
      startRunSchema.parse({ packageId: 'luch-demo', source: { type: 'lesson', id: 'rki-01' } }),
    );
    const id = view.current!.turn.id;
    now += 2000;
    view = await engine.hint(user.actor, view.run.id, id, 0);
    await engine.hint(user.actor, view.run.id, id, 0);
    expect(view.current!.turn.usedHints).toHaveLength(1);
    now += 3000;
    await engine.save(user.actor, view.run.id, {
      turnId: id,
      draftAnswer: correct(exerciseOf(view)),
      revision: 1,
      paused: true,
    });
    now += 120000;
    view = await engine.repository.view(user.actor, view.run.id);
    expect(view.current!.turn.activeMilliseconds).toBe(5000);
    expect(view.current!.turn.paused).toBe(true);
    await engine.resume(user.actor, view.run.id, id);
    now += 1000;
    const result = await engine.answer(user.actor, view.run.id, {
      turnId: id,
      operationId: randomUUID(),
      answer: correct(exerciseOf(view)),
    });
    expect(result.attempt.activeMilliseconds).toBe(6000);
    expect(result.attempt.elapsedMilliseconds).toBe(126000);
    expect(result.attempt.usedHints).toHaveLength(1);
    expect(result.attempt.independent).toBe(false);
    expect(result.attempt.evaluation?.correct).toBe(true);
  });
  it('caps unknown offline activity and never uses time to lower the learning grade', async () => {
    const user = await active();
    let now = Date.now();
    const engine = new LuchEngine(db, () => now);
    const view = await engine.start(
      user.actor,
      startRunSchema.parse({
        packageId: 'luch-demo',
        source: { type: 'lesson', id: 'english-01' },
      }),
    );
    now += 3600000;
    const result = await engine.answer(user.actor, view.run.id, {
      turnId: view.current!.turn.id,
      operationId: randomUUID(),
      answer: correct(exerciseOf(view)),
    });
    expect(result.attempt.activeMilliseconds).toBe(30000);
    expect(result.attempt.elapsedMilliseconds).toBe(3600000);
    expect(result.attempt.evaluation?.score).toBe(1);
  });
  it('preserves drafts and rejects a stale revision or stale turn without changing answers', async () => {
    const user = await active();
    let view = await start(user);
    const base = `/api/v1/engine/runs/${view.run.id}`;
    const draft = correct(exerciseOf(view));
    const saved = await app.inject({
      method: 'POST',
      url: `${base}/save`,
      headers: user.headers,
      payload: { turnId: view.current!.turn.id, draftAnswer: draft, revision: 2, paused: true },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.current.turn.draftAnswer).toEqual(draft);
    for (const revision of [1, 2])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/save`,
            headers: user.headers,
            payload: {
              turnId: view.current!.turn.id,
              draftAnswer: wrong(exerciseOf(view)),
              revision,
              paused: false,
            },
          })
        ).statusCode,
      ).toBe(409);
    const originalTurn = view.current!.turn.id;
    view = (await answer(user, view, draft)).view;
    view = await action(user, view);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/save`,
          headers: user.headers,
          payload: { turnId: originalTurn, draftAnswer: draft, revision: 3 },
        })
      ).statusCode,
    ).toBe(409);
    expect(view.current!.turn.draftAnswer).toBeNull();
    expect(await count('engine_attempts')).toBe(1);
  });
  it('makes repeated and concurrent answers and advances idempotent', async () => {
    const user = await active();
    const view = await start(user),
      base = `/api/v1/engine/runs/${view.run.id}`;
    const payload = {
      turnId: view.current!.turn.id,
      operationId: randomUUID(),
      answer: correct(exerciseOf(view)),
    };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'POST', url: `${base}/answer`, headers: user.headers, payload }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.json().data.attempt.id)).size).toBe(1);
    expect(await count('engine_events')).toBe(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/answer`,
          headers: user.headers,
          payload: { ...payload, answer: wrong(exerciseOf(view)) },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/answer`,
          headers: user.headers,
          payload: { ...payload, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: 'POST',
          url: `${base}/next`,
          headers: user.headers,
          payload: { turnId: view.current!.turn.id },
        }),
      ),
    );
    const refreshed = runViewSchema.parse(
      (await app.inject({ url: base, headers: user.headers })).json().data,
    );
    expect(refreshed.current!.position).toBe(1);
    expect(await count('engine_attempts')).toBe(1);
  });
  it('serializes lesson starts and operation keys even across different runs', async () => {
    const user = await active();
    const starts = await Promise.all([start(user), start(user), start(user)]);
    expect(new Set(starts.map((view) => view.run.id)).size).toBe(1);
    const other = await start(user, 'english-01'),
      operationId = randomUUID();
    const responses = await Promise.all(
      [starts[0]!, other].map((view) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${view.run.id}/answer`,
          headers: user.headers,
          payload: {
            turnId: view.current!.turn.id,
            operationId,
            answer: correct(exerciseOf(view)),
          },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await count('engine_attempts')).toBe(1);
  });
  it('keeps control and diagnostic banks closed until completion and disables all help', async () => {
    const user = await active(),
      admin = await active('superadmin');
    for (const setId of ['rki-control', 'english-diagnostic']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/engine/runs',
        headers: user.headers,
        payload: { packageId: 'luch-demo', source: { type: 'set', id: setId } },
      });
      let view = runViewSchema.parse(response.json().data);
      expect(view.run.totalSteps).toBe(6);
      expect(view.material).toEqual([]);
      while (view.current) {
        const denied = await app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${view.run.id}/hint`,
          headers: user.headers,
          payload: { turnId: view.current.turn.id, index: 0 },
        });
        expect(denied.statusCode).toBe(403);
        const result = await answer(user, view);
        expect(result.attempt.evaluation).toBeNull();
        expect(result.view.debug).toBeNull();
        const privileged = runViewSchema.parse(
          (
            await app.inject({ url: `/api/v1/engine/runs/${view.run.id}`, headers: admin.headers })
          ).json().data,
        );
        expect(privileged.attempts.at(-1)!.evaluation?.correct).toBe(true);
        expect(privileged.debug).not.toBeNull();
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/v1/engine/runs/${view.run.id}/retry`,
              headers: user.headers,
              payload: { turnId: view.current.turn.id },
            })
          ).statusCode,
        ).toBe(403);
        view = await action(user, result.view);
      }
      expect(view.attempts.every((attempt) => attempt.evaluation?.correct)).toBe(true);
    }
  });
  it('allows only the owner, assigned teacher and superadmin to read; admin can act with attribution', async () => {
    const user = await active(),
      foreign = await active(),
      teacher = await active('teacher'),
      unrelated = await active('teacher'),
      admin = await active('superadmin');
    await db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      user.actor.user.id,
    ]);
    const view = await start(user),
      url = `/api/v1/engine/runs/${view.run.id}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    for (const actor of [foreign, unrelated])
      expect((await app.inject({ url, headers: actor.headers })).statusCode).toBe(404);
    const read = runViewSchema.parse(
      (await app.inject({ url, headers: teacher.headers })).json().data,
    );
    expect(read.writable).toBe(false);
    expect(read.debug).toBeNull();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/answer`,
          headers: teacher.headers,
          payload: {
            turnId: view.current!.turn.id,
            operationId: randomUUID(),
            answer: correct(exerciseOf(view)),
          },
        })
      ).statusCode,
    ).toBe(403);
    const result = await answer(admin, view);
    expect(result.attempt.submittedBy).toBe(admin.actor.user.id);
    expect(result.attempt.submittedFor).toBe(user.actor.user.id);
    expect(result.attempt.adminAssistance).toBe(true);
    expect(result.attempt.independent).toBe(false);
    const detail = await app.inject({
      url: `/api/v1/admin/accounts/${user.actor.user.id}`,
      headers: admin.headers,
    });
    expect(detail.json().data.progress.attempts).toBe(1);
    expect(detail.json().data.progress.correctAttempts).toBe(1);
    expect(detail.json().data.progress.assistedAttempts).toBe(1);
    expect(
      (
        await db.query(
          'SELECT id FROM security_audit WHERE actor_id=$1 AND target_id=$2 AND action=$3',
          [admin.actor.user.id, user.actor.user.id, 'learning.answer_submitted'],
        )
      ).rows,
    ).toHaveLength(1);
    let following = await action(admin, result.view);
    following = await new LuchEngine(db).save(admin.actor, following.run.id, {
      turnId: following.current!.turn.id,
      draftAnswer: correct(exerciseOf(following)),
      revision: 1,
      paused: true,
    });
    const byOwner = await answer(user, following);
    expect(byOwner.attempt.submittedBy).toBe(user.actor.user.id);
    expect(byOwner.attempt.adminAssistance).toBe(true);
    expect(byOwner.attempt.independent).toBe(false);
    for (const actor of [user, foreign])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/engine/runs',
            headers: actor.headers,
            payload: {
              packageId: 'luch-demo',
              userId: admin.actor.user.id,
              source: { type: 'lesson', id: 'rki-01' },
            },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('paginates all admin runs while keeping learner and teacher lists scoped', async () => {
    const one = await active(),
      two = await active(),
      admin = await active('superadmin'),
      teacher = await active('teacher');
    await db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      one.actor.user.id,
    ]);
    await start(one);
    await start(one, 'rki-02');
    await start(two, 'english-01');
    for (const [actor, size] of [
      [one, 2],
      [two, 1],
      [teacher, 2],
    ] as const)
      expect(
        (await app.inject({ url: '/api/v1/engine/runs', headers: actor.headers })).json().data
          .items,
      ).toHaveLength(size);
    const first = (
      await app.inject({ url: '/api/v1/engine/runs?limit=2', headers: admin.headers })
    ).json().data;
    expect(first.items).toHaveLength(2);
    const cursor = first.nextCursor;
    const second = (
      await app.inject({
        url: `/api/v1/engine/runs?limit=2&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
        headers: admin.headers,
      })
    ).json().data;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await app.inject({
          url: `/api/v1/engine/runs?userId=${two.actor.user.id}`,
          headers: one.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('pins in-progress content and answers to their published revision', async () => {
    const user = await active();
    const view = await start(user);
    const changed = structuredClone(demo);
    changed.package.version = 2;
    const exercise = changed.exercises.find((item) => item.id === view.current!.exercise.id)!;
    exercise.version = 2;
    exercise.explanation = 'Новое объяснение.';
    if (exercise.solution.type === 'choice')
      exercise.solution.correctOptionIds = [(wrong(exercise) as { optionId: string }).optionId];
    await new ContentService(db).import(changed);
    const result = await answer(user, view);
    expect(result.attempt.evaluation?.correct).toBe(true);
    expect(result.attempt.evaluation?.explanation).toBe(exerciseOf(view).explanation);
    expect(result.view.run.packageVersion).toBe(1);
  });
  it('restarts completed training as a new run and keeps the original evidence', async () => {
    const user = await active();
    let view = await start(user);
    while (view.current) view = await action(user, (await answer(user, view)).view);
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/engine/runs',
      headers: user.headers,
      payload: {
        packageId: 'luch-demo',
        packageVersion: 1,
        source: { type: 'lesson', id: 'rki-01' },
        restart: true,
      },
    });
    const repeated = runViewSchema.parse(result.json().data);
    expect(repeated.run.cycle).toBe(2);
    expect(repeated.run.id).not.toBe(view.run.id);
    expect(repeated.current!.turn.draftAnswer).toBeNull();
    const attempt = await answer(user, repeated);
    expect(attempt.attempt.hadPriorFeedback).toBe(true);
    expect(attempt.attempt.independent).toBe(false);
    expect(await count('engine_attempts')).toBe(3);
  });
  it('does not record technical validation failures or accept forged grading and assistance', async () => {
    const user = await active();
    const view = await start(user),
      url = `/api/v1/engine/runs/${view.run.id}/answer`,
      common = { turnId: view.current!.turn.id, operationId: randomUUID() };
    for (const answer of [
      { type: 'choice', optionId: 'missing' },
      { type: 'short_text', text: 'x' },
      {
        type: 'choice',
        optionId: (correct(exerciseOf(view)) as { optionId: string }).optionId,
        correct: true,
      },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: user.headers,
            payload: { ...common, answer },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: user.headers,
          payload: { ...common, answer: correct(exerciseOf(view)), score: 1, usedHints: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie: user.headers.cookie },
          payload: { ...common, answer: correct(exerciseOf(view)) },
        })
      ).statusCode,
    ).toBe(403);
    expect(await count('engine_attempts')).toBe(0);
    expect(await count('engine_events')).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${view.run.id}/next`,
          headers: user.headers,
          payload: { turnId: view.current!.turn.id },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('rolls back attempts and feedback when event persistence fails', async () => {
    const user = await active();
    const view = await start(user);
    const failing: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: (sql, params) => {
              if (sql.startsWith('INSERT INTO engine_events'))
                throw new Error('Simulated storage failure');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(
      new LuchEngine(failing).answer(user.actor, view.run.id, {
        turnId: view.current!.turn.id,
        operationId: randomUUID(),
        answer: correct(exerciseOf(view)),
      }),
    ).rejects.toThrow('Simulated storage failure');
    expect(await count('engine_attempts')).toBe(0);
    expect(
      (await new LuchEngine(db).repository.view(user.actor, view.run.id)).current!.attempt,
    ).toBeNull();
    expect((await answer(user, view)).attempt.evaluation?.correct).toBe(true);
  });
  it('persists hidden integrity signals once, exposes them only to reviewers and keeps the grade', async () => {
    const user = await active(),
      admin = await active('superadmin');
    const view = await start(user),
      url = `/api/v1/engine/runs/${view.run.id}`;
    const payload = {
      turnId: view.current!.turn.id,
      batchId: randomUUID(),
      stats: integrityStatsSchema.parse({
        durationMilliseconds: 3000,
        hiddenMilliseconds: 1800,
        tabHides: 1,
        focusLosses: 1,
        returns: 1,
        pasteEvents: 1,
        pointerSamples: 30,
        pointerDistance: 4000,
        fastMoves: 10,
        straightMoves: 20,
        syntheticEvents: 5,
        pointerTypes: ['mouse'],
      }),
    };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/integrity`,
            headers: user.headers,
            payload,
          })
        ).statusCode,
      ).toBe(200);
    expect(await count('engine_integrity_packets')).toBe(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/integrity`,
          headers: user.headers,
          payload: { ...payload, stats: { ...payload.stats, pasteEvents: 2 } },
        })
      ).statusCode,
    ).toBe(409);
    const result = await answer(user, view);
    expect(result.attempt.evaluation?.score).toBe(1);
    expect(result.attempt.integrity).toBeNull();
    const privileged = runViewSchema.parse(
      (await app.inject({ url, headers: admin.headers })).json().data,
    );
    expect(privileged.attempts[0]!.integrity?.requiresReview).toBe(true);
    expect(privileged.attempts[0]!.integrity?.signals.map((signal) => signal.code)).toContain(
      'pointer_pattern',
    );
    expect(await count('engine_integrity_assessments')).toBe(1);
    const foreign = await active();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/integrity`,
          headers: foreign.headers,
          payload,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('allows keyboard/touch and missing telemetry, and honors the superadmin switch', async () => {
    const user = await active(),
      admin = await active('superadmin');
    let view = await start(user);
    const base = `/api/v1/engine/runs/${view.run.id}`;
    await app.inject({
      method: 'POST',
      url: `${base}/integrity`,
      headers: user.headers,
      payload: {
        turnId: view.current!.turn.id,
        batchId: randomUUID(),
        stats: {
          durationMilliseconds: 1000,
          pointerTypes: ['touch'],
          keyboardNavigation: true,
          syntheticEvents: 8,
        },
      },
    });
    await answer(user, view);
    let privileged = runViewSchema.parse(
      (await app.inject({ url: base, headers: admin.headers })).json().data,
    );
    expect(privileged.attempts[0]!.integrity?.requiresReview).toBe(false);
    expect(
      privileged.attempts[0]!.integrity?.signals.some(
        (signal) => signal.code === 'pointer_pattern',
      ),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/engine/integrity-policy',
          headers: user.headers,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/engine/integrity-policy',
          headers: admin.headers,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    view = await start(user, 'rki-02');
    const next = `/api/v1/engine/runs/${view.run.id}`;
    expect(view.integrityEnabled).toBe(false);
    const ignored = await app.inject({
      method: 'POST',
      url: `${next}/integrity`,
      headers: user.headers,
      payload: {
        turnId: view.current!.turn.id,
        batchId: randomUUID(),
        stats: { durationMilliseconds: 1000, pasteEvents: 5, tabHides: 5 },
      },
    });
    expect(ignored.json().data.monitored).toBe(false);
    const result = await answer(user, view);
    expect(result.attempt.evaluation?.correct).toBe(true);
    privileged = runViewSchema.parse(
      (await app.inject({ url: next, headers: admin.headers })).json().data,
    );
    expect(privileged.attempts[0]!.integrity?.status).toBe('insufficient_data');
  });
});

it.each([
  ['trim/case/Unicode', ' \uFF29\uFF33  ', true],
  ['wrong text', 'are', false],
  ['whitespace only', '   ', null],
])('normalizes text using content rules: %s', (_name, value, expected) => {
  const exercise = structuredClone(
    demo.exercises.find((item) => item.id === 'english-01-practice-text')!,
  );
  if (expected === null)
    expect(() => evaluate(exercise, { type: 'short_text', text: value })).toThrow();
  else expect(evaluate(exercise, { type: 'short_text', text: value }).correct).toBe(expected);
  if (exercise.solution.type === 'short_text') {
    exercise.solution.accepted = [' IS '];
    exercise.solution.normalization.trim = false;
    exercise.solution.normalization.caseSensitive = true;
    exercise.solution.normalization.collapseWhitespace = false;
    expect(evaluate(exercise, { type: 'short_text', text: ' IS ' }).correct).toBe(true);
    expect(evaluate(exercise, { type: 'short_text', text: 'is' }).correct).toBe(false);
  }
});

it('retains a lesson, draft, hint and results after logout and a database/server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luch-engine-'));
  const diskSettings = { ...settings, DATABASE_URL: `pglite:${directory}/db` };
  let first: Awaited<ReturnType<typeof buildApp>> | undefined,
    second: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const database = await createDatabase(diskSettings);
    await migrate(database);
    await seedDemoContent(database);
    await database.exec('UPDATE security_policy SET captcha_enabled=false');
    first = await buildApp(diskSettings, database);
    const user = await active('student', database, first);
    let view = await start(user, 'rki-01', 'practice', first);
    await first.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${view.run.id}/hint`,
      headers: user.headers,
      payload: { turnId: view.current!.turn.id, index: 0 },
    });
    view = (await answer(user, view, correct(exerciseOf(view)), first)).view;
    view = await action(user, view, 'next', first);
    await first.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${view.run.id}/save`,
      headers: user.headers,
      payload: {
        turnId: view.current!.turn.id,
        draftAnswer: { type: 'short_text', text: 'зовут' },
        revision: 1,
        paused: true,
      },
    });
    await first.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: user.headers,
      payload: {},
    });
    await first.close();
    first = undefined;
    second = await buildApp(diskSettings, await createDatabase(diskSettings));
    const signed = await second.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: user.email,
        code: createTotp(user.email, user.secret).generate({ timestamp: Date.now() + 30000 }),
      },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const logged = {
      ...user,
      headers: {
        cookie: `luch_session=${signed.cookies.find((cookie) => cookie.name === 'luch_session')!.value}`,
        'x-csrf-token': signed.json().data.csrfToken,
      },
    };
    const restored = runViewSchema.parse(
      (
        await second.inject({ url: `/api/v1/engine/runs/${view.run.id}`, headers: logged.headers })
      ).json().data,
    );
    expect(restored.current!.position).toBe(1);
    expect(restored.current!.turn.draftAnswer).toEqual({ type: 'short_text', text: 'зовут' });
    expect(restored.attempts[0]!.usedHints).toHaveLength(1);
    const finished = await action(
      logged,
      (await answer(logged, restored, correct(exerciseOf(restored)), second)).view,
      'next',
      second,
    );
    expect(finished.run.status).toBe('completed');
    expect(finished.attempts).toHaveLength(2);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
