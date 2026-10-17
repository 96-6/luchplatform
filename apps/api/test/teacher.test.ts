import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import {
  attemptDetailSchema,
  attemptsPageSchema,
  planViewSchema,
  teacherActionsPageSchema,
  studentDashboardSchema,
  type RunView,
} from '@luch/contracts';
import { learningFixture, failOn, type Login } from './helpers/learning.js';
import { TeacherService } from '../src/modules/teacher/service.js';
import { LuchEngine } from '../src/modules/engine/service.js';
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
async function group() {
  const student = await f.active(),
    teacher = await f.active('teacher');
  await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
    teacher.actor.user.id,
    student.actor.user.id,
  ]);
  return { student, teacher };
}
async function lesson(student: Login, language = 'ru', purpose = 'practice') {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: student.headers,
    payload: {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: language === 'ru' ? 'rki-01' : 'english-01', purpose },
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as RunView;
}
async function review(
  teacher: Login,
  id: string,
  fields: Record<string, unknown> = {},
  status = 200,
) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/teacher/attempts/${id}/reviews`,
    headers: teacher.headers,
    payload: {
      operationId: randomUUID(),
      revision: 0,
      decision: 'correct',
      correct: true,
      comment: 'Ручная проверка: ответ принят.',
      ...fields,
    },
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function detail(user: Login, id: string) {
  const r = await f.app.inject({ url: `/api/v1/learning/attempts/${id}`, headers: user.headers });
  expect(r.statusCode, r.body).toBe(200);
  return attemptDetailSchema.parse(r.json().data);
}
async function add(
  teacher: Login,
  planId: string,
  exerciseId: string,
  fields: Record<string, unknown> = {},
  status = 200,
) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/teacher/plans/${planId}/assignments`,
    headers: teacher.headers,
    payload: {
      operationId: randomUUID(),
      exerciseId,
      reason: 'Дополнительная практика с преподавателем.',
      dueAt: null,
      ...fields,
    },
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function update(
  teacher: Login,
  planId: string,
  id: string,
  fields: Record<string, unknown> = {},
  status = 200,
) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/teacher/plans/${planId}/assignments/${id}`,
    headers: teacher.headers,
    payload: {
      operationId: randomUUID(),
      revision: 0,
      action: 'reschedule',
      dueAt: null,
      reason: 'Меняем срок с учётом нагрузки.',
      ...fields,
    },
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function count(table: string) {
  return Number(
    (await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n,
  );
}
describe('teacher workspace and shared student results', () => {
  it('shows saved integrity observations only to the assigned teacher and superadmin in attempt lists and details', async () => {
    const { student, teacher } = await group(),
      run = await lesson(student);
    const packet = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/integrity`,
      headers: student.headers,
      payload: {
        turnId: run.current!.turn.id,
        batchId: randomUUID(),
        stats: {
          durationMilliseconds: 5000,
          hiddenMilliseconds: 1000,
          tabHides: 1,
          focusLosses: 1,
          pasteEvents: 1,
          inputEvents: 1,
        },
      },
    });
    expect(packet.statusCode, packet.body).toBe(200);
    expect(packet.json().data.accepted).toBe(true);
    const submitted = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/answer`,
      headers: student.headers,
      payload: {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer: f.answerFor(run, true),
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const id = submitted.json().data.attempt.id;
    const owner = await detail(student, id),
      reviewer = await detail(teacher, id);
    expect(owner.attempt.integrity).toBeNull();
    expect(reviewer.attempt.integrity).toMatchObject({
      requiresReview: true,
      stats: { tabHides: 1, focusLosses: 1 },
    });
    expect(reviewer.attempt.evaluation).toEqual(owner.attempt.evaluation);
    const list = await f.app.inject({
      url: `/api/v1/learning/attempts?userId=${student.actor.user.id}`,
      headers: teacher.headers,
    });
    expect(
      attemptsPageSchema.parse(list.json().data).items[0]!.attempt.integrity?.requiresReview,
    ).toBe(true);
    const ownList = await f.app.inject({
      url: '/api/v1/learning/attempts',
      headers: student.headers,
    });
    expect(attemptsPageSchema.parse(ownList.json().data).items[0]!.attempt.integrity).toBeNull();
    const root = await f.active('superadmin');
    expect((await detail(root, id)).attempt.integrity?.requiresReview).toBe(true);
    const stranger = await f.active('teacher');
    expect(
      (await f.app.inject({ url: `/api/v1/learning/attempts/${id}`, headers: stranger.headers }))
        .statusCode,
    ).toBe(404);
  });
  it('keeps the diagnostic and original plan snapshot while exposing subsequent teacher assessment', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student);
    const diagnostic = (
      await f.db.query('SELECT * FROM diagnostic_sessions WHERE id=$1', [p.plan.diagnosticId])
    ).rows[0]!;
    const id = (
      await f.db.query<{ id: string }>(
        'SELECT id FROM engine_attempts WHERE run_id=$1 ORDER BY evaluated_at,id LIMIT 1',
        [diagnostic.run_id],
      )
    ).rows[0]!.id;
    await review(teacher, id, { correct: false, comment: 'Уточнение после беседы с учеником.' });
    const saved = (
      await f.db.query('SELECT result FROM diagnostic_sessions WHERE id=$1', [p.plan.diagnosticId])
    ).rows[0]!.result;
    expect(saved).toEqual(diagnostic.result);
    expect((await f.plan(student, p.plan.id)).assignments.map((a) => a.reason)).toEqual(
      p.assignments.map((a) => a.reason),
    );
    const apiResult = await f.app.inject({
      url: `/api/v1/diagnostics/${p.plan.diagnosticId}`,
      headers: student.headers,
    });
    expect(apiResult.json().data.diagnostic.teacherReviewedAttempts).toBe(1);
    expect((await detail(student, id)).attempt.evaluation!.correct).toBe(false);
  });
  it('preserves confirmed speech text and original assistant feedback when a teacher corrects its grade', async () => {
    const { student, teacher } = await group(),
      run = await lesson(student),
      wrong = f.answerFor(run, false);
    if (wrong.type !== 'choice') throw new Error('Choice expected');
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/speech/text`,
      headers: student.headers,
      payload: {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        text: 'Моя подтверждённая реплика',
        optionId: wrong.optionId,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().data.input.attemptId,
      originalReply = response.json().data.input.reply;
    await review(teacher, id);
    const d = await detail(teacher, id);
    expect(d.speechInput!.confirmedText).toBe('Моя подтверждённая реплика');
    expect(d.speechInput!.reply).toBe(originalReply);
    expect(d.attempt.evaluation!.source).toBe('teacher');
  });
  it('pages a long immutable review history without hiding the current assessment', async () => {
    const { student, teacher } = await group(),
      run = await f.answer(student, await lesson(student), false),
      id = run.attempts[0]!.id;
    for (let n = 0; n < 22; n++)
      await review(teacher, id, {
        revision: n,
        decision: n === 0 ? 'correct' : 'comment',
        correct: n === 0 ? true : undefined,
        comment: `Проверка ${n + 1}`,
      });
    const d = await detail(student, id);
    expect(d.reviews).toHaveLength(20);
    expect(d.nextReviewCursor).toEqual({ revision: 3 });
    const service = new TeacherService(f.db),
      next = await service.detail(student.actor, id, 3);
    expect(next.reviews.map((r) => r.revision)).toEqual([2, 1]);
    expect(next.attempt.teacherReview!.correct).toBe(true);
  });
  it('serializes teacher plan changes with engine answers and assignment starts', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student),
      run = await f.start(student, p.plan.id, p.assignments[0]!.id);
    const [answered, added] = await Promise.all([
      f.answer(student, run, false),
      add(teacher, p.plan.id, 'rki-01-practice-choice'),
    ]);
    expect(answered.attempts).toHaveLength(1);
    expect(added.statusCode).toBe(200);
    const plan = await f.plan(student, p.plan.id);
    expect(new Set(plan.assignments.map((a) => a.position)).size).toBe(plan.assignments.length);
    const target = p.assignments[1]!.id;
    const responses = await Promise.all([
      f.app.inject({
        method: 'POST',
        url: `/api/v1/teacher/plans/${p.plan.id}/assignments/${target}`,
        headers: teacher.headers,
        payload: {
          operationId: randomUUID(),
          revision: 0,
          action: 'cancel',
          dueAt: null,
          reason: 'Отмена до начала.',
        },
      }),
      f.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${p.plan.id}/assignments/${target}/start`,
        headers: student.headers,
        payload: {},
      }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });
  it('lists only assigned students and real attempts, with pinned answers, hints and reviewer-only criteria', async () => {
    const { student, teacher } = await group();
    await f.active();
    let run = await lesson(student);
    const hint = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/hint`,
      headers: student.headers,
      payload: { turnId: run.current!.turn.id, index: 0 },
    });
    expect(hint.statusCode).toBe(200);
    run = await f.answer(student, run, false);
    const id = run.attempts[0]!.id;
    const list = await f.app.inject({ url: '/api/v1/teacher/students', headers: teacher.headers });
    expect(list.json().data.map((u: { id: string }) => u.id)).toEqual([student.actor.user.id]);
    const page = await f.app.inject({
      url: `/api/v1/learning/attempts?userId=${student.actor.user.id}`,
      headers: teacher.headers,
    });
    const data = attemptsPageSchema.parse(page.json().data);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.reviewable).toBe(true);
    const saved = await detail(teacher, id);
    expect(saved.attempt.usedHints).toHaveLength(1);
    expect(saved.solution).not.toBeNull();
    expect((await detail(student, id)).solution).toBeNull();
    expect(saved.attempt.automaticEvaluation!.source).toBe('luch-engine');
  });
  it('corrects a grade transactionally, preserving original evidence and sharing the same effective result everywhere', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student);
    let run = await f.start(student, p.plan.id, p.assignments[0]!.id);
    run = await f.answer(student, run, false);
    const id = run.attempts[0]!.id;
    const before = (await f.db.query('SELECT * FROM engine_attempts WHERE id=$1', [id])).rows[0]!,
      assignmentsBefore = (await f.plan(student, p.plan.id)).assignments.length;
    const operationId = randomUUID(),
      first = await review(teacher, id, { operationId }),
      again = await review(teacher, id, { operationId });
    expect(again.json().data.attempt.teacherReview.id).toBe(
      first.json().data.attempt.teacherReview.id,
    );
    for (const user of [student, teacher]) {
      const d = await detail(user, id);
      expect(d.attempt.evaluation!.correct).toBe(true);
      expect(d.attempt.evaluation!.source).toBe('teacher');
      expect(d.attempt.automaticEvaluation!.correct).toBe(false);
      expect(d.attempt.independent).toBe(true);
      expect(d.reviews).toHaveLength(1);
    }
    const after = (await f.db.query('SELECT * FROM engine_attempts WHERE id=$1', [id])).rows[0]!;
    expect(after.answer).toEqual(before.answer);
    expect(after.evaluation).toEqual(before.evaluation);
    expect(after.is_correct).toBe(false);
    const obs = (await f.db.query('SELECT * FROM skill_observations WHERE attempt_id=$1', [id]))
      .rows[0]!;
    expect(obs.outcome).toBe('independent_success');
    expect(obs.automatic_outcome).toBe('mistake');
    expect((await f.view(student, run.run.id)).attempts[0]!.evaluation!.correct).toBe(true);
    expect((await f.plan(student, p.plan.id)).assignments).toHaveLength(assignmentsBefore);
    const dashboard = studentDashboardSchema.parse(
      (await f.app.inject({ url: '/api/v1/student/dashboard', headers: student.headers })).json()
        .data,
    );
    expect(dashboard.progress.teacherReviewedAttempts).toBe(1);
    expect(dashboard.recentResults[0]!.teacherReviewed).toBe(true);
    const history = await f.app.inject({
      url: `/api/v1/plans/${p.plan.id}/history`,
      headers: student.headers,
    });
    expect(
      history.json().data.items.some((i: { action: string }) => i.action === 'assessment_reviewed'),
    ).toBe(true);
    expect(await count('teacher_actions')).toBe(1);
  });
  it('supports confirmation, comment-only decisions, later corrections and a complete revision history', async () => {
    const { student, teacher } = await group(),
      run = await f.answer(student, await lesson(student), true),
      id = run.attempts[0]!.id;
    await review(teacher, id, {
      decision: 'confirm',
      correct: undefined,
      comment: 'Подтверждаю самостоятельный ответ.',
    });
    await review(teacher, id, {
      revision: 1,
      decision: 'comment',
      correct: undefined,
      comment: 'Попробуйте другой пример.',
    });
    let d = await detail(student, id);
    expect(d.attempt.reviewRevision).toBe(2);
    expect(d.attempt.teacherReview!.revision).toBe(1);
    expect(d.attempt.evaluation!.correct).toBe(true);
    await review(teacher, id, {
      revision: 2,
      decision: 'correct',
      correct: false,
      comment: 'Уточнение после повторной проверки.',
    });
    d = await detail(student, id);
    expect(d.reviews.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(d.attempt.automaticEvaluation!.correct).toBe(true);
    expect(d.attempt.evaluation!.correct).toBe(false);
  });
  it('rebuilds older skill evidence without losing a later result or inventing independent success with help', async () => {
    const { student, teacher } = await group();
    let run = await lesson(student);
    const h = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/hint`,
      headers: student.headers,
      payload: { turnId: run.current!.turn.id, index: 0 },
    });
    expect(h.statusCode).toBe(200);
    run = await f.answer(student, run, false);
    const first = run.attempts[0]!.id;
    run = await f.next(student, run);
    run = await f.answer(student, run, true);
    const last = run.attempts.at(-1)!.id;
    await review(teacher, first);
    const s = (
      await f.db.query('SELECT * FROM student_skill_states WHERE user_id=$1', [
        student.actor.user.id,
      ])
    ).rows[0]!;
    expect(s.last_attempt_id).toBe(last);
    expect(s.independent_successes).toBe(1);
    expect(s.hinted_successes).toBe(1);
    expect(s.mistakes).toBe(0);
    expect(s.independent_streak).toBe(1);
    expect((await detail(student, first)).attempt.independent).toBe(false);
  });
  it('uses the reviewed grade when deferred assignment evidence is processed on completion', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student),
      result = planViewSchema.parse(
        (await add(teacher, p.plan.id, 'rki-01-practice-choice')).json().data,
      ),
      a = result.assignments.find((a) => a.kind === 'teacher')!;
    let run = await f.start(student, p.plan.id, a.id);
    run = await f.answer(student, run, false);
    const id = run.attempts[0]!.id;
    expect(
      (await f.db.query('SELECT 1 FROM skill_observations WHERE attempt_id=$1', [id])).rows,
    ).toHaveLength(0);
    await review(teacher, id);
    run = await f.next(student, run);
    expect(run.run.status).toBe('completed');
    const obs = (await f.db.query('SELECT * FROM skill_observations WHERE attempt_id=$1', [id]))
      .rows[0]!;
    expect(obs.outcome).toBe('independent_success');
    expect(obs.automatic_outcome).toBe('mistake');
    expect(obs.teacher_review_id).not.toBeNull();
  });
  it.each(['diagnostic', 'control'])(
    'blocks teacher feedback and grades during an unfinished %s and preserves the original diagnostic snapshot',
    async (purpose) => {
      const { student, teacher } = await group();
      let run = await f.answer(student, await lesson(student, 'ru', purpose), false),
        id = run.attempts[0]!.id;
      let d = await detail(teacher, id);
      expect(d.reviewable).toBe(false);
      expect(d.solution).toBeNull();
      expect(d.attempt.evaluation).toBeNull();
      await review(teacher, id, {}, 409);
      expect(await count('teacher_reviews')).toBe(0);
      run = await f.finish(student, run.run.id);
      await review(teacher, id);
      d = await detail(student, id);
      expect(d.attempt.teacherReview).not.toBeNull();
      expect(d.attempt.evaluation!.correct).toBe(true);
    },
  );
  it('rejects stale revisions, changed payloads and duplicate concurrent deliveries safely', async () => {
    const { student, teacher } = await group(),
      run = await f.answer(student, await lesson(student), false),
      id = run.attempts[0]!.id,
      operationId = randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 3 }, () => review(teacher, id, { operationId })),
    );
    expect(new Set(replies.map((r) => r.json().data.attempt.teacherReview.id)).size).toBe(1);
    expect(await count('teacher_reviews')).toBe(1);
    await review(teacher, id, { operationId, comment: 'Другой текст.' }, 409);
    await review(
      teacher,
      id,
      { decision: 'comment', correct: undefined, comment: 'Старая версия' },
      409,
    );
    expect(await count('teacher_reviews')).toBe(1);
  });
  it.each(['ru', 'en'] as const)(
    'assigns a pinned %s exercise, replays it without duplication and starts the original exercise in the existing engine',
    async (language) => {
      const { student, teacher } = await group(),
        p = await f.preparedPlan(student, { language }),
        exerciseId = language === 'ru' ? 'rki-01-practice-choice' : 'english-01-practice-choice',
        operationId = randomUUID();
      const bank = await f.app.inject({
        url: `/api/v1/plans/${p.plan.id}/exercise-bank`,
        headers: teacher.headers,
      });
      expect(bank.statusCode, bank.body).toBe(200);
      expect(JSON.stringify(bank.json())).not.toContain('correctOptionIds');
      const first = planViewSchema.parse(
          (await add(teacher, p.plan.id, exerciseId, { operationId })).json().data,
        ),
        again = planViewSchema.parse(
          (await add(teacher, p.plan.id, exerciseId, { operationId })).json().data,
        );
      expect(again.assignments).toHaveLength(7);
      const a = first.assignments.find((a) => a.kind === 'teacher')!;
      expect(a.reason.text).toBe('Дополнительная практика с преподавателем.');
      expect(first.writable).toBe(false);
      expect(first.manageable).toBe(true);
      const run = await f.start(student, p.plan.id, a.id);
      expect(run.run.sourceType).toBe('assignment');
      expect(run.current!.exercise.id).toBe(exerciseId);
      expect(run.current!.generatedExerciseId).toBeNull();
      expect(await count('provider_requests')).toBe(0);
      await add(
        teacher,
        p.plan.id,
        language === 'ru' ? 'english-01-practice-choice' : 'rki-01-practice-choice',
        {},
        400,
      );
    },
  );
  it('reschedules pending work, retains original reasons and rejects a stale or already-started edit', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student),
      a = p.assignments[0]!,
      dueAt = new Date(Date.now() + 86400000).toISOString(),
      operationId = randomUUID();
    let result = planViewSchema.parse(
      (await update(teacher, p.plan.id, a.id, { operationId, dueAt })).json().data,
    );
    await update(teacher, p.plan.id, a.id, { operationId, dueAt });
    expect(result.assignments[0]!.dueAt).toBe(dueAt);
    expect(result.assignments[0]!.reason).toEqual(a.reason);
    expect(result.assignments[0]!.revision).toBe(1);
    expect(result.assignments[0]!.canStart).toBe(false);
    await update(teacher, p.plan.id, a.id, {}, 409);
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${p.plan.id}/assignments/${a.id}/start`,
      headers: student.headers,
      payload: {},
    });
    expect(r.statusCode).toBe(409);
    expect(await count('provider_requests')).toBe(0);
    result = planViewSchema.parse(
      (await update(teacher, p.plan.id, a.id, { revision: 1 })).json().data,
    );
    await f.start(student, p.plan.id, a.id);
    await update(
      teacher,
      p.plan.id,
      a.id,
      { revision: result.assignments[0]!.revision, action: 'cancel' },
      409,
    );
  });
  it('cancels pending assignments without marking them completed and supports a fully cleared plan', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student);
    for (const a of p.assignments)
      await update(teacher, p.plan.id, a.id, {
        action: 'cancel',
        reason: 'Освобождаем план для новых назначений.',
      });
    const view = await f.plan(student, p.plan.id);
    expect(view.plan.totalAssignments).toBe(0);
    expect(view.plan.completedAssignments).toBe(0);
    expect(view.plan.cancelledAssignments).toBe(6);
    expect(view.plan.status).toBe('active');
    expect(view.plan.completedAt).toBeNull();
    expect(view.nextAssignmentId).toBeNull();
    expect(view.assignments.every((a) => a.status === 'cancelled' && !a.canStart)).toBe(true);
    const home = studentDashboardSchema.parse(
      (await f.app.inject({ url: '/api/v1/student/dashboard', headers: student.headers })).json()
        .data,
    );
    expect(home.today).toHaveLength(0);
    expect(home.nextAssignment).toBeNull();
    expect(home.progress.completedLessons).toBe(0);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${p.plan.id}/assignments/${p.assignments[0]!.id}/start`,
      headers: student.headers,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
  });
  it('shares saved comments, assignment changes and history with the student, with stable pagination', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student);
    await add(teacher, p.plan.id, 'rki-01-practice-choice');
    await update(teacher, p.plan.id, p.assignments[0]!.id, { action: 'cancel' });
    let run = await f.start(student, p.plan.id, p.assignments[1]!.id);
    run = await f.answer(student, run, false);
    await review(teacher, run.attempts[0]!.id);
    const service = new TeacherService(f.db),
      first = teacherActionsPageSchema.parse(await service.updates(student.actor, { limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const next = teacherActionsPageSchema.parse(
      await service.updates(student.actor, {
        limit: 2,
        beforeCreatedAt: first.nextCursor!.createdAt,
        beforeId: first.nextCursor!.id,
      }),
    );
    expect(next.items).toHaveLength(1);
    expect(new Set([...first.items, ...next.items].map((a) => a.id)).size).toBe(3);
  });
  it('keeps review and assignment mutations atomic when persistence fails', async () => {
    const { student, teacher } = await group(),
      p = await f.preparedPlan(student),
      run = await f.answer(student, await f.start(student, p.plan.id, p.assignments[0]!.id), false),
      id = run.attempts[0]!.id;
    const broken = new TeacherService(failOn(f.db, 'INSERT INTO learning_plan_changes'));
    await expect(
      broken.review(teacher.actor, id, {
        operationId: randomUUID(),
        revision: 0,
        decision: 'correct',
        correct: true,
        comment: 'Не должно сохраниться частично.',
      }),
    ).rejects.toThrow();
    expect((await detail(student, id)).attempt.teacherReview).toBeNull();
    expect(await count('teacher_actions')).toBe(0);
    await expect(
      broken.assign(teacher.actor, p.plan.id, {
        operationId: randomUUID(),
        exerciseId: 'rki-01-practice-choice',
        dueAt: null,
        reason: 'Не должно появиться частичное назначение.',
        estimatedMinutes: 3,
      }),
    ).rejects.toThrow();
    expect((await f.plan(student, p.plan.id)).assignments).toHaveLength(7);
    expect(await count('teacher_actions')).toBe(0);
  });
  it('enforces ownership, current teacher relationship, CSRF and unchanged engine permissions', async () => {
    const { student, teacher } = await group(),
      foreign = await f.active('teacher'),
      peer = await f.active(),
      admin = await f.active('admin'),
      p = await f.preparedPlan(student),
      run = await f.answer(student, await f.start(student, p.plan.id, p.assignments[0]!.id), false),
      id = run.attempts[0]!.id;
    for (const user of [foreign, peer]) {
      expect(
        (await f.app.inject({ url: `/api/v1/learning/attempts/${id}`, headers: user.headers }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await f.app.inject({
            url: `/api/v1/learning/teacher-updates?userId=${student.actor.user.id}`,
            headers: user.headers,
          })
        ).statusCode,
      ).toBe(404);
    }
    await review(student, id, {}, 403);
    await review(admin, id, {}, 403);
    await review(foreign, id, {}, 404);
    await add(student, p.plan.id, 'rki-01-practice-choice', {}, 403);
    await add(foreign, p.plan.id, 'rki-01-practice-choice', {}, 404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/teacher/attempts/${id}/reviews`,
          headers: { cookie: teacher.headers.cookie },
          payload: { operationId: randomUUID(), revision: 0, decision: 'comment', comment: 'CSRF' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/plans/${p.plan.id}/assignments/${p.assignments[1]!.id}/start`,
          headers: teacher.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await f.db.query('DELETE FROM teacher_students WHERE teacher_id=$1', [teacher.actor.user.id]);
    await review(teacher, id, {}, 404);
    expect((await f.app.inject({ url: `/api/v1/learning/attempts/${id}` })).statusCode).toBe(401);
  });
});
