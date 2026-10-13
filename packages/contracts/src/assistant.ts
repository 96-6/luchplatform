import { z } from 'zod';
import { exerciseViewSchema, contentBlockSchema } from './content.js';
import { evaluationSchema, answerSchema } from './engine.js';

export const avatarIdSchema = z.enum(['mentor', 'partner', 'guide']);
export const assistantPreferencesSchema = z.strictObject({
  avatarId: avatarIdSchema.default('mentor'),
  voiceAvatarId: avatarIdSchema.default('mentor'),
  address: z.enum(['informal', 'formal']).default('formal'),
  pace: z.enum(['slow', 'normal', 'fast']).default('normal'),
  detail: z.enum(['brief', 'detailed']).default('brief'),
  animation: z.boolean().default(true),
});
export const avatarSchema = z.object({
  id: avatarIdSchema,
  name: z.string(),
  style: z.string(),
  description: z.string(),
  image: z.string().startsWith('/avatars/'),
});
export const assistantProfileSchema = z.object({
  userId: z.uuid(),
  revision: z.number().int().nonnegative(),
  preferences: assistantPreferencesSchema,
  recommendedAvatarId: avatarIdSchema,
  avatars: z.array(avatarSchema),
  writable: z.boolean(),
});
export const saveAssistantProfileSchema = z.strictObject({
  userId: z.uuid().optional(),
  revision: z.number().int().nonnegative(),
  preferences: assistantPreferencesSchema,
});
export const assistantActionSchema = z.enum(['explain', 'hint', 'dialogue']);
export const assistantContextSchema = z.object({
  runId: z.uuid(),
  stepId: z.uuid(),
  turnId: z.uuid(),
  packageId: z.string(),
  packageVersion: z.number().int(),
  generatedExerciseId: z.uuid().nullable(),
  purpose: z.enum(['practice', 'diagnostic', 'control']),
  exercise: exerciseViewSchema,
  material: z.array(contentBlockSchema),
  lastAttempt: z
    .object({ id: z.uuid(), answer: answerSchema, evaluation: evaluationSchema.nullable() })
    .nullable(),
  goal: z.string().nullable(),
});
export const assistantMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  action: assistantActionSchema,
  avatarId: avatarIdSchema,
  stepId: z.uuid(),
  turnId: z.uuid(),
  createdAt: z.iso.datetime(),
  actorId: z.uuid(),
  context: assistantContextSchema.nullable().default(null),
});
export const assistantChatSchema = z.object({
  label: z.literal('Демо-помощник'),
  runId: z.uuid(),
  title: z.string(),
  writable: z.boolean(),
  hintsEnabled: z.boolean(),
  messages: z.array(assistantMessageSchema),
  nextBefore: z.number().int().positive().nullable(),
  context: assistantContextSchema.nullable(),
});
export const sendAssistantMessageSchema = z.strictObject({
  operationId: z.uuid(),
  turnId: z.uuid(),
  action: assistantActionSchema,
  text: z.string().trim().max(1000).default(''),
});
const providerIdentifier = z.string().regex(/^[a-zA-Z0-9_-]{0,100}$/);
export const avatarBindingSchema = z.strictObject({
  id: avatarIdSchema,
  avatarId: providerIdentifier,
  voiceRu: providerIdentifier,
  voiceEn: providerIdentifier,
});
export const avatarBindingsSchema = z.object({
  revision: z.number().int().positive(),
  items: z.array(avatarBindingSchema),
});
export const updateAvatarBindingsSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    items: z.array(avatarBindingSchema).length(3),
  })
  .refine((d) => new Set(d.items.map((x) => x.id)).size === 3, 'Укажите три разных персонажа.');
export const assistantVideoSchema = z.object({
  status: z.enum(['pending', 'ready', 'error']),
  url: z.string().startsWith('/api/v1/assistant/').nullable(),
  cached: z.boolean(),
  message: z.string().nullable(),
});
export type AssistantPreferences = z.infer<typeof assistantPreferencesSchema>;
export type AssistantContext = z.infer<typeof assistantContextSchema>;
export type AssistantAction = z.infer<typeof assistantActionSchema>;
