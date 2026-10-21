import type { FastifyRequest } from 'fastify';
import { pageTarget, PageLocationError } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { hashToken } from '../auth/crypto.js';
import { AppError } from '../../errors.js';
import { studentAccess } from '../diagnostics/profile.js';
import { assertUserAccess } from '../engine/repository.js';
import { access as meetingAccess } from '../meetings/repository.js';
import { ContentRepository } from '../content/repository.js';

export class NavigationService {
  constructor(readonly auth: AuthService) {}
  async check(request: FastifyRequest, path: string) {
    let target;
    try {
      target = pageTarget(path);
    } catch (e) {
      if (e instanceof PageLocationError)
        throw new AppError(e.statusCode, 'PAGE_NOT_AVAILABLE', e.message);
      throw e;
    }
    const db = this.auth.database;
    if (target.kind === 'development' && !this.auth.settings.ENABLE_DEV_TOOLS)
      throw new AppError(404, 'PAGE_NOT_FOUND', 'Страница не найдена.');
    if (
      target.kind === 'mailbox' &&
      !(
        this.auth.settings.APP_ENV !== 'production' &&
        this.auth.settings.ENABLE_DEV_TOOLS &&
        this.auth.settings.MAIL_MODE === 'local'
      )
    )
      throw new AppError(404, 'PAGE_NOT_FOUND', 'Страница не найдена.');
    if (target.kind === 'verification' || target.kind === 'password-link') {
      const row = (
        await db.query(
          'SELECT 1 FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.kind=$2 AND t.consumed_at IS NULL AND t.expires_at>now() AND NOT u.is_blocked AND u.is_active AND t.auth_revision=u.auth_revision',
          [
            hashToken(String(target.query.token)),
            target.kind === 'verification' ? 'email' : 'password',
          ],
        )
      ).rows[0];
      if (!row)
        throw new AppError(
          410,
          'LINK_EXPIRED',
          'Ссылка недействительна или устарела. Запросите новое письмо.',
        );
    }
    if (target.kind === 'enrollment') await this.auth.requireEnrollment(request);
    if (target.public) return { path };
    const actor = await this.auth.requireActor(request);
    if (target.roles && !target.roles.includes(actor.user.role))
      throw new AppError(403, 'ACCESS_DENIED', 'Этот раздел недоступен вашей роли.');
    if (target.query.userId) await studentAccess(db, actor, String(target.query.userId));
    const id = target.parts[0]!;
    if (target.kind === 'student-detail') {
      try {
        await studentAccess(db, actor, id);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404)
          throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Аккаунт не найден.');
        throw error;
      }
    }
    const tables = {
      run: 'engine_runs',
      attempt: 'engine_attempts',
      diagnostic: 'diagnostic_sessions',
      plan: 'learning_plans',
    } as const;
    if (target.kind in tables) {
      const table = tables[target.kind as keyof typeof tables];
      const row = (
        await db.query<{ user_id: string }>(`SELECT user_id FROM ${table} WHERE id=$1`, [id])
      ).rows[0];
      if (!row) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Страница или ресурс не найдены.');
      await assertUserAccess(db, actor, row.user_id);
    }
    if (target.kind === 'meeting') {
      const a = await meetingAccess(db, actor, id);
      if (target.parts[1]) {
        if (['completed', 'cancelled'].includes(a.m.status))
          throw new AppError(
            410,
            'MEETING_ENDED',
            'Видеовстреча завершена или отменена. Итоги доступны в карточке занятия.',
          );
        if (a.member?.blocked_at)
          throw new AppError(
            403,
            'MEETING_ENTRY_DENIED',
            'Организатор закрыл вам вход в эту встречу.',
          );
        if (
          a.m.locked &&
          !a.canManage &&
          !(
            await db.query(
              "SELECT 1 FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state='admitted'",
              [id, actor.user.id],
            )
          ).rows.length
        )
          throw new AppError(403, 'MEETING_LOCKED', 'Организатор закрыл новые подключения.');
      }
    }
    if (target.kind === 'route' || target.kind === 'lesson') {
      const content = new ContentRepository(db);
      const route = await content.route(
        id,
        target.parts[1]!,
        target.query.packageVersion as number | undefined,
      );
      if (target.kind === 'lesson' && !route.lessons.some((l) => l.id === target.parts[2]))
        throw new AppError(404, 'CONTENT_NOT_FOUND', 'Урок в этом маршруте не найден.');
    }
    return { path };
  }
}
