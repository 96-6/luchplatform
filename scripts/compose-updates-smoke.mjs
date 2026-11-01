import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { installedBuild } from '../apps/api/dist/modules/updates/build.js';
import { UpdatesService } from '../apps/api/dist/modules/updates/service.js';
import { GitHubUpdates } from '../apps/api/dist/modules/updates/github.js';
import { UpdateSpool } from '../apps/api/dist/modules/updates/spool.js';
import { inspectSource } from './build-info.mjs';
import { UpdateWorker } from './update-runtime/worker.mjs';
import { configuration, deployment, json, sleep } from './update-runtime/shared.mjs';
import { command } from './update-runtime/commands.mjs';
const settings = loadSettings();
assert.equal(settings.APP_ENV, 'test', 'Only isolated Compose fixtures may override the source.');
const config = await configuration('/updates/config.json'),
  source = '/releases/fixture-source';
if (process.argv.includes('verify')) {
  const state = await deployment(config);
  assert.notEqual(state.current, 'initial');
  const db = await createDatabase(settings);
  try {
    assert.equal(
      (await db.query('SELECT value FROM compose_update_fixture')).rows[0].value,
      'persisted across containers',
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM platform_update_jobs WHERE phase='completed'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
  console.log('Compose release, job history and migrated data survived app/agent restart.');
} else {
  const build = await inspectSource(source),
    target = build.commit;
  const tree = (
    await command(
      'git',
      ['-C', source, 'ls-tree', '-r', '-z', '--format=%(objectname) %(path)', 'HEAD'],
      { capture: true, quiet: true },
    )
  )
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), path: line.slice(41), type: 'blob' }));
  const github = new GitHubUpdates(async (url) =>
    url.endsWith('/branches/main')
      ? Response.json({
          commit: {
            sha: target,
            commit: { tree: { sha: target }, committer: { date: new Date().toISOString() } },
          },
        })
      : url.includes('/git/trees/')
        ? Response.json({ truncated: false, tree })
        : Response.json({ status: 'ahead' }),
  );
  const worker = new UpdateWorker(config, { gitRemote: source }),
    running = worker.loop();
  const db = await createDatabase(settings);
  let job;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await new UpdateSpool('/updates').agent()).available) break;
      await sleep(200);
    }
    const id = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,full_name,role,is_demo) VALUES($1,'compose-updater@example.test','Compose updater','superadmin',true)",
      [id],
    );
    const actor = {
      user: publicUser((await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]),
      sessionId: randomUUID(),
      tokenHash: 'fixture',
    };
    const service = new UpdatesService(
      db,
      await installedBuild(settings),
      new UpdateSpool('/updates'),
      github,
    );
    await service.check(true);
    job = await service.start(actor, { operationId: randomUUID(), targetCommit: target });
    await service.close();
  } catch (error) {
    worker.stop();
    await running.catch(() => {});
    throw error;
  } finally {
    await db.close();
  }
  await running;
  const result = await json(resolve('/updates/jobs', job.id + '.json'));
  assert.equal(result.phase, 'completed', JSON.stringify(result));
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await deployment(config)).current === target) break;
    await sleep(200);
  }
  assert.equal((await deployment(config)).current, target);
  // Reconcile the finished spool into the real database before restarting both containers.
  const reopened = await createDatabase(settings);
  try {
    await new UpdatesService(
      reopened,
      await installedBuild(settings),
      new UpdateSpool('/updates'),
      github,
    ).reconcile();
  } finally {
    await reopened.close();
  }
  console.log(
    'Compose agent built a real Git release, backed up PostgreSQL, migrated and switched the separate application container.',
  );
}
