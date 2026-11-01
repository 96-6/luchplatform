import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startUpdateSchema, systemStatusSchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { UpdatesService } from './service.js';
import { assertSchemaCurrent } from '../../db/migrations.js';

export async function registerUpdateRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: UpdatesService,
  automatic: boolean,
) {
  app.get('/api/v1/admin/updates', async (r, reply) => {
    await auth.requireActor(r, 'superadmin');
    const data = await service.overview();
    if (data.latestJob && service.spool.directory)
      await service.spool.grant(auth, r, reply, data.latestJob.id);
    return { data, requestId: r.id };
  });
  app.post('/api/v1/admin/updates/check', async (r) => {
    await auth.requireActor(r, 'superadmin', true);
    z.strictObject({}).parse(r.body);
    await service.check(true);
    return { data: await service.overview(), requestId: r.id };
  });
  app.post('/api/v1/admin/updates/apply', async (r, reply) => {
    const actor = await auth.requireActor(r, 'superadmin', true);
    const job = await service.start(actor, startUpdateSchema.parse(r.body));
    await service.spool.grant(auth, r, reply, job.id);
    return { data: job, requestId: r.id };
  });
  app.get('/api/v1/admin/updates/progress', async (r, reply) => {
    await auth.requireActor(r, 'superadmin');
    const { jobId } = z.strictObject({ jobId: z.uuid() }).parse(r.query);
    const data = await service.progress(jobId);
    if (service.spool.directory) await service.spool.grant(auth, r, reply, jobId);
    return { data, requestId: r.id };
  });
  app.get('/api/v1/admin/system-status', async (r) => {
    await auth.requireActor(r, 'superadmin');
    const started = Date.now();
    let available = false,
      schemaCurrent = false,
      schemaVersion: string | null = null;
    try {
      await auth.database.query('SELECT 1');
      available = true;
      schemaVersion =
        (
          await auth.database.query<{ version: string }>(
            'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
          )
        ).rows[0]?.version ?? null;
      await assertSchemaCurrent(auth.database);
      schemaCurrent = true;
    } catch {}
    const latencyMs = Date.now() - started;
    const configured = Boolean(auth.settings.LIVEKIT_URL && auth.settings.LIVEKIT_API_SECRET);
    let videoAvailable: boolean | null = null;
    if (configured)
      try {
        const res = await fetch(auth.settings.LIVEKIT_URL, {
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        });
        videoAvailable = res.ok;
        await res.body?.cancel();
      } catch {
        videoAvailable = false;
      }
    return {
      data: systemStatusSchema.parse({
        refreshedAt: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        database: {
          driver: auth.database.kind,
          available,
          schemaCurrent,
          schemaVersion,
          latencyMs,
        },
        build: service.build,
        agent: await service.spool.agent(),
        video: { configured, available: videoAvailable },
        mail:
          auth.settings.MAIL_MODE === 'local'
            ? 'local'
            : auth.settings.SMTP_HOST
              ? 'smtp'
              : 'not_configured',
      }),
      requestId: r.id,
    };
  });
  if (automatic) {
    let timer: ReturnType<typeof setInterval> | undefined;
    app.addHook('onReady', async () => {
      const run = () => {
        void service.check(false).catch(() => {});
      };
      timer = setInterval(run, 60000);
      timer.unref();
      run();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
      await service.close();
    });
  }
}
