import {
  reportCountsSchema,
  reportAttemptSchema,
  reportChangeSchema,
  skillStateSchema,
  teacherReviewSchema,
  type ReportCounts,
  type reportPageQuerySchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { QueryExecutor } from '../../db/database.js';
import { iso } from '../engine/repository.js';

export type PageQuery = z.infer<typeof reportPageQuerySchema>;
export const evidenceCte = `WITH evidence AS (
  SELECT a.id,a.run_id,a.step_id,a.user_id,a.submitted_by,a.evaluated_at,a.active_ms,
    a.is_correct AS automatic_correct,COALESCE(a.teacher_correct,a.is_correct) AS correct,
    a.independent,a.used_hints,a.prior_feedback,a.admin_assistance,a.assistant_help,
    a.teacher_review_id,a.teacher_correct,r.purpose,r.status AS run_status,r.title AS run_title,
    r.package_id,r.package_version,r.route_id,s.exercise_id,s.generated_exercise_id,e.skill_id,
    COALESCE(g.definition,e.definition)->>'instruction' AS instruction,t.number,
    (r.purpose='practice' OR r.status='completed') AS released
  FROM engine_attempts a JOIN engine_runs r ON r.id=a.run_id
  JOIN engine_steps s ON s.id=a.step_id JOIN engine_turns t ON t.id=a.turn_id
  JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id
  LEFT JOIN generated_exercises g ON g.id=s.generated_exercise_id
  JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
  WHERE a.user_id=$1 AND route.definition->>'language'=$2
)`;

const countsSql = `count(*)::integer AS submitted,
  count(*) FILTER (WHERE e.released)::integer AS evaluated,
  count(*) FILTER (WHERE NOT e.released)::integer AS pending,
  count(*) FILTER (WHERE e.released AND e.independent)::integer AS independent_attempts,
  count(*) FILTER (WHERE e.released AND NOT e.independent)::integer AS assisted_attempts,
  count(*) FILTER (WHERE e.released AND e.correct)::integer AS correct,
  count(*) FILTER (WHERE e.released AND NOT e.correct)::integer AS incorrect,
  count(*) FILTER (WHERE e.released AND NOT e.automatic_correct)::integer AS automatic_incorrect,
  count(*) FILTER (WHERE e.released AND e.correct AND e.independent)::integer AS independent_correct,
  count(*) FILTER (WHERE e.released AND e.correct AND NOT e.independent)::integer AS assisted_correct,
  count(*) FILTER (WHERE e.released AND e.correct AND NOT e.independent AND jsonb_array_length(e.used_hints)>0)::integer AS hinted_correct,
  count(*) FILTER (WHERE e.released AND e.correct AND NOT e.independent AND jsonb_array_length(e.used_hints)=0)::integer AS other_assisted_correct,
  count(*) FILTER (WHERE e.released AND e.teacher_correct IS NOT NULL)::integer AS teacher_reviewed,
  count(*) FILTER (WHERE e.released AND tr.decision='confirm')::integer AS teacher_confirmed,
  count(*) FILTER (WHERE e.released AND tr.decision='correct')::integer AS teacher_corrected,
  COALESCE(sum(e.active_ms) FILTER (WHERE e.released),0)::float8 AS active_ms`;
export function countsOf(row?: Record<string, unknown>): ReportCounts {
  const n = (key: string) => Number(row?.[key] ?? 0);
  return reportCountsSchema.parse({
    submittedAttempts: n('submitted'),
    evaluatedAttempts: n('evaluated'),
    pendingEvaluationAttempts: n('pending'),
    independentAttempts: n('independent_attempts'),
    assistedAttempts: n('assisted_attempts'),
    correctAttempts: n('correct'),
    incorrectAttempts: n('incorrect'),
    automaticIncorrectAttempts: n('automatic_incorrect'),
    independentCorrect: n('independent_correct'),
    assistedCorrect: n('assisted_correct'),
    hintedCorrect: n('hinted_correct'),
    otherAssistedCorrect: n('other_assisted_correct'),
    teacherReviewedAttempts: n('teacher_reviewed'),
    teacherConfirmedAttempts: n('teacher_confirmed'),
    teacherCorrectedAttempts: n('teacher_corrected'),
    activeMilliseconds: n('active_ms'),
  });
}
export async function counts(tx: QueryExecutor, userId: string, language: string) {
  const params = [userId, language];
  const total = (
    await tx.query(
      `${evidenceCte} SELECT ${countsSql} FROM evidence e LEFT JOIN teacher_reviews tr ON tr.id=e.teacher_review_id`,
      params,
    )
  ).rows[0]!;
  const byPurpose = (
    await tx.query(
      `${evidenceCte} SELECT purpose,${countsSql} FROM evidence e LEFT JOIN teacher_reviews tr ON tr.id=e.teacher_review_id GROUP BY purpose ORDER BY purpose`,
      params,
    )
  ).rows;
  return {
    counts: countsOf(total),
    byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, counts: countsOf(r) })),
  };
}

export async function completion(
  tx: QueryExecutor,
  userId: string,
  language: string,
  planId: string | null,
) {
  const rows = (
    await tx.query<{
      steps: number;
      unique_exercises: number;
      runs: number;
      lessons: number;
      assignments: number;
      cancelled: number;
      active: number;
      pending: number;
    }>(
      `WITH runs AS (
    SELECT r.* FROM engine_runs r JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id
    WHERE r.user_id=$1 AND route.definition->>'language'=$2
  ), assignments AS (
    SELECT a.*,r.status AS run_status FROM plan_assignments a JOIN learning_plans p ON p.id=a.plan_id JOIN diagnostic_sessions d ON d.id=p.diagnostic_id LEFT JOIN engine_runs r ON r.id=a.run_id
    WHERE a.user_id=$1 AND d.questionnaire->>'language'=$2
  ) SELECT
    (SELECT count(*)::integer FROM engine_steps s JOIN runs r ON r.id=s.run_id WHERE s.state='completed' AND (r.purpose='practice' OR r.status='completed')) AS steps,
    (SELECT count(DISTINCT(s.package_id,s.package_version,s.exercise_id,COALESCE(s.generated_exercise_id::text,'')))::integer FROM engine_steps s JOIN runs r ON r.id=s.run_id WHERE s.state='completed' AND (r.purpose='practice' OR r.status='completed')) AS unique_exercises,
    (SELECT count(*)::integer FROM runs WHERE status='completed') AS runs,
    (SELECT count(DISTINCT(package_id,lesson_id))::integer FROM runs WHERE status='completed' AND purpose='practice' AND source_type='lesson') AS lessons,
    (SELECT count(*)::integer FROM assignments WHERE cancelled_at IS NULL AND run_status='completed') AS assignments,
    (SELECT count(*)::integer FROM assignments WHERE cancelled_at IS NOT NULL) AS cancelled,
    (SELECT count(*)::integer FROM assignments WHERE cancelled_at IS NULL AND run_status='active') AS active,
    (SELECT count(*)::integer FROM assignments WHERE cancelled_at IS NULL AND run_id IS NULL AND (plan_id=$3::uuid OR kind<>'initial')) AS pending`,
      [userId, language, planId],
    )
  ).rows[0]!;
  return {
    completedSteps: rows.steps,
    uniqueExercises: rows.unique_exercises,
    completedRuns: rows.runs,
    completedLessons: rows.lessons,
    completedAssignments: rows.assignments,
    cancelledAssignments: rows.cancelled,
    activeAssignments: rows.active,
    pendingAssignments: rows.pending,
  };
}

export async function skills(tx: QueryExecutor, userId: string, language: string) {
  const totals = (
    await tx.query(
      `${evidenceCte} SELECT e.package_id,e.package_version,e.skill_id,${countsSql},
    count(*) FILTER (WHERE released AND NOT EXISTS(SELECT 1 FROM skill_observations o WHERE o.attempt_id=e.id))::integer AS awaiting
    FROM evidence e LEFT JOIN teacher_reviews tr ON tr.id=e.teacher_review_id GROUP BY e.package_id,e.package_version,e.skill_id`,
      [userId, language],
    )
  ).rows;
  const rows = (
    await tx.query(
      `SELECT k.package_id,k.package_version,k.id AS skill_id,k.definition->>'title' AS title,k.definition->>'description' AS description,s.*,
    k.package_id AS pinned_package_id,k.package_version AS pinned_package_version,k.id AS pinned_skill_id
    FROM learning_skills k JOIN content_packages cp ON cp.id=k.package_id
    LEFT JOIN student_skill_states s ON s.user_id=$1 AND s.package_id=k.package_id AND s.package_version=k.package_version AND s.skill_id=k.id
    WHERE (cp.current_version=k.package_version OR s.user_id IS NOT NULL OR EXISTS(SELECT 1 FROM engine_attempts a JOIN engine_steps st ON st.id=a.step_id JOIN learning_exercises ex ON ex.package_id=st.package_id AND ex.package_version=st.package_version AND ex.id=st.exercise_id WHERE a.user_id=$1 AND st.package_id=k.package_id AND st.package_version=k.package_version AND ex.skill_id=k.id))
    AND EXISTS(SELECT 1 FROM learning_exercises e JOIN learning_lessons l ON l.package_id=e.package_id AND l.package_version=e.package_version AND l.id=e.lesson_id JOIN learning_routes r ON r.package_id=l.package_id AND r.package_version=l.package_version AND r.id=l.route_id WHERE e.package_id=k.package_id AND e.package_version=k.package_version AND e.skill_id=k.id AND r.definition->>'language'=$2)
    ORDER BY k.package_id,k.package_version,k.id`,
      [userId, language],
    )
  ).rows;
  return rows.map((s) => {
    const total = totals.find(
      (t) =>
        t.package_id === s.pinned_package_id &&
        t.package_version === s.pinned_package_version &&
        t.skill_id === s.pinned_skill_id,
    );
    return {
      packageId: s.pinned_package_id,
      packageVersion: s.pinned_package_version,
      skillId: s.pinned_skill_id,
      title: s.title,
      description: s.description,
      counts: countsOf(total),
      awaitingObservationAttempts: Number(total?.awaiting ?? 0),
      state: s.user_id
        ? skillStateSchema.parse({
            packageId: s.pinned_package_id,
            packageVersion: s.pinned_package_version,
            skillId: s.pinned_skill_id,
            title: s.title,
            description: s.description,
            attempts: s.attempts,
            independentSuccesses: s.independent_successes,
            hintedSuccesses: s.hinted_successes,
            assistedSuccesses: s.assisted_successes,
            mistakes: s.mistakes,
            diagnosticAttempts: s.diagnostic_attempts,
            controlAttempts: s.control_attempts,
            independentStreak: s.independent_streak,
            status: s.status,
            lastOutcome: s.last_outcome,
            lastAttemptId: s.last_attempt_id,
            lastObservedAt: iso(s.last_observed_at as string),
            lastIndependentAt: s.last_independent_at ? iso(s.last_independent_at as string) : null,
            lastReviewAt: s.last_review_at ? iso(s.last_review_at as string) : null,
          })
        : null,
    };
  });
}

export async function errors(tx: QueryExecutor, userId: string, language: string) {
  const rows = (
    await tx.query(
      `${evidenceCte} SELECT e.package_id,e.package_version,e.skill_id,k.definition->>'title' AS title,
    count(*)::integer AS mistakes,count(DISTINCT(e.exercise_id,COALESCE(e.generated_exercise_id::text,'')))::integer AS exercises,
    min(e.evaluated_at) AS first_at,max(e.evaluated_at) AS last_at,(array_agg(e.id ORDER BY e.evaluated_at DESC,e.id DESC))[1] AS last_id
    FROM evidence e JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id
    WHERE e.released AND NOT e.correct GROUP BY e.package_id,e.package_version,e.skill_id,k.definition HAVING count(*)>=2
    ORDER BY mistakes DESC,e.package_id,e.package_version,e.skill_id`,
      [userId, language],
    )
  ).rows;
  return rows.map((r) => ({
    packageId: r.package_id,
    packageVersion: r.package_version,
    skillId: r.skill_id,
    title: r.title,
    mistakes: r.mistakes,
    exercises: r.exercises,
    firstAt: iso(r.first_at as string),
    lastAt: iso(r.last_at as string),
    lastAttemptId: r.last_id,
  }));
}

export async function attempts(tx: QueryExecutor, userId: string, input: PageQuery) {
  const rows = (
    await tx.query(
      `${evidenceCte} SELECT e.*,k.definition->>'title' AS skill_title,
    tr.id AS review_id,tr.revision,tr.decision,tr.correct AS reviewed_correct,tr.comment,tr.author_id,tr.created_at AS reviewed_at,u.full_name AS author_name
    FROM evidence e JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id
    LEFT JOIN teacher_reviews tr ON tr.id=e.teacher_review_id LEFT JOIN users u ON u.id=tr.author_id
    WHERE ($3::timestamptz IS NULL OR (e.evaluated_at,e.id)<($3,$4::uuid))
    ORDER BY e.evaluated_at DESC,e.id DESC LIMIT $5`,
      [
        userId,
        input.language,
        input.beforeCreatedAt ?? null,
        input.beforeId ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, input.limit).map((r) =>
    reportAttemptSchema.parse({
      id: r.id,
      runId: r.run_id,
      runTitle: r.run_title,
      purpose: r.purpose,
      skillId: r.skill_id,
      skillTitle: r.skill_title,
      instruction: r.instruction,
      number: r.number,
      correct: r.released ? r.correct : null,
      automaticCorrect: r.released ? r.automatic_correct : null,
      independent: r.released ? r.independent : null,
      help: !r.released
        ? []
        : [
            ...((r.used_hints as unknown[]).length ? ['hint'] : []),
            ...(r.prior_feedback ? ['prior_feedback'] : []),
            ...(r.assistant_help ? ['assistant'] : []),
            ...(r.admin_assistance ? ['administrator'] : []),
            ...(r.submitted_by !== r.user_id ? ['other_actor'] : []),
          ],
      teacherReview:
        r.released && r.review_id
          ? teacherReviewSchema.parse({
              id: r.review_id,
              revision: r.revision,
              decision: r.decision,
              correct: r.reviewed_correct,
              comment: r.comment,
              author: { id: r.author_id, name: r.author_name },
              createdAt: iso(r.reviewed_at as string),
            })
          : null,
      evaluatedAt: iso(r.evaluated_at as string),
      activeMilliseconds: Number(r.active_ms),
    }),
  );
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > input.limit && last ? { createdAt: last.evaluatedAt, id: last.id } : null,
  };
}

export async function changes(tx: QueryExecutor, userId: string, input: PageQuery) {
  const filter = `FROM learning_plan_changes c JOIN learning_plans p ON p.id=c.plan_id JOIN diagnostic_sessions d ON d.id=p.diagnostic_id WHERE p.user_id=$1 AND d.questionnaire->>'language'=$2`;
  const total = (
    await tx.query<{ total: number }>(`SELECT count(*)::integer AS total ${filter}`, [
      userId,
      input.language,
    ])
  ).rows[0]!.total;
  const rows = (
    await tx.query(
      `SELECT c.*,COALESCE(v.attempt_id,ta.attempt_id) AS attempt_id,u.full_name AS created_by_name,k.definition->>'title' AS skill_name
    FROM learning_plan_changes c JOIN learning_plans p ON p.id=c.plan_id JOIN diagnostic_sessions d ON d.id=p.diagnostic_id
    LEFT JOIN engine_events v ON v.id=c.event_id LEFT JOIN teacher_actions ta ON ta.id=c.teacher_action_id
    JOIN users u ON u.id=c.created_by JOIN learning_skills k ON k.package_id=p.package_id AND k.package_version=p.package_version AND k.id=c.skill_id
    WHERE p.user_id=$1 AND d.questionnaire->>'language'=$2 AND ($3::timestamptz IS NULL OR (c.created_at,c.id)<($3,$4::uuid))
    ORDER BY c.created_at DESC,c.id DESC LIMIT $5`,
      [
        userId,
        input.language,
        input.beforeCreatedAt ?? null,
        input.beforeId ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, input.limit).map((r) =>
    reportChangeSchema.parse({
      id: r.id,
      planId: r.plan_id,
      attemptId: r.attempt_id,
      assignmentId: r.assignment_id,
      action: r.action,
      skillId: r.skill_id,
      skillName: r.skill_name,
      outcome: r.outcome,
      createdByName: r.created_by_name,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: iso(r.created_at as string),
    }),
  );
  const last = items.at(-1);
  return {
    total,
    page: {
      items,
      nextCursor:
        rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    },
  };
}

export async function updatedAt(tx: QueryExecutor, userId: string, language: string) {
  const row = (
    await tx.query<{ at: Date | string | null }>(
      `${evidenceCte} SELECT greatest(
    (SELECT max(evaluated_at) FROM evidence),
    (SELECT max(tr.created_at) FROM teacher_reviews tr JOIN evidence e ON e.id=tr.attempt_id WHERE e.released),
    (SELECT max(created_at) FROM student_profile_revisions WHERE user_id=$1 AND questionnaire->>'language'=$2),
    (SELECT max(c.created_at) FROM learning_plan_changes c JOIN learning_plans p ON p.id=c.plan_id JOIN diagnostic_sessions d ON d.id=p.diagnostic_id WHERE p.user_id=$1 AND d.questionnaire->>'language'=$2),
    (SELECT max(p.created_at) FROM learning_plans p JOIN diagnostic_sessions d ON d.id=p.diagnostic_id WHERE p.user_id=$1 AND d.questionnaire->>'language'=$2),
    (SELECT max(r.updated_at) FROM engine_runs r JOIN learning_routes route ON route.package_id=r.package_id AND route.package_version=r.package_version AND route.id=r.route_id WHERE r.user_id=$1 AND route.definition->>'language'=$2)
  ) AS at`,
      [userId, language],
    )
  ).rows[0]!;
  return row.at ? iso(row.at) : null;
}
