import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  prepareMeetingBanSchema,
  editMeetingBanSchema,
  confirmMeetingBanSchema,
  meetingIpBansQuerySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { MeetingsService } from './service.js';
import { MeetingBans } from './bans.js';
import { AppError } from '../../errors.js';
import { limitAttempts } from '../security/rate.js';
export async function registerMeetingBanRoutes(
  app: FastifyInstance,
  auth: AuthService,
  meetings: MeetingsService,
) {
  const service = new MeetingBans(auth.database),
    idOf = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  async function actor(r: Parameters<AuthService['requireActor']>[0], write = false) {
    const a = await auth.requireActor(r, undefined, write);
    if (!['teacher', 'admin', 'superadmin'].includes(a.user.role))
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
    if (write) await limitAttempts(auth.database, auth.crypto, `meeting-bans:${a.user.id}`, 120);
    return a;
  }
  app.get('/api/v1/meeting-ip-bans', async (r) => ({
    data: await service.list(await actor(r), meetingIpBansQuerySchema.parse(r.query)),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/ip-bans/prepare', async (r) => ({
    data: await service.prepareCreate(
      await actor(r, true),
      idOf(r.params),
      prepareMeetingBanSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meeting-ip-bans/:id/prepare', async (r) => ({
    data: await service.prepareEdit(
      await actor(r, true),
      idOf(r.params),
      editMeetingBanSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meeting-ip-bans/confirm', async (r) => {
    const data = await service.confirm(
      await actor(r, true),
      confirmMeetingBanSchema.parse(r.body).confirmationId,
    );
    await meetings.drain();
    return { data, requestId: r.id };
  });
}
