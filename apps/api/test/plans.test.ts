import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentPackageSchema,
  diagnosticViewSchema,
  planViewSchema,
  plansPageSchema,
  runViewSchema,
  submitResultSchema,
  type Answer,
  type Questionnaire,
  type RunView,
  type User,
} from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings, projectRoot } from '../src/config.js';
import { createDatabase, type Database, type QueryExecutor } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { publicUser, type UserRow } from '../src/modules/accounts/repository.js';
import { AccountCrypto, createTotp } from '../src/modules/auth/crypto.js';
import type { Actor } from '../src/modules/auth/service.js';
import { seedDemoContent } from '../src/modules/content/bootstrap.js';
import { ContentService } from '../src/modules/content/service.js';
import { LuchEngine } from '../src/modules/engine/service.js';
import { DiagnosticsService } from '../src/modules/diagnostics/service.js';
import { PlansService } from '../src/modules/plans/service.js';

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
  actor: Actor;
  headers: { cookie: string; 'x-csrf-token': string };
  email: string;
  secret: string;
};
async function active(role: User['role'] = 'student'): Promise<Login> {
  const id = randomUUID(),
    email = `plan-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  const row = (
    await db.query<UserRow>(
      'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true) RETURNING *',
      [id, email, 'План', role, crypto.encrypt(secret)],
    )
  ).rows[0]!;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: createTotp(email, secret).generate() },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    email,
    secret,
    actor: { user: publicUser(row), tokenHash: 'test', sessionId: randomUUID() },
    headers: {
      cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
      'x-csrf-token': response.json().data.csrfToken,
    },
  };
}
const questionnaire: Questionnaire = {
  language: 'ru',
  goal: 'daily_life',
  experience: 'none',
  minutesPerDay: 20,
};
async function profile(user: Login, fields: Partial<Questionnaire> = {}, revision = 0) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/learning/profile',
    headers: user.headers,
    payload: { ...questionnaire, ...fields, revision },
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function diagnostic(user: Login, restart = false, profileRevision = 1) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/diagnostics',
    headers: user.headers,
    payload: { restart, profileRevision },
  });
  expect(r.statusCode, r.body).toBe(200);
  return diagnosticViewSchema.parse(r.json().data);
}
async function view(user: Login, runId: string) {
  const r = await app.inject({ url: `/api/v1/engine/runs/${runId}`, headers: user.headers });
  expect(r.statusCode, r.body).toBe(200);
  return runViewSchema.parse(r.json().data);
}
function answerFor(run: RunView, correct: boolean): Answer {
  const e = demo.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.solution.type === 'short_text')
    return { type: 'short_text', text: correct ? e.solution.accepted[0]! : 'wrong' };
  if (e.response.type !== 'choice') throw new Error('Invalid bank');
  const solution = e.solution;
  return {
    type: 'choice',
    optionId: e.response.options.find((o) => solution.correctOptionIds.includes(o.id) === correct)!
      .id,
  };
}
async function submit(user: Login, run: RunView, correct: boolean) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${run.run.id}/answer`,
    headers: user.headers,
    payload: {
      turnId: run.current!.turn.id,
      operationId: randomUUID(),
      answer: answerFor(run, correct),
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return submitResultSchema.parse(r.json().data).view;
}
async function next(user: Login, run: RunView) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${run.run.id}/next`,
    headers: user.headers,
    payload: { turnId: run.current!.turn.id },
  });
  expect(r.statusCode, r.body).toBe(200);
  return runViewSchema.parse(r.json().data);
}
async function finish(user: Login, runId: string, answers = [true, true, true, true, true, true]) {
  let run = await view(user, runId);
  while (run.current) {
    if (!run.current.attempt) run = await submit(user, run, answers[run.current.position] ?? false);
    run = await next(user, run);
  }
  return run;
}
async function completedDiagnostic(user: Login, answers?: boolean[]) {
  const d = await diagnostic(user);
  await finish(user, d.diagnostic.runId, answers);
  const r = await app.inject({
    url: `/api/v1/diagnostics/${d.diagnostic.id}`,
    headers: user.headers,
  });
  return diagnosticViewSchema.parse(r.json().data);
}
async function plan(user: Login, id: string) {
  const r = await app.inject({ url: `/api/v1/plans/${id}`, headers: user.headers });
  expect(r.statusCode, r.body).toBe(200);
  return planViewSchema.parse(r.json().data);
}
async function start(user: Login, id: string, assignmentId: string) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/plans/${id}/assignments/${assignmentId}/start`,
    headers: user.headers,
    payload: {},
  });
  expect(r.statusCode, r.body).toBe(200);
  return runViewSchema.parse(r.json().data);
}
function failOn(prefix: string): Database {
  return {
    ...db,
    transaction: (callback) =>
      db.transaction((tx) => {
        const failing: QueryExecutor = {
          ...tx,
          async query(sql, parameters) {
            if (sql.startsWith(prefix)) throw new Error('Planned persistence failure');
            return tx.query(sql, parameters);
          },
        };
        return callback(failing);
      }),
  };
}

describe('initial individual plans', () => {
  it('preserves a diagnostic result if an imported route has no practice bank, without fabricating assignments', async () => {
    const s = await active(),
      root = await active('superadmin'),
      assessmentOnly = structuredClone(demo);
    assessmentOnly.package.version = 2;
    assessmentOnly.exercises = assessmentOnly.exercises.filter((e) => e.purpose !== 'practice');
    assessmentOnly.sets = assessmentOnly.sets.filter((s) => s.purpose !== 'practice');
    await new ContentService(db).import(assessmentOnly, root.actor.user.id);
    await profile(s);
    const d = await completedDiagnostic(s);
    expect(d.result!.correct).toBe(6);
    expect(d.planId).toBeNull();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: s.headers,
      payload: { diagnosticId: d.diagnostic.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PLAN_CONTENT_UNAVAILABLE');
    expect((await db.query('SELECT * FROM learning_plans')).rows).toHaveLength(0);
  });
  it('recommends independent practice after a diagnostic completed with administrative help', async () => {
    const s = await active(),
      root = await active('superadmin');
    await profile(s, { goal: 'work' });
    const d = await diagnostic(s),
      engine = new LuchEngine(db);
    let run = await engine.repository.view(root.actor, d.diagnostic.runId);
    while (run.current) {
      run = (
        await engine.answer(root.actor, run.run.id, {
          turnId: run.current.turn.id,
          operationId: randomUUID(),
          answer: answerFor(run, true),
        })
      ).view;
      run = await engine.next(root.actor, run.run.id, run.current!.turn.id);
    }
    const report = await new DiagnosticsService(db).read(s.actor, d.diagnostic.id),
      p = await plan(s, report.planId!);
    expect(report.result!.correct).toBe(6);
    expect(p.plan.createdBy).toBe(root.actor.user.id);
    expect(p.assignments.every((a) => a.reason.kind === 'guided_success')).toBe(true);
    expect(p.assignments[0]!.reason.skills[0]!.independentCorrect).toBe(0);
  });
  it('links matching active work across historical plans without duplicating runs or completion', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s),
      p = await plan(s, d.planId!);
    const r = await start(s, p.plan.id, p.assignments[0]!.id),
      repeated = await diagnostic(s, true);
    await finish(s, repeated.diagnostic.runId);
    const report = await new DiagnosticsService(db).read(s.actor, repeated.diagnostic.id),
      newer = await plan(s, report.planId!);
    const assignment = newer.assignments.find((a) => a.lessonId === p.assignments[0]!.lessonId)!;
    const linked = await start(s, newer.plan.id, assignment.id);
    expect(linked.run.id).toBe(r.run.id);
    expect(new Set(linked.run.planIds)).toEqual(new Set([p.plan.id, newer.plan.id]));
    await finish(s, r.run.id);
    expect((await plan(s, p.plan.id)).plan.completedAssignments).toBe(1);
    expect((await plan(s, newer.plan.id)).plan.completedAssignments).toBe(1);
    expect(
      (await db.query("SELECT * FROM engine_runs WHERE purpose='practice'")).rows,
    ).toHaveLength(1);
  });
  it('creates a real personal plan automatically, pins practice exercises and opens its first assignment', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s, [true, false, true, true, true, true]);
    const p = await plan(s, d.planId!);
    expect(p.plan).toMatchObject({
      diagnosticId: d.diagnostic.id,
      rulesVersion: '1.0.0',
      totalAssignments: 6,
      completedAssignments: 0,
      status: 'active',
      recommendedDays: 3,
      createdBy: s.actor.user.id,
    });
    expect(p.assignments.map((a) => a.lessonId)).toEqual([
      'rki-02',
      'rki-01',
      'rki-05',
      'rki-06',
      'rki-03',
      'rki-04',
    ]);
    expect(
      p.assignments.every(
        (a) => a.status === 'pending' && a.runId === null && a.exercises.length === 2,
      ),
    ).toBe(true);
    expect(p.assignments[0]!.reason).toMatchObject({
      kind: 'diagnostic_gap',
      skills: [{ skillId: 'ru-time', correct: 0, questions: 1 }],
    });
    const run = await start(s, p.plan.id, p.nextAssignmentId!);
    expect(run.current!.exercise.id).toBe('rki-02-practice-choice');
    expect(run.run.planIds).toEqual([p.plan.id]);
    expect((await plan(s, p.plan.id)).assignments[0]).toMatchObject({
      status: 'active',
      runId: run.run.id,
      startedBy: s.actor.user.id,
    });
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain('correctOptionIds');
    expect(serialized).not.toContain('acceptedAnswers');
  });
  it('changes ordering by actual diagnostic gaps and by goal, with minute budgets including short days', async () => {
    const good = await active(),
      poor = await active(),
      work = await active();
    await profile(good, { goal: 'travel', minutesPerDay: 5 });
    await profile(poor, { goal: 'travel', minutesPerDay: 35 });
    await profile(work, { goal: 'work' });
    const a = await plan(good, (await completedDiagnostic(good)).planId!);
    const b = await plan(
      poor,
      (await completedDiagnostic(poor, [false, true, true, true, true, true])).planId!,
    );
    const c = await plan(work, (await completedDiagnostic(work)).planId!);
    expect(a.assignments[0]!.lessonId).toBe('rki-04');
    expect(a.assignments[0]!.reason.kind).toBe('goal_priority');
    expect(b.assignments[0]!.lessonId).toBe('rki-01');
    expect(b.assignments[0]!.reason.kind).toBe('diagnostic_gap');
    expect(c.assignments[0]!.lessonId).toBe('rki-01');
    expect(a.plan.recommendedDays).toBe(6);
    expect(b.plan.recommendedDays).toBe(2);
    expect(b.assignments.at(-1)!.recommendedDay).toBe(2);
  });
  it('does not create a plan or expose partial grades before completion and enforces auth/CSRF', async () => {
    const s = await active();
    await profile(s);
    const d = await diagnostic(s);
    expect(d.planId).toBeNull();
    expect((await db.query('SELECT * FROM learning_plans')).rows).toHaveLength(0);
    const options = {
      method: 'POST' as const,
      url: '/api/v1/plans',
      payload: { diagnosticId: d.diagnostic.id },
    };
    expect((await app.inject(options)).statusCode).toBe(401);
    expect(
      (await app.inject({ ...options, headers: { cookie: s.headers.cookie } })).statusCode,
    ).toBe(403);
    expect((await app.inject({ ...options, headers: s.headers })).statusCode).toBe(409);
    const list = await app.inject({ url: '/api/v1/plans', headers: s.headers });
    expect(plansPageSchema.parse(list.json().data).items).toEqual([]);
  });
  it('deduplicates concurrent generation and starts, including a replay after completion', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s);
    const generated = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/plans',
          headers: s.headers,
          payload: { diagnosticId: d.diagnostic.id },
        }),
      ),
    );
    expect(generated.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await db.query('SELECT * FROM learning_plans')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM plan_assignments')).rows).toHaveLength(6);
    const p = await plan(s, d.planId!),
      a = p.assignments[0]!;
    const [first, second] = await Promise.all([
      start(s, p.plan.id, a.id),
      start(s, p.plan.id, a.id),
    ]);
    expect(second.run.id).toBe(first.run.id);
    await finish(s, first.run.id);
    expect((await start(s, p.plan.id, a.id)).run.id).toBe(first.run.id);
    expect(
      (await db.query("SELECT * FROM security_audit WHERE action='plan.assignment_started'")).rows,
    ).toHaveLength(1);
  });
  it('updates assignment and plan statuses only after actual engine completion without regrading', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s);
    let p = await plan(s, d.planId!);
    for (const assignment of p.assignments) {
      let r = await start(s, p.plan.id, assignment.id);
      r = await submit(s, r, false);
      r = await next(s, r);
      r = await submit(s, r, true);
      expect((await plan(s, p.plan.id)).assignments[assignment.position]!.status).toBe('active');
      r = await next(s, r);
      expect(r.run.status).toBe('completed');
      p = await plan(s, p.plan.id);
      expect(p.assignments[assignment.position]!.completedAt).toBe(r.run.completedAt);
      expect(p.plan.completedAssignments).toBe(assignment.position + 1);
    }
    expect(p.plan.status).toBe('completed');
    expect(p.nextAssignmentId).toBeNull();
    expect(p.plan.completedAt).not.toBeNull();
    expect(
      (
        await db.query(
          "SELECT * FROM engine_attempts a JOIN engine_runs r ON r.id=a.run_id WHERE r.purpose='practice'",
        )
      ).rows,
    ).toHaveLength(12);
  });
  it('denies unrelated users, gives an assigned teacher read access and audits superadmin operations', async () => {
    const s = await active(),
      other = await active(),
      teacher = await active('teacher'),
      root = await active('superadmin');
    await profile(s);
    const d = await completedDiagnostic(s),
      p = await plan(s, d.planId!);
    for (const viewer of [other, teacher]) {
      expect(
        (await app.inject({ url: `/api/v1/plans/${p.plan.id}`, headers: viewer.headers }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: `/api/v1/plans?userId=${s.actor.user.id}`,
            headers: viewer.headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/plans',
            headers: viewer.headers,
            payload: { diagnosticId: d.diagnostic.id },
          })
        ).statusCode,
      ).toBe(404);
    }
    await db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      s.actor.user.id,
    ]);
    expect((await plan(teacher, p.plan.id)).writable).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/plans/${p.plan.id}/assignments/${p.assignments[0]!.id}/start`,
          headers: teacher.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/plans',
          headers: teacher.headers,
          payload: { diagnosticId: d.diagnostic.id },
        })
      ).statusCode,
    ).toBe(403);
    expect((await plan(root, p.plan.id)).writable).toBe(true);
    const run = await start(root, p.plan.id, p.assignments[0]!.id);
    expect(run.run.user.id).toBe(s.actor.user.id);
    expect(run.current!.turn.adminAssistance).toBe(false);
    const after = await plan(root, p.plan.id);
    expect(after.assignments[0]!.startedBy).toBe(root.actor.user.id);
    expect(
      (
        await db.query(
          "SELECT * FROM security_audit WHERE actor_id=$1 AND action='plan.assignment_started' AND target_id=$2",
          [root.actor.user.id, s.actor.user.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/plans/${p.plan.id}/assignments/${randomUUID()}/start`,
          headers: root.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('keeps the diagnostic questionnaire and bank revision even after changes while assessment is active', async () => {
    const s = await active(),
      root = await active('superadmin');
    await profile(s, { language: 'en', goal: 'travel', minutesPerDay: 10 });
    const d = await diagnostic(s);
    await profile(s, { language: 'ru', goal: 'work', minutesPerDay: 120 }, 1);
    const newer = structuredClone(demo);
    newer.package.version = 2;
    newer.lessons.find((l) => l.id === 'english-04')!.title = 'New revision';
    await new ContentService(db).import(newer, root.actor.user.id);
    await finish(s, d.diagnostic.runId);
    const report = await new DiagnosticsService(db).read(s.actor, d.diagnostic.id),
      p = await plan(s, report.planId!);
    expect(p.plan).toMatchObject({
      profileRevision: 1,
      packageVersion: 1,
      questionnaire: { language: 'en', goal: 'travel', minutesPerDay: 10 },
    });
    expect(p.assignments[0]!.title).toBe('Places and directions');
    expect((await start(s, p.plan.id, p.assignments[0]!.id)).run.packageVersion).toBe(1);
  });
  it('continues a matching unfinished lesson and uses a new cycle for completed independent work', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s),
      p = await plan(s, d.planId!);
    const engine = new LuchEngine(db),
      first = p.assignments[0]!,
      second = p.assignments[1]!;
    let old = await engine.start(s.actor, {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: first.lessonId, purpose: 'practice' },
      restart: false,
    });
    old = await submit(s, old, true);
    old = await next(s, old);
    const resumed = await start(s, p.plan.id, first.id);
    expect(resumed.run.id).toBe(old.run.id);
    expect(resumed.run.currentPosition).toBe(1);
    const completed = await engine.start(s.actor, {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: second.lessonId, purpose: 'practice' },
      restart: false,
    });
    await finish(s, completed.run.id);
    const fresh = await start(s, p.plan.id, second.id);
    expect(fresh.run.id).not.toBe(completed.run.id);
    expect(fresh.run.cycle).toBe(2);
  });
  it('retains a draft and linked assignment through logout and ordinary authenticator login', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s),
      p = await plan(s, d.planId!);
    const r = await start(s, p.plan.id, p.assignments[0]!.id),
      answer = answerFor(r, true);
    await new LuchEngine(db).save(s.actor, r.run.id, {
      turnId: r.current!.turn.id,
      draftAnswer: answer,
      revision: 1,
      paused: true,
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: s.headers,
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await app.inject({ url: `/api/v1/plans/${p.plan.id}`, headers: s.headers })).statusCode,
    ).toBe(401);
    await db.query('UPDATE users SET last_totp_counter=-1 WHERE id=$1', [s.actor.user.id]);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: s.email, code: createTotp(s.email, s.secret).generate() },
    });
    expect(login.statusCode, login.body).toBe(200);
    s.headers = {
      cookie: `luch_session=${login.cookies.find((c) => c.name === 'luch_session')!.value}`,
      'x-csrf-token': login.json().data.csrfToken,
    };
    expect((await plan(s, p.plan.id)).nextAssignmentId).toBe(p.assignments[0]!.id);
    const resumed = await start(s, p.plan.id, p.assignments[0]!.id);
    expect(resumed.current!.turn.draftAnswer).toEqual(answer);
    expect(resumed.run.id).toBe(r.run.id);
  });
  it('can explicitly generate a missing plan for a previously saved diagnostic without touching its result', async () => {
    const s = await active();
    await profile(s);
    const d = await completedDiagnostic(s);
    const original = d.result;
    await db.exec('TRUNCATE learning_plans CASCADE');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: s.headers,
      payload: { diagnosticId: d.diagnostic.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    const p = planViewSchema.parse(response.json().data);
    expect(p.plan.diagnosticId).toBe(d.diagnostic.id);
    const saved = await new DiagnosticsService(db).read(s.actor, d.diagnostic.id);
    expect(saved.result).toEqual(original);
    expect(saved.planId).toBe(p.plan.id);
  });
  it('rolls back final completion, skill totals and a partial plan together on persistence failure, then retries safely', async () => {
    const s = await active();
    await profile(s);
    const d = await diagnostic(s);
    let r = await view(s, d.diagnostic.runId);
    while (r.current!.position < 5) {
      r = await submit(s, r, true);
      r = await next(s, r);
    }
    r = await submit(s, r, true);
    const lastTurn = r.current!.turn.id;
    await expect(
      new LuchEngine(failOn('INSERT INTO plan_assignments')).next(s.actor, r.run.id, lastTurn),
    ).rejects.toThrow('Planned persistence failure');
    expect((await view(s, r.run.id)).run.status).toBe('active');
    expect((await db.query('SELECT * FROM diagnostic_skill_results')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM learning_plans')).rows).toHaveLength(0);
    await next(s, r);
    const saved = await new DiagnosticsService(db).read(s.actor, d.diagnostic.id);
    expect(saved.planId).not.toBeNull();
    await new LuchEngine(db).next(s.actor, r.run.id, lastTurn);
    expect((await db.query('SELECT * FROM learning_plans')).rows).toHaveLength(1);
  });
  it('does not leave an orphan run if assignment linking fails, and validates database ownership references', async () => {
    const s = await active(),
      other = await active();
    await profile(s);
    const d = await completedDiagnostic(s),
      p = await plan(s, d.planId!),
      assignment = p.assignments[0]!;
    await expect(
      new PlansService(failOn('UPDATE plan_assignments')).startAssignment(
        s.actor,
        p.plan.id,
        assignment.id,
      ),
    ).rejects.toThrow('Planned persistence failure');
    expect(
      (await db.query("SELECT * FROM engine_runs WHERE purpose='practice'")).rows,
    ).toHaveLength(0);
    const foreign = await new LuchEngine(db).start(other.actor, {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: assignment.lessonId, purpose: 'practice' },
      restart: false,
    });
    await expect(
      db.query('UPDATE plan_assignments SET run_id=$2,started_by=$3,started_at=now() WHERE id=$1', [
        assignment.id,
        foreign.run.id,
        s.actor.user.id,
      ]),
    ).rejects.toThrow();
    expect((await plan(s, p.plan.id)).assignments[0]!.status).toBe('pending');
    expect((await start(s, p.plan.id, assignment.id)).run.user.id).toBe(s.actor.user.id);
  });
  it('preserves separate plans for repeat diagnostics and paginates/filter languages without duplicates', async () => {
    const s = await active();
    await profile(s);
    const a = await completedDiagnostic(s);
    await profile(s, { language: 'en' }, 1);
    const b = await diagnostic(s, false, 2);
    await finish(s, b.diagnostic.runId);
    const c = await diagnostic(s, true, 2);
    await finish(s, c.diagnostic.runId);
    const response = await app.inject({ url: '/api/v1/plans?limit=1', headers: s.headers }),
      first = plansPageSchema.parse(response.json().data);
    const cursor = first.nextCursor!;
    const response2 = await app.inject({
      url: `/api/v1/plans?limit=2&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
      headers: s.headers,
    });
    const second = plansPageSchema.parse(response2.json().data);
    expect(new Set([...first.items, ...second.items].map((p) => p.id)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
    const filtered = await app.inject({ url: '/api/v1/plans?language=ru', headers: s.headers });
    expect(plansPageSchema.parse(filtered.json().data).items.map((p) => p.id)).toEqual([a.planId]);
    expect((await plan(s, a.planId!)).plan.questionnaire.language).toBe('ru');
  });
});
