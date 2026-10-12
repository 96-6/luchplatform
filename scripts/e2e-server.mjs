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
const settings = parseSettings({
  APP_ENV: 'test',
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_URL: 'http://127.0.0.1:3200',
  API_PORT: '3200',
  DATABASE_URL: `pglite:${directory}/database`,
  ENABLE_DEV_TOOLS: 'true',
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
const app = await buildApp(settings, database, { captchaGenerator: () => 'ABCDE' });
// Isolated test fixtures avoid turning curriculum scenarios into repeated account-enrollment load.
const fixtureCrypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
const fixtureKeys = {};
const fixturePath = new URL('../data/e2e-accounts.json', import.meta.url);
for (const prefix of [
  'engine-retry',
  'engine-control',
  'engine-integrity',
  'engine-integrity-admin',
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
        prefix === 'engine-integrity-admin' ? 'superadmin' : 'student',
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
