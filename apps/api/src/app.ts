import { createHash } from 'node:crypto';
import { PAGE_ERROR_STYLES } from '@luch/contracts';
import { registerReportRoutes } from './modules/reports/routes.js';
import { ReportsService } from './modules/reports/service.js';
import { OperationsService } from './modules/operations/service.js';
import { registerOperationsRoutes } from './modules/operations/routes.js';
import websocket from '@fastify/websocket';
import { registerMeetingSignalling } from './modules/meetings/signalling.js';
import { registerMeetingRoutes } from './modules/meetings/routes.js';
import { MeetingFiles } from './modules/meetings/files.js';
import { MeetingsService } from './modules/meetings/service.js';
import { LiveKitVideo, type MeetingVideo } from './modules/meetings/adapter.js';
import { registerTeacherRoutes } from './modules/teacher/routes.js';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { registerWebAccess, pageError } from './modules/navigation/web.js';
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
import { registerBrowserSecurity } from './modules/security/browsers.js';

export async function buildApp(
  settings: Settings,
  database: Database,
  options: {
    captchaGenerator?: () => string;
    ipInspector?: IpInspector;
    providerFetch?: ProviderFetch;
    meetingVideo?: MeetingVideo;
    testWebRoot?: string;
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
    requestTimeout: 30 * 60 * 1000,
  });
  const allowedOrigin = new URL(settings.APP_URL).origin;
  await app.register(cors, {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
  await app.register(cookies);
  await app.register(websocket, {
    options: { maxPayload: 256 * 1024 },
    errorHandler: (_error, socket) => {
      socket.terminate();
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'sha256-" + createHash('sha256').update(PAGE_ERROR_STYLES).digest('base64') + "'",
        ],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:', 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", new URL(settings.APP_URL.replace(/^http/, 'ws')).origin],
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
  await registerBrowserSecurity(app, auth);
  app.addHook('onClose', async () => {
    await database.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (
      settings.SERVE_WEB &&
      !request.url.startsWith('/api/') &&
      !(error instanceof AppError && error.code === 'VPN_ACCESS_DENIED')
    ) {
      const status =
        error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 : 500;
      if (status >= 500)
        request.log.error(
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
          'Page request failed',
        );
      return pageError(
        reply,
        status,
        error instanceof AppError
          ? error.message
          : status === 400
            ? 'Некорректная ссылка.'
            : 'Сервис временно недоступен. Повторите позже.',
        request.id,
      );
    }
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
      if (error.code === 'VPN_ACCESS_DENIED' && !request.url.startsWith('/api/'))
        return pageError(reply, 403, error.message, request.id);
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
  await registerReportRoutes(app, auth, new ReportsService(database));
  const meetings = new MeetingsService(
    database,
    options.meetingVideo ?? new LiveKitVideo(settings),
    Date.now,
    new MeetingFiles(database, resolve(projectRoot, settings.MEETING_FILE_DIRECTORY)),
  );
  await registerMeetingRoutes(app, auth, meetings, settings.APP_ENV !== 'test');
  await registerOperationsRoutes(app, auth, new OperationsService(database, settings, meetings));
  await registerMeetingSignalling(app, auth, meetings, settings);
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

  if (options.testWebRoot && settings.APP_ENV !== 'test')
    throw new Error('A web root override is test-only.');
  const webRoot = options.testWebRoot ?? resolve(projectRoot, 'apps/web/dist');
  if (settings.SERVE_WEB) {
    await access(resolve(webRoot, 'index.html'));
  }
  await registerWebAccess(app, auth, webRoot);
  app.setNotFoundHandler((request, reply) => {
    if (settings.SERVE_WEB && !request.url.startsWith('/api/'))
      return pageError(reply, 404, 'Страница или ресурс не найдены.', request.id);
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
