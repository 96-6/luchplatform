import {
  aiCeilingsSchema,
  aiControlsSchema,
  providerRequestSchema,
  type AiCeilings,
  type AiControls,
  type ProviderId,
  type updateAiCeilingsSchema,
  type updateAiControlsSchema,
  type updateProviderSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import type { Settings } from '../../config.js';
import { AppError } from '../../errors.js';
import { AccountCrypto } from '../auth/crypto.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';

export type ProviderRow = {
  id: ProviderId;
  revision: number;
  enabled: boolean;
  credential_ciphertext: string | null;
  key_disabled: boolean;
  model: string;
  voice_ru: string;
  voice_en: string;
  input_rate: string | null;
  output_rate: string | null;
  character_rate: string | null;
  pricing_confirmed_at: Date | string | null;
};
export type Configuration = { revision: number; ceilings: AiCeilings; controls: AiControls };
const settingChanged = () =>
  new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
export function requireOperator(actor: Actor, root = false) {
  if (actor.user.role !== 'superadmin' && (root || actor.user.role !== 'admin'))
    throw new AppError(403, 'ACCESS_DENIED', 'Настройки доступны администратору.');
}
export async function configuration(tx: QueryExecutor, lock = false): Promise<Configuration> {
  const row = (
    await tx.query<{ revision: number; ceilings: unknown; controls: unknown }>(
      `SELECT * FROM ai_configuration WHERE id=1 ${lock ? 'FOR UPDATE' : ''}`,
    )
  ).rows[0]!;
  return {
    revision: row.revision,
    ceilings: aiCeilingsSchema.parse(row.ceilings),
    controls: aiControlsSchema.parse(row.controls),
  };
}
const limited = [
  'dailyMicros',
  'monthlyMicros',
  'perUserDailyMicros',
  'requestsPerUserDay',
  'maxOutputTokens',
  'maxTtsCharacters',
  'maxConcurrent',
] as const;
export function validateControls(ceilings: AiCeilings, controls: AiControls) {
  if (limited.some((k) => controls[k] > ceilings[k]))
    throw new AppError(400, 'LIMIT_EXCEEDED', 'Параметры превышают ограничения суперадмина.');
  if (controls.withListening && !controls.listeningEnabled)
    throw new AppError(400, 'LISTENING_DISABLED', 'Для listening-вариантов включите озвучивание.');
}
export async function spend(tx: QueryExecutor, now: number, userId?: string) {
  const row = (
    await tx.query<{
      lifetime: string;
      daily: string;
      monthly: string;
      user_daily: string;
      user_calls: string;
      pending: string;
    }>(
      `SELECT COALESCE(sum(charged_micros),0)::text AS lifetime,
      COALESCE(sum(charged_micros) FILTER (WHERE created_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS daily,
      COALESCE(sum(charged_micros) FILTER (WHERE created_at>=date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS monthly,
      COALESCE(sum(charged_micros) FILTER (WHERE user_id=$2::uuid AND created_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text AS user_daily,
      count(*) FILTER (WHERE user_id=$2::uuid AND created_at>=date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS user_calls,
      count(*) FILTER (WHERE status='reserved')::text AS pending FROM provider_requests`,
      [new Date(now), userId ?? null],
    )
  ).rows[0]!;
  return {
    lifetimeMicros: Number(row.lifetime),
    dailyMicros: Number(row.daily),
    monthlyMicros: Number(row.monthly),
    perUserDailyMicros: Number(row.user_daily),
    userCalls: Number(row.user_calls),
    pending: Number(row.pending),
  };
}
export class ProviderSettingsService {
  constructor(
    readonly db: Database,
    readonly crypto: AccountCrypto,
    readonly environment: Pick<
      Settings,
      'OPENAI_API_KEY' | 'NEUROAPI_API_KEY' | 'ELEVENLABS_API_KEY'
    >,
    readonly now: () => number = Date.now,
  ) {}
  environmentKey(id: ProviderId) {
    return id === 'openai'
      ? this.environment.OPENAI_API_KEY
      : id === 'neuroapi'
        ? this.environment.NEUROAPI_API_KEY
        : this.environment.ELEVENLABS_API_KEY;
  }
  credential(row: ProviderRow) {
    return row.key_disabled
      ? ''
      : row.credential_ciphertext
        ? this.crypto.decrypt(row.credential_ciphertext)
        : this.environmentKey(row.id);
  }
  viewProvider(row: ProviderRow) {
    const configured = Boolean(this.credential(row));
    return {
      id: row.id,
      revision: row.revision,
      enabled: row.enabled,
      model: row.model,
      voiceRu: row.voice_ru,
      voiceEn: row.voice_en,
      inputRate: row.input_rate ? Number(row.input_rate) : null,
      outputRate: row.output_rate ? Number(row.output_rate) : null,
      characterRate: row.character_rate ? Number(row.character_rate) : null,
      pricingConfirmedAt: row.pricing_confirmed_at
        ? new Date(row.pricing_confirmed_at).toISOString()
        : null,
      keyConfigured: configured,
      keySource: configured
        ? row.credential_ciphertext
          ? ('database' as const)
          : ('environment' as const)
        : ('none' as const),
    };
  }
  async read(actor: Actor) {
    requireOperator(actor);
    return this.db.transaction(async (tx) => {
      const config = await configuration(tx),
        providers = (await tx.query<ProviderRow>('SELECT * FROM external_providers ORDER BY id'))
          .rows;
      return {
        ...config,
        providers: providers.map((p) => this.viewProvider(p)),
        canManageSecrets: actor.user.role === 'superadmin',
        spend: await spend(tx, this.now()),
      };
    });
  }
  async updateControls(actor: Actor, input: z.infer<typeof updateAiControlsSchema>) {
    requireOperator(actor);
    await this.db.transaction(async (tx) => {
      const current = await configuration(tx, true);
      if (current.revision !== input.revision) throw settingChanged();
      validateControls(current.ceilings, input.controls);
      await tx.query(
        'UPDATE ai_configuration SET controls=$2,revision=revision+1,updated_by=$3,updated_at=$4 WHERE id=1 AND revision=$1',
        [input.revision, JSON.stringify(input.controls), actor.user.id, new Date(this.now())],
      );
      await tx.query('UPDATE adaptive_policy SET review_delay_hours=$1 WHERE id=1', [
        input.controls.reviewDelayHours,
      ]);
      await audit(tx, actor.user.id, 'providers.controls_changed');
    });
    return this.read(actor);
  }
  async updateCeilings(actor: Actor, input: z.infer<typeof updateAiCeilingsSchema>) {
    requireOperator(actor, true);
    await this.db.transaction(async (tx) => {
      const current = await configuration(tx, true);
      if (current.revision !== input.revision) throw settingChanged();
      const controls = { ...current.controls };
      for (const key of limited) controls[key] = Math.min(controls[key], input.ceilings[key]);
      if (!input.ceilings.maxTtsCharacters) {
        controls.listeningEnabled = false;
        controls.withListening = false;
      }
      if (!input.ceilings.lifetimeMicros) {
        controls.enabled = false;
        controls.listeningEnabled = false;
        controls.withListening = false;
      }
      await tx.query(
        'UPDATE ai_configuration SET ceilings=$2,controls=$3,revision=revision+1,updated_by=$4,updated_at=$5 WHERE id=1 AND revision=$1',
        [
          input.revision,
          JSON.stringify(input.ceilings),
          JSON.stringify(controls),
          actor.user.id,
          new Date(this.now()),
        ],
      );
      await audit(tx, actor.user.id, 'providers.ceilings_changed');
    });
    return this.read(actor);
  }
  async updateProvider(actor: Actor, id: ProviderId, input: z.infer<typeof updateProviderSchema>) {
    requireOperator(actor, true);
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.query<ProviderRow>('SELECT * FROM external_providers WHERE id=$1 FOR UPDATE', [id])
      ).rows[0]!;
      if (row.revision !== input.revision) throw settingChanged();
      const secret = input.clearKey
        ? null
        : input.apiKey
          ? this.crypto.encrypt(input.apiKey)
          : row.credential_ciphertext;
      const disabled = input.clearKey ? true : input.apiKey ? false : row.key_disabled;
      const ratesChanged =
        row.model !== input.model ||
        Number(row.input_rate) !== Number(input.inputRate) ||
        Number(row.output_rate) !== Number(input.outputRate) ||
        Number(row.character_rate) !== Number(input.characterRate);
      const confirmed = input.confirmPricing
        ? new Date(this.now())
        : ratesChanged
          ? null
          : row.pricing_confirmed_at;
      if (
        input.enabled &&
        (!confirmed ||
          (id === 'elevenlabs'
            ? !input.characterRate || !input.voiceRu || !input.voiceEn
            : !input.inputRate || !input.outputRate))
      )
        throw new AppError(
          400,
          'PROVIDER_INCOMPLETE',
          'Укажите и подтвердите цены; для ElevenLabs нужны голоса обоих языков.',
        );
      if (
        input.enabled &&
        !this.credential({ ...row, credential_ciphertext: secret, key_disabled: disabled })
      )
        throw new AppError(400, 'PROVIDER_KEY_REQUIRED', 'Сначала задайте ключ провайдера.');
      await tx.query(
        'UPDATE external_providers SET revision=revision+1,enabled=$2,model=$3,voice_ru=$4,voice_en=$5,input_rate=$6,output_rate=$7,character_rate=$8,pricing_confirmed_at=$9,credential_ciphertext=$10,key_disabled=$11,updated_by=$12,updated_at=$13 WHERE id=$1',
        [
          id,
          input.enabled,
          input.model,
          input.voiceRu,
          input.voiceEn,
          input.inputRate,
          input.outputRate,
          input.characterRate,
          confirmed,
          secret,
          disabled,
          actor.user.id,
          new Date(this.now()),
        ],
      );
      await audit(tx, actor.user.id, 'providers.connection_changed');
    });
    return this.read(actor);
  }
  async requests(actor: Actor) {
    requireOperator(actor);
    const rows = (
      await this.db.query<{
        id: string;
        kind: string;
        provider: string;
        model: string;
        status: string;
        reserved_micros: string;
        charged_micros: string;
        input_units: number;
        output_units: number;
        created_at: Date | string;
        error_code: string | null;
      }>('SELECT * FROM provider_requests ORDER BY created_at DESC,id DESC LIMIT 100')
    ).rows;
    return {
      items: rows.map((r) =>
        providerRequestSchema.parse({
          id: r.id,
          kind: r.kind,
          provider: r.provider,
          model: r.model,
          status: r.status,
          reservedMicros: Number(r.reserved_micros),
          chargedMicros: Number(r.charged_micros),
          inputUnits: r.input_units,
          outputUnits: r.output_units,
          createdAt: new Date(r.created_at).toISOString(),
          errorCode: r.error_code,
        }),
      ),
    };
  }
}
