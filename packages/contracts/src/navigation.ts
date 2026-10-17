import { translate, translateMessage, type Locale } from './localization.js';
import { z } from 'zod';

export const navigationQuerySchema = z.strictObject({ path: z.string().min(1).max(2048) });
export const navigationAccessSchema = z.object({ path: z.string() });
export function pageStatusTitle(status: number, locale: Locale = 'ru') {
  return translate(
    (
      {
        400: 'Некорректная ссылка',
        401: 'Требуется вход',
        403: 'Доступ запрещён',
        404: 'Страница не найдена',
        410: 'Ссылка больше недоступна',
        503: 'Сервис временно недоступен',
      } as Record<number, string>
    )[status] ?? 'Не удалось открыть страницу',
    locale,
  );
}
export const PAGE_ERROR_STYLES = `:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#213a36;background:#f4f6f3;line-height:1.6;color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,680px)}.brand{display:flex;align-items:center;gap:12px;font-weight:750;font-size:22px;text-decoration:none;margin-bottom:28px;color:#184e45}.brand svg{background:#184e45;color:white;border-radius:12px;padding:9px}.card{background:white;border:1px solid #dce6df;border-radius:20px;padding:clamp(24px,5vw,48px);box-shadow:0 16px 50px #213a360a}.status{display:inline-block;background:#fff3cf;border:1px solid #e9ce83;color:#795819;border-radius:10px;font-size:14px;font-weight:700;padding:6px 12px}h1{font-size:clamp(25px,4vw,36px);line-height:1.25;letter-spacing:-.03em;margin:20px 0 16px}p{margin:0 0 24px;overflow-wrap:anywhere;white-space:pre-line}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.button{display:inline-flex;justify-content:center;align-items:center;padding:11px 18px;background:#184e45;color:#fff;text-decoration:none;font-weight:650;border:1px solid #184e45;border-radius:10px}.secondary{color:#184e45;background:#edf3ef;border-color:#edf3ef}a:focus-visible{outline:3px solid #cf941c;outline-offset:4px}.request{color:#667d74;font-size:12px;margin:24px 0 0}.register{display:inline-block;color:#476359;font-size:13px;margin-top:20px}@media(max-width:480px){body{padding:16px}.actions{flex-direction:column}.button{width:100%}}`;
export function pageErrorDocument(
  status: number,
  message: string,
  requestId: string,
  locale: Locale = 'ru',
) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const text = (source: string) => escape(translate(source, locale));
  const title = pageStatusTitle(status, locale);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${status} · ${escape(title)} · ${locale === 'en' ? 'LUCH' : 'ЛУЧ'}</title><style>${PAGE_ERROR_STYLES}</style></head><body><main><a class="brand" href="/"><svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20 12 3l9 17M7 14h10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>${locale === 'en' ? 'LUCH' : 'ЛУЧ'}</a><section class="card" role="alert"><span class="status">${status}</span><h1>${escape(title)}</h1><p>${escape(translateMessage(message, locale))}</p><div class="actions"><a class="button" href="/">${text('На главную')}</a><a class="button secondary" href="/login">${text('Войти в аккаунт')}</a></div>${status === 410 ? `<a class="register" href="/register">${text('Запросить новое письмо')}</a>` : ''}<p class="request">${text('Код обращения:')} ${escape(requestId)}</p></section></main></body></html>`;
}
type Role = 'student' | 'teacher' | 'admin' | 'superadmin';
const learning: Role[] = ['student', 'teacher', 'superadmin'];
const operators: Role[] = ['admin', 'superadmin'];
const empty = z.strictObject({});
const subject = z.strictObject({ userId: z.uuid().optional() });
const revision = z.coerce.number().int().min(1).max(1_000_000).optional();
const patterns: {
  pattern: RegExp;
  kind: string;
  roles?: Role[];
  public?: boolean;
  query?: z.ZodType;
}[] = [
  { pattern: /^\/$/, kind: 'home', public: true },
  { pattern: /^\/(login|register|network-check)$/, kind: 'public', public: true },
  {
    pattern: /^\/verify-email$/,
    kind: 'verification',
    public: true,
    query: z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  },
  { pattern: /^\/authenticator$/, kind: 'enrollment', public: true },
  {
    pattern: /^\/demo-mail$/,
    kind: 'mailbox',
    public: true,
    query: z.strictObject({ email: z.email().optional() }),
  },
  { pattern: /^\/system$/, kind: 'development', public: true },
  { pattern: /^\/student$/, kind: 'student', roles: ['student'] },
  { pattern: /^\/teacher$/, kind: 'teacher', roles: ['teacher'] },
  { pattern: /^\/operations$/, kind: 'operations', roles: operators },
  { pattern: /^\/admin\/providers$/, kind: 'providers', roles: operators },
  {
    pattern: /^\/admin$/,
    kind: 'admin',
    roles: ['superadmin'],
    query: z.strictObject({ tab: z.enum(['accounts', 'security', 'audit']).optional() }),
  },
  { pattern: /^\/admin\/(content|learning)$/, kind: 'administration', roles: ['superadmin'] },
  {
    pattern: /^\/(onboarding|plan|assistant|feedback)$/,
    kind: 'subject',
    roles: learning,
    query: subject,
  },
  { pattern: /^\/learning$/, kind: 'history', roles: learning, query: subject },
  {
    pattern: /^\/progress$/,
    kind: 'report',
    roles: learning,
    query: subject.extend({ language: z.enum(['ru', 'en']).optional() }),
  },
  {
    pattern: /^\/schedule$/,
    kind: 'schedule',
    query: z.strictObject({
      view: z.enum(['week', 'month', 'agenda']).optional(),
      day: z.iso.date().optional(),
    }),
  },
  { pattern: /^\/courses$/, kind: 'catalog' },
  {
    pattern: /^\/courses\/([a-z0-9][a-z0-9-]{0,79})\/([a-z0-9][a-z0-9-]{0,79})$/,
    kind: 'route',
    query: z.strictObject({ packageVersion: revision }),
  },
  {
    pattern:
      /^\/courses\/([a-z0-9][a-z0-9-]{0,79})\/([a-z0-9][a-z0-9-]{0,79})\/lessons\/([a-z0-9][a-z0-9-]{0,79})$/,
    kind: 'lesson',
    query: z.strictObject({
      packageVersion: revision,
      purpose: z.enum(['practice', 'diagnostic', 'control']).optional(),
    }),
  },
  {
    pattern: /^\/teacher\/students\/([^/]+)$/,
    kind: 'student-detail',
    roles: ['teacher', 'superadmin'],
  },
  { pattern: /^\/learning\/runs\/([^/]+)$/, kind: 'run', roles: learning },
  { pattern: /^\/learning\/attempts\/([^/]+)$/, kind: 'attempt', roles: learning },
  { pattern: /^\/diagnostics\/([^/]+)$/, kind: 'diagnostic', roles: learning },
  { pattern: /^\/plan\/([^/]+)$/, kind: 'plan', roles: learning },
  { pattern: /^\/meetings\/([^/]+)(\/room)?$/, kind: 'meeting' },
];
export class PageLocationError extends Error {
  constructor(public readonly statusCode: number) {
    super(statusCode === 404 ? 'Страница не найдена.' : 'Некорректная ссылка.');
  }
}
export function pageTarget(path: string) {
  if (
    path.length > 2048 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\\u0000-\u0020\u007f#]/.test(path)
  )
    throw new PageLocationError(400);
  const [pathname = '', search = ''] = path.split('?');
  if (
    pathname.includes('%') ||
    pathname.includes('//') ||
    pathname.split('/').some((p) => p === '.' || p === '..') ||
    path.split('?').length > 2
  )
    throw new PageLocationError(400);
  const route = patterns.find((p) => p.pattern.test(pathname));
  if (!route) throw new PageLocationError(404);
  const values: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (Object.hasOwn(values, key) || key === '__proto__' || key === 'constructor')
      throw new PageLocationError(400);
    values[key] = value;
  }
  const parsed = (route.query ?? empty).safeParse(values);
  if (!parsed.success) throw new PageLocationError(400);
  const parts = route.pattern.exec(pathname)!.slice(1);
  if (
    ['student-detail', 'run', 'attempt', 'diagnostic', 'plan', 'meeting'].includes(route.kind) &&
    !z.uuid().safeParse(parts[0]).success
  )
    throw new PageLocationError(404);
  return {
    kind: route.kind,
    public: Boolean(route.public),
    roles: route.roles,
    parts,
    query: parsed.data as Record<string, string | number | undefined>,
    pathname,
  };
}
