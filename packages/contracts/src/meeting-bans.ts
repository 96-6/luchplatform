import { z } from 'zod';
export const MEETING_BAN_HOLD_MS = 5000;
const reason = z.string().trim().min(1).max(1000);
const ip = z.string().trim().min(2).max(64);
export const prepareMeetingBanSchema = z
  .strictObject({
    operationId: z.uuid(),
    sessionId: z.uuid().optional(),
    ip: ip.optional(),
    reason,
  })
  .refine(
    (x) => Boolean(x.sessionId) !== Boolean(x.ip),
    'Выберите гостя или укажите один IP-адрес.',
  );
export const editMeetingBanSchema = z.strictObject({
  operationId: z.uuid(),
  revision: z.number().int().positive(),
  ip,
  reason,
  active: z.boolean(),
});
export const confirmMeetingBanSchema = z.strictObject({ confirmationId: z.uuid() });
export const meetingBanConfirmationSchema = z.object({
  id: z.uuid(),
  ip: z.string(),
  targetName: z.string(),
  readyAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
const person = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
const state = z.object({
  ip: z.string(),
  reason: z.string(),
  active: z.boolean(),
  targetName: z.string(),
});
export const meetingIpBanSchema = z.object({
  id: z.uuid(),
  meetingId: z.uuid(),
  meetingTitle: z.string(),
  inviteId: z.uuid().nullable(),
  ip: z.string(),
  targetName: z.string(),
  owner: person,
  reason: z.string(),
  active: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  updatedBy: person,
  canEdit: z.boolean(),
  history: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['created', 'updated', 'revoked', 'reactivated']),
      actor: person,
      before: state.nullable(),
      after: state,
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const meetingIpBansQuerySchema = z
  .strictObject({
    meetingId: z.uuid().optional(),
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .refine((x) => Boolean(x.beforeId) === Boolean(x.beforeCreatedAt));
export const meetingIpBansPageSchema = z.object({
  items: z.array(meetingIpBanSchema),
  nextCursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable(),
});
export type MeetingIpBan = z.infer<typeof meetingIpBanSchema>;
