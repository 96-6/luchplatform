import type { QueryExecutor } from '../../db/database.js';
import type { LearningOutcome } from '@luch/contracts';
// Observations are a projection. Original engine evaluations and review decisions stay immutable.
export async function applyReviewedObservation(
  tx: QueryExecutor,
  attemptId: string,
  reviewId: string,
  correct: boolean,
) {
  const evidence = (
    await tx.query<{
      user_id: string;
      package_id: string;
      package_version: number;
      skill_id: string;
      independent: boolean;
      used_hints: unknown[];
    }>(
      'SELECT o.*,a.independent,a.used_hints FROM skill_observations o JOIN engine_attempts a ON a.id=o.attempt_id WHERE o.attempt_id=$1',
      [attemptId],
    )
  ).rows[0];
  if (!evidence) return; // Unfinished assigned/closed runs are processed by the engine on completion.
  const outcome: LearningOutcome = !correct
    ? 'mistake'
    : evidence.independent
      ? 'independent_success'
      : evidence.used_hints.length
        ? 'hinted_success'
        : 'assisted_success';
  await tx.query(
    'UPDATE skill_observations SET automatic_outcome=COALESCE(automatic_outcome,outcome),outcome=$2,teacher_review_id=$3 WHERE attempt_id=$1',
    [attemptId, outcome, reviewId],
  );
  const rows = (
    await tx.query<{
      attempt_id: string;
      outcome: LearningOutcome;
      purpose: string;
      observed_at: Date | string;
      assignment_kind: string | null;
    }>(
      `SELECT o.*,p.kind AS assignment_kind FROM skill_observations o JOIN engine_attempts a ON a.id=o.attempt_id JOIN engine_runs r ON r.id=a.run_id LEFT JOIN plan_assignments p ON p.id=r.assignment_id
    WHERE o.user_id=$1 AND o.package_id=$2 AND o.package_version=$3 AND o.skill_id=$4 ORDER BY o.observed_at,o.attempt_id`,
      [evidence.user_id, evidence.package_id, evidence.package_version, evidence.skill_id],
    )
  ).rows;
  const counts = { independent_success: 0, hinted_success: 0, assisted_success: 0, mistake: 0 };
  let streak = 0,
    diagnostic = 0,
    control = 0,
    lastIndependent: Date | string | null = null,
    lastReview: Date | string | null = null;
  for (const row of rows) {
    counts[row.outcome]++;
    diagnostic += Number(row.purpose === 'diagnostic');
    control += Number(row.purpose === 'control');
    streak = row.outcome === 'independent_success' && row.purpose !== 'diagnostic' ? streak + 1 : 0;
    if (row.outcome === 'independent_success') lastIndependent = row.observed_at;
    if (row.assignment_kind === 'review') lastReview = row.observed_at;
  }
  const last = rows.at(-1)!;
  const status =
    last.outcome === 'mistake'
      ? 'needs_practice'
      : last.outcome !== 'independent_success'
        ? 'supported'
        : last.assignment_kind === 'review' && last.purpose === 'control'
          ? 'confirmed'
          : last.purpose === 'diagnostic'
            ? 'learning'
            : 'demonstrated';
  await tx.query(
    `UPDATE student_skill_states SET attempts=$5,independent_successes=$6,hinted_successes=$7,assisted_successes=$8,mistakes=$9,diagnostic_attempts=$10,control_attempts=$11,independent_streak=$12,status=$13,last_outcome=$14,last_attempt_id=$15,last_observed_at=$16,last_independent_at=$17,last_review_at=$18 WHERE user_id=$1 AND package_id=$2 AND package_version=$3 AND skill_id=$4`,
    [
      evidence.user_id,
      evidence.package_id,
      evidence.package_version,
      evidence.skill_id,
      rows.length,
      counts.independent_success,
      counts.hinted_success,
      counts.assisted_success,
      counts.mistake,
      diagnostic,
      control,
      streak,
      status,
      last.outcome,
      last.attempt_id,
      last.observed_at,
      lastIndependent,
      lastReview,
    ],
  );
}
