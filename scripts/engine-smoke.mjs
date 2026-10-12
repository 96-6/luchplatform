import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startRunSchema } from '@luch/contracts';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { LuchEngine } from '../apps/api/dist/modules/engine/service.js';

const settings = loadSettings();
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Engine smoke requires an isolated development/test database with dev tools.');
const db = await createDatabase(settings);
try {
  const email = 'compose-engine@example.test';
  await db.query(
    'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
    [randomUUID(), email, 'Compose engine check', 'student'],
  );
  const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  const actor = { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' };
  const engine = new LuchEngine(db);
  let view = await engine.start(
    actor,
    startRunSchema.parse({
      packageId: 'luch-demo',
      packageVersion: 1,
      source: { type: 'lesson', id: 'rki-01' },
    }),
  );
  const answer = async () => {
    const exercise = await engine.content.definition(
      'exercises',
      view.run.packageId,
      view.run.packageVersion,
      view.current.exercise.id,
    );
    return exercise.solution.type === 'choice'
      ? { type: 'choice', optionId: exercise.solution.correctOptionIds[0] }
      : { type: 'short_text', text: exercise.solution.accepted[0] };
  };
  if (process.argv[2] !== 'verify') {
    if (view.current?.position === 0) {
      view = await engine.hint(actor, view.run.id, view.current.turn.id, 0);
      view = (
        await engine.answer(actor, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(),
        })
      ).view;
      view = await engine.next(actor, view.run.id, view.current.turn.id);
    }
    if (view.current)
      await engine.save(actor, view.run.id, {
        turnId: view.current.turn.id,
        draftAnswer: await answer(),
        revision: 1,
        paused: true,
      });
    console.log('Engine answer, hint and unfinished lesson persisted.');
  } else {
    if (view.current) {
      assert.equal(view.current.position, 1);
      assert.equal(view.current.turn.draftAnswer.text, 'зовут');
      assert.equal(view.attempts.length, 1);
      assert.equal(view.attempts[0].usedHints.length, 1);
      view = (
        await engine.answer(actor, view.run.id, {
          turnId: view.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(),
        })
      ).view;
      view = await engine.next(actor, view.run.id, view.current.turn.id);
    }
    assert.equal(view.run.status, 'completed');
    assert.equal(view.attempts.length, 2);
    assert.ok(view.attempts.every((attempt) => attempt.evaluation.correct));
    assert.equal(view.attempts[0].independent, false);
    assert.equal(view.attempts[1].independent, true);
    console.log('Engine lesson resumed and completed after restart.');
  }
} finally {
  await db.close();
}
