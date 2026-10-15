import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  speechUploadSchema,
  speechConfirmSchema,
  speechTextSchema,
  speechRetrySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { VoiceService } from './service.js';
import { AssistantAudioService } from './audio.js';
const runParams = z.object({ runId: z.uuid() }),
  inputParams = runParams.extend({ id: z.uuid() });
export async function registerVoiceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  voice: VoiceService,
  audio: AssistantAudioService,
) {
  app.get('/api/v1/engine/runs/:runId/speech', async (request) => {
    const actor = await auth.requireActor(request),
      p = runParams.parse(request.params);
    return { data: await voice.session(actor, p.runId), requestId: request.id };
  });
  app.post('/api/v1/engine/runs/:runId/speech/inputs', { bodyLimit: 1400000 }, async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = runParams.parse(request.params);
    return {
      data: await voice.upload(actor, p.runId, speechUploadSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.post('/api/v1/engine/runs/:runId/speech/text', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = runParams.parse(request.params);
    return {
      data: await voice.text(actor, p.runId, speechTextSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/engine/runs/:runId/speech/inputs/:id', async (request) => {
    const actor = await auth.requireActor(request),
      p = inputParams.parse(request.params);
    return { data: await voice.read(actor, p.runId, p.id), requestId: request.id };
  });
  app.get('/api/v1/engine/runs/:runId/speech/inputs/:id/result', async (request) => {
    const actor = await auth.requireActor(request),
      p = inputParams.parse(request.params);
    return { data: await voice.result(actor, p.runId, p.id), requestId: request.id };
  });
  app.post('/api/v1/engine/runs/:runId/speech/inputs/:id/retry', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = inputParams.parse(request.params);
    return {
      data: await voice.retry(
        actor,
        p.runId,
        p.id,
        speechRetrySchema.parse(request.body).operationId,
      ),
      requestId: request.id,
    };
  });
  app.post('/api/v1/engine/runs/:runId/speech/inputs/:id/discard', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = inputParams.parse(request.params);
    z.strictObject({}).parse(request.body);
    return { data: await voice.discard(actor, p.runId, p.id), requestId: request.id };
  });
  app.post('/api/v1/engine/runs/:runId/speech/inputs/:id/confirm', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      p = inputParams.parse(request.params);
    return {
      data: await voice.confirm(actor, p.runId, p.id, speechConfirmSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/assistant/messages/:id/audio', async (request) => {
    const actor = await auth.requireActor(request),
      { id } = z.object({ id: z.uuid() }).parse(request.params);
    return { data: await audio.status(actor, id), requestId: request.id };
  });
  app.post('/api/v1/assistant/messages/:id/audio', async (request) => {
    const actor = await auth.requireActor(request, undefined, true),
      { id } = z.object({ id: z.uuid() }).parse(request.params);
    return {
      data: await audio.prepare(actor, id, speechRetrySchema.parse(request.body).operationId),
      requestId: request.id,
    };
  });
  app.get('/api/v1/assistant/messages/:id/audio/:key', async (request, reply) => {
    const actor = await auth.requireActor(request),
      p = z.object({ id: z.uuid(), key: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    const bytes = await audio.audio(actor, p.id, p.key),
      range = request.headers.range;
    reply.type('audio/mpeg').header('accept-ranges', 'bytes');
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
