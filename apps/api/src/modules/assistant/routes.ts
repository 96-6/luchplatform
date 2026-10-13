import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  saveAssistantProfileSchema,
  sendAssistantMessageSchema,
  updateAvatarBindingsSchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { AssistantService } from './service.js';
import { AvatarVideoService } from './video.js';

export async function registerAssistantRoutes(
  app: FastifyInstance,
  auth: AuthService,
  assistant: AssistantService,
  video: AvatarVideoService,
) {
  app.get('/api/v1/assistant/profile', async (request) => ({
    data: await assistant.profile(
      await auth.requireActor(request),
      z.object({ userId: z.uuid().optional() }).parse(request.query).userId,
    ),
    requestId: request.id,
  }));
  app.post('/api/v1/assistant/profile', async (request) => ({
    data: await assistant.saveProfile(
      await auth.requireActor(request, undefined, true),
      saveAssistantProfileSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/assistant/runs/:id/messages', async (request) => ({
    data: await assistant.chat(
      await auth.requireActor(request),
      z.object({ id: z.uuid() }).parse(request.params).id,
      z.object({ before: z.coerce.number().int().positive().optional() }).parse(request.query)
        .before,
    ),
    requestId: request.id,
  }));
  app.post('/api/v1/assistant/runs/:id/messages', async (request) => ({
    data: await assistant.send(
      await auth.requireActor(request, undefined, true),
      z.object({ id: z.uuid() }).parse(request.params).id,
      sendAssistantMessageSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/admin/assistant/avatars', async (request) => ({
    data: await video.bindings(await auth.requireActor(request, 'superadmin')),
    requestId: request.id,
  }));
  app.post('/api/v1/admin/assistant/avatars', async (request) => ({
    data: await video.updateBindings(
      await auth.requireActor(request, 'superadmin', true),
      updateAvatarBindingsSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
  for (const action of ['prepare', 'status'] as const)
    app.post(`/api/v1/assistant/messages/:id/video/${action}`, async (request) => ({
      data: await video[action](
        await auth.requireActor(request, undefined, true),
        z.object({ id: z.uuid() }).parse(request.params).id,
      ),
      requestId: request.id,
    }));
  app.get('/api/v1/assistant/messages/:id/video/media', async (request, reply) => {
    const bytes = await video.media(
        await auth.requireActor(request),
        z.object({ id: z.uuid() }).parse(request.params).id,
      ),
      range = request.headers.range;
    reply.type('video/mp4').header('accept-ranges', 'bytes');
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).header('content-range', `bytes */${bytes.length}`).send();
      const start = Number(m[1]),
        end = Math.min(m[2] ? Number(m[2]) : bytes.length - 1, bytes.length - 1);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= bytes.length
      )
        return reply.code(416).header('content-range', `bytes */${bytes.length}`).send();
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${bytes.length}`)
        .header('content-length', end - start + 1)
        .send(bytes.subarray(start, end + 1));
    }
    return reply.header('content-length', bytes.length).send(bytes);
  });
}
