import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_POLICY,
  browserAccessLinkSchema,
  browserAccessLinksSchema,
  browserAccessDevicesSchema,
} from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const old = 'Mozilla/5.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)';
const yandex = chrome + ' YaBrowser/26.10.0.0 Yowser/2.5';
let f: Awaited<ReturnType<typeof learningFixture>>;
beforeAll(async () => {
  f = await learningFixture();
});
beforeEach(async () => {
  await f.reset();
  await f.db.exec('INSERT INTO browser_policy(id) VALUES(1) ON CONFLICT DO NOTHING;');
});
afterAll(async () => {
  await f.app.close();
});
const base = '/api/v1/admin/browser-access-links';
async function post(
  user: Login,
  url: string,
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  const r = await f.app.inject({
    method: 'POST',
    url,
    headers: { ...user.headers, ...extra },
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function create(root: Login, singleUse = true, extra: Record<string, unknown> = {}) {
  return browserAccessLinkSchema.parse(
    (
      await post(root, base, {
        operationId: randomUUID(),
        label: 'Ручной доступ',
        singleUse,
        ...extra,
      })
    ).json().data,
  );
}
async function page(
  url: string,
  headers: Record<string, string> = { 'user-agent': old },
  status = 200,
) {
  const u = new URL(url);
  const r = await f.app.inject({ url: u.pathname + u.search, headers });
  expect(r.statusCode, r.body).toBe(status);
  const c = r.cookies.find((c) => c.name === 'luch_browser_access');
  return {
    response: r,
    headers: {
      ...headers,
      ...(c ? { cookie: [headers.cookie, `${c.name}=${c.value}`].filter(Boolean).join('; ') } : {}),
    },
    raw: u.searchParams.get('token')!,
    proof: /name="proof" value="([^"]+)"/.exec(r.body)?.[1] ?? '',
  };
}
async function redeem(
  p: Awaited<ReturnType<typeof page>>,
  status = 303,
  label = 'Тестовый ноутбук',
  extra: Record<string, string> = {},
) {
  const r = await f.app.inject({
    method: 'POST',
    url: '/browser-access',
    headers: {
      ...p.headers,
      'content-type': 'application/x-www-form-urlencoded',
      origin: new URL(f.settings.APP_URL).origin,
      ...extra,
    },
    payload: new URLSearchParams({ token: p.raw, proof: p.proof, label }).toString(),
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function links(root: Login) {
  const r = await f.app.inject({ url: base, headers: root.headers });
  expect(r.statusCode, r.body).toBe(200);
  return browserAccessLinksSchema.parse(r.json().data);
}
async function devices(root: Login, id: string) {
  const r = await f.app.inject({ url: `${base}/${id}/devices`, headers: root.headers });
  expect(r.statusCode, r.body).toBe(200);
  return browserAccessDevicesSchema.parse(r.json().data);
}
async function verified(root: Login) {
  const headers = { ...root.headers, 'user-agent': chrome };
  const boot = await f.app.inject({
    url: '/api/v1/security/browser/bootstrap?force=true',
    headers,
  });
  const c = boot.cookies.find((c) => c.name === 'luch_browser');
  headers.cookie += '; luch_browser=' + c!.value;
  const b = boot.json().data.challenge,
    snapshot = { userAgent: chrome, platform: 'Win32', hints: null };
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/security/browser/assess',
    headers,
    payload: {
      challengeId: b.id,
      nonce: b.nonce,
      page: snapshot,
      worker: snapshot,
      features: {
        fetch: true,
        abortController: true,
        websocket: true,
        crypto: true,
        textEncoder: true,
        worker: true,
      },
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().data.decision.allowed).toBe(true);
  root.headers = headers;
}
it('limits link creation, lists, device details and revocation to superadmins with CSRF', async () => {
  const root = await f.active('superadmin'),
    l = await create(root);
  for (const role of ['student', 'teacher', 'admin'] as const) {
    const user = await f.active(role);
    for (const url of [base, `${base}/${l.id}/devices`])
      expect((await f.app.inject({ url, headers: user.headers })).statusCode).toBe(403);
    await post(user, base, { operationId: randomUUID(), label: 'bad', singleUse: false }, 403);
    await post(user, `${base}/${l.id}/revoke`, {}, 403);
    await post(user, `${base}/${l.id}/devices/${randomUUID()}/revoke`, {}, 403);
  }
  expect((await f.app.inject({ url: base })).statusCode).toBe(401);
  const noCsrf = await f.app.inject({
    method: 'POST',
    url: base,
    headers: { cookie: root.headers.cookie },
    payload: { operationId: randomUUID(), label: 'bad', singleUse: true },
  });
  expect(noCsrf.statusCode).toBe(403);
  await post(root, base, { operationId: randomUUID(), label: '', singleUse: true }, 400);
  await post(
    root,
    base,
    { operationId: randomUUID(), label: 'bad', singleUse: true, creatorId: root.actor.user.id },
    400,
  );
  await post(
    root,
    base,
    {
      operationId: randomUUID(),
      label: 'bad',
      singleUse: true,
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    },
    400,
  );
});
it('replays link creation safely, persists its creator and keeps secret values out of device responses', async () => {
  const root = await f.active('superadmin'),
    operationId = randomUUID(),
    input = { operationId, label: 'Разрешение группы', singleUse: false };
  const a = (await post(root, base, input)).json().data,
    b = (await post(root, base, input)).json().data;
  expect(a.id).toBe(b.id);
  expect(a.url).toBe(b.url);
  expect(a.creator).toMatchObject({ id: root.actor.user.id, email: root.actor.user.email });
  await post(root, base, { ...input, label: 'different' }, 409);
  const raw = new URL(a.url).searchParams.get('token')!;
  const stored = (
    await f.db.query('SELECT token_hash,token_ciphertext FROM browser_access_links WHERE id=$1', [
      a.id,
    ])
  ).rows[0]!;
  expect(stored.token_hash).not.toBe(raw);
  expect(String(stored.token_ciphertext)).not.toContain(raw);
  const p = await page(a.url);
  await redeem(p);
  const d = (await devices(root, a.id)).items[0]!;
  expect(d).toMatchObject({
    label: 'Тестовый ноутбук',
    browser: 'ie',
    platform: 'windows',
    active: true,
  });
  expect(JSON.stringify(d)).not.toMatch(/token_hash|token_ciphertext|luch_browser_access/);
  expect((await links(root)).items).toHaveLength(1);
});
it('does not spend single-use links on GET and serializes two independent browser redemptions', async () => {
  const root = await f.active('superadmin'),
    l = await create(root),
    a = await page(l.url),
    b = await page(l.url);
  expect((await links(root)).items[0]?.totalDevices).toBe(0);
  const results = await Promise.all(
    [a, b].map((p) =>
      f.app.inject({
        method: 'POST',
        url: '/browser-access',
        headers: { ...p.headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ token: p.raw, proof: p.proof, label: 'race' }).toString(),
      }),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([303, 410]);
  expect((await devices(root, l.id)).items).toHaveLength(1);
  const winner = results[0]!.statusCode === 303 ? a : b;
  await redeem(winner);
  await page(l.url, winner.headers);
  await page(l.url, { 'user-agent': old }, 410);
  expect((await links(root)).items[0]).toMatchObject({
    totalDevices: 1,
    activeDevices: 1,
    status: 'used',
  });
});
it('remembers multiple browser profiles, deduplicates retries and records the last authenticated account', async () => {
  const root = await f.active('superadmin'),
    student = await f.active(),
    l = await create(root, false);
  const a = await page(l.url),
    b = await page(l.url, { 'user-agent': yandex });
  await redeem(a);
  await redeem(a);
  await redeem(b, 303, 'Телефон');
  const headers = { ...a.headers, cookie: a.headers.cookie + '; ' + student.headers.cookie };
  const response = await f.app.inject({ url: '/api/v1/auth/session', headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.user.id).toBe(student.actor.user.id);
  const remembered = (await devices(root, l.id)).items;
  expect(remembered).toHaveLength(2);
  expect(remembered.find((d) => d.label === 'Тестовый ноутбук')?.lastUser?.id).toBe(
    student.actor.user.id,
  );
  expect((await links(root)).items[0]).toMatchObject({ activeDevices: 2, totalDevices: 2 });
});
it.each([old, yandex])(
  'overrides both browser modes without worker evidence or an account: %s',
  async (ua) => {
    const root = await f.active('superadmin'),
      l = await create(root);
    await f.db.exec('UPDATE browser_policy SET enhanced_enabled=true,revision=revision+1');
    const denied = await f.app.inject({
      url: '/api/v1/auth/session',
      headers: { 'user-agent': ua },
    });
    expect(denied.statusCode).toBe(403);
    const p = await page(l.url, { 'user-agent': ua });
    await redeem(p);
    const boot = await f.app.inject({
      url: '/api/v1/security/browser/bootstrap?force=true',
      headers: p.headers,
    });
    expect(boot.json().data).toMatchObject({
      challenge: null,
      decision: { allowed: true, warning: false, reason: 'manual' },
    });
    const anon = await f.app.inject({ url: '/api/v1/auth/session', headers: p.headers });
    expect(anon.statusCode, anon.body).toBe(200);
    expect(anon.json().data.user).toBeNull();
    expect((await f.app.inject({ url: base, headers: p.headers })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          url: '/api/v1/video/rtc/validate?access_token=invalid',
          headers: p.headers,
        })
      ).statusCode,
    ).toBe(401);
    const forged = await f.app.inject({
      url: '/api/v1/auth/session',
      headers: {
        ...p.headers,
        cookie: 'luch_browser_access=' + 'A'.repeat(43),
        'x-browser-approved': 'true',
      },
    });
    expect(forged.statusCode).toBe(403);
  },
);
it('rejects missing, altered, foreign and expired form proofs and cross-site requests', async () => {
  const root = await f.active('superadmin'),
    l = await create(root, false),
    p = await page(l.url),
    other = await page(l.url);
  await redeem({ ...p, proof: '' }, 403);
  await redeem({ ...p, proof: p.proof.slice(0, -1) + 'x' }, 403);
  await redeem({ ...p, headers: other.headers }, 403);
  await redeem(p, 403, 'name', { 'sec-fetch-site': 'cross-site' });
  await redeem(p, 403, 'name', { origin: 'https://example.invalid' });
  const expired = p.proof.replace(/^\d+/, String(Date.now() - 1));
  await redeem({ ...p, proof: expired }, 403);
  expect((await devices(root, l.id)).items).toHaveLength(0);
});
it('revokes one remembered browser while preserving the others, history and revoker attribution', async () => {
  const root = await f.active('superadmin'),
    otherRoot = await f.active('superadmin'),
    l = await create(root, false),
    a = await page(l.url),
    b = await page(l.url);
  await redeem(a);
  await redeem(b, 303, 'Второй');
  const d = (await devices(root, l.id)).items.find((d) => d.label === 'Тестовый ноутбук')!;
  await post(otherRoot, `${base}/${l.id}/devices/${d.id}/revoke`, {});
  await post(otherRoot, `${base}/${l.id}/devices/${d.id}/revoke`, {});
  expect((await f.app.inject({ url: '/api/v1/auth/session', headers: a.headers })).statusCode).toBe(
    403,
  );
  expect((await f.app.inject({ url: '/api/v1/auth/session', headers: b.headers })).statusCode).toBe(
    200,
  );
  const saved = (await devices(root, l.id)).items.find((x) => x.id === d.id)!;
  expect(saved.active).toBe(false);
  expect(saved.revokedBy?.id).toBe(otherRoot.actor.user.id);
  expect((await links(root)).items[0]).toMatchObject({ totalDevices: 2, activeDevices: 1 });
  const audits = (
    await f.db.query(
      "SELECT actor_id FROM security_audit WHERE action='browser.access_device_revoked'",
    )
  ).rows;
  expect(audits).toEqual([{ actor_id: otherRoot.actor.user.id }]);
});
it('revokes a link and all its existing permits, including bootstrap and video gateway requests', async () => {
  const root = await f.active('superadmin'),
    l = await create(root, false),
    a = await page(l.url),
    b = await page(l.url);
  await redeem(a);
  await redeem(b);
  await post(root, `${base}/${l.id}/revoke`, {});
  await post(root, `${base}/${l.id}/revoke`, {});
  for (const p of [a, b]) {
    const boot = await f.app.inject({
      url: '/api/v1/security/browser/bootstrap',
      headers: p.headers,
    });
    expect(boot.json().data.decision.allowed).toBe(false);
    for (const url of ['/api/v1/auth/session', '/api/v1/video/rtc/validate?access_token=invalid'])
      expect((await f.app.inject({ url, headers: p.headers })).statusCode).toBe(403);
  }
  await page(l.url, a.headers, 410);
  expect((await links(root)).items[0]).toMatchObject({
    totalDevices: 2,
    activeDevices: 0,
    status: 'revoked',
    revokedBy: { id: root.actor.user.id },
  });
});
it('expires grants independently of the link redemption deadline and keeps permits through policy changes', async () => {
  const root = await f.active('superadmin'),
    l = await create(root, false, { expiresAt: new Date(Date.now() + 60000).toISOString() }),
    p = await page(l.url);
  await redeem(p);
  await f.db.query('UPDATE browser_access_links SET expires_at=$2 WHERE id=$1', [
    l.id,
    new Date(Date.now() - 1),
  ]);
  await page(l.url, { 'user-agent': old }, 410);
  await f.db.exec('UPDATE browser_policy SET enhanced_enabled=true,revision=revision+1');
  expect((await f.app.inject({ url: '/api/v1/auth/session', headers: p.headers })).statusCode).toBe(
    200,
  );
  await verified(root);
  expect((await links(root)).items[0]).toMatchObject({ status: 'expired', activeDevices: 1 });
  await f.db.exec("UPDATE browser_access_devices SET expires_at=now()-interval '1 second'");
  expect((await f.app.inject({ url: '/api/v1/auth/session', headers: p.headers })).statusCode).toBe(
    403,
  );
  expect((await links(root)).items[0]?.activeDevices).toBe(0);
});
it('lets a manually permitted superadmin configure strict policy and pages link/device lists without omissions', async () => {
  const root = await f.active('superadmin'),
    l = await create(root, false),
    p = await page(l.url, { ...root.headers, 'user-agent': old });
  await redeem(p);
  const manual = { ...root, headers: p.headers };
  const result = await post(manual, '/api/v1/admin/browser-policy', {
    ...DEFAULT_BROWSER_POLICY,
    enhancedEnabled: true,
  });
  expect(result.json().data.enhancedEnabled).toBe(true);
  await create(manual, false, { label: 'Вторая' });
  await create(manual, false, { label: 'Третья' });
  const first = await f.app.inject({ url: base + '?limit=2', headers: p.headers });
  const cursor = first.json().data.nextCursor;
  const second = await f.app.inject({
    url:
      base +
      '?limit=2&' +
      new URLSearchParams({ beforeCreatedAt: cursor.createdAt, beforeId: cursor.id }),
    headers: p.headers,
  });
  const ids = [...first.json().data.items, ...second.json().data.items].map((x) => x.id);
  expect(new Set(ids).size).toBe(3);
  const bad = await f.app.inject({ url: base + '?beforeId=' + randomUUID(), headers: p.headers });
  expect(bad.statusCode).toBe(400);
});
