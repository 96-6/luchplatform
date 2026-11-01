import { testVideo } from '../tests/e2e/test-video.mjs';
import { DEFAULT_BROWSER_POLICY } from '@luch/contracts';
import { testTone } from '../tests/e2e/test-tone.mjs';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { migrate } from '../apps/api/dist/db/migrations.js';
import { randomBytes } from 'node:crypto';
import { bootstrapService, seedDemo } from '../apps/api/dist/modules/accounts/bootstrap.js';
import { seedDemoContent } from '../apps/api/dist/modules/content/bootstrap.js';
import { buildApp } from '../apps/api/dist/app.js';
import { Passwords } from '../apps/api/dist/modules/auth/password.js';
import { AccountCrypto, createTotp } from '../apps/api/dist/modules/auth/crypto.js';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'luch-e2e-'));
const localAdminAlias = randomBytes(18).toString('base64url');
const videoEnvironment = process.env.LUCH_VIDEO_TEST_ENV
  ? JSON.parse(await readFile(process.env.LUCH_VIDEO_TEST_ENV, 'utf8'))
  : {};
const settings = parseSettings({
  ...videoEnvironment,
  APP_ENV: 'test',
  MEETING_FILE_DIRECTORY: join(directory, 'meeting-files'),
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_URL: 'http://127.0.0.1:3200',
  API_PORT: '3200',
  DATABASE_URL: `pglite:${directory}/database`,
  ENABLE_DEV_TOOLS: 'true',
  LOCAL_DEBUG_LOGIN: 'true',
  LOCAL_DEBUG_ADMIN_ALIAS: localAdminAlias,
  SERVE_WEB: 'true',
  LOG_LEVEL: 'warn',
});
const database = await createDatabase(settings);
await migrate(database);
await seedDemo(database, settings);
await seedDemoContent(database);
await bootstrapService(database, settings).provision(
  'content-admin@example.test',
  'Контент администратор',
  'superadmin',
  true,
);
let speechTestMode = { sttFailure: false, ttsFailure: false, transcript: null };
const mic = Buffer.alloc(44 + 32000 * 2);
mic.write('RIFF', 0);
mic.writeUInt32LE(mic.length - 8, 4);
mic.write('WAVEfmt ', 8);
mic.writeUInt32LE(16, 16);
mic.writeUInt16LE(1, 20);
mic.writeUInt16LE(1, 22);
mic.writeUInt32LE(16000, 24);
mic.writeUInt32LE(32000, 28);
mic.writeUInt16LE(2, 32);
mic.writeUInt16LE(16, 34);
mic.write('data', 36);
mic.writeUInt32LE(mic.length - 44, 40);
for (let at = 44; at < mic.length; at += 2)
  mic.writeInt16LE(Math.round(Math.sin(at / 20) * 10000), at);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/e2e-mic.wav', import.meta.url), mic);
const app = await buildApp(settings, database, {
  captchaGenerator: () => 'ABCDE',
  updateFetch: async (url) => {
    if (url.endsWith('/branches/main'))
      return Response.json({
        commit: {
          sha: '2'.repeat(40),
          commit: { tree: { sha: '3'.repeat(40) }, committer: { date: '2026-11-01T00:00:00Z' } },
        },
      });
    if (url.includes('/git/trees/'))
      return Response.json({
        truncated: false,
        tree: [{ path: 'README.md', type: 'blob', sha: '4'.repeat(40) }],
      });
    if (url.includes('/compare/')) return Response.json({ status: 'ahead' });
    throw Error('Unexpected GitHub fixture path');
  },
  providerFetch: async (url, options) => {
    if (String(url) === 'https://api.heygen.com/v3/videos')
      return Response.json({ data: { video_id: 'e2e-avatar-video' } });
    if (String(url).startsWith('https://api.heygen.com/v3/videos/'))
      return Response.json({
        data: {
          status: 'completed',
          video_url: 'https://resource.heygen.ai/test-fixture.mp4',
          duration: 1,
        },
      });
    if (String(url) === 'https://resource.heygen.ai/test-fixture.mp4')
      return new Response(testVideo, { headers: { 'content-type': 'video/mp4' } });
    if (String(url) === 'https://api.elevenlabs.io/v1/speech-to-text') {
      if (speechTestMode.sttFailure) throw new Error('Test STT outage');
      const language = options.body.get('language_code');
      return Response.json({
        text: speechTestMode.transcript ?? (language === 'ru' ? 'Меня зовут Анна.' : 'I am Anna.'),
        language_code: language,
      });
    }
    if (
      String(url).startsWith('https://api.elevenlabs.io/v1/text-to-speech/') &&
      speechTestMode.ttsFailure
    )
      throw new Error('Test TTS outage');
    if (String(url).startsWith('https://api.elevenlabs.io/'))
      return new Response(testTone, { headers: { 'content-type': 'audio/mpeg' } });
    const body = JSON.parse(String(options.body));
    const prompt = JSON.parse(body.messages[1].content);
    const context = JSON.parse(prompt.context);
    const en = context.language === 'en';
    const question = {
      instruction: prompt.withListening
        ? 'Прослушайте реплику и выберите имя.'
        : 'Выберите вежливое приветствие.',
      material: '',
      options: [
        { id: 'a', text: 'Игорь' },
        { id: 'b', text: 'Анна' },
        { id: 'c', text: 'Олег' },
      ],
      correctOptionId: 'b',
      explanation: 'В реплике названо имя Анна.',
      hint: 'Обратите внимание на фразу знакомства.',
      listeningText: prompt.withListening
        ? en
          ? 'Hello. My name is Anna.'
          : 'Здравствуйте. Меня зовут Анна.'
        : null,
    };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(question) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    });
  },
});
// Isolated test fixtures avoid turning curriculum scenarios into repeated account-enrollment load.
const fixtureCrypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
const testIsolationToken = randomBytes(24).toString('hex');
const fixtureKeys = { localAdminAlias, testIsolationToken };
const fixturePasswordHash = await new Passwords(fixtureCrypto).protect(
  'Browser fixture password 2026!',
);
// This route exists only in the isolated test harness, never in the application or runtime image.
app.post('/__e2e/isolate', async (request, reply) => {
  if (request.headers['x-e2e-fixture'] !== testIsolationToken) return reply.code(403).send();
  await database.exec('TRUNCATE auth_rate_limits');
  return reply.code(204).send();
});
app.post('/__e2e/speech-mode', async (request, reply) => {
  if (request.headers['x-e2e-fixture'] !== testIsolationToken) return reply.code(403).send();
  speechTestMode = {
    sttFailure: Boolean(request.body.sttFailure),
    ttsFailure: Boolean(request.body.ttsFailure),
    transcript:
      typeof request.body.transcript === 'string' ? request.body.transcript.slice(0, 1000) : null,
  };
  return reply.code(204).send();
});
const fixturePath = new URL('../data/e2e-accounts.json', import.meta.url);
// Isolated harness recovery for browser-policy tests; this file is not part of the runtime image.
app.post('/__e2e/browser-policy-reset', async (request, reply) => {
  if (request.headers['x-e2e-fixture'] !== testIsolationToken) return reply.code(403).send();
  const p = DEFAULT_BROWSER_POLICY;
  await database.query(
    'UPDATE browser_policy SET outdated_enabled=$1,enhanced_enabled=$2,blocked_browsers=$3,allowed_browsers=$4,minimum_versions=$5,revision=revision+1 WHERE id=1',
    [
      p.outdatedEnabled,
      p.enhancedEnabled,
      JSON.stringify(p.blockedBrowsers),
      JSON.stringify(p.allowedBrowsers),
      JSON.stringify(p.minimumVersions),
    ],
  );
  return reply.code(204).send();
});
for (const prefix of [
  'audit-updates-superadmin',
  'audit-status-superadmin',
  'audit-updates-student',
  'browser-yandex-student',
  'engine-retry',
  'engine-control',
  'engine-integrity',
  'engine-integrity-admin',
  'plan-ru',
  'plan-en',
  'plan-review',
  'plan-admin',
  'plan-teacher',
  'plan-other',
  'adapt-error',
  'adapt-success',
  'adapt-admin',
  'adapt-providers-admin',
  'adapt-listening',
  'assistant-ru',
  'assistant-en',
  'assistant-control',
  'assistant-error',
  'assistant-admin',
  'dashboard-ru',
  'dashboard-en',
  'dashboard-empty',
  'dashboard-retry',
  'speech-ru',
  'speech-en',
  'speech-failure',
  'speech-permission',
  'speech-control',
  'teacher-ru',
  'teacher-en',
  'teacher-ru-tutor',
  'teacher-en-tutor',
  'teacher-retry-tutor',
  'teacher-outsider',
  'teacher-empty-tutor',
  'teacher-retry-student',
  'meeting-adhoc-tutor',
  'meeting-vanish-tutor',
  'meeting-layout-tutor',
  'meeting-layout-student',
  'meeting-vanish-student',
  'meeting-protection-tutor',
  'meeting-single-tutor',
  'meeting-single-student',
  'meeting-single-peer',
  'meeting-files-tutor',
  'meeting-ru-student',
  'meeting-en-student',
  'meeting-ru-tutor',
  'meeting-en-tutor',
  'meeting-moderation-student',
  'meeting-moderation-tutor',
  'meeting-calendar-student',
  'meeting-calendar-tutor',
  'meeting-outsider',
  'meeting-calendar-peer',
  'meeting-moderation-peer',
  'report-ru-student',
  'report-en-student',
  'report-ru-tutor',
  'report-en-tutor',
  'report-empty',
  'audit-student',
  'audit-tutor',
  'audit-admin',
  'audit-superadmin',
  'audit-select-student',
  'audit-select-tutor',
  'audit-maint-admin',
  'audit-maint-superadmin',
  'audit-links-student',
  'audit-links-tutor',
  'audit-dev-student',
])
  for (const retry of [0, 1]) {
    const email = `${prefix}-${retry}@example.test`;
    const key = createTotp(email).secret.base32;
    fixtureKeys[email] = key;
    await database.query(
      'INSERT INTO users (id,email,full_name,role,is_demo,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES ($1,$2,$3,$4,true,now(),now(),$5,true,$6,now())',
      [
        randomUUID(),
        email,
        prefix.startsWith('audit-')
          ? `Проверка интерфейса ${prefix}`
          : prefix.startsWith('meeting-')
            ? `Встречи ${prefix}`
            : prefix.startsWith('report-')
              ? `Отчёт ${prefix}`
              : 'Проверка движка',
        prefix === 'engine-integrity-admin' ||
        prefix === 'plan-admin' ||
        prefix === 'adapt-admin' ||
        prefix === 'adapt-providers-admin' ||
        prefix === 'assistant-admin' ||
        prefix.endsWith('-superadmin')
          ? 'superadmin'
          : prefix.startsWith('audit-') && prefix.endsWith('-admin')
            ? 'admin'
            : prefix === 'plan-teacher' || prefix.endsWith('-tutor')
              ? 'teacher'
              : 'student',
        fixtureCrypto.encrypt(key),
        fixturePasswordHash,
      ],
    );
  }
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(fixturePath, JSON.stringify(fixtureKeys), { mode: 0o600 });
await bootstrapService(database, settings).provision(
  'engine-admin@example.test',
  'Администратор движка',
  'superadmin',
  true,
);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void app.close().then(async () => {
      await rm(fixturePath, { force: true });
      await rm(directory, { recursive: true, force: true });
    });
  });
}
await app.listen({ host: '127.0.0.1', port: 3200 });
