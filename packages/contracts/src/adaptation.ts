import { z } from 'zod';
import { contentIdSchema } from './content.js';
export const ADAPTATION_VERSION = '1.0.0';
export const learningOutcomeSchema = z.enum([
  'mistake',
  'independent_success',
  'hinted_success',
  'assisted_success',
]);
export const skillStateSchema = z.object({
  packageId: contentIdSchema,
  packageVersion: z.number().int().positive(),
  skillId: contentIdSchema,
  title: z.string(),
  description: z.string(),
  attempts: z.number().int().nonnegative(),
  independentSuccesses: z.number().int().nonnegative(),
  hintedSuccesses: z.number().int().nonnegative(),
  assistedSuccesses: z.number().int().nonnegative(),
  mistakes: z.number().int().nonnegative(),
  diagnosticAttempts: z.number().int().nonnegative(),
  controlAttempts: z.number().int().nonnegative(),
  independentStreak: z.number().int().nonnegative(),
  status: z.enum(['learning', 'needs_practice', 'supported', 'demonstrated', 'confirmed']),
  lastOutcome: learningOutcomeSchema,
  lastAttemptId: z.uuid(),
  lastObservedAt: z.iso.datetime(),
  lastIndependentAt: z.iso.datetime().nullable(),
  lastReviewAt: z.iso.datetime().nullable(),
});
export const skillStatesSchema = z.object({ userId: z.uuid(), items: z.array(skillStateSchema) });
export const planChangeSchema = z.object({
  id: z.uuid(),
  attemptId: z.uuid(),
  assignmentId: z.uuid().nullable(),
  action: z.enum([
    'correction_added',
    'correction_reused',
    'supported_practice_added',
    'supported_practice_reused',
    'review_scheduled',
    'review_reused',
    'next_step_ready',
    'review_confirmed',
    'bank_unavailable',
  ]),
  skillId: contentIdSchema,
  skillName: z.string(),
  outcome: learningOutcomeSchema,
  reason: z.string(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
});
export const planChangesQuerySchema = z
  .object({
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (q) => Boolean(q.beforeCreatedAt) === Boolean(q.beforeId),
    'Cursor fields are required together.',
  );
export const planChangesPageSchema = z.object({
  items: z.array(planChangeSchema),
  nextCursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable(),
});
export const startAssignmentSchema = z.strictObject({});
export type LearningOutcome = z.infer<typeof learningOutcomeSchema>;
