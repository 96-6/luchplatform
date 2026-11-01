import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseSettings } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { UpdatesService } from '../src/modules/updates/service.js';
import { GitHubUpdates, type UpdateFetch } from '../src/modules/updates/github.js';
import { UpdateSpool, atomicJson } from '../src/modules/updates/spool.js';
import {
  updateOverviewSchema,
  systemStatusSchema,
  updateJobSchema,
  type BuildInfo,
} from '@luch/contracts';
import { AccountCrypto, createTotp } from '../src/modules/auth/crypto.js';
import { fixturePasswordHash, passwordLogin } from './helpers/password.js';

const alias = randomBytes(16).toString('hex'),
  installed = '1'.repeat(40),
  latest = '2'.repeat(40),
  tree = '3'.repeat(40);
const build: BuildInfo = {
  version: '0.1.0',
  commit: installed,
  fingerprint: '0'.repeat(64),
  builtAt: '2026-10-01T00:00:00.000Z',
  modified: false,
  kind: 'build',
};
let db: Database,
  app: Awaited<ReturnType<typeof buildApp>>,
  directory: string,
  calls = 0,
  fail = false;
let accountCrypto: AccountCrypto;
const fetcher: UpdateFetch = async (url) => {
  calls++;
  if (fail) throw Error('external outage with private token');
  if (url.endsWith('/branches/main'))
    return Response.json({
      commit: {
        sha: latest,
        commit: { tree: { sha: tree }, committer: { date: '2026-11-01T00:00:00Z' } },
      },
    });
  if (url.includes('/git/trees/'))
    return Response.json({
      truncated: false,
      tree: [{ path: 'README.md', type: 'blob', sha: '4'.repeat(40) }],
    });
  if (url.includes('/compare/')) return Response.json({ status: 'ahead' });
  throw Error('Unexpected GitHub path');
};
beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'luch-updates-'));
  const settings = parseSettings({
    APP_ENV: 'test',
    APP_URL: 'http://localhost:5173',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ENABLE_DEV_TOOLS: 'true',
    LOCAL_DEBUG_LOGIN: 'true',
    LOCAL_DEBUG_ADMIN_ALIAS: alias,
    UPDATE_STATE_DIRECTORY: directory,
    LOG_LEVEL: 'silent',
  });
  accountCrypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db, { updateFetch: fetcher, testInstalledBuild: build });
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE users CASCADE; INSERT INTO security_policy(id,captcha_enabled) VALUES(1,false) ON CONFLICT(id) DO UPDATE SET captcha_enabled=false; UPDATE platform_update_channel SET checked_at=NULL,next_check_at=NULL,checking_since=NULL,latest_commit=NULL,latest_fingerprint=NULL,latest_committed_at=NULL,last_error=NULL',
  );
  calls = 0;
  fail = false;
  await atomicJson(resolve(directory, 'agent.json'), {
    protocol: 1,
    mode: 'node',
    heartbeatAt: new Date().toISOString(),
  });
});
afterAll(async () => {
  await db.exec('UPDATE security_policy SET captcha_enabled=true');
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
async function login(email = alias, instance = app, database = db, key = accountCrypto) {
  let response;
  if (email === alias) {
    const address = 'root-' + randomUUID() + '@example.test',
      totp = createTotp(address);
    await database.query(
      "INSERT INTO users(id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES($1,$2,'Root','superadmin',now(),now(),$3,true,$4,now())",
      [randomUUID(), address, key.encrypt(totp.secret.base32), await fixturePasswordHash(key)],
    );
    response = await passwordLogin(instance, {
      payload: { email: address, code: totp.generate() },
    });
  } else
    response = await instance.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, code: '' },
    });
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
    'x-csrf-token': response.json().data.csrfToken,
  };
}
describe('platform update controls', () => {
  it('allows a saved empty meeting while retaining admitted and reconnecting VANISH sessions as active', async () => {
    const headers = await login();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/adhoc',
      headers,
      payload: {
        operationId: randomUUID(),
        title: 'Empty retained meeting',
        language: 'ru',
        timeZone: 'UTC',
        durationMinutes: null,
        reusable: true,
        allowGuests: false,
        expiresAt: null,
        lobbyEnabled: false,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.meeting.id,
      userId = (await app.inject({ url: '/api/v1/auth/session', headers })).json().data.user.id;
    await db.query("UPDATE scheduled_meetings SET status='live' WHERE id=$1", [id]);
    try {
      expect(await app.quiesceForUpdate()).toBe(true);
      app.resumeAfterUpdate();
      const sessionId = randomUUID();
      await db.query(
        "INSERT INTO meeting_sessions(id,meeting_id,user_id,state,first_connected_at,created_at,vanish) VALUES($1,$2,$3,'admitted',now(),now(),true)",
        [sessionId, id, userId],
      );
      expect(await app.quiesceForUpdate()).toBe(false);
      expect(
        (await app.inject({ url: '/api/v1/admin/updates', headers })).json().data.liveMeetings,
      ).toBe(1);
      await db.query("UPDATE meeting_sessions SET state='left',ended_at=now() WHERE id=$1", [
        sessionId,
      ]);
      expect(await app.quiesceForUpdate()).toBe(true);
      expect(
        (await db.query('SELECT status FROM scheduled_meetings WHERE id=$1', [id])).rows[0]!.status,
      ).toBe('live');
    } finally {
      app.resumeAfterUpdate();
    }
  });
  it('restricts diagnostics, checks, progress and changes to superadmins, including on LAN', async () => {
    const root = await login(),
      student = await login('testuser1');
    for (const url of [
      '/admin/system-status',
      '/admin/updates',
      '/admin/updates/progress?jobId=' + randomUUID(),
    ]) {
      expect((await app.inject({ url: '/api/v1' + url })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1' + url, headers: student })).statusCode).toBe(403);
    }
    const status = await app.inject({
      url: '/api/v1/admin/system-status',
      headers: root,
      remoteAddress: '192.168.1.27',
    });
    expect(status.statusCode, status.body).toBe(200);
    const data = systemStatusSchema.parse(status.json().data);
    expect(data.database.available && data.database.schemaCurrent).toBe(true);
    expect(data.database.schemaVersion).toBe('027_platform_updates.sql');
    expect(status.body).not.toContain('DATABASE_URL');
    expect(status.body).not.toContain(directory);
    for (const path of ['check', 'apply']) {
      const payload = path === 'check' ? {} : { operationId: randomUUID(), targetCommit: latest };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/updates/' + path,
            headers: student,
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/updates/' + path,
            headers: { cookie: root.cookie },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/updates/' + path,
            headers: { ...root, origin: 'https://unrelated.example' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
  });
  it('checks GitHub, queues one attributed job, reuses a retry and rejects arbitrary targets or extra commands', async () => {
    const headers = await login();
    const checked = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates/check',
      headers,
      payload: {},
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const view = updateOverviewSchema.parse(checked.json().data);
    expect(view.status).toBe('outdated');
    expect(view.updateAvailable && view.canUpdate).toBe(true);
    expect(Date.parse(view.nextCheckAt!) - Date.parse(view.checkedAt!)).toBe(21600000);
    const input = { operationId: randomUUID(), targetCommit: latest };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/updates/apply',
          headers,
          payload: { ...input, targetCommit: '5'.repeat(40) },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/updates/apply',
          headers,
          payload: { ...input, command: 'touch /tmp/unwanted' },
        })
      ).statusCode,
    ).toBe(400);
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates/apply',
      headers,
      payload: input,
    });
    expect(started.statusCode, started.body).toBe(200);
    const job = updateJobSchema.parse(started.json().data);
    expect(started.cookies.some((c) => c.name === 'luch_update_progress' && c.httpOnly)).toBe(true);
    expect(
      JSON.parse(await readFile(resolve(directory, 'jobs', job.id + '.json'), 'utf8')),
    ).toEqual(job);
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates/apply',
      headers,
      payload: input,
    });
    expect(retry.json().data.id).toBe(job.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/updates/apply',
          headers,
          payload: { ...input, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    await atomicJson(resolve(directory, 'jobs', job.id + '.json'), {
      ...job,
      phase: 'completed',
      completedAt: new Date().toISOString(),
      logs: [{ sequence: 1, at: new Date().toISOString(), text: 'Обновлено' }],
    });
    const progress = await app.inject({
      url: '/api/v1/admin/updates/progress?jobId=' + job.id,
      headers,
    });
    expect(progress.json().data.job.phase).toBe('completed');
    expect(
      (
        await db.query(
          "SELECT action FROM security_audit WHERE action LIKE 'platform.update_%' ORDER BY created_at",
        )
      ).rows.map((r) => r.action),
    ).toEqual(['platform.update_requested', 'platform.update_completed']);
  });
  it('persists the six-hour schedule, coalesces concurrent checks and retains the last result after GitHub errors', async () => {
    let now = Date.now();
    const service = () =>
      new UpdatesService(
        db,
        build,
        new UpdateSpool(directory),
        new GitHubUpdates(fetcher),
        () => now,
      );
    const first = service();
    await Promise.all([first.check(false), first.check(false)]);
    expect(calls).toBe(2);
    await service().check(false);
    expect(calls).toBe(2);
    now += 21600001;
    await service().check(false);
    expect(calls).toBe(4);
    fail = true;
    await first.check(true);
    const state = await first.overview();
    expect(state.latest?.commit).toBe(latest);
    expect(state.lastError).toBeTruthy();
    expect(state.lastError).not.toContain('private token');
    await atomicJson(resolve(directory, 'agent.json'), {
      protocol: 1,
      mode: 'node',
      heartbeatAt: new Date(Date.now() - 60000).toISOString(),
    });
    expect((await first.overview()).canUpdate).toBe(false);
    await first.close();
  });
  it('keeps diagnostics available with developer tools disabled and the maintenance gate server controlled', async () => {
    const headers = await login();
    await app.quiesceForUpdate();
    const mutation = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/updates/check',
      headers,
      payload: {},
    });
    expect(mutation.statusCode).toBe(503);
    expect(
      (await app.inject({ url: '/api/v1/admin/system-status', headers, remoteAddress: '10.1.1.9' }))
        .statusCode,
    ).toBe(200);
    app.resumeAfterUpdate();
    const settings = parseSettings({
      APP_ENV: 'test',
      DATABASE_URL: 'pglite:memory',
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'silent',
    });
    const otherDb = await createDatabase(settings);
    await migrate(otherDb);
    const other = await buildApp(settings, otherDb, { updateFetch: fetcher });
    await otherDb.exec('UPDATE security_policy SET captcha_enabled=false');
    const remoteRoot = await login(
      alias,
      other,
      otherDb,
      new AccountCrypto(settings.AUTH_ENCRYPTION_KEY),
    );
    for (const url of [
      '/api/v1/admin/system-status',
      '/api/v1/navigation/access?path=%2Fsystem',
      '/api/v1/navigation/access?path=%2Fadmin%3Ftab%3Dupdates',
      '/api/v1/navigation/access?path=%2Fadmin%3Ftab%3Dsystem',
    ])
      expect(
        (await other.inject({ url, headers: remoteRoot, remoteAddress: '192.168.1.27' }))
          .statusCode,
      ).toBe(200);
    expect((await other.inject({ url: '/api/v1/dev/records' })).statusCode).toBe(404);
    await other.close();
  });
});
