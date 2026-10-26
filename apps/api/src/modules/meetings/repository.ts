import { randomUUID } from 'node:crypto';
import { meetingSchema, type Meeting } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { isGuest, type MeetingActor } from './identity.js';
import { canonicalJson } from '../content/service.js';
export const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
export type MeetingRow = {
  id: string;
  title: string;
  description: string;
  language: 'ru' | 'en';
  organizer_id: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  kind: 'scheduled' | 'adhoc';
  duration_minutes: number | null;
  time_zone: string;
  status: Meeting['status'];
  revision: number;
  room_name: string;
  lobby_enabled: boolean;
  locked: boolean;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  summary_comment: string | null;
  summary_revision: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};
export type MemberRow = {
  user_id: string;
  role: 'organizer' | 'student' | 'participant' | 'guest';
  admitted_at?: Date | string | null;
  blocked_at: Date | string | null;
  audio_allowed: boolean;
  video_allowed: boolean;
  screen_allowed: boolean;
  full_name: string;
  email: string;
};
export type SessionRow = {
  id: string;
  meeting_id: string;
  user_id: string;
  guest_id?: string | null;
  state: 'waiting' | 'admitted' | 'left' | 'removed';
  hand_raised_at: Date | string | null;
  created_at: Date | string;
  first_connected_at: Date | string | null;
  last_seen_at: Date | string | null;
  ended_at: Date | string | null;
  device_revision?: number;
};
export async function access(tx: QueryExecutor, actor: MeetingActor, id: string, lock = false) {
  const m = (
    await tx.query<MeetingRow>(
      `SELECT * FROM scheduled_meetings WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'Занятие не найдено.');
  const members = (
    await tx.query<MemberRow>(
      `SELECT p.*,u.full_name,u.email FROM meeting_members p JOIN users u ON u.id=p.user_id WHERE p.meeting_id=$1 ORDER BY p.role,u.full_name,p.user_id`,
      [id],
    )
  ).rows;
  const guests = (
    await tx.query<MemberRow>(
      "SELECT g.id AS user_id,'guest' AS role,g.blocked_at,g.audio_allowed,g.video_allowed,g.screen_allowed,g.full_name,'' AS email,g.admitted_at FROM meeting_guests g WHERE g.meeting_id=$1 ORDER BY g.created_at,g.id",
      [id],
    )
  ).rows;
  members.push(...guests);
  const member = members.find((p) => p.user_id === actor.user.id);
  const global = actor.user.role === 'admin' || actor.user.role === 'superadmin';
  if (!member && !global) throw new AppError(404, 'MEETING_NOT_FOUND', 'Занятие не найдено.');
  return {
    m,
    members,
    member,
    canManage: global || (member?.role === 'organizer' && actor.user.role === 'teacher'),
    canInspect:
      actor.user.role === 'superadmin' ||
      (member?.role === 'organizer' && ['teacher', 'admin'].includes(actor.user.role)),
  };
}
export type MeetingAccess = Awaited<ReturnType<typeof access>>;
export function requireManager(a: MeetingAccess) {
  if (!a.canManage)
    throw new AppError(
      403,
      'MEETING_ORGANIZER_REQUIRED',
      'Действие доступно организатору или администратору.',
    );
}
export async function viewMeeting(
  tx: QueryExecutor,
  a: MeetingAccess,
  configured: boolean,
  now: number,
) {
  const organizer = (
    await tx.query<{ id: string; full_name: string; email: string }>(
      'SELECT id,full_name,email FROM users WHERE id=$1',
      [a.m.organizer_id],
    )
  ).rows[0]!;
  const homework = (
    await tx.query<{
      id: string;
      student_id: string;
      full_name: string;
      assignment_id: string;
      plan_id: string;
      title: string;
      reason: { text: string };
      due_at: Date | string | null;
    }>(
      `SELECT h.*,u.full_name,a.plan_id,a.reason,a.due_at,l.definition->>'title' AS title FROM meeting_homework h JOIN users u ON u.id=h.student_id JOIN plan_assignments a ON a.id=h.assignment_id JOIN learning_lessons l ON l.package_id=a.package_id AND l.package_version=a.package_version AND l.id=a.lesson_id WHERE h.meeting_id=$1 AND ($2 OR h.student_id=$3) ORDER BY h.created_at,h.id`,
      [a.m.id, a.canManage, a.member?.user_id ?? null],
    )
  ).rows;
  const history = (
    await tx.query<{
      id: string;
      request: { comment: string };
      full_name: string;
      created_at: Date | string;
    }>(
      `SELECT o.id,o.request,u.full_name,o.created_at FROM meeting_operations o JOIN users u ON u.id=o.actor_id WHERE o.meeting_id=$1 AND o.kind='summary' ORDER BY o.created_at DESC,o.id DESC LIMIT 30`,
      [a.m.id],
    )
  ).rows;
  const alreadyJoined =
    (
      await tx.query(
        "SELECT 1 FROM meeting_sessions WHERE meeting_id=$1 AND COALESCE(user_id,guest_id)=$2 AND state IN ('waiting','admitted')",
        [a.m.id, a.member?.user_id ?? null],
      )
    ).rows.length > 0;
  return meetingSchema.parse({
    id: a.m.id,
    title: a.m.title,
    description: a.m.description,
    language: a.m.language,
    organizer: {
      id: organizer.id,
      name: organizer.full_name,
      email: a.member?.role === 'guest' ? '' : organizer.email,
    },
    startsAt: iso(a.m.starts_at),
    endsAt: iso(a.m.ends_at),
    kind: a.m.kind,
    durationMinutes: a.m.duration_minutes,
    timeZone: a.m.time_zone,
    status: a.m.status,
    revision: a.m.revision,
    lobbyEnabled: a.m.lobby_enabled,
    locked: a.m.locked,
    startedAt: iso(a.m.started_at),
    endedAt: iso(a.m.ended_at),
    summaryComment:
      a.member?.role === 'guest' && !a.member.admitted_at ? null : a.m.summary_comment,
    summaryRevision: a.m.summary_revision,
    members: a.members
      .filter(
        (p) =>
          a.member?.role !== 'guest' ||
          a.member.admitted_at ||
          p.role === 'organizer' ||
          p.user_id === a.member.user_id,
      )
      .map((p) => ({
        id: p.user_id,
        name: p.full_name,
        email: a.member?.role === 'guest' ? '' : p.email,
        role: p.role,
        blocked: Boolean(p.blocked_at),
      })),
    canManage: a.canManage,
    canInspect: a.canInspect,
    canJoin:
      ['scheduled', 'live'].includes(a.m.status) &&
      !a.member?.blocked_at &&
      (a.canManage ||
        ((alreadyJoined || !a.m.locked) && now >= new Date(a.m.starts_at).getTime() - 900000)) &&
      now <= deadline(a.m),
    videoConfigured: configured,
    homework: (a.member?.role === 'guest' ? [] : homework).map((h) => ({
      id: h.id,
      studentId: h.student_id,
      studentName: h.full_name,
      assignmentId: h.assignment_id,
      planId: h.plan_id,
      title: h.title,
      reason: h.reason.text,
      dueAt: iso(h.due_at),
    })),
    summaryHistory: (a.member?.role === 'guest' && !a.member.admitted_at ? [] : history).map(
      (h) => ({
        id: h.id,
        comment: h.request.comment,
        author: h.full_name,
        createdAt: iso(h.created_at),
      }),
    ),
  });
}
export async function oldOperation(
  tx: QueryExecutor,
  actor: MeetingActor,
  operationId: string,
  kind: string,
  request: unknown,
) {
  const old = (
    await tx.query<{
      meeting_id: string;
      result_id: string | null;
      request: unknown;
      kind: string;
    }>(
      `SELECT * FROM meeting_operations WHERE ${isGuest(actor) ? 'guest_actor_id' : 'actor_id'}=$1 AND operation_id=$2`,
      [isGuest(actor) ? null : actor.user.id, operationId],
    )
  ).rows[0];
  if (old && (old.kind !== kind || canonicalJson(old.request) !== canonicalJson(request)))
    throw new AppError(
      409,
      'MEETING_OPERATION_CONFLICT',
      'Операция уже сохранена с другими данными.',
    );
  return old;
}
export async function operation(
  tx: QueryExecutor,
  actor: MeetingActor,
  meetingId: string,
  operationId: string,
  kind: string,
  request: unknown,
  now: number,
  resultId: string | null = null,
  before: unknown = null,
) {
  await tx.query(
    'INSERT INTO meeting_operations (id,meeting_id,actor_id,operation_id,kind,request,before_state,result_id,created_at,guest_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      meetingId,
      isGuest(actor) ? null : actor.user.id,
      operationId,
      kind,
      JSON.stringify(request),
      before === null ? null : JSON.stringify(before),
      resultId,
      new Date(now),
      isGuest(actor) ? actor.user.id : null,
    ],
  );
}
export async function command(
  tx: QueryExecutor,
  meetingId: string,
  kind: 'permissions' | 'remove' | 'delete_room',
  payload: unknown,
  now: number,
) {
  await tx.query(
    'INSERT INTO meeting_commands (id,meeting_id,kind,payload,retry_at,created_at) VALUES ($1,$2,$3,$4,$5,$5)',
    [randomUUID(), meetingId, kind, JSON.stringify(payload), new Date(now)],
  );
}
export async function session(
  tx: QueryExecutor,
  actor: MeetingActor,
  id: string,
  meetingId: string,
) {
  const s = (
    await tx.query<SessionRow>(
      'SELECT s.*,COALESCE(s.user_id,s.guest_id) AS user_id,COALESCE(d.revision,0) AS device_revision FROM meeting_sessions s LEFT JOIN meeting_device_reports d ON d.session_id=s.id WHERE s.id=$1 AND s.meeting_id=$2',
      [id, meetingId],
    )
  ).rows[0];
  if (!s || s.user_id !== actor.user.id)
    throw new AppError(404, 'MEETING_SESSION_NOT_FOUND', 'Подключение не найдено.');
  return s;
}
export function policy(p?: Pick<MemberRow, 'audio_allowed' | 'video_allowed' | 'screen_allowed'>) {
  return {
    audioAllowed: p?.audio_allowed ?? true,
    videoAllowed: p?.video_allowed ?? true,
    screenAllowed: p?.screen_allowed ?? true,
  };
}
export const sessionView = (s: SessionRow, p?: MemberRow) => ({
  id: s.id,
  state: s.state,
  handRaisedAt: iso(s.hand_raised_at),
  deviceRevision: s.device_revision ?? 0,
  ...policy(p),
});

export const deadline = (m: Pick<MeetingRow, 'kind' | 'status' | 'ends_at'>) =>
  m.ends_at && (m.kind !== 'adhoc' || m.status !== 'scheduled')
    ? new Date(m.ends_at).getTime() + (m.kind === 'adhoc' ? 0 : 14400000)
    : Infinity;
