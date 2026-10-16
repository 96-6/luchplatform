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
  endsAt: iso,
  timeZone: z.string(),
  status: z.enum(['scheduled', 'live', 'completed', 'cancelled']),
  revision: z.number().int().positive(),
  lobbyEnabled: z.boolean(),
  locked: z.boolean(),
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
  summaryComment: z.string().nullable(),
  summaryRevision: z.number().int().nonnegative(),
  members: z.array(person.extend({ role: z.enum(['organizer', 'student']), blocked: z.boolean() })),
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
      role: z.enum(['organizer', 'student', 'admin', 'superadmin']),
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
export const meetingMessagesSchema = z.object({
  items: z.array(
    z.object({ id: uuid, userId: uuid, name: z.string(), text: z.string(), createdAt: iso }),
  ),
  nextCursor: z.object({ createdAt: iso, id: uuid }).nullable(),
});
export const sendMeetingMessageSchema = z.strictObject({
  operationId: uuid,
  text: z.string().trim().min(1).max(2000),
});
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
