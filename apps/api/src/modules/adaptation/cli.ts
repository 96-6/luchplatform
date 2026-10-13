import { loadSettings } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { assertSchemaCurrent } from '../../db/migrations.js';
import { recoverLearningEvents } from './processor.js';

async function run() {
  const db = await createDatabase(loadSettings());
  try {
    await assertSchemaCurrent(db);
    const count = await recoverLearningEvents(db);
    console.log(`Learning event recovery complete: ${count} runs processed.`);
  } finally {
    await db.close();
  }
}
run().catch(() => {
  console.error('Learning recovery failed. Check the database and migration state.');
  process.exitCode = 1;
});
