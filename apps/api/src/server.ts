import { loadSettings } from './config.js';
import { createDatabase } from './db/database.js';
import { buildApp } from './app.js';

try {
  const settings = loadSettings();
  const database = await createDatabase(settings);
  let app;
  try {
    app = await buildApp(settings, database);
  } catch (error) {
    await database.close();
    throw error;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  }
  try {
    await app.listen({ host: settings.API_HOST, port: settings.API_PORT });
  } catch (error) {
    await app.close();
    throw error;
  }
} catch (error) {
  // Config validation errors are value-free; connection errors are intentionally generic.
  console.error(
    error instanceof Error &&
      (error.message.startsWith('Invalid environment:') ||
        error.message.startsWith('Local database'))
      ? error.message
      : 'Application failed to start. Check environment, database availability, ports and the client build.',
  );
  process.exitCode = 1;
}
