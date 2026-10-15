import { diagnosticResultSchema, questionnaireSchema } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { AppError } from '../../errors.js';
import { studentAccess } from './profile.js';

export type DiagnosticRow = {
  id: string;
  user_id: string;
  run_id: string;
  profile_revision: number;
  questionnaire: unknown;
  package_id: string;
  package_version: number;
  route_id: string;
  set_id: string;
  result: unknown;
  created_at: Date | string;
  completed_at: Date | string | null;
  user_email: string;
  user_name: string;
  title: string;
  is_demo: boolean;
  status: 'active' | 'completed';
  total_steps: number;
  answered: string;
  teacher_reviewed: number;
  plan_id: string | null;
};
export const diagnosticSelect = `SELECT d.*,r.title,r.is_demo,r.status,r.total_steps,
  u.email AS user_email,u.full_name AS user_name,
  (SELECT count(*) FROM engine_attempts a WHERE a.run_id=d.run_id)::text AS answered,
  (SELECT count(*)::integer FROM engine_attempts a WHERE a.run_id=d.run_id AND a.teacher_correct IS NOT NULL) AS teacher_reviewed
  ,p.id AS plan_id FROM diagnostic_sessions d JOIN engine_runs r ON r.id=d.run_id JOIN users u ON u.id=d.user_id
  LEFT JOIN learning_plans p ON p.diagnostic_id=d.id`;
export function diagnosticSummary(row: DiagnosticRow) {
  return {
    id: row.id,
    runId: row.run_id,
    user: { id: row.user_id, email: row.user_email, name: row.user_name },
    profileRevision: row.profile_revision,
    questionnaire: questionnaireSchema.parse(row.questionnaire),
    packageId: row.package_id,
    packageVersion: row.package_version,
    routeId: row.route_id,
    setId: row.set_id,
    title: row.title,
    isDemo: row.is_demo,
    status: row.status,
    answeredQuestions: Number(row.answered),
    teacherReviewedAttempts: row.teacher_reviewed ?? 0,
    totalQuestions: row.total_steps,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
export async function readDiagnostic(tx: QueryExecutor, actor: Actor, id: string) {
  const row = (await tx.query<DiagnosticRow>(`${diagnosticSelect} WHERE d.id=$1`, [id])).rows[0];
  if (!row) throw new AppError(404, 'DIAGNOSTIC_NOT_FOUND', 'Диагностика не найдена.');
  await studentAccess(tx, actor, row.user_id);
  if (actor.user.role === 'superadmin')
    await audit(tx, actor.user.id, 'diagnostic.debug_view', row.user_id);
  return {
    diagnostic: diagnosticSummary(row),
    planId: row.plan_id ?? null,
    result: row.result ? diagnosticResultSchema.parse(row.result) : null,
    writable: actor.user.id === row.user_id || actor.user.role === 'superadmin',
  };
}
