import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { registerSchema, type Session, type User } from '@luch/contracts';
import type { Settings } from '../../config.js';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { publicUser, dashboardPath, audit, type UserRow } from '../accounts/repository.js';
import type { MailService } from '../mail/service.js';
import type { NetworkService } from '../security/network.js';
import { getPolicy } from '../security/policy.js';
import { AccountCrypto, createTotp, hashToken, token } from './crypto.js';
import { localDebugRequest } from './local.js';

export const anonymousSession: Session = { user: null, csrfToken: null, dashboardPath: null };
export type Actor = { user: User; tokenHash: string; sessionId: string };
type TokenRow = { user_id: string; expires_at: Date | string };

export class AuthService {
  readonly sessionCookie: string;
  readonly enrollmentCookie: string;
  constructor(
    readonly database: Database,
    readonly settings: Settings,
    readonly crypto: AccountCrypto,
    readonly mail: MailService,
    readonly network: NetworkService,
  ) {
    this.sessionCookie = settings.APP_ENV === 'production' ? '__Host-luch_session' : 'luch_session';
    this.enrollmentCookie =
      settings.APP_ENV === 'production' ? '__Host-luch_enrollment' : 'luch_enrollment';
  }
  private cookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      secure: this.settings.APP_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge,
    };
  }
  private async emailToken(tx: QueryExecutor, user: UserRow) {
    const value = token();
    await tx.query(
      "UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND kind='email' AND consumed_at IS NULL",
      [user.id],
    );
    await tx.query(
      'INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at) VALUES ($1,$2,$3,$4)',
      [hashToken(value), user.id, 'email', new Date(Date.now() + 30 * 60 * 1000)],
    );
    return this.mail.queue(tx, user.id, user.email, value);
  }
  async register(input: z.infer<typeof registerSchema>) {
    const mailId = await this.database.transaction(async (tx) => {
      const inserted = await tx.query<UserRow>(
        'INSERT INTO users (id,email,full_name,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING *',
        [randomUUID(), input.email, input.name, input.role],
      );
      const user =
        inserted.rows[0] ??
        (await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [input.email]))
          .rows[0];
      if (!user || user.totp_enabled_at || user.is_blocked) return null;
      return this.emailToken(tx, user);
    });
    if (mailId) await this.mail.send(mailId);
    return {
      message:
        'Если адрес доступен для регистрации, письмо подтверждения отправлено. Проверьте почту.',
    };
  }
  async provision(email: string, name: string, role: User['role'], isDemo: boolean) {
    const result = await this.database.transaction(async (tx) => {
      const created = await tx.query<UserRow>(
        'INSERT INTO users (id,email,full_name,role,is_demo,access_verified) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING RETURNING *',
        [randomUUID(), email.toLowerCase(), name, role, isDemo, role === 'superadmin'],
      );
      const user =
        created.rows[0] ??
        (await tx.query<UserRow>('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]))
          .rows[0]!;
      if (user.role !== role) throw new Error('Existing account has a different role.');
      const mailId = created.rows[0] ? await this.emailToken(tx, user) : null;
      return { user: publicUser(user), mailId };
    });
    if (result.mailId) await this.mail.send(result.mailId);
    return result.user;
  }
  async verifyEmail(value: string, reply: FastifyReply) {
    const enrollmentToken = token();
    await this.database.transaction(async (tx) => {
      const consumed = await tx.query<TokenRow>(
        "UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND kind='email' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id,expires_at",
        [hashToken(value)],
      );
      const tokenRow = consumed.rows[0];
      if (!tokenRow)
        throw new AppError(
          400,
          'LINK_EXPIRED',
          'Ссылка недействительна или устарела. Запросите новое письмо.',
        );
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [tokenRow.user_id])
      ).rows[0];
      if (!user || user.totp_enabled_at || user.is_blocked)
        throw new AppError(400, 'LINK_EXPIRED', 'Ссылка недействительна или устарела.');
      const secret = createTotp(user.email).secret.base32;
      await tx.query(
        'UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),totp_secret_ciphertext=$1 WHERE id=$2',
        [this.crypto.encrypt(secret), user.id],
      );
      await tx.query(
        "UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND kind='enrollment' AND consumed_at IS NULL",
        [user.id],
      );
      await tx.query(
        'INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at) VALUES ($1,$2,$3,$4)',
        [hashToken(enrollmentToken), user.id, 'enrollment', new Date(Date.now() + 10 * 60 * 1000)],
      );
      await audit(tx, user.id, 'email.verified', user.id);
    });
    reply.setCookie(this.enrollmentCookie, enrollmentToken, this.cookieOptions(600));
  }
  private async enrollmentToken(request: FastifyRequest, tx: QueryExecutor = this.database) {
    const value = request.cookies[this.enrollmentCookie];
    if (!value)
      throw new AppError(
        401,
        'ENROLLMENT_EXPIRED',
        'Подтвердите почту, чтобы подключить Authenticator.',
      );
    const result = await tx.query<TokenRow>(
      "SELECT user_id,expires_at FROM auth_tokens WHERE token_hash=$1 AND kind='enrollment' AND consumed_at IS NULL AND expires_at>now()",
      [hashToken(value)],
    );
    if (!result.rows[0])
      throw new AppError(
        401,
        'ENROLLMENT_EXPIRED',
        'Время подключения истекло. Запросите новое письмо.',
      );
    return { ...result.rows[0], value };
  }
  async enrollment(request: FastifyRequest) {
    const record = await this.enrollmentToken(request);
    const user = (
      await this.database.query<UserRow>('SELECT * FROM users WHERE id=$1', [record.user_id])
    ).rows[0];
    if (!user?.totp_secret_ciphertext || user.totp_enabled_at || user.is_blocked)
      throw new AppError(401, 'ENROLLMENT_EXPIRED', 'Подключение Authenticator недоступно.');
    const manualKey = this.crypto.decrypt(user.totp_secret_ciphertext);
    return {
      email: user.email,
      manualKey,
      qrDataUrl: await QRCode.toDataURL(createTotp(user.email, manualKey).toString(), {
        width: 240,
        margin: 2,
      }),
      expiresAt: new Date(record.expires_at).toISOString(),
    };
  }
  private async acceptCode(tx: QueryExecutor, user: UserRow, code: string, enable: boolean) {
    if (
      !user.email_verified_at ||
      !user.totp_secret_ciphertext ||
      user.is_blocked ||
      (!enable && !user.totp_enabled_at)
    )
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или код Authenticator.');
    const totp = createTotp(user.email, this.crypto.decrypt(user.totp_secret_ciphertext));
    const now = Date.now();
    const delta = totp.validate({ token: code, window: 1, timestamp: now });
    if (delta === null)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или код Authenticator.');
    const counter = Math.floor(now / 30000) + delta;
    const updated = await tx.query<UserRow>(
      `UPDATE users SET last_totp_counter=$1${enable ? ',totp_enabled_at=now()' : ''} WHERE id=$2 AND last_totp_counter<$1${enable ? ' AND totp_enabled_at IS NULL' : ''} RETURNING *`,
      [counter, user.id],
    );
    if (!updated.rows[0])
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Неверная почта или код Authenticator. Дождитесь нового кода.',
      );
    return updated.rows[0];
  }
  private async newSession(
    tx: QueryExecutor,
    user: User,
    request: FastifyRequest,
    localDebug = false,
  ) {
    const previous = request.cookies[this.sessionCookie];
    if (previous)
      await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [
        hashToken(previous),
      ]);
    const policy = await getPolicy(tx);
    const value = token();
    const hashed = hashToken(value);
    await tx.query(
      'INSERT INTO auth_sessions (id,token_hash,user_id,expires_at,local_debug) VALUES ($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        hashed,
        user.id,
        new Date(Date.now() + policy.sessionHours * 3600000),
        localDebug,
      ],
    );
    await audit(tx, user.id, localDebug ? 'session.local_started' : 'session.started', user.id);
    return {
      value,
      hours: policy.sessionHours,
      session: {
        user,
        csrfToken: this.crypto.mac(`csrf:${hashed}`),
        dashboardPath: dashboardPath(user.role),
      } satisfies Session,
    };
  }
  async confirmEnrollment(request: FastifyRequest, reply: FastifyReply, code: string) {
    const result = await this.database.transaction(async (tx) => {
      const enrollment = await this.enrollmentToken(request, tx);
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [enrollment.user_id])
      ).rows[0];
      if (!user) throw new AppError(401, 'ENROLLMENT_EXPIRED', 'Подключение недоступно.');
      const activated = publicUser(await this.acceptCode(tx, user, code, true));
      await tx.query('UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1', [
        hashToken(enrollment.value),
      ]);
      await audit(tx, user.id, 'authenticator.enabled', user.id);
      const policy = await getPolicy(tx);
      if (policy.vpnCheckEnabled && !activated.accessVerified)
        return {
          session: anonymousSession,
          awaitingReview: true,
          created: null,
          userId: activated.id,
        };
      const created = await this.newSession(tx, activated, request);
      return { session: created.session, awaitingReview: false, created, userId: activated.id };
    });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
    if (result.created)
      reply.setCookie(
        this.sessionCookie,
        result.created.value,
        this.cookieOptions(result.created.hours * 3600),
      );
    await this.network.linkUser(request, result.userId);
    return { session: result.session, awaitingReview: result.awaitingReview };
  }
  async login(request: FastifyRequest, reply: FastifyReply, email: string, code: string) {
    const found = await this.database.query<UserRow>('SELECT * FROM users WHERE email=$1', [email]);
    if (!found.rows[0])
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или код Authenticator.');
    await this.network.check(request);
    const created = await this.database.transaction(async (tx) => {
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email])
      ).rows[0]!;
      const accepted = publicUser(await this.acceptCode(tx, user, code, false));
      if ((await getPolicy(tx)).vpnCheckEnabled && !accepted.accessVerified)
        throw new AppError(
          403,
          'ACCESS_REVIEW_REQUIRED',
          'Доступ ожидает проверки администратором.',
        );
      return this.newSession(tx, accepted, request);
    });
    reply.setCookie(this.sessionCookie, created.value, this.cookieOptions(created.hours * 3600));
    await this.network.linkUser(request, created.session.user!.id);
    return created.session;
  }
  async localLogin(request: FastifyRequest, reply: FastifyReply, alias: string, code: string) {
    if (code !== '' || !localDebugRequest(this.settings, request)) return null;
    const isAdmin = this.crypto.matches(alias, this.settings.LOCAL_DEBUG_ADMIN_ALIAS);
    if (!isAdmin && !['testuser1', 'testuser2', 'testuser3'].includes(alias)) return null;
    await this.network.check(request);
    const email = isAdmin ? 'local-admin@example.test' : `${alias}@example.test`;
    const role = isAdmin ? 'superadmin' : 'student';
    const created = await this.database.transaction(async (tx) => {
      const secret = createTotp(email).secret.base32;
      await tx.query(
        'INSERT INTO users (id,email,full_name,role,is_demo,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,true,now(),now(),$5,true) ON CONFLICT (email) DO NOTHING',
        [
          randomUUID(),
          email,
          isAdmin ? 'Локальный суперадмин' : `Тестовый ученик ${alias.slice(-1)}`,
          role,
          this.crypto.encrypt(secret),
        ],
      );
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email])
      ).rows[0]!;
      if (
        !user.is_demo ||
        user.role !== role ||
        user.is_blocked ||
        !user.email_verified_at ||
        !user.totp_enabled_at
      )
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или код Authenticator.');
      if ((await getPolicy(tx)).vpnCheckEnabled && !user.access_verified)
        throw new AppError(
          403,
          'ACCESS_REVIEW_REQUIRED',
          'Доступ ожидает проверки администратором.',
        );
      return this.newSession(tx, publicUser(user), request, true);
    });
    reply.setCookie(this.sessionCookie, created.value, this.cookieOptions(created.hours * 3600));
    await this.network.linkUser(request, created.session.user!.id);
    return created.session;
  }
  async actor(request: FastifyRequest): Promise<Actor | null> {
    const value = request.cookies[this.sessionCookie];
    if (!value) return null;
    const result = await this.database.query<
      UserRow & { session_id: string; token_hash: string; local_debug: boolean }
    >(
      `SELECT u.*,s.id AS session_id,s.token_hash,s.local_debug FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_blocked=false AND u.email_verified_at IS NOT NULL AND u.totp_enabled_at IS NOT NULL`,
      [hashToken(value)],
    );
    const row = result.rows[0];
    if (row?.local_debug && !localDebugRequest(this.settings, request)) return null;
    return row
      ? { user: publicUser(row), sessionId: row.session_id, tokenHash: row.token_hash }
      : null;
  }
  async requireActor(request: FastifyRequest, role?: User['role'], write = false) {
    const actor = await this.actor(request);
    if (!actor) throw new AppError(401, 'AUTH_REQUIRED', 'Войдите в аккаунт.');
    if (role && actor.user.role !== role)
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
    await this.network.check(request, actor.user);
    if (write) this.checkCsrf(request, actor);
    return actor;
  }
  checkCsrf(request: FastifyRequest, actor: Actor) {
    const value = request.headers['x-csrf-token'];
    if (
      typeof value !== 'string' ||
      !this.crypto.matches(value, this.crypto.mac(`csrf:${actor.tokenHash}`))
    )
      throw new AppError(403, 'INVALID_REQUEST', 'Обновите страницу и повторите действие.');
  }
  async session(request: FastifyRequest, reply: FastifyReply) {
    const actor = await this.actor(request);
    if (!actor) {
      reply.clearCookie(this.sessionCookie, { path: '/' });
      return anonymousSession;
    }
    await this.network.check(request, actor.user);
    return {
      user: actor.user,
      csrfToken: this.crypto.mac(`csrf:${actor.tokenHash}`),
      dashboardPath: dashboardPath(actor.user.role),
    };
  }
  async logout(request: FastifyRequest, reply: FastifyReply) {
    const actor = await this.actor(request);
    if (actor) this.checkCsrf(request, actor);
    const value = request.cookies[this.sessionCookie];
    if (value)
      await this.database.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [
        hashToken(value),
      ]);
    reply.clearCookie(this.sessionCookie, { path: '/' });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
    if (actor) await audit(this.database, actor.user.id, 'session.ended', actor.user.id);
    return { message: 'Вы вышли из аккаунта.' };
  }
}
