import { z } from 'zod';
import { PAGE_ERROR_STYLES } from './navigation.js';
import { translate, type Locale } from './localization.js';

export const clientProtectionRoles = ['student', 'teacher', 'admin'] as const;
const roles = z
  .array(z.enum(clientProtectionRoles))
  .max(3)
  .refine((value) => new Set(value).size === value.length, 'Роли не должны повторяться.');
export const clientProtectionPolicySchema = z.strictObject({
  interactionEnabled: z.boolean(),
  interactionRoles: roles,
  blockersEnabled: z.boolean(),
  blockersRoles: roles,
  revision: z.number().int().positive(),
});
export type ClientProtectionPolicy = z.infer<typeof clientProtectionPolicySchema>;
export const DEFAULT_CLIENT_PROTECTION_POLICY: ClientProtectionPolicy = {
  interactionEnabled: false,
  interactionRoles: ['student', 'teacher'],
  blockersEnabled: false,
  blockersRoles: ['student', 'teacher'],
  revision: 1,
};
export const clientProtectionStateSchema = z.object({
  interactionRestricted: z.boolean(),
  blockersRequired: z.boolean(),
  verified: z.boolean(),
  revision: z.number().int().positive(),
  challenge: z.object({ id: z.uuid(), nonce: z.string().length(43) }).nullable(),
});
export type ClientProtectionState = z.infer<typeof clientProtectionStateSchema>;
export const clientProtectionEvidenceSchema = z.strictObject({
  id: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  proof: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  visible: z.boolean(),
});
export const CLIENT_PROTECTION_MESSAGE =
  'Браузер блокирует необходимые функции сайта. Разрешите JavaScript, cookies и ресурсы платформы, затем повторите проверку.';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function clientProtectionDocument(requestId: string, locale: Locale = 'ru') {
  const t = (s: string) => escape(translate(s, locale));
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>403 · ${t('Доступ запрещён')}</title><style>${PAGE_ERROR_STYLES}</style><script type="module" src="/api/v1/security/client/runtime.js"></script></head><body data-client-check><main><a class="brand" href="/">${locale === 'en' ? 'LUCH' : 'ЛУЧ'}</a><section class="card"><span class="status">403</span><h1>${t('Доступ запрещён')}</h1><p>${t(CLIENT_PROTECTION_MESSAGE)}</p><p id="client-check-status" role="status" aria-live="polite"></p><div class="actions"><button type="button" class="button" id="client-check-retry">${t('Повторить проверку')}</button><a href="/login" class="button secondary">${t('Сменить аккаунт')}</a></div><p class="request">${t('Код обращения:')} ${escape(requestId)}</p></section></main></body></html>`;
}
