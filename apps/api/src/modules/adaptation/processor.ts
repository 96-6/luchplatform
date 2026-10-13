import { randomUUID } from 'node:crypto';
import {
  ADAPTATION_VERSION,
  exerciseSchema,
  questionnaireSchema,
  type AssignmentReason,
  type LearningOutcome,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';

type Evidence = {
  id: string;
  attempt_id: string;
  user_id: string;
  submitted_by: string;
  package_id: string;
  package_version: number;
  route_id: string;
  run_id: string;
  purpose: 'practice' | 'diagnostic' | 'control';
  run_status: string;
  is_correct: boolean;
  independent: boolean;
  used_hints: unknown[];
  evaluated_at: Date | string;
  created_at: Date | string;
  definition: unknown;
  user_role: string;
  assignment_kind: string | null;
};
const eventSelect = `SELECT v.id,v.attempt_id,v.created_at,a.user_id,a.submitted_by,a.is_correct,a.independent,a.used_hints,a.evaluated_at,
  r.id AS run_id,r.package_id,r.package_version,r.route_id,r.purpose,r.status AS run_status,u.role AS user_role,
  COALESCE(g.definition,e.definition) AS definition,pa.kind AS assignment_kind
  FROM engine_events v JOIN engine_attempts a ON a.id=v.attempt_id JOIN engine_runs r ON r.id=a.run_id
  JOIN users u ON u.id=a.user_id JOIN engine_steps s ON s.id=a.step_id
  JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id
  LEFT JOIN generated_exercises g ON g.id=s.generated_exercise_id LEFT JOIN plan_assignments pa ON pa.id=r.assignment_id`;
type Plan = { id: string; questionnaire: unknown; created_at: Date | string };
type ChangeAction =
  | 'correction_added'
  | 'correction_reused'
  | 'supported_practice_added'
  | 'supported_practice_reused'
  | 'review_scheduled'
  | 'review_reused'
  | 'next_step_ready'
  | 'review_confirmed'
  | 'bank_unavailable';
function outcomeOf(e: Evidence): LearningOutcome {
  return !e.is_correct
    ? 'mistake'
    : e.independent
      ? 'independent_success'
      : e.used_hints.length
        ? 'hinted_success'
        : 'assisted_success';
}
async function change(
  tx: QueryExecutor,
  plan: Plan,
  e: Evidence,
  skillId: string,
  action: ChangeAction,
  reason: string,
  assignmentId: string | null,
  now: number,
) {
  await tx.query(
    'INSERT INTO learning_plan_changes (id,plan_id,event_id,assignment_id,action,skill_id,outcome,reason,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (plan_id,event_id,action) DO NOTHING',
    [
      randomUUID(),
      plan.id,
      e.id,
      assignmentId,
      action,
      skillId,
      outcomeOf(e),
      reason,
      e.submitted_by,
      new Date(now),
    ],
  );
}
async function assign(
  tx: QueryExecutor,
  plan: Plan,
  e: Evidence,
  kind: 'correction' | 'supported_practice' | 'review',
  delayHours: number,
  now: number,
) {
  const source = exerciseSchema.parse(e.definition),
    outcome = outcomeOf(e);
  const existing = (
    await tx.query<{ id: string }>(
      'SELECT id FROM plan_assignments WHERE plan_id=$1 AND skill_id=$2 AND kind=$3 AND closed_at IS NULL',
      [plan.id, source.skillId, kind],
    )
  ).rows[0];
  const prefix =
    kind === 'correction'
      ? 'correction'
      : kind === 'supported_practice'
        ? 'supported_practice'
        : 'review';
  if (existing) {
    const reason =
      kind === 'review'
        ? 'Отсроченная проверка этого навыка уже назначена; её срок сохранён.'
        : 'Дополнительная практика этого навыка уже назначена; повторное назначение не создаётся.';
    await change(
      tx,
      plan,
      e,
      source.skillId,
      `${prefix}_reused` as ChangeAction,
      reason,
      existing.id,
      now,
    );
    return;
  }
  const purpose = kind === 'review' ? 'control' : 'practice';
  const candidate = (
    await tx.query<{ definition: unknown }>(
      `SELECT x.definition FROM learning_exercises x JOIN learning_lessons l
    ON l.package_id=x.package_id AND l.package_version=x.package_version AND l.id=x.lesson_id
    WHERE x.package_id=$1 AND x.package_version=$2 AND x.skill_id=$3 AND x.purpose=$4 AND l.route_id=$5
    ORDER BY (x.id=$6),x.position,x.id LIMIT 1`,
      [e.package_id, e.package_version, source.skillId, purpose, e.route_id, source.id],
    )
  ).rows[0];
  if (!candidate) {
    await change(
      tx,
      plan,
      e,
      source.skillId,
      'bank_unavailable',
      `В закреплённом банке нет ${kind === 'review' ? 'контрольного' : 'тренировочного'} задания на этот навык. Результат сохранён.`,
      null,
      now,
    );
    return;
  }
  const exercise = exerciseSchema.parse(candidate.definition),
    id = randomUUID(),
    questionnaire = questionnaireSchema.parse(plan.questionnaire);
  const due = kind === 'review' ? new Date(now + delayHours * 3_600_000) : null;
  const explanation =
    kind === 'correction'
      ? 'В ответе обнаружена ошибка. Назначена дополнительная тренировка того же навыка.'
      : kind === 'supported_practice'
        ? 'Успешный ответ получен с подсказкой, помощью или после обратной связи. Назначена практика для самостоятельного ответа.'
        : outcome === 'independent_success'
          ? 'Самостоятельный успех. Назначена отсроченная проверка, чтобы уточнить сохранение навыка.'
          : 'Практика выполнена с помощью. Отсроченная проверка уточнит самостоятельность результата.';
  const reason: AssignmentReason = {
    kind:
      kind === 'correction'
        ? 'typical_error'
        : kind === 'supported_practice'
          ? 'guided_practice'
          : 'delayed_check',
    text: explanation,
    goal: questionnaire.goal,
    goalMatched: false,
    sourceAttemptId: e.attempt_id,
    skills: [
      {
        skillId: source.skillId,
        name: source.skillId,
        correct: Number(e.is_correct),
        questions: 1,
        independentCorrect: Number(e.is_correct && e.independent),
      },
    ],
  };
  const position = (
    await tx.query<{ position: number }>(
      'SELECT COALESCE(max(position),-1)+1 AS position FROM plan_assignments WHERE plan_id=$1',
      [plan.id],
    )
  ).rows[0]!.position;
  const day = Math.max(
    1,
    Math.floor(((due?.getTime() ?? now) - new Date(plan.created_at).getTime()) / 86_400_000) + 1,
  );
  await tx.query(
    'INSERT INTO plan_assignments (id,plan_id,user_id,package_id,package_version,route_id,lesson_id,purpose,position,recommended_day,estimated_minutes,reason,kind,skill_id,source_attempt_id,created_at,due_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,3,$11,$12,$13,$14,$15,$16)',
    [
      id,
      plan.id,
      e.user_id,
      e.package_id,
      e.package_version,
      e.route_id,
      exercise.lessonId,
      purpose,
      position,
      day,
      JSON.stringify(reason),
      kind,
      source.skillId,
      e.attempt_id,
      new Date(now),
      due,
    ],
  );
  await tx.query(
    'INSERT INTO plan_assignment_exercises (assignment_id,package_id,package_version,exercise_id,exercise_version,position) VALUES ($1,$2,$3,$4,$5,0)',
    [id, e.package_id, e.package_version, exercise.id, exercise.version],
  );
  const action = kind === 'review' ? 'review_scheduled' : (`${prefix}_added` as ChangeAction);
  await change(tx, plan, e, source.skillId, action, explanation, id, now);
}
async function adaptPlan(tx: QueryExecutor, e: Evidence, delayHours: number, now: number) {
  const linked = (
    await tx.query<{ plan_id: string }>(
      'SELECT plan_id FROM plan_assignments WHERE run_id=$1 ORDER BY plan_id',
      [e.run_id],
    )
  ).rows.map((r) => r.plan_id);
  const plans = (
    await tx.query<Plan>(
      `SELECT p.id,p.created_at,d.questionnaire FROM learning_plans p JOIN diagnostic_sessions d ON d.id=p.diagnostic_id
    WHERE p.user_id=$1 AND p.package_id=$2 AND p.package_version=$3 AND p.route_id=$4
    AND (CASE WHEN cardinality($5::uuid[])>0 THEN p.id=ANY($5::uuid[]) ELSE p.id=(SELECT id FROM learning_plans WHERE user_id=$1 AND package_id=$2 AND package_version=$3 AND route_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1) END)
    ORDER BY p.id FOR UPDATE OF p`,
      [e.user_id, e.package_id, e.package_version, e.route_id, linked],
    )
  ).rows;
  const exercise = exerciseSchema.parse(e.definition),
    outcome = outcomeOf(e);
  for (const plan of plans) {
    if (outcome === 'mistake') await assign(tx, plan, e, 'correction', delayHours, now);
    else if (outcome === 'independent_success') {
      const next = (
        await tx.query<{ id: string }>(
          `SELECT a.id FROM plan_assignments a LEFT JOIN engine_runs r ON r.id=a.run_id
        WHERE a.plan_id=$1 AND a.kind='initial' AND (r.status IS NULL OR r.status='active')
        ORDER BY a.position LIMIT 1`,
          [plan.id],
        )
      ).rows[0];
      await change(
        tx,
        plan,
        e,
        exercise.skillId,
        'next_step_ready',
        next
          ? 'Самостоятельный успех: доступен следующий шаг обучения в текущем уроке или первоначальном маршруте.'
          : 'Самостоятельный успех: основные шаги маршрута выполнены.',
        next?.id ?? null,
        now,
      );
      if (e.assignment_kind === 'review' && e.purpose === 'control')
        await change(
          tx,
          plan,
          e,
          exercise.skillId,
          'review_confirmed',
          'Самостоятельный ответ на отсроченной проверке подтвердил результат этого навыка в демонстрационном наборе.',
          null,
          now,
        );
      else await assign(tx, plan, e, 'review', delayHours, now);
    } else if (e.assignment_kind === 'correction' || e.assignment_kind === 'supported_practice') {
      await assign(tx, plan, e, 'review', delayHours, now);
    } else await assign(tx, plan, e, 'supported_practice', delayHours, now);
  }
}
export async function processRunLearningEvents(tx: QueryExecutor, runId: string, now: number) {
  const events = (
    await tx.query<Evidence>(
      `${eventSelect} WHERE r.id=$1 AND v.processed_at IS NULL ORDER BY a.evaluated_at,a.id FOR UPDATE OF v`,
      [runId],
    )
  ).rows;
  if (
    !events.length ||
    ((events[0]!.purpose !== 'practice' || events[0]!.assignment_kind !== null) &&
      events[0]!.run_status !== 'completed')
  )
    return;
  const policy = (
    await tx.query<{ installed_at: Date | string; review_delay_hours: number }>(
      'SELECT * FROM adaptive_policy WHERE id=1',
    )
  ).rows[0]!;
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [events[0]!.user_id]);
  for (const e of events) {
    if (e.user_role === 'student') {
      const exercise = exerciseSchema.parse(e.definition),
        outcome = outcomeOf(e),
        observed = new Date(e.evaluated_at);
      const already =
        (await tx.query('SELECT 1 FROM skill_observations WHERE attempt_id=$1', [e.attempt_id]))
          .rows.length > 0;
      if (!already) {
        const confirmed =
          e.assignment_kind === 'review' &&
          e.purpose === 'control' &&
          outcome === 'independent_success';
        const status =
          outcome === 'mistake'
            ? 'needs_practice'
            : outcome !== 'independent_success'
              ? 'supported'
              : confirmed
                ? 'confirmed'
                : e.purpose === 'diagnostic'
                  ? 'learning'
                  : 'demonstrated';
        await tx.query(
          `INSERT INTO student_skill_states (user_id,package_id,package_version,skill_id,attempts,independent_successes,hinted_successes,assisted_successes,mistakes,diagnostic_attempts,control_attempts,status,last_outcome,last_attempt_id,last_observed_at,last_independent_at,last_review_at)
          VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (user_id,package_id,package_version,skill_id) DO UPDATE SET attempts=student_skill_states.attempts+1,
          independent_successes=student_skill_states.independent_successes+$5,hinted_successes=student_skill_states.hinted_successes+$6,
          assisted_successes=student_skill_states.assisted_successes+$7,mistakes=student_skill_states.mistakes+$8,
          diagnostic_attempts=student_skill_states.diagnostic_attempts+$9,control_attempts=student_skill_states.control_attempts+$10,
          status=CASE WHEN $14>=student_skill_states.last_observed_at THEN $11 ELSE student_skill_states.status END,
          last_outcome=CASE WHEN $14>=student_skill_states.last_observed_at THEN $12 ELSE student_skill_states.last_outcome END,
          last_attempt_id=CASE WHEN $14>=student_skill_states.last_observed_at THEN $13 ELSE student_skill_states.last_attempt_id END,
          last_observed_at=GREATEST(student_skill_states.last_observed_at,$14),
          last_independent_at=CASE WHEN $15 IS NOT NULL THEN GREATEST(student_skill_states.last_independent_at,$15) ELSE student_skill_states.last_independent_at END,
          last_review_at=CASE WHEN $16 IS NOT NULL THEN GREATEST(student_skill_states.last_review_at,$16) ELSE student_skill_states.last_review_at END`,
          [
            e.user_id,
            e.package_id,
            e.package_version,
            exercise.skillId,
            Number(outcome === 'independent_success'),
            Number(outcome === 'hinted_success'),
            Number(outcome === 'assisted_success'),
            Number(outcome === 'mistake'),
            Number(e.purpose === 'diagnostic'),
            Number(e.purpose === 'control'),
            status,
            outcome,
            e.attempt_id,
            observed,
            outcome === 'independent_success' ? observed : null,
            e.assignment_kind === 'review' ? observed : null,
          ],
        );
        await tx.query(
          'INSERT INTO skill_observations (attempt_id,user_id,package_id,package_version,skill_id,outcome,purpose,rules_version,observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            e.attempt_id,
            e.user_id,
            e.package_id,
            e.package_version,
            exercise.skillId,
            outcome,
            e.purpose,
            ADAPTATION_VERSION,
            observed,
          ],
        );
        await tx.query(
          `UPDATE student_skill_states SET independent_streak=(SELECT count(*)::integer FROM (
          SELECT sum(CASE WHEN outcome='independent_success' AND purpose<>'diagnostic' THEN 0 ELSE 1 END) OVER (ORDER BY observed_at DESC,attempt_id DESC) AS interruptions
          FROM skill_observations WHERE user_id=$1 AND package_id=$2 AND package_version=$3 AND skill_id=$4) streak WHERE interruptions=0)
          WHERE user_id=$1 AND package_id=$2 AND package_version=$3 AND skill_id=$4`,
          [e.user_id, e.package_id, e.package_version, exercise.skillId],
        );
        if (
          e.purpose !== 'diagnostic' &&
          new Date(e.created_at).getTime() >= new Date(policy.installed_at).getTime()
        )
          await adaptPlan(tx, e, policy.review_delay_hours, now);
      }
    }
    await tx.query('UPDATE engine_events SET processed_at=$2 WHERE id=$1', [e.id, new Date(now)]);
  }
}
export async function recoverLearningEvents(db: Database, now: () => number = Date.now) {
  let processedRuns = 0;
  for (;;) {
    const processed = await db.transaction(async (tx) => {
      const run = (
        await tx.query<{ id: string }>(`SELECT r.id FROM engine_runs r
        WHERE (r.status='completed' OR (r.purpose='practice' AND r.assignment_id IS NULL)) AND EXISTS (SELECT 1 FROM engine_events v JOIN engine_attempts a ON a.id=v.attempt_id WHERE a.run_id=r.id AND v.processed_at IS NULL)
        ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)
      ).rows[0];
      if (!run) return false;
      await processRunLearningEvents(tx, run.id, now());
      return true;
    });
    if (!processed) return processedRuns;
    processedRuns++;
  }
}
