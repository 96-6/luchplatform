import { z } from 'zod';

export const browserIds = [
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'safari',
  'opera',
  'brave',
  'vivaldi',
  'vanadium',
  'samsung',
  'duckduckgo',
  'yandex',
  'ie',
  'edge_legacy',
  'opera_mini',
  'uc',
  'puffin',
  'qq',
  'webview',
  'unknown',
] as const;
export const browserIdSchema = z.enum(browserIds);
export const browserNames: Record<(typeof browserIds)[number], string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  safari: 'Safari',
  opera: 'Opera / Opera GX',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  vanadium: 'Vanadium',
  samsung: 'Samsung Internet',
  duckduckgo: 'DuckDuckGo',
  yandex: 'Yandex Browser',
  ie: 'Internet Explorer',
  edge_legacy: 'Microsoft Edge Legacy',
  opera_mini: 'Opera Mini',
  uc: 'UC Browser',
  puffin: 'Puffin',
  qq: 'QQ Browser',
  webview: 'WebView',
  unknown: 'Other / unknown',
};
const list = z
  .array(browserIdSchema)
  .max(browserIds.length)
  .refine((values) => new Set(values).size === values.length, 'Браузеры не должны повторяться.');
export const browserPolicySchema = z
  .strictObject({
    outdatedEnabled: z.boolean(),
    enhancedEnabled: z.boolean(),
    blockedBrowsers: list,
    allowedBrowsers: list,
    minimumVersions: z.strictObject({
      chromium: z.number().int().min(1).max(999),
      firefox: z.number().int().min(1).max(999),
      webkit: z.number().int().min(1).max(999),
    }),
    revision: z.number().int().positive(),
  })
  .refine(
    (p) => !p.allowedBrowsers.includes('yandex') && !p.allowedBrowsers.includes('unknown'),
    'Яндекс Браузер и неизвестные браузеры нельзя разрешить в усиленном режиме.',
  )
  .refine(
    (p) => !p.enhancedEnabled || p.allowedBrowsers.length > 0,
    'Выберите хотя бы один разрешённый браузер.',
  );
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;
export const DEFAULT_BROWSER_POLICY: BrowserPolicy = {
  outdatedEnabled: true,
  enhancedEnabled: false,
  blockedBrowsers: ['ie', 'edge_legacy', 'opera_mini', 'uc', 'puffin', 'qq', 'webview'],
  allowedBrowsers: [
    'chrome',
    'chromium',
    'edge',
    'firefox',
    'safari',
    'opera',
    'brave',
    'vivaldi',
    'vanadium',
    'samsung',
    'duckduckgo',
  ],
  minimumVersions: { chromium: 154, firefox: 153, webkit: 26 },
  revision: 1,
};
export const browserHintsSchema = z.strictObject({
  brands: z
    .array(z.strictObject({ brand: z.string().max(100), version: z.string().max(40) }))
    .max(12),
  platform: z.string().max(80),
  mobile: z.boolean(),
});
export const browserSnapshotSchema = z.strictObject({
  userAgent: z.string().max(1024),
  platform: z.string().max(80),
  hints: browserHintsSchema.nullable(),
});
export const browserFeaturesSchema = z.strictObject({
  fetch: z.boolean(),
  abortController: z.boolean(),
  websocket: z.boolean(),
  crypto: z.boolean(),
  textEncoder: z.boolean(),
  worker: z.boolean(),
});
export const browserEvidenceSchema = z.strictObject({
  challengeId: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  page: browserSnapshotSchema,
  worker: browserSnapshotSchema.nullable(),
  features: browserFeaturesSchema,
});
export const browserDecisionSchema = z.object({
  allowed: z.boolean(),
  warning: z.boolean(),
  family: browserIdSchema,
  reason: z.enum([
    'disabled',
    'allowed',
    'blocked',
    'outdated',
    'not_allowed',
    'inconsistent',
    'capabilities',
  ]),
  message: z.string().nullable(),
  policyRevision: z.number().int().positive(),
});
export const browserBootstrapSchema = z.object({
  enabled: z.boolean(),
  policyRevision: z.number().int().positive(),
  challenge: z.object({ id: z.uuid(), nonce: z.string(), expiresAt: z.iso.datetime() }).nullable(),
  decision: browserDecisionSchema.nullable(),
  noticeToken: z.string(),
});
export const browserAssessmentSchema = z.object({
  decision: browserDecisionSchema,
  noticeToken: z.string(),
});
export const browserNoticeSchema = z.object({ show: z.boolean(), message: z.string().nullable() });
export const BROWSER_WARNING_MESSAGE = 'Ваш браузер может быть несовместим с платформой';
export const BROWSER_DENIED_MESSAGE = 'Ваш браузер несовместим с платформой';
