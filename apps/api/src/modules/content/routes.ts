import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTENT_MAX_BYTES, contentIdSchema, exercisePurposeSchema } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { ContentService } from './service.js';

const paramsSchema = z.object({ packageId: contentIdSchema, id: contentIdSchema });
const querySchema = z.strictObject({
  packageVersion: z.coerce.number().int().min(1).max(1_000_000).optional(),
  purpose: exercisePurposeSchema.optional(),
});
export async function registerContentRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new ContentService(auth.database);
  const repository = service.repository;
  app.get('/api/v1/content/routes', async (request) => {
    await auth.requireActor(request);
    return { data: await repository.catalog(), requestId: request.id };
  });
  for (const kind of ['routes', 'lessons', 'sets'] as const) {
    app.get(`/api/v1/content/packages/:packageId/${kind}/:id`, async (request) => {
      await auth.requireActor(request);
      const { packageId, id } = paramsSchema.parse(request.params);
      const query = querySchema.parse(request.query);
      const data =
        kind === 'routes'
          ? await repository.route(packageId, id, query.packageVersion)
          : kind === 'lessons'
            ? await repository.lesson(
                packageId,
                id,
                query.purpose ?? 'practice',
                query.packageVersion,
              )
            : await repository.set(packageId, id, query.packageVersion);
      return { data, requestId: request.id };
    });
  }
  app.get('/api/v1/admin/content/packages', async (request) => {
    await auth.requireActor(request, 'superadmin');
    return { data: await repository.packages(), requestId: request.id };
  });
  app.get('/api/v1/admin/content/packages/:packageId/export', async (request) => {
    await auth.requireActor(request, 'superadmin');
    const { packageId } = z.object({ packageId: contentIdSchema }).parse(request.params);
    const { packageVersion } = querySchema.parse(request.query);
    return { data: await service.export(packageId, packageVersion), requestId: request.id };
  });
  app.post('/api/v1/admin/content/import', { bodyLimit: CONTENT_MAX_BYTES }, async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    return { data: await service.import(request.body, actor.user.id), requestId: request.id };
  });
}
