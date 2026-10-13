import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  saveQuestionnaireSchema,
  studentQuerySchema,
  startDiagnosticSchema,
  diagnosticsQuerySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { DiagnosticsService } from './service.js';

export async function registerDiagnosticRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new DiagnosticsService(auth.database);
  app.get('/api/v1/learning/profile', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await service.profiles.read(actor, studentQuerySchema.parse(request.query).userId),
      requestId: request.id,
    };
  });
  app.post('/api/v1/learning/profile', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await service.profiles.save(actor, saveQuestionnaireSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.post('/api/v1/diagnostics', async (request) => {
    const actor = await auth.requireActor(request, undefined, true);
    return {
      data: await service.start(actor, startDiagnosticSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/diagnostics', async (request) => {
    const actor = await auth.requireActor(request);
    return {
      data: await service.list(actor, diagnosticsQuerySchema.parse(request.query)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/diagnostics/:id', async (request) => {
    const actor = await auth.requireActor(request);
    const id = z.object({ id: z.uuid() }).parse(request.params).id;
    return { data: await service.read(actor, id), requestId: request.id };
  });
}
