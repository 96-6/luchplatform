import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  deviceReportSchema,
  meetingSummarySchema,
  type createMeetingSchema,
  type updateMeetingSchema,
  type meetingsQuerySchema,
  type moderateMeetingSchema,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { canonicalJson } from '../content/service.js';
import { TeacherService } from '../teacher/service.js';
import { classifyDevice } from './devices.js';
import type { MeetingVideo, RtcPeer } from './adapter.js';
import {
  access,
  requireManager,
  viewMeeting,
  oldOperation,
  operation,
  command,
  session,
  policy,
  sessionView,
  iso,
  type SessionRow,
  type MeetingAccess,
} from './repository.js';
type Draft = z.infer<typeof createMeetingSchema>;
const closed = () => new AppError(409, 'MEETING_CLOSED', 'Занятие завершено или отменено.');
export class MeetingsService {
  constructor(
    readonly db: Database,
    readonly video: MeetingVideo,
    readonly now: () => number = Date.now,
  ) {}
  private async opLock(tx: QueryExecutor, actor: Actor, id: string) {
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `meeting:${actor.user.id}:${id}`,
      ]);
  }
  private async draft(
    tx: QueryExecutor,
    actor: Actor,
    input: Draft | z.infer<typeof updateMeetingSchema>,
  ) {
    if (!['teacher', 'admin', 'superadmin'].includes(actor.user.role))
      throw new AppError(
        403,
        'MEETING_ORGANIZER_REQUIRED',
        'Создать занятие может преподаватель или администратор.',
      );
    if (actor.user.role === 'teacher' && input.organizerId !== actor.user.id)
      throw new AppError(
        403,
        'MEETING_ORGANIZER_REQUIRED',
        'Выберите себя основным организатором.',
      );
    const organizers = [input.organizerId, ...input.coorganizerIds];
    const teachers = (
      await tx.query<{ id: string; role: string }>(
        'SELECT id,role FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [organizers],
      )
    ).rows;
    if (
      teachers.length !== organizers.length ||
      teachers.some((x) => !['teacher', 'admin', 'superadmin'].includes(x.role)) ||
      teachers.find((t) => t.id === input.organizerId)?.role !== 'teacher'
    )
      throw new AppError(
        400,
        'MEETING_INVALID_ORGANIZER',
        'Основным организатором должен быть преподаватель.',
      );
    const students = (
      await tx.query<{ id: string; role: string }>(
        'SELECT id,role FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
        [input.studentIds],
      )
    ).rows;
    if (students.length !== input.studentIds.length || students.some((x) => x.role !== 'student'))
      throw new AppError(400, 'MEETING_INVALID_STUDENTS', 'Выберите существующих учеников.');
    for (const t of teachers.filter((x) => x.role === 'teacher')) {
      const links = (
        await tx.query(
          'SELECT student_id FROM teacher_students WHERE teacher_id=$1 AND student_id=ANY($2::uuid[]) FOR SHARE',
          [t.id, input.studentIds],
        )
      ).rows;
      if (links.length !== input.studentIds.length)
        throw new AppError(
          403,
          'MEETING_STUDENT_ACCESS',
          'Ученики должны быть закреплены за каждым преподавателем-организатором.',
        );
    }
  }
  async options(actor: Actor) {
    if (!['teacher', 'admin', 'superadmin'].includes(actor.user.role))
      throw new AppError(
        403,
        'MEETING_ORGANIZER_REQUIRED',
        'Доступно преподавателю или администратору.',
      );
    return this.db.transaction(async (tx) => {
      const global = actor.user.role !== 'teacher';
      const students = (
        await tx.query<{ id: string; full_name: string; email: string }>(
          `SELECT u.id,u.full_name,u.email FROM users u WHERE u.role='student' AND ($1 OR EXISTS(SELECT 1 FROM teacher_students t WHERE t.teacher_id=$2 AND t.student_id=u.id)) ORDER BY u.full_name,u.id LIMIT 200`,
          [global, actor.user.id],
        )
      ).rows;
      const organizers = (
        await tx.query<{ id: string; full_name: string; email: string }>(
          `SELECT u.id,u.full_name,u.email,u.role FROM users u WHERE u.role IN ('teacher','admin','superadmin') AND ($1 OR u.id=$2 OR EXISTS(SELECT 1 FROM teacher_students a JOIN teacher_students b ON a.student_id=b.student_id WHERE a.teacher_id=$2 AND b.teacher_id=u.id)) ORDER BY u.full_name,u.id LIMIT 200`,
          [global, actor.user.id],
        )
      ).rows;
      const map = (p: { id: string; full_name: string; email: string }) => ({
        id: p.id,
        name: p.full_name,
        email: p.email,
      });
      return {
        students: students.map(map),
        organizers: organizers.map((p) => ({ ...map(p), role: (p as { role?: string }).role })),
      };
    });
  }
  read(actor: Actor, id: string) {
    return this.db.transaction(async (tx) =>
      viewMeeting(tx, await access(tx, actor, id), this.video.configured, this.now()),
    );
  }
  async list(actor: Actor, input: z.infer<typeof meetingsQuerySchema>) {
    return this.db.transaction(async (tx) => {
      const global = ['admin', 'superadmin'].includes(actor.user.role);
      const rows = (
        await tx.query<{ id: string; starts_at: Date | string }>(
          `SELECT m.id,m.starts_at FROM scheduled_meetings m WHERE ($1 OR EXISTS(SELECT 1 FROM meeting_members p WHERE p.meeting_id=m.id AND p.user_id=$2)) AND m.starts_at<$4 AND m.ends_at>$3 AND ($5::timestamptz IS NULL OR (m.starts_at,m.id)>($5,$6::uuid)) ORDER BY m.starts_at,m.id LIMIT $7`,
          [
            global,
            actor.user.id,
            input.from,
            input.to,
            input.beforeStartsAt ?? null,
            input.beforeId ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, input.limit))
        items.push(
          await viewMeeting(tx, await access(tx, actor, row.id), this.video.configured, this.now()),
        );
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > input.limit && last ? { startsAt: last.startsAt, id: last.id } : null,
      };
    });
  }
  async create(actor: Actor, input: Draft) {
    const id = await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, input.operationId);
      const old = await oldOperation(tx, actor, input.operationId, 'create', input);
      if (old) {
        await access(tx, actor, old.meeting_id);
        return old.meeting_id;
      }
      await this.draft(tx, actor, input);
      const id = randomUUID(),
        now = this.now();
      await tx.query(
        `INSERT INTO scheduled_meetings (id,title,description,language,organizer_id,starts_at,ends_at,time_zone,room_name,lobby_enabled,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [
          id,
          input.title,
          input.description,
          input.language,
          input.organizerId,
          input.startsAt,
          input.endsAt,
          input.timeZone,
          `luch-${randomUUID()}`,
          input.lobbyEnabled,
          actor.user.id,
          new Date(now),
        ],
      );
      for (const uid of [input.organizerId, ...input.coorganizerIds, ...input.studentIds])
        await tx.query('INSERT INTO meeting_members (meeting_id,user_id,role) VALUES ($1,$2,$3)', [
          id,
          uid,
          input.studentIds.includes(uid) ? 'student' : 'organizer',
        ]);
      await operation(tx, actor, id, input.operationId, 'create', input, now);
      await audit(tx, actor.user.id, 'meeting.created', input.organizerId);
      return id;
    });
    return this.read(actor, id);
  }
  async update(actor: Actor, id: string, input: z.infer<typeof updateMeetingSchema>) {
    await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, input.operationId);
      const a = await access(tx, actor, id, true);
      requireManager(a);
      if (await oldOperation(tx, actor, input.operationId, 'update', { id, ...input })) return;
      if (a.m.status !== 'scheduled')
        throw new AppError(409, 'MEETING_STARTED', 'Изменять расписание можно до начала встречи.');
      if (input.revision !== a.m.revision)
        throw new AppError(409, 'MEETING_CHANGED', 'Занятие изменилось. Обновите страницу.');
      await this.draft(tx, actor, input);
      await tx.query(
        `UPDATE scheduled_meetings SET title=$2,description=$3,language=$4,organizer_id=$5,starts_at=$6,ends_at=$7,time_zone=$8,lobby_enabled=$9,revision=revision+1,updated_at=$10 WHERE id=$1`,
        [
          id,
          input.title,
          input.description,
          input.language,
          input.organizerId,
          input.startsAt,
          input.endsAt,
          input.timeZone,
          input.lobbyEnabled,
          new Date(this.now()),
        ],
      );
      const removed = a.members.filter(
        (m) =>
          ![input.organizerId, ...input.coorganizerIds, ...input.studentIds].includes(m.user_id),
      );
      for (const p of removed) {
        await this.removeSessions(tx, id, p.user_id);
        await tx.query('DELETE FROM meeting_members WHERE meeting_id=$1 AND user_id=$2', [
          id,
          p.user_id,
        ]);
      }
      for (const uid of [input.organizerId, ...input.coorganizerIds, ...input.studentIds])
        await tx.query(
          'INSERT INTO meeting_members (meeting_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (meeting_id,user_id) DO UPDATE SET role=$3',
          [id, uid, input.studentIds.includes(uid) ? 'student' : 'organizer'],
        );
      await operation(
        tx,
        actor,
        id,
        input.operationId,
        'update',
        { id, ...input },
        this.now(),
        null,
        a.m,
      );
    });
    await this.drain(id);
    return this.read(actor, id);
  }
  private async removeSessions(tx: QueryExecutor, id: string, userId?: string) {
    const rows = (
      await tx.query<SessionRow>(
        `UPDATE meeting_sessions SET state='removed',hand_raised_at=NULL,ended_at=$2 WHERE meeting_id=$1 AND state IN ('waiting','admitted') AND ($3::uuid IS NULL OR user_id=$3) RETURNING *`,
        [id, new Date(this.now()), userId ?? null],
      )
    ).rows;
    for (const s of rows) {
      await command(tx, id, 'remove', { identity: s.id }, this.now());
      await tx.query('DELETE FROM meeting_device_reports WHERE session_id=$1', [s.id]);
    }
  }
  async join(actor: Actor, id: string, operationId: string) {
    const sid = await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, operationId);
      const a = await access(tx, actor, id, true),
        request = { id };
      const old = await oldOperation(tx, actor, operationId, 'join', request);
      if (old) return old.result_id!;
      if (
        !['scheduled', 'live'].includes(a.m.status) ||
        this.now() > new Date(a.m.ends_at).getTime() + 14400000
      )
        throw closed();
      if (a.member?.blocked_at)
        throw new AppError(403, 'MEETING_REMOVED', 'Организатор удалил вас из встречи.');
      let s = (
        await tx.query<SessionRow>(
          `SELECT * FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state IN ('waiting','admitted')`,
          [id, actor.user.id],
        )
      ).rows[0];
      if (
        !a.canManage &&
        ((!s && a.m.locked) || this.now() < new Date(a.m.starts_at).getTime() - 900000)
      )
        throw new AppError(409, 'MEETING_NOT_OPEN', 'Вход пока закрыт. Проверьте время занятия.');
      if (a.canManage && a.m.status === 'scheduled') await this.video.ensureRoom(a.m.room_name);
      if (!s) {
        const sid = randomUUID();
        s = (
          await tx.query<SessionRow>(
            `INSERT INTO meeting_sessions (id,meeting_id,user_id,state,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [
              sid,
              id,
              actor.user.id,
              a.canManage || (!a.m.lobby_enabled && a.m.status === 'live') ? 'admitted' : 'waiting',
              new Date(this.now()),
            ],
          )
        ).rows[0]!;
      }
      if (a.canManage && a.m.status === 'scheduled')
        await tx.query(
          `UPDATE scheduled_meetings SET status='live',started_at=$2,updated_at=$2,revision=revision+1 WHERE id=$1`,
          [id, new Date(this.now())],
        );
      await operation(tx, actor, id, operationId, 'join', request, this.now(), s.id);
      await audit(tx, actor.user.id, 'meeting.join_requested', actor.user.id);
      return s.id;
    });
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id),
        s = await session(tx, actor, sid, id);
      return {
        session: sessionView(s, a.member),
        meeting: await viewMeeting(tx, a, this.video.configured, this.now()),
      };
    });
  }
  async token(actor: Actor, id: string, sid: string) {
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id, true),
        s = await session(tx, actor, sid, id);
      if (a.m.status !== 'live' || this.now() > new Date(a.m.ends_at).getTime() + 14400000)
        throw closed();
      if (s.state !== 'admitted' || a.member?.blocked_at)
        throw new AppError(403, 'MEETING_NOT_ADMITTED', 'Дождитесь допуска организатора.');
      await this.video.ensureRoom(a.m.room_name);
      const token = await this.video.token(a.m.room_name, s.id, actor.user.name, policy(a.member));
      await audit(tx, actor.user.id, 'meeting.token_issued', actor.user.id);
      return {
        token,
        serverUrl: this.video.browserUrl,
        identity: s.id,
        expiresAt: new Date(this.now() + 120000).toISOString(),
      };
    });
  }
  async leave(actor: Actor, id: string, sid: string) {
    await this.db.transaction(async (tx) => {
      await access(tx, actor, id, true);
      const s = await session(tx, actor, sid, id);
      if (!['waiting', 'admitted'].includes(s.state)) return;
      await tx.query(
        `UPDATE meeting_sessions SET state='left',hand_raised_at=NULL,ended_at=$2 WHERE id=$1`,
        [sid, new Date(this.now())],
      );
      await tx.query('DELETE FROM meeting_device_reports WHERE session_id=$1', [sid]);
      await command(tx, id, 'remove', { identity: sid }, this.now());
    });
    await this.drain(id);
    return { ok: true };
  }
  async hand(actor: Actor, id: string, sid: string, raised: boolean) {
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id, true),
        s = await session(tx, actor, sid, id);
      if (s.state !== 'admitted' || a.m.status !== 'live' || a.member?.blocked_at) throw closed();
      await tx.query('UPDATE meeting_sessions SET hand_raised_at=$2 WHERE id=$1', [
        sid,
        raised ? new Date(this.now()) : null,
      ]);
      return { ok: true };
    });
  }
  async moderate(actor: Actor, id: string, input: z.infer<typeof moderateMeetingSchema>) {
    await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, input.operationId);
      const a = await access(tx, actor, id, true);
      requireManager(a);
      const request = { id, ...input };
      if (await oldOperation(tx, actor, input.operationId, 'moderate', request)) return;
      const action = input.action;
      if (['lock', 'unlock', 'end', 'cancel'].includes(action)) {
        if (input.revision !== a.m.revision)
          throw new AppError(409, 'MEETING_CHANGED', 'Занятие изменилось. Обновите страницу.');
        if (!['scheduled', 'live'].includes(a.m.status)) throw closed();
        if (action === 'cancel' && a.m.status !== 'scheduled')
          throw new AppError(409, 'MEETING_STARTED', 'Для начатой встречи выберите завершение.');
        if (action === 'end' && a.m.status !== 'live')
          throw new AppError(409, 'MEETING_NOT_STARTED', 'Встреча ещё не начата.');
        if (action === 'end' || action === 'cancel') {
          await tx.query(
            'UPDATE scheduled_meetings SET status=$2,ended_at=$3,updated_at=$3,revision=revision+1 WHERE id=$1',
            [id, action === 'end' ? 'completed' : 'cancelled', new Date(this.now())],
          );
          await this.removeSessions(tx, id);
          await command(tx, id, 'delete_room', {}, this.now());
        } else
          await tx.query(
            'UPDATE scheduled_meetings SET locked=$2,revision=revision+1,updated_at=$3 WHERE id=$1',
            [id, action === 'lock', new Date(this.now())],
          );
      } else {
        if (a.m.status !== 'live') throw closed();
        if (action === 'mute_all') {
          for (const p of a.members.filter((p) => p.role === 'student'))
            await this.changeMedia(tx, a, p.user_id, 'mute_audio');
        } else if (action === 'restore') {
          if (!input.targetId || !a.members.some((m) => m.user_id === input.targetId))
            throw new AppError(404, 'MEETING_PARTICIPANT_NOT_FOUND', 'Участник не найден.');
          await tx.query(
            'UPDATE meeting_members SET blocked_at=NULL WHERE meeting_id=$1 AND user_id=$2',
            [id, input.targetId],
          );
        } else {
          const s = (
            await tx.query<SessionRow & { user_role: string }>(
              `SELECT s.*,u.role AS user_role FROM meeting_sessions s JOIN users u ON u.id=s.user_id WHERE s.meeting_id=$1 AND s.id=$2`,
              [id, input.targetId ?? null],
            )
          ).rows[0];
          if (!s || !['waiting', 'admitted'].includes(s.state))
            throw new AppError(
              404,
              'MEETING_PARTICIPANT_NOT_FOUND',
              'Участник не найден во встрече.',
            );
          if (
            s.user_id === actor.user.id ||
            (s.user_role === 'superadmin' && actor.user.role !== 'superadmin')
          )
            throw new AppError(
              403,
              'MEETING_MODERATION_DENIED',
              'Это действие недоступно для выбранного участника.',
            );
          if (action === 'admit') {
            if (s.state !== 'waiting')
              throw new AppError(409, 'MEETING_ALREADY_ADMITTED', 'Участник уже допущен.');
            await tx.query("UPDATE meeting_sessions SET state='admitted' WHERE id=$1", [s.id]);
          } else if (action === 'kick') {
            await tx.query(
              'UPDATE meeting_members SET blocked_at=$3 WHERE meeting_id=$1 AND user_id=$2',
              [id, s.user_id, new Date(this.now())],
            );
            await this.removeSessions(tx, id, s.user_id);
          } else if (action === 'lower_hand')
            await tx.query('UPDATE meeting_sessions SET hand_raised_at=NULL WHERE id=$1', [s.id]);
          else await this.changeMedia(tx, a, s.user_id, action);
        }
      }
      await operation(tx, actor, id, input.operationId, 'moderate', request, this.now(), null, a.m);
      await audit(tx, actor.user.id, `meeting.${action}`, input.targetId ? null : actor.user.id);
    });
    await this.drain(id);
    return this.read(actor, id);
  }
  private async changeMedia(tx: QueryExecutor, a: MeetingAccess, userId: string, action: string) {
    const member = a.members.find((p) => p.user_id === userId);
    if (!member)
      throw new AppError(
        403,
        'MEETING_MODERATION_DENIED',
        'Для администратора встречи это действие недоступно.',
      );
    const column = action.includes('audio')
        ? 'audio_allowed'
        : action.includes('video')
          ? 'video_allowed'
          : 'screen_allowed',
      allowed = action.startsWith('allow_');
    await tx.query(`UPDATE meeting_members SET ${column}=$3 WHERE meeting_id=$1 AND user_id=$2`, [
      a.m.id,
      userId,
      allowed,
    ]);
    const p = {
      ...policy(member),
      [column === 'audio_allowed'
        ? 'audioAllowed'
        : column === 'video_allowed'
          ? 'videoAllowed'
          : 'screenAllowed']: allowed,
    };
    const sessions = (
      await tx.query<SessionRow>(
        `SELECT * FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state='admitted'`,
        [a.m.id, userId],
      )
    ).rows;
    for (const s of sessions)
      await command(tx, a.m.id, 'permissions', { identity: s.id, ...p }, this.now());
  }
  async drain(meetingId?: string) {
    if (!this.video.configured) return;
    for (let i = 0; i < 128; i++) {
      const done = await this.db.transaction(async (tx) => {
        const c = (
          await tx.query<{
            sequence: string;
            id: string;
            meeting_id: string;
            room_name: string;
            kind: 'permissions' | 'remove' | 'delete_room';
            payload: {
              identity: string;
              audioAllowed: boolean;
              videoAllowed: boolean;
              screenAllowed: boolean;
            };
          }>(
            `SELECT c.*,m.room_name FROM meeting_commands c JOIN scheduled_meetings m ON m.id=c.meeting_id WHERE c.status='pending' AND c.retry_at<=$1 AND ($2::uuid IS NULL OR c.meeting_id=$2) AND NOT EXISTS(SELECT 1 FROM meeting_commands earlier WHERE earlier.meeting_id=c.meeting_id AND earlier.sequence<c.sequence AND earlier.status='pending') ORDER BY c.sequence LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
            [new Date(this.now()), meetingId ?? null],
          )
        ).rows[0];
        if (!c) return false;
        try {
          if (c.kind === 'permissions')
            await this.video.permissions(c.room_name, c.payload.identity, {
              audioAllowed: c.payload.audioAllowed,
              videoAllowed: c.payload.videoAllowed,
              screenAllowed: c.payload.screenAllowed,
            });
          else if (c.kind === 'remove') await this.video.remove(c.room_name, c.payload.identity);
          else await this.video.close(c.room_name);
          await tx.query(
            "UPDATE meeting_commands SET status='applied',attempts=attempts+1,applied_at=$2 WHERE id=$1",
            [c.id, new Date(this.now())],
          );
          return true;
        } catch {
          await tx.query(
            'UPDATE meeting_commands SET attempts=attempts+1,retry_at=$2 WHERE id=$1',
            [c.id, new Date(this.now() + 5000)],
          );
          return false;
        }
      });
      if (!done) break;
    }
  }
  async room(actor: Actor, id: string, sid?: string) {
    await this.drain(id);
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id);
      const active = sid
        ? null
        : (
            await tx.query<SessionRow>(
              "SELECT * FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state IN ('waiting','admitted')",
              [id, actor.user.id],
            )
          ).rows[0];
      const own = sid
        ? await session(tx, actor, sid, id)
        : active
          ? await session(tx, actor, active.id, id)
          : null;
      let peers: RtcPeer[] = [],
        available = false;
      if (
        a.m.status === 'live' &&
        !a.member?.blocked_at &&
        (own?.state === 'admitted' || a.canManage)
      )
        try {
          peers = await this.video.participants(a.m.room_name);
          available = true;
        } catch {
          /* Technical outage: preserve learning data and report unavailable. */
        }
      const sessions = (
        await tx.query<
          SessionRow & {
            full_name: string;
            user_role: 'student' | 'teacher' | 'admin' | 'superadmin';
            report_camera: unknown;
            report_microphone: unknown;
            reported_at: Date | string | null;
          }
        >(
          `SELECT s.*,u.full_name,u.role AS user_role,d.camera AS report_camera,d.microphone AS report_microphone,d.reported_at FROM meeting_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN meeting_device_reports d ON d.session_id=s.id WHERE s.meeting_id=$1 AND s.state IN ('waiting','admitted') ORDER BY s.created_at,s.id`,
          [id],
        )
      ).rows;
      const participants = [];
      for (const p of peers) {
        const s = sessions.find((s) => s.id === p.identity && s.state === 'admitted');
        if (!s) continue;
        const member = a.members.find((m) => m.user_id === s.user_id);
        await tx.query(
          'UPDATE meeting_sessions SET first_connected_at=COALESCE(first_connected_at,$2),last_seen_at=$2 WHERE id=$1',
          [s.id, new Date(this.now())],
        );
        const warnings = [];
        if (a.canInspect)
          for (const kind of ['camera', 'microphone'] as const) {
            const report = (kind === 'camera' ? s.report_camera : s.report_microphone) as {
              label: string;
              trackSid: string;
              match: string | null;
            } | null;
            if (
              report?.match &&
              p.tracks.some((t) => t.sid === report.trackSid && t.source === kind && !t.muted)
            )
              warnings.push({
                kind,
                label: report.label,
                match: report.match,
                reportedAt: iso(s.reported_at),
              });
          }
        participants.push({
          identity: s.id,
          userId: s.user_id,
          name: s.full_name,
          role:
            member?.role === 'organizer' && s.user_role !== 'student'
              ? 'organizer'
              : s.user_role === 'admin' || s.user_role === 'superadmin'
                ? s.user_role
                : 'student',
          handRaisedAt: iso(s.hand_raised_at),
          ...policy(member),
          warnings,
          deviceReportedAt: a.canInspect ? iso(s.reported_at) : null,
        });
      }
      const pending = Number(
        (
          await tx.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM meeting_commands WHERE meeting_id=$1 AND status='pending'",
            [id],
          )
        ).rows[0]!.n,
      );
      return {
        meeting: await viewMeeting(tx, a, this.video.configured, this.now()),
        self: own ? sessionView(own, a.member) : null,
        available,
        pendingCommands: a.canManage ? pending : 0,
        participants,
        waiting: a.canManage
          ? sessions
              .filter((s) => s.state === 'waiting')
              .map((s) => ({
                identity: s.id,
                userId: s.user_id,
                name: s.full_name,
                createdAt: iso(s.created_at),
              }))
          : [],
      };
    });
  }
  async devices(actor: Actor, id: string, sid: string, input: z.infer<typeof deviceReportSchema>) {
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id, true),
        s = await session(tx, actor, sid, id);
      if (a.m.status !== 'live' || s.state !== 'admitted' || a.member?.blocked_at) throw closed();
      const old = (
        await tx.query<{ revision: number; request: unknown }>(
          'SELECT * FROM meeting_device_reports WHERE session_id=$1',
          [sid],
        )
      ).rows[0];
      if (old && input.revision < old.revision) return { ok: true };
      if (old && input.revision === old.revision) {
        if (canonicalJson(old.request) !== canonicalJson(input))
          throw new AppError(
            409,
            'MEETING_DEVICE_REPORT_CHANGED',
            'Состояние устройств уже обновлено.',
          );
        return { ok: true };
      }
      const peer = (await this.video.participants(a.m.room_name)).find((p) => p.identity === sid);
      const report = (kind: 'camera' | 'microphone') => {
        const data = input[kind];
        return data &&
          peer?.tracks.some((t) => t.sid === data.trackSid && t.source === kind && !t.muted)
          ? { ...data, match: classifyDevice(kind, data.label) }
          : null;
      };
      await tx.query(
        'INSERT INTO meeting_device_reports (session_id,revision,request,camera,microphone,reported_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id) DO UPDATE SET revision=$2,request=$3,camera=$4,microphone=$5,reported_at=$6',
        [
          sid,
          input.revision,
          JSON.stringify(input),
          JSON.stringify(report('camera')),
          JSON.stringify(report('microphone')),
          new Date(this.now()),
        ],
      );
      return { ok: true };
    });
  }
  async messages(actor: Actor, id: string, cursor?: { createdAt: string; id: string }) {
    return this.db.transaction(async (tx) => {
      const a = await access(tx, actor, id);
      if (a.member?.blocked_at)
        throw new AppError(403, 'MEETING_REMOVED', 'Доступ к чату закрыт организатором.');
      const rows = (
        await tx.query<{
          id: string;
          user_id: string;
          full_name: string;
          text: string;
          created_at: Date | string;
        }>(
          `SELECT c.*,u.full_name FROM meeting_messages c JOIN users u ON u.id=c.user_id WHERE c.meeting_id=$1 AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2,$3::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT 51`,
          [id, cursor?.createdAt ?? null, cursor?.id ?? null],
        )
      ).rows;
      const items = rows.slice(0, 50).map((m) => ({
        id: m.id,
        userId: m.user_id,
        name: m.full_name,
        text: m.text,
        createdAt: iso(m.created_at),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > 50 && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }
  async send(actor: Actor, id: string, operationId: string, text: string) {
    await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, operationId);
      const a = await access(tx, actor, id, true);
      if (a.m.status !== 'live' || a.member?.blocked_at) throw closed();
      if (
        !(
          await tx.query(
            "SELECT 1 FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state='admitted'",
            [id, actor.user.id],
          )
        ).rows.length
      )
        throw new AppError(403, 'MEETING_NOT_ADMITTED', 'Сначала присоединитесь к встрече.');
      const old = (
        await tx.query<{ meeting_id: string; text: string }>(
          'SELECT * FROM meeting_messages WHERE user_id=$1 AND operation_id=$2',
          [actor.user.id, operationId],
        )
      ).rows[0];
      if (old) {
        if (old.meeting_id !== id || old.text !== text)
          throw new AppError(
            409,
            'MEETING_OPERATION_CONFLICT',
            'Сообщение уже сохранено с другим текстом.',
          );
        return;
      }
      const recent = Number(
        (
          await tx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM meeting_messages WHERE user_id=$1 AND meeting_id=$2 AND created_at>$3',
            [actor.user.id, id, new Date(this.now() - 60000)],
          )
        ).rows[0]!.n,
      );
      if (recent >= 20)
        throw new AppError(429, 'MEETING_CHAT_LIMIT', 'Слишком много сообщений. Подождите минуту.');
      await tx.query(
        'INSERT INTO meeting_messages (id,meeting_id,user_id,operation_id,text,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, actor.user.id, operationId, text, new Date(this.now())],
      );
    });
    return this.messages(actor, id);
  }
  async summary(actor: Actor, id: string, input: z.infer<typeof meetingSummarySchema>) {
    await this.db.transaction(async (tx) => {
      await this.opLock(tx, actor, input.operationId);
      const a = await access(tx, actor, id, true);
      requireManager(a);
      if (actor.user.role === 'admin')
        throw new AppError(
          403,
          'TEACHER_REQUIRED',
          'Учебный итог сохраняет преподаватель или суперадмин.',
        );
      if (await oldOperation(tx, actor, input.operationId, 'summary', { id, ...input })) return;
      if (a.m.status !== 'completed')
        throw new AppError(409, 'MEETING_NOT_COMPLETED', 'Сначала завершите занятие.');
      if (a.m.summary_revision !== input.revision)
        throw new AppError(409, 'MEETING_SUMMARY_CHANGED', 'Итог уже изменён. Обновите страницу.');
      for (const userId of [...new Set(input.homework.map((h) => h.studentId))].sort())
        await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
      const teachers = new TeacherService(this.db, this.now);
      for (const h of [...input.homework].sort(
        (a, b) => a.studentId.localeCompare(b.studentId) || a.planId.localeCompare(b.planId),
      )) {
        if (!a.members.some((p) => p.user_id === h.studentId && p.role === 'student'))
          throw new AppError(
            400,
            'MEETING_HOMEWORK_STUDENT',
            'Домашнее задание предназначено участникам занятия.',
          );
        const plan = (
          await tx.query<{ user_id: string; language: string }>(
            `SELECT p.user_id,d.questionnaire->>'language' AS language FROM learning_plans p JOIN diagnostic_sessions d ON d.id=p.diagnostic_id WHERE p.id=$1`,
            [h.planId],
          )
        ).rows[0];
        if (!plan || plan.user_id !== h.studentId || plan.language !== a.m.language)
          throw new AppError(
            400,
            'MEETING_HOMEWORK_PLAN',
            'Выберите план участника на языке занятия.',
          );
        const op = randomUUID(),
          assignmentId = await teachers.assignInTransaction(tx, actor, h.planId, {
            operationId: op,
            exerciseId: h.exerciseId,
            reason: `Домашнее задание после «${a.m.title}»: ${h.reason}`,
            dueAt: h.dueAt,
            estimatedMinutes: 3,
          });
        const action = (
          await tx.query<{ id: string }>(
            'SELECT id FROM teacher_actions WHERE actor_id=$1 AND operation_id=$2',
            [actor.user.id, op],
          )
        ).rows[0]!;
        await tx.query(
          'INSERT INTO meeting_homework (id,meeting_id,student_id,assignment_id,action_id,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            id,
            h.studentId,
            assignmentId,
            action.id,
            actor.user.id,
            new Date(this.now()),
          ],
        );
      }
      await tx.query(
        'UPDATE scheduled_meetings SET summary_comment=$2,summary_revision=summary_revision+1,updated_at=$3 WHERE id=$1',
        [id, input.comment, new Date(this.now())],
      );
      await operation(
        tx,
        actor,
        id,
        input.operationId,
        'summary',
        { id, ...input },
        this.now(),
        null,
        { comment: a.m.summary_comment, revision: a.m.summary_revision },
      );
      await audit(tx, actor.user.id, 'meeting.summary_saved', a.m.organizer_id);
    });
    return this.read(actor, id);
  }
  async recover() {
    await this.db.transaction(async (tx) => {
      const rows = (
        await tx.query<{ id: string }>(
          `SELECT id FROM scheduled_meetings WHERE status='live' AND ends_at<$1 ORDER BY id FOR UPDATE SKIP LOCKED`,
          [new Date(this.now() - 14400000)],
        )
      ).rows;
      for (const row of rows) {
        await tx.query(
          "UPDATE scheduled_meetings SET status='completed',ended_at=$2,updated_at=$2,revision=revision+1 WHERE id=$1",
          [row.id, new Date(this.now())],
        );
        await this.removeSessions(tx, row.id);
        await command(tx, row.id, 'delete_room', {}, this.now());
      }
    });
    await this.drain();
  }
}
