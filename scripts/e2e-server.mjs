import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { migrate } from '../apps/api/dist/db/migrations.js';
import { randomBytes } from 'node:crypto';
import { bootstrapService, seedDemo } from '../apps/api/dist/modules/accounts/bootstrap.js';
import { seedDemoContent } from '../apps/api/dist/modules/content/bootstrap.js';
import { buildApp } from '../apps/api/dist/app.js';

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
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void app.close().then(() => rm(directory, { recursive: true, force: true }));
  });
}
await app.listen({ host: '127.0.0.1', port: 3200 });
