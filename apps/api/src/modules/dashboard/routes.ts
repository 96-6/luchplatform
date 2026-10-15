import type { FastifyInstance } from 'fastify';
import { dashboardQuerySchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { DashboardService } from './service.js';

export async function registerDashboardRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new DashboardService(auth.database);
  app.get('/api/v1/student/dashboard', async (request) => {
    const actor = await auth.requireActor(request);
    const query = dashboardQuerySchema.parse(request.query);
    return { data: await service.read(actor, query.timeZone), requestId: request.id };
  });
}
