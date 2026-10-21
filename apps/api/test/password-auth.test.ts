import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionSchema, userSchema } from '@luch/contracts';
import { learningFixture } from './helpers/learning.js';
import { fixturePassword, fixturePasswordHash } from './helpers/password.js';
import { AccountCrypto, createTotp, hashToken } from '../src/modules/auth/crypto.js';
import { Passwords } from '../src/modules/auth/password.js';
import type { UserRow } from '../src/modules/accounts/repository.js';

let f: Awaited<ReturnType<typeof learningFixture>>;
beforeAll(async () => {
  f = await learningFixture();
});
beforeEach(async () => {
  await f.reset();
});
afterAll(async () => {
  await f.app.close();
});
const newPassword = 'A different test passphrase 2026!';
async function account(password = fixturePassword) {
  const id = randomUUID(),
    email = `password-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  const protectedHash =
    password === fixturePassword
      ? await fixturePasswordHash(f.crypto)
      : await new Passwords(f.crypto).protect(password);
  const user = (
    await f.db.query<UserRow>(
      'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES ($1,$2,$3,$4,now(),now(),$5,true,$6,now()) RETURNING *',
      [id, email, 'Проверка пароля', 'student', f.crypto.encrypt(secret), protectedHash],
    )
  ).rows[0]!;
  return {
    user,
    code: (offset = 0) => createTotp(email, secret).generate({ timestamp: Date.now() + offset }),
  };
}
const primary = (email: string, password = fixturePassword) =>
  f.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
function pending(response: Awaited<ReturnType<typeof primary>>) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.step).toBe('totp');
  const cookie = response.cookies.find((c) => c.name === 'luch_login')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  return {
    cookie: `luch_login=${cookie.value}`,
    'x-login-csrf': response.json().data.csrfToken as string,
  };
}
const confirm = (headers: ReturnType<typeof pending>, code: string) =>
  f.app.inject({ method: 'POST', url: '/api/v1/auth/login/confirm', headers, payload: { code } });
function sessionHeaders(response: Awaited<ReturnType<typeof primary>>) {
  const session = sessionSchema.parse(response.json().data);
  return {
    cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
    'x-csrf-token': session.csrfToken!,
  };
}
async function passwordLink(email: string) {
  const requested = await f.app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/request',
    payload: { email },
  });
  expect(requested.statusCode, requested.body).toBe(202);
  const row = (
    await f.db.query<{ body_ciphertext: string }>(
      'SELECT body_ciphertext FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',
      [email],
    )
  ).rows[0]!;
  const link = new URL(JSON.parse(f.crypto.decrypt(row.body_ciphertext)).verificationUrl);
  expect(link.pathname).toBe('/set-password');
  return link.searchParams.get('token')!;
}
const reset = (token: string, password = newPassword) =>
  f.app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/reset',
    payload: { token, password },
  });

describe('password and separate second factor', () => {
  it('stores independently salted protected Argon2id hashes and cannot recover the original password', async () => {
    const passwords = new Passwords(f.crypto),
      a = await passwords.protect(newPassword),
      b = await passwords.protect(newPassword);
    expect(a).not.toBe(b);
    expect(a).not.toContain(newPassword);
    expect(a).not.toContain('$argon2');
    expect(f.crypto.decrypt(a)).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.matches(newPassword, a)).toBe(true);
    expect(await passwords.matches('incorrect password', a)).toBe(false);
    expect(await passwords.matches(newPassword, null)).toBe(false);
    expect(await passwords.matches(newPassword, 'corrupt ciphertext')).toBe(false);
    expect(
      await new Passwords(new AccountCrypto(randomBytes(32).toString('base64'))).matches(
        newPassword,
        a,
      ),
    ).toBe(false);
  });
  it('keeps password-only requests anonymous and requires a challenge-bound CSRF token and TOTP', async () => {
    const a = await account(),
      first = await primary(a.user.email),
      headers = pending(first);
    expect(first.cookies.some((c) => c.name === 'luch_session')).toBe(false);
    expect(first.body).not.toContain(a.user.id);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers })).json().data.user,
    ).toBeNull();
    expect((await f.app.inject({ url: `/api/v1/users/${a.user.id}`, headers })).statusCode).toBe(
      401,
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login/confirm',
          payload: { code: a.code() },
        })
      ).statusCode,
    ).toBe(401);
    expect((await confirm({ ...headers, 'x-login-csrf': 'forged' }, a.code())).statusCode).toBe(
      401,
    );
    const other = pending(await primary(a.user.email));
    expect(
      (await confirm({ ...headers, 'x-login-csrf': other['x-login-csrf'] }, a.code())).statusCode,
    ).toBe(401);
    const signed = await confirm(headers, a.code());
    expect(signed.statusCode, signed.body).toBe(200);
    expect(sessionSchema.parse(signed.json().data).user!.id).toBe(a.user.id);
    expect((await confirm(headers, a.code())).statusCode).toBe(401);
    expect(
      (await f.db.query('SELECT * FROM auth_sessions WHERE user_id=$1', [a.user.id])).rows,
    ).toHaveLength(1);
  });
  it('rejects the legacy OTP-only login and gives the same error for unknown users and incorrect passwords', async () => {
    const a = await account();
    const legacy = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: a.user.email, code: a.code() },
    });
    expect(legacy.statusCode).toBe(401);
    const wrong = await primary(a.user.email, 'incorrect password'),
      unknown = await primary('missing@example.test', 'incorrect password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect((await f.db.query('SELECT * FROM auth_sessions')).rows).toHaveLength(0);
  });
  it('restores only the pending second step and expires it without issuing a session', async () => {
    const a = await account(),
      headers = pending(await primary(a.user.email));
    const restored = await f.app.inject({ url: '/api/v1/auth/login/challenge', headers });
    expect(restored.json().data).toMatchObject({
      step: 'totp',
      csrfToken: headers['x-login-csrf'],
    });
    await f.db.query(
      "UPDATE auth_login_challenges SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [a.user.id],
    );
    expect(
      (await f.app.inject({ url: '/api/v1/auth/login/challenge', headers })).json().data,
    ).toBeNull();
    expect((await confirm(headers, a.code())).json().error.code).toBe('LOGIN_EXPIRED');
  });
  it('persists failed second-factor attempts and permits at most five per challenge', async () => {
    const a = await account(),
      headers = pending(await primary(a.user.email));
    const valid = new Set([-30000, 0, 30000].map((offset) => a.code(offset)));
    let invalid = '000000';
    while (valid.has(invalid)) invalid = String(Number(invalid) + 1).padStart(6, '0');
    for (let i = 0; i < 5; i++) expect((await confirm(headers, invalid)).statusCode).toBe(401);
    expect(
      (
        await f.db.query<{ attempts: number }>(
          'SELECT attempts FROM auth_login_challenges WHERE user_id=$1',
          [a.user.id],
        )
      ).rows[0]!.attempts,
    ).toBe(5);
    expect((await confirm(headers, a.code())).json().error.code).toBe('LOGIN_EXPIRED');
    expect((await confirm(pending(await primary(a.user.email)), a.code())).statusCode).toBe(200);
  });
  it('cancels pending second-factor proof on logout', async () => {
    const a = await account(),
      headers = pending(await primary(a.user.email));
    const loggedOut = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers,
      payload: {},
    });
    expect(loggedOut.statusCode).toBe(200);
    expect((await confirm(headers, a.code())).statusCode).toBe(401);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/login/challenge', headers })).json().data,
    ).toBeNull();
  });
  it('serializes concurrent submissions of one challenge into one session', async () => {
    const a = await account(),
      headers = pending(await primary(a.user.email)),
      code = a.code();
    const result = await Promise.all([confirm(headers, code), confirm(headers, code)]);
    expect(result.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(
      (await f.db.query('SELECT * FROM auth_sessions WHERE user_id=$1', [a.user.id])).rows,
    ).toHaveLength(1);
  });
  it('does not turn email verification alone into first-factor proof or an enrollment cookie', async () => {
    const email = 'new-password-user@example.test';
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { email, name: 'Новый ученик', role: 'student', password: fixturePassword },
        })
      ).statusCode,
    ).toBe(202);
    const stored = (await f.db.query<UserRow>('SELECT * FROM users WHERE email=$1', [email]))
      .rows[0]!;
    await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Подмена', role: 'student', password: newPassword },
    });
    expect(
      (await f.db.query<UserRow>('SELECT * FROM users WHERE email=$1', [email])).rows[0]!
        .password_hash_ciphertext,
    ).toBe(stored.password_hash_ciphertext);
    const mail = (
      await f.db.query<{ body_ciphertext: string }>(
        'SELECT body_ciphertext FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',
        [email],
      )
    ).rows[0]!;
    const link = new URL(JSON.parse(f.crypto.decrypt(mail.body_ciphertext)).verificationUrl);
    const verified = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: link.searchParams.get('token') },
    });
    expect(verified.statusCode).toBe(200);
    expect(
      verified.cookies.filter(
        (c) => c.value && ['luch_session', 'luch_enrollment'].includes(c.name),
      ),
    ).toHaveLength(0);
    expect((await f.app.inject({ url: '/api/v1/auth/enrollment' })).statusCode).toBe(401);
    const first = await primary(email);
    expect(first.json().data).toEqual({ step: 'enrollment' });
    expect(first.cookies.some((c) => c.name === 'luch_session')).toBe(false);
  });
});

describe('password recovery and account controls', () => {
  it('keeps recovery replies generic and protects single-use latest-only links', async () => {
    const a = await account(),
      old = await passwordLink(a.user.email),
      latest = await passwordLink(a.user.email);
    const known = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/request',
      payload: { email: a.user.email },
    });
    const missing = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/request',
      payload: { email: 'unknown@example.test' },
    });
    expect(missing.statusCode).toBe(known.statusCode);
    expect(missing.json().data).toEqual(known.json().data);
    expect((await reset(old)).statusCode).toBe(400);
    expect((await reset(latest)).statusCode).toBe(400);
    const final = await passwordLink(a.user.email);
    expect((await reset(final, 'too short')).statusCode).toBe(400);
    expect((await reset(final)).statusCode).toBe(200);
    expect((await reset(final)).statusCode).toBe(400);
    expect(
      (await f.db.query('SELECT * FROM auth_sessions WHERE user_id=$1', [a.user.id])).rows,
    ).toHaveLength(0);
  });
  it('expires recovery links and does not send links for inactive or banned accounts', async () => {
    const a = await account(),
      link = await passwordLink(a.user.email);
    await f.db.query(
      "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [a.user.id],
    );
    expect((await reset(link)).statusCode).toBe(400);
    await f.db.query('UPDATE users SET is_active=false WHERE id=$1', [a.user.id]);
    const before = (await f.db.query('SELECT id FROM mail_outbox')).rows.length;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/request',
          payload: { email: a.user.email },
        })
      ).statusCode,
    ).toBe(202);
    await f.db.query('UPDATE users SET is_active=true,is_blocked=true WHERE id=$1', [a.user.id]);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/request',
          payload: { email: a.user.email },
        })
      ).statusCode,
    ).toBe(202);
    expect((await f.db.query('SELECT id FROM mail_outbox')).rows).toHaveLength(before);
  });
  it('revokes sessions and pending login on recovery while preserving Authenticator and requiring both factors again', async () => {
    const a = await account(),
      headers = sessionHeaders(await confirm(pending(await primary(a.user.email)), a.code())),
      unfinished = pending(await primary(a.user.email));
    const link = await passwordLink(a.user.email),
      changed = await reset(link);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.cookies.filter((c) => c.name === 'luch_session' && c.value)).toHaveLength(0);
    const row = (await f.db.query<UserRow>('SELECT * FROM users WHERE id=$1', [a.user.id]))
      .rows[0]!;
    expect(row.totp_secret_ciphertext).toBe(a.user.totp_secret_ciphertext);
    expect(row.auth_revision).toBe(a.user.auth_revision + 1);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers })).json().data.user,
    ).toBeNull();
    expect((await confirm(unfinished, a.code(30000))).statusCode).toBe(401);
    expect((await primary(a.user.email)).statusCode).toBe(401);
    const signed = await confirm(pending(await primary(a.user.email, newPassword)), a.code(30000));
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.body).not.toContain(row.password_hash_ciphertext!);
  });
  it('lets existing OTP accounts set their first password without resetting their second factor', async () => {
    const a = await account();
    await f.db.query(
      'UPDATE users SET password_hash_ciphertext=NULL,password_changed_at=NULL WHERE id=$1',
      [a.user.id],
    );
    expect((await primary(a.user.email)).statusCode).toBe(401);
    const link = await passwordLink(a.user.email);
    expect((await reset(link)).statusCode).toBe(200);
    const signed = await confirm(pending(await primary(a.user.email, newPassword)), a.code());
    expect(sessionSchema.parse(signed.json().data).user!.id).toBe(a.user.id);
    expect(
      (await f.db.query<UserRow>('SELECT * FROM users WHERE id=$1', [a.user.id])).rows[0]!
        .totp_secret_ciphertext,
    ).toBe(a.user.totp_secret_ciphertext);
  });
  it('requires current password, fresh TOTP and session CSRF for self-service password changes', async () => {
    const a = await account(),
      headers = sessionHeaders(await confirm(pending(await primary(a.user.email)), a.code()));
    const change = (currentPassword: string, code: string, h = headers) =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/change',
        headers: h,
        payload: { currentPassword, password: newPassword, code },
      });
    expect(
      (await change(fixturePassword, a.code(30000), { ...headers, 'x-csrf-token': 'forged' }))
        .statusCode,
    ).toBe(403);
    expect((await change('wrong current password', a.code(30000))).statusCode).toBe(401);
    expect((await change(fixturePassword, a.code())).statusCode).toBe(401);
    expect((await change(fixturePassword, a.code(30000))).statusCode).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers })).json().data.user,
    ).toBeNull();
    expect((await primary(a.user.email)).statusCode).toBe(401);
    expect((await primary(a.user.email, newPassword)).json().data.step).toBe('totp');
  });
  it('limits password management to superadmins without returning stored passwords or hashes', async () => {
    const root = await f.active('superadmin'),
      operator = await f.active('admin'),
      a = await account(),
      unfinished = pending(await primary(a.user.email));
    const input = { operationId: randomUUID(), password: newPassword },
      url = `/api/v1/admin/accounts/${a.user.id}/password/reset`;
    for (const [headers, status] of [
      [{}, 401],
      [operator.headers, 403],
      [{ cookie: root.headers.cookie }, 403],
    ] as const)
      expect(
        (await f.app.inject({ method: 'POST', url, headers, payload: input })).statusCode,
      ).toBe(status);
    const results = await Promise.all(
      [0, 1].map(() =>
        f.app.inject({ method: 'POST', url, headers: root.headers, payload: input }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json().data).toEqual(results[1]!.json().data);
    expect(userSchema.parse(results[0]!.json().data).passwordConfigured).toBe(true);
    expect((await confirm(unfinished, a.code())).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: root.headers,
          payload: { ...input, password: fixturePassword },
        })
      ).statusCode,
    ).toBe(409);
    const row = (await f.db.query<UserRow>('SELECT * FROM users WHERE id=$1', [a.user.id]))
      .rows[0]!;
    for (const path of [
      '/api/v1/admin/accounts',
      `/api/v1/admin/accounts/${a.user.id}`,
      `/api/v1/users/${a.user.id}`,
    ]) {
      const r = await f.app.inject({ url: path, headers: root.headers });
      expect(r.statusCode).toBe(200);
      for (const secret of [
        newPassword,
        row.password_hash_ciphertext!,
        f.crypto.decrypt(row.password_hash_ciphertext!),
      ])
        expect(r.body).not.toContain(secret);
    }
    expect(row.totp_secret_ciphertext).toBe(a.user.totp_secret_ciphertext);
    const operations = (
      await f.db.query('SELECT * FROM admin_account_operations WHERE target_id=$1', [a.user.id])
    ).rows;
    expect(JSON.stringify(operations)).not.toContain(newPassword);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/admin/accounts/${root.actor.user.id}/password/reset`,
          headers: root.headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    const link = await passwordLink(a.user.email);
    expect((await reset(link, fixturePassword)).statusCode).toBe(200);
    expect(
      (await f.app.inject({ method: 'POST', url, headers: root.headers, payload: input }))
        .statusCode,
    ).toBe(409);
  });
  it('rejects password-hash and credential injection through public account contracts', async () => {
    const a = await account();
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'injection@example.test',
        name: 'Подмена',
        role: 'student',
        password: fixturePassword,
        password_hash_ciphertext: a.user.password_hash_ciphertext,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(
      (await f.db.query('SELECT * FROM users WHERE email=$1', ['injection@example.test'])).rows,
    ).toHaveLength(0);
  });
});
