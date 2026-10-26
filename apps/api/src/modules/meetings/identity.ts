import type { FastifyRequest } from 'fastify';
import type { User } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { hashToken } from '../auth/crypto.js';
import { AppError } from '../../errors.js';
export type MeetingActor = {
  user: { id: string; name: string; role: User['role'] | 'guest' };
  tokenHash: string;
  sessionId: string;
};
export const isGuest = (actor: MeetingActor) => actor.user.role === 'guest';
export const guestCookie = (production: boolean, id: string) =>
  `${production ? '__Host-' : ''}luch_guest_${id}`;
export async function guestActor(
  auth: AuthService,
  request: FastifyRequest,
  meetingId: string,
  write = false,
): Promise<MeetingActor> {
  const value = request.cookies[guestCookie(auth.settings.APP_ENV === 'production', meetingId)];
  const row = value
    ? (
        await auth.database.query<{ id: string; full_name: string; token_hash: string }>(
          `SELECT g.* FROM meeting_guests g JOIN scheduled_meetings m ON m.id=g.meeting_id JOIN meeting_invites i ON i.id=g.invite_id WHERE g.meeting_id=$1 AND g.token_hash=$2 AND g.expires_at>now() AND i.allow_guests=true AND i.revoked_at IS NULL`,
          [meetingId, hashToken(value)],
        )
      ).rows[0]
    : null;
  if (!row)
    throw new AppError(
      401,
      'MEETING_GUEST_REQUIRED',
      'Откройте приглашение, чтобы войти во встречу.',
    );
  if (write) {
    const csrf = request.headers['x-meeting-csrf'];
    if (
      typeof csrf !== 'string' ||
      !auth.crypto.matches(csrf, auth.crypto.mac('meeting-guest:' + row.token_hash))
    )
      throw new AppError(403, 'INVALID_REQUEST', 'Обновите страницу и повторите действие.');
  }
  return {
    user: { id: row.id, name: row.full_name, role: 'guest' },
    tokenHash: row.token_hash,
    sessionId: row.id,
  };
}
export async function meetingActor(
  auth: AuthService,
  request: FastifyRequest,
  meetingId: string,
  write = false,
): Promise<MeetingActor> {
  const user = await auth.actor(request);
  if (user) return auth.requireActor(request, undefined, write);
  return guestActor(auth, request, meetingId, write);
}
