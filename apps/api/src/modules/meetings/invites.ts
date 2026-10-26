import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  createAdhocMeetingSchema,
  updateMeetingInviteSchema,
  redeemMeetingInviteSchema,
} from '@luch/contracts';
import type { Actor, AuthService } from '../auth/service.js';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { token, hashToken } from '../auth/crypto.js';
import {
  access,
  requireManager,
  oldOperation,
  operation,
  command,
  iso,
  type MeetingRow,
} from './repository.js';
import { guestActor, guestCookie, type MeetingActor } from './identity.js';
import type { MeetingsService } from './service.js';

type Invite = {
  id: string;
  meeting_id: string;
  created_by: string;
  token_hash: string;
  token_ciphertext: string;
  reusable: boolean;
  allow_guests: boolean;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  used_by_user_id: string | null;
  used_by_guest_id: string | null;
  revision: number;
};
type Guest = {
  admitted_at: Date | string | null;
  id: string;
  full_name: string;
  meeting_id: string;
  token_hash: string;
  token_ciphertext: string;
  expires_at: Date | string;
};
export class MeetingInvites {
  constructor(
    readonly auth: AuthService,
    readonly meetings: MeetingsService,
  ) {}
  private get db() {
    return this.auth.database;
  }
  private get now() {
    return this.meetings.now();
  }
  private async lock(tx: QueryExecutor, actor: Actor, op: string) {
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `meeting:${actor.user.id}:${op}`,
      ]);
  }
  private valid(row: Invite) {
    if (row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= this.now))
      throw new AppError(
        410,
        'MEETING_INVITE_EXPIRED',
        'Приглашение отключено или срок его действия истёк.',
      );
  }
  private future(value: string | null) {
    if (value && Date.parse(value) <= this.now)
      throw new AppError(400, 'MEETING_INVITE_TIME', 'Срок действия ссылки должен быть в будущем.');
  }
  private dto(row: Invite) {
    return {
      id: row.id,
      meetingId: row.meeting_id,
      url: `${this.auth.settings.APP_URL}/meeting-invite?token=${this.auth.crypto.decrypt(row.token_ciphertext)}`,
      reusable: row.reusable,
      allowGuests: row.allow_guests,
      expiresAt: iso(row.expires_at),
      revoked: Boolean(row.revoked_at),
      used: Boolean(row.used_by_guest_id || row.used_by_user_id),
      revision: row.revision,
    };
  }
  private async insertMeeting(
    tx: QueryExecutor,
    actor: Actor,
    input: {
      title: string;
      description: string;
      language: 'ru' | 'en';
      startsAt?: string | undefined;
      timeZone: string;
      durationMinutes: number | null;
      lobbyEnabled: boolean;
    },
    organizer = actor.user.id,
  ) {
    const id = randomUUID(),
      starts = new Date(input.startsAt ?? this.now),
      ends =
        input.durationMinutes === null
          ? null
          : new Date(starts.getTime() + input.durationMinutes * 60000);
    await tx.query(
      `INSERT INTO scheduled_meetings(id,title,description,language,organizer_id,starts_at,ends_at,time_zone,room_name,lobby_enabled,created_by,created_at,updated_at,kind,duration_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'adhoc',$13)`,
      [
        id,
        input.title,
        input.description,
        input.language,
        organizer,
        starts,
        ends,
        input.timeZone,
        `luch-${randomUUID()}`,
        input.lobbyEnabled,
        actor.user.id,
        new Date(this.now),
        input.durationMinutes,
      ],
    );
    await tx.query(
      "INSERT INTO meeting_members(meeting_id,user_id,role) VALUES($1,$2,'organizer')",
      [id, organizer],
    );
    return id;
  }
  async create(actor: Actor, input: z.infer<typeof createAdhocMeetingSchema>) {
    if (!['teacher', 'admin', 'superadmin'].includes(actor.user.role))
      throw new AppError(
        403,
        'MEETING_ORGANIZER_REQUIRED',
        'Создать занятие может преподаватель или администратор.',
      );
    this.future(input.expiresAt);
    const result = await this.db.transaction(async (tx) => {
      await this.lock(tx, actor, input.operationId);
      const old = await oldOperation(tx, actor, input.operationId, 'adhoc_create', input);
      if (old)
        return {
          id: old.meeting_id,
          invite: (
            await tx.query<Invite>('SELECT * FROM meeting_invites WHERE id=$1', [old.result_id])
          ).rows[0]!,
        };
      const id = await this.insertMeeting(tx, actor, input),
        value = token();
      const invite = (
        await tx.query<Invite>(
          'INSERT INTO meeting_invites(id,meeting_id,created_by,token_hash,token_ciphertext,reusable,allow_guests,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            randomUUID(),
            id,
            actor.user.id,
            hashToken(value),
            this.auth.crypto.encrypt(value),
            input.reusable,
            input.allowGuests,
            input.expiresAt,
            new Date(this.now),
          ],
        )
      ).rows[0]!;
      await tx.query('INSERT INTO meeting_invite_history(invite_id,meeting_id) VALUES($1,$2)', [
        invite.id,
        id,
      ]);
      await operation(tx, actor, id, input.operationId, 'adhoc_create', input, this.now, invite.id);
      return { id, invite };
    });
    return { meeting: await this.meetings.read(actor, result.id), invite: this.dto(result.invite) };
  }
  async read(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      requireManager(await access(tx, actor, id));
      const row = (
        await tx.query<Invite>(
          'SELECT i.* FROM meeting_invites i JOIN meeting_invite_history h ON h.invite_id=i.id WHERE h.meeting_id=$1',
          [id],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          404,
          'MEETING_INVITE_NOT_FOUND',
          'Для этой встречи приглашение не создано.',
        );
      return this.dto(row);
    });
  }
  async update(actor: Actor, id: string, input: z.infer<typeof updateMeetingInviteSchema>) {
    if (!input.revoked) this.future(input.expiresAt);
    await this.db.transaction(async (tx) => {
      await this.lock(tx, actor, input.operationId);
      requireManager(await access(tx, actor, id));
      if (await oldOperation(tx, actor, input.operationId, 'invite_update', { id, ...input }))
        return;
      const i = (
        await tx.query<Invite>(
          'SELECT i.* FROM meeting_invites i JOIN meeting_invite_history h ON h.invite_id=i.id WHERE h.meeting_id=$1 FOR UPDATE OF i',
          [id],
        )
      ).rows[0];
      if (!i)
        throw new AppError(
          404,
          'MEETING_INVITE_NOT_FOUND',
          'Для этой встречи приглашение не создано.',
        );
      requireManager(await access(tx, actor, i.meeting_id, true));
      if (i.revision !== input.revision)
        throw new AppError(409, 'MEETING_CHANGED', 'Приглашение изменилось. Обновите страницу.');
      await tx.query(
        'UPDATE meeting_invites SET allow_guests=$2,expires_at=$3,revoked_at=$4,revision=revision+1 WHERE id=$1',
        [i.id, input.allowGuests, input.expiresAt, input.revoked ? new Date(this.now) : null],
      );
      if (!input.allowGuests || input.revoked) {
        const current = await access(tx, actor, i.meeting_id, true);
        requireManager(current);
        await tx.query('UPDATE meeting_guests SET blocked_at=$2 WHERE invite_id=$1', [
          i.id,
          new Date(this.now),
        ]);
        const rows = (
          await tx.query<{ id: string; meeting_id: string }>(
            "UPDATE meeting_sessions SET state='removed',ended_at=$2,hand_raised_at=NULL WHERE guest_id IN(SELECT id FROM meeting_guests WHERE invite_id=$1) AND state IN('waiting','admitted') RETURNING id,meeting_id",
            [i.id, new Date(this.now)],
          )
        ).rows;
        for (const s of rows) {
          await command(tx, s.meeting_id, 'remove', { identity: s.id }, this.now);
          await tx.query('DELETE FROM meeting_device_reports WHERE session_id=$1', [s.id]);
        }
      }
      await operation(
        tx,
        actor,
        id,
        input.operationId,
        'invite_update',
        { id, ...input },
        this.now,
        i.id,
      );
    });
    await this.meetings.drain();
    return this.read(actor, id);
  }
  async restart(actor: Actor, id: string, operationId: string) {
    const result = await this.db.transaction(async (tx) => {
      await this.lock(tx, actor, operationId);
      requireManager(await access(tx, actor, id));
      const old = await oldOperation(tx, actor, operationId, 'invite_restart', { id });
      if (old) return old.meeting_id;
      const i = (
        await tx.query<Invite>(
          'SELECT i.* FROM meeting_invites i JOIN meeting_invite_history h ON h.invite_id=i.id WHERE h.meeting_id=$1 FOR UPDATE OF i',
          [id],
        )
      ).rows[0];
      if (!i || !i.reusable)
        throw new AppError(
          409,
          'MEETING_INVITE_NOT_REUSABLE',
          'Начать новую встречу можно только по многоразовой ссылке.',
        );
      this.valid(i);
      const a = await access(tx, actor, i.meeting_id, true);
      requireManager(a);
      if (!['completed', 'cancelled'].includes(a.m.status))
        throw new AppError(409, 'MEETING_STILL_OPEN', 'Сначала завершите текущую встречу.');
      const next = await this.insertMeeting(
        tx,
        actor,
        {
          title: a.m.title,
          description: a.m.description,
          language: a.m.language,
          timeZone: a.m.time_zone,
          durationMinutes: a.m.duration_minutes,
          lobbyEnabled: a.m.lobby_enabled,
        },
        a.m.organizer_id,
      );
      await tx.query('UPDATE meeting_invites SET meeting_id=$2,revision=revision+1 WHERE id=$1', [
        i.id,
        next,
      ]);
      await tx.query('INSERT INTO meeting_invite_history(invite_id,meeting_id) VALUES($1,$2)', [
        i.id,
        next,
      ]);
      await operation(tx, actor, next, operationId, 'invite_restart', { id }, this.now, i.id);
      return next;
    });
    return {
      meeting: await this.meetings.read(actor, result),
      invite: await this.read(actor, result),
    };
  }
  async preview(value: string) {
    return this.db.transaction(async (tx) => {
      const i = (
        await tx.query<Invite>('SELECT * FROM meeting_invites WHERE token_hash=$1', [
          hashToken(value),
        ])
      ).rows[0];
      if (!i) throw new AppError(404, 'MEETING_INVITE_NOT_FOUND', 'Приглашение не найдено.');
      this.valid(i);
      const m = (
        await tx.query<MeetingRow & { full_name: string }>(
          'SELECT m.*,u.full_name FROM scheduled_meetings m JOIN users u ON u.id=m.organizer_id WHERE m.id=$1',
          [i.meeting_id],
        )
      ).rows[0]!;
      return {
        title: m.title,
        organizer: m.full_name,
        startsAt: iso(m.starts_at),
        endsAt: iso(m.ends_at),
        status: m.status,
        allowGuests: i.allow_guests,
        reusable: i.reusable,
        expiresAt: iso(i.expires_at),
      };
    });
  }
  async redeem(
    request: FastifyRequest,
    reply: FastifyReply,
    input: z.infer<typeof redeemMeetingInviteSchema>,
  ) {
    const registered = await this.auth.actor(request);
    if (registered) await this.auth.requireActor(request, undefined, true);
    const result = await this.db.transaction(async (tx) => {
      const i = (
        await tx.query<Invite>('SELECT * FROM meeting_invites WHERE token_hash=$1 FOR UPDATE', [
          hashToken(input.token),
        ])
      ).rows[0];
      if (!i) throw new AppError(404, 'MEETING_INVITE_NOT_FOUND', 'Приглашение не найдено.');
      this.valid(i);
      const m = (
        await tx.query<MeetingRow>('SELECT * FROM scheduled_meetings WHERE id=$1 FOR UPDATE', [
          i.meeting_id,
        ])
      ).rows[0]!;
      if (['completed', 'cancelled'].includes(m.status))
        throw new AppError(
          410,
          'MEETING_ENDED',
          'Встреча завершена. Дождитесь новой встречи от организатора.',
        );
      if (registered) {
        const organizer =
          registered.user.id === m.organizer_id ||
          ['admin', 'superadmin'].includes(registered.user.role);
        if (
          !organizer &&
          !i.reusable &&
          (i.used_by_guest_id || (i.used_by_user_id && i.used_by_user_id !== registered.user.id))
        )
          throw new AppError(
            410,
            'MEETING_INVITE_USED',
            'Одноразовое приглашение уже использовано.',
          );
        const role =
          registered.user.id === m.organizer_id
            ? 'organizer'
            : registered.user.role === 'student'
              ? 'student'
              : 'participant';
        await tx.query(
          'INSERT INTO meeting_members(meeting_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(meeting_id,user_id) DO NOTHING',
          [m.id, registered.user.id, role],
        );
        if (!organizer && !i.reusable)
          await tx.query('UPDATE meeting_invites SET used_by_user_id=$2 WHERE id=$1', [
            i.id,
            registered.user.id,
          ]);
        return { meetingId: m.id, guest: null, key: null };
      }
      if (!i.allow_guests)
        throw new AppError(
          401,
          'MEETING_LOGIN_REQUIRED',
          'Организатор разрешил вход только зарегистрированным пользователям.',
        );
      if (!input.name) throw new AppError(400, 'MEETING_GUEST_NAME', 'Укажите имя для встречи.');
      const value = request.cookies[guestCookie(this.auth.settings.APP_ENV === 'production', m.id)];
      let guest = (
        await tx.query<Guest>(
          'SELECT * FROM meeting_guests WHERE meeting_id=$1 AND invite_id=$2 AND (join_operation_id=$3 OR token_hash=$4) AND expires_at>now()',
          [m.id, i.id, input.operationId, value ? hashToken(value) : ''],
        )
      ).rows[0];
      if (guest && guest.full_name !== input.name)
        throw new AppError(
          409,
          'MEETING_OPERATION_CONFLICT',
          'Имя в сохранённом приглашении отличается.',
        );
      if (
        !i.reusable &&
        (i.used_by_user_id || (i.used_by_guest_id && i.used_by_guest_id !== guest?.id))
      )
        throw new AppError(410, 'MEETING_INVITE_USED', 'Одноразовое приглашение уже использовано.');
      if (!guest) {
        const key = token();
        guest = (
          await tx.query<Guest>(
            'INSERT INTO meeting_guests(id,meeting_id,invite_id,full_name,token_hash,token_ciphertext,join_operation_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [
              randomUUID(),
              m.id,
              i.id,
              input.name,
              hashToken(key),
              this.auth.crypto.encrypt(key),
              input.operationId,
              new Date(this.now + 30 * 86400000),
              new Date(this.now),
            ],
          )
        ).rows[0]!;
      }
      const blocked = (
        await tx.query<{ blocked_at: unknown }>(
          'SELECT blocked_at FROM meeting_guests WHERE id=$1',
          [guest.id],
        )
      ).rows[0]?.blocked_at;
      if (blocked) throw new AppError(403, 'MEETING_REMOVED', 'Организатор удалил вас из встречи.');
      if (!i.reusable)
        await tx.query('UPDATE meeting_invites SET used_by_guest_id=$2 WHERE id=$1', [
          i.id,
          guest.id,
        ]);
      return { meetingId: m.id, guest, key: this.auth.crypto.decrypt(guest.token_ciphertext) };
    });
    if (result.guest)
      reply.setCookie(
        guestCookie(this.auth.settings.APP_ENV === 'production', result.meetingId),
        result.key!,
        {
          httpOnly: true,
          secure: this.auth.settings.APP_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 30 * 86400,
        },
      );
    return {
      meetingId: result.meetingId,
      guest: result.guest ? this.sessionDto(result.guest) : null,
      path: result.guest
        ? `/guest/meetings/${result.meetingId}/room`
        : `/meetings/${result.meetingId}/room`,
    };
  }
  private sessionDto(g: Guest) {
    return {
      id: g.id,
      name: g.full_name,
      meetingId: g.meeting_id,
      csrfToken: this.auth.crypto.mac('meeting-guest:' + g.token_hash),
      admitted: Boolean(g.admitted_at),
      expiresAt: iso(g.expires_at),
    };
  }
  async guestSession(request: FastifyRequest, id: string) {
    const actor = await guestActor(this.auth, request, id);
    const g = (
      await this.db.query<Guest>('SELECT * FROM meeting_guests WHERE id=$1', [actor.user.id])
    ).rows[0]!;
    return this.sessionDto(g);
  }
}
