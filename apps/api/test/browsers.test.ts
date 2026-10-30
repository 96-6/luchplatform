import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BROWSER_POLICY,
  browserPolicySchema,
  browserAssessmentSchema,
  BROWSER_DENIED_MESSAGE,
  BROWSER_WARNING_MESSAGE,
} from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
import { browserSignals, evaluateBrowser } from '../src/modules/security/browsers-detection.js';

const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const yandex = chrome + ' YaBrowser/26.10.0.0 Yowser/2.5';
const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
const features = {
  fetch: true,
  abortController: true,
  websocket: true,
  crypto: true,
  textEncoder: true,
  worker: true,
};
const snapshot = (ua = chrome) => ({ userAgent: ua, platform: 'Win32', hints: null });
let f: Awaited<ReturnType<typeof learningFixture>>;
beforeAll(async () => {
  f = await learningFixture();
});
beforeEach(async () => {
  await f.reset();
  await f.db.exec(
    'TRUNCATE browser_challenges,browser_assessments; INSERT INTO browser_policy(id) VALUES(1) ON CONFLICT DO NOTHING;',
  );
});
afterAll(async () => {
  await f.app.close();
});
type Headers = Record<string, string>;
async function challenge(user?: Login, ua = chrome, extra: Headers = {}) {
  const headers: Headers = { ...(user?.headers ?? {}), 'user-agent': ua, ...extra };
  const r = await f.app.inject({ url: '/api/v1/security/browser/bootstrap?force=true', headers });
  expect(r.statusCode, r.body).toBe(200);
  const c = r.cookies.find((v) => v.name === 'luch_browser');
  if (c) headers.cookie = [headers.cookie, `${c.name}=${c.value}`].filter(Boolean).join('; ');
  return { headers, boot: r.json().data };
}
async function verify(
  user?: Login,
  ua = chrome,
  pageUA = ua,
  workerUA: string | null = ua,
  extra: Headers = {},
  missing = false,
) {
  const c = await challenge(user, ua, extra);
  expect(c.boot.challenge).not.toBeNull();
  const body = {
    challengeId: c.boot.challenge.id,
    nonce: c.boot.challenge.nonce,
    page: snapshot(pageUA),
    worker: workerUA ? snapshot(workerUA) : null,
    features: { ...features, ...(missing ? { websocket: false } : {}) },
  };
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/security/browser/assess',
    headers: c.headers,
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(200);
  const assessment = browserAssessmentSchema.parse(r.json().data);
  return { ...c, body, assessment };
}
async function policy(headers: Headers, fields: Record<string, unknown>) {
  const current = await f.app.inject({ url: '/api/v1/admin/browser-policy', headers });
  expect(current.statusCode, current.body).toBe(200);
  return f.app.inject({
    method: 'POST',
    url: '/api/v1/admin/browser-policy',
    headers,
    payload: { ...current.json().data, ...fields },
  });
}
async function get(headers: Headers, path = '/api/v1/auth/session') {
  return f.app.inject({ url: path, headers });
}
describe('browser policy admission', () => {
  it('starts with persisted basic protection enabled, strict protection disabled and editable defaults', async () => {
    const root = await f.active('superadmin'),
      verified = await verify(root);
    const r = await get(verified.headers, '/api/v1/admin/browser-policy');
    expect(browserPolicySchema.parse(r.json().data)).toEqual(DEFAULT_BROWSER_POLICY);
    expect(
      (await f.db.query('SELECT outdated_enabled,enhanced_enabled FROM browser_policy')).rows,
    ).toEqual([{ outdated_enabled: true, enhanced_enabled: false }]);
    expect(verified.assessment.decision.allowed).toBe(true);
  });
  it.each(['student', 'teacher', 'admin'] as const)(
    'denies policy reads and writes to %s',
    async (role) => {
      const user = await f.active(role);
      expect((await get(user.headers, '/api/v1/admin/browser-policy')).statusCode).toBe(403);
      const r = await f.app.inject({
        method: 'POST',
        url: '/api/v1/admin/browser-policy',
        headers: user.headers,
        payload: DEFAULT_BROWSER_POLICY,
      });
      expect(r.statusCode).toBe(403);
    },
  );
  it('requires CSRF, prevents self-lockout, saves lists and versions atomically, rejects stale revisions and audits the actor', async () => {
    const root = await f.active('superadmin'),
      v = await verify(root);
    const noCsrf = { ...v.headers };
    delete noCsrf['x-csrf-token'];
    expect((await policy(noCsrf, { enhancedEnabled: true })).statusCode).toBe(403);
    expect((await policy(v.headers, { blockedBrowsers: ['chrome'] })).statusCode).toBe(409);
    expect(
      (await policy(v.headers, { minimumVersions: { chromium: 157, firefox: 153, webkit: 26 } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await policy(v.headers, { enhancedEnabled: true, allowedBrowsers: ['chrome', 'yandex'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await policy(v.headers, { enhancedEnabled: true, allowedBrowsers: [] })).statusCode,
    ).toBe(400);
    expect((await policy(v.headers, { allowedBrowsers: ['chrome', 'chrome'] })).statusCode).toBe(
      400,
    );
    const saved = await policy(v.headers, {
      enhancedEnabled: true,
      allowedBrowsers: ['chrome', 'opera', 'chromium', 'vanadium'],
      minimumVersions: { chromium: 155, firefox: 153, webkit: 26 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({
      enhancedEnabled: true,
      revision: 2,
      minimumVersions: { chromium: 155 },
    });
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/browser-policy',
      headers: v.headers,
      payload: DEFAULT_BROWSER_POLICY,
    });
    expect(stale.statusCode).toBe(409);
    expect((await f.db.query('SELECT updated_by FROM browser_policy')).rows[0]!.updated_by).toBe(
      root.actor.user.id,
    );
    expect(
      (
        await f.db.query(
          "SELECT actor_id FROM security_audit WHERE action='browser.policy_changed'",
        )
      ).rows,
    ).toEqual([{ actor_id: root.actor.user.id }]);
  });
  it('honors an explicit basic-mode block of unknown clients, including ordinary HTTP tooling', async () => {
    const root = await f.active('superadmin'),
      v = await verify(root);
    expect((await get({ 'user-agent': 'node' }, '/api/v1/system')).statusCode).toBe(200);
    const saved = await policy(v.headers, { blockedBrowsers: ['unknown'] });
    expect(saved.statusCode, saved.body).toBe(200);
    for (const headers of [
      { 'user-agent': 'node' },
      { 'user-agent': 'UnknownBrowser/1.0', 'sec-fetch-mode': 'cors' },
    ]) {
      const denied = await get(headers, '/api/v1/system');
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.message).toBe(BROWSER_DENIED_MESSAGE);
    }
    expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(200);
  });
  it('enforces verification before browser authentication, data APIs and signalling, and does not trust approval headers', async () => {
    expect(
      (await get({ 'user-agent': 'node', 'sec-fetch-mode': 'cors' }, '/api/v1/system')).statusCode,
    ).toBe(428);
    for (const path of [
      '/api/v1/auth/session',
      '/api/v1/system',
      '/learning-media/private.txt',
      '/api/v1/video/rtc/validate?access_token=x',
    ]) {
      const r = await get({ 'user-agent': chrome, 'x-browser-approved': 'true' }, path);
      expect(r.statusCode, r.body).toBe(428);
      expect(r.json().error.code).toBe('BROWSER_CHECK_REQUIRED');
    }
    const v = await verify();
    expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(200);
  });
  it.each([
    'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)',
    chrome.replace('156.0.0.0', '100.0.0.0'),
    chrome + ' Edge/18.19041',
    chrome + ' Opera Mini/80.0',
    chrome + ' UCBrowser/15.0',
    chrome + ' Puffin/12.0',
    chrome + ' MQQBrowser/14.0',
    chrome.replace('KHTML, like Gecko)', 'KHTML, like Gecko; wv)'),
  ])('rejects an outdated or blocked browser on every protected request (%s)', async (ua) => {
    const r = await get({ 'user-agent': ua }, '/api/v1/system');
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe(BROWSER_DENIED_MESSAGE);
  });
  it('uses the configurable Yandex engine minimum without relaxing Chrome or allowing older Yandex releases', async () => {
    const released = yandex.replace('156.0.0.0', '152.0.7977.1860');
    const v = await verify(undefined, released, released, released, {
      'sec-ch-ua': '"Chromium";v="152", "Yandex Browser";v="26"',
    });
    expect(v.assessment.decision).toMatchObject({ allowed: true, warning: true });
    expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(200);
    for (const ua of [chrome.replace('156.0.0.0', '152.0.0.0'), released.replace('152.', '151.')])
      expect((await get({ 'user-agent': ua }, '/api/v1/system')).statusCode).toBe(403);
    expect(
      (
        await get(
          {
            'user-agent': chrome.replace('156.0.0.0', '152.0.0.0'),
            'sec-ch-ua': '"Chromium";v="152", "Yandex Browser";v="26"',
          },
          '/api/v1/system',
        )
      ).statusCode,
    ).toBe(403);
    const root = await f.active('superadmin'),
      admin = await verify(root);
    expect(
      (
        await policy(admin.headers, {
          minimumVersions: { ...DEFAULT_BROWSER_POLICY.minimumVersions, yandex: 153 },
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(403);
  });
  it('prevents a Yandex administrator from raising its own engine minimum above the current browser', async () => {
    const root = await f.active('superadmin'),
      ua = yandex.replace('156.0.0.0', '152.0.7977.1860'),
      v = await verify(root, ua);
    const saved = await policy(v.headers, {
      minimumVersions: { ...DEFAULT_BROWSER_POLICY.minimumVersions, yandex: 153 },
    });
    expect(saved.statusCode).toBe(409);
    expect(saved.json().error.code).toBe('SELF_LOCKOUT');
  });
  it('allows an up-to-date Yandex Browser and remembers the first-login notice per account', async () => {
    const user = await f.active(),
      v = await verify(user, yandex);
    expect(v.assessment.decision).toMatchObject({ allowed: true, warning: true, family: 'yandex' });
    expect((await get(v.headers)).json().data.user.id).toBe(user.actor.user.id);
    const notice = await get(v.headers, '/api/v1/security/browser/notice');
    expect(notice.json().data).toEqual({ show: true, message: BROWSER_WARNING_MESSAGE });
    const ack = await f.app.inject({
      method: 'POST',
      url: '/api/v1/security/browser/notice',
      headers: v.headers,
      payload: { token: v.assessment.noticeToken },
    });
    expect(ack.statusCode, ack.body).toBe(200);
    const fresh = await verify(user, yandex);
    expect((await get(fresh.headers, '/api/v1/security/browser/notice')).json().data.show).toBe(
      false,
    );
    const peer = await f.active(),
      other = await verify(peer, yandex);
    expect((await get(other.headers, '/api/v1/security/browser/notice')).json().data.show).toBe(
      true,
    );
  });
  it('remembers a guest notice and rejects a forged acknowledgement', async () => {
    const v = await verify(undefined, yandex);
    expect((await get(v.headers, '/api/v1/security/browser/notice')).json().data.show).toBe(true);
    for (const token of ['0'.repeat(64), v.assessment.noticeToken]) {
      const r = await f.app.inject({
        method: 'POST',
        url: '/api/v1/security/browser/notice',
        headers: v.headers,
        payload: { token },
      });
      expect(r.statusCode).toBe(token.startsWith('0000') ? 403 : 200);
    }
    expect((await get(v.headers, '/api/v1/security/browser/notice')).json().data.show).toBe(false);
  });
  it('strictly refuses Yandex, unknown clients and unverified browsers even when basic protection is off', async () => {
    const root = await f.active('superadmin'),
      v = await verify(root);
    expect(
      (await policy(v.headers, { outdatedEnabled: false, enhancedEnabled: true })).statusCode,
    ).toBe(200);
    for (const ua of [yandex, 'Some unknown browser', 'node']) {
      const r = await get({ 'user-agent': ua }, '/api/v1/system');
      expect(r.statusCode).toBe(403);
      expect(r.json().error.message).toBe(BROWSER_DENIED_MESSAGE);
    }
    const forged = await get(
      { 'user-agent': chrome, 'sec-ch-ua': '"Chromium";v="156", "Yandex Browser";v="26"' },
      '/api/v1/system',
    );
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.message).toBe(BROWSER_DENIED_MESSAGE);
    expect((await get({ 'user-agent': chrome }, '/api/v1/system')).statusCode).toBe(428);
  });
  it.each(['page', 'worker', 'headers'] as const)(
    'detects inconsistent User-Agent changes in %s',
    async (where) => {
      const v = await verify(
        undefined,
        where === 'headers' ? firefox : chrome,
        where === 'page' ? firefox : chrome,
        where === 'worker' ? firefox : chrome,
      );
      expect(v.assessment.decision).toMatchObject({ allowed: false, reason: 'inconsistent' });
      expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(403);
    },
  );
  it('rejects missing workers, missing capabilities and forged extra evidence', async () => {
    expect((await verify(undefined, chrome, chrome, null)).assessment.decision.allowed).toBe(false);
    expect(
      (await verify(undefined, chrome, chrome, chrome, {}, true)).assessment.decision.allowed,
    ).toBe(false);
    const c = await challenge();
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/security/browser/assess',
      headers: c.headers,
      payload: {
        challengeId: c.boot.challenge.id,
        nonce: c.boot.challenge.nonce,
        page: snapshot(),
        worker: snapshot(),
        features,
        approved: true,
      },
    });
    expect(r.statusCode).toBe(400);
  });
  it('consumes a challenge once and binds it to its browser cookie, headers, expiry and policy revision', async () => {
    const v = await verify();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/security/browser/assess',
          headers: v.headers,
          payload: v.body,
        })
      ).statusCode,
    ).toBe(403);
    const c = await challenge(),
      other = await challenge();
    const body = {
      challengeId: c.boot.challenge.id,
      nonce: c.boot.challenge.nonce,
      page: snapshot(),
      worker: snapshot(),
      features,
    };
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/security/browser/assess',
          headers: other.headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const different = { ...c.headers, 'user-agent': chrome.replace('156.', '155.') };
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/security/browser/assess',
          headers: different,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    await f.db.query(
      "UPDATE browser_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
      [c.boot.challenge.id],
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/security/browser/assess',
          headers: c.headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await get({ ...v.headers, 'user-agent': chrome.replace('156.', '155.') }, '/api/v1/system'))
        .statusCode,
    ).toBe(428);
    await f.db.exec("UPDATE browser_assessments SET verified_until=now()-interval '1 second'");
    expect((await get(v.headers, '/api/v1/system')).statusCode).toBe(428);
  });
  it('invalidates other browser checks and unconsumed challenges immediately after a policy change', async () => {
    const root = await f.active('superadmin'),
      v = await verify(root),
      user = await verify();
    const c = await challenge();
    expect((await policy(v.headers, { enhancedEnabled: true })).statusCode).toBe(200);
    expect((await get(user.headers, '/api/v1/system')).statusCode).toBe(428);
    const old = await f.app.inject({
      method: 'POST',
      url: '/api/v1/security/browser/assess',
      headers: c.headers,
      payload: {
        challengeId: c.boot.challenge.id,
        nonce: c.boot.challenge.nonce,
        page: snapshot(),
        worker: snapshot(),
        features,
      },
    });
    expect(old.statusCode).toBe(403);
    expect((await verify()).assessment.decision.allowed).toBe(true);
  });
  it('disables both controls explicitly without resetting their saved lists', async () => {
    const root = await f.active('superadmin'),
      v = await verify(root);
    expect(
      (await policy(v.headers, { outdatedEnabled: false, enhancedEnabled: false })).statusCode,
    ).toBe(200);
    expect((await get({ 'user-agent': 'MSIE 6.0' }, '/api/v1/system')).statusCode).toBe(200);
    const r = await get(v.headers, '/api/v1/admin/browser-policy');
    expect(r.json().data.blockedBrowsers).toEqual(DEFAULT_BROWSER_POLICY.blockedBrowsers);
  });
});
describe('browser engine and brand compatibility', () => {
  it.each([
    [chrome, 'chrome'],
    [chrome + ' OPR/132.0', 'opera'],
    [chrome + ' Edg/156.0', 'edge'],
    [chrome + ' Vanadium/156.0', 'vanadium'],
    [chrome + ' Brave/1.0', 'brave'],
    [chrome + ' Vivaldi/9.0', 'vivaldi'],
    [firefox, 'firefox'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15',
      'safari',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 CriOS/156.0 Mobile/15E148 Safari/604.1',
      'chrome',
    ],
  ])('admits a compatible popular browser %s', (ua, family) => {
    const signals = browserSignals({ 'user-agent': ua }, snapshot(ua), snapshot(ua), features);
    expect(
      evaluateBrowser({ ...DEFAULT_BROWSER_POLICY, enhancedEnabled: true }, signals, true),
    ).toMatchObject({ allowed: true, family });
  });
  it('ignores GREASE brands and does not compare Opera product versions with Chromium engine versions', () => {
    const ua = chrome + ' OPR/132.0';
    const hints = {
      brands: [
        { brand: 'Chromium', version: '156' },
        { brand: 'Opera', version: '132' },
        { brand: 'Not A;Brand', version: '99' },
      ],
      platform: 'Windows',
      mobile: false,
    };
    const snap = { ...snapshot(ua), hints };
    const signals = browserSignals(
      {
        'user-agent': ua,
        'sec-ch-ua': '"Chromium";v="156", "Opera";v="132", "Not A;Brand";v="99"',
      },
      snap,
      snap,
      features,
    );
    expect(
      evaluateBrowser({ ...DEFAULT_BROWSER_POLICY, enhancedEnabled: true }, signals, true),
    ).toMatchObject({ allowed: true, family: 'opera' });
  });
  it('accepts unbranded Chromium using its hints and retains the verified fork when later requests omit hints', async () => {
    const hints = {
      brands: [{ brand: 'Chromium', version: '156' }],
      platform: 'Windows',
      mobile: false,
    };
    const snap = { ...snapshot(), hints };
    const signals = browserSignals({ 'user-agent': chrome }, snap, snap, features);
    expect(
      evaluateBrowser(
        { ...DEFAULT_BROWSER_POLICY, enhancedEnabled: true, allowedBrowsers: ['chromium'] },
        signals,
        true,
      ),
    ).toMatchObject({ allowed: true, family: 'chromium' });
  });
});
