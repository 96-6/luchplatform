import { testVideo } from '../tests/e2e/test-video.mjs';
import { testTone } from '../tests/e2e/test-tone.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { migrate } from '../apps/api/dist/db/migrations.js';
import { randomBytes } from 'node:crypto';
import { bootstrapService, seedDemo } from '../apps/api/dist/modules/accounts/bootstrap.js';
import { seedDemoContent } from '../apps/api/dist/modules/content/bootstrap.js';
import { buildApp } from '../apps/api/dist/app.js';
import { AccountCrypto, createTotp } from '../apps/api/dist/modules/auth/crypto.js';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'luch-e2e-'));
const localAdminAlias = randomBytes(18).toString('base64url');
const settings = parseSettings({
  APP_ENV: 'test',
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
const app = await buildApp(settings, database, {
  captchaGenerator: () => 'ABCDE',
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
// This route exists only in the isolated test harness, never in the application or runtime image.
app.post('/__e2e/isolate', async (request, reply) => {
  if (request.headers['x-e2e-fixture'] !== testIsolationToken) return reply.code(403).send();
  await database.exec('TRUNCATE auth_rate_limits');
  return reply.code(204).send();
});
const fixturePath = new URL('../data/e2e-accounts.json', import.meta.url);
for (const prefix of [
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
])
  for (const retry of [0, 1]) {
    const email = `${prefix}-${retry}@example.test`;
    const key = createTotp(email).secret.base32;
    fixtureKeys[email] = key;
    await database.query(
      'INSERT INTO users (id,email,full_name,role,is_demo,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,true,now(),now(),$5,true)',
      [
        randomUUID(),
        email,
        'Проверка движка',
        prefix === 'engine-integrity-admin' ||
        prefix === 'plan-admin' ||
        prefix === 'adapt-admin' ||
        prefix === 'adapt-providers-admin' ||
        prefix === 'assistant-admin'
          ? 'superadmin'
          : prefix === 'plan-teacher'
            ? 'teacher'
            : 'student',
        fixtureCrypto.encrypt(key),
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
