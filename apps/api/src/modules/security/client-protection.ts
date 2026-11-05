import { randomUUID } from 'node:crypto';
import {
  clientProtectionPolicySchema,
  type ClientProtectionPolicy,
  type User,
  CLIENT_PROTECTION_MESSAGE,
} from '@luch/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { clientProtectionEvidenceSchema } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import type { Actor, AuthService } from '../auth/service.js';
import { hashToken, token } from '../auth/crypto.js';
import { audit } from '../accounts/repository.js';
import { AppError } from '../../errors.js';
import { limitAttempts } from './rate.js';

const MINUTE = 60000;
type Challenge = {
  id: string;
  session_id: string;
  client_hash: string;
  header_hash: string;
  nonce_hash: string;
  policy_revision: number;
  resource_seen: boolean;
  consumed_at: Date | string | null;
  expires_at: Date | string;
};
export async function getClientProtectionPolicy(
  db: QueryExecutor,
): Promise<ClientProtectionPolicy> {
  const row = (
    await db.query<{
      interaction_enabled: boolean;
      interaction_roles: unknown;
      blockers_enabled: boolean;
      blockers_roles: unknown;
      revision: number;
    }>('SELECT * FROM client_protection_policy WHERE id=1')
  ).rows[0];
  if (!row) throw new AppError(503, 'POLICY_UNAVAILABLE', 'Настройки доступа временно недоступны.');
  return clientProtectionPolicySchema.parse({
    interactionEnabled: row.interaction_enabled,
    interactionRoles: row.interaction_roles,
    blockersEnabled: row.blockers_enabled,
    blockersRoles: row.blockers_roles,
    revision: row.revision,
  });
}
function selected(enabled: boolean, roles: string[], role?: User['role']) {
  return enabled && role !== undefined && role !== 'superadmin' && roles.includes(role);
}
export class ClientProtectionService {
  readonly cookie: string;
  constructor(
    readonly auth: AuthService,
    readonly now = Date.now,
  ) {
    this.cookie = auth.settings.APP_ENV === 'production' ? '__Host-luch_client' : 'luch_client';
  }
  private client(r: FastifyRequest) {
    const raw = r.cookies[this.cookie];
    return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? hashToken(raw) : null;
  }
  private header(r: FastifyRequest) {
    return this.auth.crypto.mac(`client-header:${r.headers['user-agent'] ?? ''}`);
  }
  private denied() {
    return new AppError(403, 'CLIENT_CAPABILITIES_REQUIRED', CLIENT_PROTECTION_MESSAGE);
  }
  private async verified(
    r: FastifyRequest,
    actor: Actor,
    p: ClientProtectionPolicy,
    db: QueryExecutor = this.auth.database,
  ) {
    const client = this.client(r);
    if (!client) return false;
    return Boolean(
      (
        await db.query(
          `SELECT 1 FROM client_capability_grants WHERE session_id=$1 AND client_hash=$2
       AND header_hash=$3 AND policy_revision=$4 AND verified_until>$5`,
          [actor.sessionId, client, this.header(r), p.revision, new Date(this.now())],
        )
      ).rows[0],
    );
  }
  async check(r: FastifyRequest) {
    if (!r.cookies[this.auth.sessionCookie]) return;
    const p = await getClientProtectionPolicy(this.auth.database);
    if (!p.blockersEnabled) return;
    const actor = await this.auth.actor(r);
    if (
      actor &&
      selected(p.blockersEnabled, p.blockersRoles, actor.user.role) &&
      !(await this.verified(r, actor, p))
    )
      throw this.denied();
  }
  async bootstrap(r: FastifyRequest, reply: FastifyReply, force: boolean) {
    const p = await getClientProtectionPolicy(this.auth.database);
    const actor = await this.auth.actor(r);
    const interactionRestricted = selected(
      p.interactionEnabled,
      p.interactionRoles,
      actor?.user.role,
    );
    const blockersRequired = selected(p.blockersEnabled, p.blockersRoles, actor?.user.role);
    const verified = !blockersRequired || (actor !== null && (await this.verified(r, actor, p)));
    const state = {
      interactionRestricted,
      blockersRequired,
      verified,
      revision: p.revision,
      challenge: null,
    };
    if (!blockersRequired || !actor || (verified && !force)) return state;
    await limitAttempts(
      this.auth.database,
      this.auth.crypto,
      `client-challenge:${actor.sessionId}`,
      120,
    );
    let client = this.client(r);
    if (!client) {
      const raw = token();
      client = hashToken(raw);
      reply.setCookie(this.cookie, raw, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: this.auth.settings.APP_ENV === 'production',
        maxAge: 86400,
      });
    }
    const id = randomUUID(),
      nonce = token();
    await this.auth.database.query(
      `INSERT INTO client_capability_challenges
       (id,session_id,client_hash,header_hash,nonce_hash,policy_revision,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        actor.sessionId,
        client,
        this.header(r),
        hashToken(nonce),
        p.revision,
        new Date(this.now() + 2 * MINUTE),
      ],
    );
    return { ...state, challenge: { id, nonce } };
  }
  private matches(
    row: Challenge | undefined,
    r: FastifyRequest,
    actor: Actor,
    p: ClientProtectionPolicy,
  ): row is Challenge {
    return Boolean(
      row &&
      row.session_id === actor.sessionId &&
      row.client_hash === this.client(r) &&
      row.header_hash === this.header(r) &&
      row.policy_revision === p.revision &&
      selected(p.blockersEnabled, p.blockersRoles, actor.user.role) &&
      new Date(row.expires_at).getTime() > this.now(),
    );
  }
  private proof(row: Challenge) {
    return this.auth.crypto.mac(`client-resource:${row.id}:${row.nonce_hash}`);
  }
  async resource(r: FastifyRequest, id: string) {
    const actor = await this.auth.requireActor(r);
    const p = await getClientProtectionPolicy(this.auth.database);
    const row = (
      await this.auth.database.query<Challenge>(
        'SELECT * FROM client_capability_challenges WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!this.matches(row, r, actor, p) || row.consumed_at) throw this.denied();
    await this.auth.database.query(
      'UPDATE client_capability_challenges SET resource_seen=true WHERE id=$1',
      [id],
    );
    return `window.dispatchEvent(new CustomEvent('luch:client-resource',{detail:${JSON.stringify({ id, proof: this.proof(row) })}}));`;
  }
  async verify(r: FastifyRequest, input: z.infer<typeof clientProtectionEvidenceSchema>) {
    const actor = await this.auth.requireActor(r);
    await limitAttempts(
      this.auth.database,
      this.auth.crypto,
      `client-verify:${actor.sessionId}`,
      120,
    );
    const accepted = await this.auth.database.transaction(async (tx) => {
      // Same lock order as settings changes; revocation and verification cannot cross revisions.
      const p = await getClientProtectionPolicyWithLock(tx);
      const row = (
        await tx.query<Challenge>(
          'SELECT * FROM client_capability_challenges WHERE id=$1 FOR UPDATE',
          [input.id],
        )
      ).rows[0];
      if (
        !this.matches(row, r, actor, p) ||
        !this.auth.crypto.matches(hashToken(input.nonce), row.nonce_hash)
      )
        throw this.denied();
      if (
        !input.visible ||
        !row.resource_seen ||
        !input.proof ||
        !this.auth.crypto.matches(input.proof, this.proof(row))
      ) {
        await tx.query(
          'DELETE FROM client_capability_grants WHERE session_id=$1 AND client_hash=$2',
          [actor.sessionId, row.client_hash],
        );
        await tx.query('UPDATE client_capability_challenges SET consumed_at=$2 WHERE id=$1', [
          row.id,
          new Date(this.now()),
        ]);
        return false;
      }
      // A lost successful response may be retried, without extending an already issued grant.
      if (row.consumed_at) return await this.verified(r, actor, p, tx);
      await tx.query('UPDATE client_capability_challenges SET consumed_at=$2 WHERE id=$1', [
        row.id,
        new Date(this.now()),
      ]);
      await tx.query(
        `INSERT INTO client_capability_grants(session_id,client_hash,header_hash,policy_revision,verified_until)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,client_hash) DO UPDATE SET
         header_hash=EXCLUDED.header_hash,policy_revision=EXCLUDED.policy_revision,verified_until=EXCLUDED.verified_until`,
        [
          actor.sessionId,
          row.client_hash,
          row.header_hash,
          p.revision,
          new Date(this.now() + 5 * MINUTE),
        ],
      );
      return true;
    });
    if (!accepted) throw this.denied();
    return { message: 'Проверка завершена.' };
  }
  async update(r: FastifyRequest, input: ClientProtectionPolicy) {
    const actor = await this.auth.requireActor(r, 'superadmin', true);
    return this.auth.database.transaction(async (tx) => {
      const current = await getClientProtectionPolicyWithLock(tx, true);
      const { revision: _old, ...before } = current;
      const { revision: _new, ...after } = input;
      if (JSON.stringify(before) === JSON.stringify(after)) return current;
      if (input.revision !== current.revision)
        throw new AppError(409, 'POLICY_CHANGED', 'Настройки изменились. Обновите страницу.');
      await tx.query(
        `UPDATE client_protection_policy SET interaction_enabled=$1,interaction_roles=$2,
         blockers_enabled=$3,blockers_roles=$4,revision=revision+1,updated_at=$5,updated_by=$6 WHERE id=1`,
        [
          input.interactionEnabled,
          JSON.stringify(input.interactionRoles),
          input.blockersEnabled,
          JSON.stringify(input.blockersRoles),
          new Date(this.now()),
          actor.user.id,
        ],
      );
      await tx.query('DELETE FROM client_capability_grants');
      await tx.query('DELETE FROM client_capability_challenges');
      await audit(tx, actor.user.id, 'security.client_protection.updated');
      return { ...input, revision: current.revision + 1 };
    });
  }
  async cleanup() {
    await this.auth.database.query('DELETE FROM client_capability_challenges WHERE expires_at<$1', [
      new Date(this.now()),
    ]);
    await this.auth.database.query('DELETE FROM client_capability_grants WHERE verified_until<$1', [
      new Date(this.now()),
    ]);
  }
}
async function getClientProtectionPolicyWithLock(tx: QueryExecutor, write = false) {
  await tx.query(
    `SELECT id FROM client_protection_policy WHERE id=1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
  );
  return getClientProtectionPolicy(tx);
}
