import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { migrate } from '../apps/api/dist/db/migrations.js';
import { buildApp } from '../apps/api/dist/app.js';

const directory = await mkdtemp(join(tmpdir(), 'luch-e2e-'));
const settings = parseSettings({
  APP_ENV: 'test',
  APP_URL: 'http://127.0.0.1:3200',
  API_PORT: '3200',
  DATABASE_URL: `pglite:${directory}/database`,
  ENABLE_DEV_TOOLS: 'true',
  SERVE_WEB: 'true',
  LOG_LEVEL: 'warn',
});
const database = await createDatabase(settings);
await migrate(database);
const app = await buildApp(settings, database);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void app.close().then(() => rm(directory, { recursive: true, force: true }));
  });
}
await app.listen({ host: '127.0.0.1', port: 3200 });
