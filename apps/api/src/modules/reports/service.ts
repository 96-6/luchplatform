import { createHash } from 'node:crypto';
import {
  learningReportSchema,
  learningReportViewSchema,
  questionnaireSchema,
  diagnosticResultSchema,
  type reportQuerySchema,
  type DashboardAssignment,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { studentAccess } from '../diagnostics/profile.js';
import {
  diagnosticSelect,
  diagnosticSummary,
  type DiagnosticRow,
} from '../diagnostics/repository.js';
import { planSelect, planSummary, type PlanRow } from '../plans/repository.js';
import { assignments, currentRun } from '../dashboard/repository.js';
import { canonicalJson } from '../content/service.js';
import { audit } from '../accounts/repository.js';
import { canReview } from '../teacher/repository.js';
import { iso } from '../engine/repository.js';
import * as repository from './repository.js';
import { integrityPage, reviewerReport } from './integrity.js';

const priority = { teacher: 0, correction: 1, supported_practice: 2, review: 3, initial: 4 };
function assignmentOrder(a: DashboardAssignment, b: DashboardAssignment) {
  return (
    Number(b.status === 'active') - Number(a.status === 'active') ||
    Number(b.canStart) - Number(a.canStart) ||
    priority[a.kind] - priority[b.kind] ||
    (a.dueAt ?? '').localeCompare(b.dueAt ?? '') ||
    a.id.localeCompare(b.id)
  );
}
export class ReportsService {
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {}
  private async snapshot<T>(actor: Actor, userId: string, read: (tx: QueryExecutor) => Promise<T>) {
    const result = await this.db.transaction(async (tx) => {
      // All parts of a report observe the same committed learning state and cannot write it.
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await studentAccess(tx, actor, userId);
      return read(tx);
    });
    if (actor.user.role === 'superadmin')
      await audit(this.db, actor.user.id, 'report.debug_view', userId);
    return result;
  }
  async read(actor: Actor, userId: string, input: z.infer<typeof reportQuerySchema>) {
    return this.snapshot(actor, userId, async (tx) => {
      const user = (
          await tx.query<{ id: string; full_name: string; email: string }>(
            'SELECT id,full_name,email FROM users WHERE id=$1',
            [userId],
          )
        ).rows[0]!,
        selected = (
          await tx.query<{ language: 'ru' | 'en' }>(
            "SELECT questionnaire->>'language' AS language FROM student_profiles WHERE user_id=$1",
            [userId],
          )
        ).rows[0],
        language = input.language ?? selected?.language ?? 'ru',
        profile = (
          await tx.query<{ revision: number; questionnaire: unknown; created_at: Date | string }>(
            "SELECT revision,questionnaire,created_at FROM student_profile_revisions WHERE user_id=$1 AND questionnaire->>'language'=$2 ORDER BY revision DESC LIMIT 1",
            [userId, language],
          )
        ).rows[0],
        plan = (
          await tx.query<PlanRow>(
            `${planSelect} WHERE p.user_id=$1 AND d.questionnaire->>'language'=$2 ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,
            [userId, language],
          )
        ).rows[0],
        diagnostic = (
          await tx.query<DiagnosticRow>(
            `${diagnosticSelect} WHERE d.user_id=$1 AND d.questionnaire->>'language'=$2 ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
            [userId, language],
          )
        ).rows[0],
        outstanding = await assignments(tx, userId, language, plan?.id ?? null, this.now()),
        changes = await repository.changes(tx, userId, { language, limit: 20 }),
        publicData = {
          version: '1.0.0' as const,
          user: { id: user.id, name: user.full_name, email: user.email },
          language,
          profile: profile
            ? {
                ...questionnaireSchema.parse(profile.questionnaire),
                revision: profile.revision,
                updatedAt: iso(profile.created_at),
              }
            : null,
          updatedAt: await repository.updatedAt(tx, userId, language),
          ...(await repository.counts(tx, userId, language)),
          completion: await repository.completion(tx, userId, language, plan?.id ?? null),
          skills: await repository.skills(tx, userId, language),
          repeatedErrors: await repository.errors(tx, userId, language),
          planChangesCount: changes.total,
          planChanges: changes.page,
          recentAttempts: await repository.attempts(tx, userId, { language, limit: 20 }),
          diagnostic: diagnostic
            ? {
                summary: diagnosticSummary(diagnostic),
                result:
                  diagnostic.status === 'completed' && diagnostic.result
                    ? diagnosticResultSchema.parse(diagnostic.result)
                    : null,
              }
            : null,
          next: {
            continueRun: await currentRun(tx, userId, language),
            plan: plan ? planSummary(plan) : null,
            assignments: outstanding.sort(assignmentOrder).slice(0, 6),
            outstandingAssignments: outstanding.length,
          },
        },
        report = learningReportSchema.parse({
          ...publicData,
          revision: createHash('sha256').update(canonicalJson(publicData)).digest('hex'),
        });
      return learningReportViewSchema.parse({
        report,
        reviewer: canReview(actor) ? await reviewerReport(tx, userId, language) : null,
        refreshedAt: new Date(this.now()).toISOString(),
      });
    });
  }
  attempts(actor: Actor, userId: string, input: repository.PageQuery) {
    return this.snapshot(actor, userId, (tx) => repository.attempts(tx, userId, input));
  }
  changes(actor: Actor, userId: string, input: repository.PageQuery) {
    return this.snapshot(
      actor,
      userId,
      async (tx) => (await repository.changes(tx, userId, input)).page,
    );
  }
  integrity(actor: Actor, userId: string, input: repository.PageQuery) {
    if (!canReview(actor))
      throw new AppError(
        403,
        'REPORT_REVIEWER_REQUIRED',
        'Этот раздел доступен преподавателю ученика или суперадмину.',
      );
    return this.snapshot(actor, userId, (tx) => integrityPage(tx, userId, input));
  }
}
