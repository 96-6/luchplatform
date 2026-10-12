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
    SERVE_WEB: flag.default(false),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    AI_API_URL: optionalUrl,
    AI_API_KEY: z.string().default(''),
    SPEECH_API_URL: optionalUrl,
    SPEECH_API_KEY: z.string().default(''),
    VIDEO_SERVICE_URL: optionalUrl,
    VIDEO_API_KEY: z.string().default(''),
  })
  .superRefine((settings, context) => {
    const url = new URL(settings.APP_URL);
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
