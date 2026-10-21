import { fixturePassword, passwordLogin } from './helpers/password.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountAuthenticatorSchema, sessionSchema } from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { AccountCrypto, createTotp, hashToken, token } from '../src/modules/auth/crypto.js';

const alias = randomBytes(18).toString('base64url');
const environment = {
  APP_ENV: 'test',
  APP_URL: 'http://localhost:5173',
  API_HOST: '127.0.0.1',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENABLE_DEV_TOOLS: 'true',
  LOCAL_DEBUG_LOGIN: 'true',
  LOCAL_DEBUG_ADMIN_ALIAS: alias,
  LOG_LEVEL: 'silent',
};
const settings = parseSettings(environment),
  crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
if (
  process.env.TEST_DATABASE_URL &&
  !new URL(process.env.TEST_DATABASE_URL).pathname.includes('test')
)
  throw new Error('Use an isolated test database.');
let db: Database, app: Awaited<ReturnType<typeof buildApp>>;
type Headers = { cookie: string; 'x-csrf-token': string };
beforeAll(async () => {
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db);
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE users CASCADE; INSERT INTO security_policy (id,captcha_enabled) VALUES (1,false)',
  );
});
afterAll(async () => {
  await db.exec('UPDATE security_policy SET captcha_enabled=true');
  await app.close();
});
function headers(response: Awaited<ReturnType<typeof app.inject>>): Headers {
  return {
    cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
    'x-csrf-token': response.json().data.csrfToken,
  };
}
async function local(email = alias) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: '' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { response, headers: headers(response) };
}
async function create(admin: Headers, role = 'student') {
  const input = {
    email: `admin-made-${randomUUID()}@example.test`,
    name: 'Созданный пользователь',
    password: fixturePassword,
    role,
    operationId: randomUUID(),
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/accounts',
    headers: admin,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { input, setup: accountAuthenticatorSchema.parse(response.json().data) };
}
async function login(email: string, secret: string) {
  return passwordLogin(app, { payload: { email, code: createTotp(email, secret).generate() } });
}

describe('local account operations', () => {
  it('returns the same credentials error for malformed email and 2FA inputs', async () => {
    for (const payload of [
      { email: 'invalid', code: '' },
      { email: 'valid@example.test', code: 'abc' },
      { email: 'valid@example.test', code: '123' },
      { email: 42, code: '' },
      { email: '', code: '' },
      { email: 'unknown', code: '', role: 'superadmin' },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
      expect(r.statusCode, r.body).toBe(401);
      expect(r.json().error.code).toBe('INVALID_CREDENTIALS');
      expect(r.json().error.message).toBe('Неверная почта или пароль.');
    }
    expect((await db.query('SELECT * FROM users')).rows).toHaveLength(0);
  });
  it('creates persistent isolated local identities and full sessions for all four shortcuts', async () => {
    const admin = await local();
    expect(sessionSchema.parse(admin.response.json().data).user!.role).toBe('superadmin');
    expect(admin.response.json().data.dashboardPath).toBe('/admin');
    for (const email of ['testuser1', 'testuser2', 'testuser3']) {
      const user = await local(email),
        again = await local(email);
      expect(user.response.json().data.user.id).toBe(again.response.json().data.user.id);
      expect(user.response.json().data.dashboardPath).toBe('/student');
      expect(
        (await app.inject({ url: '/api/v1/auth/session', headers: user.headers })).json().data.user
          .role,
      ).toBe('student');
    }
    expect((await db.query('SELECT * FROM users')).rows).toHaveLength(4);
    expect(
      (await db.query('SELECT * FROM auth_sessions WHERE local_debug=true')).rows,
    ).toHaveLength(7);
  });
  it('does not accept unknown shortcuts or shortcuts with a nonempty code', async () => {
    for (const email of [alias, 'testuser1', 'testuser2', 'testuser3', 'unknown'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email, code: '123456' },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'unknown', code: '' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('rejects remote/forwarded requests and never transports a local session to a remote request', async () => {
    const admin = await local();
    for (const request of [
      { remoteAddress: '198.51.100.10' },
      { headers: { 'x-forwarded-for': '127.0.0.1' } },
      { headers: { forwarded: 'for=127.0.0.1' } },
      { headers: { host: 'example.test' } },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: alias, code: '' },
        ...request,
      });
      expect(r.statusCode, r.body).toBe(401);
    }
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: admin.headers,
          remoteAddress: '198.51.100.10',
        })
      ).json().data.user,
    ).toBeNull();
    expect(
      (
        await app.inject({
          url: '/api/v1/admin/accounts',
          headers: admin.headers,
          remoteAddress: '198.51.100.10',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: 'https://evil.example' },
          payload: { email: alias, code: '' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('disables shortcuts and their sessions when the local mode is off', async () => {
    const admin = await local();
    const ordinary = await buildApp(parseSettings({ ...environment, LOCAL_DEBUG_LOGIN: 'false' }), {
      ...db,
      close: async () => {},
    });
    try {
      expect(
        (
          await ordinary.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: alias, code: '' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await ordinary.inject({ url: '/api/v1/auth/session', headers: admin.headers })).json().data
          .user,
      ).toBeNull();
    } finally {
      await ordinary.close();
    }
    expect(() =>
      parseSettings({
        ...environment,
        APP_ENV: 'production',
        APP_URL: 'https://luch.example',
        DATABASE_URL: 'postgresql://user:password@db:5432/luch',
        MAIL_MODE: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        ENABLE_DEV_TOOLS: 'false',
      }),
    ).toThrow('LOCAL_DEBUG_LOGIN');
    expect(() => parseSettings({ ...environment, API_HOST: '0.0.0.0' })).toThrow(
      'LOCAL_DEBUG_LOGIN',
    );
    expect(() => parseSettings({ ...environment, TRUST_PROXY_CIDRS: '127.0.0.1' })).toThrow(
      'LOCAL_DEBUG_LOGIN',
    );
  });
  it('admin-created accounts immediately use ordinary email and TOTP login without SMTP', async () => {
    const admin = await local();
    for (const role of ['student', 'teacher']) {
      const { setup } = await create(admin.headers, role);
      expect(setup.user).toMatchObject({ emailVerified: true, authenticatorEnabled: true, role });
      expect(setup.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
      const r = await login(setup.user.email, setup.manualKey);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().data.user.id).toBe(setup.user.id);
      expect(r.json().data.dashboardPath).toBe(role === 'student' ? '/student' : '/teacher');
      expect(r.body).not.toContain(setup.manualKey);
      const detail = await app.inject({
        url: `/api/v1/admin/accounts/${setup.user.id}`,
        headers: admin.headers,
      });
      expect(detail.body).not.toContain(setup.manualKey);
    }
    expect((await db.query('SELECT * FROM mail_outbox')).rows).toHaveLength(0);
  });
  it('resets 2FA, invalidates old sessions/tokens and admits only the new key', async () => {
    const admin = await local(),
      { setup } = await create(admin.headers);
    const signed = await login(setup.user.email, setup.manualKey);
    expect(signed.statusCode).toBe(200);
    const oldSession = headers(signed);
    await db.query(
      'INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at) VALUES ($1,$2,$3,$4)',
      [hashToken(token()), setup.user.id, 'enrollment', new Date(Date.now() + 600000)],
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${setup.user.id}/authenticator/reset`,
      headers: admin.headers,
      payload: { operationId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const fresh = accountAuthenticatorSchema.parse(response.json().data);
    expect(fresh.manualKey).not.toBe(setup.manualKey);
    expect(
      (await app.inject({ url: '/api/v1/auth/session', headers: oldSession })).json().data.user,
    ).toBeNull();
    expect((await login(setup.user.email, setup.manualKey)).statusCode).toBe(401);
    expect((await login(setup.user.email, fresh.manualKey)).statusCode).toBe(200);
    expect(
      (
        await db.query('SELECT * FROM auth_tokens WHERE user_id=$1 AND consumed_at IS NULL', [
          setup.user.id,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('limits credential viewing/resetting and creation to CSRF-authorized superadmins', async () => {
    const admin = await local(),
      student = await local('testuser1'),
      { setup } = await create(admin.headers);
    for (const requestHeaders of [{}, student.headers]) {
      expect(
        (
          await app.inject({
            url: `/api/v1/admin/accounts/${setup.user.id}/authenticator`,
            headers: requestHeaders,
          })
        ).statusCode,
      ).toBe(requestHeaders === student.headers ? 403 : 401);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers: { cookie: admin.headers.cookie },
          payload: {
            email: 'new@example.test',
            name: 'Тестовый',
            role: 'student',
            operationId: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(403);
    const current = await app.inject({
      url: `/api/v1/admin/accounts/${setup.user.id}/authenticator`,
      headers: admin.headers,
    });
    expect(current.json().data.manualKey).toBe(setup.manualKey);
    expect(current.headers['cache-control']).toBe('no-store');
  });
  it('deduplicates create/reset deliveries and rejects changed or obsolete operations', async () => {
    const admin = await local(),
      input = {
        email: 'duplicate@example.test',
        name: 'Повтор операции',
        password: fixturePassword,
        role: 'student',
        operationId: randomUUID(),
      };
    const created = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers: admin.headers,
          payload: input,
        }),
      ),
    );
    expect(created.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(created[0]!.json().data).toEqual(created[1]!.json().data);
    const id = created[0]!.json().data.user.id as string;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers: admin.headers,
          payload: { ...input, name: 'Другой' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers: admin.headers,
          payload: { ...input, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    const operationId = randomUUID(),
      url = `/api/v1/admin/accounts/${id}/authenticator/reset`;
    const reset = await Promise.all(
      [0, 1].map(() =>
        app.inject({ method: 'POST', url, headers: admin.headers, payload: { operationId } }),
      ),
    );
    expect(reset.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(reset[0]!.json().data).toEqual(reset[1]!.json().data);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: admin.headers,
          payload: { operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url, headers: admin.headers, payload: { operationId } }))
        .statusCode,
    ).toBe(409);
    expect((await db.query('SELECT * FROM users WHERE email=$1', [input.email])).rows).toHaveLength(
      1,
    );
  });
  it('honors blocking and cannot upgrade an existing ordinary identity through a shortcut', async () => {
    const admin = await local();
    await db.query('UPDATE users SET is_blocked=true WHERE id=$1', [
      admin.response.json().data.user.id,
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: alias, code: '' },
        })
      ).statusCode,
    ).toBe(403);
    await db.query(
      'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,false)',
      [randomUUID(), 'testuser1@example.test', 'Обычный аккаунт', 'teacher'],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'testuser1', code: '' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
