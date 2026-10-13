import { randomUUID } from 'node:crypto';
import {
  assistantContextSchema,
  assistantPreferencesSchema,
  exerciseSchema,
  lessonSchema,
  type AssistantContext,
  type sendAssistantMessageSchema,
  type saveAssistantProfileSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import {
  assertUserAccess,
  attemptSelect,
  attemptView,
  hintsOf,
  lockRun,
  stepsOf,
  type AttemptRow,
  type TurnRow,
} from '../engine/repository.js';
import { exerciseView } from '../content/repository.js';
import { canonicalJson } from '../content/service.js';
import { avatars, profileOf, messagesOf, markHelp, type ExchangeRow } from './repository.js';
import { DemoAssistantAdapter } from './demo.js';

export class AssistantService {
  constructor(
    readonly db: Database,
    readonly adapter = new DemoAssistantAdapter(),
    readonly now: () => number = Date.now,
  ) {}
  async profile(actor: Actor, userId = actor.user.id) {
    return this.db.transaction(async (tx) => {
      await assertUserAccess(tx, actor, userId);
      const goal = (
        await tx.query<{ goal: string }>(
          "SELECT questionnaire->>'goal' AS goal FROM student_profiles WHERE user_id=$1",
          [userId],
        )
      ).rows[0]?.goal;
      return {
        userId,
        ...(await profileOf(tx, userId)),
        recommendedAvatarId: goal === 'work' ? ('partner' as const) : ('mentor' as const),
        avatars,
        writable: actor.user.id === userId || actor.user.role === 'superadmin',
      };
    });
  }
  async saveProfile(actor: Actor, input: z.infer<typeof saveAssistantProfileSchema>) {
    const userId = input.userId ?? actor.user.id;
    await this.db.transaction(async (tx) => {
      await assertUserAccess(tx, actor, userId, true);
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const old = await profileOf(tx, userId);
      if (canonicalJson(old.preferences) === canonicalJson(input.preferences) && old.revision > 0)
        return;
      if (old.revision !== input.revision)
        throw new AppError(
          409,
          'ASSISTANT_PROFILE_CHANGED',
          'Выбор помощника уже изменён. Обновите страницу.',
        );
      await tx.query(
        'INSERT INTO assistant_profiles (user_id,revision,preferences,updated_by,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO UPDATE SET revision=$2,preferences=$3,updated_by=$4,updated_at=$5',
        [
          userId,
          old.revision + 1,
          JSON.stringify(input.preferences),
          actor.user.id,
          new Date(this.now()),
        ],
      );
      await audit(tx, actor.user.id, 'assistant.profile_saved', userId);
    });
    return this.profile(actor, userId);
  }
  async context(tx: QueryExecutor, actor: Actor, runId: string, write = false) {
    const run = await lockRun(tx, runId, actor, write),
      step = (await stepsOf(tx, runId)).find((s) => s.position === run.current_position);
    if (!step || !step.current_turn_id)
      return { run, step: null, turn: null, context: null, exercise: null };
    const exercise = exerciseSchema.parse(step.definition);
    const turn = (
      await tx.query<TurnRow>('SELECT * FROM engine_turns WHERE id=$1', [step.current_turn_id])
    ).rows[0]!;
    const material =
      run.purpose === 'practice'
        ? lessonSchema.parse(
            (
              await tx.query<{ definition: unknown }>(
                'SELECT definition FROM learning_lessons WHERE package_id=$1 AND package_version=$2 AND id=$3',
                [run.package_id, run.package_version, exercise.lessonId],
              )
            ).rows[0]!.definition,
          ).blocks
        : [];
    const previous = (
      await tx.query<AttemptRow>(
        `${attemptSelect} WHERE a.run_id=$1 ORDER BY a.evaluated_at DESC,a.id DESC LIMIT 1`,
        [runId],
      )
    ).rows[0];
    const attempt = previous
      ? attemptView(previous, run.purpose === 'practice' || run.status === 'completed')
      : null;
    const goal =
      (
        await tx.query<{ goal: string }>(
          "SELECT questionnaire->>'goal' AS goal FROM student_profiles WHERE user_id=$1",
          [run.user_id],
        )
      ).rows[0]?.goal ?? null;
    const context: AssistantContext = {
      runId,
      stepId: step.id,
      turnId: turn.id,
      packageId: run.package_id,
      packageVersion: run.package_version,
      generatedExerciseId: step.generated_exercise_id,
      purpose: run.purpose,
      topic: run.title,
      exercise: exerciseView(exercise),
      material,
      lastAttempt: attempt
        ? {
            id: attempt.id,
            exerciseId: attempt.exerciseId,
            answer: attempt.answer,
            evaluation: attempt.evaluation,
          }
        : null,
      goal,
    };
    return { run, step, turn, exercise, context };
  }
  async chat(actor: Actor, runId: string, before?: number) {
    return this.db.transaction(async (tx) => {
      const { run, context } = await this.context(tx, actor, runId);
      const rows = (
        await tx.query<ExchangeRow>(
          'SELECT * FROM assistant_exchanges WHERE run_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT 31',
          [runId, before ?? null],
        )
      ).rows;
      const chosen = rows.slice(0, 30).reverse();
      if (actor.user.role === 'superadmin')
        await audit(tx, actor.user.id, 'assistant.chat_view', run.user_id);
      return {
        label: 'Демо-помощник' as const,
        runId,
        title: run.title,
        writable: actor.user.id === run.user_id || actor.user.role === 'superadmin',
        hintsEnabled: run.purpose === 'practice',
        messages: messagesOf(chosen, actor.user.role === 'superadmin'),
        nextBefore: rows.length > 30 ? Number(chosen[0]!.sequence) : null,
        context: actor.user.role === 'superadmin' ? context : null,
      };
    });
  }
  async send(actor: Actor, runId: string, input: z.infer<typeof sendAssistantMessageSchema>) {
    await this.db.transaction(async (tx) => {
      const { run, step, turn, context, exercise } = await this.context(tx, actor, runId, true);
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `assistant:${run.user_id}:${input.operationId}`,
        ]);
      const old = (
        await tx.query<ExchangeRow>(
          'SELECT * FROM assistant_exchanges WHERE user_id=$1 AND operation_id=$2',
          [run.user_id, input.operationId],
        )
      ).rows[0];
      if (old) {
        if (
          old.run_id !== runId ||
          canonicalJson(old.request) !== canonicalJson(input) ||
          old.actor_id !== actor.user.id
        )
          throw new AppError(
            409,
            'ASSISTANT_OPERATION_CONFLICT',
            'Эта операция уже сохранена с другим сообщением.',
          );
        return;
      }
      if (!turn || !step || !context || !exercise || turn.id !== input.turnId)
        throw new AppError(
          409,
          'TURN_CHANGED',
          'Текущее задание изменилось. Обновите прохождение.',
        );
      if (run.purpose !== 'practice' && input.action !== 'explain')
        throw new AppError(
          403,
          'HINTS_DISABLED',
          'В диагностике и контрольных заданиях подсказки и тематический диалог отключены.',
        );
      const count = (
        await tx.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM assistant_exchanges WHERE run_id=$1 AND created_at>$2',
          [runId, new Date(this.now() - 60_000)],
        )
      ).rows[0]!;
      if (Number(count.count) >= 20)
        throw new AppError(429, 'ASSISTANT_RATE_LIMIT', 'Помощник занят. Повторите через минуту.');
      const preferences = (await profileOf(tx, run.user_id)).preferences;
      const used = hintsOf(turn),
        nextHint = exercise.hints.findIndex((_, i) => !used.some((h) => h.index === i));
      const hint =
        input.action === 'hint'
          ? (exercise.hints[nextHint] ?? exercise.hints.at(-1) ?? null)
          : null;
      const dialogueTurn = Number(
        (
          await tx.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM assistant_exchanges WHERE run_id=$1 AND step_id=$2 AND action='dialogue'",
            [runId, step.id],
          )
        ).rows[0]!.count,
      );
      const reply = await this.adapter.reply({
        context,
        preferences,
        action: input.action,
        text: input.text,
        hint,
        dialogueTurn,
      });
      if (!reply || reply.length > 5000)
        throw new AppError(
          503,
          'ASSISTANT_UNAVAILABLE',
          'Помощник не смог ответить. Повторите сообщение.',
        );
      await tx.query(
        'INSERT INTO assistant_exchanges (id,user_id,run_id,step_id,turn_id,operation_id,request,context,preferences,action,user_text,assistant_text,actor_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          randomUUID(),
          run.user_id,
          runId,
          step.id,
          turn.id,
          input.operationId,
          JSON.stringify(input),
          JSON.stringify(assistantContextSchema.parse(context)),
          JSON.stringify(preferences),
          input.action,
          input.text,
          reply,
          actor.user.id,
          new Date(this.now()),
        ],
      );
      if (run.purpose === 'practice' && turn.state === 'open')
        await markHelp(
          tx,
          turn.id,
          input.action === 'hint' && nextHint >= 0
            ? {
                index: nextHint,
                text: hint!,
                usedAt: new Date(this.now()).toISOString(),
                usedBy: actor.user.id,
              }
            : null,
          actor.user.id,
          run.user_id,
        );
      if (actor.user.id !== run.user_id)
        await audit(tx, actor.user.id, 'assistant.message_sent', run.user_id);
    });
    return this.chat(actor, runId);
  }
}
