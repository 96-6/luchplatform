import type { FastifyInstance } from 'fastify';
import { maintenanceInputSchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { OperationsService } from './service.js';
export async function registerOperationsRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: OperationsService,
) {
  app.get('/api/v1/operations', async (request) => ({
    data: await service.overview(await auth.requireActor(request)),
    requestId: request.id,
  }));
  app.post('/api/v1/operations/actions', async (request) => ({
    data: await service.execute(
      await auth.requireActor(request, undefined, true),
      maintenanceInputSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
}
