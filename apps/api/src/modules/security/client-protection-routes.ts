import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  clientProtectionDocument,
  clientProtectionPolicySchema,
  clientProtectionEvidenceSchema,
  resolveLocale,
} from '@luch/contracts';
import { projectRoot } from '../../config.js';
import { AppError } from '../../errors.js';
import type { AuthService } from '../auth/service.js';
import { ClientProtectionService, getClientProtectionPolicy } from './client-protection.js';

export const CLIENT_PUBLIC_PATHS = [
  '/api/v1/security/client/bootstrap',
  '/api/v1/security/client/verify',
  '/api/v1/security/client/runtime.js',
  '/api/v1/security/client/ads.js',
  '/api/v1/security/client/probe.css',
];
export async function registerClientProtection(app: FastifyInstance, auth: AuthService) {
  const service = new ClientProtectionService(auth);
  app.addHook('onRequest', async (r, reply) => {
    const path = r.url.split('?')[0]!;
    if (
      CLIENT_PUBLIC_PATHS.includes(path) ||
      [
        '/api/v1/auth/session',
        '/api/v1/auth/logout',
        '/api/v1/health/live',
        '/api/v1/health/ready',
        '/api/v1/security/bootstrap',
        '/api/v1/security/evaluate',
        '/api/v1/security/ping',
        '/api/v1/security/browser/bootstrap',
        '/api/v1/security/browser/assess',
        '/api/v1/security/browser/notice',
        '/browser-check-worker.js',
        '/favicon.svg',
        '/login',
      ].includes(path) ||
      /^\/assets\/[A-Za-z0-9_/-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/.test(path) ||
      /^\/avatars\/(?:mentor|partner|guide)\.svg$/.test(path) ||
      path === '/audio/pcm-recorder.js'
    )
      return;
    try {
      await service.check(r);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'CLIENT_CAPABILITIES_REQUIRED' &&
        !path.startsWith('/api/') &&
        !path.startsWith('/learning-media/')
      )
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .send(
            clientProtectionDocument(
              r.id,
              resolveLocale(r.headers.cookie, r.headers['accept-language']),
            ),
          );
      throw error;
    }
  });
  app.get('/api/v1/security/client/bootstrap', async (r, reply) => {
    const q = z.strictObject({ force: z.enum(['true', 'false']).optional() }).parse(r.query);
    return { data: await service.bootstrap(r, reply, q.force === 'true'), requestId: r.id };
  });
  app.post('/api/v1/security/client/verify', { bodyLimit: 2048 }, async (r) => ({
    data: await service.verify(r, clientProtectionEvidenceSchema.parse(r.body)),
    requestId: r.id,
  }));
  app.get('/api/v1/security/client/ads.js', async (r, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(r.query);
    return reply
      .type('application/javascript')
      .header('cross-origin-resource-policy', 'same-origin')
      .send(await service.resource(r, id));
  });
  let runtime: Promise<string> | undefined;
  app.get('/api/v1/security/client/runtime.js', async (_r, reply) => {
    runtime ??= readFile(
      resolve(
        projectRoot,
        `apps/web/${auth.settings.SERVE_WEB ? 'dist' : 'public'}/client-check.js`,
      ),
      'utf8',
    );
    try {
      return reply
        .type('application/javascript')
        .header('cross-origin-resource-policy', 'same-origin')
        .send(await runtime);
    } catch (e) {
      runtime = undefined;
      throw e;
    }
  });
  app.get('/api/v1/security/client/probe.css', async (_r, reply) =>
    reply
      .type('text/css')
      .header('cross-origin-resource-policy', 'same-origin')
      .send(
        '.luch-client-control,.luch-client-probe{position:fixed;left:-10000px;top:0;width:4px;height:4px;pointer-events:none;overflow:hidden}',
      ),
  );
  app.get('/api/v1/admin/client-protection', async (r) => {
    await auth.requireActor(r, 'superadmin');
    return { data: await getClientProtectionPolicy(auth.database), requestId: r.id };
  });
  app.post('/api/v1/admin/client-protection', async (r) => ({
    data: await service.update(r, clientProtectionPolicySchema.parse(r.body)),
    requestId: r.id,
  }));
  let work: Promise<void> | null = null;
  const timer =
    auth.settings.APP_ENV !== 'test'
      ? setInterval(() => {
          work ??= service
            .cleanup()
            .catch(() => {
              app.log.warn('Client check cleanup will retry.');
            })
            .finally(() => {
              work = null;
            });
        }, 600000)
      : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await work;
  });
}
