import {
  planAssignmentSchema,
  planSummarySchema,
  planViewSchema,
  questionnaireSchema,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import type { Actor } from '../auth/service.js';
import { studentAccess } from '../diagnostics/profile.js';

export type PlanRow = {
  id: string;
  diagnostic_id: string;
  user_id: string;
  package_id: string;
  package_version: number;
  route_id: string;
  rules_version: string;
  created_by: string;
  created_at: Date | string;
  profile_revision: number;
  questionnaire: unknown;
  user_email: string;
  user_name: string;
  title: string;
  is_demo: boolean;
  total: number;
  cancelled: number;
  completed: number;
  days: number;
  completed_at: Date | string | null;
};
export const planSelect = `SELECT p.*,d.profile_revision,d.questionnaire,
  u.email AS user_email,u.full_name AS user_name,l.definition->>'title' AS title,
  (v.manifest->'package'->>'isDemo')::boolean AS is_demo,totals.*
  FROM learning_plans p JOIN diagnostic_sessions d ON d.id=p.diagnostic_id
  JOIN users u ON u.id=p.user_id
  JOIN learning_routes l ON l.package_id=p.package_id AND l.package_version=p.package_version AND l.id=p.route_id
  JOIN content_revisions v ON v.package_id=p.package_id AND v.version=p.package_version
  JOIN LATERAL (SELECT count(*) FILTER (WHERE a.cancelled_at IS NULL)::integer AS total,count(*) FILTER (WHERE r.status='completed' AND a.cancelled_at IS NULL)::integer AS completed,count(*) FILTER (WHERE a.cancelled_at IS NOT NULL)::integer AS cancelled,
    COALESCE(max(a.recommended_day) FILTER (WHERE a.cancelled_at IS NULL),1) AS days,max(r.completed_at) AS completed_at
    FROM plan_assignments a LEFT JOIN engine_runs r ON r.id=a.run_id WHERE a.plan_id=p.id) totals ON true`;
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
export function planSummary(row: PlanRow) {
  return planSummarySchema.parse({
    id: row.id,
    diagnosticId: row.diagnostic_id,
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
    profileRevision: row.profile_revision,
    questionnaire: questionnaireSchema.parse(row.questionnaire),
    packageId: row.package_id,
    packageVersion: row.package_version,
    routeId: row.route_id,
    title: row.title,
    isDemo: row.is_demo,
    rulesVersion: row.rules_version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    status: row.total > 0 && row.total === row.completed ? 'completed' : 'active',
    totalAssignments: row.total,
    cancelledAssignments: row.cancelled ?? 0,
    completedAssignments: row.completed,
    recommendedDays: row.days,
    completedAt: row.total > 0 && row.total === row.completed ? iso(row.completed_at) : null,
  });
}
export async function readPlan(tx: QueryExecutor, actor: Actor, id: string, now = Date.now()) {
  const row = (await tx.query<PlanRow>(`${planSelect} WHERE p.id=$1`, [id])).rows[0];
  if (!row) throw new AppError(404, 'PLAN_NOT_FOUND', 'Учебный план не найден.');
  await studentAccess(tx, actor, row.user_id);
  const assignments = (
    await tx.query<{
      id: string;
      position: number;
      recommended_day: number;
      lesson_id: string;
      title: string;
      estimated_minutes: number;
      reason: unknown;
      exercises: unknown;
      run_id: string | null;
      status: 'pending' | 'active' | 'completed' | 'cancelled';
      teacher_revision: number;
      teacher_note: string | null;
      cancelled_at: Date | string | null;
      completed_steps: number;
      started_by: string | null;
      started_at: Date | string | null;
      completed_at: Date | string | null;
      kind: 'initial' | 'correction' | 'supported_practice' | 'review' | 'teacher';
      purpose: 'practice' | 'control';
      due_at: Date | string | null;
    }>(
      `SELECT a.*,l.definition->>'title' AS title,CASE WHEN a.cancelled_at IS NOT NULL THEN 'cancelled' ELSE COALESCE(r.status,'pending') END AS status,
    COALESCE(r.current_position,0) AS completed_steps,r.completed_at,
    (SELECT jsonb_agg(jsonb_build_object('id',e.exercise_id,'version',e.exercise_version,'generatedExerciseId',e.generated_exercise_id) ORDER BY e.position)
      FROM plan_assignment_exercises e WHERE e.assignment_id=a.id) AS exercises
    FROM plan_assignments a JOIN learning_lessons l ON l.package_id=a.package_id AND l.package_version=a.package_version AND l.id=a.lesson_id
    LEFT JOIN engine_runs r ON r.id=a.run_id WHERE a.plan_id=$1 ORDER BY a.position`,
      [id],
    )
  ).rows.map((a) =>
    planAssignmentSchema.parse({
      id: a.id,
      kind: a.kind,
      purpose: a.purpose,
      dueAt: iso(a.due_at),
      canStart:
        !a.cancelled_at &&
        (Boolean(a.run_id) ||
          !a.due_at ||
          new Date(a.due_at).getTime() <= now ||
          actor.user.role === 'superadmin'),
      revision: a.teacher_revision,
      teacherNote: a.teacher_note,
      cancelledAt: iso(a.cancelled_at),
      position: a.position,
      recommendedDay: a.recommended_day,
      lessonId: a.lesson_id,
      title: a.title,
      estimatedMinutes: a.estimated_minutes,
      reason: a.reason,
      exercises: a.exercises,
      runId: a.run_id,
      status: a.status,
      completedSteps: a.completed_steps,
      startedBy: a.started_by,
      startedAt: iso(a.started_at),
      completedAt: iso(a.completed_at),
    }),
  );
  row.completed = assignments.filter((a) => a.status === 'completed').length;
  row.completed_at = assignments.reduce<string | null>(
    (latest, a) => (a.completedAt && (!latest || a.completedAt > latest) ? a.completedAt : latest),
    null,
  );
  if (actor.user.role === 'superadmin')
    await audit(tx, actor.user.id, 'plan.debug_view', row.user_id);
  return planViewSchema.parse({
    plan: planSummary(row),
    assignments,
    nextAssignmentId:
      assignments.find((a) => a.status === 'active')?.id ??
      [...assignments]
        .filter((a) => a.status === 'pending' && a.canStart)
        .sort(
          (a, b) =>
            ({ teacher: 0, correction: 1, supported_practice: 2, review: 3, initial: 4 })[a.kind] -
              { teacher: 0, correction: 1, supported_practice: 2, review: 3, initial: 4 }[b.kind] ||
            a.position - b.position,
        )[0]?.id ??
      null,
    writable: actor.user.id === row.user_id || actor.user.role === 'superadmin',
    manageable: actor.user.role === 'teacher' || actor.user.role === 'superadmin',
  });
}
