import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { planChangesPageSchema, skillStatesSchema } from '@luch/contracts';
import { learningFixture, failOn } from './helpers/learning.js';
import { LuchEngine } from '../src/modules/engine/service.js';
import { PlansService } from '../src/modules/plans/service.js';
import {
  recoverLearningEvents,
  processRunLearningEvents,
} from '../src/modules/adaptation/processor.js';

let f: Awaited<ReturnType<typeof learningFixture>>;
beforeAll(async () => {
  f = await learningFixture();
});
beforeEach(async () => {
  await f.reset();
});
afterAll(async () => {
  await f.app.close();
});
describe('adaptive learning and spaced checks', () => {
  it('creates different next work for a mistake and an independent success from persisted attempts', async () => {
    const poor = await f.active(),
      good = await f.active(),
      a = await f.preparedPlan(poor),
      b = await f.preparedPlan(good);
    await f.finish(poor, (await f.start(poor, a.plan.id, a.assignments[0]!.id)).run.id, [
      false,
      false,
    ]);
    await f.finish(good, (await f.start(good, b.plan.id, b.assignments[0]!.id)).run.id, [
      true,
      true,
    ]);
    const errorPlan = await f.plan(poor, a.plan.id),
      successPlan = await f.plan(good, b.plan.id);
    const correction = errorPlan.assignments.find((x) => x.id === errorPlan.nextAssignmentId)!;
    expect(correction.kind).toBe('correction');
    expect(correction.reason.kind).toBe('typical_error');
    expect(correction.reason.skills[0]!.skillId).toBe('ru-introduction');
    const review = successPlan.assignments.find((x) => x.kind === 'review')!;
    expect(review.purpose).toBe('control');
    expect(review.canStart).toBe(false);
    expect(new Date(review.dueAt!).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    expect(successPlan.assignments.find((x) => x.id === successPlan.nextAssignmentId)!.kind).toBe(
      'initial',
    );
    const changes = planChangesPageSchema.parse(
      (
        await f.app.inject({ url: `/api/v1/plans/${a.plan.id}/history`, headers: poor.headers })
      ).json().data,
    );
    expect(
      changes.items.some((x) => x.action === 'correction_added' && x.reason.includes('ошибка')),
    ).toBe(true);
    expect(
      changes.items.every((x) => x.createdBy === poor.actor.user.id && x.createdAt && x.attemptId),
    ).toBe(true);
  });
  it('separates hinted, assisted and independent successes without changing original grades', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s);
    let run = await f.start(s, p.plan.id, p.assignments[0]!.id);
    const hint = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/hint`,
      headers: s.headers,
      payload: { turnId: run.current!.turn.id, index: 0 },
    });
    expect(hint.statusCode, hint.body).toBe(200);
    run = await f.answer(s, run, true);
    expect(run.attempts[0]!.evaluation!.score).toBe(1);
    expect(run.attempts[0]!.independent).toBe(false);
    const states = skillStatesSchema.parse(
      (await f.app.inject({ url: '/api/v1/learning/skills', headers: s.headers })).json().data,
    );
    const skill = states.items.find((x) => x.skillId === 'ru-introduction')!;
    expect(skill.hintedSuccesses).toBe(1);
    expect(skill.independentSuccesses).toBe(1);
    expect(skill.status).toBe('supported');
    expect(
      (await f.plan(s, p.plan.id)).assignments.some((a) => a.kind === 'supported_practice'),
    ).toBe(true);
    run = await f.next(s, run);
    run = await f.answer(s, run, false);
    const retry = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/retry`,
      headers: s.headers,
      payload: { turnId: run.current!.turn.id },
    });
    expect(retry.statusCode).toBe(200);
    run = await f.view(s, run.run.id);
    run = await f.answer(s, run, true);
    expect(run.current!.attempt!.independent).toBe(false);
    const updated = skillStatesSchema
      .parse(
        (await f.app.inject({ url: '/api/v1/learning/skills', headers: s.headers })).json().data,
      )
      .items.find((x) => x.skillId === 'ru-introduction')!;
    expect(updated.assistedSuccesses).toBe(1);
    expect(updated.mistakes).toBe(1);
    expect(updated.hintedSuccesses).toBe(1);
  });
  it('enforces delay, disables hints and reveals a review result only after completion', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s);
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id);
    const plan = await f.plan(s, p.plan.id),
      review = plan.assignments.find((a) => a.kind === 'review')!;
    const early = await f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${p.plan.id}/assignments/${review.id}/start`,
      headers: s.headers,
      payload: {},
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('ASSIGNMENT_NOT_DUE');
    const clock = () => new Date(review.dueAt!).getTime() + 1000,
      plans = new PlansService(f.db, clock),
      engine = plans.engine;
    let run = await plans.startAssignment(s.actor, p.plan.id, review.id);
    expect(run.current!.turn.hadPriorFeedback).toBe(false);
    await expect(engine.hint(s.actor, run.run.id, run.current!.turn.id, 0)).rejects.toMatchObject({
      statusCode: 403,
    });
    const answered = await engine.answer(s.actor, run.run.id, {
      turnId: run.current!.turn.id,
      operationId: randomUUID(),
      answer: f.answerFor(run, true),
    });
    run = answered.view;
    expect(run.attempts[0]!.evaluation).toBeNull();
    const before = (
      await f.db.query<{ control_attempts: number }>(
        'SELECT control_attempts FROM student_skill_states WHERE user_id=$1 AND skill_id=$2',
        [s.actor.user.id, 'ru-introduction'],
      )
    ).rows[0]!;
    expect(before.control_attempts).toBe(0);
    run = await engine.next(s.actor, run.run.id, run.current!.turn.id);
    expect(run.attempts[0]!.evaluation!.correct).toBe(true);
    const state = (
      await f.db.query<{ status: string; control_attempts: number }>(
        'SELECT status,control_attempts FROM student_skill_states WHERE user_id=$1 AND skill_id=$2',
        [s.actor.user.id, 'ru-introduction'],
      )
    ).rows[0]!;
    expect(state).toMatchObject({ status: 'confirmed', control_attempts: 1 });
    expect(
      (await plans.read(s.actor, p.plan.id)).assignments.filter((a) => a.kind === 'review'),
    ).toHaveLength(1);
  });
  it('deduplicates simultaneous result submissions, repeated completion and event recovery', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s),
      run = await f.start(s, p.plan.id, p.assignments[0]!.id),
      operationId = randomUUID();
    const [a, b] = await Promise.all([
      f.answer(s, run, false, operationId),
      f.answer(s, run, false, operationId),
    ]);
    expect(a.current!.attempt!.id).toBe(b.current!.attempt!.id);
    const engine = new LuchEngine(f.db);
    await f.db.transaction((tx) => processRunLearningEvents(tx, run.run.id, Date.now()));
    await recoverLearningEvents(f.db);
    expect(
      (
        await f.db.query("SELECT * FROM plan_assignments WHERE plan_id=$1 AND kind='correction'", [
          p.plan.id,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await f.db.query('SELECT * FROM skill_observations WHERE attempt_id=$1', [
          a.current!.attempt!.id,
        ])
      ).rows,
    ).toHaveLength(1);
    const after = await engine.next(s.actor, run.run.id, run.current!.turn.id);
    await engine.next(s.actor, run.run.id, run.current!.turn.id);
    expect(after.run.currentPosition).toBe(1);
  });
  it('rolls back the attempt, event, skill update and assignment if saving a plan change fails', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s),
      run = await f.start(s, p.plan.id, p.assignments[0]!.id),
      engine = new LuchEngine(failOn(f.db, 'INSERT INTO learning_plan_changes'));
    await expect(
      engine.answer(s.actor, run.run.id, {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer: f.answerFor(run, false),
      }),
    ).rejects.toThrow('Planned persistence failure');
    expect((await f.view(s, run.run.id)).attempts).toHaveLength(0);
    expect((await f.db.query('SELECT * FROM engine_attempts')).rows).toHaveLength(6);
    expect((await f.db.query('SELECT * FROM skill_observations')).rows).toHaveLength(6);
    expect(
      (await f.db.query("SELECT * FROM plan_assignments WHERE kind<>'initial'")).rows,
    ).toHaveLength(0);
    await f.answer(s, run, false);
    expect((await f.plan(s, p.plan.id)).assignments.some((a) => a.kind === 'correction')).toBe(
      true,
    );
  });
  it('recovers without looping over a saved answer in an unfinished corrective assignment', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s);
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id, [false, false]);
    const correction = (await f.plan(s, p.plan.id)).assignments.find(
      (a) => a.kind === 'correction',
    )!;
    // This recovery test deliberately replays the pinned bank item via the domain service.
    let run = await new PlansService(f.db).startAssignment(s.actor, p.plan.id, correction.id);
    run = await f.answer(s, run, false);
    expect(run.run.status).toBe('active');
    expect(
      (
        await f.db.query('SELECT * FROM skill_observations WHERE attempt_id=$1', [
          run.current!.attempt!.id,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(await recoverLearningEvents(f.db)).toBe(0);
    const restored = await f.view(s, run.run.id);
    expect(restored.current!.attempt!.id).toBe(run.current!.attempt!.id);
    run = await f.next(s, restored);
    expect(run.run.status).toBe('completed');
    expect(
      (await f.plan(s, p.plan.id)).assignments.filter((a) => a.kind === 'correction'),
    ).toHaveLength(2);
    expect(await recoverLearningEvents(f.db)).toBe(0);
  });
  it('coalesces open corrections and creates another after a failed corrective assignment is completed', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s);
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id, [false, false]);
    let plan = await f.plan(s, p.plan.id);
    expect(plan.assignments.filter((a) => a.kind === 'correction')).toHaveLength(1);
    const correction = plan.assignments.find((a) => a.kind === 'correction')!;
    const run = await new PlansService(f.db).startAssignment(s.actor, p.plan.id, correction.id);
    expect(run.run.totalSteps).toBe(1);
    expect(run.run.sourceType).toBe('assignment');
    await f.finish(s, run.run.id, [false]);
    plan = await f.plan(s, p.plan.id);
    expect(plan.assignments.filter((a) => a.kind === 'correction')).toHaveLength(2);
    expect(plan.assignments.find((a) => a.id === correction.id)!.status).toBe('completed');
    expect(plan.assignments.find((a) => a.id === plan.nextAssignmentId)!.kind).toBe('correction');
  });
  it('denies foreign skill/history reads and gives assigned teachers and superadmin the same persisted data', async () => {
    const s = await f.active(),
      other = await f.active(),
      teacher = await f.active('teacher'),
      root = await f.active('superadmin'),
      p = await f.preparedPlan(s);
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id, [false, false]);
    for (const viewer of [other, teacher])
      for (const url of [
        `/api/v1/learning/skills?userId=${s.actor.user.id}`,
        `/api/v1/plans/${p.plan.id}/history`,
      ])
        expect((await f.app.inject({ url, headers: viewer.headers })).statusCode).toBe(404);
    await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      s.actor.user.id,
    ]);
    const original = (
      await f.app.inject({ url: `/api/v1/plans/${p.plan.id}/history`, headers: s.headers })
    ).json().data;
    for (const viewer of [teacher, root])
      expect(
        (
          await f.app.inject({ url: `/api/v1/plans/${p.plan.id}/history`, headers: viewer.headers })
        ).json().data,
      ).toEqual(original);
  });
  it('records help from superadmin and marks an early forced review as assisted', async () => {
    const s = await f.active(),
      root = await f.active('superadmin'),
      p = await f.preparedPlan(s);
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id);
    const review = (await f.plan(root, p.plan.id)).assignments.find((a) => a.kind === 'review')!,
      run = await f.start(root, p.plan.id, review.id);
    expect(run.current!.turn.adminAssistance).toBe(true);
    const own = await f.view(s, run.run.id);
    await f.finish(s, own.run.id, [true]);
    expect(
      (
        await f.db.query<{ status: string; assisted_successes: number }>(
          'SELECT status,assisted_successes FROM student_skill_states WHERE user_id=$1 AND skill_id=$2',
          [s.actor.user.id, 'ru-introduction'],
        )
      ).rows[0],
    ).toMatchObject({ status: 'supported', assisted_successes: 1 });
  });
  it('keeps incomplete diagnostics/control private and does not invent assignments without an initial plan', async () => {
    const s = await f.active(),
      engine = new LuchEngine(f.db);
    let r = await engine.start(s.actor, {
      packageId: 'luch-demo',
      source: { type: 'set', id: 'rki-diagnostic' },
      restart: false,
    });
    r = (
      await engine.answer(s.actor, r.run.id, {
        turnId: r.current!.turn.id,
        operationId: randomUUID(),
        answer: f.answerFor(r, false),
      })
    ).view;
    expect((await f.db.query('SELECT * FROM student_skill_states')).rows).toHaveLength(0);
    await f.finish(s, r.run.id);
    expect((await f.db.query('SELECT * FROM student_skill_states')).rows).toHaveLength(6);
    expect((await f.db.query('SELECT * FROM plan_assignments')).rows).toHaveLength(0);
  });
  it('paginates dated changes without duplicates and preserves original reasons across new events', async () => {
    const s = await f.active(),
      p = await f.preparedPlan(s),
      original = p.assignments[0]!.reason;
    await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id, [false, false]);
    const first = planChangesPageSchema.parse(
        (
          await f.app.inject({
            url: `/api/v1/plans/${p.plan.id}/history?limit=1`,
            headers: s.headers,
          })
        ).json().data,
      ),
      cursor = first.nextCursor!;
    const second = planChangesPageSchema.parse(
      (
        await f.app.inject({
          url: `/api/v1/plans/${p.plan.id}/history?beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
          headers: s.headers,
        })
      ).json().data,
    );
    expect(new Set([...first.items, ...second.items].map((c) => c.id)).size).toBe(2);
    expect((await f.plan(s, p.plan.id)).assignments[0]!.reason).toEqual(original);
  });
});
