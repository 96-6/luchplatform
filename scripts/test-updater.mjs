// Real managed-server acceptance: local Git main, real builds/migrations, persistent DB and browser.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { migrate } from '../apps/api/dist/db/migrations.js';
import { AccountCrypto, createTotp } from '../apps/api/dist/modules/auth/crypto.js';
import { Passwords } from '../apps/api/dist/modules/auth/password.js';
import { command } from './update-runtime/commands.mjs';
import { atomic, json, sleep, deployment } from './update-runtime/shared.mjs';
import { runSupervisor } from './update-runtime/supervisor.mjs';
import { UpdateWorker } from './update-runtime/worker.mjs';
import { writeBuildInfo, inspectSource } from './build-info.mjs';

process.umask(0o077);
const project = fileURLToPath(new URL('../', import.meta.url)),
  directory = await mkdtemp(resolve(tmpdir(), 'luch-updater-'));
const initial = resolve(directory, 'source'),
  state = resolve(directory, 'state');
const config = {
  protocol: 1,
  mode: 'node',
  initialRoot: initial,
  dataDir: resolve(directory, 'data'),
  stateDir: state,
  releasesDir: resolve(directory, 'releases'),
  backupsDir: resolve(directory, 'backups'),
  listenHost: '127.0.0.1',
  listenPort: 0,
};
const native = process.env.UPDATER_TEST_DATABASE_URL;
if (native && !new URL(native).pathname.includes('test'))
  throw Error('An isolated test database is required');
const secret = randomBytes(32).toString('base64'),
  email = 'update-root@example.test',
  password = 'Isolated updater fixture password 2026!',
  totp = createTotp(email),
  actorId = randomUUID();
let supervisor, browser, workerPromise, worker, page;
const env = {
  ...(process.env.UPDATER_TEST_VIDEO_ENV
    ? JSON.parse(await readFile(process.env.UPDATER_TEST_VIDEO_ENV, 'utf8'))
    : {}),
  APP_ENV: 'test',
  APP_URL: 'http://127.0.0.1:3309',
  API_HOST: '127.0.0.1',
  API_PORT: '3309',
  DATABASE_URL: native ?? `pglite:${config.dataDir}/database`,
  AUTH_ENCRYPTION_KEY: secret,
  SERVE_WEB: 'true',
  ENABLE_DEV_TOOLS: 'false',
  LOCAL_DEBUG_LOGIN: 'false',
  LOG_LEVEL: 'silent',
  MEETING_FILE_DIRECTORY: resolve(config.dataDir, 'meeting-files'),
  UPDATE_STATE_DIRECTORY: state,
};
Object.assign(process.env, env);
const settings = parseSettings(env),
  crypto = new AccountCrypto(secret);
const git = async (args) => command('git', args, { cwd: initial, quiet: true, capture: true });
async function commit(message) {
  await git(['add', '--all']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    message,
  ]);
  return (await git(['rev-parse', 'HEAD'])).trim();
}
async function waitFor(test, ms = 120000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const value = await test();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw last ?? Error('Acceptance condition timed out');
}
async function control(action, jobId) {
  const d = await deployment(config),
    requestId = randomUUID();
  await atomic(resolve(state, 'deployment.json'), { ...d, action, jobId, requestId });
  return waitFor(async () => {
    const ack = await json(resolve(state, 'ack.json'));
    return ack?.requestId === requestId && ack.action === 'stopped' ? ack : null;
  });
}
async function targetVersion(version, migration, sql, breakStartup = false) {
  const pkg = JSON.parse(await readFile(resolve(initial, 'package.json'), 'utf8'));
  pkg.version = version;
  await writeFile(resolve(initial, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // npm ci compares package versions too; keep the root lock metadata in sync.
  const lock = JSON.parse(await readFile(resolve(initial, 'package-lock.json'), 'utf8'));
  lock.version = version;
  lock.packages[''].version = version;
  await writeFile(resolve(initial, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeFile(resolve(initial, `apps/api/migrations/${migration}_updater_fixture.sql`), sql);
  if (breakStartup) {
    const p = resolve(initial, 'apps/api/src/server.ts');
    await writeFile(
      p,
      "if(process.env.APP_ENV==='test')throw new Error('Synthetic update readiness failure');\n" +
        (await readFile(p, 'utf8')),
    );
  }
  const sha = await commit('Updater acceptance ' + version),
    source = await inspectSource(initial);
  return { sha, fingerprint: source.fingerprint };
}
async function seedChannel(db, target) {
  await db.query(
    "UPDATE platform_update_channel SET checked_at=now(),next_check_at=now()+interval '6 hours',checking_since=NULL,latest_commit=$1,latest_fingerprint=$2,latest_committed_at=now(),last_error=NULL WHERE id=1",
    [target.sha, target.fingerprint],
  );
}
try {
  await mkdir(initial, { recursive: true });
  await mkdir(state, { recursive: true });
  const files = (
    await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: project,
      capture: true,
      quiet: true,
    })
  )
    .split('\0')
    .filter(Boolean);
  for (const name of files) {
    const destination = resolve(initial, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(project, name), destination);
  }
  await command('git', ['init', '-b', 'main', initial], { quiet: true });
  await commit('Installed fixture');
  await writeFile(resolve(initial, '.git/info/exclude'), 'node_modules\n');
  // Use the already built application as an archive-style initial installation.
  for (const folder of ['apps/api/dist', 'apps/web/dist', 'packages/contracts/dist'])
    await cp(resolve(project, folder), resolve(initial, folder), { recursive: true });
  await symlink(resolve(project, 'node_modules'), resolve(initial, 'node_modules'), 'dir');
  for (const workspace of ['apps/api', 'apps/web', 'packages/contracts'])
    try {
      await access(resolve(project, workspace, 'node_modules'));
      await symlink(
        resolve(project, workspace, 'node_modules'),
        resolve(initial, workspace, 'node_modules'),
        'dir',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  const stamp = await writeBuildInfo(initial);
  await atomic(resolve(initial, 'build-info.json'), { ...stamp, commit: null });
  const target = await targetVersion(
    '0.1.1',
    '028',
    "CREATE TABLE updater_fixture(value text NOT NULL); INSERT INTO updater_fixture VALUES('preserved');\n",
  );
  // Restore installed source before initial migrations; Git main remains the update source separately.
  const remote = resolve(directory, 'remote.git');
  await command('git', ['clone', '--bare', initial, remote], { quiet: true });
  await git(['checkout', 'HEAD~1']);
  let db = await createDatabase(settings);
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES($1,$2,$3,'superadmin',now(),now(),$4,true,$5,now())",
    [
      actorId,
      email,
      'Обновления — проверка',
      crypto.encrypt(totp.secret.base32),
      await new Passwords(crypto).protect(password),
    ],
  );
  await db.exec('UPDATE security_policy SET captcha_enabled=false');
  await seedChannel(db, target);
  await db.close();
  config.listenPort = 3309;
  supervisor = await runSupervisor(config, { startWorker: false });
  await waitFor(async () => {
    const r = await fetch(env.APP_URL + '/api/v1/health/ready');
    return r.ok;
  });
  console.log('Installed server is ready.');
  // Let the real worker announce its heartbeat before the UI requests the overview.
  worker = new UpdateWorker(config, { gitRemote: remote });
  workerPromise = worker.loop();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const context = await browser.newContext({
    locale: 'ru-RU',
    permissions: ['camera', 'microphone'],
  });
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('Browser error:', e.message));
  await page.goto(env.APP_URL + '/login');
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByLabel('Код Authenticator').fill(totp.generate());
  await page.getByRole('button', { name: 'Подтвердить вход', exact: true }).click();
  await page.waitForURL('**/admin');
  await page.getByRole('tab', { name: 'Обновления', exact: true }).click();
  await page
    .getByRole('button', { name: 'Обновить систему', exact: true })
    .waitFor({ state: 'visible' });
  assert(await page.getByRole('img', { name: 'Доступно обновление' }).count());
  let call, meetingId, meetingCsrf;
  if (process.env.UPDATER_TEST_VIDEO_ENV) {
    meetingCsrf = (await (await page.request.get(env.APP_URL + '/api/v1/auth/session')).json()).data
      .csrfToken;
    const created = await page.request.post(env.APP_URL + '/api/v1/meetings/adhoc', {
      headers: { 'x-csrf-token': meetingCsrf },
      data: {
        operationId: randomUUID(),
        title: 'Managed update live-call acceptance',
        language: 'ru',
        timeZone: 'UTC',
        durationMinutes: null,
        reusable: true,
        allowGuests: false,
        expiresAt: null,
        lobbyEnabled: false,
      },
    });
    assert.equal(created.status(), 200, await created.text());
    meetingId = (await created.json()).data.meeting.id;
    call = await context.newPage();
    await call.goto(env.APP_URL + `/meetings/${meetingId}/room`);
    await call.getByRole('button', { name: 'Начать встречу', exact: true }).click();
    await waitFor(
      async () =>
        (await call.locator('.meeting-connection').innerText()).includes('Соединение установлено'),
      30000,
    );
    await call.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await call.getByRole('button', { name: 'Выключить камеру', exact: true }).waitFor();
    await waitFor(
      async () =>
        call
          .locator('video')
          .evaluateAll((elements) => elements.some((video) => video.readyState >= 2)),
      30000,
    );
  }
  await page.evaluate(() => {
    window.__updatePageIdentity = 'same-document';
  });
  let maintenance = false;
  const probes = [];
  page.on('response', async (response) => {
    if (response.url().includes('/admin/updates/progress') && response.ok())
      try {
        if ((await response.json()).data.transport === 'maintenance' && !maintenance) {
          maintenance = true;
          probes.push(
            (async () => {
              assert.equal((await fetch(response.url())).status, 503);
              assert.equal((await fetch(env.APP_URL + '/api/v1/health/live')).status, 200);
            })(),
          );
        }
      } catch {}
  });
  await page.getByRole('button', { name: 'Обновить систему', exact: true }).click();
  await page.getByRole('button', { name: 'Начать обновление', exact: true }).click();
  if (call) {
    const jobId = (await (await page.request.get(env.APP_URL + '/api/v1/admin/updates')).json())
      .data.latestJob.id;
    await waitFor(
      async () =>
        (await json(resolve(state, 'jobs', jobId + '.json')))?.phase === 'waiting_for_meetings',
      15 * 60 * 1000,
    );
    assert(
      (await call.locator('.meeting-connection').innerText()).includes('Соединение установлено'),
    );
    assert.equal((await deployment(config)).current, 'initial');
    assert.equal((await fetch(env.APP_URL + '/api/v1/health/ready')).status, 200);
    const ended = await page.request.post(env.APP_URL + `/api/v1/meetings/${meetingId}/moderate`, {
      headers: { 'x-csrf-token': meetingCsrf },
      data: { operationId: randomUUID(), action: 'end' },
    });
    assert.equal(ended.status(), 200, await ended.text());
    await call.close();
    console.log(
      'PASS: real LiveKit signalling, camera publication and waiting for the active call through the stable supervisor.',
    );
  }
  await waitFor(
    async () => {
      const d = await deployment(config);
      return d.current === target.sha && d.action === 'serve';
    },
    15 * 60 * 1000,
  );
  await workerPromise;
  workerPromise = null;
  await page
    .getByRole('heading', { name: 'Обновление завершено', exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__updatePageIdentity), 'same-document');
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'updates');
  assert(maintenance, 'Progress was served during the application restart');
  await Promise.all(probes);
  let response = await page.request.get(env.APP_URL + '/api/v1/auth/session');
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).data.user.id, actorId);
  response = await page.request.get(env.APP_URL + '/api/v1/admin/updates');
  const done = (await response.json()).data;
  assert.equal(done.current.commit, target.sha);
  assert.equal(done.status, 'current');
  assert.equal(done.latestJob.phase, 'completed');
  await page.screenshot({
    path: resolve(project, 'test-results/updater-success.png'),
    fullPage: true,
  });
  console.log(
    'PASS: real Git build, backup, migration, readiness, same page, maintenance progress and preserved superadmin session.',
  );

  // Publish a second real source build whose migration succeeds but API startup fails.
  await git(['checkout', 'main']);
  const broken = await targetVersion(
    '0.1.2',
    '029',
    "UPDATE updater_fixture SET value='changed by failed update'; CREATE TABLE failed_update_marker(id integer);\n",
    true,
  );
  await command('git', ['--git-dir', remote, 'fetch', initial, 'main:main'], { quiet: true });
  const failureId = randomUUID();
  await control('stop', failureId);
  db = await createDatabase(settings);
  await seedChannel(db, broken);
  await db.query(
    'INSERT INTO platform_update_jobs(id,actor_id,operation_id,target_commit,created_at) VALUES($1,$2,$3,$4,now())',
    [failureId, actorId, randomUUID(), broken.sha],
  );
  await db.close();
  const old = await deployment(config);
  await atomic(resolve(state, 'deployment.json'), {
    ...old,
    action: 'serve',
    jobId: null,
    requestId: randomUUID(),
  });
  await waitFor(async () => {
    const r = await fetch(env.APP_URL + '/api/v1/health/ready');
    return r.ok;
  });
  const failedJob = {
    id: failureId,
    targetCommit: broken.sha,
    actorName: 'Обновления — проверка',
    phase: 'queued',
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    completedAt: null,
    restored: false,
    error: null,
    logs: [],
  };
  await atomic(resolve(state, 'jobs', failureId + '.json'), failedJob);
  const rollbackWorker = new UpdateWorker(config, { gitRemote: remote });
  await rollbackWorker.loop({ once: true });
  const failed = await json(resolve(state, 'jobs', failureId + '.json'));
  assert.equal(failed.phase, 'failed', JSON.stringify(failed));
  assert.equal(failed.restored, true, JSON.stringify(failed));
  await waitFor(async () => {
    const r = await fetch(env.APP_URL + '/api/v1/health/ready');
    return r.ok;
  });
  response = await page.request.get(env.APP_URL + '/api/v1/auth/session');
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).data.user.id, actorId);
  await page.reload();
  await page.getByRole('heading', { name: 'Обновление не выполнено', exact: true }).waitFor();
  await supervisor.close();
  supervisor = null;
  db = await createDatabase(settings);
  assert.equal((await db.query('SELECT value FROM updater_fixture')).rows[0].value, 'preserved');
  assert.equal(
    (await db.query("SELECT to_regclass('public.failed_update_marker') AS name")).rows[0].name,
    null,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version LIKE '029_%'"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [actorId])).rows[0].n,
    1,
  );
  await db.close();
  console.log(
    'PASS: failed startup restored the previous build, full database, migration history and existing session (' +
      (native ? 'native PostgreSQL' : 'persistent PGlite') +
      ').',
  );
} catch (error) {
  if (page) {
    console.error(
      'Browser at failure:',
      page.url(),
      (
        await page
          .locator('main')
          .innerText()
          .catch(() => '')
      ).slice(0, 2500),
    );
    await mkdir(resolve(project, 'test-results'), { recursive: true });
    await page
      .screenshot({ path: resolve(project, 'test-results/updater-failure.png'), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  worker?.stop();
  if (workerPromise) await workerPromise.catch(() => {});
  if (browser) await browser.close();
  if (supervisor) await supervisor.close();
  await rm(directory, { recursive: true, force: true });
}
