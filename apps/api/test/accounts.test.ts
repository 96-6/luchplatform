import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { AccountCrypto, createTotp, hashToken } from '../src/modules/auth/crypto.js';
import { seedDemo } from '../src/modules/accounts/bootstrap.js';

const key = randomBytes(32).toString('base64');
const settings = parseSettings({
  APP_ENV: 'test',
  AUTH_ENCRYPTION_KEY: key,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
  ENABLE_DEV_TOOLS: 'true',
  LOG_LEVEL: 'silent',
});
if (
  process.env.TEST_DATABASE_URL &&
  !new URL(process.env.TEST_DATABASE_URL).pathname.includes('test')
)
  throw new Error('Use an isolated test database.');
const crypto = new AccountCrypto(key);
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  db = await createDatabase(settings);
  await migrate(db);
  app = await buildApp(settings, db, { captchaGenerator: () => 'ABCDE' });
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE users CASCADE; TRUNCATE captcha_challenges,auth_rate_limits; INSERT INTO security_policy (id,captcha_enabled) VALUES (1,false)',
  );
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.exec(
    "UPDATE security_policy SET vpn_check_enabled=false,captcha_enabled=true,ip_allowlist='[]'::jsonb,revision=1",
  );
  await app.close();
});
function cookie(response: { cookies: { name: string; value: string }[] }, name = 'luch_session') {
  const found = response.cookies.find((item) => item.name === name);
  expect(found).toBeDefined();
  return `${name}=${found!.value}`;
}
async function active(role: User['role'] = 'student') {
  const id = randomUUID();
  const email = `${role}-${id}@example.test`;
  const secret = createTotp(email).secret.base32;
  await db.query(
    'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true)',
    [id, email, `Test ${role}`, role, crypto.encrypt(secret)],
  );
  return { id, email, secret, code: () => createTotp(email, secret).generate() };
}
async function login(user: Awaited<ReturnType<typeof active>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: user.email, code: user.code() },
  });
  expect(response.statusCode).toBe(200);
  return { cookie: cookie(response), csrf: response.json().data.csrfToken as string, response };
}
async function enableCaptcha() {
  await db.exec('UPDATE security_policy SET captcha_enabled=true');
}
async function captcha(purpose: 'login' | 'register' | 'enrollment') {
  const response = await app.inject({ url: `/api/v1/auth/captcha?purpose=${purpose}` });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(response.body).not.toContain('ABCDE');
  return { id: response.json().data.id, answer: 'ABCDE' };
}

describe('accounts acceptance', () => {
  it('completes registration, email verification, QR enrollment and a persistent session', async () => {
    await enableCaptcha();
    const email = 'new-student@example.test';
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Новый ученик', role: 'student', captcha: await captcha('register') },
    });
    expect(register.statusCode).toBe(202);
    const inbox = await app.inject({ url: `/api/v1/dev/mail?email=${email}` });
    const link = new URL(inbox.json().data[0].verificationUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: link.searchParams.get('token') },
    });
    expect(confirm.statusCode).toBe(200);
    const enrollmentCookie = cookie(confirm, 'luch_enrollment');
    const enrollment = await app.inject({
      url: '/api/v1/auth/enrollment',
      headers: { cookie: enrollmentCookie },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.json().data.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = enrollment.json().data.manualKey as string;
    const activated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollment/confirm',
      headers: { cookie: enrollmentCookie },
      payload: { code: createTotp(email, secret).generate(), captcha: await captcha('enrollment') },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().data.session.dashboardPath).toBe('/student');
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie: cookie(activated) },
    });
    expect(session.json().data.user.email).toBe(email);
    expect(session.body).not.toContain(secret);
    const stored = await db.query<{ totp_secret_ciphertext: string }>(
      'SELECT totp_secret_ciphertext FROM users WHERE email=$1',
      [email],
    );
    expect(stored.rows[0]?.totp_secret_ciphertext).not.toContain(secret);
    const consumed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: link.searchParams.get('token') },
    });
    expect(consumed.statusCode).toBe(400);
    expect(
      (await app.inject({ url: '/api/v1/auth/enrollment', headers: { cookie: enrollmentCookie } }))
        .statusCode,
    ).toBe(401);
  });
  it('keeps email confirmation and Authenticator mandatory', async () => {
    const user = await active();
    await db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [user.id]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: user.email, code: user.code() },
        })
      ).statusCode,
    ).toBe(401);
    await db.query('UPDATE users SET email_verified_at=now(),totp_enabled_at=NULL WHERE id=$1', [
      user.id,
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: user.email, code: user.code() },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('does not grant the superadmin role through registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'forged@example.test', name: 'Forged admin', role: 'superadmin' },
    });
    expect(response.statusCode).toBe(400);
    expect((await db.query("SELECT id FROM users WHERE email='forged@example.test'")).rows).toEqual(
      [],
    );
  });
  it('seeds demo accounts and the teacher relation without duplicates', async () => {
    await seedDemo(db, settings);
    await seedDemo(db, settings);
    expect(
      (await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users')).rows[0]
        ?.count,
    ).toBe('3');
    expect(
      (await db.query<{ count: string }>('SELECT count(*)::text AS count FROM teacher_students'))
        .rows[0]?.count,
    ).toBe('1');
    expect(
      (await db.query<{ count: string }>('SELECT count(*)::text AS count FROM mail_outbox')).rows[0]
        ?.count,
    ).toBe('3');
  });
  it('signs in both roles and restricts profiles to their owner or assigned teacher', async () => {
    const student = await active();
    const other = await active();
    const teacher = await active('teacher');
    const unrelated = await active('teacher');
    await db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.id,
      student.id,
    ]);
    const s = await login(student);
    const t = await login(teacher);
    const u = await login(unrelated);
    expect(s.response.json().data.dashboardPath).toBe('/student');
    expect(t.response.json().data.dashboardPath).toBe('/teacher');
    expect(
      (await app.inject({ url: `/api/v1/users/${student.id}`, headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/api/v1/users/${other.id}`, headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/v1/users/${student.id}`, headers: { cookie: t.cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/api/v1/users/${other.id}`, headers: { cookie: t.cookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/v1/users/${student.id}`, headers: { cookie: u.cookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/teacher/students', headers: { cookie: t.cookie } }))
        .json()
        .data.map((user: User) => user.id),
    ).toEqual([student.id]);
    expect(
      (await app.inject({ url: '/api/v1/admin/accounts', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: '/api/v1/teacher/students', headers: { cookie: s.cookie } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ url: `/api/v1/users/${student.id}` })).statusCode).toBe(401);
  });
  it('allows superadmin debugging and records reads, changes and session revocation', async () => {
    const admin = await active('superadmin');
    const user = await active();
    const session = await login(user);
    const a = await login(admin);
    const headers = { cookie: a.cookie, 'x-csrf-token': a.csrf };
    const detail = await app.inject({ url: `/api/v1/admin/accounts/${user.id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.user.email).toBe(user.email);
    expect(detail.json().data.progress).toEqual({
      runs: 0,
      completedRuns: 0,
      attempts: 0,
      correctAttempts: 0,
      assistedAttempts: 0,
    });
    expect(detail.body).not.toContain(user.secret);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/accounts/${user.id}/revoke-sessions`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ url: '/api/v1/auth/session', headers: { cookie: session.cookie } })
      ).json().data.user,
    ).toBeNull();
    expect(
      (await app.inject({ url: '/api/v1/admin/audit', headers }))
        .json()
        .data.some((entry: { action: string }) => entry.action === 'account.debug_view'),
    ).toBe(true);
  });
  it('rejects reused codes, including simultaneous sign-in submissions', async () => {
    const user = await active();
    const payload = { email: user.email, code: user.code() };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/auth/login', payload }),
      app.inject({ method: 'POST', url: '/api/v1/auth/login', payload }),
    ]);
    expect(responses.map((item) => item.statusCode).sort()).toEqual([200, 401]);
    expect(
      (
        await db.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM auth_sessions WHERE user_id=$1',
          [user.id],
        )
      ).rows[0]?.count,
    ).toBe('1');
  });
  it('expires sessions and invalidates them after logout', async () => {
    const user = await active();
    const session = await login(user);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await app.inject({ url: `/api/v1/users/${user.id}`, headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(401);
    const another = await active();
    const second = await login(another);
    await db.query(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [another.id],
    );
    expect(
      (await app.inject({ url: '/api/v1/auth/session', headers: { cookie: second.cookie } })).json()
        .data.user,
    ).toBeNull();
  });
  it('persists a usable session after reopening the database and rebuilding the server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luch-session-'));
    const isolated = { ...settings, DATABASE_URL: `pglite:${directory}/db` };
    const firstDb = await createDatabase(isolated);
    await migrate(firstDb);
    await firstDb.exec('UPDATE security_policy SET captcha_enabled=false');
    const user = await active();
    const row = (
      await db.query<{ full_name: string; totp_secret_ciphertext: string }>(
        'SELECT full_name,totp_secret_ciphertext FROM users WHERE id=$1',
        [user.id],
      )
    ).rows[0]!;
    await firstDb.query(
      "INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext) VALUES ($1,$2,$3,'student',now(),now(),$4)",
      [user.id, user.email, row.full_name, row.totp_secret_ciphertext],
    );
    const first = await buildApp(isolated, firstDb);
    const loginResponse = await first.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, code: user.code() },
    });
    expect(loginResponse.statusCode).toBe(200);
    const savedCookie = cookie(loginResponse);
    await first.close();
    const secondDb = await createDatabase(isolated);
    const second = await buildApp(isolated, secondDb);
    try {
      expect(
        (
          await second.inject({ url: '/api/v1/auth/session', headers: { cookie: savedCookie } })
        ).json().data.user.id,
      ).toBe(user.id);
    } finally {
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('stores session hashes and enforces CSRF and browser origin checks', async () => {
    const admin = await active('superadmin');
    const session = await login(admin);
    const value = session.cookie.split('=')[1]!;
    const stored = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM auth_sessions WHERE user_id=$1',
      [admin.id],
    );
    expect(stored.rows[0]?.token_hash).toBe(hashToken(value));
    expect(stored.rows[0]?.token_hash).not.toBe(value);
    const policy = (
      await app.inject({ url: '/api/v1/admin/security', headers: { cookie: session.cookie } })
    ).json().data;
    delete policy.currentIp;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/security',
          headers: { cookie: session.cookie },
          payload: policy,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/security',
          headers: {
            cookie: session.cookie,
            'x-csrf-token': session.csrf,
            origin: 'https://unrelated.example',
          },
          payload: policy,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('makes enabled captcha mandatory, single-use and persistent across setting changes', async () => {
    await enableCaptcha();
    const user = await active();
    const input = { email: user.email, code: user.code() };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: input })).statusCode,
    ).toBe(400);
    const challenge = await captcha('login');
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { ...input, captcha: challenge },
    });
    expect(good.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { ...input, captcha: challenge },
        })
      ).statusCode,
    ).toBe(400);
    const expired = await captcha('register');
    await db.query(
      "UPDATE captcha_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: {
            email: 'expired@example.test',
            name: 'Expired',
            role: 'student',
            captcha: expired,
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('limits repeated failed sign-ins in durable storage', async () => {
    const user = await active();
    const invalid = String((Number(user.code()) + 1) % 1000000).padStart(6, '0');
    for (let i = 0; i < 5; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { email: user.email, code: invalid },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: user.email, code: invalid },
        })
      ).statusCode,
    ).toBe(429);
  });
  it('keeps SMTP failure recoverable and keeps the local mailbox unavailable in SMTP mode', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('Temporary mail failure'));
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail,
      close: vi.fn(),
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const smtp = await buildApp(
      { ...settings, MAIL_MODE: 'smtp', SMTP_HOST: 'smtp.example.test' },
      { ...db, close: async () => {} },
    );
    try {
      const payload = { email: 'mail@example.test', name: 'Mail user', role: 'student' };
      expect(
        (await smtp.inject({ method: 'POST', url: '/api/v1/auth/register', payload })).statusCode,
      ).toBe(503);
      sendMail.mockResolvedValue({ messageId: 'test' });
      expect(
        (await smtp.inject({ method: 'POST', url: '/api/v1/auth/register', payload })).statusCode,
      ).toBe(202);
      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(
        (await smtp.inject({ url: '/api/v1/dev/mail?email=mail@example.test' })).statusCode,
      ).toBe(404);
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM users WHERE email='mail@example.test'",
          )
        ).rows[0]?.count,
      ).toBe('1');
    } finally {
      await smtp.close();
    }
  });
  it('rejects foreign-key role mismatches and saves valid assignments', async () => {
    const admin = await active('superadmin');
    const teacher = await active('teacher');
    const student = await active();
    const s = await login(admin);
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/teacher-students',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { teacherId: teacher.id, studentId: student.id },
    });
    expect(result.statusCode).toBe(200);
    await expect(
      db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
        student.id,
        teacher.id,
      ]),
    ).rejects.toThrow();
  });
});

describe('site access controls', () => {
  it('blocks the website and API with the requested message when the network assessment denies access', async () => {
    await db.exec(
      'UPDATE security_policy SET vpn_check_enabled=true,ip_allowlist=\'["127.0.0.1"]\'::jsonb',
    );
    const risky = await buildApp(
      settings,
      { ...db, close: async () => {} },
      { ipInspector: async () => ({ openProxyPorts: [80], dnsLeak: true }) },
    );
    try {
      const evaluated = await risky.inject({
        method: 'POST',
        url: '/api/v1/security/evaluate',
        payload: {},
      });
      expect(evaluated.json().data.allowed).toBe(false);
      expect(evaluated.json().data.message).toBe('вы используете VPN - сервис недоступен');
      const proof = cookie(evaluated, 'luch_network');
      const website = await risky.inject({ url: '/', headers: { cookie: proof } });
      expect(website.statusCode).toBe(403);
      expect(website.headers['content-type']).toContain('text/html');
      expect(website.body).toContain('вы используете VPN - сервис недоступен');
      expect(
        (await risky.inject({ url: '/api/v1/admin/accounts', headers: { cookie: proof } }))
          .statusCode,
      ).toBe(403);
      await db.exec('UPDATE security_policy SET vpn_check_enabled=false');
      expect(
        (await risky.inject({ url: '/api/v1/system', headers: { cookie: proof } })).statusCode,
      ).toBe(200);
    } finally {
      await risky.close();
    }
  });
  it('requires a whitelisted observed IP and does not trust forged forwarding headers', async () => {
    await db.exec(
      'UPDATE security_policy SET vpn_check_enabled=true,ip_allowlist=\'["127.0.0.1/32"]\'::jsonb',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/security/evaluate',
      remoteAddress: '203.0.113.10',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      payload: {},
    });
    expect(response.json().data.allowed).toBe(false);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'unknown@example.test', code: '123456' },
    });
    expect(missing.statusCode).toBe(401);
    const user = await active();
    await db.query('UPDATE users SET access_verified=false WHERE id=$1', [user.id]);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/security/evaluate',
      payload: {},
    });
    expect(allowed.json().data.allowed).toBe(true);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie: cookie(allowed, 'luch_network') },
      payload: { email: user.email, code: user.code() },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ACCESS_REVIEW_REQUIRED');
  });
  it('handles partial network measurements', async () => {
    await db.exec(
      'UPDATE security_policy SET vpn_check_enabled=true,ip_allowlist=\'["127.0.0.1"]\'::jsonb',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/security/evaluate',
      payload: {
        resourceResults: [
          { id: 'youtube', loaded: true },
          { id: 'telegram', loaded: true },
          { id: 'whatsapp', loaded: true },
        ],
      },
    });
    expect(response.json().data.allowed).toBe(true);
    const record = (
      await db.query<{ observations: { label: string; status: string }[] }>(
        'SELECT observations FROM network_assessments',
      )
    ).rows[0]!;
    expect(record.observations.find((item) => item.label === 'DNS leak')?.status).toBe('unknown');
  });
  it('saves admin switches and protects against an accidental self lockout', async () => {
    const admin = await active('superadmin');
    const session = await login(admin);
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };
    let policy = (await app.inject({ url: '/api/v1/admin/security', headers })).json().data;
    delete policy.currentIp;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/security',
          headers,
          payload: { ...policy, vpnCheckEnabled: true },
        })
      ).statusCode,
    ).toBe(409);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/security',
      headers,
      payload: {
        ...policy,
        captchaEnabled: true,
        ipAllowlist: ['127.0.0.1'],
        vpnCheckEnabled: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const evaluated = await app.inject({
      method: 'POST',
      url: '/api/v1/security/evaluate',
      payload: {},
    });
    const combined = `${session.cookie}; ${cookie(evaluated, 'luch_network')}`;
    policy = (
      await app.inject({ url: '/api/v1/admin/security', headers: { cookie: combined } })
    ).json().data;
    expect(policy.captchaEnabled).toBe(true);
    expect(policy.vpnCheckEnabled).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/accounts/${admin.id}`,
          headers: { ...headers, cookie: combined },
          payload: { isBlocked: true, accessVerified: true },
        })
      ).statusCode,
    ).toBe(409);
  });
});
