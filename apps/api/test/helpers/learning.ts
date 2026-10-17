import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import {
  contentPackageSchema,
  runViewSchema,
  diagnosticViewSchema,
  planViewSchema,
  submitResultSchema,
  type Answer,
  type Questionnaire,
  type RunView,
  type User,
} from '@luch/contracts';
import { buildApp } from '../../src/app.js';
import { parseSettings, projectRoot, type Settings } from '../../src/config.js';
import { createDatabase, type Database, type QueryExecutor } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrations.js';
import { AccountCrypto, createTotp } from '../../src/modules/auth/crypto.js';
import type { Actor } from '../../src/modules/auth/service.js';
import { publicUser, type UserRow } from '../../src/modules/accounts/repository.js';
import { seedDemoContent } from '../../src/modules/content/bootstrap.js';
import type { ProviderFetch } from '../../src/modules/providers/adapters.js';

export type Login = { actor: Actor; headers: { cookie: string; 'x-csrf-token': string } };
export async function learningFixture(
  providerFetch?: ProviderFetch,
  meetingVideo?: import('../../src/modules/meetings/adapter.js').MeetingVideo,
  videoSettings?: Pick<
    Settings,
    'LIVEKIT_URL' | 'LIVEKIT_WS_URL' | 'LIVEKIT_API_KEY' | 'LIVEKIT_API_SECRET'
  >,
  testWebRoot?: string,
) {
  const settings = parseSettings({
    APP_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    LOG_LEVEL: 'silent',
    SERVE_WEB: testWebRoot ? 'true' : 'false',
    ...videoSettings,
  });
  if (
    process.env.TEST_DATABASE_URL &&
    !new URL(process.env.TEST_DATABASE_URL).pathname.includes('test')
  )
    throw new Error('Use an isolated test database.');
  const db = await createDatabase(settings);
  await migrate(db);
  const app = await buildApp(settings, db, {
      providerFetch,
      meetingVideo,
      ...(testWebRoot ? { testWebRoot } : {}),
    }),
    crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
  const demo = contentPackageSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, 'content/demo/luch-demo.json'), 'utf8')),
  );
  const reset = async () => {
    await db.exec(`TRUNCATE users,content_packages,auth_rate_limits CASCADE;
      INSERT INTO security_policy (id,captcha_enabled) VALUES (1,false);
      INSERT INTO ai_configuration (id) VALUES (1);
      INSERT INTO external_providers (id,model) VALUES ('openai','gpt-4.1-mini'),('neuroapi','gpt-4.1-mini'),('elevenlabs','eleven_multilingual_v2'),('heygen','avatar_iv'),('elevenlabs_stt','scribe_v2');
      INSERT INTO avatar_configuration (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET revision=1,bindings=DEFAULT;
      UPDATE adaptive_policy SET installed_at=now(),review_delay_hours=48 WHERE id=1;`);
    await seedDemoContent(db);
  };
  const active = async (role: User['role'] = 'student'): Promise<Login> => {
    const id = randomUUID(),
      email = `learning-${id}@example.test`,
      secret = createTotp(email).secret.base32;
    const row = (
      await db.query<UserRow>(
        'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true) RETURNING *',
        [id, email, 'Обучение', role, crypto.encrypt(secret)],
      )
    ).rows[0]!;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, code: createTotp(email, secret).generate() },
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      actor: { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'test' },
      headers: {
        cookie: `luch_session=${response.cookies.find((c) => c.name === 'luch_session')!.value}`,
        'x-csrf-token': response.json().data.csrfToken,
      },
    };
  };
  const view = async (user: Login, id: string) => {
    const r = await app.inject({ url: `/api/v1/engine/runs/${id}`, headers: user.headers });
    expect(r.statusCode, r.body).toBe(200);
    return runViewSchema.parse(r.json().data);
  };
  const answerFor = (run: RunView, correct: boolean): Answer => {
    const e = demo.exercises.find((e) => e.id === run.current!.exercise.id)!;
    if (e.solution.type === 'short_text')
      return { type: 'short_text', text: correct ? e.solution.accepted[0]! : 'wrong' };
    const solution = e.solution;
    if (e.response.type !== 'choice') throw new Error('Bad bank');
    return {
      type: 'choice',
      optionId: e.response.options.find(
        (o) => solution.correctOptionIds.includes(o.id) === correct,
      )!.id,
    };
  };
  const answer = async (
    user: Login,
    run: RunView,
    correct: boolean,
    operationId = randomUUID(),
  ) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/answer`,
      headers: user.headers,
      payload: { turnId: run.current!.turn.id, operationId, answer: answerFor(run, correct) },
    });
    expect(r.statusCode, r.body).toBe(200);
    return submitResultSchema.parse(r.json().data).view;
  };
  const next = async (user: Login, run: RunView) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/next`,
      headers: user.headers,
      payload: { turnId: run.current!.turn.id },
    });
    expect(r.statusCode, r.body).toBe(200);
    return runViewSchema.parse(r.json().data);
  };
  const finish = async (
    user: Login,
    id: string,
    answers = [true, true, true, true, true, true],
  ) => {
    let run = await view(user, id);
    while (run.current) {
      if (!run.current.attempt)
        run = await answer(user, run, answers[run.current.position] ?? false);
      run = await next(user, run);
    }
    return run;
  };
  const plan = async (user: Login, id: string) => {
    const r = await app.inject({ url: `/api/v1/plans/${id}`, headers: user.headers });
    expect(r.statusCode, r.body).toBe(200);
    return planViewSchema.parse(r.json().data);
  };
  const start = async (user: Login, id: string, assignmentId: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${id}/assignments/${assignmentId}/start`,
      headers: user.headers,
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    return runViewSchema.parse(r.json().data);
  };
  const preparedPlan = async (
    user: Login,
    fields: Partial<Questionnaire> = {},
    answers?: boolean[],
  ) => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/learning/profile',
      headers: user.headers,
      payload: {
        language: 'ru',
        goal: 'daily_life',
        experience: 'none',
        minutesPerDay: 20,
        ...fields,
        revision: 0,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics',
      headers: user.headers,
      payload: { profileRevision: 1 },
    });
    expect(started.statusCode, started.body).toBe(200);
    const d = diagnosticViewSchema.parse(started.json().data);
    await finish(user, d.diagnostic.runId, answers);
    const report = await app.inject({
      url: `/api/v1/diagnostics/${d.diagnostic.id}`,
      headers: user.headers,
    });
    return plan(user, diagnosticViewSchema.parse(report.json().data).planId!);
  };
  return {
    db,
    app,
    settings,
    crypto,
    demo,
    reset,
    active,
    view,
    answerFor,
    answer,
    next,
    finish,
    plan,
    start,
    preparedPlan,
  };
}
export function failOn(db: Database, prefix: string): Database {
  return {
    ...db,
    transaction: (callback) =>
      db.transaction((tx) => {
        const broken: QueryExecutor = {
          ...tx,
          async query(sql, parameters) {
            if (sql.startsWith(prefix)) throw new Error('Planned persistence failure');
            return tx.query(sql, parameters);
          },
        };
        return callback(broken);
      }),
  };
}
