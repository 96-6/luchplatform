import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { AccountCrypto, createTotp } from '../apps/api/dist/modules/auth/crypto.js';
import { Passwords } from '../apps/api/dist/modules/auth/password.js';

const settings = loadSettings();
if (settings.APP_ENV === 'production' || !settings.ENABLE_DEV_TOOLS)
  throw new Error('Password smoke requires an isolated development/test database.');
const db = await createDatabase(settings),
  crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY),
  passwords = new Passwords(crypto),
  base = 'http://127.0.0.1:3000',
  statePath = '/tmp/luch-password-smoke.json';
const post = (path, body, headers = {}) =>
  fetch(base + '/api/v1' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
try {
  if (process.argv[2] !== 'verify') {
    const id = randomUUID(),
      email = `compose-password-${id}@example.test`,
      password = randomBytes(24).toString('base64url'),
      secret = createTotp(email).secret.base32;
    await db.query(
      'INSERT INTO users(id,email,full_name,role,is_demo,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified,password_hash_ciphertext,password_changed_at) VALUES($1,$2,$3,$4,true,now(),now(),$5,true,$6,now())',
      [
        id,
        email,
        'Compose password check',
        'student',
        crypto.encrypt(secret),
        await passwords.protect(password),
      ],
    );
    const first = await post('/auth/login', { email, password });
    assert.equal(first.status, 200);
    const challenge = (await first.json()).data;
    assert.equal(challenge.step, 'totp');
    const pending = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('luch_login='))
      .split(';')[0];
    assert.equal(
      (await (await fetch(base + '/api/v1/auth/session', { headers: { cookie: pending } })).json())
        .data.user,
      null,
    );
    const second = await post(
      '/auth/login/confirm',
      { code: createTotp(email, secret).generate() },
      { cookie: pending, 'x-login-csrf': challenge.csrfToken },
    );
    assert.equal(second.status, 200);
    const session = (await second.json()).data;
    assert.equal(session.user.id, id);
    const cookie = second.headers
      .getSetCookie()
      .find((c) => c.startsWith('luch_session='))
      .split(';')[0];
    await writeFile(
      statePath,
      JSON.stringify({ id, email, password, cookie, csrf: session.csrfToken }),
      { mode: 0o600 },
    );
    console.log('Password and separate 2FA session persisted.');
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const session = await (
      await fetch(base + '/api/v1/auth/session', { headers: { cookie: state.cookie } })
    ).json();
    assert.equal(session.data.user.id, state.id);
    const row = (
      await db.query('SELECT password_hash_ciphertext FROM users WHERE id=$1', [state.id])
    ).rows[0];
    assert.equal(await passwords.matches(state.password, row.password_hash_ciphertext), true);
    assert.equal(JSON.stringify(session).includes(row.password_hash_ciphertext), false);
    assert.equal(
      (await post('/auth/logout', {}, { cookie: state.cookie, 'x-csrf-token': state.csrf })).status,
      200,
    );
    assert.equal(
      (
        await (
          await fetch(base + '/api/v1/auth/session', { headers: { cookie: state.cookie } })
        ).json()
      ).data.user,
      null,
    );
    console.log('Protected password and 2FA session survive restart; logout revokes the session.');
  }
} finally {
  await db.close();
}
