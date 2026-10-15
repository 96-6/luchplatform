import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { DashboardService } from '../apps/api/dist/modules/dashboard/service.js';

const settings = loadSettings();
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Plan smoke requires an isolated development/test database.');
const db = await createDatabase(settings);
try {
  const user = (
    await db.query('SELECT * FROM users WHERE email=$1', ['compose-diagnostic@example.test'])
  ).rows[0];
  assert.ok(user, 'Run diagnostic-smoke verify first.');
  const actor = { user: publicUser(user), sessionId: randomUUID(), tokenHash: 'smoke' },
    service = new PlansService(db);
  const diagnostic = (
    await db.query(
      'SELECT * FROM diagnostic_sessions WHERE user_id=$1 AND result IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',
      [user.id],
    )
  ).rows[0];
  assert.ok(diagnostic);
  const plan = await service.generate(actor, diagnostic.id);
  assert.equal(plan.plan.packageVersion, diagnostic.package_version);
  assert.equal(plan.assignments.filter((a) => a.kind === 'initial').length, 6);
  assert.equal(plan.assignments[0].reason.kind, 'diagnostic_gap');
  const assignment = plan.assignments[0];
  let view = await service.startAssignment(actor, plan.plan.id, assignment.id);
  const dashboard = new DashboardService(db);
  const home = await dashboard.read(actor, 'Europe/Moscow');
  assert.equal(home.plan.id, plan.plan.id);
  assert.equal(home.profile.language, 'en');
  assert.equal(home.profile.goal, 'work');
  if (view.current) assert.equal(home.continueRun.id, view.run.id);
  const answer = async () => {
    const e = await service.engine.content.definition(
      'exercises',
      view.run.packageId,
      view.run.packageVersion,
      view.current.exercise.id,
    );
    return e.solution.type === 'choice'
      ? { type: 'choice', optionId: e.solution.correctOptionIds[0] }
      : { type: 'short_text', text: e.solution.accepted[0] };
  };
  if (process.argv[2] !== 'verify' && view.current) {
    if (view.current.position === 0) {
      view = (
        await service.engine.answer(actor, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(),
        })
      ).view;
      view = await service.engine.next(actor, view.run.id, view.current.turn.id);
    }
    await service.engine.save(actor, view.run.id, {
      turnId: view.current.turn.id,
      revision: view.current.turn.draftRevision + 1,
      draftAnswer: await answer(),
      paused: true,
    });
    const home = await dashboard.read(actor, 'Europe/Moscow');
    assert.equal(home.continueRun.id, view.run.id);
    assert.equal(home.continueRun.completedSteps, 1);
    assert.ok(home.today.some((a) => a.id === assignment.id && a.runId === view.run.id));
    console.log('Initial plan, reason, draft and student dashboard persisted.');
  } else {
    if (view.current) {
      assert.equal(view.current.position, 1);
      assert.equal(view.attempts.length, 1);
      assert.ok(view.current.turn.draftAnswer);
    }
    while (view.current) {
      if (!view.current.attempt)
        view = (
          await service.engine.answer(actor, view.run.id, {
            turnId: view.current.turn.id,
            operationId: randomUUID(),
            answer: await answer(),
          })
        ).view;
      view = await service.engine.next(actor, view.run.id, view.current.turn.id);
    }
    const saved = await service.read(actor, plan.plan.id);
    assert.equal(saved.assignments[0].runId, view.run.id);
    assert.equal(saved.assignments[0].status, 'completed');
    assert.equal(saved.plan.completedAssignments, 1);
    assert.equal(view.run.planIds.includes(plan.plan.id), true);
    assert.deepEqual(saved.assignments[0].reason, assignment.reason);
    const home = await dashboard.read(actor, 'Europe/Moscow');
    assert.equal(home.plan.completedAssignments, 1);
    assert.equal(home.progress.completedLessons, 1);
    assert.equal(home.continueRun, null);
    assert.ok(home.recentResults.some((r) => r.runId === view.run.id));
    assert.ok(home.reviews.length > 0);
    console.log(
      'Student dashboard and plan restored after restart; real completion, reviews and reason persisted.',
    );
  }
} finally {
  await db.close();
}
