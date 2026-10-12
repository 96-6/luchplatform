import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  hintRequestSchema,
  runsQuerySchema,
  saveDraftSchema,
  startRunSchema,
  submitAnswerSchema,
  turnActionSchema,
  integrityPacketSchema,
  integrityPolicySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { LuchEngine } from './service.js';
import { audit } from '../accounts/repository.js';
import { integrityPolicy, receiveIntegrity, setIntegrityPolicy } from './integrity.js';

export async function registerEngineRoutes(app: FastifyInstance, auth: AuthService) {
  const engine = new LuchEngine(auth.database);
  const idOf = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.post('/api/v1/engine/runs/:id/integrity', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await receiveIntegrity(
        auth.database,
        actor,
        idOf(request.params),
        integrityPacketSchema.parse(request.body),
      ),
      requestId: request.id,
    };
  });
  app.get('/api/v1/admin/engine/integrity-policy', async (request) => {
    await auth.requireActor(request, 'superadmin');
    return { data: await integrityPolicy(auth.database), requestId: request.id };
  });
  app.post('/api/v1/admin/engine/integrity-policy', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    return {
      data: await setIntegrityPolicy(
        auth.database,
        actor,
        integrityPolicySchema.parse(request.body).enabled,
      ),
      requestId: request.id,
    };
  });
  app.post('/api/v1/engine/runs', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await engine.start(actor, startRunSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/engine/runs', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await engine.list(actor, runsQuerySchema.parse(request.query)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/engine/runs/:id', async (request) => {
    const actor = await auth.requireActor(request);
    const view = await engine.repository.view(actor, idOf(request.params));
    if (actor.user.role === 'superadmin')
      await audit(auth.database, actor.user.id, 'learning.debug_view', view.run.user.id);
    return {
      data: view,
      requestId: request.id,
    };
  });
  for (const action of ['save', 'resume', 'hint', 'answer', 'next', 'retry'] as const)
    app.post(`/api/v1/engine/runs/:id/${action}`, async (request) => {
      const actor = await auth.requireActor(request, undefined, true),
        id = idOf(request.params);
      const input = request.body;
      const data =
        action === 'save'
          ? await engine.save(actor, id, saveDraftSchema.parse(input))
          : action === 'answer'
            ? await engine.answer(actor, id, submitAnswerSchema.parse(input))
            : action === 'hint'
              ? await engine.hint(
                  actor,
                  id,
                  hintRequestSchema.parse(input).turnId,
                  hintRequestSchema.parse(input).index,
                )
              : await engine[action](actor, id, turnActionSchema.parse(input).turnId);
      return { data, requestId: request.id };
    });
}
