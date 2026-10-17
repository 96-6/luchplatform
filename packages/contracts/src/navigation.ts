import { z } from 'zod';

export const navigationQuerySchema = z.strictObject({ path: z.string().min(1).max(2048) });
export const navigationAccessSchema = z.object({ path: z.string() });
export function pageStatusTitle(status: number) {
  return (
    (
      {
        400: 'Некорректная ссылка',
        401: 'Требуется вход',
        403: 'Доступ запрещён',
        404: 'Страница не найдена',
        410: 'Ссылка больше недоступна',
        503: 'Сервис временно недоступен',
      } as Record<number, string>
    )[status] ?? 'Не удалось открыть страницу'
  );
}
export function pageErrorDocument(status: number, message: string, requestId: string) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const title = pageStatusTitle(status);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${status} · ${title} · ЛУЧ</title></head><body><main><section role="alert"><h1>${status} · ${title}</h1><p>${escape(message)}</p></section><p><a href="/">На главную</a> · <a href="/login">Войти в аккаунт</a> · <a href="/register">Регистрация и новое письмо</a></p><p>Код обращения: ${escape(requestId)}</p></main></body></html>`;
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
