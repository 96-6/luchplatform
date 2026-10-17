import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { operationsOverviewSchema, maintenanceOperationSchema, pageTarget } from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
import { hashToken, token } from '../src/modules/auth/crypto.js';

let f: Awaited<ReturnType<typeof learningFixture>>, directory: string, root: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'luch-interface-access-'));
  root = join(directory, 'web');
  for (const d of ['assets', 'avatars', 'audio', 'learning-media'])
    await mkdir(join(root, d), { recursive: true });
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html lang="ru"><body>Audited application shell</body></html>',
  );
  await writeFile(join(root, 'assets', 'index-test.js'), 'export const marker=true;');
  await writeFile(join(root, 'audio', 'pcm-recorder.js'), '/* audio worklet fixture */');
  await writeFile(
    join(root, 'learning-media', 'phrases-ru-v1.txt'),
    'Материал демонстрационного банка',
  );
  await writeFile(join(root, 'learning-media', 'unpublished.txt'), 'unpublished');
  await writeFile(join(directory, 'private.txt'), 'outside-static-root');
  await symlink(join(directory, 'private.txt'), join(root, 'assets', 'escape.js'));
  f = await learningFixture(undefined, undefined, undefined, root);
});
beforeEach(async () => {
  await f.reset();
});
afterAll(async () => {
  await f.app.close();
  await rm(directory, { recursive: true, force: true });
});
async function group() {
  const student = await f.active(),
    teacher = await f.active('teacher'),
    admin = await f.active('admin'),
    superadmin = await f.active('superadmin');
  await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
    teacher.actor.user.id,
    student.actor.user.id,
  ]);
  return { student, teacher, admin, superadmin };
}
async function get(path: string, actor?: Login) {
  return f.app.inject({ url: path, ...(actor ? { headers: actor.headers } : {}) });
}
async function navigation(path: string, actor?: Login) {
  return get(`/api/v1/navigation/access?path=${encodeURIComponent(path)}`, actor);
}
async function start(actor: Login, purpose = 'practice') {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: actor.headers,
    payload: {
      packageId: 'luch-demo',
      restart: true,
      source: { type: 'lesson', id: 'rki-01', purpose },
    },
  });
  expect(r.statusCode).toBe(200);
  return r.json().data;
}
async function execute(
  actor: Login,
  kind: string,
  operationId = randomUUID(),
  headers = actor.headers,
) {
  return f.app.inject({
    method: 'POST',
    url: '/api/v1/operations/actions',
    headers,
    payload: { kind, operationId },
  });
}
describe('page access, links and operator interfaces', () => {
  it('returns real HTML 401 for private direct links and 403 for a wrong role, including HEAD', async () => {
    const g = await group();
    for (const path of [
      '/student',
      '/teacher',
      '/admin',
      '/plan',
      '/courses',
      '/admin/content',
      '/operations',
    ]) {
      const r = await get(path);
      expect(r.statusCode, path).toBe(401);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain('401 · Требуется вход');
      expect(r.body).not.toContain('Audited application shell');
    }
    for (const [actor, path] of [
      [g.student, '/admin'],
      [g.teacher, '/operations'],
      [g.admin, '/progress'],
      [g.admin, '/admin'],
      [g.superadmin, '/student'],
    ] as const) {
      expect((await get(path, actor)).statusCode).toBe(403);
      expect((await navigation(path, actor)).statusCode).toBe(403);
    }
    const head = await f.app.inject({ method: 'HEAD', url: '/admin' });
    expect(head.statusCode).toBe(401);
    expect(head.body).toBe('');
  });
  it('allows each role own navigation and does not require a fabricated student ID for selection pages', async () => {
    const g = await group();
    const matrix: [Login, string[]][] = [
      [
        g.student,
        [
          '/student',
          '/courses',
          '/learning',
          '/onboarding',
          '/assistant',
          '/plan',
          '/progress',
          '/feedback',
          '/schedule',
        ],
      ],
      [
        g.teacher,
        [
          '/teacher',
          '/courses',
          '/learning',
          '/onboarding',
          '/assistant',
          '/plan',
          '/progress',
          '/feedback',
          '/schedule',
        ],
      ],
      [g.admin, ['/operations', '/admin/providers', '/schedule', '/courses']],
      [
        g.superadmin,
        [
          '/admin',
          '/admin?tab=accounts',
          '/admin?tab=security',
          '/admin?tab=audit',
          '/operations',
          '/admin/content',
          '/admin/learning',
          '/assistant',
          '/plan',
          '/onboarding',
          '/progress',
          '/schedule',
        ],
      ],
    ];
    for (const [actor, paths] of matrix)
      for (const path of paths) {
        expect((await get(path, actor)).statusCode, path).toBe(200);
        expect((await navigation(path, actor)).statusCode, path).toBe(200);
      }
  });
  it('checks actual ownership for run, attempt, diagnostic, plan and student links before sending the SPA', async () => {
    const g = await group(),
      other = await f.active();
    let run = await start(g.student);
    run = await f.answer(g.student, run, true);
    const plan = await f.preparedPlan(g.student),
      planId = plan.plan.id,
      diagnosticId = plan.plan.diagnosticId;
    for (const path of [
      `/learning/runs/${run.run.id}`,
      `/learning/attempts/${run.current.attempt.id}`,
      `/diagnostics/${diagnosticId}`,
      `/plan/${planId}`,
      `/progress?userId=${g.student.actor.user.id}`,
      `/assistant?userId=${g.student.actor.user.id}`,
    ]) {
      for (const actor of [g.student, g.teacher, g.superadmin])
        expect((await get(path, actor)).statusCode, path).toBe(200);
      expect((await get(path, other)).statusCode, path).toBe(404);
      expect((await navigation(path, other)).statusCode).toBe(404);
    }
    expect((await get(`/teacher/students/${g.student.actor.user.id}`, g.teacher)).statusCode).toBe(
      200,
    );
    for (const actor of [g.student, g.teacher, g.admin])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/v1/admin/teacher-students/remove',
            headers: actor.headers,
            payload: { teacherId: g.teacher.actor.user.id, studentId: g.student.actor.user.id },
          })
        ).statusCode,
      ).toBe(403);
    const revoke = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/v1/admin/teacher-students/remove',
        headers: g.superadmin.headers,
        payload: { teacherId: g.teacher.actor.user.id, studentId: g.student.actor.user.id },
      });
    expect((await revoke()).statusCode).toBe(200);
    expect((await revoke()).statusCode).toBe(200);
    expect((await get(`/plan/${planId}`, g.teacher)).statusCode).toBe(404);
    expect((await navigation(`/learning/runs/${run.run.id}`, g.teacher)).statusCode).toBe(404);
  });
  it('rejects missing resources, route/lesson substitution, duplicate parameters and redirect injection', async () => {
    const g = await group();
    for (const path of [
      `/learning/runs/${randomUUID()}`,
      `/plan/${randomUUID()}`,
      '/learning/runs/not-a-uuid',
      `/courses/luch-demo/${f.demo.routes.find((r) => r.language === 'ru')!.id}/lessons/english-01`,
      '/unimplemented',
      '/index.html',
      '/package.json',
      '/.env',
      '/temporary/credentials.json',
    ]) {
      const r = await get(path, g.student);
      expect(r.statusCode, path).toBe(404);
      expect(r.body).not.toContain('Audited application shell');
    }
    for (const path of [
      '/progress?userId=' + g.student.actor.user.id + '&userId=' + g.teacher.actor.user.id,
      '/login?next=https%3A%2F%2Fevil.example',
      '/admin?tab=does-not-exist',
      '/progress?language=zz',
      '/schedule?day=2026-02-31',
      '/plan?userId=%27%20OR%201%3D1--',
    ]) {
      expect((await get(path, g.superadmin)).statusCode, path).toBe(400);
      expect((await navigation(path, g.superadmin)).statusCode, path).toBe(400);
    }
    for (const path of [
      'https://evil.example',
      '//evil.example',
      '/admin\\x',
      '/assets/%2e%2e/index.html',
      '/plan?constructor=x',
      '/plan?__proto__=x',
      '/login?next=javascript:alert(1)',
    ])
      expect((await navigation(path, g.superadmin)).statusCode, path).toBe(400);
    expect(() => pageTarget('/learning/runs/%252fadmin')).toThrow();
  });
  it('checks temporary verification/enrollment state without consuming a link or revealing setup secrets in HTML', async () => {
    const id = randomUUID(),
      value = token();
    await f.db.query('INSERT INTO users (id,email,full_name,role) VALUES ($1,$2,$3,$4)', [
      id,
      `pending-${id}@example.test`,
      'Pending account',
      'student',
    ]);
    await f.db.query(
      "INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at) VALUES ($1,$2,'email',now()+interval '30 minutes')",
      [hashToken(value), id],
    );
    expect((await get('/verify-email')).statusCode).toBe(400);
    expect((await get('/authenticator')).statusCode).toBe(401);
    for (let i = 0; i < 2; i++)
      expect((await get(`/verify-email?token=${value}`)).statusCode).toBe(200);
    expect(
      (
        await f.db.query('SELECT consumed_at FROM auth_tokens WHERE token_hash=$1', [
          hashToken(value),
        ])
      ).rows[0]!.consumed_at,
    ).toBeNull();
    const verify = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: value },
    });
    expect(verify.statusCode).toBe(200);
    const cookie = verify.cookies.find((c) => c.name === 'luch_enrollment')!;
    const enrolled = await f.app.inject({
      url: '/authenticator',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.body).not.toMatch(/otpauth|manualKey|qrDataUrl/);
    expect((await get(`/verify-email?token=${value}`)).statusCode).toBe(410);
    await f.db.query(
      "UPDATE auth_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND kind='enrollment'",
      [id],
    );
    expect(
      (
        await f.app.inject({
          url: '/authenticator',
          headers: { cookie: `${cookie.name}=${cookie.value}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await get(`/verify-email?token=${token()}`)).statusCode).toBe(410);
  });
  it('serves only permitted static files and authenticated published learning media', async () => {
    const student = await f.active();
    for (const path of ['/assets/index-test.js', '/audio/pcm-recorder.js'])
      expect((await get(path)).statusCode).toBe(200);
    expect((await get('/learning-media/phrases-ru-v1.txt')).statusCode).toBe(401);
    expect((await get('/learning-media/phrases-ru-v1.txt', student)).statusCode).toBe(200);
    for (const path of [
      '/assets/escape.js',
      '/learning-media/unpublished.txt',
      '/learning-media/missing.txt',
      '/assets/index-test.js.map',
    ])
      expect((await get(path, student)).statusCode, path).toBe(404);
    for (const path of [
      '/learning-media/../private.txt',
      '/learning-media/%2e%2e/private.txt',
      '/assets/%2e%2e/index.html',
    ])
      expect([400, 404]).toContain((await get(path, student)).statusCode);
  });
  it('blocks expired and locked meeting-room links while retaining the authorized meeting card', async () => {
    const g = await group(),
      create = await f.app.inject({
        method: 'POST',
        url: '/api/v1/meetings',
        headers: g.teacher.headers,
        payload: {
          operationId: randomUUID(),
          title: 'Занятие для проверки доступа',
          description: '',
          language: 'ru',
          startsAt: new Date(Date.now() + 60000).toISOString(),
          endsAt: new Date(Date.now() + 3600000).toISOString(),
          timeZone: 'Europe/Moscow',
          organizerId: g.teacher.actor.user.id,
          coorganizerIds: [],
          studentIds: [g.student.actor.user.id],
          lobbyEnabled: true,
        },
      });
    expect(create.statusCode).toBe(200);
    const id = create.json().data.id;
    expect((await get(`/meetings/${id}/room`, g.student)).statusCode).toBe(200);
    await f.db.query('UPDATE scheduled_meetings SET locked=true WHERE id=$1', [id]);
    expect((await get(`/meetings/${id}/room`, g.student)).statusCode).toBe(403);
    expect((await get(`/meetings/${id}/room`, g.teacher)).statusCode).toBe(200);
    await f.db.query("UPDATE scheduled_meetings SET status='cancelled' WHERE id=$1", [id]);
    expect((await get(`/meetings/${id}/room`, g.teacher)).statusCode).toBe(410);
    expect((await get(`/meetings/${id}`, g.student)).statusCode).toBe(200);
  });
  it('builds a secret-free operational overview and enforces operator actions and CSRF on the server', async () => {
    const g = await group();
    expect((await get('/api/v1/operations')).statusCode).toBe(401);
    for (const actor of [g.student, g.teacher])
      expect((await get('/api/v1/operations', actor)).statusCode).toBe(403);
    for (const actor of [g.admin, g.superadmin]) {
      const r = await get('/api/v1/operations', actor);
      expect(r.statusCode).toBe(200);
      const data = operationsOverviewSchema.parse(r.json().data);
      expect(data.counts).toMatchObject({
        routes: 2,
        lessons: 12,
        students: 1,
        teachers: 1,
        learningReady: 0,
      });
      expect(JSON.stringify(data)).not.toMatch(
        /ciphertext|api[_-]?key|secret|postgresql:|pglite:|tokenHash/i,
      );
      expect(data.actions.includes('seed_content')).toBe(actor === g.superadmin);
    }
    expect((await execute(g.admin, 'seed_content')).statusCode).toBe(403);
    expect((await execute(g.admin, 'expire_audio')).statusCode).toBe(403);
    expect(
      (
        await execute(g.superadmin, 'seed_content', randomUUID(), {
          cookie: g.superadmin.headers.cookie,
        } as typeof g.superadmin.headers)
      ).statusCode,
    ).toBe(403);
    expect((await execute(g.superadmin, 'shell')).statusCode).toBe(400);
    for (const actor of [g.teacher, g.admin])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/v1/engine/runs',
            headers: actor.headers,
            payload: {
              packageId: 'luch-demo',
              source: { type: 'lesson', id: 'rki-01', purpose: 'practice' },
            },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('persists maintenance results and returns the same action after repeated delivery without duplicate work', async () => {
    const g = await group(),
      operationId = randomUUID();
    const a = await execute(g.superadmin, 'seed_content', operationId);
    expect(a.statusCode).toBe(200);
    const result = maintenanceOperationSchema.parse(a.json().data);
    expect(result.status).toBe('completed');
    const b = await execute(g.superadmin, 'seed_content', operationId);
    expect(b.json().data).toEqual(result);
    expect((await execute(g.superadmin, 'expire_audio', operationId)).statusCode).toBe(409);
    expect(
      Number((await f.db.query('SELECT count(*) AS n FROM platform_operations')).rows[0]!.n),
    ).toBe(1);
    expect((await get('/api/v1/operations', g.admin)).json().data.recentOperations[0].id).toBe(
      result.id,
    );
    expect(Number((await f.db.query('SELECT count(*) AS n FROM learning_routes')).rows[0]!.n)).toBe(
      2,
    );
  });
  it('claims a concurrently delivered maintenance action once', async () => {
    const actor = await f.active('superadmin'),
      operationId = randomUUID();
    const responses = await Promise.all([
      execute(actor, 'seed_content', operationId),
      execute(actor, 'seed_content', operationId),
      execute(actor, 'seed_content', operationId),
    ]);
    expect(responses.some((r) => r.statusCode === 200)).toBe(true);
    expect(responses.every((r) => [200, 409].includes(r.statusCode))).toBe(true);
    expect(
      Number((await f.db.query('SELECT count(*) AS n FROM platform_operations')).rows[0]!.n),
    ).toBe(1);
    const repeat = await execute(actor, 'seed_content', operationId);
    expect(repeat.statusCode).toBe(200);
    expect(
      responses
        .filter((r) => r.statusCode === 200)
        .every((r) => r.json().data.id === repeat.json().data.id),
    ).toBe(true);
  });
  it('recovers genuine pending evidence without duplicating observations and defers incomplete control attempts', async () => {
    const g = await group();
    let run = await start(g.student);
    run = await f.answer(g.student, run, true);
    const before = Number(
      (await f.db.query('SELECT count(*) AS n FROM skill_observations')).rows[0]!.n,
    );
    await f.db.query('UPDATE engine_events SET processed_at=NULL WHERE attempt_id=$1', [
      run.current.attempt.id,
    ]);
    let control = await start(g.student, 'control');
    await f.answer(g.student, control, true);
    const overview = (await get('/api/v1/operations', g.admin)).json().data;
    expect(overview.counts.learningReady).toBe(1);
    expect(overview.counts.learningDeferred).toBe(1);
    const r = await execute(g.admin, 'recover_learning');
    expect(r.statusCode).toBe(200);
    expect(r.json().data.result.processed).toBe(1);
    const after = (await get('/api/v1/operations', g.admin)).json().data;
    expect(after.counts.learningReady).toBe(0);
    expect(after.counts.learningDeferred).toBe(1);
    expect(
      Number((await f.db.query('SELECT count(*) AS n FROM skill_observations')).rows[0]!.n),
    ).toBe(before);
  });
});
