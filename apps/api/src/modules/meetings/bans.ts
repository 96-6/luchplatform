import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  MEETING_BAN_HOLD_MS,
  type prepareMeetingBanSchema,
  type editMeetingBanSchema,
  type meetingIpBansQuerySchema,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { normalizeIp } from '../security/policy.js';
import { audit } from '../accounts/repository.js';
import { access, requireManager, iso } from './repository.js';
import { canonicalJson } from '../content/service.js';
import { removeMeetingSessions } from './revocation.js';

export const meetingBanMessage =
  'Гостевой вход с этого IP-адреса заблокирован организатором встречи.';
const scope = `(b.meeting_id=$1 OR b.invite_id IN (SELECT invite_id FROM meeting_invite_history WHERE meeting_id=$1))`;
export async function assertGuestIpAllowed(tx: QueryExecutor, meetingId: string, ip: string) {
  if (
    (
      await tx.query(`SELECT 1 FROM meeting_ip_bans b WHERE b.active AND b.ip=$2 AND ${scope}`, [
        meetingId,
        normalizeIp(ip),
      ])
    ).rows.length
  )
    throw new AppError(403, 'MEETING_IP_BANNED', meetingBanMessage);
}
type Ban = {
  id: string;
  meeting_id: string;
  invite_id: string | null;
  ip: string;
  target_name: string;
  owner_id: string;
  reason: string;
  active: boolean;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  updated_by: string;
};
type Change = {
  ip: string;
  reason: string;
  active: boolean;
  targetName: string;
  revision?: number;
};
type Confirmation = {
  id: string;
  actor_id: string;
  session_id: string;
  operation_id: string;
  meeting_id: string;
  ban_id: string | null;
  request: Change;
  ready_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  result_id: string | null;
};
const person = (r: { id: string; full_name: string; email: string }) => ({
  id: r.id,
  name: r.full_name,
  email: r.email,
});
export class MeetingBans {
  constructor(
    readonly db: Database,
    readonly now = Date.now,
  ) {}
  private ip(value: string) {
    try {
      return normalizeIp(value);
    } catch {
      throw new AppError(400, 'INVALID_IP', 'Укажите один корректный IPv4- или IPv6-адрес.');
    }
  }
  private editAccess(actor: Actor, b: Ban) {
    if (actor.user.role !== 'superadmin' && actor.user.id !== b.owner_id)
      throw new AppError(
        403,
        'BAN_OWNER_REQUIRED',
        'Изменять блокировку может её автор или суперадмин.',
      );
  }
  private async ban(tx: QueryExecutor, id: string, lock = false) {
    const b = (
      await tx.query<Ban>(
        'SELECT * FROM meeting_ip_bans WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
        [id],
      )
    ).rows[0];
    if (!b) throw new AppError(404, 'BAN_NOT_FOUND', 'Блокировка не найдена.');
    return b;
  }
  private async prepare(
    actor: Actor,
    meetingId: string,
    operationId: string,
    banId: string | null,
    request: Change,
  ) {
    return this.db.transaction(async (tx) => {
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `meeting-ban:${actor.user.id}:${operationId}`,
        ]);
      let row = (
        await tx.query<Confirmation>(
          'SELECT * FROM meeting_ban_confirmations WHERE actor_id=$1 AND operation_id=$2',
          [actor.user.id, operationId],
        )
      ).rows[0];
      if (
        row &&
        (row.session_id !== actor.sessionId ||
          row.meeting_id !== meetingId ||
          row.ban_id !== banId ||
          canonicalJson(row.request) !== canonicalJson(request))
      )
        throw new AppError(
          409,
          'BAN_OPERATION_CONFLICT',
          'Эта операция уже использована для другой блокировки.',
        );
      if (!row)
        row = (
          await tx.query<Confirmation>(
            'INSERT INTO meeting_ban_confirmations(id,actor_id,session_id,operation_id,meeting_id,ban_id,request,ready_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [
              randomUUID(),
              actor.user.id,
              actor.sessionId,
              operationId,
              meetingId,
              banId,
              JSON.stringify(request),
              new Date(this.now() + MEETING_BAN_HOLD_MS),
              new Date(this.now() + 120000),
            ],
          )
        ).rows[0]!;
      if (!row.consumed_at && new Date(row.expires_at).getTime() <= this.now()) {
        row = (
          await tx.query<Confirmation>(
            'UPDATE meeting_ban_confirmations SET ready_at=$2,expires_at=$3 WHERE id=$1 RETURNING *',
            [row.id, new Date(this.now() + MEETING_BAN_HOLD_MS), new Date(this.now() + 120000)],
          )
        ).rows[0]!;
      }
      return {
        id: row.id,
        ip: request.ip,
        targetName: request.targetName,
        readyAt: iso(row.ready_at),
        expiresAt: iso(row.expires_at),
      };
    });
  }
  async prepareCreate(
    actor: Actor,
    meetingId: string,
    input: z.infer<typeof prepareMeetingBanSchema>,
  ) {
    const a = await access(this.db, actor, meetingId);
    requireManager(a);
    let ip = input.ip,
      targetName = 'Гостевой IP';
    if (input.sessionId) {
      const s = (
        await this.db.query<{ ip: string | null; full_name: string }>(
          `SELECT COALESCE(s.remote_ip,g.last_ip) AS ip,g.full_name FROM meeting_sessions s JOIN meeting_guests g ON g.id=s.guest_id WHERE s.id=$1 AND s.meeting_id=$2 AND s.state IN ('waiting','admitted')`,
          [input.sessionId, meetingId],
        )
      ).rows[0];
      if (!s) throw new AppError(404, 'MEETING_GUEST_NOT_FOUND', 'Гость не найден во встрече.');
      if (!s.ip)
        throw new AppError(
          409,
          'GUEST_IP_UNAVAILABLE',
          'IP-адрес гостя пока недоступен. Дождитесь его повторного подключения.',
        );
      ip = s.ip;
      targetName = s.full_name;
    }
    return this.prepare(actor, meetingId, input.operationId, null, {
      ip: this.ip(ip!),
      reason: input.reason,
      active: true,
      targetName,
    });
  }
  async prepareEdit(actor: Actor, id: string, input: z.infer<typeof editMeetingBanSchema>) {
    const b = await this.ban(this.db, id);
    this.editAccess(actor, b);
    if (b.revision !== input.revision)
      throw new AppError(409, 'BAN_CHANGED', 'Блокировка уже изменена. Обновите список.');
    const ip = this.ip(input.ip);
    return this.prepare(actor, b.meeting_id, input.operationId, id, {
      ip,
      reason: input.reason,
      active: input.active,
      revision: input.revision,
      targetName: ip === b.ip ? b.target_name : 'Гостевой IP',
    });
  }
  async confirm(actor: Actor, id: string) {
    let result: string;
    try {
      result = await this.db.transaction(async (tx) => {
        const c = (
          await tx.query<Confirmation>(
            'SELECT * FROM meeting_ban_confirmations WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!c || c.actor_id !== actor.user.id || c.session_id !== actor.sessionId)
          throw new AppError(404, 'BAN_CONFIRMATION_NOT_FOUND', 'Подтверждение не найдено.');
        const old = c.ban_id ? await this.ban(tx, c.ban_id, true) : null;
        if (old) this.editAccess(actor, old);
        else requireManager(await access(tx, actor, c.meeting_id, true));
        if (c.consumed_at) return c.result_id!;
        if (new Date(c.expires_at).getTime() <= this.now())
          throw new AppError(
            410,
            'BAN_CONFIRMATION_EXPIRED',
            'Подтверждение устарело. Повторите удержание кнопки.',
          );
        if (new Date(c.ready_at).getTime() > this.now())
          throw new AppError(
            409,
            'BAN_HOLD_REQUIRED',
            'Для подтверждения удерживайте «Да» пять секунд.',
          );
        if (old && old.revision !== c.request.revision)
          throw new AppError(409, 'BAN_CHANGED', 'Блокировка уже изменена. Обновите список.');
        const r = c.request,
          at = new Date(this.now()),
          banId = old?.id ?? randomUUID();
        if (old)
          await tx.query(
            'UPDATE meeting_ip_bans SET ip=$2,reason=$3,active=$4,target_name=$5,revision=revision+1,updated_at=$6,updated_by=$7 WHERE id=$1',
            [banId, r.ip, r.reason, r.active, r.targetName, at, actor.user.id],
          );
        else {
          const invite =
            (
              await tx.query<{ invite_id: string }>(
                'SELECT invite_id FROM meeting_invite_history WHERE meeting_id=$1 ORDER BY invite_id LIMIT 1',
                [c.meeting_id],
              )
            ).rows[0]?.invite_id ?? null;
          await tx.query(
            'INSERT INTO meeting_ip_bans(id,meeting_id,invite_id,ip,target_name,owner_id,reason,active,created_at,updated_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8,$8,$6)',
            [banId, c.meeting_id, invite, r.ip, r.targetName, actor.user.id, r.reason, at],
          );
        }
        const before = old
          ? { ip: old.ip, reason: old.reason, active: old.active, targetName: old.target_name }
          : null;
        const after = { ip: r.ip, reason: r.reason, active: r.active, targetName: r.targetName };
        const kind = !old
          ? 'created'
          : old.active && !r.active
            ? 'revoked'
            : !old.active && r.active
              ? 'reactivated'
              : 'updated';
        await tx.query(
          'INSERT INTO meeting_ip_ban_events(id,ban_id,actor_id,operation_id,kind,before_state,after_state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            banId,
            actor.user.id,
            c.operation_id,
            kind,
            before ? JSON.stringify(before) : null,
            JSON.stringify(after),
            at,
          ],
        );
        await tx.query(
          'UPDATE meeting_ban_confirmations SET consumed_at=$2,result_id=$3 WHERE id=$1',
          [id, at, banId],
        );
        if (r.active) await this.enforce(tx);
        await audit(tx, actor.user.id, 'meeting.ip_ban_' + kind);
        return banId;
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505')
        throw new AppError(
          409,
          'BAN_EXISTS',
          'Для этого IP уже есть действующая блокировка в этом приглашении.',
        );
      throw e;
    }
    return this.read(actor, result);
  }
  async enforce(tx: QueryExecutor = this.db) {
    const rows = (
      await tx.query<{ id: string }>(
        `SELECT s.id FROM meeting_sessions s JOIN meeting_guests g ON g.id=s.guest_id WHERE s.state IN ('waiting','admitted') AND EXISTS(SELECT 1 FROM meeting_ip_bans b WHERE b.active AND b.ip=COALESCE(s.remote_ip,g.last_ip) AND (b.meeting_id=s.meeting_id OR b.invite_id=g.invite_id)) ORDER BY s.id`,
      )
    ).rows;
    await removeMeetingSessions(
      tx,
      rows.map((s) => s.id),
      this.now(),
    );
  }
  async read(actor: Actor, id: string, scopedManager = false) {
    const b = await this.ban(this.db, id);
    if (!scopedManager && actor.user.role !== 'superadmin' && actor.user.id !== b.owner_id)
      requireManager(await access(this.db, actor, b.meeting_id));
    const people = (
      await this.db.query<{ id: string; full_name: string; email: string }>(
        'SELECT id,full_name,email FROM users WHERE id=ANY($1::uuid[])',
        [[b.owner_id, b.updated_by]],
      )
    ).rows;
    const events = (
      await this.db.query<{
        id: string;
        kind: string;
        actor_id: string;
        full_name: string;
        email: string;
        before_state: unknown;
        after_state: unknown;
        created_at: Date | string;
      }>(
        'SELECT e.*,u.full_name,u.email FROM meeting_ip_ban_events e JOIN users u ON u.id=e.actor_id WHERE e.ban_id=$1 ORDER BY e.created_at DESC,e.id DESC',
        [id],
      )
    ).rows;
    const m = (
      await this.db.query<{ title: string }>('SELECT title FROM scheduled_meetings WHERE id=$1', [
        b.meeting_id,
      ])
    ).rows[0]!;
    return {
      id: b.id,
      meetingId: b.meeting_id,
      meetingTitle: m.title,
      inviteId: b.invite_id,
      ip: b.ip,
      targetName: b.target_name,
      owner: person(people.find((p) => p.id === b.owner_id)!),
      reason: b.reason,
      active: b.active,
      revision: b.revision,
      createdAt: iso(b.created_at),
      updatedAt: iso(b.updated_at),
      updatedBy: person(people.find((p) => p.id === b.updated_by)!),
      canEdit: actor.user.role === 'superadmin' || actor.user.id === b.owner_id,
      history: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        actor: person({ id: e.actor_id, full_name: e.full_name, email: e.email }),
        before: e.before_state,
        after: e.after_state,
        createdAt: iso(e.created_at),
      })),
    };
  }
  async list(actor: Actor, input: z.infer<typeof meetingIpBansQuerySchema>) {
    if (input.meetingId) requireManager(await access(this.db, actor, input.meetingId));
    const rows = (
      await this.db.query<{ id: string; created_at: Date | string }>(
        `SELECT b.id,b.created_at FROM meeting_ip_bans b WHERE ($2::boolean OR b.owner_id=$3 OR $1::uuid IS NOT NULL) AND ($1::uuid IS NULL OR ${scope}) AND ($4::timestamptz IS NULL OR (b.created_at,b.id)<($4,$5::uuid)) ORDER BY b.created_at DESC,b.id DESC LIMIT $6`,
        [
          input.meetingId ?? null,
          actor.user.role === 'superadmin',
          actor.user.id,
          input.beforeCreatedAt ?? null,
          input.beforeId ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const chosen = rows.slice(0, input.limit),
      last = chosen.at(-1);
    const items = [];
    for (const row of chosen) items.push(await this.read(actor, row.id, Boolean(input.meetingId)));
    return {
      items,
      nextCursor:
        rows.length > input.limit && last ? { createdAt: iso(last.created_at), id: last.id } : null,
    };
  }
}
