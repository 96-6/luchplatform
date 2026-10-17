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
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: createTotp(email, secret).generate() },
  });
}

describe('account access status', () => {
  it('distinguishes deactivation from a ban, revokes sessions and restores access without resetting credentials', async () => {
    const admin = (await local()).headers;
    const { input, setup } = await create(admin);
    const status = (isActive: boolean, isBlocked = false, blockReason = '') =>
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/accounts/${setup.user.id}`,
        headers: admin,
        payload: { isActive, isBlocked, blockReason, accessVerified: true },
      });
    expect((await status(false)).statusCode).toBe(200);
    let denied = await login(input.email, setup.manualKey);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
      message: 'Ваш аккаунт деактивирован администратором',
    });
    expect((await status(true)).json().data).toMatchObject({ isActive: true, isBlocked: false });
    const signed = await login(input.email, setup.manualKey);
    expect(signed.statusCode, signed.body).toBe(200);
    const student = headers(signed);
    const reason = 'Нарушение правил <img src=x onerror=alert(1)>';
    expect((await status(true, true, reason)).statusCode).toBe(200);
    const expired = await app.inject({ url: '/api/v1/auth/session', headers: student });
    expect(expired.json().data.user).toBeNull();
    denied = await login(input.email, setup.manualKey);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'ACCOUNT_BLOCKED',
      message: 'Ваша учетная запись заблокирована\n' + reason,
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: input.email, code: 'not-a-code' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).not.toContain(reason);
    const restored = await status(true);
    expect(restored.json().data.blockReason).toBe('');
    expect(
      (
        await db.query<{ totp_secret_ciphertext: string }>(
          'SELECT totp_secret_ciphertext FROM users WHERE id=$1',
          [setup.user.id],
        )
      ).rows[0]!.totp_secret_ciphertext,
    ).toBeTruthy();
  });
  it('rejects self-deactivation and excessive reasons', async () => {
    const admin = await local();
    const selfId = admin.response.json().data.user.id;
    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${selfId}`,
      headers: admin.headers,
      payload: { isActive: false, isBlocked: false, accessVerified: true },
    });
    expect(self.statusCode).toBe(409);
    const { setup } = await create(admin.headers);
    const long = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${setup.user.id}`,
      headers: admin.headers,
      payload: {
        isActive: true,
        isBlocked: true,
        blockReason: 'x'.repeat(1001),
        accessVerified: true,
      },
    });
    expect(long.statusCode).toBe(400);
    const unchanged = (
      await db.query<{ is_active: boolean; is_blocked: boolean }>(
        'SELECT is_active,is_blocked FROM users WHERE id=$1',
        [setup.user.id],
      )
    ).rows[0]!;
    expect(unchanged).toMatchObject({ is_active: true, is_blocked: false });
  });
});
