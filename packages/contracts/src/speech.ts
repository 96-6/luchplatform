import { z } from 'zod';
import { contentIdSchema } from './content.js';
import { runViewSchema } from './engine.js';
export const SPEECH_MAX_SECONDS = 30;
export const SPEECH_MAX_WAV_BYTES = 960044;
export const speechUploadSchema = z.strictObject({
  turnId: z.uuid(),
  operationId: z.uuid(),
  audioBase64: z.string().min(1).max(1280060),
});
export const speechRetrySchema = z.strictObject({ operationId: z.uuid() });
export const speechConfirmSchema = z.strictObject({
  operationId: z.uuid(),
  text: z.string().trim().min(1).max(1000),
  optionId: contentIdSchema.optional(),
});
export const speechTextSchema = speechConfirmSchema.extend({ turnId: z.uuid() });
export const speechInputSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  turnId: z.uuid(),
  source: z.enum(['voice', 'text']),
  status: z.enum(['processing', 'ready', 'error', 'discarded', 'confirmed']),
  transcript: z.string().nullable(),
  confirmedText: z.string().nullable(),
  optionId: contentIdSchema.nullable(),
  durationMilliseconds: z.number().int().nonnegative(),
  edited: z.boolean(),
  canRetry: z.boolean(),
  attemptId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  reply: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const speechSessionSchema = z.object({
  runId: z.uuid(),
  turnId: z.uuid().nullable(),
  writable: z.boolean(),
  enabled: z.boolean(),
  ttsEnabled: z.boolean(),
  maxSeconds: z.number().int().min(0).max(SPEECH_MAX_SECONDS),
  input: speechInputSchema.nullable(),
});
export const speechConfirmationSchema = z.object({
  input: speechInputSchema,
  view: runViewSchema,
  assignment: z
    .object({
      id: z.uuid(),
      planId: z.uuid(),
      title: z.string(),
      kind: z.enum(['initial', 'correction', 'supported_practice', 'review']),
      dueAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export const assistantSpeechSchema = z.object({
  url: z.string().startsWith('/api/v1/assistant/messages/'),
  cached: z.boolean(),
});
export type SpeechInput = z.infer<typeof speechInputSchema>;
