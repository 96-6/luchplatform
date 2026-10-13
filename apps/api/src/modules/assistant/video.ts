import { createHash } from 'node:crypto';
import {
  assistantPreferencesSchema,
  avatarBindingsSchema,
  type updateAvatarBindingsSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { assertUserAccess } from '../engine/repository.js';
import { audit } from '../accounts/repository.js';
import { canonicalJson } from '../content/service.js';
import {
  configuration,
  ProviderSettingsService,
  type ProviderRow,
  requireOperator,
} from '../providers/settings.js';
import { ProviderBudget, type Reservation } from '../providers/budget.js';
import { HeyGenAdapter, HeyGenRejected } from '../providers/heygen.js';
import type { ExchangeRow } from './repository.js';

type Job = {
  cache_key: string;
  request_id: string;
  remote_id: string | null;
  credential_ciphertext: string | null;
  reservation: Omit<Reservation, 'credential'>;
  status: 'submitting' | 'pending' | 'ready' | 'error';
  error_code: string | null;
  created_at: Date | string;
};
const unavailable = () =>
  new AppError(
    503,
    'CONTENT_GENERATION_UNAVAILABLE',
    'Ошибка генерации контента: подходящего непросмотренного видео нет, а новый ролик сейчас недоступен. Повторите позже.',
  );
export class AvatarVideoService {
  readonly budget: ProviderBudget;
  constructor(
    readonly settings: ProviderSettingsService,
    readonly adapter = new HeyGenAdapter(),
  ) {
    this.budget = new ProviderBudget(settings);
  }
  async bindings(actor: Actor) {
    requireOperator(actor, true);
    const row = (
      await this.settings.db.query<{ revision: number; bindings: unknown }>(
        'SELECT * FROM avatar_configuration WHERE id=1',
      )
    ).rows[0]!;
    return avatarBindingsSchema.parse({ revision: row.revision, items: row.bindings });
  }
  async updateBindings(actor: Actor, input: z.infer<typeof updateAvatarBindingsSchema>) {
    requireOperator(actor, true);
    await this.settings.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ revision: number; bindings: unknown }>(
          'SELECT * FROM avatar_configuration WHERE id=1 FOR UPDATE',
        )
      ).rows[0]!;
      if (row.revision !== input.revision)
        throw new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
      if (canonicalJson(row.bindings) === canonicalJson(input.items)) return;
      await tx.query(
        'UPDATE avatar_configuration SET revision=revision+1,bindings=$1,updated_by=$2,updated_at=$3 WHERE id=1',
        [JSON.stringify(input.items), actor.user.id, new Date(this.settings.now())],
      );
      await tx.query(
        "UPDATE external_providers SET enabled=false,pricing_confirmed_at=NULL,revision=revision+1 WHERE id='heygen'",
      );
      await audit(tx, actor.user.id, 'assistant.avatar_bindings_changed');
    });
    return this.bindings(actor);
  }
  async exchange(tx: QueryExecutor, actor: Actor, id: string, write = false) {
    const row = (await tx.query<ExchangeRow>('SELECT * FROM assistant_exchanges WHERE id=$1', [id]))
      .rows[0];
    if (!row) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Реплика не найдена.');
    await assertUserAccess(tx, actor, row.user_id, write);
    return row;
  }
  async link(tx: QueryExecutor, exchangeId: string, key: string) {
    await tx.query(
      'INSERT INTO assistant_message_videos (exchange_id,cache_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [exchangeId, key],
    );
  }
  result(job: Job, exchangeId: string, cached: boolean) {
    if (job.status === 'error')
      return {
        status: 'error' as const,
        url: null,
        cached,
        message:
          'Ошибка генерации контента. Готовое видео недоступно; текстовая реплика сохранена.',
      };
    return {
      status: job.status === 'ready' ? ('ready' as const) : ('pending' as const),
      url: job.status === 'ready' ? `/api/v1/assistant/messages/${exchangeId}/video/media` : null,
      cached,
      message: null,
    };
  }
  async prepare(actor: Actor, exchangeId: string) {
    let reservation: Reservation | undefined,
      key = '',
      script = '',
      avatarId = '',
      voiceId = '',
      language: 'ru' | 'en' = 'en',
      speed = 1;
    const prepared = await this.settings.db.transaction(async (tx) => {
      const exchange = await this.exchange(tx, actor, exchangeId, true);
      // Serialize preparation for this message even when two browser tabs send together.
      await tx.query('SELECT id FROM assistant_exchanges WHERE id=$1 FOR UPDATE', [exchangeId]);
      const linked = (
        await tx.query<Job>(
          'SELECT j.* FROM assistant_message_videos m JOIN avatar_video_jobs j ON j.cache_key=m.cache_key WHERE m.exchange_id=$1',
          [exchangeId],
        )
      ).rows[0];
      if (linked) return this.result(linked, exchangeId, true);
      const config = await configuration(tx, true),
        p = assistantPreferencesSchema.parse(exchange.preferences);
      const bindings = avatarBindingsSchema.parse({
        revision: 1,
        items: (
          await tx.query<{ bindings: unknown }>(
            'SELECT bindings FROM avatar_configuration WHERE id=1',
          )
        ).rows[0]!.bindings,
      }).items;
      const provider = (
        await tx.query<ProviderRow>("SELECT * FROM external_providers WHERE id='heygen'")
      ).rows[0]!;
      language = (exchange.context as { exercise: { language: 'ru' | 'en' } }).exercise.language;
      avatarId = bindings.find((b) => b.id === p.avatarId)!.avatarId;
      const voice = bindings.find((b) => b.id === p.voiceAvatarId)!;
      voiceId = language === 'ru' ? voice.voiceRu : voice.voiceEn;
      speed = p.pace === 'slow' ? 0.8 : p.pace === 'fast' ? 1.2 : 1;
      script = exchange.assistant_text;
      key = createHash('sha256')
        .update(
          JSON.stringify({ script, language, avatarId, voiceId, speed, model: provider.model }),
        )
        .digest('hex');
      const contentKey = createHash('sha256')
        .update(JSON.stringify({ script, language, avatar: p.avatarId, voice: p.voiceAvatarId }))
        .digest('hex');
      let cached = (
        await tx.query<Job>('SELECT * FROM avatar_video_jobs WHERE cache_key=$1', [key])
      ).rows[0];
      const alreadySeen =
        cached?.status === 'ready' &&
        Boolean(
          (
            await tx.query('SELECT 1 FROM avatar_video_views WHERE user_id=$1 AND cache_key=$2', [
              exchange.user_id,
              key,
            ])
          ).rows.length,
        );
      if (!cached || cached.status === 'error' || alreadySeen) {
        const fallback = (
          await tx.query<Job>(
            'SELECT j.* FROM avatar_video_jobs j JOIN avatar_video_cache c ON c.cache_key=j.cache_key WHERE j.content_key=$1 AND NOT EXISTS(SELECT 1 FROM avatar_video_views v WHERE v.user_id=$2 AND v.cache_key=j.cache_key) ORDER BY j.created_at,j.cache_key LIMIT 1',
            [contentKey, exchange.user_id],
          )
        ).rows[0];
        if (fallback) {
          await this.link(tx, exchangeId, fallback.cache_key);
          return this.result(fallback, exchangeId, true);
        }
      }
      if (alreadySeen) throw unavailable();
      if (cached && cached.status !== 'error') {
        await this.link(tx, exchangeId, key);
        return this.result(cached, exchangeId, true);
      }
      // Settings/price revisions permit an explicit new attempt after a known rejection.
      if (cached)
        key = createHash('sha256')
          .update(`${key}:${provider.revision}:${config.revision}`)
          .digest('hex');
      if (
        !avatarId ||
        !voiceId ||
        script.length >
          Math.min(config.ceilings.maxVideoCharacters, config.controls.maxVideoCharacters)
      )
        throw unavailable();
      const seconds = Math.ceil(script.length / (2.5 * speed) + 10);
      let result: Awaited<ReturnType<ProviderBudget['reserve']>>;
      try {
        result = await this.budget.reserve(tx, actor, exchange.user_id, {
          resourceKey: `avatar:${key}`,
          cacheKey: key,
          kind: 'avatar_video',
          inputBound: seconds,
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          [
            'PROVIDER_DISABLED',
            'PROVIDER_UNAVAILABLE',
            'PROVIDER_BUDGET_LIMIT',
            'PROVIDER_INPUT_LIMIT',
          ].includes(error.code)
        )
          throw unavailable();
        throw error;
      }
      if ('existing' in result) throw unavailable();
      reservation = result.reservation;
      const { credential, ...metadata } = reservation;
      await tx.query(
        'INSERT INTO avatar_video_jobs (cache_key,request_id,credential_ciphertext,reservation,created_at,content_key) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          key,
          reservation.id,
          this.settings.crypto.encrypt(credential),
          JSON.stringify(metadata),
          new Date(this.settings.now()),
          contentKey,
        ],
      );
      await this.link(tx, exchangeId, key);
      return null;
    });
    if (prepared) return prepared;
    try {
      const remote = await this.adapter.start(
        reservation!,
        script,
        avatarId,
        voiceId,
        language,
        speed,
      );
      await this.settings.db.query(
        "UPDATE avatar_video_jobs SET remote_id=$2,status='pending' WHERE cache_key=$1",
        [key, remote],
      );
      return { status: 'pending' as const, url: null, cached: false, message: null };
    } catch (error) {
      await this.settings.db.transaction(async (tx) => {
        if (error instanceof HeyGenRejected) {
          await tx.query(
            "UPDATE provider_requests SET status='failed',charged_micros=0,error_code=$2,completed_at=$3 WHERE id=$1 AND status='reserved'",
            [reservation!.id, error.code, new Date(this.settings.now())],
          );
        } else await this.budget.settle(tx, reservation!, null, 'HEYGEN_UNAVAILABLE');
        await tx.query(
          "UPDATE avatar_video_jobs SET status='error',error_code=$2,credential_ciphertext=NULL WHERE cache_key=$1",
          [key, error instanceof HeyGenRejected ? error.code : 'HEYGEN_UNAVAILABLE'],
        );
      });
      throw unavailable();
    }
  }
  async status(actor: Actor, exchangeId: string) {
    const job = await this.settings.db.transaction(async (tx) => {
      await this.exchange(tx, actor, exchangeId);
      const row = (
        await tx.query<Job>(
          'SELECT j.* FROM assistant_message_videos m JOIN avatar_video_jobs j ON j.cache_key=m.cache_key WHERE m.exchange_id=$1',
          [exchangeId],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'VIDEO_NOT_FOUND', 'Сначала подготовьте видео.');
      if (
        row.status === 'submitting' &&
        this.settings.now() - new Date(row.created_at).getTime() > 30_000
      ) {
        const r: Reservation = { ...row.reservation, credential: '' };
        await this.budget.settle(tx, r, null, 'HEYGEN_INTERRUPTED');
        await tx.query(
          "UPDATE avatar_video_jobs SET status='error',error_code='HEYGEN_INTERRUPTED',credential_ciphertext=NULL WHERE cache_key=$1",
          [row.cache_key],
        );
        return { row: { ...row, status: 'error' as const }, poll: false };
      }
      if (row.status !== 'pending') return { row, poll: false };
      const claimed = await tx.query(
        'UPDATE avatar_video_jobs SET next_poll_at=$2 WHERE cache_key=$1 AND next_poll_at<=$3 RETURNING cache_key',
        [row.cache_key, new Date(this.settings.now() + 5000), new Date(this.settings.now())],
      );
      return { row, poll: Boolean(claimed.rows.length) };
    });
    const j = job.row;
    if (!job.poll) return this.result(j, exchangeId, true);
    const r: Reservation = {
      ...j.reservation,
      credential: this.settings.crypto.decrypt(j.credential_ciphertext!),
    };
    try {
      const result = await this.adapter.status(j.remote_id!, r.credential);
      if (result.status === 'failed') {
        await this.settings.db.transaction(async (tx) => {
          await this.budget.settle(tx, r, null, 'HEYGEN_VIDEO_FAILED');
          await tx.query(
            "UPDATE avatar_video_jobs SET status='error',error_code='HEYGEN_VIDEO_FAILED',credential_ciphertext=NULL WHERE cache_key=$1",
            [j.cache_key],
          );
        });
        return this.result({ ...j, status: 'error' }, exchangeId, false);
      }
      if (result.status === 'completed') {
        if (!result.video_url || !result.duration || !Number.isFinite(result.duration))
          throw new Error('INVALID_VIDEO_METADATA');
        const video = await this.adapter.download(result.video_url),
          seconds = Math.ceil(result.duration);
        await this.settings.db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO avatar_video_cache (cache_key,video,duration,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [j.cache_key, video, seconds, new Date(this.settings.now())],
          );
          await this.budget.settle(tx, r, { input: seconds, output: 0 });
          await tx.query(
            "UPDATE avatar_video_jobs SET status='ready',credential_ciphertext=NULL WHERE cache_key=$1",
            [j.cache_key],
          );
        });
        return this.result({ ...j, status: 'ready' }, exchangeId, false);
      }
    } catch {
      // A status/download timeout retries only the read, never the paid creation.
      return {
        status: 'pending' as const,
        url: null,
        cached: true,
        message: 'Видео ещё недоступно. Повторим проверку; новая платная генерация не запускается.',
      };
    }
    return this.result(j, exchangeId, true);
  }
  async media(actor: Actor, exchangeId: string) {
    return this.settings.db.transaction(async (tx) => {
      const exchange = await this.exchange(tx, actor, exchangeId);
      const row = (
        await tx.query<{ video: Uint8Array; cache_key: string }>(
          'SELECT c.* FROM assistant_message_videos m JOIN avatar_video_cache c ON c.cache_key=m.cache_key WHERE m.exchange_id=$1',
          [exchangeId],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'VIDEO_NOT_FOUND', 'Видео ещё не готово.');
      if (actor.user.id === exchange.user_id)
        await tx.query(
          'INSERT INTO avatar_video_views (user_id,cache_key,first_viewed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [exchange.user_id, row.cache_key, new Date(this.settings.now())],
        );
      return Buffer.from(row.video);
    });
  }
}
