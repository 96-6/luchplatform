import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { TeacherService } from '../apps/api/dist/modules/teacher/service.js';
import { DashboardService } from '../apps/api/dist/modules/dashboard/service.js';
const settings = loadSettings(),
  verify = process.argv[2] === 'verify';
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Teacher smoke requires an isolated development/test database.');
const db = await createDatabase(settings);
try {
  const teacher = new TeacherService(db),
    plans = new PlansService(db),
    diagnostics = new DiagnosticsService(db);
  async function actor(name, role) {
    const email = `compose-teacher-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
        [randomUUID(), email, 'Teacher persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row, 'Run teacher-smoke before verification.');
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' };
  }
  async function answer(view, correct = true) {
    const e = await plans.engine.content.definition(
      'exercises',
      view.run.packageId,
      view.run.packageVersion,
      view.current.exercise.id,
    );
    return e.solution.type === 'short_text'
      ? { type: 'short_text', text: correct ? e.solution.accepted[0] : 'wrong' }
      : {
          type: 'choice',
          optionId: e.response.options.find(
            (o) => e.solution.correctOptionIds.includes(o.id) === correct,
          ).id,
        };
  }
  async function planFor(student, language) {
    const saved = (
      await db.query(
        'SELECT id FROM learning_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [student.user.id],
      )
    ).rows[0];
    if (saved) return plans.read(student, saved.id);
    assert.equal(verify, false);
    await diagnostics.profiles.save(student, {
      language,
      goal: 'daily_life',
      experience: 'none',
      minutesPerDay: 20,
      revision: 0,
    });
    const diagnostic = await diagnostics.start(student, { profileRevision: 1, restart: false });
    let view = await diagnostics.engine.repository.view(student, diagnostic.diagnostic.runId);
    while (view.current) {
      view = (
        await diagnostics.engine.answer(student, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(view),
        })
      ).view;
      view = await diagnostics.engine.next(student, view.run.id, view.current.turn.id);
    }
    return plans.read(student, (await diagnostics.read(student, diagnostic.diagnostic.id)).planId);
  }
  const tutor = await actor('tutor', 'teacher');
  for (const language of ['ru', 'en']) {
    const student = await actor(language, 'student');
    if (!verify)
      await db.query(
        'INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [tutor.user.id, student.user.id],
      );
    let plan = await planFor(student, language),
      view = await plans.startAssignment(
        student,
        plan.plan.id,
        plan.assignments.find((a) => a.kind === 'initial').id,
      );
    if (!verify) {
      view = await plans.engine.hint(student, view.run.id, view.current.turn.id, 0);
      view = (
        await plans.engine.answer(student, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(view, false),
        })
      ).view;
      const attempt = view.attempts[0];
      let detail = await teacher.review(tutor, attempt.id, {
        operationId: randomUUID(),
        revision: 0,
        decision: 'correct',
        correct: true,
        comment: 'Ответ принят преподавателем после проверки контекста.',
      });
      detail = await teacher.review(tutor, attempt.id, {
        operationId: randomUUID(),
        revision: 1,
        decision: 'comment',
        comment: 'Обратите внимание на форму представления.',
      });
      assert.equal(detail.attempt.automaticEvaluation.correct, false);
      assert.equal(detail.attempt.evaluation.correct, true);
      assert.equal(detail.attempt.independent, false);
      plan = await teacher.assign(tutor, plan.plan.id, {
        operationId: randomUUID(),
        exerciseId: language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
        dueAt: null,
        estimatedMinutes: 3,
        reason: 'Практика по комментарию преподавателя.',
      });
      const assigned = plan.assignments.find((a) => a.kind === 'teacher');
      plan = await teacher.updateAssignment(tutor, plan.plan.id, assigned.id, {
        operationId: randomUUID(),
        revision: 0,
        action: 'reschedule',
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Переносим практику на следующий день.',
      });
      const correction = plan.assignments.find((a) => a.kind === 'correction');
      assert.ok(correction);
      await teacher.updateAssignment(tutor, plan.plan.id, correction.id, {
        operationId: randomUUID(),
        revision: 0,
        action: 'cancel',
        dueAt: null,
        reason: 'Автоматическая коррекция заменена заданием преподавателя.',
      });
      view = await plans.engine.next(student, view.run.id, view.current.turn.id);
      await plans.engine.save(student, view.run.id, {
        turnId: view.current.turn.id,
        revision: 1,
        draftAnswer: { type: 'short_text', text: 'Teacher reviewed draft' },
        paused: true,
      });
      assert.equal((await teacher.updates(student, { limit: 20 })).items.length, 5);
    } else {
      assert.equal(view.current.turn.draftAnswer.text, 'Teacher reviewed draft');
      const attempt = view.attempts[0],
        detail = await teacher.detail(student, attempt.id);
      assert.equal(detail.attempt.evaluation.source, 'teacher');
      assert.equal(detail.attempt.evaluation.correct, true);
      assert.equal(detail.attempt.automaticEvaluation.correct, false);
      assert.equal(detail.attempt.independent, false);
      assert.equal(detail.attempt.usedHints.length, 1);
      assert.equal(detail.reviews.length, 2);
      const original = (await db.query('SELECT * FROM engine_attempts WHERE id=$1', [attempt.id]))
        .rows[0];
      assert.equal(original.is_correct, false);
      const actions = (
        await db.query('SELECT * FROM teacher_actions WHERE student_id=$1 ORDER BY created_at,id', [
          student.user.id,
        ])
      ).rows;
      assert.equal(actions.length, 5);
      for (const action of actions) {
        const { attemptId, planId, assignmentId, ...payload } = action.request;
        if (action.kind === 'review') await teacher.review(tutor, attemptId, payload);
        else if (action.kind === 'assignment_added') await teacher.assign(tutor, planId, payload);
        else await teacher.updateAssignment(tutor, planId, assignmentId, payload);
      }
      assert.equal((await teacher.updates(student, { limit: 20 })).items.length, 5);
      plan = await plans.read(student, plan.plan.id);
      assert.equal(plan.plan.cancelledAssignments, 1);
      const assigned = plan.assignments.find((a) => a.kind === 'teacher'),
        cancelled = plan.assignments.find((a) => a.status === 'cancelled');
      assert.equal(assigned.canStart, false);
      await assert.rejects(plans.startAssignment(student, plan.plan.id, assigned.id), {
        code: 'ASSIGNMENT_NOT_DUE',
      });
      await assert.rejects(plans.startAssignment(student, plan.plan.id, cancelled.id), {
        code: 'ASSIGNMENT_CANCELLED',
      });
      const home = await new DashboardService(db).read(student);
      assert.equal(home.progress.teacherReviewedAttempts, 1);
      assert.ok(home.today.every((a) => a.id !== cancelled.id));
      plan = await teacher.updateAssignment(tutor, plan.plan.id, assigned.id, {
        operationId: randomUUID(),
        revision: 1,
        action: 'reschedule',
        dueAt: null,
        reason: 'Можно продолжать практику после перерыва.',
      });
      const next = await plans.startAssignment(student, plan.plan.id, assigned.id);
      assert.equal(next.run.sourceType, 'assignment');
      assert.equal(next.current.generatedExerciseId, null);
      assert.equal(
        next.current.exercise.id,
        language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
      );
    }
  }
  console.log(
    verify
      ? 'Teacher restart verified for RU/EN: original and effective grades, comments, authors, hints, plans, cancellations, due dates and drafts restored; repeat deliveries do not duplicate changes and students can start assigned practice.'
      : 'Teacher reviews, shared feedback, assigned exercises, schedule changes, cancellations and unfinished student drafts persisted for RU/EN.',
  );
} finally {
  await db.close();
}
