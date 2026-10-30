import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseSettings, projectRoot } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { AccountCrypto, createTotp, token, hashToken } from '../src/modules/auth/crypto.js';
import { publicUser, type UserRow } from '../src/modules/accounts/repository.js';
import { seedDemoContent } from '../src/modules/content/bootstrap.js';
import { LuchEngine } from '../src/modules/engine/service.js';

it('upgrades a populated pre-password database, revokes old login state and preserves actual learning attempts and Authenticator', async () => {
  const schema = 'auth_migration_' + randomBytes(8).toString('hex');
  const settings = parseSettings({
    APP_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'silent',
  });
  const owner = process.env.TEST_DATABASE_URL ? await createDatabase(settings) : null;
  if (owner) {
    await owner.exec(`CREATE SCHEMA ${schema}`);
    const url = new URL(settings.DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    settings.DATABASE_URL = url.toString();
  }
  const db = await createDatabase(settings),
    crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const directory = resolve(projectRoot, 'apps/api/migrations');
    const files = (await readdir(directory))
      .filter((p) => /^\d{3}_.+\.sql$/.test(p) && p < '018_')
      .sort();
    await db.exec(
      'CREATE TABLE schema_migrations (version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of files) {
      const sql = await readFile(resolve(directory, file), 'utf8');
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
          file,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      });
    }
    expect(files).toHaveLength(17);
    const id = randomUUID(),
      email = 'legacy-migration@example.test',
      secret = createTotp(email).secret.base32,
      cipher = crypto.encrypt(secret),
      oldSession = token(),
      oldEnrollment = token();
    const user = (
      await db.query<UserRow>(
        "INSERT INTO users(id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES($1,$2,$3,'student',now(),now(),$4,true) RETURNING *",
        [id, email, 'Существующий ученик', cipher],
      )
    ).rows[0]!;
    await db.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [randomUUID(), hashToken(oldSession), id],
    );
    await db.query(
      "INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,'enrollment',now()+interval '5 minutes')",
      [hashToken(oldEnrollment), id],
    );
    await db.exec('UPDATE security_policy SET captcha_enabled=false');
    await seedDemoContent(db);
    const actor = {
        user: publicUser(user),
        sessionId: randomUUID(),
        tokenHash: 'migration-fixture',
      },
      engine = new LuchEngine(db);
    let run = await engine.start(actor, {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: 'rki-01', purpose: 'practice' },
    });
    const definition = await engine.content.definition(
      'exercises',
      'luch-demo',
      1,
      run.current!.exercise.id,
    );
    const answer =
      definition.solution.type === 'choice'
        ? { type: 'choice' as const, optionId: definition.solution.correctOptionIds[0]! }
        : { type: 'short_text' as const, text: definition.solution.accepted[0]! };
    run = (
      await engine.answer(actor, run.run.id, {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer,
      })
    ).view;
    const before = (await db.query('SELECT * FROM engine_attempts WHERE run_id=$1', [run.run.id]))
      .rows;
    expect(before).toHaveLength(1);
    expect(await migrate(db)).toEqual([
      '018_password_two_factor.sql',
      '019_meeting_links_files.sql',
      '020_meeting_recording_policy.sql',
      '021_browser_security.sql',
    ]);
    expect(await migrate(db)).toEqual([]);
    const migrated = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [id])).rows[0]!;
    expect(migrated.password_hash_ciphertext).toBeNull();
    expect(migrated.totp_secret_ciphertext).toBe(cipher);
    expect(migrated.totp_enabled_at).toEqual(user.totp_enabled_at);
    expect(
      (await db.query('SELECT * FROM engine_attempts WHERE run_id=$1', [run.run.id])).rows,
    ).toEqual(before);
    app = await buildApp(settings, db);
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: { cookie: `luch_session=${oldSession}` },
        })
      ).json().data.user,
    ).toBeNull();
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/enrollment',
          headers: { cookie: `luch_enrollment=${oldEnrollment}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, code: createTotp(email, secret).generate() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/request',
          payload: { email },
        })
      ).statusCode,
    ).toBe(202);
    const mail = (
      await db.query<{ body_ciphertext: string }>(
        'SELECT body_ciphertext FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',
        [email],
      )
    ).rows[0]!;
    const link = new URL(JSON.parse(crypto.decrypt(mail.body_ciphertext)).verificationUrl),
      password = 'Migration test passphrase 2026!';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/password/reset',
          payload: { token: link.searchParams.get('token'), password },
        })
      ).statusCode,
    ).toBe(200);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.step).toBe('totp');
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/confirm',
      headers: {
        cookie: `luch_login=${first.cookies.find((c) => c.name === 'luch_login')!.value}`,
        'x-login-csrf': first.json().data.csrfToken,
      },
      payload: { code: createTotp(email, secret).generate() },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.user.id).toBe(id);
    const view = await app.inject({
      url: `/api/v1/engine/runs/${run.run.id}`,
      headers: {
        cookie: `luch_session=${second.cookies.find((c) => c.name === 'luch_session')!.value}`,
      },
    });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().data.attempts).toHaveLength(1);
    expect(
      (await db.query('SELECT * FROM engine_attempts WHERE run_id=$1', [run.run.id])).rows,
    ).toEqual(before);
  } finally {
    if (app) await app.close();
    else await db.close();
    if (owner) {
      await owner.exec(`DROP SCHEMA ${schema} CASCADE`);
      await owner.close();
    }
  }
});
