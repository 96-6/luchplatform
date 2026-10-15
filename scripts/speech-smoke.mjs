import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { aiCeilingsSchema, aiControlsSchema, updateProviderSchema } from '@luch/contracts';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { AccountCrypto } from '../apps/api/dist/modules/auth/crypto.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { ProviderSettingsService } from '../apps/api/dist/modules/providers/settings.js';
import { ElevenLabsAdapter } from '../apps/api/dist/modules/providers/adapters.js';
import { ElevenLabsTranscriptionAdapter } from '../apps/api/dist/modules/speech/adapter.js';
import { VoiceService } from '../apps/api/dist/modules/speech/service.js';
import { AssistantAudioService } from '../apps/api/dist/modules/speech/audio.js';

const settings = loadSettings(),
  verify = process.argv[2] === 'verify';
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Voice smoke requires an isolated test/development database.');
const db = await createDatabase(settings);
const wav = Buffer.alloc(32044);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(Math.sin(i / 20) * 10000), i);
const cachedAudio = Buffer.from('ID3-synthetic-voice-persistence');
let calls = 0,
  transcript = '';
const fake = async (url) => {
  calls++;
  if (verify)
    throw new Error('Restart must reuse saved recognition and audio without a paid call.');
  return String(url).endsWith('/speech-to-text')
    ? Response.json({ text: transcript })
    : new Response(cachedAudio, { headers: { 'content-type': 'audio/mpeg' } });
};
try {
  const providers = new ProviderSettingsService(
    db,
    new AccountCrypto(settings.AUTH_ENCRYPTION_KEY),
    {
      OPENAI_API_KEY: '',
      NEUROAPI_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      HEYGEN_API_KEY: '',
    },
  );
  const voice = new VoiceService(providers, new ElevenLabsTranscriptionAdapter(fake)),
    audio = new AssistantAudioService(providers, new ElevenLabsAdapter(fake)),
    plans = new PlansService(db),
    diagnostics = new DiagnosticsService(db);
  async function actor(name, role = 'student') {
    const email = `compose-speech-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
        [randomUUID(), email, 'Voice persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row, 'Run speech-smoke before verification.');
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' };
  }
  async function solution(view, correct = true) {
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
  async function planFor(user, language) {
    let saved = (
      await db.query(
        'SELECT id FROM learning_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [user.user.id],
      )
    ).rows[0];
    if (!saved) {
      assert.equal(verify, false);
      await diagnostics.profiles.save(user, {
        language,
        goal: 'daily_life',
        experience: 'none',
        minutesPerDay: 20,
        revision: 0,
      });
      const d = await diagnostics.start(user, { profileRevision: 1, restart: false });
      let view = await diagnostics.engine.repository.view(user, d.diagnostic.runId);
      while (view.current) {
        view = (
          await diagnostics.engine.answer(user, view.run.id, {
            turnId: view.current.turn.id,
            operationId: randomUUID(),
            answer: await solution(view),
          })
        ).view;
        view = await diagnostics.engine.next(user, view.run.id, view.current.turn.id);
      }
      saved = { id: (await diagnostics.read(user, d.diagnostic.id)).planId };
    }
    return plans.read(user, saved.id);
  }
  const root = await actor('root', 'superadmin');
  if (!verify) {
    const previous = (
      await db.query(
        'SELECT p.enabled,p.credential_ciphertext,u.email,u.is_demo FROM external_providers p LEFT JOIN users u ON u.id=p.updated_by',
      )
    ).rows;
    assert.ok(
      previous.every(
        (p) =>
          (!p.enabled && !p.credential_ciphertext) || (p.is_demo && p.email.startsWith('compose-')),
      ),
      'Use a test database without real provider configuration.',
    );
    let config = await providers.read(root);
    config = await providers.updateCeilings(root, {
      revision: config.revision,
      ceilings: aiCeilingsSchema.parse({
        ...config.ceilings,
        lifetimeMicros: 10000000,
        dailyMicros: 10000000,
        monthlyMicros: 10000000,
        perUserDailyMicros: 10000000,
        requestsPerUserDay: 100,
        maxRecordingSeconds: 30,
        maxTtsCharacters: 3000,
      }),
    });
    for (const id of ['elevenlabs_stt', 'elevenlabs'])
      config = await providers.updateProvider(
        root,
        id,
        updateProviderSchema.parse({
          revision: config.providers.find((p) => p.id === id).revision,
          enabled: true,
          model: id === 'elevenlabs_stt' ? 'scribe_v2' : 'eleven_multilingual_v2',
          voiceRu: id === 'elevenlabs' ? 'fixture-ru' : '',
          voiceEn: id === 'elevenlabs' ? 'fixture-en' : '',
          inputRate: null,
          outputRate: null,
          characterRate: id === 'elevenlabs' ? 100000 : null,
          minuteRate: id === 'elevenlabs_stt' ? 20000 : null,
          confirmPricing: true,
          apiKey: randomBytes(24).toString('hex'),
        }),
      );
    await providers.updateControls(root, {
      revision: config.revision,
      controls: aiControlsSchema.parse({
        ...config.controls,
        transcriptionEnabled: true,
        assistantSpeechEnabled: true,
        dailyMicros: 10000000,
        monthlyMicros: 10000000,
        perUserDailyMicros: 10000000,
        requestsPerUserDay: 100,
        maxRecordingSeconds: 30,
        maxTtsCharacters: 3000,
      }),
    });
  }
  for (const [name, language, pending] of [
    ['ru-error', 'ru', false],
    ['en-error', 'en', false],
    ['en-pending', 'en', true],
  ]) {
    const user = await actor(name),
      plan = await planFor(user, language);
    let view = await plans.startAssignment(
      user,
      plan.plan.id,
      plan.assignments.find((a) => a.kind === 'initial').id,
    );
    if (!verify) {
      const answer = await solution(view, pending);
      assert.equal(answer.type, 'choice');
      transcript = view.current.exercise.response.options.find(
        (o) => o.id === answer.optionId,
      ).text;
      const input = await voice.upload(user, view.run.id, {
        turnId: view.current.turn.id,
        operationId: randomUUID(),
        audioBase64: wav.toString('base64'),
      });
      assert.equal(input.status, 'ready');
      assert.equal((await voice.engine.repository.view(user, view.run.id)).attempts.length, 0);
      if (!pending) {
        const result = await voice.confirm(user, view.run.id, input.id, {
          operationId: randomUUID(),
          text: transcript,
        });
        assert.equal(result.view.attempts[0].evaluation.correct, false);
        assert.equal(result.assignment.kind, 'correction');
        const spoken = await audio.prepare(user, result.input.messageId, randomUUID());
        assert.deepEqual(
          await audio.audio(user, result.input.messageId, spoken.url.split('/').at(-1)),
          cachedAudio,
        );
      }
    } else {
      const session = await voice.session(user, view.run.id),
        input = session.input;
      assert.ok(input);
      const row = (await db.query('SELECT * FROM speech_inputs WHERE id=$1', [input.id])).rows[0];
      assert.equal(row.audio, null);
      assert.equal(
        (
          await voice.upload(user, view.run.id, {
            turnId: row.turn_id,
            operationId: row.operation_id,
            audioBase64: wav.toString('base64'),
          })
        ).id,
        input.id,
      );
      const operationId = row.confirm_operation_id ?? randomUUID();
      const payload = { operationId, text: row.confirmed_text ?? row.transcript };
      const result = await voice.confirm(user, view.run.id, input.id, payload);
      const again = await voice.confirm(user, view.run.id, input.id, payload);
      assert.equal(result.input.attemptId, again.input.attemptId);
      assert.equal(result.view.attempts[0].independent, true);
      assert.equal(result.view.attempts[0].evaluation.correct, pending);
      assert.equal(result.assignment.kind, pending ? 'review' : 'correction');
      const current = await plans.read(user, plan.plan.id);
      assert.equal(
        current.assignments.filter((a) => a.kind === (pending ? 'review' : 'correction')).length,
        1,
      );
      if (!pending) {
        const spoken = await audio.prepare(user, result.input.messageId, randomUUID());
        assert.equal(spoken.cached, true);
        assert.deepEqual(
          await audio.audio(user, result.input.messageId, spoken.url.split('/').at(-1)),
          cachedAudio,
        );
      }
    }
  }
  if (!verify) {
    assert.equal(calls, 5);
    const config = await providers.read(root);
    await providers.updateControls(root, {
      revision: config.revision,
      controls: { ...config.controls, transcriptionEnabled: false, assistantSpeechEnabled: false },
    });
    console.log(
      'RU/EN voice answers, correction reasons, pending recognition, protected audio and cost ledger persisted.',
    );
  } else {
    assert.equal(calls, 0);
    console.log(
      'Voice restart verified: recognition resumes, confirmation is atomic and repeatable, correction/review branches and cached audio survive; no paid calls repeated.',
    );
  }
} finally {
  await db.close();
}
