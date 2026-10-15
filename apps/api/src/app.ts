import { registerTeacherRoutes } from './modules/teacher/routes.js';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import cookies from '@fastify/cookie';
import { ZodError } from 'zod';
import { projectRoot, type Settings } from './config.js';
import type { Database } from './db/database.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { AppError } from './errors.js';
import { registerVoiceRoutes } from './modules/speech/routes.js';
import { VoiceService } from './modules/speech/service.js';
import { AssistantAudioService } from './modules/speech/audio.js';
import { ElevenLabsTranscriptionAdapter } from './modules/speech/adapter.js';
import { registerProbeRoutes } from './modules/probes/routes.js';
import { AccountCrypto } from './modules/auth/crypto.js';
import { AuthService } from './modules/auth/service.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerAccountRoutes } from './modules/accounts/routes.js';
import { registerContentRoutes } from './modules/content/routes.js';
import { registerEngineRoutes } from './modules/engine/routes.js';
import { registerDiagnosticRoutes } from './modules/diagnostics/routes.js';
import { registerPlanRoutes } from './modules/plans/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerAdaptationRoutes } from './modules/adaptation/routes.js';
import { ProviderSettingsService } from './modules/providers/settings.js';
import { GenerationService } from './modules/providers/generation.js';
import { SpeechService } from './modules/providers/speech.js';
import {
  TextGenerationAdapter,
  ElevenLabsAdapter,
  type ProviderFetch,
} from './modules/providers/adapters.js';
import { AssistantService } from './modules/assistant/service.js';
import { AvatarVideoService } from './modules/assistant/video.js';
import { HeyGenAdapter } from './modules/providers/heygen.js';
import { registerAssistantRoutes } from './modules/assistant/routes.js';
import { registerProviderRoutes } from './modules/providers/routes.js';
import { MailService } from './modules/mail/service.js';
import { CaptchaService } from './modules/security/captcha.js';
import { NetworkService, type IpInspector } from './modules/security/network.js';
import { ipAllowed, validateRanges } from './modules/security/policy.js';

export async function buildApp(
  settings: Settings,
  database: Database,
  options: {
    captchaGenerator?: () => string;
    ipInspector?: IpInspector;
    providerFetch?: ProviderFetch;
  } = {},
) {
  const crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
  const network = new NetworkService(database, settings, crypto, options.ipInspector);
  const mail = new MailService(database, settings, crypto);
  const auth = new AuthService(database, settings, crypto, mail, network);
  const captcha = new CaptchaService(database, crypto, options.captchaGenerator);
  const providerSettings = new ProviderSettingsService(database, crypto, settings);
  const generation = new GenerationService(
    providerSettings,
    new TextGenerationAdapter(options.providerFetch),
  );
  const speech = new SpeechService(providerSettings, new ElevenLabsAdapter(options.providerFetch));
  const proxyRanges = validateRanges(
    settings.TRUST_PROXY_CIDRS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (proxyRanges.some((range) => range.endsWith('/0')))
    throw new Error('Trusted proxy ranges must be specific.');
  const app = Fastify({
    trustProxy: proxyRanges.length ? (address) => ipAllowed(address, proxyRanges) : false,
    logger:
      settings.LOG_LEVEL === 'silent'
        ? false
        : {
            level: settings.LOG_LEVEL,
            serializers: {
              req: (request) => ({ method: request.method, url: request.url.split('?')[0] ?? '/' }),
            },
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
  await app.register(cookies);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:'],
        connectSrc: ["'self'"],
        ...(network.probeTargets().length
          ? {
              imgSrc: [
                "'self'",
                'data:',
                'https:',
                ...network.probeTargets().map((target) => new URL(target.url).origin),
              ],
            }
          : {}),
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
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (
      path.startsWith('/api/v1/health/') ||
      path.startsWith('/api/v1/security/') ||
      path.startsWith('/assets/') ||
      path === '/api/v1/auth/logout' ||
      path === '/network-check'
    )
      return;
    await network.check(request, undefined, false);
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
      if (error.code === 'VPN_ACCESS_DENIED' && !request.url.startsWith('/api/')) {
        return reply
          .code(403)
          .type('text/html; charset=utf-8')
          .send(
            '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Сервис недоступен</title><body><main><h1>вы используете VPN - сервис недоступен</h1><a href="/network-check">Проверить соединение ещё раз</a></main></body></html>',
          );
      }
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
    data: { application: 'ЛУЧ', stage: 'assistant', devToolsEnabled: settings.ENABLE_DEV_TOOLS },
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
  await registerAuthRoutes(app, auth, captcha);
  await registerAccountRoutes(app, auth);
  await registerTeacherRoutes(app, auth);
  await registerContentRoutes(app, auth);
  await registerEngineRoutes(app, auth);
  await registerDiagnosticRoutes(app, auth);
  await registerPlanRoutes(app, auth, (actor, planId, assignmentId) =>
    generation.prepare(actor, planId, assignmentId),
  );
  await registerVoiceRoutes(
    app,
    auth,
    new VoiceService(providerSettings, new ElevenLabsTranscriptionAdapter(options.providerFetch)),
    new AssistantAudioService(providerSettings, new ElevenLabsAdapter(options.providerFetch)),
  );
  await registerAdaptationRoutes(app, auth);
  await registerDashboardRoutes(app, auth);
  await registerProviderRoutes(app, auth, providerSettings, speech);
  await registerAssistantRoutes(
    app,
    auth,
    new AssistantService(database),
    new AvatarVideoService(providerSettings, new HeyGenAdapter(options.providerFetch)),
  );

  const webRoot = resolve(projectRoot, 'apps/web/dist');
  if (settings.SERVE_WEB) {
    await access(resolve(webRoot, 'index.html'));
    await app.register(staticFiles, { root: webRoot, index: false });
    app.get('/', (_request, reply) => reply.type('text/html').sendFile('index.html'));
  }
  const webPaths = new Set([
    '/',
    '/plan',
    '/operations',
    '/admin/providers',
    '/assistant',
    '/schedule',
    '/progress',
    '/feedback',
    '/teacher',
    '/system',
    '/student',
    '/login',
    '/register',
    '/verify-email',
    '/authenticator',
    '/admin',
    '/admin/content',
    '/courses',
    '/learning',
    '/onboarding',
    '/admin/learning',
    '/demo-mail',
    '/network-check',
  ]);
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    if (
      settings.SERVE_WEB &&
      request.method === 'GET' &&
      (webPaths.has(pathname) ||
        /^\/teacher\/students\/[0-9a-f-]{36}$/.test(pathname) ||
        /^\/courses\/[a-z0-9-]+\/[a-z0-9-]+(?:\/lessons\/[a-z0-9-]+)?$/.test(pathname) ||
        /^\/learning\/(?:runs|attempts)\/[0-9a-f-]{36}$/.test(pathname) ||
        /^\/diagnostics\/[0-9a-f-]{36}$/.test(pathname) ||
        /^\/plan\/[0-9a-f-]{36}$/.test(pathname))
    ) {
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
