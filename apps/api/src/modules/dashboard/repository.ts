import { dashboardAssignmentSchema, type DashboardAssignment } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { iso, runSelect, summary, type RunRow } from '../engine/repository.js';

export async function currentRun(tx: QueryExecutor, userId: string, language: string | null) {
  const row = (
    await tx.query<RunRow>(
      `${runSelect}
    JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
    WHERE r.user_id=$1 AND r.status='active'
      AND ($2::text IS NULL OR route.definition->>'language'=$2)
    ORDER BY r.updated_at DESC,r.created_at DESC,r.id DESC LIMIT 1`,
      [userId, language],
    )
  ).rows[0];
  return row ? summary(row) : null;
}

// Include outstanding adaptive work from older plans of the selected language.
// Replacing a diagnostic must not silently hide an already assigned review.
export async function assignments(
  tx: QueryExecutor,
  userId: string,
  language: string | null,
  planId: string | null,
  now: number,
) {
  const rows = (
    await tx.query<{
      id: string;
      plan_id: string;
      title: string;
      kind: DashboardAssignment['kind'];
      purpose: DashboardAssignment['purpose'];
      due_at: Date | string | null;
      recommended_day: number;
      estimated_minutes: number;
      reason: { text: string };
      run_id: string | null;
      status: DashboardAssignment['status'];
      completed_steps: number;
      total_steps: number;
    }>(
      `SELECT a.*,l.definition->>'title' AS title,
      COALESCE(r.status,'pending') AS status,COALESCE(r.current_position,0) AS completed_steps,
      (SELECT count(*)::integer FROM plan_assignment_exercises e WHERE e.assignment_id=a.id) AS total_steps
    FROM plan_assignments a JOIN learning_plans p ON p.id=a.plan_id
    JOIN diagnostic_sessions d ON d.id=p.diagnostic_id
    JOIN learning_lessons l ON l.package_id=a.package_id AND l.package_version=a.package_version AND l.id=a.lesson_id
    LEFT JOIN engine_runs r ON r.id=a.run_id
    WHERE a.user_id=$1 AND ($2::text IS NULL OR d.questionnaire->>'language'=$2)
      AND (a.plan_id=$3::uuid OR a.kind<>'initial') AND COALESCE(r.status,'pending')<>'completed'
    ORDER BY p.created_at,a.position,a.id`,
      [userId, language, planId],
    )
  ).rows;
  return rows.map((a) =>
    dashboardAssignmentSchema.parse({
      id: a.id,
      planId: a.plan_id,
      title: a.title,
      kind: a.kind,
      purpose: a.purpose,
      dueAt: a.due_at ? iso(a.due_at) : null,
      canStart: Boolean(a.run_id) || !a.due_at || new Date(a.due_at).getTime() <= now,
      recommendedDay: a.recommended_day,
      estimatedMinutes: a.estimated_minutes,
      reason: a.reason.text,
      runId: a.run_id,
      status: a.status,
      completedSteps: a.completed_steps,
      totalSteps: a.total_steps,
    }),
  );
}

export async function progress(tx: QueryExecutor, userId: string, language: string | null) {
  const counts = (
    await tx.query<{
      evaluated: number;
      independent_correct: number;
      assisted_correct: number;
      incorrect: number;
      pending: number;
    }>(
      `SELECT
      count(*) FILTER (WHERE r.purpose='practice' OR r.status='completed')::integer AS evaluated,
      count(*) FILTER (WHERE (r.purpose='practice' OR r.status='completed') AND a.is_correct AND a.independent)::integer AS independent_correct,
      count(*) FILTER (WHERE (r.purpose='practice' OR r.status='completed') AND a.is_correct AND NOT a.independent)::integer AS assisted_correct,
      count(*) FILTER (WHERE (r.purpose='practice' OR r.status='completed') AND NOT a.is_correct)::integer AS incorrect,
      count(*) FILTER (WHERE r.purpose<>'practice' AND r.status<>'completed')::integer AS pending
    FROM engine_attempts a JOIN engine_runs r ON r.id=a.run_id
    JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
    WHERE a.user_id=$1 AND ($2::text IS NULL OR route.definition->>'language'=$2)`,
      [userId, language],
    )
  ).rows[0]!;
  const lessons = (
    await tx.query<{ total: number }>(
      `SELECT count(DISTINCT (r.package_id,r.lesson_id))::integer AS total
    FROM engine_runs r
    JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
    WHERE r.user_id=$1 AND r.status='completed' AND r.source_type='lesson' AND r.purpose='practice'
      AND ($2::text IS NULL OR route.definition->>'language'=$2)`,
      [userId, language],
    )
  ).rows[0]!.total;
  return {
    completedLessons: lessons,
    evaluatedAttempts: counts.evaluated,
    independentCorrect: counts.independent_correct,
    assistedCorrect: counts.assisted_correct,
    incorrectAttempts: counts.incorrect,
    pendingEvaluationAttempts: counts.pending,
  };
}

export async function recentResults(tx: QueryExecutor, userId: string, language: string | null) {
  const rows = (
    await tx.query<{
      id: string;
      run_id: string;
      title: string;
      purpose: 'practice' | 'diagnostic' | 'control';
      correct: boolean | null;
      independent: boolean | null;
      evaluated_at: Date | string;
    }>(
      `SELECT a.id,a.run_id,r.title,r.purpose,a.evaluated_at,
      CASE WHEN r.purpose='practice' OR r.status='completed' THEN a.is_correct ELSE NULL END AS correct,
      CASE WHEN r.purpose='practice' OR r.status='completed' THEN a.independent ELSE NULL END AS independent
    FROM engine_attempts a JOIN engine_runs r ON r.id=a.run_id
    JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
    WHERE a.user_id=$1 AND ($2::text IS NULL OR route.definition->>'language'=$2)
    ORDER BY a.evaluated_at DESC,a.id DESC LIMIT 5`,
      [userId, language],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    title: r.title,
    purpose: r.purpose,
    correct: r.correct,
    independent: r.independent,
    evaluatedAt: iso(r.evaluated_at),
  }));
}
