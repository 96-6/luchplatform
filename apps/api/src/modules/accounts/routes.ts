import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  accountUpdateSchema,
  securityPolicySchema,
  teacherLinkSchema,
  adminAccountCreateSchema,
  adminAuthenticatorResetSchema,
} from '@luch/contracts';
import type { AuthService, Actor } from '../auth/service.js';
import { audit, publicUser, type UserRow } from './repository.js';
import { getPolicy, ipAllowed, normalizeIp, validateRanges } from '../security/policy.js';
import { AppError } from '../../errors.js';
import { learningProgress } from '../engine/repository.js';
import { AccountCredentials } from './credentials.js';

export async function registerAccountRoutes(app: FastifyInstance, auth: AuthService) {
  const db = auth.database;
  const credentials = new AccountCredentials(db, auth.crypto);
  const idOf = (value: unknown) => z.object({ id: z.uuid() }).parse(value).id;
  app.post('/api/v1/admin/accounts', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    return {
      data: await credentials.create(actor, adminAccountCreateSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/admin/accounts/:id/authenticator', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin');
    return { data: await credentials.read(actor, idOf(request.params)), requestId: request.id };
  });
  app.post('/api/v1/admin/accounts/:id/authenticator/reset', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    return {
      data: await credentials.reset(
        actor,
        idOf(request.params),
        adminAuthenticatorResetSchema.parse(request.body).operationId,
      ),
      requestId: request.id,
    };
  });
  async function readUser(actor: Actor, id: string) {
    const related =
      actor.user.id === id ||
      actor.user.role === 'superadmin' ||
      (actor.user.role === 'teacher' &&
        (
          await db.query(
            'SELECT student_id FROM teacher_students WHERE teacher_id=$1 AND student_id=$2',
            [actor.user.id, id],
          )
        ).rows.length > 0);
    if (!related) throw new AppError(404, 'NOT_FOUND', 'Аккаунт не найден.');
    const row = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Аккаунт не найден.');
    return row;
  }
  app.get('/api/v1/users/:id', async (request) => {
    const actor = await auth.requireActor(request);
    const row = await readUser(actor, idOf(request.params));
    if (actor.user.role === 'superadmin')
      await audit(db, actor.user.id, 'account.debug_view', row.id);
    return { data: publicUser(row), requestId: request.id };
  });
  app.get('/api/v1/teacher/students', async (request) => {
    const actor = await auth.requireActor(request, 'teacher');
    const result = await db.query<UserRow>(
      'SELECT u.* FROM teacher_students ts JOIN users u ON u.id=ts.student_id WHERE ts.teacher_id=$1 ORDER BY u.full_name,u.id',
      [actor.user.id],
    );
    return { data: result.rows.map(publicUser), requestId: request.id };
  });
  app.get('/api/v1/admin/accounts', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin');
    const { search, role } = z
      .strictObject({
        search: z.string().max(100).default(''),
        role: z.enum(['student', 'teacher', 'admin', 'superadmin']).optional(),
      })
      .parse(request.query);
    const result = await db.query<UserRow>(
      'SELECT * FROM users WHERE ($2::text IS NULL OR role=$2) AND (email ILIKE $1 OR full_name ILIKE $1) ORDER BY created_at DESC,id LIMIT 100',
      [`%${search}%`, role ?? null],
    );
    await audit(db, actor.user.id, 'accounts.list_view');
    return { data: result.rows.map(publicUser), requestId: request.id };
  });
  app.get('/api/v1/admin/accounts/:id', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin');
    const id = idOf(request.params);
    const user = await readUser(actor, id);
    const teachers = await db.query<UserRow>(
      'SELECT u.* FROM teacher_students ts JOIN users u ON u.id=ts.teacher_id WHERE ts.student_id=$1',
      [id],
    );
    const students = await db.query<UserRow>(
      'SELECT u.* FROM teacher_students ts JOIN users u ON u.id=ts.student_id WHERE ts.teacher_id=$1',
      [id],
    );
    const assessments = await db.query<{
      id: string;
      ip: string;
      denied: boolean;
      observations: unknown;
      created_at: Date;
    }>(
      'SELECT id,ip,denied,observations,created_at FROM network_assessments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
      [id],
    );
    await audit(db, actor.user.id, 'account.debug_view', id);
    return {
      data: {
        user: publicUser(user),
        teachers: teachers.rows.map(publicUser),
        students: students.rows.map(publicUser),
        progress: await learningProgress(db, id),
        assessments: assessments.rows.map((row) => ({
          id: row.id,
          ip: row.ip,
          denied: row.denied,
          observations: row.observations,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      },
      requestId: request.id,
    };
  });
  app.post('/api/v1/admin/accounts/:id', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    const id = idOf(request.params);
    const input = accountUpdateSchema.parse(request.body);
    await readUser(actor, id);
    const policy = await getPolicy(db);
    if (
      id === actor.user.id &&
      (input.isBlocked || (policy.vpnCheckEnabled && !input.accessVerified))
    )
      throw new AppError(409, 'SELF_LOCKOUT', 'Нельзя отключить собственный доступ.');
    const user = await db.transaction(async (tx) => {
      const result = await tx.query<UserRow>(
        'UPDATE users SET is_blocked=$1,access_verified=$2 WHERE id=$3 RETURNING *',
        [input.isBlocked, input.accessVerified, id],
      );
      if (input.isBlocked || (policy.vpnCheckEnabled && !input.accessVerified))
        await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1', [id]);
      await audit(tx, actor.user.id, 'account.access_changed', id);
      return publicUser(result.rows[0]!);
    });
    return { data: user, requestId: request.id };
  });
  app.post('/api/v1/admin/accounts/:id/revoke-sessions', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    const id = idOf(request.params);
    await readUser(actor, id);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1', [id]);
      await audit(tx, actor.user.id, 'sessions.revoked', id);
    });
    return { data: { message: 'Сессии аккаунта завершены.' }, requestId: request.id };
  });
  app.post('/api/v1/admin/teacher-students', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    const input = teacherLinkSchema.parse(request.body);
    const valid = await db.query(
      "SELECT id FROM users WHERE (id=$1 AND role='teacher') OR (id=$2 AND role='student')",
      [input.teacherId, input.studentId],
    );
    if (valid.rows.length !== 2)
      throw new AppError(400, 'INVALID_RELATION', 'Выберите преподавателя и ученика.');
    await db.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [input.teacherId, input.studentId],
      );
      await audit(tx, actor.user.id, 'teacher.student_assigned', input.studentId);
    });
    return { data: { message: 'Ученик закреплён за преподавателем.' }, requestId: request.id };
  });
  app.get('/api/v1/admin/security', async (request) => {
    await auth.requireActor(request, 'superadmin');
    return {
      data: { ...(await getPolicy(db)), currentIp: normalizeIp(request.ip) },
      requestId: request.id,
    };
  });
  app.post('/api/v1/admin/security', async (request) => {
    const actor = await auth.requireActor(request, 'superadmin', true);
    const input = securityPolicySchema.parse(request.body);
    input.ipAllowlist = validateRanges(input.ipAllowlist);
    if (
      input.vpnCheckEnabled &&
      (!actor.user.accessVerified || !ipAllowed(normalizeIp(request.ip), input.ipAllowlist))
    )
      throw new AppError(
        409,
        'SELF_LOCKOUT',
        'Сначала подтвердите свой доступ и добавьте текущий IP в белый список.',
      );
    await db.transaction(async (tx) => {
      const updated = await tx.query(
        'UPDATE security_policy SET captcha_enabled=$1,vpn_check_enabled=$2,ip_allowlist=$3,session_hours=$4,revision=revision+1,updated_at=now(),updated_by=$5 WHERE id=1 AND revision=$6 RETURNING id',
        [
          input.captchaEnabled,
          input.vpnCheckEnabled,
          JSON.stringify(input.ipAllowlist),
          input.sessionHours,
          actor.user.id,
          input.revision,
        ],
      );
      if (!updated.rows.length)
        throw new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
      await audit(tx, actor.user.id, 'security.settings_changed');
    });
    return {
      data: { ...(await getPolicy(db)), currentIp: normalizeIp(request.ip) },
      requestId: request.id,
    };
  });
  app.get('/api/v1/admin/audit', async (request) => {
    await auth.requireActor(request, 'superadmin');
    const rows = await db.query<{
      id: string;
      action: string;
      actor_email: string | null;
      target_email: string | null;
      created_at: Date;
    }>(
      'SELECT a.id,a.action,a.created_at,u.email AS actor_email,t.email AS target_email FROM security_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users t ON t.id=a.target_id ORDER BY a.created_at DESC,a.id DESC LIMIT 50',
    );
    return {
      data: rows.rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorEmail: row.actor_email,
        targetEmail: row.target_email,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      requestId: request.id,
    };
  });
}
