import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLIENT_PROTECTION_POLICY, clientProtectionPolicySchema } from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';

let f: Awaited<ReturnType<typeof learningFixture>>, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'luch-client-protection-'));
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><html><body>Application shell</body></html>',
  );
  f = await learningFixture(undefined, undefined, undefined, directory);
});
beforeEach(async () => {
  await f.reset();
});
afterAll(async () => {
  await f.app.close();
  await rm(directory, { recursive: true, force: true });
});
type Headers = Record<string, string>;
const get = (url: string, headers?: Headers) =>
  f.app.inject({ url, ...(headers ? { headers } : {}) });
async function update(root: Login, patch: Record<string, unknown>) {
  const current = await get('/api/v1/admin/client-protection', root.headers);
  return f.app.inject({
    method: 'POST',
    url: '/api/v1/admin/client-protection',
    headers: root.headers,
    payload: { ...current.json().data, ...patch },
  });
}
async function bootstrap(user: Login, force = true) {
  const result = await get(
    '/api/v1/security/client/bootstrap' + (force ? '?force=true' : ''),
    user.headers,
  );
  expect(result.statusCode, result.body).toBe(200);
  const c = result.cookies.find((c) => c.name === 'luch_client');
  const headers: Headers = {
    ...user.headers,
    cookie: [user.headers.cookie, ...(c ? [`${c.name}=${c.value}`] : [])].join('; '),
  };
  return { headers, state: result.json().data, cookies: result.cookies };
}
async function evidence(user: Login) {
  const boot = await bootstrap(user);
  const resource = await get(
    `/api/v1/security/client/ads.js?id=${boot.state.challenge.id}`,
    boot.headers,
  );
  expect(resource.statusCode, resource.body).toBe(200);
  const proof = /"proof":"([a-f0-9]{64})"/.exec(resource.body)![1]!;
  return { ...boot, input: { ...boot.state.challenge, proof, visible: true } };
}
const verify = (headers: Headers, input: unknown) =>
  f.app.inject({
    method: 'POST',
    url: '/api/v1/security/client/verify',
    headers,
    payload: input as object,
  });
describe('role-scoped browser feature protection', () => {
  it('starts disabled, preserves ordinary access and does not challenge anonymous users or superadmins', async () => {
    const root = await f.active('superadmin'),
      student = await f.active();
    const p = await get('/api/v1/admin/client-protection', root.headers);
    expect(clientProtectionPolicySchema.parse(p.json().data)).toEqual(
      DEFAULT_CLIENT_PROTECTION_POLICY,
    );
    expect((await get('/student', student.headers)).body).toContain('Application shell');
    expect((await bootstrap(student)).state).toMatchObject({
      interactionRestricted: false,
      blockersRequired: false,
      challenge: null,
    });
    await update(root, {
      interactionEnabled: true,
      blockersEnabled: true,
      interactionRoles: ['student', 'teacher', 'admin'],
      blockersRoles: ['student', 'teacher', 'admin'],
    });
    expect((await bootstrap(root)).state).toMatchObject({
      interactionRestricted: false,
      blockersRequired: false,
      challenge: null,
    });
    expect((await get('/api/v1/security/client/bootstrap')).json().data.challenge).toBeNull();
    expect((await get('/admin?tab=security', root.headers)).statusCode).toBe(200);
  });
  it('enforces role, CSRF, origin, strict input, revisions and attributed idempotent saves', async () => {
    const root = await f.active('superadmin'),
      student = await f.active(),
      teacher = await f.active('teacher');
    expect((await get('/api/v1/admin/client-protection', student.headers)).statusCode).toBe(403);
    const input = { ...DEFAULT_CLIENT_PROTECTION_POLICY, blockersEnabled: true };
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/admin/client-protection',
          headers: teacher.headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    for (const headers of [
      { cookie: root.headers.cookie },
      { ...root.headers, origin: 'https://untrusted.test' },
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/v1/admin/client-protection',
            headers,
            payload: input,
          })
        ).statusCode,
      ).toBe(403);
    expect((await update(root, { blockersRoles: ['superadmin'] })).statusCode).toBe(400);
    expect((await update(root, { interactionRoles: ['teacher', 'teacher'] })).statusCode).toBe(400);
    const first = await update(root, { blockersEnabled: true });
    expect(first.statusCode, first.body).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/admin/client-protection',
          headers: root.headers,
          payload: input,
        })
      ).json().data,
    ).toEqual(first.json().data);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/admin/client-protection',
          headers: root.headers,
          payload: { ...input, interactionEnabled: true },
        })
      ).statusCode,
    ).toBe(409);
    const rows = (
      await f.db.query('SELECT actor_id FROM security_audit WHERE action=$1', [
        'security.client_protection.updated',
      ])
    ).rows;
    expect(rows).toEqual([{ actor_id: root.actor.user.id }]);
  });
  it('sets independent scopes from the server role and rejects role/header/URL bypasses', async () => {
    const root = await f.active('superadmin'),
      student = await f.active(),
      teacher = await f.active('teacher'),
      admin = await f.active('admin');
    await update(root, {
      interactionEnabled: true,
      interactionRoles: ['teacher'],
      blockersEnabled: true,
      blockersRoles: ['student'],
    });
    expect((await bootstrap(teacher)).state).toMatchObject({
      interactionRestricted: true,
      blockersRequired: false,
    });
    expect((await bootstrap(student)).state).toMatchObject({
      interactionRestricted: false,
      blockersRequired: true,
    });
    expect((await get('/api/v1/system', admin.headers)).statusCode).toBe(200);
    for (const headers of [
      student.headers,
      { ...student.headers, 'x-role': 'superadmin', 'user-agent': 'trusted-browser' },
    ]) {
      expect((await get('/api/v1/system?role=superadmin', headers)).statusCode).toBe(403);
      expect((await get('/api/v1/engine/runs', headers)).statusCode).toBe(403);
      expect((await get('/api/v1/navigation/access?path=%2Fstudent', headers)).statusCode).toBe(
        403,
      );
    }
    await update(root, { blockersRoles: ['teacher'] });
    expect((await get('/api/v1/system', student.headers)).statusCode).toBe(200);
    expect((await get('/api/v1/system', teacher.headers)).statusCode).toBe(403);
  });
  it('serves a real safe, localised 403 document without an SPA and allows recovery endpoints', async () => {
    const root = await f.active('superadmin'),
      student = await f.active();
    await update(root, { blockersEnabled: true });
    const denied = await get('/student', { ...student.headers, 'accept-language': 'en' });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['content-type']).toContain('text/html');
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(denied.body).toContain('Allow JavaScript, cookies');
    expect(denied.body).not.toContain('Application shell');
    expect(denied.body).toContain('/api/v1/security/client/runtime.js');
    expect((await get('/login', student.headers)).statusCode).toBe(200);
    expect((await get('/api/v1/auth/session', student.headers)).statusCode).toBe(200);
    expect((await get('/api/v1/health/ready', student.headers)).statusCode).toBe(200);
  });
  it('requires cookies and resource execution proof, then verifies subsequent API and document access', async () => {
    const root = await f.active('superadmin'),
      student = await f.active();
    await update(root, { blockersEnabled: true });
    const e = await evidence(student);
    expect(e.cookies[0]).toMatchObject({
      name: 'luch_client',
      httpOnly: true,
      path: '/',
      sameSite: 'Strict',
    });
    expect((await verify(student.headers, e.input)).statusCode).toBe(403);
    expect((await verify(e.headers, { ...e.input, nonce: 'x'.repeat(43) })).statusCode).toBe(403);
    expect((await verify(e.headers, e.input)).statusCode).toBe(200);
    expect((await get('/api/v1/system', e.headers)).statusCode).toBe(200);
    expect((await get('/student', e.headers)).statusCode).toBe(200);
    const before = (await f.db.query('SELECT verified_until FROM client_capability_grants')).rows;
    expect((await verify(e.headers, e.input)).statusCode).toBe(200);
    expect((await f.db.query('SELECT verified_until FROM client_capability_grants')).rows).toEqual(
      before,
    );
    expect((await verify(e.headers, { ...e.input, visible: false })).statusCode).toBe(403);
    expect((await get('/api/v1/system', e.headers)).statusCode).toBe(200);
  });
  it('fails closed for blocked resources or hidden probes and revokes a previously valid grant', async () => {
    const root = await f.active('superadmin'),
      student = await f.active();
    await update(root, { blockersEnabled: true });
    const boot = await bootstrap(student);
    expect(
      (
        await verify(boot.headers, {
          ...boot.state.challenge,
          proof: 'a'.repeat(64),
          visible: true,
        })
      ).statusCode,
    ).toBe(403);
    const e = await evidence(student);
    expect((await verify(e.headers, e.input)).statusCode).toBe(200);
    const next = await evidence({
      ...student,
      headers: { ...student.headers, cookie: e.headers.cookie! },
    });
    expect((await verify(next.headers, { ...next.input, visible: false })).statusCode).toBe(403);
    expect((await get('/api/v1/system', next.headers)).statusCode).toBe(403);
    expect((await verify(next.headers, next.input)).statusCode).toBe(403);
    const recovered = await evidence({
      ...student,
      headers: { ...student.headers, cookie: e.headers.cookie! },
    });
    expect((await verify(recovered.headers, recovered.input)).statusCode).toBe(200);
    expect((await verify(next.headers, { ...next.input, visible: false })).statusCode).toBe(403);
    expect((await get('/api/v1/system', recovered.headers)).statusCode).toBe(200);
  });
  it('rejects proofs from other sessions, changed browsers, expired challenges and obsolete policies', async () => {
    const root = await f.active('superadmin'),
      student = await f.active(),
      other = await f.active();
    await update(root, { blockersEnabled: true });
    let e = await evidence(student);
    const stolen = {
      ...e.headers,
      cookie:
        other.headers.cookie +
        '; ' +
        e.headers.cookie!.split('; ').find((v) => v.startsWith('luch_client=')),
    };
    expect((await verify(stolen, e.input)).statusCode).toBe(403);
    expect(
      (await verify({ ...e.headers, 'user-agent': 'changed-client' }, e.input)).statusCode,
    ).toBe(403);
    await f.db.query(
      "UPDATE client_capability_challenges SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [e.input.id],
    );
    expect((await verify(e.headers, e.input)).statusCode).toBe(403);
    e = await evidence(student);
    expect((await verify(e.headers, e.input)).statusCode).toBe(200);
    await update(root, { interactionEnabled: true });
    expect((await get('/api/v1/system', e.headers)).statusCode).toBe(403);
    expect((await verify(e.headers, e.input)).statusCode).toBe(403);
  });
  it('expires saved grants, checks current account status and keeps logout available', async () => {
    const root = await f.active('superadmin'),
      student = await f.active();
    await update(root, { blockersEnabled: true });
    const e = await evidence(student);
    await verify(e.headers, e.input);
    await f.db.exec("UPDATE client_capability_grants SET verified_until=now()-interval '1 minute'");
    expect((await get('/api/v1/system', e.headers)).statusCode).toBe(403);
    await f.db.exec("UPDATE client_capability_grants SET verified_until=now()+interval '1 minute'");
    await f.db.query('UPDATE users SET is_blocked=true WHERE id=$1', [student.actor.user.id]);
    expect((await get('/api/v1/engine/runs', e.headers)).statusCode).toBe(401);
    await f.db.query('UPDATE users SET is_blocked=false WHERE id=$1', [student.actor.user.id]);
    expect((await get('/api/v1/system', e.headers)).statusCode).toBe(200);
    const logout = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: e.headers,
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect((await verify(e.headers, e.input)).statusCode).toBe(401);
  });
});
