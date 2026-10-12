import { createProbeSchema } from '@luch/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/database.js';
import { listProbes, saveProbe } from './service.js';

export async function registerProbeRoutes(app: FastifyInstance, database: Database): Promise<void> {
  app.get('/api/v1/dev/records', async (request) => ({
    data: await listProbes(database),
    requestId: request.id,
  }));
  app.post('/api/v1/dev/records', async (request, reply) => {
    const input = createProbeSchema.parse(request.body);
    const result = await saveProbe(database, input);
    return reply
      .code(result.created ? 201 : 200)
      .send({ data: result.record, requestId: request.id });
  });
}
