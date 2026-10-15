import { z } from 'zod';
import { userSchema } from './accounts.js';
import { diagnosticSummarySchema, studentProfileSchema } from './diagnostics.js';
import { runSummarySchema } from './engine.js';
import { planAssignmentSchema, planSummarySchema } from './plans.js';

export const dashboardQuerySchema = z.strictObject({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .default('UTC')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Неизвестный часовой пояс.'),
});
export const dashboardAssignmentSchema = planAssignmentSchema
  .pick({
    id: true,
    title: true,
    kind: true,
    purpose: true,
    dueAt: true,
    canStart: true,
    recommendedDay: true,
    estimatedMinutes: true,
    status: true,
    runId: true,
    completedSteps: true,
  })
  .extend({
    planId: z.uuid(),
    reason: z.string(),
    totalSteps: z.number().int().positive(),
  });
const count = z.number().int().nonnegative();
export const studentDashboardSchema = z.object({
  user: userSchema,
  profile: studentProfileSchema.nullable(),
  asOf: z.iso.datetime(),
  timeZone: z.string(),
  recommendedDay: z.number().int().positive().nullable(),
  plan: planSummarySchema.nullable(),
  profileChangedSincePlan: z.boolean(),
  diagnostic: diagnosticSummarySchema.nullable(),
  continueRun: runSummarySchema.nullable(),
  nextAssignment: dashboardAssignmentSchema.nullable(),
  today: z.array(dashboardAssignmentSchema),
  reviews: z.array(dashboardAssignmentSchema),
  progress: z.object({
    completedLessons: count,
    evaluatedAttempts: count,
    independentCorrect: count,
    assistedCorrect: count,
    incorrectAttempts: count,
    pendingEvaluationAttempts: count,
    teacherReviewedAttempts: count.default(0),
  }),
  recentResults: z.array(
    z.object({
      id: z.uuid(),
      runId: z.uuid(),
      title: z.string(),
      purpose: z.enum(['practice', 'diagnostic', 'control']),
      correct: z.boolean().nullable(),
      independent: z.boolean().nullable(),
      evaluatedAt: z.iso.datetime(),
      teacherReviewed: z.boolean().default(false),
    }),
  ),
});
export type StudentDashboard = z.infer<typeof studentDashboardSchema>;
export type DashboardAssignment = z.infer<typeof dashboardAssignmentSchema>;
