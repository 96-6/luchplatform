import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  browserNames,
  type createBrowserAccessLinkSchema,
  type browserAccessPageQuerySchema,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { AuthService } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { hashToken, token } from '../auth/crypto.js';
import { userAgentIdentity } from './browsers-detection.js';

type Query = z.infer<typeof browserAccessPageQuerySchema>;
type Link = {
  id: string;
  created_by: string;
  label: string;
  single_use: boolean;
  token_hash: string;
  token_ciphertext: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
};
type Device = {
  id: string;
  link_id: string;
  token_hash: string;
  label: string;
  browser: string;
  platform: string;
  user_agent: string;
  first_ip: string;
  last_ip: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  last_user_id: string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
};
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const unavailable = () =>
  new AppError(
    410,
    'BROWSER_ACCESS_LINK_UNAVAILABLE',
    'Ссылка ручного допуска недоступна. Запросите новую ссылку у суперадмина.',
  );
export const BROWSER_DEVICE_SECONDS = 365 * 24 * 3600;
export class BrowserManualAccess {
  readonly cookie: string;
  constructor(
    readonly auth: AuthService,
    readonly now = Date.now,
  ) {
    this.cookie =
      auth.settings.APP_ENV === 'production' ? '__Host-luch_browser_access' : 'luch_browser_access';
  }
  cookieOptions() {
    return {
      path: '/',
      httpOnly: true,
      secure: this.auth.settings.APP_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: BROWSER_DEVICE_SECONDS,
    };
  }
  secret(r: FastifyRequest) {
    const value = r.cookies[this.cookie];
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  async current(r: FastifyRequest, tx: QueryExecutor = this.auth.database) {
    const secret = this.secret(r);
    if (!secret) return null;
    return (
      (
        await tx.query<Device>(
          'SELECT d.* FROM browser_access_devices d JOIN browser_access_links l ON l.id=d.link_id WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>$2 AND l.revoked_at IS NULL',
          [hashToken(secret), new Date(this.now())],
        )
      ).rows[0] ?? null
    );
  }
  async allowed(r: FastifyRequest) {
    const device = await this.current(r);
    if (!device) return false;
    const actor = await this.auth.actor(r);
    if (
      this.now() - new Date(device.last_seen_at).getTime() >= 60000 ||
      (actor && actor.user.id !== device.last_user_id)
    ) {
      const identity = userAgentIdentity(r.headers['user-agent'] ?? '');
      await this.auth.database.query(
        'UPDATE browser_access_devices SET last_seen_at=$2,last_ip=$3,user_agent=$4,browser=$5,platform=$6,last_user_id=COALESCE($7,last_user_id) WHERE id=$1 AND revoked_at IS NULL',
        [
          device.id,
          new Date(this.now()),
          r.ip.slice(0, 80),
          (r.headers['user-agent'] ?? '').slice(0, 1024),
          identity.family,
          identity.platform,
          actor?.user.id ?? null,
        ],
      );
    }
    return true;
  }
  private async person(tx: QueryExecutor, id: string | null) {
    if (!id) return null;
    return (
      (
        await tx.query<{ id: string; name: string; email: string }>(
          'SELECT id,full_name AS name,email FROM users WHERE id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  }
  private async view(tx: QueryExecutor, l: Link) {
    const counts = (
      await tx.query<{ total: number; active: number }>(
        'SELECT count(*)::int AS total,count(*) FILTER (WHERE revoked_at IS NULL AND expires_at>$2)::int AS active FROM browser_access_devices WHERE link_id=$1',
        [l.id, new Date(this.now())],
      )
    ).rows[0]!;
    const status = l.revoked_at
      ? 'revoked'
      : l.expires_at && new Date(l.expires_at).getTime() <= this.now()
        ? 'expired'
        : l.single_use && counts.total > 0
          ? 'used'
          : 'active';
    const url = new URL('/browser-access', this.auth.settings.APP_URL);
    url.searchParams.set('token', this.auth.crypto.decrypt(l.token_ciphertext));
    return {
      id: l.id,
      label: l.label,
      singleUse: l.single_use,
      url: url.toString(),
      creator: await this.person(tx, l.created_by),
      createdAt: iso(l.created_at),
      expiresAt: iso(l.expires_at),
      revokedAt: iso(l.revoked_at),
      revokedBy: await this.person(tx, l.revoked_by),
      status,
      totalDevices: counts.total,
      activeDevices: l.revoked_at ? 0 : counts.active,
    };
  }
  async list(r: FastifyRequest, q: Query) {
    await this.auth.requireActor(r, 'superadmin');
    const rows = (
      await this.auth.database.query<Link>(
        'SELECT * FROM browser_access_links WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3',
        [q.beforeCreatedAt ?? null, q.beforeId ?? null, q.limit + 1],
      )
    ).rows;
    const items = [];
    for (const row of rows.slice(0, q.limit)) items.push(await this.view(this.auth.database, row));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > q.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
  async create(r: FastifyRequest, input: z.infer<typeof createBrowserAccessLinkSchema>) {
    const actor = await this.auth.requireActor(r, 'superadmin', true);
    return this.auth.database.transaction(async (tx) => {
      if (this.auth.database.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `browser-link:${actor.user.id}:${input.operationId}`,
        ]);
      const old = (
        await tx.query<Link>(
          'SELECT * FROM browser_access_links WHERE created_by=$1 AND operation_id=$2',
          [actor.user.id, input.operationId],
        )
      ).rows[0];
      if (old) {
        if (
          old.label !== input.label ||
          old.single_use !== input.singleUse ||
          iso(old.expires_at) !== (input.expiresAt ? new Date(input.expiresAt).toISOString() : null)
        )
          throw new AppError(
            409,
            'BROWSER_ACCESS_OPERATION_CONFLICT',
            'Ссылка уже создана с другими параметрами.',
          );
        return this.view(tx, old);
      }
      if (input.expiresAt && new Date(input.expiresAt).getTime() <= this.now())
        throw new AppError(
          400,
          'BROWSER_ACCESS_EXPIRY',
          'Срок действия ссылки должен быть в будущем.',
        );
      const raw = token();
      const row = (
        await tx.query<Link>(
          'INSERT INTO browser_access_links(id,created_by,operation_id,label,single_use,token_hash,token_ciphertext,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            randomUUID(),
            actor.user.id,
            input.operationId,
            input.label,
            input.singleUse,
            hashToken(raw),
            this.auth.crypto.encrypt(raw),
            new Date(this.now()),
            input.expiresAt ? new Date(input.expiresAt) : null,
          ],
        )
      ).rows[0]!;
      await audit(tx, actor.user.id, 'browser.access_link_created');
      return this.view(tx, row);
    });
  }
  async revokeLink(r: FastifyRequest, id: string) {
    const actor = await this.auth.requireActor(r, 'superadmin', true);
    return this.auth.database.transaction(async (tx) => {
      const row = (
        await tx.query<Link>('SELECT * FROM browser_access_links WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw new AppError(404, 'BROWSER_ACCESS_NOT_FOUND', 'Ручной допуск не найден.');
      if (!row.revoked_at) {
        await tx.query('UPDATE browser_access_links SET revoked_at=$2,revoked_by=$3 WHERE id=$1', [
          id,
          new Date(this.now()),
          actor.user.id,
        ]);
        await audit(tx, actor.user.id, 'browser.access_link_revoked');
      }
      return { ok: true };
    });
  }
  async devices(r: FastifyRequest, id: string, q: Query) {
    await this.auth.requireActor(r, 'superadmin');
    const db = this.auth.database;
    const parent = (await db.query<Link>('SELECT * FROM browser_access_links WHERE id=$1', [id]))
      .rows[0];
    if (!parent) throw new AppError(404, 'BROWSER_ACCESS_NOT_FOUND', 'Ручной допуск не найден.');
    const rows = (
      await db.query<Device>(
        'SELECT * FROM browser_access_devices WHERE link_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
        [id, q.beforeCreatedAt ?? null, q.beforeId ?? null, q.limit + 1],
      )
    ).rows;
    const items = [];
    for (const d of rows.slice(0, q.limit))
      items.push({
        id: d.id,
        linkId: d.link_id,
        label: d.label,
        browser: d.browser,
        platform: d.platform,
        userAgent: d.user_agent,
        firstIp: d.first_ip,
        lastIp: d.last_ip,
        createdAt: iso(d.created_at),
        lastSeenAt: iso(d.last_seen_at),
        expiresAt: iso(d.expires_at),
        lastUser: await this.person(db, d.last_user_id),
        revokedAt: iso(d.revoked_at),
        revokedBy: await this.person(db, d.revoked_by),
        active:
          !parent.revoked_at && !d.revoked_at && new Date(d.expires_at).getTime() > this.now(),
      });
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > q.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
  async revokeDevice(r: FastifyRequest, id: string, deviceId: string) {
    const actor = await this.auth.requireActor(r, 'superadmin', true);
    return this.auth.database.transaction(async (tx) => {
      const row = (
        await tx.query<Device>(
          'SELECT * FROM browser_access_devices WHERE id=$1 AND link_id=$2 FOR UPDATE',
          [deviceId, id],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'BROWSER_ACCESS_NOT_FOUND', 'Ручной допуск не найден.');
      if (!row.revoked_at) {
        await tx.query(
          'UPDATE browser_access_devices SET revoked_at=$2,revoked_by=$3 WHERE id=$1',
          [deviceId, new Date(this.now()), actor.user.id],
        );
        await audit(tx, actor.user.id, 'browser.access_device_revoked', row.last_user_id);
      }
      return { ok: true };
    });
  }
  proof(secret: string, raw: string, expires = this.now() + 600000) {
    return `${expires}.${this.auth.crypto.mac(`browser-access-form:${hashToken(secret)}:${hashToken(raw)}:${expires}`)}`;
  }
  private async link(raw: string, tx: QueryExecutor, lock = false) {
    const l = (
      await tx.query<Link>(
        `SELECT * FROM browser_access_links WHERE token_hash=$1${lock ? ' FOR UPDATE' : ''}`,
        [hashToken(raw)],
      )
    ).rows[0];
    if (!l || l.revoked_at || (l.expires_at && new Date(l.expires_at).getTime() <= this.now()))
      throw unavailable();
    return l;
  }
  async preview(r: FastifyRequest, raw: string) {
    const db = this.auth.database,
      l = await this.link(raw, db);
    const existing = await this.current(r);
    const count = Number(
      (
        await db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM browser_access_devices WHERE link_id=$1',
          [l.id],
        )
      ).rows[0]!.n,
    );
    if (l.single_use && count > 0 && existing?.link_id !== l.id) throw unavailable();
    let secret = this.secret(r);
    if (
      !secret ||
      (!existing &&
        (
          await db.query('SELECT 1 FROM browser_access_devices WHERE token_hash=$1', [
            hashToken(secret),
          ])
        ).rows.length)
    )
      secret = token();
    return { secret, proof: this.proof(secret, raw), alreadyAllowed: Boolean(existing) };
  }
  async redeem(r: FastifyRequest, raw: string, proof: string, label: string) {
    const secret = this.secret(r),
      deadline = Number(proof.split('.')[0]);
    if (
      !secret ||
      !Number.isSafeInteger(deadline) ||
      deadline <= this.now() ||
      deadline > this.now() + 600000 ||
      !this.auth.crypto.matches(proof, this.proof(secret, raw, deadline))
    )
      throw new AppError(
        403,
        'BROWSER_ACCESS_FORM_INVALID',
        'Откройте ссылку ручного допуска заново.',
      );
    const actor = await this.auth.actor(r);
    await this.auth.database.transaction(async (tx) => {
      if (this.auth.database.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `browser-device:${hashToken(secret)}`,
        ]);
      const l = await this.link(raw, tx, true);
      const existing = await this.current(r, tx);
      const used = (
        await tx.query('SELECT 1 FROM browser_access_devices WHERE link_id=$1 LIMIT 1', [l.id])
      ).rows.length;
      if (l.single_use && used && existing?.link_id !== l.id) throw unavailable();
      if (existing) return;
      const identity = userAgentIdentity(r.headers['user-agent'] ?? '');
      const collision = (
        await tx.query('SELECT 1 FROM browser_access_devices WHERE token_hash=$1', [
          hashToken(secret),
        ])
      ).rows.length;
      if (collision)
        throw new AppError(
          403,
          'BROWSER_ACCESS_FORM_INVALID',
          'Откройте ссылку ручного допуска заново.',
        );
      await tx.query(
        'INSERT INTO browser_access_devices(id,link_id,token_hash,label,browser,platform,user_agent,first_ip,last_ip,created_at,last_seen_at,expires_at,last_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9,$10,$11)',
        [
          randomUUID(),
          l.id,
          hashToken(secret),
          label || `${browserNames[identity.family]} · ${identity.platform}`,
          identity.family,
          identity.platform,
          (r.headers['user-agent'] ?? '').slice(0, 1024),
          r.ip.slice(0, 80),
          new Date(this.now()),
          new Date(this.now() + BROWSER_DEVICE_SECONDS * 1000),
          actor?.user.id ?? null,
        ],
      );
      await audit(tx, actor?.user.id ?? null, 'browser.access_device_remembered', l.created_by);
    });
  }
}
