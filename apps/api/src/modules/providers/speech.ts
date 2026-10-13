import { createHash } from 'node:crypto';
import { exerciseSchema } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { lockRun, stepsOf } from '../engine/repository.js';
import { ProviderBudget, type Reservation } from './budget.js';
import { ElevenLabsAdapter } from './adapters.js';
import { ProviderSettingsService, type ProviderRow } from './settings.js';

export class SpeechService {
  readonly budget: ProviderBudget;
  constructor(
    readonly settings: ProviderSettingsService,
    readonly adapter = new ElevenLabsAdapter(),
  ) {
    this.budget = new ProviderBudget(settings);
  }
  async link(tx: QueryExecutor, runId: string, stepId: string, key: string) {
    await tx.query(
      'INSERT INTO run_listening_assets (run_id,step_id,cache_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [runId, stepId, key],
    );
    return `/api/v1/engine/runs/${runId}/steps/${stepId}/listening/${key}`;
  }
  async prepare(actor: Actor, runId: string, stepId: string, operationId: string) {
    let reservation: Reservation | undefined,
      text = '',
      language: 'ru' | 'en' = 'en',
      key = '';
    const preparation = await this.settings.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId, actor);
      if (actor.user.id !== run.user_id && actor.user.role !== 'superadmin')
        throw new AppError(403, 'ACCESS_DENIED', 'Подготовить аудио может ученик или суперадмин.');
      const step = (await stepsOf(tx, runId)).find((s) => s.id === stepId);
      if (!step) throw new AppError(404, 'STEP_NOT_FOUND', 'Задание не найдено.');
      const exercise = exerciseSchema.parse(step.definition);
      if (!exercise.listening)
        throw new AppError(
          409,
          'LISTENING_NOT_AVAILABLE',
          'В этом задании нет listening-материала.',
        );
      text = exercise.listening.text;
      language = exercise.language;
      const linked = (
        await tx.query<{ cache_key: string }>(
          'SELECT cache_key FROM run_listening_assets WHERE run_id=$1 AND step_id=$2 ORDER BY cache_key LIMIT 1',
          [runId, stepId],
        )
      ).rows[0];
      if (linked)
        return { url: await this.link(tx, runId, stepId, linked.cache_key), cached: true };
      const provider = (
        await tx.query<ProviderRow>("SELECT * FROM external_providers WHERE id='elevenlabs'")
      ).rows[0]!;
      key = createHash('sha256')
        .update(
          JSON.stringify({
            text,
            language,
            model: provider.model,
            voice: language === 'ru' ? provider.voice_ru : provider.voice_en,
          }),
        )
        .digest('hex');
      if (
        (await tx.query('SELECT 1 FROM listening_audio_cache WHERE cache_key=$1', [key])).rows
          .length
      )
        return { url: await this.link(tx, runId, stepId, key), cached: true };
      const result = await this.budget.reserve(tx, actor, run.user_id, {
        resourceKey: `listening:${key}:${operationId}`,
        cacheKey: key,
        kind: 'listening',
        inputBound: text.length,
      });
      if ('existing' in result)
        throw new AppError(
          result.existing.status === 'reserved' ? 409 : 503,
          result.existing.status === 'reserved' ? 'PROVIDER_IN_PROGRESS' : 'SPEECH_UNAVAILABLE',
          'Аудио пока недоступно. Повторите подготовку позже.',
        );
      reservation = result.reservation;
      return null;
    });
    if (preparation) return preparation;
    const r = reservation!;
    try {
      const audio = await this.adapter.speak(r, text, language);
      return await this.settings.db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO listening_audio_cache (cache_key,request_id,audio,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (cache_key) DO NOTHING',
          [key, r.id, audio, new Date(this.settings.now())],
        );
        await this.budget.settle(tx, r, { input: text.length, output: 0 });
        return { url: await this.link(tx, runId, stepId, key), cached: false };
      });
    } catch {
      await this.settings.db.transaction((tx) =>
        this.budget.settle(tx, r, null, 'SPEECH_UNAVAILABLE'),
      );
      throw new AppError(
        503,
        'SPEECH_UNAVAILABLE',
        'Не удалось подготовить аудио. Учебный ответ и оценка не изменены.',
      );
    }
  }
  async audio(actor: Actor, runId: string, stepId: string, key: string) {
    return this.settings.db.transaction(async (tx) => {
      await lockRun(tx, runId, actor);
      const row = (
        await tx.query<{ audio: Uint8Array }>(
          `SELECT c.audio FROM run_listening_assets x JOIN listening_audio_cache c ON c.cache_key=x.cache_key
        WHERE x.run_id=$1 AND x.step_id=$2 AND x.cache_key=$3`,
          [runId, stepId, key],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'AUDIO_NOT_FOUND', 'Аудио не найдено.');
      return Buffer.from(row.audio);
    });
  }
}
