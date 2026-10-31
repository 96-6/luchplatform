import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  PAGE_ERROR_STYLES,
  browserAccessPageQuerySchema,
  createBrowserAccessLinkSchema,
  resolveLocale,
  translate,
} from '@luch/contracts';
import { AppError } from '../../errors.js';
import { pageError } from '../navigation/web.js';
import { limitAttempts } from './rate.js';
import type { BrowserManualAccess } from './browser-access.js';

const rawToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const styles =
  PAGE_ERROR_STYLES +
  'input{display:block;font:inherit;width:100%;max-width:100%;padding:10px;border:1px solid #b6c8bf;border-radius:8px;margin-top:8px}button{font:inherit;cursor:pointer}label{font-weight:600}';
function document(r: FastifyRequest, raw: string, proof: string, alreadyAllowed: boolean) {
  const locale = resolveLocale(r.headers.cookie, r.headers['accept-language']);
  const t = (s: string) => escape(translate(s, locale));
  const form = alreadyAllowed
    ? `<p>${t('Этот браузер уже запомнен. Можно перейти на платформу.')}</p><div class="actions"><a class="button" href="/">${t('Перейти на платформу')}</a></div>`
    : `<p>${t('Суперадмин разрешает этому браузеру обходить проверку совместимости. Вход в аккаунт и остальные правила безопасности сохраняются.')}</p><p>${t('Допуск хранится в этом браузере до 365 дней. После удаления cookie или смены профиля потребуется новая ссылка. Совместимость функций старого браузера не гарантируется.')}</p><form method="post" action="/browser-access"><input type="hidden" name="token" value="${escape(raw)}"><input type="hidden" name="proof" value="${escape(proof)}"><label>${t('Название устройства (необязательно)')}<input name="label" maxlength="120" autocomplete="off"></label><div class="actions"><button class="button" type="submit">${t('Разрешить этот браузер')}</button></div></form>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="origin"><title>${t('Разрешить вход вручную')} · ${locale === 'en' ? 'LUCH' : 'ЛУЧ'}</title><style>${styles}</style></head><body><main><a href="/" class="brand">${locale === 'en' ? 'LUCH' : 'ЛУЧ'}</a><section class="card"><h1>${t('Разрешить вход вручную')}</h1>${form}</section></main></body></html>`;
}
export async function registerBrowserManualRoutes(
  app: FastifyInstance,
  service: BrowserManualAccess,
) {
  const auth = service.auth;
  const ids = z.object({ id: z.uuid() }),
    deviceIds = ids.extend({ deviceId: z.uuid() });
  app.get('/api/v1/admin/browser-access-links', async (r) => ({
    data: await service.list(r, browserAccessPageQuerySchema.parse(r.query)),
    requestId: r.id,
  }));
  app.post('/api/v1/admin/browser-access-links', async (r) => ({
    data: await service.create(r, createBrowserAccessLinkSchema.parse(r.body)),
    requestId: r.id,
  }));
  app.post('/api/v1/admin/browser-access-links/:id/revoke', async (r) => {
    z.strictObject({}).parse(r.body);
    return { data: await service.revokeLink(r, ids.parse(r.params).id), requestId: r.id };
  });
  app.get('/api/v1/admin/browser-access-links/:id/devices', async (r) => ({
    data: await service.devices(
      r,
      ids.parse(r.params).id,
      browserAccessPageQuerySchema.parse(r.query),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/admin/browser-access-links/:id/devices/:deviceId/revoke', async (r) => {
    z.strictObject({}).parse(r.body);
    const p = deviceIds.parse(r.params);
    return { data: await service.revokeDevice(r, p.id, p.deviceId), requestId: r.id };
  });
  await app.register(async (pages) => {
    pages.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_r, body, done) => {
        const form = new URLSearchParams(String(body)),
          out: Record<string, string> = {};
        for (const [key, value] of form) {
          if (Object.hasOwn(out, key) || !['token', 'proof', 'label'].includes(key)) {
            done(new AppError(400, 'INVALID_REQUEST', 'Проверьте введённые данные.'));
            return;
          }
          out[key] = value;
        }
        done(null, out);
      },
    );
    pages.setErrorHandler((error, r, reply) => {
      const status =
        error instanceof AppError
          ? error.statusCode
          : error instanceof ZodError
            ? 400
            : error &&
                typeof error === 'object' &&
                'statusCode' in error &&
                Number(error.statusCode) >= 400 &&
                Number(error.statusCode) < 500
              ? Number(error.statusCode)
              : 500;
      if (status === 500)
        r.log.error(
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Manual browser access page failed',
        );
      return pageError(
        reply,
        status,
        error instanceof AppError
          ? error.message
          : status === 400
            ? 'Некорректная ссылка.'
            : 'Сервис временно недоступен. Повторите позже.',
        r.id,
      );
    });
    pages.get('/browser-access', async (r, reply) => {
      const { token } = z.strictObject({ token: rawToken }).parse(r.query);
      await limitAttempts(auth.database, auth.crypto, `browser-manual-preview:${r.ip}`, 240);
      const view = await service.preview(r, token);
      if (service.secret(r) !== view.secret)
        reply.setCookie(service.cookie, view.secret, service.cookieOptions());
      return reply
        .type('text/html; charset=utf-8')
        .header('referrer-policy', 'origin')
        .header('x-robots-tag', 'noindex, nofollow, noarchive')
        .header(
          'content-security-policy',
          `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        )
        .send(document(r, token, view.proof, view.alreadyAllowed));
    });
    pages.post('/browser-access', { bodyLimit: 4096 }, async (r, reply) => {
      const p = z
        .strictObject({
          token: rawToken,
          proof: z.string().max(120),
          label: z.string().trim().max(120).default(''),
        })
        .parse(r.body);
      if (r.headers['sec-fetch-site'] === 'cross-site')
        throw new AppError(
          403,
          'BROWSER_ACCESS_FORM_INVALID',
          'Откройте ссылку ручного допуска заново.',
        );
      await limitAttempts(auth.database, auth.crypto, `browser-manual-redeem:${r.ip}`, 120);
      await service.redeem(r, p.token, p.proof, p.label);
      return reply.header('referrer-policy', 'no-referrer').redirect('/', 303);
    });
  });
}
