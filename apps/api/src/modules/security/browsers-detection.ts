import {
  BROWSER_DENIED_MESSAGE,
  type BrowserPolicy,
  type browserSnapshotSchema,
  type browserFeaturesSchema,
  type browserDecisionSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';

type Id = BrowserPolicy['blockedBrowsers'][number];
export type Identity = {
  source: 'ua' | 'hint';
  family: Id;
  engine: 'chromium' | 'firefox' | 'webkit' | 'unknown';
  major: number | null;
  platform: string;
};
export type BrowserSignals = {
  identities: Identity[];
  features: z.infer<typeof browserFeaturesSchema> | null;
  worker: boolean;
  inconsistent: boolean;
};
const major = (value: string | undefined) =>
  value && /^\d/.test(value) ? Number.parseInt(value, 10) : null;
function platform(value: string) {
  if (/android/i.test(value)) return 'android';
  if (/iphone|ipad|ipod|ios/i.test(value)) return 'ios';
  if (/win/i.test(value)) return 'windows';
  if (/mac/i.test(value)) return 'macos';
  if (/linux|cros/i.test(value)) return 'linux';
  return 'unknown';
}
const matchers: [Id, RegExp][] = [
  ['yandex', /(?:YaBrowser|Yowser|YandexBrowser)[\/\s]/i],
  ['ie', /MSIE\s|Trident\//i],
  ['edge_legacy', /Edge\//],
  ['opera_mini', /Opera Mini|Opera Mobi/i],
  ['uc', /UCBrowser|UCWEB/i],
  ['puffin', /Puffin/i],
  ['qq', /QQBrowser/i],
  ['webview', /; wv\)|FBAN\/|FBAV\/|Instagram|MicroMessenger/i],
  ['edge', /Edg(?:e|A|iOS)?\//i],
  ['opera', /OPR\/|OPiOS\//i],
  ['brave', /Brave\//i],
  ['vivaldi', /Vivaldi\//i],
  ['vanadium', /Vanadium\//i],
  ['samsung', /SamsungBrowser\//i],
  ['duckduckgo', /DuckDuckGo\//i],
  ['firefox', /Firefox\/|FxiOS\//i],
  ['chromium', /Chromium\//i],
  ['chrome', /Chrome\/|CriOS\//i],
  ['safari', /Version\/.*Safari\//i],
];
export function userAgentIdentity(ua: string): Identity {
  const family = matchers.find(([, re]) => re.test(ua))?.[0] ?? 'unknown';
  const chrome = /(?:Chrome|Chromium|CriOS)\/(\d+)/i.exec(ua)?.[1];
  const firefox = /(?:Firefox|FxiOS)\/(\d+)/i.exec(ua)?.[1];
  const ios = /(?:iPhone|iPad|iPod).*OS (\d+)/i.exec(ua)?.[1];
  const safari = /Version\/(\d+)/i.exec(ua)?.[1];
  return {
    source: 'ua',
    family,
    platform: platform(ua),
    engine: ios
      ? 'webkit'
      : chrome
        ? 'chromium'
        : firefox
          ? 'firefox'
          : safari
            ? 'webkit'
            : 'unknown',
    major: major(ios ?? chrome ?? firefox ?? safari),
  };
}
function brandId(brand: string): Id | null {
  const s = brand.toLowerCase().replace(/[^a-z]/g, '');
  const ids: Record<string, Id> = {
    chromium: 'chromium',
    googlechrome: 'chrome',
    headlesschrome: 'chrome',
    microsoftedge: 'edge',
    opera: 'opera',
    operagx: 'opera',
    brave: 'brave',
    vivaldi: 'vivaldi',
    vanadium: 'vanadium',
    samsunginternet: 'samsung',
    yandex: 'yandex',
    yandexbrowser: 'yandex',
    yabrowser: 'yandex',
    duckduckgo: 'duckduckgo',
    firefox: 'firefox',
  };
  return ids[s] ?? null;
}
function hintIdentities(hints: z.infer<typeof browserSnapshotSchema>['hints']): Identity[] {
  if (!hints) return [];
  return hints.brands.flatMap((b) => {
    const family = brandId(b.brand);
    return family
      ? [
          {
            source: 'hint',
            family,
            engine: family === 'firefox' ? ('firefox' as const) : ('chromium' as const),
            major: ['chrome', 'chromium', 'firefox'].includes(family) ? major(b.version) : null,
            platform: platform(hints.platform),
          },
        ]
      : [];
  });
}
function headerBrands(raw: string | string[] | undefined) {
  if (typeof raw !== 'string' || raw.length > 4096) return [];
  return Array.from(raw.matchAll(/("(?:[^"\\]|\\.)*")\s*;\s*v="([0-9.]+)"/g))
    .flatMap((m) => {
      try {
        return [{ brand: JSON.parse(m[1]!) as string, version: m[2]! }];
      } catch {
        return [];
      }
    })
    .slice(0, 12);
}
export function headerIdentities(headers: IncomingHttpHeaders): Identity[] {
  return [
    userAgentIdentity(String(headers['user-agent'] ?? '').slice(0, 1024)),
    ...hintIdentities({
      brands: headerBrands(headers['sec-ch-ua-full-version-list'] ?? headers['sec-ch-ua']),
      platform: String(headers['sec-ch-ua-platform'] ?? ''),
      mobile: headers['sec-ch-ua-mobile'] === '?1',
    }),
  ];
}
export function browserSignals(
  headers: IncomingHttpHeaders,
  page?: z.infer<typeof browserSnapshotSchema>,
  worker?: z.infer<typeof browserSnapshotSchema> | null,
  features?: z.infer<typeof browserFeaturesSchema>,
): BrowserSignals {
  const identities = headerIdentities(headers);
  for (const snapshot of [page, worker])
    if (snapshot) {
      identities.push(userAgentIdentity(snapshot.userAgent), ...hintIdentities(snapshot.hints));
    }
  const engines = new Set(identities.filter((x) => x.engine !== 'unknown').map((x) => x.engine));
  const platforms = new Set(
    identities.filter((x) => x.platform !== 'unknown').map((x) => x.platform),
  );
  // Generic Chromium/Chrome claims coexist with branded forks; two different branded forks do not.
  const branded = new Set(
    identities
      .filter((x) => !['unknown', 'chrome', 'chromium', 'safari'].includes(x.family))
      .map((x) => x.family),
  );
  const versions = new Set(
    identities
      .filter((x) => x.engine !== 'unknown' && x.major !== null)
      .map((x) => `${x.engine}:${x.major}`),
  );
  const agents = [String(headers['user-agent'] ?? ''), page?.userAgent, worker?.userAgent].filter(
    (v): v is string => Boolean(v),
  );
  const differentAgents = agents.some((ua) => ua !== agents[0]);
  return {
    identities,
    features: features ?? null,
    worker: Boolean(worker),
    inconsistent:
      engines.size > 1 ||
      platforms.size > 1 ||
      branded.size > 1 ||
      versions.size > 1 ||
      differentAgents,
  };
}
export function evaluateBrowser(
  policy: BrowserPolicy,
  signals: BrowserSignals,
  complete: boolean,
): z.infer<typeof browserDecisionSchema> {
  const known = signals.identities.filter((x) => x.family !== 'unknown');
  const identity =
    known.find((x) => x.family === 'yandex') ??
    known.find((x) => !['chrome', 'chromium', 'safari'].includes(x.family)) ??
    known.find((x) => x.source === 'hint' && x.family === 'chrome') ??
    known.find((x) => x.source === 'hint' && x.family === 'chromium') ??
    known[0];
  const family = identity?.family ?? 'unknown';
  const result = (reason: z.infer<typeof browserDecisionSchema>['reason'], allowed = false) => ({
    allowed,
    family,
    reason,
    warning: allowed && policy.outdatedEnabled && family === 'yandex',
    message: allowed
      ? null
      : reason === 'inconsistent'
        ? 'Данные браузера противоречат друг другу. Отключите подмену User-Agent и повторите проверку.'
        : reason === 'capabilities'
          ? 'Не удалось подтвердить необходимые возможности браузера. Обновите браузер и проверьте настройки расширений.'
          : BROWSER_DENIED_MESSAGE,
    policyRevision: policy.revision,
  });
  if (!policy.outdatedEnabled && !policy.enhancedEnabled) return result('disabled', true);
  if (policy.enhancedEnabled && known.some((x) => x.family === 'yandex')) return result('blocked');
  if (
    policy.outdatedEnabled &&
    (known.some((x) => policy.blockedBrowsers.includes(x.family)) ||
      (family === 'unknown' && policy.blockedBrowsers.includes('unknown')))
  )
    return result('blocked');
  if (signals.inconsistent) return result('inconsistent');
  if (
    signals.identities.some(
      (x) =>
        x.engine !== 'unknown' && x.major !== null && x.major < policy.minimumVersions[x.engine],
    )
  )
    return result('outdated');
  if (
    complete &&
    (!signals.worker || !signals.features || !Object.values(signals.features).every(Boolean))
  )
    return result('capabilities');
  if (
    complete &&
    family !== 'unknown' &&
    !signals.identities.some((x) => x.engine !== 'unknown' && x.major !== null)
  )
    return result('capabilities');
  if (
    policy.enhancedEnabled &&
    !policy.allowedBrowsers.includes(family) &&
    !(
      !complete &&
      ['chrome', 'chromium'].includes(family) &&
      policy.allowedBrowsers.some((id) =>
        [
          'chrome',
          'chromium',
          'edge',
          'opera',
          'brave',
          'vivaldi',
          'vanadium',
          'samsung',
          'duckduckgo',
        ].includes(id),
      )
    )
  )
    return result('not_allowed');
  return result('allowed', true);
}
