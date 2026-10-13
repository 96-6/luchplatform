import { z } from 'zod';
import { contentIdSchema } from './content.js';
import { userSchema } from './accounts.js';
import { diagnosticsQuerySchema, learningGoalSchema, questionnaireSchema } from './diagnostics.js';

export const PLAN_RULES_VERSION = '1.0.0';
export const assignmentReasonSchema = z.object({
  kind: z.enum([
    'diagnostic_gap',
    'guided_success',
    'goal_priority',
    'route_step',
    'typical_error',
    'guided_practice',
    'delayed_check',
  ]),
  text: z.string().min(1),
  goal: learningGoalSchema,
  goalMatched: z.boolean(),
  sourceAttemptId: z.uuid().optional(),
  skills: z.array(
    z.object({
      skillId: contentIdSchema,
      name: z.string(),
      correct: z.number().int().nonnegative(),
      questions: z.number().int().positive(),
      independentCorrect: z.number().int().nonnegative(),
    }),
  ),
});
export const planAssignmentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['initial', 'correction', 'supported_practice', 'review']),
  purpose: z.enum(['practice', 'control']),
  dueAt: z.iso.datetime().nullable(),
  canStart: z.boolean(),
  position: z.number().int().nonnegative(),
  recommendedDay: z.number().int().positive(),
  lessonId: contentIdSchema,
  title: z.string(),
  estimatedMinutes: z.number().int().positive(),
  reason: assignmentReasonSchema,
  exercises: z
    .array(
      z.object({
        id: contentIdSchema,
        version: z.number().int().positive(),
        generatedExerciseId: z.uuid().nullable(),
      }),
    )
    .min(1),
  status: z.enum(['pending', 'active', 'completed']),
  runId: z.uuid().nullable(),
  completedSteps: z.number().int().nonnegative(),
  startedBy: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export const planSummarySchema = z.object({
  id: z.uuid(),
  diagnosticId: z.uuid(),
  user: userSchema.pick({ id: true, name: true, email: true }),
  profileRevision: z.number().int().positive(),
  questionnaire: questionnaireSchema,
  packageId: contentIdSchema,
  packageVersion: z.number().int().positive(),
  routeId: contentIdSchema,
  title: z.string(),
  isDemo: z.boolean(),
  rulesVersion: z.string(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  status: z.enum(['active', 'completed']),
  totalAssignments: z.number().int().positive(),
  completedAssignments: z.number().int().nonnegative(),
  recommendedDays: z.number().int().positive(),
  completedAt: z.iso.datetime().nullable(),
});
export const planViewSchema = z.object({
  plan: planSummarySchema,
  assignments: z.array(planAssignmentSchema).min(1),
  nextAssignmentId: z.uuid().nullable(),
  writable: z.boolean(),
});
export const createPlanSchema = z.strictObject({ diagnosticId: z.uuid() });
export const plansQuerySchema = diagnosticsQuerySchema.safeExtend({
  language: z.enum(['ru', 'en']).optional(),
});
export const plansPageSchema = z.object({
  user: userSchema.pick({ id: true, name: true, email: true }),
  items: z.array(planSummarySchema),
  nextCursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable(),
});
export type AssignmentReason = z.infer<typeof assignmentReasonSchema>;
export type PlanView = z.infer<typeof planViewSchema>;
