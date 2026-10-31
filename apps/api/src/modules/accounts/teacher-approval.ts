import type { Database } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { audit, managementUser, type UserRow } from './repository.js';

export class TeacherRegistrationApproval {
  constructor(readonly db: Database) {}
  async details(user: UserRow) {
    if (user.role !== 'teacher') return null;
    const approvedBy = user.teacher_approved_by
      ? ((
          await this.db.query<{ id: string; name: string; email: string }>(
            'SELECT id,full_name AS name,email FROM users WHERE id=$1',
            [user.teacher_approved_by],
          )
        ).rows[0] ?? null)
      : null;
    return {
      pending: user.teacher_approval_required,
      approvedAt: user.teacher_approved_at
        ? new Date(user.teacher_approved_at).toISOString()
        : null,
      approvedBy,
    };
  }
  async approve(actor: Actor, id: string) {
    if (actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
    return this.db.transaction(async (tx) => {
      const user = (await tx.query<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!user) throw new AppError(404, 'NOT_FOUND', 'Аккаунт не найден.');
      if (user.role !== 'teacher')
        throw new AppError(400, 'NOT_A_TEACHER', 'Выберите аккаунт преподавателя.');
      if (!user.teacher_approval_required) return managementUser(user);
      const result = await tx.query<UserRow>(
        'UPDATE users SET teacher_approval_required=false,teacher_approved_at=now(),teacher_approved_by=$2 WHERE id=$1 RETURNING *',
        [id, actor.user.id],
      );
      await audit(tx, actor.user.id, 'teacher.registration_approved', id);
      return managementUser(result.rows[0]!);
    });
  }
}
