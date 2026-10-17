import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reportQuerySchema, reportPageQuerySchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { ReportsService } from './service.js';
import { AppError } from '../../errors.js';
export async function registerReportRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: ReportsService,
) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/v1/reports/me', async (request) => {
    const actor = await auth.requireActor(request);
    if (actor.user.role !== 'student')
      throw new AppError(403, 'STUDENT_REQUIRED', 'Выберите ученика для просмотра отчёта.');
    return {
      data: await service.read(actor, actor.user.id, reportQuerySchema.parse(request.query)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/reports/:id', async (request) => ({
    data: await service.read(
      await auth.requireActor(request),
      id(request.params),
      reportQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/reports/:id/attempts', async (request) => ({
    data: await service.attempts(
      await auth.requireActor(request),
      id(request.params),
      reportPageQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/reports/:id/changes', async (request) => ({
    data: await service.changes(
      await auth.requireActor(request),
      id(request.params),
      reportPageQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/reports/:id/integrity', async (request) => ({
    data: await service.integrity(
      await auth.requireActor(request),
      id(request.params),
      reportPageQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
}
