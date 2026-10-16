import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalUrl = z.union([z.literal(''), z.url()]).default('');
const settingsSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.url().default('http://localhost:5173'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1).default('pglite:./data/luch'),
    DATABASE_SSL: flag.default(false),
    ENABLE_DEV_TOOLS: flag.default(false),
    LOCAL_DEBUG_LOGIN: flag.default(false),
    LOCAL_DEBUG_ADMIN_ALIAS: z.string().max(254).default(''),
    SERVE_WEB: flag.default(false),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    AUTH_ENCRYPTION_KEY: z.string().default(''),
    MAIL_MODE: z.enum(['local', 'smtp']).default('local'),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: flag.default(false),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z.string().default('ЛУЧ <no-reply@localhost>'),
    TRUST_PROXY_CIDRS: z.string().default(''),
    IP_INTEL_URL: optionalUrl,
    IP_INTEL_KEY: z.string().default(''),
    NETWORK_PROBE_URLS: z.string().default(''),
    NETWORK_STUN_URLS: z.string().default(''),
    AI_API_URL: optionalUrl,
    AI_API_KEY: z.string().default(''),
    OPENAI_API_KEY: z.string().default(''),
    NEUROAPI_API_KEY: z.string().default(''),
    ELEVENLABS_API_KEY: z.string().default(''),
    HEYGEN_API_KEY: z.string().default(''),
    SPEECH_API_URL: optionalUrl,
    SPEECH_API_KEY: z.string().default(''),
    VIDEO_SERVICE_URL: optionalUrl,
    VIDEO_API_KEY: z.string().default(''),
    LIVEKIT_URL: optionalUrl,
    LIVEKIT_WS_URL: optionalUrl,
    LIVEKIT_API_KEY: z.string().default(''),
    LIVEKIT_API_SECRET: z.string().default(''),
  })
  .superRefine((settings, context) => {
    const url = new URL(settings.APP_URL);
    const video = [
      settings.LIVEKIT_URL,
      settings.LIVEKIT_WS_URL,
      settings.LIVEKIT_API_KEY,
      settings.LIVEKIT_API_SECRET,
    ];
    if (
      video.some(Boolean) &&
      (!video.every(Boolean) ||
        settings.LIVEKIT_API_SECRET.length < 32 ||
        !/^https?:/.test(settings.LIVEKIT_URL) ||
        !/^wss?:/.test(settings.LIVEKIT_WS_URL))
    )
      context.addIssue({
        code: 'custom',
        path: ['LIVEKIT_URL'],
        message:
          'Supply the server HTTP URL, browser WS URL, key and a secret of at least 32 characters.',
      });
    for (const [field, value] of [
      ['LIVEKIT_URL', settings.LIVEKIT_URL],
      ['LIVEKIT_WS_URL', settings.LIVEKIT_WS_URL],
    ] as const) {
      if (value) {
        const endpoint = new URL(value);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Use an endpoint URL without credentials or query parameters.',
          });
      }
    }
    if (
      settings.APP_ENV === 'production' &&
      settings.LIVEKIT_WS_URL &&
      !settings.LIVEKIT_WS_URL.startsWith('wss://')
    )
      context.addIssue({
        code: 'custom',
        path: ['LIVEKIT_WS_URL'],
        message: 'Production video requires WSS.',
      });

    if (
      settings.LOCAL_DEBUG_LOGIN &&
      (settings.APP_ENV === 'production' ||
        !settings.ENABLE_DEV_TOOLS ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['localhost', '127.0.0.1', '::1'].includes(settings.API_HOST) ||
        settings.TRUST_PROXY_CIDRS.trim() ||
        settings.LOCAL_DEBUG_ADMIN_ALIAS.length < 8 ||
        ['testuser1', 'testuser2', 'testuser3'].includes(settings.LOCAL_DEBUG_ADMIN_ALIAS))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['LOCAL_DEBUG_LOGIN'],
        message:
          'Local debug access requires an isolated loopback development environment and a configured alias.',
      });
    }
    if (
      settings.AUTH_ENCRYPTION_KEY &&
      Buffer.from(settings.AUTH_ENCRYPTION_KEY, 'base64').length !== 32
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_ENCRYPTION_KEY'],
        message: 'A 32-byte base64 key is required.',
      });
    }
    if (settings.IP_INTEL_URL && new URL(settings.IP_INTEL_URL).protocol !== 'https:')
      context.addIssue({ code: 'custom', path: ['IP_INTEL_URL'], message: 'HTTPS is required.' });
    if (settings.MAIL_MODE === 'smtp' && !settings.SMTP_HOST)
      context.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP host is required.' });
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      context.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'Use an HTTP(S) origin without credentials, path or query.',
      });
    }
    const embedded = settings.DATABASE_URL.startsWith('pglite:');
    if (embedded) {
      if (!settings.DATABASE_URL.slice(7).trim()) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Specify an embedded database directory.',
        });
      }
      if (settings.DATABASE_URL === 'pglite:memory' && settings.APP_ENV !== 'test') {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Memory storage is permitted only in tests.',
        });
      }
    } else {
      const parsed = URL.canParse(settings.DATABASE_URL) ? new URL(settings.DATABASE_URL) : null;
      if (
        !parsed ||
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.pathname === '/'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Use a PostgreSQL connection URL or pglite:<directory>.',
        });
      }
    }
    if (settings.APP_ENV === 'production') {
      if (!settings.AUTH_ENCRYPTION_KEY)
        context.addIssue({
          code: 'custom',
          path: ['AUTH_ENCRYPTION_KEY'],
          message: 'Run environment setup or supply the account key.',
        });
      if (settings.MAIL_MODE !== 'smtp')
        context.addIssue({
          code: 'custom',
          path: ['MAIL_MODE'],
          message: 'Production requires SMTP.',
        });
      if (embedded)
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'Production requires a separate PostgreSQL server.',
        });
      if (url.protocol !== 'https:')
        context.addIssue({
          code: 'custom',
          path: ['APP_URL'],
          message: 'Production requires HTTPS.',
        });
      if (settings.ENABLE_DEV_TOOLS)
        context.addIssue({
          code: 'custom',
          path: ['ENABLE_DEV_TOOLS'],
          message: 'Development tools must be disabled in production.',
        });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;
export function parseSettings(environment: Record<string, string | undefined>): Settings {
  const result = settingsSchema.safeParse(environment);
  if (!result.success) {
    // Do not include environment values: database URLs and provider keys may contain secrets.
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  return result.data;
}
export function loadSettings(): Settings {
  dotenv({ path: `${projectRoot}/.env`, quiet: true });
  return parseSettings(process.env);
}
