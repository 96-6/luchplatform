import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createMeetingSchema,
  updateMeetingSchema,
  meetingsQuerySchema,
  meetingOperationSchema,
  moderateMeetingSchema,
  deviceReportSchema,
  sendMeetingMessageSchema,
  meetingSummarySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { MeetingsService } from './service.js';
export async function registerMeetingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: MeetingsService,
  background = true,
) {
  const ids = z.object({ id: z.uuid() }),
    sessions = z.object({ id: z.uuid(), sid: z.uuid() });
  app.get('/api/v1/meetings/options', async (r) => ({
    data: await service.options(await auth.requireActor(r)),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings', async (r) => ({
    data: await service.list(await auth.requireActor(r), meetingsQuerySchema.parse(r.query)),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings', async (r) => ({
    data: await service.create(
      await auth.requireActor(r, undefined, true),
      createMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id', async (r) => ({
    data: await service.read(await auth.requireActor(r), ids.parse(r.params).id),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id', async (r) => ({
    data: await service.update(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      updateMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/join', async (r) => ({
    data: await service.join(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      meetingOperationSchema.parse(r.body).operationId,
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id/room-state', async (r) => ({
    data: await service.room(
      await auth.requireActor(r),
      ids.parse(r.params).id,
      z.strictObject({ sessionId: z.uuid().optional() }).parse(r.query).sessionId,
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/moderate', async (r) => ({
    data: await service.moderate(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      moderateMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/sessions/:sid/token', async (r) => {
    const p = sessions.parse(r.params);
    z.strictObject({}).parse(r.body);
    return {
      data: await service.token(await auth.requireActor(r, undefined, true), p.id, p.sid),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/leave', async (r) => {
    const p = sessions.parse(r.params);
    z.strictObject({}).parse(r.body);
    return {
      data: await service.leave(await auth.requireActor(r, undefined, true), p.id, p.sid),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/hand', async (r) => {
    const p = sessions.parse(r.params);
    return {
      data: await service.hand(
        await auth.requireActor(r, undefined, true),
        p.id,
        p.sid,
        z.strictObject({ raised: z.boolean() }).parse(r.body).raised,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/devices', async (r) => {
    const p = sessions.parse(r.params);
    return {
      data: await service.devices(
        await auth.requireActor(r, undefined, true),
        p.id,
        p.sid,
        deviceReportSchema.parse(r.body),
      ),
      requestId: r.id,
    };
  });
  const page = z
    .strictObject({ beforeCreatedAt: z.iso.datetime().optional(), beforeId: z.uuid().optional() })
    .refine((x) => Boolean(x.beforeCreatedAt) === Boolean(x.beforeId));
  app.get('/api/v1/meetings/:id/messages', async (r) => {
    const q = page.parse(r.query);
    return {
      data: await service.messages(
        await auth.requireActor(r),
        ids.parse(r.params).id,
        q.beforeCreatedAt && q.beforeId
          ? { createdAt: q.beforeCreatedAt, id: q.beforeId }
          : undefined,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/messages', async (r) => {
    const p = sendMeetingMessageSchema.parse(r.body);
    return {
      data: await service.send(
        await auth.requireActor(r, undefined, true),
        ids.parse(r.params).id,
        p.operationId,
        p.text,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/summary', { bodyLimit: 192 * 1024 }, async (r) => ({
    data: await service.summary(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      meetingSummarySchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  let inFlight: Promise<void> | null = null;
  const recover = () => {
    if (inFlight) return;
    inFlight = service
      .recover()
      .catch(() => {
        app.log.warn('Video meeting recovery will retry.');
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = background ? setInterval(recover, 10000) : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await inFlight;
  });
}
