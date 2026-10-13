import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { z } from 'zod';
import type { adminAccountCreateSchema } from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { AccountCrypto, createTotp, hashToken } from '../auth/crypto.js';
import { canonicalJson } from '../content/service.js';
import { audit, publicUser, type UserRow } from './repository.js';

type Operation = {
  target_id: string;
  kind: string;
  payload_hash: string;
  credential_fingerprint: string;
};
export class AccountCredentials {
  constructor(
    readonly db: Database,
    readonly crypto: AccountCrypto,
  ) {}
  private assertAdmin(actor: Actor) {
    if (actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
  }
  private async setup(user: UserRow) {
    if (!user.totp_secret_ciphertext)
      throw new AppError(
        409,
        'AUTHENTICATOR_NOT_READY',
        'Authenticator ещё не настроен. Создайте новый ключ.',
      );
    const manualKey = this.crypto.decrypt(user.totp_secret_ciphertext);
    return {
      user: publicUser(user),
      manualKey,
      qrDataUrl: await QRCode.toDataURL(createTotp(user.email, manualKey).toString(), {
        width: 240,
        margin: 2,
      }),
      activatedAt: user.totp_enabled_at ? new Date(user.totp_enabled_at).toISOString() : null,
    };
  }
  private async user(tx: QueryExecutor, id: string) {
    const row = (await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!row) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Аккаунт не найден.');
    return row;
  }
  async read(actor: Actor, id: string) {
    this.assertAdmin(actor);
    const user = await this.db.transaction(async (tx) => {
      const user = await this.user(tx, id);
      await audit(tx, actor.user.id, 'authenticator.admin_view', id);
      return user;
    });
    return this.setup(user);
  }
  private async lockOperation(tx: QueryExecutor, actor: Actor, operationId: string) {
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `account-op:${actor.user.id}:${operationId}`,
      ]);
    return (
      await tx.query<Operation>(
        'SELECT * FROM admin_account_operations WHERE actor_id=$1 AND operation_id=$2',
        [actor.user.id, operationId],
      )
    ).rows[0];
  }
  private async replay(tx: QueryExecutor, operation: Operation, kind: string, payloadHash: string) {
    if (operation.kind !== kind || operation.payload_hash !== payloadHash)
      throw new AppError(409, 'OPERATION_CONFLICT', 'Эта операция уже использована.');
    const row = await this.user(tx, operation.target_id);
    if (
      !row.totp_secret_ciphertext ||
      this.crypto.mac(this.crypto.decrypt(row.totp_secret_ciphertext)) !==
        operation.credential_fingerprint
    )
      throw new AppError(
        409,
        'AUTHENTICATOR_CHANGED',
        'Authenticator уже изменён. Откройте текущий QR-код.',
      );
    return row;
  }
  private async record(
    tx: QueryExecutor,
    actor: Actor,
    operationId: string,
    user: UserRow,
    kind: string,
    payloadHash: string,
    secret: string,
  ) {
    await tx.query(
      'INSERT INTO admin_account_operations (actor_id,operation_id,target_id,kind,payload_hash,credential_fingerprint) VALUES ($1,$2,$3,$4,$5,$6)',
      [actor.user.id, operationId, user.id, kind, payloadHash, this.crypto.mac(secret)],
    );
    await audit(
      tx,
      actor.user.id,
      kind === 'create' ? 'account.admin_created' : 'authenticator.admin_reset',
      user.id,
    );
  }
  async create(actor: Actor, input: z.infer<typeof adminAccountCreateSchema>) {
    this.assertAdmin(actor);
    const payloadHash = hashToken(
      canonicalJson({ email: input.email, name: input.name, role: input.role }),
    );
    const user = await this.db.transaction(async (tx) => {
      const operation = await this.lockOperation(tx, actor, input.operationId);
      if (operation) return this.replay(tx, operation, 'create', payloadHash);
      const secret = createTotp(input.email).secret.base32;
      const row = (
        await tx.query<UserRow>(
          'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true) ON CONFLICT (email) DO NOTHING RETURNING *',
          [randomUUID(), input.email, input.name, input.role, this.crypto.encrypt(secret)],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          409,
          'ACCOUNT_EXISTS',
          'Аккаунт с этой почтой уже существует. Откройте его карточку.',
        );
      await this.record(tx, actor, input.operationId, row, 'create', payloadHash, secret);
      return row;
    });
    return this.setup(user);
  }
  async reset(actor: Actor, id: string, operationId: string) {
    this.assertAdmin(actor);
    const payloadHash = hashToken(id);
    const user = await this.db.transaction(async (tx) => {
      const operation = await this.lockOperation(tx, actor, operationId);
      if (operation) return this.replay(tx, operation, 'reset', payloadHash);
      const original = await this.user(tx, id),
        secret = createTotp(original.email).secret.base32;
      const row = (
        await tx.query<UserRow>(
          'UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),totp_enabled_at=now(),totp_secret_ciphertext=$2,last_totp_counter=-1 WHERE id=$1 RETURNING *',
          [id, this.crypto.encrypt(secret)],
        )
      ).rows[0]!;
      await tx.query(
        'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
        [id],
      );
      await tx.query(
        'UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
        [id],
      );
      await this.record(tx, actor, operationId, row, 'reset', payloadHash, secret);
      return row;
    });
    return this.setup(user);
  }
}
