import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { OperationsService } from '../apps/api/dist/modules/operations/service.js';
import { MeetingsService } from '../apps/api/dist/modules/meetings/service.js';
import { LiveKitVideo } from '../apps/api/dist/modules/meetings/adapter.js';
const settings = loadSettings(),
  verify = process.argv.includes('verify'),
  file = process.env.OPERATIONS_SMOKE_FILE ?? '/tmp/luch-operations-smoke.json';
assert.ok(
  settings.APP_ENV !== 'production' && settings.ENABLE_DEV_TOOLS,
  'Use an isolated development/test database.',
);
const db = await createDatabase(settings);
try {
  const service = new OperationsService(
    db,
    settings,
    new MeetingsService(db, new LiveKitVideo(settings)),
  );
  async function actor(role) {
    const email = `compose-operations-${role}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT(email) DO NOTHING',
        [randomUUID(), email, 'Operations persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row);
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'fixture' };
  }
  const root = await actor('superadmin'),
    admin = await actor('admin');
  const saved = verify ? JSON.parse(await readFile(file, 'utf8')) : [];
  for (const [who, kind] of [
    [root, 'seed_content'],
    [root, 'expire_audio'],
    [admin, 'recover_learning'],
  ]) {
    const expected = saved.find((x) => x.kind === kind),
      operationId = expected?.operationId ?? randomUUID();
    const result = await service.execute(who, { operationId, kind });
    assert.equal(result.status, 'completed');
    assert.deepEqual(await service.execute(who, { operationId, kind }), result);
    if (verify) assert.deepEqual(result, expected.result);
    else saved.push({ kind, operationId, result });
  }
  await assert.rejects(
    service.execute(admin, { operationId: randomUUID(), kind: 'seed_content' }),
    { statusCode: 403 },
  );
  const overview = await service.overview(admin);
  assert.equal(overview.canManagePlatform, false);
  assert.ok(!overview.actions.includes('expire_audio'));
  assert.ok(overview.counts.routes >= 2);
  assert.ok(overview.counts.lessons >= 12);
  if (!verify) await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  console.log(
    verify
      ? 'Operator actions and results restored after restart; replay does not duplicate work and administrator permissions remain bounded.'
      : 'Operator actions persisted: demo bank, expired audio cleanup and bounded learning recovery; no paid calls or duplicated learning data.',
  );
} finally {
  await db.close();
}
