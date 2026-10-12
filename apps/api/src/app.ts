import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { ZodError } from 'zod';
import { projectRoot, type Settings } from './config.js';
import type { Database } from './db/database.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { AppError } from './errors.js';
import { registerProbeRoutes } from './modules/probes/routes.js';

export async function buildApp(settings: Settings, database: Database) {
  const app = Fastify({
    logger:
      settings.LOG_LEVEL === 'silent'
        ? false
        : {
            level: settings.LOG_LEVEL,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 16 * 1024,
    requestTimeout: 15000,
  });
  const allowedOrigin = new URL(settings.APP_URL).origin;
  await app.register(cors, {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: settings.APP_ENV === 'production' ? [] : null,
      },
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    if (
      request.method !== 'GET' &&
      request.headers.origin &&
      request.headers.origin !== allowedOrigin
    ) {
      throw new AppError(403, 'ORIGIN_REJECTED', 'Запрос с этого адреса не разрешён.');
    }
  });
  app.addHook('onClose', async () => {
    await database.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || 'body';
        (fields[key] ??= []).push(issue.message);
      }
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Проверьте введённые данные.',
          requestId: request.id,
          fields,
        },
      });
    }
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } });
    }
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Запрос не удалось обработать.',
          requestId: request.id,
        },
      });
    }
    request.log.error(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Request failed',
    );
    return reply.code(503).send({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Сервис временно недоступен. Повторите попытку.',
        requestId: request.id,
      },
    });
  });
  app.get('/api/v1/system', async (request) => ({
    data: { application: 'ЛУЧ', stage: 'foundation', devToolsEnabled: settings.ENABLE_DEV_TOOLS },
    requestId: request.id,
  }));
  app.get('/api/v1/health/live', async (request) => ({
    data: { status: 'ok' },
    requestId: request.id,
  }));
  app.get('/api/v1/health/ready', async (request) => {
    try {
      await assertSchemaCurrent(database);
    } catch {
      throw new AppError(
        503,
        'DATABASE_NOT_READY',
        'База данных пока недоступна или требует обновления структуры.',
      );
    }
    return { data: { status: 'ok' }, requestId: request.id };
  });
  if (settings.ENABLE_DEV_TOOLS) await registerProbeRoutes(app, database);

  const webRoot = resolve(projectRoot, 'apps/web/dist');
  if (settings.SERVE_WEB) {
    await access(resolve(webRoot, 'index.html'));
    await app.register(staticFiles, { root: webRoot, index: false });
    app.get('/', (_request, reply) => reply.type('text/html').sendFile('index.html'));
  }
  const webPaths = new Set([
    '/',
    '/plan',
    '/assistant',
    '/schedule',
    '/progress',
    '/teacher',
    '/system',
  ]);
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (settings.SERVE_WEB && request.method === 'GET' && webPaths.has(pathname)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Страница или ресурс не найдены.',
        requestId: request.id,
      },
    });
  });
  return app;
}
