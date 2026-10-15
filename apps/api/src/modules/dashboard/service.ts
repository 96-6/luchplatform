import { studentDashboardSchema, type DashboardAssignment } from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { publicUser } from '../accounts/repository.js';
import type { Actor } from '../auth/service.js';
import { profileView, studentAccess, type ProfileRow } from '../diagnostics/profile.js';
import {
  diagnosticSelect,
  diagnosticSummary,
  type DiagnosticRow,
} from '../diagnostics/repository.js';
import { planSelect, readPlan, type PlanRow } from '../plans/repository.js';
import * as repository from './repository.js';

function calendarDay(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(timestamp);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
}
const priority = { teacher: 0, correction: 1, supported_practice: 2, review: 3, initial: 4 };
function order(a: DashboardAssignment, b: DashboardAssignment) {
  return (
    Number(b.status === 'active') - Number(a.status === 'active') ||
    priority[a.kind] - priority[b.kind] ||
    (a.dueAt && b.dueAt ? a.dueAt.localeCompare(b.dueAt) : 0)
  );
}

export class DashboardService {
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {}
  async read(actor: Actor, timeZone = 'UTC') {
    if (actor.user.role !== 'student')
      throw new AppError(403, 'STUDENT_REQUIRED', 'Главная ученика доступна в аккаунте ученика.');
    return this.db.transaction(async (tx) => {
      const userId = actor.user.id,
        now = this.now();
      const user = await studentAccess(tx, actor, userId);
      const row = (
        await tx.query<ProfileRow>('SELECT * FROM student_profiles WHERE user_id=$1', [userId])
      ).rows[0];
      const profile = row ? profileView(row) : null,
        language = profile?.language ?? null;
      const planRow = (
        await tx.query<PlanRow>(
          `${planSelect} WHERE p.user_id=$1
        AND ($2::text IS NULL OR d.questionnaire->>'language'=$2)
        ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,
          [userId, language],
        )
      ).rows[0];
      const planView = planRow ? await readPlan(tx, actor, planRow.id, now) : null;
      const plan = planView?.plan ?? null;
      const recommendedDay = plan
        ? Math.max(
            1,
            calendarDay(now, timeZone) -
              calendarDay(new Date(plan.createdAt).getTime(), timeZone) +
              1,
          )
        : null;
      const all = await repository.assignments(tx, userId, language, plan?.id ?? null, now);
      const available = all
        .filter(
          (a) =>
            a.canStart &&
            (a.kind !== 'initial' || a.status === 'active' || a.recommendedDay <= recommendedDay!),
        )
        .sort(order);
      const fallback = all.find((a) => a.id === planView?.nextAssignmentId && a.canStart);
      const diagnosticRow = (
        await tx.query<DiagnosticRow>(
          `${diagnosticSelect} WHERE d.user_id=$1
        AND ($2::text IS NULL OR d.questionnaire->>'language'=$2)
        ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
          [userId, language],
        )
      ).rows[0];
      return studentDashboardSchema.parse({
        user: publicUser(user),
        profile,
        asOf: new Date(now).toISOString(),
        timeZone,
        recommendedDay,
        plan,
        profileChangedSincePlan: Boolean(
          profile && plan && profile.revision !== plan.profileRevision,
        ),
        diagnostic: diagnosticRow ? diagnosticSummary(diagnosticRow) : null,
        continueRun: await repository.currentRun(tx, userId, language),
        nextAssignment: available[0] ?? fallback ?? null,
        today: available.filter((a) => a.kind !== 'review'),
        reviews: all
          .filter((a) => a.kind === 'review')
          .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')),
        progress: await repository.progress(tx, userId, language),
        recentResults: await repository.recentResults(tx, userId, language),
      });
    });
  }
}
