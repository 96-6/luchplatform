import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { TeacherService } from '../apps/api/dist/modules/teacher/service.js';
import { ReportsService } from '../apps/api/dist/modules/reports/service.js';
import { receiveIntegrity } from '../apps/api/dist/modules/engine/integrity.js';
const settings = loadSettings(),
  verify = process.argv[2] === 'verify',
  file = process.env.REPORT_SMOKE_FILE ?? '/tmp/luch-report-smoke.json';
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw Error('Report smoke requires an isolated development/test database.');
const db = await createDatabase(settings);
try {
  const diagnostics = new DiagnosticsService(db),
    plans = new PlansService(db),
    teacher = new TeacherService(db),
    reports = new ReportsService(db);
  async function actor(name, role) {
    const email = `compose-report-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT(email) DO NOTHING',
        [randomUUID(), email, 'Report persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row, 'Run report-smoke before verification.');
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
  const tutor = await actor('tutor', 'teacher'),
    expected = verify ? JSON.parse(await readFile(file, 'utf8')) : [];
  for (const language of ['ru', 'en']) {
    const student = await actor(language, 'student');
    if (!verify) {
      await db.query(
        'INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [tutor.user.id, student.user.id],
      );
      await diagnostics.profiles.save(student, {
        language,
        goal: 'travel',
        experience: 'none',
        minutesPerDay: 20,
        revision: 0,
      });
      const diagnostic = await diagnostics.start(student, { profileRevision: 1, restart: false });
      let run = await plans.engine.repository.view(student, diagnostic.diagnostic.runId);
      while (run.current) {
        run = (
          await plans.engine.answer(student, run.run.id, {
            turnId: run.current.turn.id,
            operationId: randomUUID(),
            answer: await answer(run),
          })
        ).view;
        run = await plans.engine.next(student, run.run.id, run.current.turn.id);
      }
      const planId = (await diagnostics.read(student, diagnostic.diagnostic.id)).planId;
      let plan = await plans.read(student, planId);
      run = await plans.startAssignment(student, planId, plan.assignments[0].id);
      await db.query("UPDATE engine_turns SET started_at=now()-interval '5 seconds' WHERE id=$1", [
        run.current.turn.id,
      ]);
      await receiveIntegrity(db, student, run.run.id, {
        turnId: run.current.turn.id,
        batchId: randomUUID(),
        stats: {
          durationMilliseconds: 2000,
          hiddenMilliseconds: 500,
          tabHides: 1,
          pasteEvents: 1,
          focusLosses: 0,
          returns: 0,
          pointerSamples: 0,
          pointerDistance: 0,
          fastMoves: 0,
          straightMoves: 0,
          syntheticEvents: 0,
          inputEvents: 0,
          copyEvents: 0,
          pointerTypes: [],
          keyboardNavigation: false,
        },
      });
      run = (
        await plans.engine.answer(student, run.run.id, {
          turnId: run.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(run),
        })
      ).view;
      run = await plans.engine.next(student, run.run.id, run.current.turn.id);
      run = await plans.engine.hint(student, run.run.id, run.current.turn.id, 0);
      run = (
        await plans.engine.answer(student, run.run.id, {
          turnId: run.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(run, false),
        })
      ).view;
      await teacher.review(tutor, run.current.attempt.id, {
        operationId: randomUUID(),
        revision: 0,
        decision: 'correct',
        correct: true,
        comment: 'Сохранённая проверка для общего отчёта.',
      });
      await plans.engine.next(student, run.run.id, run.current.turn.id);
      plan = await teacher.assign(tutor, planId, {
        operationId: randomUUID(),
        exerciseId: language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
        dueAt: null,
        estimatedMinutes: 3,
        reason: 'Следующий шаг из учебного отчёта.',
      });
      const next = plan.assignments.find((a) => a.kind === 'teacher'),
        cancel = plan.assignments.find((a) => a.kind === 'initial' && a.status === 'pending');
      await teacher.updateAssignment(tutor, planId, cancel.id, {
        operationId: randomUUID(),
        revision: 0,
        action: 'cancel',
        dueAt: null,
        reason: 'Заменено практикой из отчёта.',
      });
      const s = await reports.read(student, student.user.id, { language }),
        t = await reports.read(tutor, student.user.id, { language });
      assert.deepEqual(s.report, t.report);
      assert.equal(s.reviewer, null);
      assert.equal(s.report.counts.teacherReviewedAttempts, 1);
      assert.equal(s.report.counts.assistedCorrect, 1);
      assert.equal(t.reviewer.evidenceReductionUnits, 0.2);
      assert.ok(s.report.planChangesCount > 0);
      expected.push({
        language,
        report: s.report,
        reviewer: t.reviewer,
        planId,
        nextAssignmentId: next.id,
      });
    } else {
      const saved = expected.find((e) => e.language === language),
        s = await reports.read(student, student.user.id, { language }),
        t = await reports.read(tutor, student.user.id, { language });
      assert.deepEqual(s.report, saved.report);
      assert.deepEqual(t.report, s.report);
      assert.deepEqual(t.reviewer, saved.reviewer);
      assert.equal(s.reviewer, null);
      assert.equal(s.report.completion.cancelledAssignments, 1);
      const run = await plans.startAssignment(student, saved.planId, saved.nextAssignmentId);
      assert.equal(run.run.sourceType, 'assignment');
      await plans.engine.answer(student, run.run.id, {
        turnId: run.current.turn.id,
        operationId: randomUUID(),
        answer: await answer(run),
      });
      const updated = await reports.read(student, student.user.id, { language }),
        reviewed = await reports.read(tutor, student.user.id, { language });
      assert.equal(updated.report.counts.submittedAttempts, s.report.counts.submittedAttempts + 1);
      assert.notEqual(updated.report.revision, s.report.revision);
      assert.deepEqual(updated.report, reviewed.report);
    }
  }
  if (!verify) await writeFile(file, JSON.stringify(expected), { mode: 0o600 });
  console.log(
    verify
      ? 'Report restart verified for RU/EN: shared results, skills, original/current grades, help, private weights, plan history and next assignments restored; new answers update the same report.'
      : 'Learning reports and private weighted evidence persisted for RU/EN; public reports match the assigned teacher.',
  );
} finally {
  await db.close();
}
