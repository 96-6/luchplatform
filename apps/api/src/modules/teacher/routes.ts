import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  learningPageQuerySchema,
  saveTeacherReviewSchema,
  teacherAssignmentSchema,
  teacherAssignmentUpdateSchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { TeacherService } from './service.js';
export async function registerTeacherRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new TeacherService(auth.database),
    id = z.object({ id: z.uuid() });
  app.get('/api/v1/learning/attempts', async (request) => ({
    data: await service.attempts(
      await auth.requireActor(request),
      learningPageQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/learning/attempts/:id', async (request) => ({
    data: await service.detail(
      await auth.requireActor(request),
      id.parse(request.params).id,
      z
        .strictObject({ beforeRevision: z.coerce.number().int().positive().optional() })
        .parse(request.query).beforeRevision,
    ),
    requestId: request.id,
  }));
  app.post('/api/v1/teacher/attempts/:id/reviews', async (request) => ({
    data: await service.review(
      await auth.requireActor(request, undefined, true),
      id.parse(request.params).id,
      saveTeacherReviewSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
  app.get('/api/v1/plans/:id/exercise-bank', async (request) => ({
    data: await service.bank(await auth.requireActor(request), id.parse(request.params).id),
    requestId: request.id,
  }));
  app.post('/api/v1/teacher/plans/:id/assignments', async (request) => ({
    data: await service.assign(
      await auth.requireActor(request, undefined, true),
      id.parse(request.params).id,
      teacherAssignmentSchema.parse(request.body),
    ),
    requestId: request.id,
  }));
  app.post('/api/v1/teacher/plans/:planId/assignments/:id', async (request) => {
    const p = z.object({ id: z.uuid(), planId: z.uuid() }).parse(request.params);
    return {
      data: await service.updateAssignment(
        await auth.requireActor(request, undefined, true),
        p.planId,
        p.id,
        teacherAssignmentUpdateSchema.parse(request.body),
      ),
      requestId: request.id,
    };
  });
  app.get('/api/v1/learning/teacher-updates', async (request) => ({
    data: await service.updates(
      await auth.requireActor(request),
      learningPageQuerySchema.parse(request.query),
    ),
    requestId: request.id,
  }));
}
