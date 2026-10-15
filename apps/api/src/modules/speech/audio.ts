import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { assertUserAccess } from '../engine/repository.js';
import { ElevenLabsAdapter } from '../providers/adapters.js';
import { ProviderBudget, type Reservation } from '../providers/budget.js';
import { ProviderSettingsService, type ProviderRow } from '../providers/settings.js';
import type { QueryExecutor } from '../../db/database.js';
export class AssistantAudioService {
  readonly budget: ProviderBudget;
  constructor(
    readonly settings: ProviderSettingsService,
    readonly adapter = new ElevenLabsAdapter(),
  ) {
    this.budget = new ProviderBudget(settings);
  }
  async message(tx: QueryExecutor, actor: Actor, id: string, write = false) {
    const row = (
      await tx.query<{
        user_id: string;
        assistant_text: string;
        action: string;
        context: { exercise: { language: 'ru' | 'en' } };
      }>('SELECT * FROM assistant_exchanges WHERE id=$1', [id])
    ).rows[0];
    if (!row)
      throw new AppError(404, 'ASSISTANT_MESSAGE_NOT_FOUND', 'Реплика помощника не найдена.');
    await assertUserAccess(tx, actor, row.user_id, write);
    return row;
  }
  url(id: string, key: string) {
    return `/api/v1/assistant/messages/${id}/audio/${key}`;
  }
  async status(actor: Actor, id: string) {
    return this.settings.db.transaction(async (tx) => {
      await this.message(tx, actor, id);
      const row = (
        await tx.query<{ cache_key: string }>(
          'SELECT cache_key FROM assistant_message_audio WHERE exchange_id=$1',
          [id],
        )
      ).rows[0];
      return { url: row ? this.url(id, row.cache_key) : null };
    });
  }
  async prepare(actor: Actor, id: string, operationId: string) {
    let reservation: Reservation | undefined,
      text = '',
      language: 'ru' | 'en' = 'ru',
      key = '';
    const cached = await this.settings.db.transaction(async (tx) => {
      const message = await this.message(tx, actor, id, true);
      const linked = (
        await tx.query<{ cache_key: string }>(
          'SELECT cache_key FROM assistant_message_audio WHERE exchange_id=$1',
          [id],
        )
      ).rows[0];
      if (linked) return { url: this.url(id, linked.cache_key), cached: true };
      text = message.assistant_text;
      language = message.action === 'answer' ? 'ru' : message.context.exercise.language;
      const p = (
        await tx.query<ProviderRow>("SELECT * FROM external_providers WHERE id='elevenlabs'")
      ).rows[0]!;
      key = createHash('sha256')
        .update(
          JSON.stringify({
            text,
            language,
            model: p.model,
            voice: language === 'ru' ? p.voice_ru : p.voice_en,
          }),
        )
        .digest('hex');
      if (
        (await tx.query('SELECT 1 FROM assistant_audio_cache WHERE cache_key=$1', [key])).rows
          .length
      ) {
        await tx.query(
          'INSERT INTO assistant_message_audio (exchange_id,cache_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, key],
        );
        return { url: this.url(id, key), cached: true };
      }
      const reserved = await this.budget.reserve(tx, actor, message.user_id, {
        resourceKey: `assistant_speech:${message.user_id}:${id}:${operationId}`,
        cacheKey: `assistant:${key}`,
        kind: 'assistant_speech',
        inputBound: text.length,
      });
      if ('existing' in reserved)
        throw new AppError(
          reserved.existing.status === 'reserved' ? 409 : 503,
          reserved.existing.status === 'reserved' ? 'PROVIDER_IN_PROGRESS' : 'SPEECH_UNAVAILABLE',
          'Озвучивание пока недоступно. Повторите операцию; текст ответа сохранён.',
        );
      reservation = reserved.reservation;
      return null;
    });
    if (cached) return cached;
    const r = reservation!;
    try {
      const audio = await this.adapter.speak(r, text, language);
      await this.settings.db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO assistant_audio_cache (cache_key,request_id,audio,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [key, r.id, audio, new Date(this.settings.now())],
        );
        await tx.query(
          'INSERT INTO assistant_message_audio (exchange_id,cache_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, key],
        );
        await this.budget.settle(tx, r, { input: text.length, output: 0 });
      });
      return { url: this.url(id, key), cached: false };
    } catch {
      await this.settings.db.transaction((tx) =>
        this.budget.settle(tx, r, null, 'ASSISTANT_SPEECH_UNAVAILABLE'),
      );
      throw new AppError(
        503,
        'SPEECH_UNAVAILABLE',
        'Не удалось озвучить ответ. Текст и учебный результат сохранены. Можно повторить воспроизведение позже.',
      );
    }
  }
  async audio(actor: Actor, id: string, key: string) {
    return this.settings.db.transaction(async (tx) => {
      await this.message(tx, actor, id);
      const row = (
        await tx.query<{ audio: Uint8Array }>(
          'SELECT c.audio FROM assistant_message_audio m JOIN assistant_audio_cache c ON c.cache_key=m.cache_key WHERE m.exchange_id=$1 AND m.cache_key=$2',
          [id, key],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'AUDIO_NOT_FOUND', 'Аудио не найдено.');
      return Buffer.from(row.audio);
    });
  }
}
