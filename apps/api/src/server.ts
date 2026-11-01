import { loadSettings } from './config.js';
import { createDatabase } from './db/database.js';
import { buildApp } from './app.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { expireSpeechAudio } from './modules/speech/repository.js';
import { recoverLearningEvents } from './modules/adaptation/processor.js';

try {
  const settings = loadSettings();
  const database = await createDatabase(settings);
  let app;
  try {
    await assertSchemaCurrent(database);
    await recoverLearningEvents(database);
    await expireSpeechAudio(database, Date.now());
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
          if (process.connected) process.disconnect?.();
        })
        .catch(() => {
          process.exitCode = 1;
          if (process.connected) process.disconnect?.();
        });
    });
  }
  try {
    await app.listen({ host: settings.API_HOST, port: settings.API_PORT });
    if (process.send) {
      process.send({ type: 'luch:ready' });
      process.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'luch:quiesce' && 'id' in message && typeof message.id === 'string') {
          const id = message.id;
          void app.quiesceForUpdate().then(
            (ready) => process.send?.({ type: 'luch:quiesced', id, ready }),
            () => process.send?.({ type: 'luch:quiesced', id, ready: false }),
          );
        } else if (message.type === 'luch:resume') app.resumeAfterUpdate();
      });
    }
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
