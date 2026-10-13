import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPlanSchema, plansQuerySchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { PlansService } from './service.js';

export async function registerPlanRoutes(
  app: FastifyInstance,
  auth: AuthService,
  prepare?: (
    actor: Awaited<ReturnType<AuthService['requireActor']>>,
    planId: string,
    assignmentId: string,
  ) => Promise<void>,
) {
  const service = new PlansService(auth.database, Date.now, prepare);
  app.get('/api/v1/plans', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await service.list(actor, plansQuerySchema.parse(request.query)),
      requestId: request.id,
    };
  });
  app.post('/api/v1/plans', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await service.generate(actor, createPlanSchema.parse(request.body).diagnosticId),
      requestId: request.id,
    };
  });
  app.get('/api/v1/plans/:id', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await service.read(actor, z.object({ id: z.uuid() }).parse(request.params).id),
      requestId: request.id,
    };
  });
  app.post('/api/v1/plans/:id/assignments/:assignmentId/start', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    const { id, assignmentId } = z
      .object({ id: z.uuid(), assignmentId: z.uuid() })
      .parse(request.params);
    z.strictObject({}).parse(request.body);
    return { data: await service.startAssignment(actor, id, assignmentId), requestId: request.id };
  });
}
