import { z } from 'zod';
const uuid = z.uuid(),
  iso = z.iso.datetime();
export const meetingTimeZone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Неизвестный часовой пояс.');
const person = z.object({ id: uuid, name: z.string(), email: z.string() });
export const meetingDraftSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(3000).default(''),
    language: z.enum(['ru', 'en']),
    startsAt: iso,
    endsAt: iso,
    timeZone: meetingTimeZone,
    organizerId: uuid,
    coorganizerIds: z.array(uuid).max(5).default([]),
    studentIds: z.array(uuid).min(1).max(50),
    lobbyEnabled: z.boolean().default(true),
  })
  .refine(
    (x) =>
      new Date(x.endsAt).getTime() > new Date(x.startsAt).getTime() &&
      new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime() <= 8 * 3600000,
    'Продолжительность занятия — от одной минуты до восьми часов.',
  )
  .refine(
    (x) =>
      new Set(x.studentIds).size === x.studentIds.length &&
      new Set([x.organizerId, ...x.coorganizerIds]).size === x.coorganizerIds.length + 1,
    'Участники не должны повторяться.',
  );
export const createMeetingSchema = meetingDraftSchema.safeExtend({ operationId: uuid });
export const updateMeetingSchema = meetingDraftSchema.safeExtend({
  operationId: uuid,
  revision: z.number().int().positive(),
});
export const meetingOperationSchema = z.strictObject({ operationId: uuid });
export const meetingSchema = z.object({
  id: uuid,
  title: z.string(),
  description: z.string(),
  language: z.enum(['ru', 'en']),
  organizer: person,
  startsAt: iso,
  endsAt: iso.nullable(),
  kind: z.enum(['scheduled', 'adhoc']),
  durationMinutes: z.number().int().nullable(),
  timeZone: z.string(),
  status: z.enum(['scheduled', 'live', 'completed', 'cancelled']),
  revision: z.number().int().positive(),
  lobbyEnabled: z.boolean(),
  locked: z.boolean(),
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  summaryComment: z.string().nullable(),
  summaryRevision: z.number().int().nonnegative(),
  members: z.array(
    person.extend({
      role: z.enum(['organizer', 'student', 'participant', 'guest']),
      blocked: z.boolean(),
    }),
  ),
  canManage: z.boolean(),
  canInspect: z.boolean(),
  canJoin: z.boolean(),
  videoConfigured: z.boolean(),
  homework: z.array(
    z.object({
      id: uuid,
      studentId: uuid,
      studentName: z.string(),
      assignmentId: uuid,
      planId: uuid,
      title: z.string(),
      reason: z.string(),
      dueAt: iso.nullable(),
    }),
  ),
  summaryHistory: z.array(
    z.object({ id: uuid, comment: z.string(), author: z.string(), createdAt: iso }),
  ),
});
export const meetingsPageSchema = z.object({
  items: z.array(meetingSchema),
  nextCursor: z.object({ startsAt: iso, id: uuid }).nullable(),
});
export const meetingOptionsSchema = z.object({
  students: z.array(person),
  organizers: z.array(person.extend({ role: z.enum(['teacher', 'admin', 'superadmin']) })),
});
export const meetingsQuerySchema = z
  .strictObject({
    from: iso,
    to: iso,
    beforeStartsAt: iso.optional(),
    beforeId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .refine(
    (x) => Boolean(x.beforeStartsAt) === Boolean(x.beforeId),
    'Поля курсора требуются вместе.',
  )
  .refine(
    (x) =>
      new Date(x.to).getTime() > new Date(x.from).getTime() &&
      new Date(x.to).getTime() - new Date(x.from).getTime() <= 93 * 86400000,
    'Выберите период не более трёх месяцев.',
  );
export const meetingSessionSchema = z.object({
  id: uuid,
  state: z.enum(['waiting', 'admitted', 'left', 'removed']),
  handRaisedAt: iso.nullable(),
  deviceRevision: z.number().int().nonnegative().default(0),
  audioAllowed: z.boolean(),
  videoAllowed: z.boolean(),
  screenAllowed: z.boolean(),
});
export const joinMeetingSchema = z.object({
  session: meetingSessionSchema,
  meeting: meetingSchema,
});
export const meetingTokenSchema = z.object({
  token: z.string(),
  serverUrl: z.string(),
  identity: uuid,
  expiresAt: iso,
});
export const deviceReportSchema = z.strictObject({
  revision: z.number().int().positive(),
  camera: z
    .strictObject({ label: z.string().trim().max(300), trackSid: z.string().min(1).max(100) })
    .nullable(),
  microphone: z
    .strictObject({ label: z.string().trim().max(300), trackSid: z.string().min(1).max(100) })
    .nullable(),
});
export const deviceWarningSchema = z.object({
  kind: z.enum(['camera', 'microphone']),
  label: z.string(),
  match: z.string(),
  reportedAt: iso,
});
export const roomStateSchema = z.object({
  meeting: meetingSchema,
  self: meetingSessionSchema.nullable(),
  available: z.boolean(),
  pendingCommands: z.number().int().nonnegative(),
  participants: z.array(
    z.object({
      identity: uuid,
      userId: uuid,
      name: z.string(),
      role: z.enum(['organizer', 'student', 'admin', 'superadmin', 'participant', 'guest']),
      handRaisedAt: iso.nullable(),
      audioAllowed: z.boolean(),
      videoAllowed: z.boolean(),
      screenAllowed: z.boolean(),
      warnings: z.array(deviceWarningSchema),
      deviceReportedAt: iso.nullable(),
    }),
  ),
  waiting: z.array(z.object({ identity: uuid, userId: uuid, name: z.string(), createdAt: iso })),
});
export const moderateMeetingSchema = z.strictObject({
  operationId: uuid,
  action: z.enum([
    'admit',
    'kick',
    'restore',
    'mute_audio',
    'allow_audio',
    'disable_video',
    'allow_video',
    'stop_screen',
    'allow_screen',
    'lower_hand',
    'mute_all',
    'lock',
    'unlock',
    'end',
    'cancel',
  ]),
  targetId: uuid.optional(),
  revision: z.number().int().positive().optional(),
});
export const meetingFileSchema = z.object({
  id: uuid,
  filename: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number(),
  expiresAt: iso.nullable(),
  deleted: z.boolean(),
  url: z.string(),
});
export const meetingFilePolicySchema = z
  .strictObject({
    maxFileMb: z.number().int().min(1).max(1024),
    largeFileMb: z.number().int().min(0).max(1024),
    retentionDays: z.number().int().min(1).max(3650),
    revision: z.number().int().positive(),
  })
  .refine(
    (x) => x.largeFileMb <= x.maxFileMb,
    'Порог временного хранения не должен превышать максимальный размер файла.',
  );
export const meetingMessagesSchema = z.object({
  items: z.array(
    z.object({
      id: uuid,
      userId: uuid,
      name: z.string(),
      text: z.string(),
      createdAt: iso,
      attachments: z.array(meetingFileSchema),
    }),
  ),
  nextCursor: z.object({ createdAt: iso, id: uuid }).nullable(),
});
export const sendMeetingMessageSchema = z
  .strictObject({
    operationId: uuid,
    text: z.string().trim().max(2000),
    attachmentIds: z.array(uuid).max(5).default([]),
  })
  .refine((x) => x.text.length > 0 || x.attachmentIds.length > 0, 'Добавьте текст или файл.');
export const meetingSummarySchema = z
  .strictObject({
    operationId: uuid,
    revision: z.number().int().nonnegative(),
    comment: z.string().trim().min(1).max(3000),
    homework: z
      .array(
        z.strictObject({
          studentId: uuid,
          planId: uuid,
          exerciseId: z.string().min(1).max(120),
          reason: z.string().trim().min(1).max(2700),
          dueAt: iso.nullable(),
        }),
      )
      .max(50)
      .default([]),
  })
  .refine(
    (x) =>
      new Set(x.homework.map((h) => `${h.studentId}:${h.planId}:${h.exerciseId}`)).size ===
      x.homework.length,
    'Домашнее задание повторяется.',
  );
export type Meeting = z.infer<typeof meetingSchema>;
export type MeetingSession = z.infer<typeof meetingSessionSchema>;
export type MeetingRoomState = z.infer<typeof roomStateSchema>;

export const createAdhocMeetingSchema = z.strictObject({
  operationId: uuid,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(3000).default(''),
  language: z.enum(['ru', 'en']),
  startsAt: iso.optional(),
  timeZone: meetingTimeZone,
  durationMinutes: z.number().int().min(1).max(10080).nullable(),
  reusable: z.boolean(),
  allowGuests: z.boolean(),
  expiresAt: iso.nullable(),
  lobbyEnabled: z.boolean().default(true),
});
export const updateMeetingInviteSchema = z.strictObject({
  operationId: uuid,
  revision: z.number().int().positive(),
  allowGuests: z.boolean(),
  expiresAt: iso.nullable(),
  revoked: z.boolean(),
});
export const meetingInviteSchema = z.object({
  id: uuid,
  meetingId: uuid,
  url: z.string(),
  reusable: z.boolean(),
  allowGuests: z.boolean(),
  expiresAt: iso.nullable(),
  revoked: z.boolean(),
  used: z.boolean(),
  revision: z.number().int().positive(),
});
export const adhocResultSchema = z.object({ meeting: meetingSchema, invite: meetingInviteSchema });
export const meetingInvitePreviewSchema = z.object({
  title: z.string(),
  organizer: z.string(),
  startsAt: iso,
  endsAt: iso.nullable(),
  status: meetingSchema.shape.status,
  allowGuests: z.boolean(),
  reusable: z.boolean(),
  expiresAt: iso.nullable(),
});
export const redeemMeetingInviteSchema = z.strictObject({
  operationId: uuid,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(100).optional(),
});
export const meetingGuestSessionSchema = z.object({
  id: uuid,
  name: z.string(),
  meetingId: uuid,
  csrfToken: z.string(),
  admitted: z.boolean(),
  expiresAt: iso,
});
export const redeemMeetingInviteResultSchema = z.object({
  meetingId: uuid,
  guest: meetingGuestSessionSchema.nullable(),
  path: z.string(),
});
