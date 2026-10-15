import { randomUUID } from 'node:crypto';
import {
  exerciseSchema,
  type Answer,
  type speechUploadSchema,
  type speechConfirmSchema,
  type speechTextSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { lockRun, stepsOf } from '../engine/repository.js';
import { LuchEngine } from '../engine/service.js';
import { AssistantService } from '../assistant/service.js';
import { configuration, ProviderSettingsService, type ProviderRow } from '../providers/settings.js';
import { ProviderBudget, type Reservation } from '../providers/budget.js';
import { ElevenLabsTranscriptionAdapter } from './adapter.js';
import { validateWav } from './wav.js';
import {
  expireSpeechAudio,
  readSpeech,
  speechSelect,
  speechView,
  type SpeechRow,
} from './repository.js';
const stale = () =>
  new AppError(409, 'TURN_CHANGED', 'Текущее задание уже изменилось. Обновите прохождение.');
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
    .trim();
export function transcriptAnswer(
  exercise: ReturnType<typeof exerciseSchema.parse>,
  text: string,
  optionId?: string,
): Answer {
  if (exercise.response.type === 'short_text') {
    if (optionId)
      throw new AppError(400, 'INVALID_SPEECH_OPTION', 'В этом задании нужен короткий текст.');
    return { type: 'short_text', text };
  }
  if (optionId) {
    if (!exercise.response.options.some((o) => o.id === optionId))
      throw new AppError(400, 'INVALID_SPEECH_OPTION', 'Выберите вариант из текущего задания.');
    return { type: 'choice', optionId };
  }
  const options = exercise.response.options.filter((o) => normalize(o.text) === normalize(text));
  if (options.length !== 1)
    throw new AppError(
      409,
      'SPEECH_CHOICE_REQUIRED',
      'Выберите вариант, которому соответствует ваша реплика. Ответ пока не оценивался.',
    );
  return { type: 'choice', optionId: options[0]!.id };
}
export class VoiceService {
  readonly db: Database;
  readonly budget: ProviderBudget;
  readonly engine: LuchEngine;
  readonly assistant: AssistantService;
  constructor(
    readonly settings: ProviderSettingsService,
    readonly adapter = new ElevenLabsTranscriptionAdapter(),
  ) {
    this.db = settings.db;
    this.budget = new ProviderBudget(settings);
    this.engine = new LuchEngine(this.db, settings.now);
    this.assistant = new AssistantService(this.db, undefined, settings.now);
  }
  async current(tx: QueryExecutor, actor: Actor, runId: string, turnId: string) {
    const run = await lockRun(tx, runId, actor, true);
    const step = (await stepsOf(tx, runId)).find(
      (s) => s.current_turn_id === turnId && s.position === run.current_position,
    );
    if (!step || run.status !== 'active') throw stale();
    const turn = (
      await tx.query<{ state: string }>('SELECT state FROM engine_turns WHERE id=$1', [turnId])
    ).rows[0];
    if (turn?.state !== 'open')
      throw new AppError(409, 'ANSWER_ALREADY_SAVED', 'Ответ уже сохранён. Обновите прохождение.');
    return { run, step, exercise: exerciseSchema.parse(step.definition) };
  }
  async recover(tx: QueryExecutor) {
    const now = this.settings.now();
    await tx.query(
      "UPDATE provider_requests SET status='unknown',error_code='SPEECH_INTERRUPTED',completed_at=$1 WHERE id IN (SELECT provider_request_id FROM speech_inputs WHERE status='processing' AND updated_at<$2) AND status='reserved'",
      [new Date(now), new Date(now - 30000)],
    );
    await tx.query(
      "UPDATE speech_inputs SET status='error',error_code='SPEECH_INTERRUPTED',updated_at=$1 WHERE status='processing' AND updated_at<$2",
      [new Date(now), new Date(now - 30000)],
    );
    await expireSpeechAudio(tx, now);
  }
  async session(actor: Actor, runId: string) {
    return this.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId, actor);
      // Expire failed recordings and recover interrupted jobs without redispatching paid calls.
      await this.recover(tx);
      const step = (await stepsOf(tx, runId)).find((s) => s.position === run.current_position);
      const config = await configuration(tx);
      const provider = (
        await tx.query<ProviderRow>("SELECT * FROM external_providers WHERE id='elevenlabs_stt'")
      ).rows[0]!;
      const maxSeconds = Math.min(
        config.controls.maxRecordingSeconds,
        config.ceilings.maxRecordingSeconds,
      );
      const row = step?.current_turn_id
        ? (
            await tx.query<SpeechRow>(
              `${speechSelect} WHERE s.run_id=$1 AND s.turn_id=$2 AND s.status<>'discarded' ORDER BY s.created_at DESC,s.id DESC LIMIT 1`,
              [runId, step.current_turn_id],
            )
          ).rows[0]
        : undefined;
      return {
        runId,
        turnId: step?.current_turn_id ?? null,
        writable: actor.user.id === run.user_id || actor.user.role === 'superadmin',
        enabled: Boolean(
          config.controls.transcriptionEnabled &&
          maxSeconds &&
          provider?.enabled &&
          this.settings.credential(provider) &&
          provider.pricing_confirmed_at &&
          new Date(provider.pricing_confirmed_at).getTime() +
            config.ceilings.pricingValidityHours * 3600000 >=
            this.settings.now(),
        ),
        maxSeconds,
        ttsEnabled: config.controls.assistantSpeechEnabled,
        input: row ? speechView(row, this.settings.now()) : null,
      };
    });
  }
  async read(actor: Actor, runId: string, id: string) {
    return this.db.transaction(async (tx) => {
      const { row } = await readSpeech(tx, actor, runId, id);
      return speechView(row, this.settings.now());
    });
  }
  async upload(
    actor: Actor,
    runId: string,
    input: z.infer<typeof speechUploadSchema>,
    originId: string | null = null,
  ) {
    const wav = validateWav(input.audioBase64);
    let reservation: Reservation | undefined;
    const id = await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId, actor, true);
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `speech:${run.user_id}:${input.operationId}`,
        ]);
      const old = (
        await tx.query<SpeechRow>(
          'SELECT * FROM speech_inputs WHERE user_id=$1 AND operation_id=$2',
          [run.user_id, input.operationId],
        )
      ).rows[0];
      if (old) {
        if (
          old.run_id !== runId ||
          old.turn_id !== input.turnId ||
          old.audio_hash !== wav.hash ||
          old.actor_id !== actor.user.id ||
          old.origin_id !== originId
        )
          throw new AppError(
            409,
            'SPEECH_OPERATION_CONFLICT',
            'Эта операция уже сохранена с другой записью.',
          );
        return old.id;
      }
      const { step, exercise } = await this.current(tx, actor, runId, input.turnId);
      await this.recover(tx);
      const id = randomUUID(),
        result = await this.budget.reserve(tx, actor, run.user_id, {
          resourceKey: `transcription:${run.user_id}:${input.operationId}`,
          kind: 'transcription',
          inputBound: Math.ceil(wav.durationMs / 1000),
        });
      if ('existing' in result)
        throw new AppError(
          409,
          'PROVIDER_IN_PROGRESS',
          'Распознавание уже выполняется. Обновите состояние.',
        );
      reservation = result.reservation;
      const now = new Date(this.settings.now());
      await tx.query(
        "INSERT INTO speech_inputs (id,user_id,run_id,step_id,turn_id,actor_id,operation_id,source,origin_id,audio_hash,audio,duration_ms,language,status,provider_request_id,created_at,updated_at,audio_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'voice',$8,$9,$10,$11,$12,'processing',$13,$14,$14,$15)",
        [
          id,
          run.user_id,
          runId,
          step.id,
          input.turnId,
          actor.user.id,
          input.operationId,
          originId,
          wav.hash,
          wav.audio,
          wav.durationMs,
          exercise.language,
          reservation.id,
          now,
          new Date(this.settings.now() + 24 * 3600000),
        ],
      );
      return id;
    });
    if (reservation) {
      const r = reservation;
      try {
        const row = (
          await this.db.query<SpeechRow>('SELECT * FROM speech_inputs WHERE id=$1', [id])
        ).rows[0]!;
        const text = await this.adapter.transcribe(r, wav.audio, row.language);
        await this.db.transaction(async (tx) => {
          await this.budget.settle(tx, r, {
            input: Math.ceil(wav.durationMs / 1000),
            output: 0,
            resultId: id,
          });
          await tx.query(
            "UPDATE speech_inputs SET transcript=$2,status='ready',audio=NULL,error_code=NULL,updated_at=$3 WHERE id=$1 AND status IN ('processing','error')",
            [id, text, new Date(this.settings.now())],
          );
        });
      } catch {
        await this.db.transaction(async (tx) => {
          await this.budget.settle(tx, r, null, 'TRANSCRIPTION_UNAVAILABLE');
          await tx.query(
            "UPDATE speech_inputs SET status='error',error_code='TRANSCRIPTION_UNAVAILABLE',updated_at=$2 WHERE id=$1 AND status='processing'",
            [id, new Date(this.settings.now())],
          );
        });
      }
    }
    return this.read(actor, runId, id);
  }
  async retry(actor: Actor, runId: string, id: string, operationId: string) {
    const row = await this.db.transaction(async (tx) => {
      const { row } = await readSpeech(tx, actor, runId, id, true);
      if (!speechView(row, this.settings.now()).canRetry)
        throw new AppError(
          409,
          'SPEECH_RETRY_UNAVAILABLE',
          'Сохранённая запись недоступна для повтора. Запишите реплику заново или используйте текст.',
        );
      return row;
    });
    return this.upload(
      actor,
      runId,
      { turnId: row.turn_id, operationId, audioBase64: Buffer.from(row.audio!).toString('base64') },
      id,
    );
  }
  async discard(actor: Actor, runId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const { row } = await readSpeech(tx, actor, runId, id, true);
      if (row.status === 'confirmed')
        throw new AppError(
          409,
          'SPEECH_ALREADY_CONFIRMED',
          'Ответ уже сохранён; его нельзя отменить как запись.',
        );
      if (row.status === 'processing')
        throw new AppError(
          409,
          'SPEECH_IN_PROGRESS',
          'Дождитесь окончания распознавания или используйте текстовый ответ.',
        );
      await tx.query(
        "UPDATE speech_inputs SET status='discarded',audio=NULL,updated_at=$2 WHERE id=$1",
        [id, new Date(this.settings.now())],
      );
    });
    return this.read(actor, runId, id);
  }
  async confirmInTransaction(
    tx: QueryExecutor,
    actor: Actor,
    runId: string,
    id: string,
    input: z.infer<typeof speechConfirmSchema>,
  ) {
    const { row } = await readSpeech(tx, actor, runId, id, true);
    if (row.status === 'confirmed') {
      if (
        row.confirmed_text !== input.text ||
        row.confirmed_option_id !== (input.optionId ?? null) ||
        row.confirm_operation_id !== input.operationId ||
        row.confirmed_by !== actor.user.id
      )
        throw new AppError(
          409,
          'SPEECH_CONFIRM_CONFLICT',
          'Реплика уже подтверждена с другим ответом.',
        );
      return;
    }
    if (row.status !== 'ready')
      throw new AppError(
        409,
        'SPEECH_NOT_READY',
        'Сначала получите и проверьте распознанный текст.',
      );
    const { exercise } = await this.current(tx, actor, runId, row.turn_id);
    const answer = transcriptAnswer(exercise, input.text, input.optionId);
    if (row.actor_id !== row.user_id)
      await tx.query('UPDATE engine_turns SET admin_assistance=true WHERE id=$1', [row.turn_id]);
    const attemptId = await this.engine.answerInTransaction(tx, actor, runId, {
      turnId: row.turn_id,
      operationId: input.operationId,
      answer,
    });
    const messageId = await this.assistant.recordAnswerInTransaction(
      tx,
      actor,
      runId,
      row.turn_id,
      input.operationId,
      input.text,
      attemptId,
    );
    await tx.query('UPDATE engine_attempts SET speech_input_id=$2 WHERE id=$1', [attemptId, id]);
    await tx.query(
      "UPDATE speech_inputs SET status='confirmed',confirmed_text=$2,confirmed_option_id=$3,confirm_operation_id=$4,attempt_id=$5,exchange_id=$6,audio=NULL,updated_at=$7,confirmed_by=$8 WHERE id=$1",
      [
        id,
        input.text,
        input.optionId ?? null,
        input.operationId,
        attemptId,
        messageId,
        new Date(this.settings.now()),
        actor.user.id,
      ],
    );
  }
  async result(actor: Actor, runId: string, id: string) {
    const input = await this.read(actor, runId, id);
    const assignment = await this.db.transaction(async (tx) => {
      await lockRun(tx, runId, actor);
      const a = (
        await tx.query<{
          id: string;
          plan_id: string;
          title: string;
          kind: string;
          due_at: Date | string | null;
        }>(
          `SELECT a.id,a.plan_id,a.kind,a.due_at,l.definition->>'title' AS title FROM learning_plan_changes c JOIN engine_events e ON e.id=c.event_id JOIN plan_assignments a ON a.id=c.assignment_id JOIN learning_lessons l ON l.package_id=a.package_id AND l.package_version=a.package_version AND l.id=a.lesson_id WHERE e.attempt_id=$1 AND a.kind<>'initial' ORDER BY CASE a.kind WHEN 'correction' THEN 0 WHEN 'supported_practice' THEN 1 ELSE 2 END,a.position LIMIT 1`,
          [input.attemptId],
        )
      ).rows[0];
      return a
        ? {
            id: a.id,
            planId: a.plan_id,
            title: a.title,
            kind: a.kind,
            dueAt: a.due_at ? new Date(a.due_at).toISOString() : null,
          }
        : null;
    });
    return { input, view: await this.engine.repository.view(actor, runId), assignment };
  }
  async confirm(
    actor: Actor,
    runId: string,
    id: string,
    input: z.infer<typeof speechConfirmSchema>,
  ) {
    await this.db.transaction((tx) => this.confirmInTransaction(tx, actor, runId, id, input));
    return this.result(actor, runId, id);
  }
  async text(actor: Actor, runId: string, input: z.infer<typeof speechTextSchema>) {
    const id = await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId, actor, true);
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `speech:${run.user_id}:${input.operationId}`,
        ]);
      let old = (
        await tx.query<SpeechRow>(
          'SELECT * FROM speech_inputs WHERE user_id=$1 AND operation_id=$2',
          [run.user_id, input.operationId],
        )
      ).rows[0];
      if (
        old &&
        (old.run_id !== runId ||
          old.turn_id !== input.turnId ||
          old.transcript !== input.text ||
          old.source !== 'text' ||
          old.actor_id !== actor.user.id)
      )
        throw new AppError(
          409,
          'SPEECH_OPERATION_CONFLICT',
          'Эта операция уже сохранена с другой репликой.',
        );
      if (!old) {
        const { step, exercise } = await this.current(tx, actor, runId, input.turnId),
          id = randomUUID(),
          now = new Date(this.settings.now());
        await tx.query(
          "INSERT INTO speech_inputs (id,user_id,run_id,step_id,turn_id,actor_id,operation_id,source,duration_ms,language,status,transcript,created_at,updated_at,audio_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'text',0,$8,'ready',$9,$10,$10,$10)",
          [
            id,
            run.user_id,
            runId,
            step.id,
            input.turnId,
            actor.user.id,
            input.operationId,
            exercise.language,
            input.text,
            now,
          ],
        );
        old = (await tx.query<SpeechRow>('SELECT * FROM speech_inputs WHERE id=$1', [id])).rows[0]!;
      }
      await this.confirmInTransaction(tx, actor, runId, old.id, input);
      return old.id;
    });
    return this.result(actor, runId, id);
  }
}
