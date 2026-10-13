import { z } from 'zod';
import { userSchema } from './accounts.js';
import { integrityAssessmentSchema } from './integrity.js';
import {
  assetSchema,
  contentBlockSchema,
  contentIdSchema,
  exercisePurposeSchema,
  exerciseSchema,
  exerciseViewSchema,
  responseSchema,
} from './content.js';

export const ENGINE_VERSION = '1.0.0';
export const ENGINE_IDLE_MS = 30_000;
export const answerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), optionId: contentIdSchema }),
  z.strictObject({
    type: z.literal('short_text'),
    text: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0, 'Введите ответ.'),
  }),
]);
export const draftAnswerSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('choice'), optionId: contentIdSchema }),
    z.strictObject({ type: z.literal('short_text'), text: z.string().max(1000) }),
  ])
  .nullable();
export const startRunSchema = z.strictObject({
  packageId: contentIdSchema,
  packageVersion: z.number().int().min(1).max(1_000_000).optional(),
  source: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('lesson'),
      id: contentIdSchema,
      purpose: exercisePurposeSchema.default('practice'),
    }),
    z.strictObject({ type: z.literal('set'), id: contentIdSchema }),
  ]),
  userId: z.uuid().optional(),
  restart: z.boolean().default(false),
});
export const turnActionSchema = z.strictObject({ turnId: z.uuid() });
export const saveDraftSchema = z.strictObject({
  turnId: z.uuid(),
  draftAnswer: draftAnswerSchema,
  paused: z.boolean().default(false),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const hintRequestSchema = z.strictObject({
  turnId: z.uuid(),
  index: z.number().int().min(0).max(9),
});
export const submitAnswerSchema = z.strictObject({
  turnId: z.uuid(),
  operationId: z.uuid(),
  answer: answerSchema,
});
export const usedHintSchema = z.object({
  index: z.number().int(),
  text: z.string(),
  usedAt: z.iso.datetime(),
  usedBy: z.uuid(),
});
const milliseconds = z.number().int().nonnegative();
export const evaluationSchema = z.object({
  correct: z.boolean(),
  score: z.number().int(),
  maxScore: z.literal(1),
  source: z.literal('luch-engine'),
  engineVersion: z.string(),
  rubricId: contentIdSchema,
  rubricVersion: z.number().int().positive(),
  explanation: z.string(),
});
export const attemptSchema = z.object({
  id: z.uuid(),
  stepId: z.uuid(),
  turnId: z.uuid(),
  operationId: z.uuid(),
  number: z.number().int().positive(),
  exerciseId: contentIdSchema,
  exerciseVersion: z.number().int().positive(),
  skillId: contentIdSchema,
  instruction: z.string(),
  response: responseSchema,
  submittedBy: z.uuid(),
  submittedFor: z.uuid(),
  adminAssistance: z.boolean(),
  answer: answerSchema,
  evaluation: evaluationSchema.nullable(),
  usedHints: z.array(usedHintSchema),
  hadPriorFeedback: z.boolean(),
  independent: z.boolean(),
  activeMilliseconds: milliseconds,
  elapsedMilliseconds: milliseconds,
  startedAt: z.iso.datetime(),
  evaluatedAt: z.iso.datetime(),
  integrity: integrityAssessmentSchema.nullable(),
});
export const runSummarySchema = z.object({
  id: z.uuid(),
  diagnosticId: z.uuid().nullable(),
  planIds: z.array(z.uuid()),
  user: userSchema.pick({ id: true, name: true, email: true, role: true }),
  packageId: contentIdSchema,
  packageVersion: z.number().int().positive(),
  routeId: contentIdSchema,
  sourceType: z.enum(['lesson', 'set']),
  sourceId: contentIdSchema,
  title: z.string(),
  purpose: exercisePurposeSchema,
  isDemo: z.boolean(),
  status: z.enum(['active', 'completed']),
  cycle: z.number().int().positive(),
  currentPosition: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  completedSteps: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export const engineTurnSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  draftAnswer: draftAnswerSchema,
  draftRevision: z.number().int().nonnegative(),
  adminAssistance: z.boolean(),
  hadPriorFeedback: z.boolean(),
  usedHints: z.array(usedHintSchema),
  paused: z.boolean(),
  activeMilliseconds: milliseconds,
  startedAt: z.iso.datetime(),
  lastSavedAt: z.iso.datetime(),
});
export const runViewSchema = z.object({
  run: runSummarySchema,
  integrityEnabled: z.boolean(),
  writable: z.boolean(),
  current: z
    .object({
      stepId: z.uuid(),
      position: z.number().int(),
      exercise: exerciseViewSchema,
      turn: engineTurnSchema,
      hintsRemaining: z.number().int().nonnegative(),
      attempt: attemptSchema.nullable(),
    })
    .nullable(),
  material: z.array(contentBlockSchema),
  assets: z.array(assetSchema),
  attempts: z.array(attemptSchema),
  debug: z
    .array(
      z.object({
        stepId: z.uuid(),
        position: z.number().int(),
        exercise: exerciseSchema,
        turns: z.array(
          engineTurnSchema.extend({ state: z.enum(['open', 'answered']), createdBy: z.uuid() }),
        ),
        integrity: z.array(integrityAssessmentSchema),
      }),
    )
    .nullable(),
});
export const submitResultSchema = z.object({ attempt: attemptSchema, view: runViewSchema });
export const runCursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
export const runsPageSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: runCursorSchema.nullable(),
});
export const runsQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (query) => Boolean(query.beforeCreatedAt) === Boolean(query.beforeId),
    'Cursor fields are required together.',
  );
export type Answer = z.infer<typeof answerSchema>;
export type DraftAnswer = z.infer<typeof draftAnswerSchema>;
export type EngineAttempt = z.infer<typeof attemptSchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type StartRun = z.infer<typeof startRunSchema>;
export type UsedHint = z.infer<typeof usedHintSchema>;
