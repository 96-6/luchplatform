import { z } from 'zod';
export const providerIdSchema = z.enum([
  'openai',
  'neuroapi',
  'elevenlabs',
  'elevenlabs_stt',
  'heygen',
]);
const money = z.number().int().min(0).max(1_000_000_000_000);
const accountedMoney = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rate = money.refine((v) => v > 0, 'Цена должна быть положительной.');
export const aiCeilingsSchema = z.strictObject({
  lifetimeMicros: money.default(0),
  dailyMicros: money.default(0),
  monthlyMicros: money.default(0),
  perUserDailyMicros: money.default(0),
  requestsPerUserDay: z.number().int().min(0).max(1000).default(0),
  maxOutputTokens: z.number().int().min(128).max(4096).default(1024),
  maxVideoSeconds: z.number().int().min(0).max(300).default(0),
  maxVideoCharacters: z.number().int().min(0).max(1200).default(0),
  maxRecordingSeconds: z.number().int().min(0).max(30).default(0),
  maxTtsCharacters: z.number().int().min(0).max(3000).default(0),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  pricingValidityHours: z.number().int().min(1).max(168).default(24),
});
export const aiControlsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  listeningEnabled: z.boolean().default(false),
  transcriptionEnabled: z.boolean().default(false),
  assistantSpeechEnabled: z.boolean().default(false),
  videoEnabled: z.boolean().default(false),
  strategy: z.enum(['cheapest', 'openai', 'neuroapi']).default('cheapest'),
  withListening: z.boolean().default(false),
  dailyMicros: money.default(0),
  monthlyMicros: money.default(0),
  perUserDailyMicros: money.default(0),
  requestsPerUserDay: z.number().int().min(0).max(1000).default(0),
  maxOutputTokens: z.number().int().min(128).max(4096).default(1024),
  maxVideoSeconds: z.number().int().min(0).max(300).default(0),
  maxVideoCharacters: z.number().int().min(0).max(1200).default(0),
  maxRecordingSeconds: z.number().int().min(0).max(30).default(0),
  maxTtsCharacters: z.number().int().min(0).max(3000).default(0),
  maxConcurrent: z.number().int().min(1).max(10).default(2),
  reviewDelayHours: z.number().int().min(24).max(336).default(48),
});
export const providerViewSchema = z.object({
  id: providerIdSchema,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  model: z.string(),
  voiceRu: z.string(),
  voiceEn: z.string(),
  inputRate: money.nullable(),
  outputRate: money.nullable(),
  characterRate: money.nullable(),
  minuteRate: money.nullable().default(null),
  pricingConfirmedAt: z.iso.datetime().nullable(),
  keyConfigured: z.boolean(),
  keySource: z.enum(['database', 'environment', 'none']),
});
export const providerSettingsSchema = z.object({
  revision: z.number().int().positive(),
  ceilings: aiCeilingsSchema,
  controls: aiControlsSchema,
  canManageSecrets: z.boolean(),
  providers: z.array(providerViewSchema),
  spend: z.object({
    lifetimeMicros: accountedMoney,
    dailyMicros: accountedMoney,
    monthlyMicros: accountedMoney,
    pending: z.number().int().nonnegative(),
  }),
});
export const updateAiControlsSchema = z.strictObject({
  revision: z.number().int().positive(),
  controls: aiControlsSchema,
});
export const updateAiCeilingsSchema = z.strictObject({
  revision: z.number().int().positive(),
  ceilings: aiCeilingsSchema,
});
export const updateProviderSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/),
    voiceRu: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{0,100}$/)
      .default(''),
    voiceEn: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{0,100}$/)
      .default(''),
    inputRate: rate.nullable(),
    outputRate: rate.nullable(),
    characterRate: rate.nullable(),
    minuteRate: rate.nullable().default(null),
    confirmPricing: z.boolean(),
    apiKey: z
      .string()
      .trim()
      .regex(/^[!-~]{8,512}$/)
      .optional(),
    clearKey: z.boolean().default(false),
  })
  .refine((d) => !(d.apiKey && d.clearKey), 'Выберите замену или удаление ключа.');
export const providerRequestSchema = z.object({
  id: z.uuid(),
  kind: z.enum([
    'adaptive_exercise',
    'listening',
    'avatar_video',
    'transcription',
    'assistant_speech',
  ]),
  provider: providerIdSchema,
  model: z.string(),
  status: z.enum(['reserved', 'success', 'failed', 'unknown', 'overrun']),
  reservedMicros: accountedMoney,
  chargedMicros: accountedMoney,
  inputUnits: z.number().int().nonnegative(),
  outputUnits: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  errorCode: z.string().nullable(),
});
export const providerRequestsSchema = z.object({ items: z.array(providerRequestSchema) });
export const listeningRequestSchema = z.strictObject({ operationId: z.uuid() });
export const listeningResultSchema = z.object({
  url: z.string().startsWith('/api/v1/engine/runs/'),
  cached: z.boolean(),
});
export type AiCeilings = z.infer<typeof aiCeilingsSchema>;
export type AiControls = z.infer<typeof aiControlsSchema>;
export type ProviderId = z.infer<typeof providerIdSchema>;
