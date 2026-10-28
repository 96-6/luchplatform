import { AppError } from '../../errors.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import { MeetingInvites } from './invites.js';
import { meetingActor } from './identity.js';
import { fileAccess, MAX_MEETING_FILE_BYTES } from './files.js';
import { limitAttempts } from '../security/rate.js';
import { recordingPolicy, updateRecordingPolicy } from './recording-policy.js';
import {
  createAdhocMeetingSchema,
  updateMeetingInviteSchema,
  redeemMeetingInviteSchema,
  meetingFilePolicySchema,
  meetingRecordingPolicySchema,
  createMeetingSchema,
  updateMeetingSchema,
  meetingsQuerySchema,
  meetingOperationSchema,
  moderateMeetingSchema,
  deviceReportSchema,
  sendMeetingMessageSchema,
  meetingSummarySchema,
} from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import type { MeetingsService } from './service.js';
export async function registerMeetingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: MeetingsService,
  background = true,
) {
  const invites = new MeetingInvites(auth, service);
  app.addContentTypeParser('application/octet-stream', (_r, payload, done) => done(null, payload));
  const ids = z.object({ id: z.uuid() }),
    sessions = z.object({ id: z.uuid(), sid: z.uuid() });
  app.get('/api/v1/meetings/options', async (r) => ({
    data: await service.options(await auth.requireActor(r)),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings', async (r) => ({
    data: await service.list(await auth.requireActor(r), meetingsQuerySchema.parse(r.query)),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings', async (r) => ({
    data: await service.create(
      await auth.requireActor(r, undefined, true),
      createMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id', async (r) => ({
    data: await service.read(
      await meetingActor(auth, r, ids.parse(r.params).id),
      ids.parse(r.params).id,
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id', async (r) => ({
    data: await service.update(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      updateMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/join', async (r) => ({
    data: await service.join(
      await meetingActor(auth, r, ids.parse(r.params).id, true),
      ids.parse(r.params).id,
      meetingOperationSchema.parse(r.body).operationId,
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id/room-state', async (r) => ({
    data: await service.room(
      await meetingActor(auth, r, ids.parse(r.params).id),
      ids.parse(r.params).id,
      z.strictObject({ sessionId: z.uuid().optional() }).parse(r.query).sessionId,
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/moderate', async (r) => ({
    data: await service.moderate(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      moderateMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/sessions/:sid/token', async (r) => {
    const p = sessions.parse(r.params);
    z.strictObject({}).parse(r.body);
    return {
      data: await service.token(
        await meetingActor(auth, r, ids.parse(r.params).id, true),
        p.id,
        p.sid,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/leave', async (r) => {
    const p = sessions.parse(r.params);
    z.strictObject({}).parse(r.body);
    return {
      data: await service.leave(
        await meetingActor(auth, r, ids.parse(r.params).id, true),
        p.id,
        p.sid,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/hand', async (r) => {
    const p = sessions.parse(r.params);
    return {
      data: await service.hand(
        await meetingActor(auth, r, ids.parse(r.params).id, true),
        p.id,
        p.sid,
        z.strictObject({ raised: z.boolean() }).parse(r.body).raised,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/sessions/:sid/devices', async (r) => {
    const p = sessions.parse(r.params);
    return {
      data: await service.devices(
        await meetingActor(auth, r, ids.parse(r.params).id, true),
        p.id,
        p.sid,
        deviceReportSchema.parse(r.body),
      ),
      requestId: r.id,
    };
  });
  const page = z
    .strictObject({ beforeCreatedAt: z.iso.datetime().optional(), beforeId: z.uuid().optional() })
    .refine((x) => Boolean(x.beforeCreatedAt) === Boolean(x.beforeId));
  app.get('/api/v1/meetings/:id/messages', async (r) => {
    const q = page.parse(r.query);
    return {
      data: await service.messages(
        await meetingActor(auth, r, ids.parse(r.params).id),
        ids.parse(r.params).id,
        q.beforeCreatedAt && q.beforeId
          ? { createdAt: q.beforeCreatedAt, id: q.beforeId }
          : undefined,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/messages', async (r) => {
    const p = sendMeetingMessageSchema.parse(r.body);
    return {
      data: await service.send(
        await meetingActor(auth, r, ids.parse(r.params).id, true),
        ids.parse(r.params).id,
        p.operationId,
        p.text,
        p.attachmentIds,
      ),
      requestId: r.id,
    };
  });
  app.post('/api/v1/meetings/:id/summary', { bodyLimit: 192 * 1024 }, async (r) => ({
    data: await service.summary(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      meetingSummarySchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/adhoc', async (r) => ({
    data: await invites.create(
      await auth.requireActor(r, undefined, true),
      createAdhocMeetingSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id/invite', async (r) => ({
    data: await invites.read(await auth.requireActor(r), ids.parse(r.params).id),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/invite', async (r) => ({
    data: await invites.update(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      updateMeetingInviteSchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.post('/api/v1/meetings/:id/invite/restart', async (r) => ({
    data: await invites.restart(
      await auth.requireActor(r, undefined, true),
      ids.parse(r.params).id,
      meetingOperationSchema.parse(r.body).operationId,
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meeting-invites/preview', async (r) => {
    const q = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(r.query);
    await limitAttempts(auth.database, auth.crypto, `meeting-preview:${r.ip}`, 120);
    return { data: await invites.preview(q.token), requestId: r.id };
  });
  app.post('/api/v1/meeting-invites/redeem', async (r, reply) => {
    await limitAttempts(auth.database, auth.crypto, `meeting-invite:${r.ip}`, 60);
    return {
      data: await invites.redeem(r, reply, redeemMeetingInviteSchema.parse(r.body)),
      requestId: r.id,
    };
  });
  app.get('/api/v1/meeting-guests/:id/session', async (r) => ({
    data: await invites.guestSession(r, ids.parse(r.params).id),
    requestId: r.id,
  }));
  app.get('/api/v1/admin/meeting-recording-policy', async (r) => {
    await auth.requireActor(r, 'superadmin');
    return { data: await recordingPolicy(auth.database), requestId: r.id };
  });
  app.post('/api/v1/admin/meeting-recording-policy', async (r) => ({
    data: await updateRecordingPolicy(
      auth.database,
      await auth.requireActor(r, 'superadmin', true),
      meetingRecordingPolicySchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/admin/meeting-file-policy', async (r) => {
    await auth.requireActor(r, 'superadmin');
    return { data: await service.files!.policy(), requestId: r.id };
  });
  app.post('/api/v1/admin/meeting-file-policy', async (r) => ({
    data: await service.files!.updatePolicy(
      await auth.requireActor(r, 'superadmin', true),
      meetingFilePolicySchema.parse(r.body),
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/meetings/:id/file-policy', async (r) => {
    const id = ids.parse(r.params).id;
    await fileAccess(auth.database, await meetingActor(auth, r, id), id);
    return { data: await service.files!.policy(), requestId: r.id };
  });
  app.post(
    '/api/v1/meetings/:id/files/:fid',
    {
      bodyLimit: MAX_MEETING_FILE_BYTES,
      onRequest: async (r) => {
        if (
          r.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
          'application/octet-stream'
        )
          throw new AppError(415, 'MEETING_FILE_FORMAT', 'Неподдерживаемый формат загрузки файла.');
      },
    },
    async (r) => {
      const { id, fid } = z.object({ id: z.uuid(), fid: z.uuid() }).parse(r.params),
        actor = await meetingActor(auth, r, id, true);
      await limitAttempts(auth.database, auth.crypto, `meeting-upload:${actor.user.id}`, 60);
      const raw = z.string().max(2400).parse(r.headers['x-file-name']);
      let filename: string;
      try {
        filename = decodeURIComponent(raw);
      } catch {
        throw new AppError(400, 'MEETING_FILE_NAME', 'Некорректное имя файла.');
      }
      const length =
        r.headers['content-length'] === undefined ? undefined : Number(r.headers['content-length']);
      return {
        data: await service.files!.upload(actor, id, fid, filename, r.body as Readable, length),
        requestId: r.id,
      };
    },
  );
  app.get('/api/v1/meetings/:id/files/:fid', async (r, reply) => {
    const { id, fid } = z.object({ id: z.uuid(), fid: z.uuid() }).parse(r.params);
    const { file, stream } = await service.files!.download(
      await meetingActor(auth, r, id),
      id,
      fid,
    );
    const image = file.media_type.startsWith('image/');
    reply
      .header('content-length', String(file.size_bytes))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header(
        'content-disposition',
        `${image ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`,
      )
      .type(file.media_type);
    return reply.send(stream);
  });
  let inFlight: Promise<void> | null = null;
  const recover = () => {
    if (inFlight) return;
    inFlight = service
      .recover()
      .catch(() => {
        app.log.warn('Video meeting recovery will retry.');
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = background ? setInterval(recover, 10000) : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await inFlight;
  });
}
