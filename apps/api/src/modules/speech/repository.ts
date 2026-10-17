import { speechInputSchema } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { iso, lockRun } from '../engine/repository.js';
export type SpeechRow = {
  id: string;
  user_id: string;
  run_id: string;
  step_id: string;
  turn_id: string;
  actor_id: string;
  operation_id: string;
  source: 'voice' | 'text';
  origin_id: string | null;
  audio_hash: string | null;
  audio: Uint8Array | null;
  duration_ms: number;
  language: 'ru' | 'en';
  status: 'processing' | 'ready' | 'error' | 'discarded' | 'confirmed';
  transcript: string | null;
  confirmed_text: string | null;
  confirmed_option_id: string | null;
  confirm_operation_id: string | null;
  confirmed_by: string | null;
  attempt_id: string | null;
  exchange_id: string | null;
  provider_request_id: string | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  audio_expires_at: Date | string;
  reply?: string | null;
};
export const speechSelect =
  'SELECT s.*,e.assistant_text AS reply FROM speech_inputs s LEFT JOIN assistant_exchanges e ON e.id=s.exchange_id';
export function speechView(row: SpeechRow, now: number) {
  return speechInputSchema.parse({
    id: row.id,
    runId: row.run_id,
    turnId: row.turn_id,
    source: row.source,
    status: row.status,
    transcript: row.transcript,
    confirmedText: row.confirmed_text,
    optionId: row.confirmed_option_id,
    durationMilliseconds: row.duration_ms,
    edited: row.confirmed_text !== null && row.confirmed_text !== row.transcript,
    canRetry:
      row.status === 'error' &&
      Boolean(row.audio) &&
      new Date(row.audio_expires_at).getTime() > now,
    attemptId: row.attempt_id,
    messageId: row.exchange_id,
    reply: row.reply ?? null,
    error:
      row.status === 'error'
        ? 'Не удалось распознать запись. Можно повторить распознавание, записать заново или ввести текст. Учебная оценка не изменена.'
        : null,
    createdAt: iso(row.created_at),
  });
}
export async function readSpeech(
  tx: QueryExecutor,
  actor: Actor,
  runId: string,
  id: string,
  write = false,
) {
  const run = await lockRun(tx, runId, actor, write);
  const row = (
    await tx.query<SpeechRow>(
      `${speechSelect} WHERE s.id=$1 AND s.run_id=$2 ${write ? 'FOR UPDATE OF s' : ''}`,
      [id, runId],
    )
  ).rows[0];
  if (!row) throw new AppError(404, 'SPEECH_INPUT_NOT_FOUND', 'Реплика не найдена.');
  return { run, row };
}
export async function expireSpeechAudio(tx: QueryExecutor, now: number) {
  const result = await tx.query(
    'UPDATE speech_inputs SET audio=NULL WHERE audio IS NOT NULL AND audio_expires_at<=$1 RETURNING id',
    [new Date(now)],
  );
  return result.rows.length;
}
