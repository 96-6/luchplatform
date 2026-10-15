import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentPackageSchema,
  studentDashboardSchema,
  type Answer,
  type Questionnaire,
  type RunView,
  type User,
} from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings, projectRoot } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { publicUser, type UserRow } from '../src/modules/accounts/repository.js';
import { AccountCrypto, createTotp } from '../src/modules/auth/crypto.js';
import type { Actor } from '../src/modules/auth/service.js';
import { seedDemoContent } from '../src/modules/content/bootstrap.js';
import { DashboardService } from '../src/modules/dashboard/service.js';
import { ProfileService } from '../src/modules/diagnostics/profile.js';
import { DiagnosticsService } from '../src/modules/diagnostics/service.js';
import { LuchEngine } from '../src/modules/engine/service.js';
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
  bank: ReturnType<typeof contentPackageSchema.parse>;
beforeAll(async () => {
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db);
  bank = contentPackageSchema.parse(
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
async function user(role: User['role'] = 'student') {
  const id = randomUUID(),
    email = `dashboard-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  const row = (
    await db.query<UserRow>(
      'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true) RETURNING *',
      [id, email, 'Главная ученика', role, crypto.encrypt(secret)],
    )
  ).rows[0]!;
  return { user: publicUser(row), tokenHash: 'test', sessionId: randomUUID() } satisfies Actor;
}
async function headers(actor: Actor) {
  const row = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [actor.user.id]))
    .rows[0]!;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: row.email,
      code: createTotp(row.email, crypto.decrypt(row.totp_secret_ciphertext!)).generate(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
    'x-csrf-token': response.json().data.csrfToken,
  };
}
const questionnaire: Questionnaire = {
  language: 'ru',
  goal: 'travel',
  experience: 'none',
  minutesPerDay: 10,
};
async function profile(actor: Actor, fields: Partial<Questionnaire> = {}, revision = 0) {
  return new ProfileService(db).save(actor, { ...questionnaire, ...fields, revision });
}
function answer(run: RunView, correct = true): Answer {
  const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.solution.type === 'short_text')
    return { type: 'short_text', text: correct ? e.solution.accepted[0]! : 'wrong' };
  if (e.response.type !== 'choice') throw new Error('Unexpected answer');
  const solution = e.solution;
  return {
    type: 'choice',
    optionId: e.response.options.find((o) => solution.correctOptionIds.includes(o.id) === correct)!
      .id,
  };
}
async function finish(actor: Actor, run: RunView, correct = true, engine = new LuchEngine(db)) {
  while (run.current) {
    if (!run.current.attempt)
      run = (
        await engine.answer(actor, run.run.id, {
          turnId: run.current.turn.id,
          operationId: randomUUID(),
          answer: answer(run, correct),
        })
      ).view;
    run = await engine.next(actor, run.run.id, run.current!.turn.id);
  }
  return run;
}
async function diagnosed(actor: Actor, restart = false, profileRevision = 1) {
  const diagnostics = new DiagnosticsService(db),
    d = await diagnostics.start(actor, { restart, profileRevision });
  await finish(actor, await diagnostics.engine.repository.view(actor, d.diagnostic.runId));
  return diagnostics.read(actor, d.diagnostic.id);
}
async function withPlan(actor: Actor, language: 'ru' | 'en' = 'ru') {
  await profile(actor, { language });
  const d = await diagnosed(actor);
  return new PlansService(db).read(actor, d.planId!);
}
async function lesson(
  actor: Actor,
  id = 'rki-01',
  purpose: 'practice' | 'control' = 'practice',
  engine = new LuchEngine(db),
) {
  return engine.start(actor, {
    packageId: 'luch-demo',
    source: { type: 'lesson', id, purpose },
    restart: true,
  });
}
async function counts() {
  return (
    await db.query(
      `SELECT (SELECT count(*) FROM engine_runs)::integer AS runs,(SELECT count(*) FROM engine_attempts)::integer AS attempts,(SELECT count(*) FROM learning_plans)::integer AS plans,(SELECT count(*) FROM plan_assignments)::integer AS assignments,(SELECT count(*) FROM skill_observations)::integer AS observations`,
    )
  ).rows[0];
}

describe('student dashboard integration', () => {
  it('returns a real empty state, validates zones and refuses foreign user selectors or other roles', async () => {
    expect((await app.inject({ url: '/api/v1/student/dashboard' })).statusCode).toBe(401);
    const s = await user(),
      h = await headers(s),
      peer = await user();
    await profile(peer, { language: 'en', goal: 'work' });
    const response = await app.inject({ url: '/api/v1/student/dashboard', headers: h });
    expect(response.statusCode, response.body).toBe(200);
    const data = studentDashboardSchema.parse(response.json().data);
    expect(data.user.id).toBe(s.user.id);
    expect(data.profile).toBeNull();
    expect(data.plan).toBeNull();
    expect(data.continueRun).toBeNull();
    expect(data.nextAssignment).toBeNull();
    expect(data.today).toEqual([]);
    expect(data.reviews).toEqual([]);
    expect(data.progress.evaluatedAttempts).toBe(0);
    expect(data.timeZone).toBe('UTC');
    expect(response.headers['cache-control']).toBe('no-store');
    for (const query of [`userId=${peer.user.id}`, 'timeZone=No/SuchZone', 'timeZone='])
      expect(
        (await app.inject({ url: `/api/v1/student/dashboard?${query}`, headers: h })).statusCode,
      ).toBe(400);
    for (const role of ['teacher', 'admin', 'superadmin'] as const)
      expect(
        (
          await app.inject({
            url: '/api/v1/student/dashboard',
            headers: await headers(await user(role)),
          })
        ).statusCode,
      ).toBe(403);
  });

  it.each(['ru', 'en'] as const)(
    'joins the saved %s profile, ordered plan and initial day without writes or solution keys',
    async (language) => {
      const s = await user(),
        p = await withPlan(s, language),
        service = new DashboardService(db),
        before = await counts();
      const data = await service.read(s, 'Europe/Moscow');
      expect(data.profile?.language).toBe(language);
      expect(data.profile?.goal).toBe('travel');
      expect(data.plan?.id).toBe(p.plan.id);
      expect(data.diagnostic?.id).toBe(p.plan.diagnosticId);
      expect(data.recommendedDay).toBe(1);
      expect(data.today.map((a) => a.id)).toEqual([p.assignments[0]!.id]);
      expect(data.nextAssignment?.id).toBe(p.nextAssignmentId);
      expect(data.progress).toMatchObject({
        evaluatedAttempts: 6,
        independentCorrect: 6,
        assistedCorrect: 0,
        incorrectAttempts: 0,
      });
      expect(data.recentResults).toHaveLength(5);
      expect(JSON.stringify(data)).not.toMatch(
        /correctOptionIds|accepted|solution|AUTH_ENCRYPTION|totp_secret/,
      );
      await service.read(s);
      expect(await counts()).toEqual(before);
    },
  );

  it('uses local calendar days across midnight and daylight saving, retaining overdue work', async () => {
    const s = await user(),
      p = await withPlan(s);
    await db.query('UPDATE learning_plans SET created_at=$2 WHERE id=$1', [
      p.plan.id,
      '2026-03-28T23:30:00Z',
    ]);
    const service = new DashboardService(db, () => Date.parse('2026-03-29T00:30:00Z'));
    expect((await service.read(s, 'UTC')).recommendedDay).toBe(2);
    expect((await service.read(s, 'Europe/Moscow')).recommendedDay).toBe(1);
    const afterDst = await new DashboardService(db, () => Date.parse('2026-03-29T23:10:00Z')).read(
      s,
      'Europe/London',
    );
    expect(afterDst.recommendedDay).toBe(3);
    expect(afterDst.today.map((a) => a.id)).toEqual(p.assignments.slice(0, 3).map((a) => a.id));
  });

  it('resumes the most recently changed run, including standalone work and a saved draft after a profile revision', async () => {
    const s = await user();
    await profile(s);
    const engine = new LuchEngine(db),
      first = await lesson(s),
      second = await lesson(s, 'rki-02');
    await engine.save(s, first.run.id, {
      turnId: first.current!.turn.id,
      revision: 1,
      draftAnswer: answer(first),
      paused: true,
    });
    await profile(s, { goal: 'work' }, 1);
    const data = await new DashboardService(db).read(s);
    expect(data.continueRun?.id).toBe(first.run.id);
    expect(data.continueRun?.id).not.toBe(second.run.id);
    expect(
      (await engine.repository.view(s, data.continueRun!.id)).current!.turn.draftAnswer,
    ).toEqual(answer(first));
    const d = await new DiagnosticsService(db).start(s, { profileRevision: 2, restart: false });
    await profile(s, { goal: 'study' }, 2);
    expect((await new DashboardService(db).read(s)).continueRun?.id).toBe(d.diagnostic.runId);
  });

  it('shows error correction and hinted success from persisted engine evidence', async () => {
    const s = await user(),
      p = await withPlan(s),
      plans = new PlansService(db),
      engine = plans.engine,
      service = new DashboardService(db);
    let run = await plans.startAssignment(s, p.plan.id, p.assignments[0]!.id);
    const request = {
      turnId: run.current!.turn.id,
      operationId: randomUUID(),
      answer: answer(run, false),
    };
    await engine.answer(s, run.run.id, request);
    await engine.answer(s, run.run.id, request);
    run = await engine.next(s, run.run.id, run.current!.turn.id);
    await engine.hint(s, run.run.id, run.current!.turn.id, 0);
    await finish(s, run);
    const data = await service.read(s);
    expect(data.continueRun).toBeNull();
    expect(data.today.filter((a) => a.kind === 'correction')).toHaveLength(1);
    expect(data.today.some((a) => a.kind === 'supported_practice')).toBe(true);
    expect(data.nextAssignment?.kind).toBe('correction');
    expect(data.progress).toMatchObject({
      completedLessons: 1,
      evaluatedAttempts: 8,
      independentCorrect: 6,
      assistedCorrect: 1,
      incorrectAttempts: 1,
    });
    expect(data.recentResults.slice(0, 2).map((a) => [a.correct, a.independent])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(data.today.every((a) => a.status !== 'completed')).toBe(true);
  });

  it('opens reviews only when due, keeps older plan reviews, and removes a completed review', async () => {
    const s = await user(),
      p = await withPlan(s),
      plans = new PlansService(db);
    const run = await plans.startAssignment(s, p.plan.id, p.assignments[0]!.id);
    await finish(s, run);
    const before = await new DashboardService(db).read(s),
      review = before.reviews[0]!;
    expect(review.canStart).toBe(false);
    expect(before.nextAssignment?.id).not.toBe(review.id);
    await expect(plans.startAssignment(s, review.planId, review.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_DUE',
    });
    const later = await diagnosed(s, true);
    expect(later.planId).not.toBe(p.plan.id);
    const current = await new DashboardService(db).read(s);
    expect(current.plan?.id).toBe(later.planId);
    expect(current.reviews.some((a) => a.id === review.id && a.planId === p.plan.id)).toBe(true);
    expect(
      current.today.filter((a) => a.kind === 'initial').every((a) => a.planId === later.planId),
    ).toBe(true);
    const due = Date.parse(review.dueAt!);
    expect(
      (await new DashboardService(db, () => due - 1).read(s)).reviews.find(
        (a) => a.id === review.id,
      )?.canStart,
    ).toBe(false);
    expect(
      (await new DashboardService(db, () => due).read(s)).reviews.find((a) => a.id === review.id)
        ?.canStart,
    ).toBe(true);
    const timedPlans = new PlansService(db, () => due + 1);
    await finish(
      s,
      await timedPlans.startAssignment(s, review.planId, review.id),
      true,
      timedPlans.engine,
    );
    expect(
      (await new DashboardService(db, () => due + 1).read(s)).reviews.some(
        (a) => a.id === review.id,
      ),
    ).toBe(false);
  });

  it.each(['diagnostic', 'control'] as const)(
    'does not leak the correctness of an unfinished %s through recent results or totals',
    async (purpose) => {
      const s = await user(),
        engine = new LuchEngine(db);
      let run =
        purpose === 'control'
          ? await lesson(s, 'rki-01', 'control', engine)
          : await engine.start(s, {
              packageId: 'luch-demo',
              source: { type: 'set', id: 'rki-diagnostic' },
              restart: true,
            });
      run = (
        await engine.answer(s, run.run.id, {
          turnId: run.current!.turn.id,
          operationId: randomUUID(),
          answer: answer(run, false),
        })
      ).view;
      const before = await new DashboardService(db).read(s);
      expect(before.progress).toMatchObject({
        evaluatedAttempts: 0,
        incorrectAttempts: 0,
        pendingEvaluationAttempts: 1,
      });
      expect(before.recentResults[0]).toMatchObject({ correct: null, independent: null });
      await finish(s, run);
      const after = await new DashboardService(db).read(s);
      expect(after.progress.evaluatedAttempts).toBe(run.run.totalSteps);
      expect(after.progress.incorrectAttempts).toBe(1);
      expect(after.progress.pendingEvaluationAttempts).toBe(0);
      expect(after.recentResults.every((r) => r.correct !== null)).toBe(true);
    },
  );

  it('selects the current language without mixing another plan, run, answers or a changed goal', async () => {
    const s = await user(),
      ru = await withPlan(s),
      engine = new LuchEngine(db);
    await finish(s, await lesson(s));
    await profile(s, { language: 'en', goal: 'work' }, 1);
    let data = await new DashboardService(db).read(s);
    expect(data.plan).toBeNull();
    expect(data.progress.evaluatedAttempts).toBe(0);
    expect(data.recentResults).toEqual([]);
    expect(data.today).toEqual([]);
    expect(data.reviews).toEqual([]);
    const english = await diagnosed(s, false, 2);
    await profile(s, { language: 'ru', goal: 'study' }, 2);
    data = await new DashboardService(db).read(s);
    expect(data.plan?.id).toBe(ru.plan.id);
    expect(data.plan?.id).not.toBe(english.planId);
    expect(data.profileChangedSincePlan).toBe(true);
    expect(data.profile?.goal).toBe('study');
    expect(data.plan?.questionnaire.goal).toBe('travel');
    expect(data.recentResults.every((r) => !r.title.includes('English'))).toBe(true);
  });

  it('counts a repeated completed lesson once while preserving every attempt', async () => {
    const s = await user();
    await finish(s, await lesson(s));
    await finish(s, await lesson(s));
    const data = await new DashboardService(db).read(s);
    expect(data.progress.completedLessons).toBe(1);
    expect(data.progress.evaluatedAttempts).toBe(4);
    expect(data.continueRun).toBeNull();
    expect(data.recentResults).toHaveLength(4);
  });
});
