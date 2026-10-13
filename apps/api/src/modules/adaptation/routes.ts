import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { planChangesQuerySchema, studentQuerySchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { AdaptationService } from './service.js';
export async function registerAdaptationRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new AdaptationService(auth.database);
  app.get('/api/v1/learning/skills', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await service.skills(actor, studentQuerySchema.parse(request.query).userId),
      requestId: request.id,
    };
  });
  app.get('/api/v1/plans/:id/history', async (request) => {
    const actor = await auth.requireActor(request),
      id = z.object({ id: z.uuid() }).parse(request.params).id;
    return {
      data: await service.history(actor, id, planChangesQuerySchema.parse(request.query)),
      requestId: request.id,
    };
  });
}
