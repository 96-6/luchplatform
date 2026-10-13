import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';

const settings = loadSettings();
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Diagnostic smoke requires an isolated development/test database.');
const db = await createDatabase(settings);
try {
  const email = 'compose-diagnostic@example.test';
  await db.query(
    'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
    [randomUUID(), email, 'Compose diagnostic check', 'student'],
  );
  const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  const actor = { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' },
    service = new DiagnosticsService(db);
  await service.profiles.save(actor, {
    language: 'en',
    goal: 'work',
    experience: 'some',
    minutesPerDay: 15,
    revision: 0,
  });
  const d = await service.start(actor, { profileRevision: 1, restart: false });
  let view = await service.engine.repository.view(actor, d.diagnostic.runId);
  const answer = async (correct) => {
    const exercise = await service.engine.content.definition(
      'exercises',
      view.run.packageId,
      view.run.packageVersion,
      view.current.exercise.id,
    );
    return {
      type: 'choice',
      optionId: exercise.response.options.find(
        (o) => exercise.solution.correctOptionIds.includes(o.id) === correct,
      ).id,
    };
  };
  if (process.argv[2] !== 'verify' && !d.result) {
    assert.equal(d.result, null);
    if (view.current.position === 0) {
      view = (
        await service.engine.answer(actor, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(true),
        })
      ).view;
      view = await service.engine.next(actor, view.run.id, view.current.turn.id);
    }
    await service.engine.save(actor, view.run.id, {
      turnId: view.current.turn.id,
      revision: 1,
      draftAnswer: await answer(false),
      paused: true,
    });
    console.log('Questionnaire, diagnostic answer and unfinished draft persisted.');
  } else {
    if (view.current) {
      assert.equal(view.current.position, 1);
      assert.ok(view.current.turn.draftAnswer);
      assert.equal(view.attempts.length, 1);
    }
    while (view.current) {
      view = (
        await service.engine.answer(actor, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(view.current.position % 2 === 0),
        })
      ).view;
      view = await service.engine.next(actor, view.run.id, view.current.turn.id);
    }
    const report = await service.read(actor, d.diagnostic.id);
    assert.equal(report.result.correct, 3);
    assert.equal(report.result.skills.length, 6);
    assert.equal(report.result.preliminary, true);
    assert.equal(report.result.strengthIds.length, 3);
    assert.equal(report.result.difficultyIds.length, 3);
    console.log('Diagnostic resumed after restart; six skill results persisted.');
  }
} finally {
  await db.close();
}
