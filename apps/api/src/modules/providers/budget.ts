import { randomUUID } from 'node:crypto';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { configuration, spend, type ProviderRow, ProviderSettingsService } from './settings.js';
export type Reservation = {
  id: string;
  provider: ProviderRow;
  credential: string;
  cost: number;
  inputBound: number;
  outputBound: number;
  withListening: boolean;
};
export type RequestRow = {
  id: string;
  status: string;
  created_at: Date | string;
  result_id: string | null;
  charged_micros: string;
  reserved_micros: string;
  user_id: string;
};
export const tokenCost = (input: number, output: number, provider: ProviderRow) =>
  Math.max(
    1,
    Number(
      (BigInt(input) * BigInt(provider.input_rate ?? 0) +
        BigInt(output) * BigInt(provider.output_rate ?? 0) +
        999999n) /
        1000000n,
    ),
  );
const characterCost = (characters: number, provider: ProviderRow) =>
  Math.max(1, Number((BigInt(characters) * BigInt(provider.character_rate ?? 0) + 999n) / 1000n));
export const videoCost = (seconds: number, provider: ProviderRow) =>
  Math.max(1, Number((BigInt(seconds) * BigInt(provider.minute_rate ?? 0) + 59n) / 60n));
export class ProviderBudget {
  constructor(readonly settings: ProviderSettingsService) {}
  async reserve(
    tx: QueryExecutor,
    actor: Actor,
    userId: string,
    request: {
      resourceKey: string;
      kind:
        'adaptive_exercise' | 'listening' | 'avatar_video' | 'transcription' | 'assistant_speech';
      assignmentId?: string;
      cacheKey?: string;
      inputBound: number;
    },
  ) {
    const config = await configuration(tx, true),
      now = this.settings.now();
    await tx.query(
      "UPDATE provider_requests SET status='unknown',error_code='INTERRUPTED',completed_at=$1 WHERE status='reserved' AND kind<>'avatar_video' AND created_at<$2",
      [new Date(now), new Date(now - 30_000)],
    );
    const existing = (
      await tx.query<RequestRow>('SELECT * FROM provider_requests WHERE resource_key=$1', [
        request.resourceKey,
      ])
    ).rows[0];
    if (existing) {
      if (existing.user_id !== userId)
        throw new AppError(409, 'PROVIDER_OPERATION_CONFLICT', 'Операция уже используется.');
      return { existing };
    }
    const enabled =
      request.kind === 'avatar_video'
        ? config.controls.videoEnabled
        : request.kind === 'transcription'
          ? config.controls.transcriptionEnabled
          : request.kind === 'assistant_speech'
            ? config.controls.assistantSpeechEnabled
            : request.kind === 'listening'
              ? config.controls.listeningEnabled
              : config.controls.enabled;
    if (!enabled) throw new AppError(409, 'PROVIDER_DISABLED', 'Внешняя генерация выключена.');
    if (
      (request.kind === 'listening' || request.kind === 'assistant_speech') &&
      request.inputBound >
        Math.min(config.controls.maxTtsCharacters, config.ceilings.maxTtsCharacters)
    )
      throw new AppError(
        409,
        'PROVIDER_INPUT_LIMIT',
        'Текст превышает разрешённый объём озвучивания.',
      );
    if (
      request.kind === 'transcription' &&
      request.inputBound >
        Math.min(config.controls.maxRecordingSeconds, config.ceilings.maxRecordingSeconds)
    )
      throw new AppError(
        409,
        'PROVIDER_INPUT_LIMIT',
        'Запись превышает разрешённую продолжительность.',
      );
    if (
      request.kind === 'avatar_video' &&
      request.inputBound >
        Math.min(config.controls.maxVideoSeconds, config.ceilings.maxVideoSeconds)
    )
      throw new AppError(
        409,
        'PROVIDER_INPUT_LIMIT',
        'Видео превышает установленную продолжительность.',
      );
    const rows = (await tx.query<ProviderRow>('SELECT * FROM external_providers ORDER BY id')).rows;
    const valid = rows.filter(
      (p) =>
        p.enabled &&
        this.settings.credential(p) &&
        p.pricing_confirmed_at &&
        new Date(p.pricing_confirmed_at).getTime() +
          config.ceilings.pricingValidityHours * 3_600_000 >=
          now &&
        (request.kind === 'avatar_video'
          ? p.id === 'heygen' && p.minute_rate
          : request.kind === 'transcription'
            ? p.id === 'elevenlabs_stt' && p.minute_rate
            : request.kind === 'listening' || request.kind === 'assistant_speech'
              ? p.id === 'elevenlabs' && p.character_rate
              : ['openai', 'neuroapi'].includes(p.id) && p.input_rate && p.output_rate) &&
        (request.kind !== 'adaptive_exercise' ||
          config.controls.strategy === 'cheapest' ||
          p.id === config.controls.strategy),
    );
    const outputBound =
      request.kind !== 'adaptive_exercise'
        ? 0
        : Math.min(config.controls.maxOutputTokens, config.ceilings.maxOutputTokens);
    const costOf = (p: ProviderRow) =>
      request.kind === 'avatar_video'
        ? videoCost(request.inputBound, p)
        : request.kind === 'transcription'
          ? videoCost(Math.max(60, request.inputBound), p)
          : request.kind === 'listening' || request.kind === 'assistant_speech'
            ? characterCost(request.inputBound, p)
            : tokenCost(request.inputBound, outputBound, p);
    const provider = valid.sort((a, b) => costOf(a) - costOf(b) || a.id.localeCompare(b.id))[0];
    if (!provider)
      throw new AppError(
        409,
        'PROVIDER_UNAVAILABLE',
        'Нет настроенного провайдера с действующей ценой.',
      );
    if (
      request.cacheKey &&
      (
        await tx.query("SELECT 1 FROM provider_requests WHERE cache_key=$1 AND status='reserved'", [
          request.cacheKey,
        ])
      ).rows.length
    )
      throw new AppError(
        409,
        'PROVIDER_IN_PROGRESS',
        'Озвучивание уже готовится. Повторите запрос через несколько секунд.',
      );
    const cost = costOf(provider),
      used = await spend(tx, now, userId);
    if (
      used.lifetimeMicros + cost > config.ceilings.lifetimeMicros ||
      used.dailyMicros + cost >
        Math.min(config.controls.dailyMicros, config.ceilings.dailyMicros) ||
      used.monthlyMicros + cost >
        Math.min(config.controls.monthlyMicros, config.ceilings.monthlyMicros) ||
      used.perUserDailyMicros + cost >
        Math.min(config.controls.perUserDailyMicros, config.ceilings.perUserDailyMicros) ||
      used.userCalls >=
        Math.min(config.controls.requestsPerUserDay, config.ceilings.requestsPerUserDay)
    )
      throw new AppError(409, 'PROVIDER_BUDGET_LIMIT', 'Лимит внешних сервисов исчерпан.');
    if (used.pending >= Math.min(config.controls.maxConcurrent, config.ceilings.maxConcurrent))
      throw new AppError(409, 'PROVIDER_IN_PROGRESS', 'Сервисы заняты. Повторите позже.');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO provider_requests (id,resource_key,cache_key,kind,user_id,requested_by,assignment_id,provider,model,rates,reserved_micros,charged_micros,input_units,output_units,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14)',
      [
        id,
        request.resourceKey,
        request.cacheKey ?? null,
        request.kind,
        userId,
        actor.user.id,
        request.assignmentId ?? null,
        provider.id,
        provider.model,
        JSON.stringify({
          input: provider.input_rate,
          output: provider.output_rate,
          character: provider.character_rate,
          minute: provider.minute_rate,
        }),
        cost,
        request.inputBound,
        outputBound,
        new Date(now),
      ],
    );
    const withListening =
      config.controls.withListening &&
      config.controls.listeningEnabled &&
      config.controls.maxTtsCharacters > 0 &&
      rows.some(
        (p) =>
          p.id === 'elevenlabs' &&
          p.enabled &&
          p.character_rate &&
          this.settings.credential(p) &&
          p.pricing_confirmed_at &&
          new Date(p.pricing_confirmed_at).getTime() +
            config.ceilings.pricingValidityHours * 3_600_000 >=
            now,
      );
    return {
      reservation: {
        id,
        provider,
        credential: this.settings.credential(provider),
        cost,
        inputBound: request.inputBound,
        outputBound,
        withListening,
      } satisfies Reservation,
    };
  }
  async settle(
    tx: QueryExecutor,
    r: Reservation,
    actual: { input: number; output: number; resultId?: string } | null,
    errorCode?: string,
  ) {
    const cost = actual
      ? r.provider.id === 'heygen' || r.provider.id === 'elevenlabs_stt'
        ? videoCost(
            r.provider.id === 'elevenlabs_stt' ? Math.max(60, actual.input) : actual.input,
            r.provider,
          )
        : r.provider.id === 'elevenlabs'
          ? characterCost(actual.input, r.provider)
          : tokenCost(actual.input, actual.output, r.provider)
      : r.cost;
    const overrun =
      cost > r.cost || (actual && (actual.input > r.inputBound || actual.output > r.outputBound));
    await tx.query(
      "UPDATE provider_requests SET status=$2,charged_micros=$3,input_units=$4,output_units=$5,result_id=$6,error_code=$7,completed_at=$8 WHERE id=$1 AND status='reserved'",
      [
        r.id,
        overrun ? 'overrun' : actual ? 'success' : 'unknown',
        cost,
        actual?.input ?? r.inputBound,
        actual?.output ?? r.outputBound,
        actual?.resultId ?? null,
        overrun ? 'USAGE_EXCEEDED' : (errorCode ?? null),
        new Date(this.settings.now()),
      ],
    );
    if (overrun) {
      await tx.query(
        "UPDATE ai_configuration SET controls=jsonb_set(jsonb_set(jsonb_set(controls,'{enabled}','false'),'{listeningEnabled}','false'),'{withListening}','false'),revision=revision+1 WHERE id=1",
      );
      await tx.query(
        "UPDATE ai_configuration SET controls=jsonb_set(controls,'{videoEnabled}','false') WHERE id=1",
      );
      await tx.query(
        "UPDATE ai_configuration SET controls=jsonb_set(jsonb_set(controls,'{transcriptionEnabled}','false'),'{assistantSpeechEnabled}','false') WHERE id=1",
      );
      await tx.query(
        'UPDATE external_providers SET enabled=false,revision=revision+1 WHERE id=$1',
        [r.provider.id],
      );
    }
  }
}
