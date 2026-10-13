import {
  ENGINE_IDLE_MS,
  assetSchema,
  draftAnswerSchema,
  engineTurnSchema,
  evaluationSchema,
  exerciseSchema,
  lessonSchema,
  usedHintSchema,
  integrityAssessmentSchema,
  type EngineAttempt,
  type Exercise,
  type RunView,
  type UsedHint,
} from '@luch/contracts';
import { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { exerciseView } from '../content/repository.js';

export type RunRow = {
  id: string;
  diagnostic_id: string | null;
  plan_ids: string[];
  user_id: string;
  cache_fallback: boolean;
  package_id: string;
  package_version: number;
  route_id: string;
  source_type: 'lesson' | 'set' | 'assignment';
  source_id: string;
  lesson_id: string | null;
  set_id: string | null;
  purpose: 'practice' | 'diagnostic' | 'control';
  title: string;
  is_demo: boolean;
  status: 'active' | 'completed';
  current_position: number;
  total_steps: number;
  cycle: number;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  user_name: string;
  user_email: string;
  user_role: Actor['user']['role'];
};
export type StepRow = {
  id: string;
  run_id: string;
  package_id: string;
  package_version: number;
  exercise_id: string;
  exercise_version: number;
  position: number;
  state: 'pending' | 'current' | 'completed';
  current_turn_id: string | null;
  generated_exercise_id: string | null;
  definition: unknown;
};
export type TurnRow = {
  id: string;
  step_id: string;
  number: number;
  state: 'open' | 'answered';
  draft_answer: unknown;
  draft_revision: string | number;
  used_hints: unknown;
  prior_feedback: boolean;
  admin_assistance: boolean;
  assistant_help: boolean;
  active_ms: string | number;
  resumed: boolean;
  started_at: Date | string;
  last_seen_at: Date | string;
  created_by: string;
};
export type AttemptRow = {
  id: string;
  run_id: string;
  step_id: string;
  turn_id: string;
  user_id: string;
  submitted_by: string;
  operation_id: string;
  answer: unknown;
  evaluation: unknown;
  is_correct: boolean;
  independent: boolean;
  used_hints: unknown;
  prior_feedback: boolean;
  admin_assistance: boolean;
  assistant_help: boolean;
  active_ms: string | number;
  elapsed_ms: string | number;
  started_at: Date | string;
  evaluated_at: Date | string;
  number: number;
  definition: unknown;
  generated_exercise_id: string | null;
};
export const runSelect = `SELECT r.*,EXISTS(SELECT 1 FROM plan_assignments ca WHERE ca.run_id=r.id AND ca.cache_fallback) AS cache_fallback,d.id AS diagnostic_id,u.full_name AS user_name,u.email AS user_email,u.role AS user_role,
    ARRAY(SELECT a.plan_id FROM plan_assignments a JOIN learning_plans p ON p.id=a.plan_id WHERE a.run_id=r.id ORDER BY p.created_at DESC,p.id DESC) AS plan_ids
    FROM engine_runs r JOIN users u ON u.id=r.user_id LEFT JOIN diagnostic_sessions d ON d.run_id=r.id`;
export const attemptSelect = `SELECT a.*,t.number,s.generated_exercise_id,COALESCE(g.definition,e.definition) AS definition FROM engine_attempts a JOIN engine_turns t ON t.id=a.turn_id JOIN engine_steps s ON s.id=a.step_id JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id LEFT JOIN generated_exercises g ON g.id=s.generated_exercise_id`;
export const iso = (value: Date | string) => new Date(value).toISOString();
export const hintsOf = (turn: Pick<TurnRow, 'used_hints'>): UsedHint[] =>
  z.array(usedHintSchema).parse(turn.used_hints);
export function activeTime(turn: TurnRow, now: number) {
  return (
    Number(turn.active_ms) +
    (turn.state === 'open' && turn.resumed
      ? Math.max(0, Math.min(ENGINE_IDLE_MS, now - new Date(turn.last_seen_at).getTime()))
      : 0)
  );
}
export function turnView(turn: TurnRow, now: number) {
  return engineTurnSchema.parse({
    id: turn.id,
    number: turn.number,
    draftAnswer: turn.draft_answer,
    draftRevision: Number(turn.draft_revision),
    adminAssistance: turn.admin_assistance,
    assistantHelp: turn.assistant_help,
    hadPriorFeedback: turn.prior_feedback,
    usedHints: turn.used_hints,
    paused:
      !turn.resumed ||
      turn.state === 'answered' ||
      now - new Date(turn.last_seen_at).getTime() > ENGINE_IDLE_MS,
    activeMilliseconds: activeTime(turn, now),
    startedAt: iso(turn.started_at),
    lastSavedAt: iso(turn.last_seen_at),
  });
}
export function summary(row: RunRow) {
  return {
    id: row.id,
    diagnosticId: row.diagnostic_id ?? null,
    planIds: row.plan_ids ?? [],
    user: { id: row.user_id, name: row.user_name, email: row.user_email, role: row.user_role },
    packageId: row.package_id,
    packageVersion: row.package_version,
    routeId: row.route_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    purpose: row.purpose,
    isDemo: row.is_demo,
    cachedContent: row.cache_fallback ?? false,
    status: row.status,
    cycle: row.cycle,
    currentPosition: row.current_position,
    totalSteps: row.total_steps,
    completedSteps: row.current_position,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}
export function attemptView(row: AttemptRow, reveal: boolean): EngineAttempt {
  const exercise = exerciseSchema.parse(row.definition);
  return {
    id: row.id,
    stepId: row.step_id,
    turnId: row.turn_id,
    operationId: row.operation_id,
    number: row.number,
    exerciseId: exercise.id,
    generatedExerciseId: row.generated_exercise_id ?? null,
    exerciseVersion: exercise.version,
    skillId: exercise.skillId,
    instruction: exercise.instruction,
    response: exercise.response,
    submittedBy: row.submitted_by,
    submittedFor: row.user_id,
    adminAssistance: row.admin_assistance,
    assistantHelp: row.assistant_help,
    answer: draftAnswerSchema.unwrap().parse(row.answer),
    evaluation: reveal ? evaluationSchema.parse(row.evaluation) : null,
    usedHints: z.array(usedHintSchema).parse(row.used_hints),
    hadPriorFeedback: row.prior_feedback,
    independent: row.independent,
    activeMilliseconds: Number(row.active_ms),
    elapsedMilliseconds: Number(row.elapsed_ms),
    startedAt: iso(row.started_at),
    evaluatedAt: iso(row.evaluated_at),
    integrity: null,
  };
}
export async function assertUserAccess(
  tx: QueryExecutor,
  actor: Actor,
  userId: string,
  write = false,
) {
  if (actor.user.id === userId || actor.user.role === 'superadmin') return;
  if (
    actor.user.role === 'teacher' &&
    (
      await tx.query('SELECT 1 FROM teacher_students WHERE teacher_id=$1 AND student_id=$2', [
        actor.user.id,
        userId,
      ])
    ).rows.length
  ) {
    if (write)
      throw new AppError(
        403,
        'ACCESS_DENIED',
        'Изменять это прохождение может ученик или суперадмин.',
      );
    return;
  }
  throw new AppError(404, 'RUN_NOT_FOUND', 'Прохождение не найдено.');
}
export async function lockRun(
  tx: QueryExecutor,
  id: string,
  actor: Actor,
  write = false,
): Promise<RunRow> {
  const row = (
    await tx.query<RunRow>(
      `${runSelect} WHERE r.id=$1 ${write ? 'FOR UPDATE' : 'FOR SHARE'} OF r`,
      [id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'RUN_NOT_FOUND', 'Прохождение не найдено.');
  await assertUserAccess(tx, actor, row.user_id, write);
  return row;
}
export async function stepsOf(tx: QueryExecutor, runId: string) {
  return (
    await tx.query<StepRow>(
      'SELECT s.*,COALESCE(g.definition,e.definition) AS definition FROM engine_steps s JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id LEFT JOIN generated_exercises g ON g.id=s.generated_exercise_id WHERE s.run_id=$1 ORDER BY s.position',
      [runId],
    )
  ).rows;
}
export async function learningProgress(db: QueryExecutor, userId: string) {
  const result = await db.query<{
    runs: string;
    completed_runs: string;
    attempts: string;
    correct_attempts: string;
    assisted_attempts: string;
  }>(
    `SELECT (SELECT count(*) FROM engine_runs WHERE user_id=$1)::text AS runs,
     (SELECT count(*) FROM engine_runs WHERE user_id=$1 AND status='completed')::text AS completed_runs,
     count(*)::text AS attempts,count(*) FILTER (WHERE is_correct)::text AS correct_attempts,
     count(*) FILTER (WHERE NOT independent)::text AS assisted_attempts FROM engine_attempts WHERE user_id=$1`,
    [userId],
  );
  const row = result.rows[0]!;
  return {
    runs: Number(row.runs),
    completedRuns: Number(row.completed_runs),
    attempts: Number(row.attempts),
    correctAttempts: Number(row.correct_attempts),
    assistedAttempts: Number(row.assisted_attempts),
  };
}
export class EngineRepository {
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {}
  async view(actor: Actor, id: string): Promise<RunView> {
    return this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor),
        steps = await stepsOf(tx, id);
      const turns = (
        await tx.query<TurnRow>(
          'SELECT t.* FROM engine_turns t JOIN engine_steps s ON s.id=t.step_id WHERE s.run_id=$1 ORDER BY s.position,t.number',
          [id],
        )
      ).rows;
      const reveal =
        run.purpose === 'practice' ||
        run.status === 'completed' ||
        actor.user.role === 'superadmin' ||
        (actor.user.role === 'teacher' && actor.user.id !== run.user_id);
      const attempts = (
        await tx.query<AttemptRow>(
          `${attemptSelect} WHERE a.run_id=$1 ORDER BY s.position,t.number`,
          [id],
        )
      ).rows.map((row) => attemptView(row, reveal));
      const integrityRows = (
        await tx.query<{ attempt_id: string; turn_id: string; assessment: unknown }>(
          'SELECT i.* FROM engine_integrity_assessments i JOIN engine_attempts a ON a.id=i.attempt_id WHERE a.run_id=$1',
          [id],
        )
      ).rows;
      const reviewAccess =
        actor.user.role === 'superadmin' ||
        (actor.user.role === 'teacher' && actor.user.id !== run.user_id);
      if (reviewAccess)
        for (const attempt of attempts) {
          const row = integrityRows.find((item) => item.attempt_id === attempt.id);
          attempt.integrity = row ? integrityAssessmentSchema.parse(row.assessment) : null;
        }
      const integrityEnabled =
        (
          await tx.query<{ enabled: boolean }>(
            'SELECT enabled FROM engine_integrity_policy WHERE id=1',
          )
        ).rows[0]?.enabled ?? true;
      const step = steps.find((s) => s.position === run.current_position);
      const turn = step && turns.find((t) => t.id === step.current_turn_id);
      const exercise = step ? exerciseSchema.parse(step.definition) : null;
      const audio = step
        ? (
            await tx.query<{ cache_key: string }>(
              'SELECT cache_key FROM run_listening_assets WHERE run_id=$1 AND step_id=$2 ORDER BY cache_key LIMIT 1',
              [id, step.id],
            )
          ).rows[0]
        : null;
      const material =
        exercise && run.purpose === 'practice'
          ? lessonSchema.parse(
              (
                await tx.query<{ definition: unknown }>(
                  'SELECT definition FROM learning_lessons WHERE package_id=$1 AND package_version=$2 AND id=$3',
                  [run.package_id, run.package_version, exercise.lessonId],
                )
              ).rows[0]!.definition,
            ).blocks
          : [];
      const assetIds = [
        ...new Set(
          [...material, ...(exercise?.blocks ?? [])].flatMap((block) =>
            'assetId' in block ? [block.assetId] : [],
          ),
        ),
      ];
      const assets = assetIds.length
        ? (
            await tx.query<{ definition: unknown }>(
              'SELECT definition FROM learning_assets WHERE package_id=$1 AND package_version=$2 AND id=ANY($3::text[])',
              [run.package_id, run.package_version, assetIds],
            )
          ).rows.map((row) => assetSchema.parse(row.definition))
        : [];
      return {
        run: summary(run),
        integrityEnabled,
        writable: actor.user.id === run.user_id || actor.user.role === 'superadmin',
        current:
          step && turn && exercise
            ? {
                stepId: step.id,
                position: step.position,
                exercise: exerciseView(exercise),
                generatedExerciseId: step.generated_exercise_id ?? null,
                listeningUrl: audio
                  ? `/api/v1/engine/runs/${id}/steps/${step.id}/listening/${audio.cache_key}`
                  : null,
                turn: turnView(turn, this.now()),
                hintsRemaining:
                  run.purpose === 'practice'
                    ? Math.max(0, exercise.hints.length - hintsOf(turn).length)
                    : 0,
                attempt: attempts.find((a) => a.turnId === turn.id) ?? null,
              }
            : null,
        material,
        assets,
        attempts,
        debug:
          actor.user.role === 'superadmin'
            ? steps.map((s) => ({
                stepId: s.id,
                position: s.position,
                exercise: exerciseSchema.parse(s.definition),
                turns: turns
                  .filter((t) => t.step_id === s.id)
                  .map((t) => ({
                    ...turnView(t, this.now()),
                    state: t.state,
                    createdBy: t.created_by,
                  })),
                integrity: integrityRows
                  .filter((row) =>
                    turns.some((turn) => turn.step_id === s.id && turn.id === row.turn_id),
                  )
                  .map((row) => integrityAssessmentSchema.parse(row.assessment)),
              }))
            : null,
      };
    });
  }
}
