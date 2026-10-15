import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  exerciseSchema,
  type StartRun,
  type Answer,
  type DraftAnswer,
  type UsedHint,
  type runsQuerySchema,
  type saveDraftSchema,
  type submitAnswerSchema,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { ContentRepository } from '../content/repository.js';
import { canonicalJson } from '../content/service.js';
import { evaluate, validateAnswer } from './evaluator.js';
import { recordIntegrity } from './integrity.js';
import { persistDiagnosticResult } from '../diagnostics/result.js';
import { processRunLearningEvents } from '../adaptation/processor.js';
import {
  EngineRepository,
  activeTime,
  assertUserAccess,
  attemptSelect,
  hintsOf,
  lockRun,
  runSelect,
  stepsOf,
  summary,
  type AttemptRow,
  type RunRow,
  type StepRow,
  type TurnRow,
} from './repository.js';

const stale = () =>
  new AppError(409, 'TURN_CHANGED', 'Задание уже изменилось. Обновите прохождение.');
export class LuchEngine {
  readonly repository: EngineRepository;
  readonly content: ContentRepository;
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {
    this.repository = new EngineRepository(db, now);
    this.content = new ContentRepository(db);
  }
  async start(actor: Actor, input: StartRun) {
    const id = await this.db.transaction((tx) => this.startInTransaction(tx, actor, input));
    return this.repository.view(actor, id);
  }
  async startInTransaction(tx: QueryExecutor, actor: Actor, input: StartRun) {
    const userId = input.userId ?? actor.user.id;
    if (userId !== actor.user.id && actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Начните собственное прохождение.');
    const revision = await this.content.revision(input.packageId, input.packageVersion, tx);
    const manifest = revision.manifest,
      source = input.source;
    const lesson =
      source.type === 'lesson' ? manifest.lessons.find((item) => item.id === source.id) : undefined;
    const set =
      source.type === 'set' ? manifest.sets.find((item) => item.id === source.id) : undefined;
    if (!lesson && !set)
      throw new AppError(404, 'CONTENT_NOT_FOUND', 'Учебный материал не найден.');
    const purpose = source.type === 'lesson' ? source.purpose : set!.purpose;
    const exercises =
      source.type === 'lesson'
        ? manifest.exercises.filter(
            (item) => item.lessonId === source.id && item.purpose === purpose,
          )
        : set!.exerciseIds.map((id) => manifest.exercises.find((item) => item.id === id)!);
    if (!exercises.length)
      throw new AppError(409, 'NO_EXERCISES', 'В этом наборе пока нет заданий.');
    if (!(await tx.query('SELECT id FROM users WHERE id=$1', [userId])).rows.length)
      throw new AppError(404, 'USER_NOT_FOUND', 'Аккаунт не найден.');
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${userId}:${input.packageId}:${revision.packageVersion}:${source.type}:${source.id}:${purpose}`,
      ]);
    const existing = (
      await tx.query<RunRow>(
        `${runSelect} WHERE r.user_id=$1 AND r.package_id=$2 AND r.package_version=$3 AND r.source_type=$4 AND r.source_id=$5 AND r.purpose=$6 ORDER BY r.cycle DESC LIMIT 1 FOR UPDATE OF r`,
        [userId, input.packageId, revision.packageVersion, source.type, source.id, purpose],
      )
    ).rows[0];
    if (existing && (existing.status === 'active' || !input.restart)) return existing.id;
    const runId = randomUUID(),
      date = new Date(this.now());
    await tx.query(
      'INSERT INTO engine_runs (id,user_id,package_id,package_version,route_id,source_type,source_id,lesson_id,set_id,purpose,title,is_demo,total_steps,cycle,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)',
      [
        runId,
        userId,
        input.packageId,
        revision.packageVersion,
        (lesson ?? set)!.routeId,
        source.type,
        source.id,
        lesson?.id ?? null,
        set?.id ?? null,
        purpose,
        (lesson ?? set)!.title,
        revision.isDemo,
        exercises.length,
        (existing?.cycle ?? 0) + 1,
        date,
      ],
    );
    for (const [position, exercise] of exercises.entries())
      await tx.query(
        'INSERT INTO engine_steps (id,run_id,package_id,package_version,exercise_id,exercise_version,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          runId,
          input.packageId,
          revision.packageVersion,
          exercise.id,
          exercise.version,
          position,
        ],
      );
    const step = (await stepsOf(tx, runId))[0]!;
    await this.openTurn(tx, step, actor, userId);
    if (actor.user.role === 'superadmin')
      await audit(tx, actor.user.id, 'learning.started', userId);
    return runId;
  }
  async startAssignedExerciseInTransaction(
    tx: QueryExecutor,
    actor: Actor,
    assignment: {
      id: string;
      user_id: string;
      package_id: string;
      package_version: number;
      route_id: string;
      lesson_id: string;
      purpose: 'practice' | 'control';
      kind: string;
      due_at: Date | string | null;
    },
  ) {
    if (assignment.user_id !== actor.user.id && actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Начните собственное назначение.');
    const existing = (
      await tx.query<{ id: string }>('SELECT id FROM engine_runs WHERE assignment_id=$1', [
        assignment.id,
      ])
    ).rows[0];
    if (existing) return existing.id;
    const exercise = (
      await tx.query<{
        exercise_id: string;
        exercise_version: number;
        generated_exercise_id: string | null;
      }>('SELECT * FROM plan_assignment_exercises WHERE assignment_id=$1 ORDER BY position', [
        assignment.id,
      ])
    ).rows;
    if (exercise.length !== 1)
      throw new AppError(
        409,
        'ASSIGNMENT_CONTENT_CHANGED',
        'В дополнительном назначении должно быть одно задание.',
      );
    const lesson = (
      await tx.query<{ title: string }>(
        "SELECT definition->>'title' AS title FROM learning_lessons WHERE package_id=$1 AND package_version=$2 AND id=$3",
        [assignment.package_id, assignment.package_version, assignment.lesson_id],
      )
    ).rows[0]!;
    const selected = exercise[0]!,
      revision = await this.content.revision(assignment.package_id, assignment.package_version, tx);
    const id = randomUUID(),
      date = new Date(this.now()),
      title = `${assignment.kind === 'review' ? 'Повторение' : assignment.kind === 'correction' ? 'Дополнительная практика' : 'Самостоятельная практика'}: ${lesson.title}`;
    await tx.query(
      `INSERT INTO engine_runs (id,user_id,package_id,package_version,route_id,source_type,source_id,assignment_id,lesson_id,purpose,title,is_demo,total_steps,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'assignment',$6::text,$6::uuid,$7,$8,$9,$10,1,$11,$11)`,
      [
        id,
        assignment.user_id,
        assignment.package_id,
        assignment.package_version,
        assignment.route_id,
        assignment.id,
        assignment.lesson_id,
        assignment.purpose,
        title,
        revision.isDemo || Boolean(selected.generated_exercise_id),
        date,
      ],
    );
    await tx.query(
      'INSERT INTO engine_steps (id,run_id,package_id,package_version,exercise_id,exercise_version,generated_exercise_id,position) VALUES ($1,$2,$3,$4,$5,$6,$7,0)',
      [
        randomUUID(),
        id,
        assignment.package_id,
        assignment.package_version,
        selected.exercise_id,
        selected.exercise_version,
        selected.generated_exercise_id,
      ],
    );
    const step = (await stepsOf(tx, id))[0]!;
    await this.openTurn(tx, step, actor, assignment.user_id);
    if (assignment.due_at && new Date(assignment.due_at).getTime() > this.now())
      await tx.query(
        'UPDATE engine_turns SET admin_assistance=true WHERE id=(SELECT current_turn_id FROM engine_steps WHERE id=$1)',
        [step.id],
      );
    if (actor.user.role === 'superadmin')
      await audit(tx, actor.user.id, 'learning.assigned_started', assignment.user_id);
    return id;
  }
  private async openTurn(tx: QueryExecutor, step: StepRow, actor: Actor, userId: string) {
    await tx.query(
      'INSERT INTO learning_content_views (user_id,content_key,first_viewed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [
        userId,
        step.generated_exercise_id
          ? `generated:${step.generated_exercise_id}`
          : `bank:${step.package_id}:${step.package_version}:${step.exercise_id}:${step.exercise_version}`,
        new Date(this.now()),
      ],
    );
    const number =
      Number(
        (
          await tx.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM engine_turns WHERE step_id=$1',
            [step.id],
          )
        ).rows[0]!.count,
      ) + 1;
    const context = (
      await tx.query<{ kind: string | null; due_at: Date | string | null }>(
        `SELECT p.kind,p.due_at FROM engine_runs r LEFT JOIN plan_assignments p ON p.id=r.assignment_id WHERE r.id=$1`,
        [step.run_id],
      )
    ).rows[0];
    const review =
      context?.kind === 'review' &&
      context.due_at &&
      new Date(context.due_at).getTime() <= this.now();
    const prior =
      (
        await tx.query(
          `SELECT 1 FROM engine_attempts a JOIN engine_runs r ON r.id=a.run_id JOIN engine_steps s ON s.id=a.step_id WHERE a.user_id=$1 AND s.package_id=$2 AND s.package_version=$3 AND s.exercise_id=$4 AND s.generated_exercise_id IS NOT DISTINCT FROM $5::uuid AND ($6::timestamptz IS NULL OR a.evaluated_at>$6) AND (r.purpose='practice' OR r.status='completed') LIMIT 1`,
          [
            userId,
            step.package_id,
            step.package_version,
            step.exercise_id,
            step.generated_exercise_id ?? null,
            review ? new Date(this.now() - 24 * 3_600_000) : null,
          ],
        )
      ).rows.length > 0;
    const id = randomUUID(),
      date = new Date(this.now());
    await tx.query(
      'INSERT INTO engine_turns (id,step_id,number,prior_feedback,started_at,last_seen_at,created_by) VALUES ($1,$2,$3,$4,$5,$5,$6)',
      [id, step.id, number, prior, date, actor.user.id],
    );
    await tx.query("UPDATE engine_steps SET state='current',current_turn_id=$2 WHERE id=$1", [
      step.id,
      id,
    ]);
  }
  private async current(tx: QueryExecutor, run: RunRow, turnId: string) {
    if (run.status !== 'active') throw stale();
    const step = (await stepsOf(tx, run.id)).find(
      (item) => item.position === run.current_position,
    )!;
    if (step.current_turn_id !== turnId) throw stale();
    const turn = (await tx.query<TurnRow>('SELECT * FROM engine_turns WHERE id=$1', [turnId]))
      .rows[0]!;
    return { step, turn, exercise: exerciseSchema.parse(step.definition) };
  }
  private async touch(tx: QueryExecutor, turn: TurnRow, resumed: boolean) {
    await tx.query('UPDATE engine_turns SET active_ms=$2,last_seen_at=$3,resumed=$4 WHERE id=$1', [
      turn.id,
      activeTime(turn, this.now()),
      new Date(this.now()),
      resumed,
    ]);
  }
  private async changed(tx: QueryExecutor, run: RunRow, actor: Actor, action: string) {
    await tx.query('UPDATE engine_runs SET updated_at=$2 WHERE id=$1', [
      run.id,
      new Date(this.now()),
    ]);
    if (actor.user.role === 'superadmin' && actor.user.id !== run.user_id)
      await audit(tx, actor.user.id, `learning.${action}`, run.user_id);
  }
  async save(actor: Actor, id: string, input: z.infer<typeof saveDraftSchema>) {
    await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor, true),
        { turn, exercise } = await this.current(tx, run, input.turnId);
      if (turn.state !== 'open') throw stale();
      validateAnswer(exercise, input.draftAnswer, true);
      const revision = Number(turn.draft_revision);
      if (input.revision < revision) {
        if (canonicalJson(input.draftAnswer) !== canonicalJson(turn.draft_answer))
          throw new AppError(
            409,
            'DRAFT_CONFLICT',
            'Черновик изменён в другом окне. Обновите прохождение.',
          );
        return;
      }
      if (
        input.revision === revision &&
        canonicalJson(input.draftAnswer) !== canonicalJson(turn.draft_answer)
      )
        throw new AppError(
          409,
          'DRAFT_CONFLICT',
          'Черновик изменён в другом окне. Обновите прохождение.',
        );
      await this.touch(tx, turn, !input.paused);
      await tx.query(
        'UPDATE engine_turns SET draft_answer=$2,draft_revision=$3,admin_assistance=admin_assistance OR $4 WHERE id=$1',
        [
          turn.id,
          input.draftAnswer === null ? null : JSON.stringify(input.draftAnswer),
          input.revision,
          actor.user.id !== run.user_id &&
            canonicalJson(input.draftAnswer) !== canonicalJson(turn.draft_answer),
        ],
      );
      await this.changed(tx, run, actor, 'draft_saved');
    });
    return this.repository.view(actor, id);
  }
  async resume(actor: Actor, id: string, turnId: string) {
    await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor, true),
        { turn } = await this.current(tx, run, turnId);
      if (turn.state !== 'open') throw stale();
      await this.touch(tx, turn, true);
      await this.changed(tx, run, actor, 'resumed');
    });
    return this.repository.view(actor, id);
  }
  async hint(actor: Actor, id: string, turnId: string, index: number) {
    await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor, true),
        { turn, exercise } = await this.current(tx, run, turnId);
      if (run.purpose !== 'practice')
        throw new AppError(
          403,
          'HINTS_DISABLED',
          'В диагностике и контрольных заданиях подсказки отключены.',
        );
      if (turn.state !== 'open') throw stale();
      const used = hintsOf(turn);
      if (used.some((hint) => hint.index === index)) return;
      if (index !== used.length || !exercise.hints[index])
        throw new AppError(409, 'NO_HINT', 'Других подсказок для этого задания нет.');
      const hint: UsedHint = {
        index,
        text: exercise.hints[index]!,
        usedAt: new Date(this.now()).toISOString(),
        usedBy: actor.user.id,
      };
      await tx.query(
        'UPDATE engine_turns SET used_hints=$2,admin_assistance=admin_assistance OR $3 WHERE id=$1',
        [turn.id, JSON.stringify([...used, hint]), actor.user.id !== run.user_id],
      );
      await this.touch(tx, turn, true);
      await this.changed(tx, run, actor, 'hint_used');
    });
    return this.repository.view(actor, id);
  }
  async answerInTransaction(
    tx: QueryExecutor,
    actor: Actor,
    id: string,
    input: z.infer<typeof submitAnswerSchema>,
  ) {
    const run = await lockRun(tx, id, actor, true);
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `answer:${run.user_id}:${input.operationId}`,
      ]);
    const existing = (
      await tx.query<AttemptRow>(`${attemptSelect} WHERE a.user_id=$1 AND a.operation_id=$2`, [
        run.user_id,
        input.operationId,
      ])
    ).rows[0];
    if (existing) {
      if (
        existing.run_id !== id ||
        existing.turn_id !== input.turnId ||
        canonicalJson(existing.answer) !== canonicalJson(input.answer)
      )
        throw new AppError(
          409,
          'ANSWER_OPERATION_CONFLICT',
          'Эта операция уже сохранена с другим ответом.',
        );
      return existing.id;
    }
    const { step, turn, exercise } = await this.current(tx, run, input.turnId);
    if (turn.state !== 'open')
      throw new AppError(409, 'ANSWER_ALREADY_SAVED', 'Ответ уже проверен. Обновите прохождение.');
    const evaluation = evaluate(exercise, input.answer),
      hints = hintsOf(turn),
      date = new Date(this.now()),
      attempt = randomUUID();
    const active = activeTime(turn, this.now()),
      elapsed = Math.max(0, this.now() - new Date(turn.started_at).getTime());
    const adminAssistance = turn.admin_assistance || actor.user.id !== run.user_id;
    const independent =
      hints.length === 0 && !turn.prior_feedback && !turn.assistant_help && !adminAssistance;
    await tx.query(
      'INSERT INTO engine_attempts (id,run_id,step_id,turn_id,user_id,submitted_by,operation_id,answer,evaluation,is_correct,independent,used_hints,prior_feedback,active_ms,elapsed_ms,started_at,evaluated_at,admin_assistance,assistant_help) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
      [
        attempt,
        id,
        step.id,
        turn.id,
        run.user_id,
        actor.user.id,
        input.operationId,
        JSON.stringify(input.answer),
        JSON.stringify(evaluation),
        evaluation.correct,
        independent,
        JSON.stringify(hints),
        turn.prior_feedback,
        active,
        elapsed,
        turn.started_at,
        date,
        adminAssistance,
        turn.assistant_help,
      ],
    );
    await tx.query(
      "UPDATE engine_turns SET state='answered',draft_answer=$2,active_ms=$3,resumed=false,last_seen_at=$4,admin_assistance=$5 WHERE id=$1",
      [turn.id, JSON.stringify(input.answer), active, date, adminAssistance],
    );
    const integrity = await recordIntegrity(tx, run, turn, attempt, this.now());
    await tx.query(
      'INSERT INTO engine_events (id,attempt_id,kind,payload,created_at) VALUES ($1,$1,$2,$3,$4)',
      [
        attempt,
        'exercise.answered',
        JSON.stringify({
          attemptId: attempt,
          userId: run.user_id,
          submittedBy: actor.user.id,
          packageId: run.package_id,
          packageVersion: run.package_version,
          exerciseId: exercise.id,
          exerciseVersion: exercise.version,
          skillId: exercise.skillId,
          purpose: run.purpose,
          correct: evaluation.correct,
          independent,
          adminAssistance,
          requiresReview: integrity.requiresReview,
          usedHintCount: hints.length,
        }),
        date,
      ],
    );
    await this.changed(tx, run, actor, 'answer_submitted');
    await processRunLearningEvents(tx, id, this.now());
    return attempt;
  }
  async answer(actor: Actor, id: string, input: z.infer<typeof submitAnswerSchema>) {
    const attemptId = await this.db.transaction((tx) =>
      this.answerInTransaction(tx, actor, id, input),
    );
    const view = await this.repository.view(actor, id);
    return { attempt: view.attempts.find((attempt) => attempt.id === attemptId)!, view };
  }
  async next(actor: Actor, id: string, turnId: string) {
    await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor, true);
      const old = (
        await tx.query<StepRow>(
          'SELECT s.* FROM engine_steps s JOIN engine_turns t ON t.step_id=s.id WHERE s.run_id=$1 AND t.id=$2',
          [id, turnId],
        )
      ).rows[0];
      if (old?.state === 'completed') return;
      const { step, turn } = await this.current(tx, run, turnId);
      if (turn.state !== 'answered')
        throw new AppError(409, 'ANSWER_REQUIRED', 'Сначала ответьте на текущее задание.');
      await tx.query("UPDATE engine_steps SET state='completed' WHERE id=$1", [step.id]);
      const position = run.current_position + 1;
      if (position === run.total_steps) {
        await tx.query(
          "UPDATE engine_runs SET current_position=$2,status='completed',completed_at=$3,updated_at=$3 WHERE id=$1",
          [id, position, new Date(this.now())],
        );
        await persistDiagnosticResult(tx, id, this.now(), actor.user.id);
        await tx.query(
          'UPDATE plan_assignments SET closed_at=$2 WHERE run_id=$1 AND closed_at IS NULL',
          [id, new Date(this.now())],
        );
        await processRunLearningEvents(tx, id, this.now());
      } else {
        await tx.query('UPDATE engine_runs SET current_position=$2 WHERE id=$1', [id, position]);
        const following = (await stepsOf(tx, id)).find((item) => item.position === position)!;
        await this.openTurn(tx, following, actor, run.user_id);
        await this.changed(tx, run, actor, 'advanced');
      }
      if (
        actor.user.role === 'superadmin' &&
        actor.user.id !== run.user_id &&
        position === run.total_steps
      )
        await audit(tx, actor.user.id, 'learning.completed', run.user_id);
    });
    return this.repository.view(actor, id);
  }
  async retry(actor: Actor, id: string, turnId: string) {
    await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, id, actor, true);
      if (run.purpose !== 'practice')
        throw new AppError(403, 'RETRY_DISABLED', 'Повтор доступен только в тренировке.');
      const prior = (
        await tx.query<TurnRow>(
          'SELECT t.* FROM engine_turns t JOIN engine_steps s ON s.id=t.step_id WHERE s.run_id=$1 AND t.id=$2',
          [id, turnId],
        )
      ).rows[0];
      const step = (await stepsOf(tx, id)).find((item) => item.position === run.current_position);
      if (
        prior &&
        step?.id === prior.step_id &&
        step.current_turn_id !== turnId &&
        prior.state === 'answered'
      )
        return;
      const current = await this.current(tx, run, turnId);
      if (current.turn.state !== 'answered')
        throw new AppError(409, 'ANSWER_REQUIRED', 'Сначала сохраните попытку.');
      await this.openTurn(tx, current.step, actor, run.user_id);
      await this.changed(tx, run, actor, 'retried');
    });
    return this.repository.view(actor, id);
  }
  async list(actor: Actor, query: z.infer<typeof runsQuerySchema>) {
    if (query.userId) await assertUserAccess(this.db, actor, query.userId);
    const result = await this.db.query<RunRow>(
      `${runSelect} WHERE ($1::uuid IS NULL OR r.user_id=$1)
      AND ($2='superadmin' OR r.user_id=$3 OR ($2='teacher' AND EXISTS (SELECT 1 FROM teacher_students t WHERE t.teacher_id=$3 AND t.student_id=r.user_id)))
      AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4::timestamptz,$5::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT $6`,
      [
        query.userId ?? null,
        actor.user.role,
        actor.user.id,
        query.beforeCreatedAt ?? null,
        query.beforeId ?? null,
        query.limit + 1,
      ],
    );
    const hasMore = result.rows.length > query.limit,
      items = result.rows.slice(0, query.limit).map(summary),
      last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
}
