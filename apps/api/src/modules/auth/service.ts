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
import { Passwords } from './password.js';

export const anonymousSession: Session = { user: null, csrfToken: null, dashboardPath: null };
export type Actor = { user: User; tokenHash: string; sessionId: string };
type TokenRow = { user_id: string; expires_at: Date | string; auth_revision: number };
type LoginChallenge = TokenRow & { token_hash: string; attempts: number };

export class AuthService {
  readonly sessionCookie: string;
  readonly enrollmentCookie: string;
  readonly loginCookie: string;
  readonly passwords: Passwords;
  constructor(
    readonly database: Database,
    readonly settings: Settings,
    readonly crypto: AccountCrypto,
    readonly mail: MailService,
    readonly network: NetworkService,
  ) {
    this.passwords = new Passwords(crypto);
    this.loginCookie = settings.APP_ENV === 'production' ? '__Host-luch_login' : 'luch_login';
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
  private async emailToken(tx: QueryExecutor, user: UserRow, kind: 'email' | 'password' = 'email') {
    const value = token();
    await tx.query(
      'UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND kind=$2 AND consumed_at IS NULL',
      [user.id, kind],
    );
    await tx.query(
      'INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at,auth_revision) VALUES ($1,$2,$3,$4,$5)',
      [hashToken(value), user.id, kind, new Date(Date.now() + 30 * 60 * 1000), user.auth_revision],
    );
    return this.mail.queue(tx, user.id, user.email, value, kind);
  }
  async register(input: z.infer<typeof registerSchema>) {
    const protectedHash = await this.passwords.protect(input.password);
    const mailId = await this.database.transaction(async (tx) => {
      const inserted = await tx.query<UserRow>(
        'INSERT INTO users (id,email,full_name,role,password_hash_ciphertext,password_changed_at,teacher_approval_required) VALUES ($1,$2,$3,$4,$5,now(),$6) ON CONFLICT (email) DO NOTHING RETURNING *',
        [
          randomUUID(),
          input.email,
          input.name,
          input.role,
          protectedHash,
          input.role === 'teacher',
        ],
      );
      const user =
        inserted.rows[0] ??
        (await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [input.email]))
          .rows[0];
      if (!user || user.totp_enabled_at || user.is_blocked || !user.is_active) return null;
      if (
        !inserted.rows.length &&
        !(await this.passwords.matches(input.password, user.password_hash_ciphertext))
      )
        return null;
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
      const mailId = created.rows[0] ? await this.emailToken(tx, user, 'password') : null;
      return { user: publicUser(user), mailId };
    });
    if (result.mailId) await this.mail.send(result.mailId);
    return result.user;
  }
  async verifyEmail(value: string, reply: FastifyReply) {
    await this.database.transaction(async (tx) => {
      const record = (
        await tx.query<TokenRow>(
          "SELECT user_id,expires_at,auth_revision FROM auth_tokens WHERE token_hash=$1 AND kind='email' AND consumed_at IS NULL AND expires_at>now()",
          [hashToken(value)],
        )
      ).rows[0];
      if (!record)
        throw new AppError(
          400,
          'LINK_EXPIRED',
          'Ссылка недействительна или устарела. Запросите новое письмо.',
        );
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [record.user_id])
      ).rows[0];
      if (
        !user ||
        user.is_blocked ||
        !user.is_active ||
        user.auth_revision !== record.auth_revision
      )
        throw new AppError(400, 'LINK_EXPIRED', 'Ссылка недействительна или устарела.');
      const consumed = await tx.query(
        'UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL RETURNING token_hash',
        [hashToken(value)],
      );
      if (!consumed.rows.length)
        throw new AppError(400, 'LINK_EXPIRED', 'Ссылка недействительна или устарела.');
      await tx.query(
        'UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1',
        [user.id],
      );
      await audit(tx, user.id, 'email.verified', user.id);
    });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
  }
  private async enrollmentToken(request: FastifyRequest, tx: QueryExecutor = this.database) {
    const value = request.cookies[this.enrollmentCookie];
    if (!value)
      throw new AppError(
        401,
        'ENROLLMENT_EXPIRED',
        'Войдите с почтой и паролем, чтобы подключить Authenticator.',
      );
    const result = await tx.query<TokenRow>(
      "SELECT user_id,expires_at,auth_revision FROM auth_tokens WHERE token_hash=$1 AND kind='enrollment' AND consumed_at IS NULL AND expires_at>now() AND auth_revision=(SELECT auth_revision FROM users WHERE id=auth_tokens.user_id)",
      [hashToken(value)],
    );
    if (!result.rows[0])
      throw new AppError(
        401,
        'ENROLLMENT_EXPIRED',
        'Время подключения истекло. Войдите с почтой и паролем заново.',
      );
    return { ...result.rows[0], value };
  }
  async enrollment(request: FastifyRequest) {
    const { record, user } = await this.requireEnrollment(request);
    const manualKey = this.crypto.decrypt(user.totp_secret_ciphertext!);
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
  async requireEnrollment(request: FastifyRequest) {
    const record = await this.enrollmentToken(request);
    const user = (
      await this.database.query<UserRow>('SELECT * FROM users WHERE id=$1', [record.user_id])
    ).rows[0];
    if (
      !user?.totp_secret_ciphertext ||
      !user.password_hash_ciphertext ||
      user.totp_enabled_at ||
      user.is_blocked ||
      !user.is_active
    )
      throw new AppError(401, 'ENROLLMENT_EXPIRED', 'Подключение Authenticator недоступно.');
    return { record, user };
  }
  private async acceptCode(tx: QueryExecutor, user: UserRow, code: string, enable: boolean) {
    if (
      !user.email_verified_at ||
      !user.totp_secret_ciphertext ||
      (!enable && !user.totp_enabled_at)
    )
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверный код Authenticator.');
    const totp = createTotp(user.email, this.crypto.decrypt(user.totp_secret_ciphertext));
    const now = Date.now();
    const delta = totp.validate({ token: code, window: 1, timestamp: now });
    if (delta === null)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверный код Authenticator.');
    assertAccountAccess(user);
    const counter = Math.floor(now / 30000) + delta;
    const updated = await tx.query<UserRow>(
      `UPDATE users SET last_totp_counter=$1${enable ? ',totp_enabled_at=now()' : ''} WHERE id=$2 AND last_totp_counter<$1${enable ? ' AND totp_enabled_at IS NULL' : ''} RETURNING *`,
      [counter, user.id],
    );
    if (!updated.rows[0])
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Неверный код Authenticator. Дождитесь нового кода.',
      );
    return updated.rows[0];
  }
  private async newSession(
    tx: QueryExecutor,
    user: User,
    request: FastifyRequest,
    localDebug = false,
  ) {
    assertTeacherApproval(user);
    const previous = request.cookies[this.sessionCookie];
    if (previous)
      await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [
        hashToken(previous),
      ]);
    const policy = await getPolicy(tx);
    const value = token();
    const hashed = hashToken(value);
    await tx.query(
      'INSERT INTO auth_sessions (id,token_hash,user_id,expires_at,local_debug,auth_revision) VALUES ($1,$2,$3,$4,$5,(SELECT auth_revision FROM users WHERE id=$3))',
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
      if (!user?.password_hash_ciphertext || user.auth_revision !== enrollment.auth_revision)
        throw new AppError(401, 'ENROLLMENT_EXPIRED', 'Подключение недоступно.');
      const activated = publicUser(await this.acceptCode(tx, user, code, true));
      await tx.query('UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1', [
        hashToken(enrollment.value),
      ]);
      await audit(tx, user.id, 'authenticator.enabled', user.id);
      const policy = await getPolicy(tx);
      if (activated.teacherApprovalPending || (policy.vpnCheckEnabled && !activated.accessVerified))
        return {
          session: anonymousSession,
          awaitingReview: true,
          reviewReason: activated.teacherApprovalPending
            ? ('teacher_approval' as const)
            : ('network' as const),
          created: null,
          userId: activated.id,
        };
      const created = await this.newSession(tx, activated, request);
      return {
        session: created.session,
        awaitingReview: false,
        reviewReason: null,
        created,
        userId: activated.id,
      };
    });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
    if (result.created)
      reply.setCookie(
        this.sessionCookie,
        result.created.value,
        this.cookieOptions(result.created.hours * 3600),
      );
    await this.network.linkUser(request, result.userId);
    return {
      session: result.session,
      awaitingReview: result.awaitingReview,
      reviewReason: result.reviewReason,
    };
  }
  async login(request: FastifyRequest, reply: FastifyReply, email: string, password: string) {
    const original = (
      await this.database.query<UserRow>('SELECT * FROM users WHERE email=$1', [email])
    ).rows[0];
    if (!(await this.passwords.matches(password, original?.password_hash_ciphertext)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль.');
    await this.network.check(request);
    const value = token(),
      expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const result = await this.database.transaction(async (tx) => {
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email])
      ).rows[0];
      if (
        !user ||
        user.password_hash_ciphertext !== original!.password_hash_ciphertext ||
        user.auth_revision !== original!.auth_revision
      )
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль.');
      assertAccountAccess(user);
      if (!user.email_verified_at)
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Подтвердите почту по ссылке из письма.');
      if (!user.totp_enabled_at) {
        const secret = createTotp(email).secret.base32;
        await tx.query(
          'UPDATE users SET totp_secret_ciphertext=$1,last_totp_counter=-1 WHERE id=$2',
          [this.crypto.encrypt(secret), user.id],
        );
        await tx.query(
          "UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND kind='enrollment' AND consumed_at IS NULL",
          [user.id],
        );
        await tx.query(
          "INSERT INTO auth_tokens (token_hash,user_id,kind,expires_at,auth_revision) VALUES ($1,$2,'enrollment',$3,$4)",
          [hashToken(value), user.id, expiresAt, user.auth_revision],
        );
        return { step: 'enrollment' as const };
      }
      assertTeacherApproval(publicUser(user));
      await tx.query(
        'INSERT INTO auth_login_challenges (token_hash,user_id,auth_revision,expires_at) VALUES ($1,$2,$3,$4)',
        [hashToken(value), user.id, user.auth_revision, expiresAt],
      );
      return {
        step: 'totp' as const,
        csrfToken: this.crypto.mac('login-csrf:' + hashToken(value)),
        expiresAt: expiresAt.toISOString(),
      };
    });
    reply.clearCookie(this.loginCookie, { path: '/' });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
    reply.setCookie(
      result.step === 'totp' ? this.loginCookie : this.enrollmentCookie,
      value,
      this.cookieOptions(300),
    );
    return result;
  }
  private async challenge(request: FastifyRequest, tx: QueryExecutor = this.database) {
    const value = request.cookies[this.loginCookie];
    if (!value) return null;
    return (
      (
        await tx.query<LoginChallenge>(
          'SELECT c.* FROM auth_login_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND c.attempts<5 AND c.auth_revision=u.auth_revision AND u.totp_enabled_at IS NOT NULL AND u.password_hash_ciphertext IS NOT NULL',
          [hashToken(value)],
        )
      ).rows[0] ?? null
    );
  }
  async loginChallenge(request: FastifyRequest, reply: FastifyReply) {
    const challenge = await this.challenge(request);
    if (!challenge) {
      reply.clearCookie(this.loginCookie, { path: '/' });
      return null;
    }
    return {
      step: 'totp' as const,
      csrfToken: this.crypto.mac('login-csrf:' + challenge.token_hash),
      expiresAt: new Date(challenge.expires_at).toISOString(),
    };
  }
  async confirmLogin(request: FastifyRequest, reply: FastifyReply, code: string) {
    const challenge = await this.challenge(request);
    const csrf = request.headers['x-login-csrf'];
    if (
      !challenge ||
      typeof csrf !== 'string' ||
      !this.crypto.matches(csrf, this.crypto.mac('login-csrf:' + challenge.token_hash))
    )
      throw new AppError(
        401,
        'LOGIN_EXPIRED',
        'Время входа истекло. Введите почту и пароль заново.',
      );
    // Count attempts outside the verification transaction so failures remain counted.
    const attempted = await this.database.query(
      'UPDATE auth_login_challenges SET attempts=attempts+1 WHERE token_hash=$1 AND attempts<5 AND consumed_at IS NULL AND expires_at>now() RETURNING token_hash',
      [challenge.token_hash],
    );
    if (!attempted.rows.length)
      throw new AppError(
        401,
        'LOGIN_EXPIRED',
        'Время входа истекло. Введите почту и пароль заново.',
      );
    await this.network.check(request);
    const created = await this.database.transaction(async (tx) => {
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [challenge.user_id])
      ).rows[0];
      if (!user?.password_hash_ciphertext || user.auth_revision !== challenge.auth_revision)
        throw new AppError(
          401,
          'LOGIN_EXPIRED',
          'Время входа истекло. Введите почту и пароль заново.',
        );
      const current = (
        await tx.query(
          'SELECT token_hash FROM auth_login_challenges WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
          [challenge.token_hash],
        )
      ).rows[0];
      if (!current)
        throw new AppError(
          401,
          'LOGIN_EXPIRED',
          'Время входа истекло. Введите почту и пароль заново.',
        );
      const accepted = publicUser(await this.acceptCode(tx, user, code, false));
      if ((await getPolicy(tx)).vpnCheckEnabled && !accepted.accessVerified)
        throw new AppError(
          403,
          'ACCESS_REVIEW_REQUIRED',
          'Доступ ожидает проверки администратором.',
        );
      await tx.query('UPDATE auth_login_challenges SET consumed_at=now() WHERE token_hash=$1', [
        challenge.token_hash,
      ]);
      return this.newSession(tx, accepted, request);
    });
    reply.clearCookie(this.loginCookie, { path: '/' });
    reply.setCookie(this.sessionCookie, created.value, this.cookieOptions(created.hours * 3600));
    await this.network.linkUser(request, created.session.user!.id);
    return created.session;
  }
  async requestPassword(email: string) {
    const mailId = await this.database.transaction(async (tx) => {
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE email=$1 FOR UPDATE', [email])
      ).rows[0];
      if (!user || user.is_blocked || !user.is_active) return null;
      return this.emailToken(tx, user, 'password');
    });
    if (mailId) {
      try {
        await this.mail.send(mailId);
      } catch {
        /* Keep account existence private; a repeat request retries delivery. */
      }
    }
    return {
      message:
        'Если аккаунт существует, письмо для установки нового пароля отправлено. Проверьте почту.',
    };
  }
  async invalidateCredentials(tx: QueryExecutor, userId: string) {
    await tx.query(
      'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
      [userId],
    );
    await tx.query(
      'UPDATE auth_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [userId],
    );
    await tx.query(
      'UPDATE auth_login_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [userId],
    );
  }
  async resetPassword(value: string, password: string, reply: FastifyReply) {
    const protectedHash = await this.passwords.protect(password);
    await this.database.transaction(async (tx) => {
      const record = (
        await tx.query<TokenRow>(
          "SELECT user_id,expires_at,auth_revision FROM auth_tokens WHERE token_hash=$1 AND kind='password' AND consumed_at IS NULL AND expires_at>now()",
          [hashToken(value)],
        )
      ).rows[0];
      if (!record)
        throw new AppError(
          400,
          'LINK_EXPIRED',
          'Ссылка недействительна или устарела. Запросите новое письмо.',
        );
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [record.user_id])
      ).rows[0];
      if (
        !user ||
        user.is_blocked ||
        !user.is_active ||
        user.auth_revision !== record.auth_revision
      )
        throw new AppError(400, 'LINK_EXPIRED', 'Ссылка недействительна или устарела.');
      const consumed = await tx.query(
        'UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING token_hash',
        [hashToken(value)],
      );
      if (!consumed.rows.length)
        throw new AppError(400, 'LINK_EXPIRED', 'Ссылка недействительна или устарела.');
      await tx.query(
        'UPDATE users SET password_hash_ciphertext=$1,password_changed_at=now(),email_verified_at=COALESCE(email_verified_at,now()),auth_revision=auth_revision+1 WHERE id=$2',
        [protectedHash, user.id],
      );
      await this.invalidateCredentials(tx, user.id);
      await audit(tx, user.id, 'password.email_reset', user.id);
    });
    this.clearAuthCookies(reply);
    return { message: 'Пароль установлен. Войдите с новым паролем и кодом Authenticator.' };
  }
  async changePassword(
    actor: Actor,
    currentPassword: string,
    password: string,
    code: string,
    reply: FastifyReply,
  ) {
    const original = (
      await this.database.query<UserRow>('SELECT * FROM users WHERE id=$1', [actor.user.id])
    ).rows[0];
    if (!(await this.passwords.matches(currentPassword, original?.password_hash_ciphertext)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Текущий пароль неверен.');
    const protectedHash = await this.passwords.protect(password);
    await this.database.transaction(async (tx) => {
      const user = (
        await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [actor.user.id])
      ).rows[0];
      if (
        !user ||
        user.password_hash_ciphertext !== original!.password_hash_ciphertext ||
        user.auth_revision !== original!.auth_revision
      )
        throw new AppError(409, 'CREDENTIALS_CHANGED', 'Данные входа изменились. Войдите заново.');
      await this.acceptCode(tx, user, code, false);
      await tx.query(
        'UPDATE users SET password_hash_ciphertext=$1,password_changed_at=now(),auth_revision=auth_revision+1 WHERE id=$2',
        [protectedHash, user.id],
      );
      await this.invalidateCredentials(tx, user.id);
      await audit(tx, user.id, 'password.changed', user.id);
    });
    this.clearAuthCookies(reply);
    return { message: 'Пароль изменён. Войдите заново на своих устройствах.' };
  }
  private clearAuthCookies(reply: FastifyReply) {
    for (const name of [this.sessionCookie, this.enrollmentCookie, this.loginCookie])
      reply.clearCookie(name, { path: '/' });
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
      if (!user.is_demo || user.role !== role || !user.email_verified_at || !user.totp_enabled_at)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль.');
      if ((await getPolicy(tx)).vpnCheckEnabled && !user.access_verified)
        throw new AppError(
          403,
          'ACCESS_REVIEW_REQUIRED',
          'Доступ ожидает проверки администратором.',
        );
      assertAccountAccess(user);
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
      `SELECT u.*,s.id AS session_id,s.token_hash,s.local_debug FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_blocked=false AND u.is_active=true AND u.email_verified_at IS NOT NULL AND u.totp_enabled_at IS NOT NULL AND s.auth_revision=u.auth_revision AND (s.local_debug=true OR u.password_hash_ciphertext IS NOT NULL) AND (u.role<>'teacher' OR u.teacher_approval_required=false)`,
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
    const pending = request.cookies[this.loginCookie];
    if (pending)
      await this.database.query(
        'UPDATE auth_login_challenges SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL',
        [hashToken(pending)],
      );
    const enrollment = request.cookies[this.enrollmentCookie];
    if (enrollment)
      await this.database.query(
        "UPDATE auth_tokens SET consumed_at=now() WHERE token_hash=$1 AND kind='enrollment' AND consumed_at IS NULL",
        [hashToken(enrollment)],
      );
    reply.clearCookie(this.sessionCookie, { path: '/' });
    reply.clearCookie(this.enrollmentCookie, { path: '/' });
    reply.clearCookie(this.loginCookie, { path: '/' });
    if (actor) await audit(this.database, actor.user.id, 'session.ended', actor.user.id);
    return { message: 'Вы вышли из аккаунта.' };
  }
}

function assertAccountAccess(user: UserRow) {
  if (user.is_blocked)
    throw new AppError(
      403,
      'ACCOUNT_BLOCKED',
      'Ваша учетная запись заблокирована' + (user.block_reason ? '\n' + user.block_reason : ''),
    );
  if (!user.is_active)
    throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'Ваш аккаунт деактивирован администратором');
}
function assertTeacherApproval(user: User) {
  if (user.teacherApprovalPending)
    throw new AppError(
      403,
      'TEACHER_APPROVAL_REQUIRED',
      'Регистрация преподавателя ожидает подтверждения суперадмином.',
    );
}
