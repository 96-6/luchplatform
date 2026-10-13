import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { aiCeilingsSchema, aiControlsSchema, updateProviderSchema } from '@luch/contracts';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { AccountCrypto } from '../apps/api/dist/modules/auth/crypto.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { recoverLearningEvents } from '../apps/api/dist/modules/adaptation/processor.js';
import { ProviderSettingsService } from '../apps/api/dist/modules/providers/settings.js';
import { GenerationService } from '../apps/api/dist/modules/providers/generation.js';
import { SpeechService } from '../apps/api/dist/modules/providers/speech.js';
import {
  TextGenerationAdapter,
  ElevenLabsAdapter,
} from '../apps/api/dist/modules/providers/adapters.js';

const settings = loadSettings();
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Adaptation smoke requires an isolated development/test database.');
const db = await createDatabase(settings),
  verify = process.argv[2] === 'verify';
// Synthetic bytes verify binary persistence; Playwright separately checks playable audio.
const audioFixture = Buffer.from('ID3-luch-synthetic-persistence-fixture');
let externalCalls = 0;
const fakeFetch = async (url) => {
  externalCalls++;
  if (verify) throw new Error('A persisted variant and audio must not call a provider again.');
  if (String(url).startsWith('https://api.elevenlabs.io/'))
    return new Response(audioFixture, { headers: { 'content-type': 'audio/mpeg' } });
  return Response.json({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            instruction: 'Прослушайте реплику и выберите приветствие.',
            material: '',
            options: [
              { id: 'a', text: 'До свидания' },
              { id: 'b', text: 'Здравствуйте' },
              { id: 'c', text: 'Вчера' },
            ],
            correctOptionId: 'b',
            explanation: 'Здравствуйте — вежливое приветствие.',
            hint: 'Вспомните начало разговора.',
            listeningText: 'Здравствуйте. Меня зовут Анна.',
          }),
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 100 },
  });
};
try {
  const providers = new ProviderSettingsService(
    db,
    new AccountCrypto(settings.AUTH_ENCRYPTION_KEY),
    {
      OPENAI_API_KEY: '',
      NEUROAPI_API_KEY: '',
      ELEVENLABS_API_KEY: '',
    },
  );
  const generation = new GenerationService(providers, new TextGenerationAdapter(fakeFetch));
  const speech = new SpeechService(providers, new ElevenLabsAdapter(fakeFetch));
  const plans = new PlansService(db, Date.now, (actor, plan, assignment) =>
    generation.prepare(actor, plan, assignment),
  );
  const diagnostics = new DiagnosticsService(db);
  async function actor(name, role = 'student') {
    const email = `compose-adaptation-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
        [randomUUID(), email, `Compose adaptation ${name}`, role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row, 'Run adaptation-smoke before verification.');
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' };
  }
  async function answerFor(view, correct) {
    const e = (
      await db.query(
        `SELECT COALESCE(g.definition,e.definition) AS definition FROM engine_steps s
      JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id
      LEFT JOIN generated_exercises g ON g.id=s.generated_exercise_id WHERE s.id=$1`,
        [view.current.stepId],
      )
    ).rows[0].definition;
    return e.response.type === 'choice'
      ? {
          type: 'choice',
          optionId: e.response.options.find(
            (o) => e.solution.correctOptionIds.includes(o.id) === correct,
          ).id,
        }
      : { type: 'short_text', text: correct ? e.solution.accepted[0] : 'wrong' };
  }
  async function finish(engine, user, view, correct) {
    while (view.current) {
      if (!view.current.attempt)
        view = (
          await engine.answer(user, view.run.id, {
            turnId: view.current.turn.id,
            operationId: randomUUID(),
            answer: await answerFor(view, correct),
          })
        ).view;
      view = await engine.next(user, view.run.id, view.current.turn.id);
    }
    return view;
  }
  async function preparedPlan(user, language) {
    const current = (
      await db.query(
        'SELECT id FROM learning_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [user.user.id],
      )
    ).rows[0];
    if (current) return plans.read(user, current.id);
    assert.equal(verify, false);
    await diagnostics.profiles.save(user, {
      language,
      goal: 'daily_life',
      experience: 'none',
      minutesPerDay: 20,
      revision: 0,
    });
    const d = await diagnostics.start(user, { profileRevision: 1, restart: false });
    await finish(
      diagnostics.engine,
      user,
      await diagnostics.engine.repository.view(user, d.diagnostic.runId),
      true,
    );
    return plans.read(user, (await diagnostics.read(user, d.diagnostic.id)).planId);
  }
  const poor = await actor('error'),
    good = await actor('success'),
    paid = await actor('provider'),
    root = await actor('root', 'superadmin');
  let errorPlan = await preparedPlan(poor, 'ru'),
    successPlan = await preparedPlan(good, 'en'),
    paidPlan = await preparedPlan(paid, 'ru');
  if (!verify) {
    const previous = (
      await db.query('SELECT id,enabled,credential_ciphertext,updated_by FROM external_providers')
    ).rows;
    assert.ok(
      previous.every(
        (p) => (!p.enabled && !p.credential_ciphertext) || p.updated_by === root.user.id,
      ),
      'Use an isolated database without existing real provider configuration.',
    );
    for (const [user, plan, correct] of [
      [poor, errorPlan, false],
      [good, successPlan, true],
      [paid, paidPlan, false],
    ])
      await finish(
        plans.engine,
        user,
        await plans.startAssignment(
          user,
          plan.plan.id,
          plan.assignments.find((a) => a.kind === 'initial').id,
        ),
        correct,
      );
    errorPlan = await plans.read(poor, errorPlan.plan.id);
    successPlan = await plans.read(good, successPlan.plan.id);
    paidPlan = await plans.read(paid, paidPlan.plan.id);
    const correction = errorPlan.assignments.find((a) => a.kind === 'correction');
    let unfinished = await plans.startAssignment(poor, errorPlan.plan.id, correction.id);
    if (!unfinished.current.attempt)
      unfinished = (
        await plans.engine.answer(poor, unfinished.run.id, {
          turnId: unfinished.current.turn.id,
          operationId: randomUUID(),
          answer: await answerFor(unfinished, false),
        })
      ).view;
    assert.equal(unfinished.run.status, 'active');
    assert.equal(successPlan.assignments.find((a) => a.kind === 'review').canStart, false);
    let config = await providers.read(root);
    config = await providers.updateCeilings(root, {
      revision: config.revision,
      ceilings: aiCeilingsSchema.parse({
        lifetimeMicros: 10_000_000,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 20,
        maxTtsCharacters: 2000,
      }),
    });
    for (const id of ['neuroapi', 'elevenlabs'])
      config = await providers.updateProvider(
        root,
        id,
        updateProviderSchema.parse({
          revision: config.providers.find((p) => p.id === id).revision,
          enabled: true,
          model: id === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4.1-mini',
          voiceRu: id === 'elevenlabs' ? 'testRuVoice' : '',
          voiceEn: id === 'elevenlabs' ? 'testEnVoice' : '',
          inputRate: id === 'elevenlabs' ? null : 100000,
          outputRate: id === 'elevenlabs' ? null : 400000,
          characterRate: id === 'elevenlabs' ? 100000 : null,
          confirmPricing: true,
          apiKey: randomBytes(24).toString('hex'),
        }),
      );
    await providers.updateControls(root, {
      revision: config.revision,
      controls: aiControlsSchema.parse({
        enabled: true,
        listeningEnabled: true,
        withListening: true,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 20,
        maxTtsCharacters: 2000,
      }),
    });
    const generatedAssignment = paidPlan.assignments.find((a) => a.kind === 'correction');
    const view = await plans.startAssignment(paid, paidPlan.plan.id, generatedAssignment.id);
    assert.ok(view.current.generatedExerciseId);
    assert.equal(view.current.exercise.hasListening, true);
    await speech.prepare(paid, view.run.id, view.current.stepId, randomUUID());
    await plans.engine.save(paid, view.run.id, {
      turnId: view.current.turn.id,
      revision: view.current.turn.draftRevision + 1,
      draftAnswer: { type: 'choice', optionId: 'b' },
      paused: true,
    });
    assert.equal(externalCalls, 2);
    console.log(
      'Error/success branches, unfinished corrective answer, generated variant, audio and cost ledger persisted.',
    );
  } else {
    assert.equal(await recoverLearningEvents(db), 0);
    const correction = errorPlan.assignments.find((a) => a.kind === 'correction');
    const run = await plans.startAssignment(poor, errorPlan.plan.id, correction.id);
    assert.equal(run.run.totalSteps, 1);
    assert.equal(run.attempts.length, 1);
    assert.equal(run.current.attempt.evaluation.correct, false);
    const originalReason = correction.reason;
    const beforeHistory = (
      await db.query(
        'SELECT * FROM learning_plan_changes WHERE plan_id=$1 ORDER BY created_at,id',
        [errorPlan.plan.id],
      )
    ).rows;
    await plans.engine.next(poor, run.run.id, run.current.turn.id);
    await plans.engine.next(poor, run.run.id, run.current.turn.id);
    const updated = await plans.read(poor, errorPlan.plan.id);
    assert.equal(updated.assignments.filter((a) => a.kind === 'correction').length, 2);
    assert.deepEqual(
      updated.assignments.find((a) => a.id === correction.id).reason,
      originalReason,
    );
    const afterHistory = (
      await db.query(
        'SELECT * FROM learning_plan_changes WHERE plan_id=$1 ORDER BY created_at,id',
        [errorPlan.plan.id],
      )
    ).rows;
    assert.ok(
      beforeHistory.every((change) =>
        afterHistory.some((next) => next.id === change.id && next.reason === change.reason),
      ),
    );
    const review = successPlan.assignments.find((a) => a.kind === 'review');
    await assert.rejects(plans.startAssignment(good, successPlan.plan.id, review.id), {
      code: 'ASSIGNMENT_NOT_DUE',
    });
    const duePlans = new PlansService(db, () => new Date(review.dueAt).getTime() + 1000);
    await finish(
      duePlans.engine,
      good,
      await duePlans.startAssignment(good, successPlan.plan.id, review.id),
      true,
    );
    assert.equal(
      (
        await db.query('SELECT status FROM student_skill_states WHERE user_id=$1 AND skill_id=$2', [
          good.user.id,
          review.reason.skills[0].skillId,
        ])
      ).rows[0].status,
      'confirmed',
    );
    const generated = paidPlan.assignments.find((a) => a.kind === 'correction');
    const view = await plans.startAssignment(paid, paidPlan.plan.id, generated.id);
    assert.ok(
      view.current.generatedExerciseId &&
        view.current.listeningUrl &&
        view.current.turn.draftAnswer,
    );
    const cached = await speech.prepare(paid, view.run.id, view.current.stepId, randomUUID());
    assert.equal(cached.cached, true);
    assert.equal(cached.url, view.current.listeningUrl);
    assert.deepEqual(
      await speech.audio(paid, view.run.id, view.current.stepId, cached.url.split('/').at(-1)),
      audioFixture,
    );
    const operationId = randomUUID(),
      payload = {
        turnId: view.current.turn.id,
        operationId,
        answer: { type: 'choice', optionId: 'b' },
      };
    const answered = await plans.engine.answer(paid, view.run.id, payload);
    const repeated = await plans.engine.answer(paid, view.run.id, payload);
    assert.equal(answered.attempt.id, repeated.attempt.id);
    await finish(plans.engine, paid, answered.view, true);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM provider_requests WHERE user_id=$1 AND status='success'",
          [paid.user.id],
        )
      ).rows[0].count,
      2,
    );
    assert.equal(externalCalls, 0);
    const config = await providers.read(root);
    await providers.updateControls(root, {
      revision: config.revision,
      controls: {
        ...config.controls,
        enabled: false,
        listeningEnabled: false,
        withListening: false,
      },
    });
    console.log(
      'Restart verified: pending recovery terminates, plan reasons persist, review confirms skill, cached audio/variant/ledger survive and replies do not duplicate.',
    );
  }
} finally {
  await db.close();
}
