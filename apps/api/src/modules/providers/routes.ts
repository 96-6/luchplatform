import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  providerIdSchema,
  updateAiCeilingsSchema,
  updateAiControlsSchema,
  updateProviderSchema,
  listeningRequestSchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { ProviderSettingsService } from './settings.js';
import { SpeechService } from './speech.js';
export async function registerProviderRoutes(
  app: FastifyInstance,
  auth: AuthService,
  settings: ProviderSettingsService,
  speech: SpeechService,
) {
  app.get('/api/v1/admin/providers', async (request) => {
    const actor = await auth.requireActor(request);
    return { data: await settings.read(actor), requestId: request.id };
  });
  app.post('/api/v1/admin/providers/controls', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await settings.updateControls(actor, updateAiControlsSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.post('/api/v1/admin/providers/ceilings', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await settings.updateCeilings(actor, updateAiCeilingsSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.post('/api/v1/admin/providers/:provider', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      id = z.object({ provider: providerIdSchema }).parse(request.params).provider;
    return {
      data: await settings.updateProvider(actor, id, updateProviderSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/admin/providers/requests', async (request) => {
    const actor = await auth.requireActor(request);
    return { data: await settings.requests(actor), requestId: request.id };
  });
  app.post('/api/v1/engine/runs/:id/steps/:stepId/listening', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = z.object({ id: z.uuid(), stepId: z.uuid() }).parse(request.params);
    return {
      data: await speech.prepare(
        actor,
        p.id,
        p.stepId,
        listeningRequestSchema.parse(request.body).operationId,
      ),
      requestId: request.id,
    };
  });
  app.get('/api/v1/engine/runs/:id/steps/:stepId/listening/:key', async (request, reply) => {
    const actor = await auth.requireActor(request),
      p = z
        .object({ id: z.uuid(), stepId: z.uuid(), key: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(request.params);
    const audio = await speech.audio(actor, p.id, p.stepId, p.key),
      range = request.headers.range;
    reply.type('audio/mpeg').header('accept-ranges', 'bytes');
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return reply.code(416).header('content-range', `bytes */${audio.length}`).send();
      const start = Number(match[1]),
        end = Math.min(match[2] ? Number(match[2]) : audio.length - 1, audio.length - 1);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= audio.length
      )
        return reply.code(416).header('content-range', `bytes */${audio.length}`).send();
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${audio.length}`)
        .header('content-length', end - start + 1)
        .send(audio.subarray(start, end + 1));
    }
    return reply.header('content-length', audio.length).send(audio);
  });
}
