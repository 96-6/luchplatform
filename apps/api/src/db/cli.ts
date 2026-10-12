import { loadSettings } from '../config.js';
import { createDatabase } from './database.js';
import { migrate, assertSchemaCurrent } from './migrations.js';
import { saveProbe } from '../modules/probes/service.js';

const smokeOperation = '00000000-0000-4000-8000-000000000001';
async function run() {
  const settings = loadSettings();
  const command = process.argv[2];
  if (!['migrate', 'smoke', 'verify-smoke'].includes(command ?? ''))
    throw new Error('Usage: cli <migrate|smoke|verify-smoke>');
  if (command !== 'migrate' && !settings.ENABLE_DEV_TOOLS)
    throw new Error(
      'Enable development tools in a local or test environment to run the smoke check.',
    );
  const database = await createDatabase(settings);
  try {
    if (command === 'migrate') {
      const applied = await migrate(database);
      console.log(
        applied.length
          ? `Applied: ${applied.join(', ')}`
          : 'Database schema is current; no migrations applied.',
      );
    } else {
      await assertSchemaCurrent(database);
      if (command === 'smoke') {
        const saved = await saveProbe(database, {
          label: 'CLI persistence check',
          operationId: smokeOperation,
        });
        console.log(`Test record saved: ${saved.record.id}`);
      } else {
        const result = await database.query<{ id: string }>(
          'SELECT id FROM system_probes WHERE operation_id = $1',
          [smokeOperation],
        );
        if (!result.rows[0]) throw new Error('No persisted test record found. Run db:smoke first.');
        console.log(`Persistence verified in a new process: ${result.rows[0].id}`);
      }
    }
  } finally {
    await database.close();
  }
}
run().catch((error: unknown) => {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Database operation failed. Check connection and migration state.',
  );
  process.exitCode = 1;
});
