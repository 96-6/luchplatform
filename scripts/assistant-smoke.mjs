import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  assistantPreferencesSchema,
  aiControlsSchema,
  aiCeilingsSchema,
  updateProviderSchema,
} from '@luch/contracts';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { AccountCrypto } from '../apps/api/dist/modules/auth/crypto.js';
import { LuchEngine } from '../apps/api/dist/modules/engine/service.js';
import { AssistantService } from '../apps/api/dist/modules/assistant/service.js';
import { AvatarVideoService } from '../apps/api/dist/modules/assistant/video.js';
import { ProviderSettingsService } from '../apps/api/dist/modules/providers/settings.js';
import { HeyGenAdapter } from '../apps/api/dist/modules/providers/heygen.js';

const settings = loadSettings(),
  verify = process.argv[2] === 'verify';
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Assistant smoke needs an isolated test/development database.');
const db = await createDatabase(settings);
const bytes = Buffer.from([
  0,
  0,
  0,
  24,
  ...Buffer.from('ftypisom'),
  0,
  0,
  0,
  0,
  ...Buffer.from('isommp42'),
]);
let calls = 0;
const fake = async (url) => {
  calls++;
  if (verify) throw new Error('Saved video must not need an external API.');
  return String(url).endsWith('/videos')
    ? Response.json({ data: { video_id: 'smoke-video' } })
    : String(url).includes('/v3/videos/')
      ? Response.json({
          data: {
            status: 'completed',
            duration: 1,
            video_url: 'https://resource.heygen.ai/smoke.mp4',
          },
        })
      : new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
};
try {
  async function actor(name, role) {
    const email = `compose-assistant-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
        [randomUUID(), email, 'Assistant persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row);
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'smoke' };
  }
  const student = await actor('student', 'student'),
    root = await actor('root', 'superadmin'),
    assistant = new AssistantService(db),
    engine = new LuchEngine(db),
    providers = new ProviderSettingsService(db, new AccountCrypto(settings.AUTH_ENCRYPTION_KEY), {
      OPENAI_API_KEY: '',
      NEUROAPI_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      HEYGEN_API_KEY: '',
    }),
    video = new AvatarVideoService(providers, new HeyGenAdapter(fake));
  let view = await engine.start(student, {
    packageId: 'luch-demo',
    packageVersion: 1,
    source: { type: 'lesson', id: 'rki-01', purpose: 'practice' },
    restart: false,
  });
  if (!verify) {
    const profile = await assistant.profile(student);
    await assistant.saveProfile(student, {
      revision: profile.revision,
      preferences: assistantPreferencesSchema.parse({
        avatarId: 'guide',
        voiceAvatarId: 'partner',
        pace: 'slow',
        address: 'informal',
        animation: false,
      }),
    });
    await assistant.send(student, view.run.id, {
      operationId: randomUUID(),
      turnId: view.current.turn.id,
      action: 'explain',
      text: '',
    });
    let config = await providers.read(root);
    config = await providers.updateCeilings(root, {
      revision: config.revision,
      ceilings: aiCeilingsSchema.parse({
        ...config.ceilings,
        lifetimeMicros: 10_000_000,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 100,
        maxVideoCharacters: 1200,
        maxVideoSeconds: 300,
      }),
    });
    const bindings = await video.bindings(root);
    await video.updateBindings(root, {
      revision: bindings.revision,
      items: ['mentor', 'partner', 'guide'].map((id) => ({
        id,
        avatarId: `${id}-avatar`,
        voiceRu: `${id}-ru`,
        voiceEn: `${id}-en`,
      })),
    });
    config = await providers.read(root);
    config = await providers.updateProvider(
      root,
      'heygen',
      updateProviderSchema.parse({
        revision: config.providers.find((p) => p.id === 'heygen').revision,
        enabled: true,
        model: 'avatar_iv',
        inputRate: null,
        outputRate: null,
        characterRate: null,
        minuteRate: 1_000_000,
        confirmPricing: true,
        apiKey: randomBytes(24).toString('hex'),
      }),
    );
    await providers.updateControls(root, {
      revision: config.revision,
      controls: aiControlsSchema.parse({
        ...config.controls,
        videoEnabled: true,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 100,
        maxVideoCharacters: 1200,
        maxVideoSeconds: 300,
      }),
    });
    const message = (await assistant.chat(student, view.run.id)).messages.at(-1);
    assert.equal((await video.prepare(student, message.id)).status, 'pending');
    assert.equal((await video.status(student, message.id)).status, 'ready');
    assert.equal(calls, 3);
    config = await providers.read(root);
    await providers.updateControls(root, {
      revision: config.revision,
      controls: { ...config.controls, videoEnabled: false },
    });
    console.log('Avatar, contextual chat, help marker, reserved spend and downloaded video saved.');
  } else {
    const profile = await assistant.profile(student);
    assert.equal(profile.preferences.avatarId, 'guide');
    assert.equal(profile.preferences.voiceAvatarId, 'partner');
    assert.equal(profile.preferences.animation, false);
    const chat = await assistant.chat(student, view.run.id);
    assert.equal(chat.messages.length, 2);
    assert.ok(chat.messages[1].content.includes(view.current.exercise.instruction));
    const exchange = (
      await db.query('SELECT * FROM assistant_exchanges WHERE run_id=$1', [view.run.id])
    ).rows[0];
    await assistant.send(student, view.run.id, exchange.request);
    assert.equal((await assistant.chat(student, view.run.id)).messages.length, 2);
    view = await engine.repository.view(student, view.run.id);
    assert.equal(view.current.turn.assistantHelp, true);
    const result = await video.prepare(student, exchange.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.cached, true);
    assert.deepEqual(await video.media(student, exchange.id), bytes);
    assert.equal(calls, 0);
    const answered = await engine.answer(student, view.run.id, {
      turnId: view.current.turn.id,
      operationId: randomUUID(),
      answer: { type: 'choice', optionId: view.current.exercise.response.options[0].id },
    });
    assert.equal(answered.attempt.assistantHelp, true);
    assert.equal(answered.attempt.independent, false);
    console.log(
      'Avatar, chat, help and cached video restored in another process; no paid call repeated.',
    );
  }
} finally {
  await db.close();
}
