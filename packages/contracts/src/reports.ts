import { z } from 'zod';
import {
  questionnaireSchema,
  diagnosticSummarySchema,
  diagnosticResultSchema,
} from './diagnostics.js';
import { runSummarySchema } from './engine.js';
import { skillStateSchema, planChangeSchema } from './adaptation.js';
import { planSummarySchema } from './plans.js';
import { dashboardAssignmentSchema } from './dashboard.js';
import { teacherReviewSchema } from './reviews.js';
import { integrityAssessmentSchema } from './integrity.js';

const count = z.number().int().nonnegative();
const cursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable();
export const reportQuerySchema = z.strictObject({ language: z.enum(['ru', 'en']).optional() });
export const reportPageQuerySchema = z
  .strictObject({
    language: z.enum(['ru', 'en']),
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine(
    (q) => Boolean(q.beforeCreatedAt) === Boolean(q.beforeId),
    'Поля курсора требуются вместе.',
  );
export const reportCountsSchema = z.object({
  submittedAttempts: count,
  evaluatedAttempts: count,
  pendingEvaluationAttempts: count,
  independentAttempts: count,
  assistedAttempts: count,
  correctAttempts: count,
  incorrectAttempts: count,
  automaticIncorrectAttempts: count,
  independentCorrect: count,
  assistedCorrect: count,
  hintedCorrect: count,
  otherAssistedCorrect: count,
  teacherReviewedAttempts: count,
  teacherConfirmedAttempts: count,
  teacherCorrectedAttempts: count,
  activeMilliseconds: z.number().nonnegative(),
});
export const reportAttemptSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  runTitle: z.string(),
  purpose: z.enum(['practice', 'diagnostic', 'control']),
  skillId: z.string(),
  skillTitle: z.string(),
  instruction: z.string(),
  number: count,
  correct: z.boolean().nullable(),
  automaticCorrect: z.boolean().nullable(),
  independent: z.boolean().nullable(),
  help: z.array(z.enum(['hint', 'prior_feedback', 'assistant', 'administrator', 'other_actor'])),
  teacherReview: teacherReviewSchema.nullable(),
  evaluatedAt: z.iso.datetime(),
  activeMilliseconds: z.number().nonnegative(),
});
export const reportAttemptsPageSchema = z.object({
  items: z.array(reportAttemptSchema),
  nextCursor: cursor,
});
export const reportChangeSchema = planChangeSchema.extend({ planId: z.uuid() });
export const reportChangesPageSchema = z.object({
  items: z.array(reportChangeSchema),
  nextCursor: cursor,
});
export const reportSkillSchema = z.object({
  packageId: z.string(),
  packageVersion: z.number().int().positive(),
  skillId: z.string(),
  title: z.string(),
  description: z.string(),
  state: skillStateSchema.nullable(),
  counts: reportCountsSchema,
  awaitingObservationAttempts: count,
});
export const reportErrorSchema = z.object({
  packageId: z.string(),
  packageVersion: z.number().int().positive(),
  skillId: z.string(),
  title: z.string(),
  mistakes: count,
  exercises: count,
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  lastAttemptId: z.uuid(),
});
export const learningReportSchema = z.object({
  version: z.literal('1.0.0'),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  language: z.enum(['ru', 'en']),
  profile: questionnaireSchema.extend({ revision: count, updatedAt: z.iso.datetime() }).nullable(),
  updatedAt: z.iso.datetime().nullable(),
  counts: reportCountsSchema,
  completion: z.object({
    completedSteps: count,
    uniqueExercises: count,
    completedRuns: count,
    completedLessons: count,
    completedAssignments: count,
    cancelledAssignments: count,
    activeAssignments: count,
    pendingAssignments: count,
  }),
  byPurpose: z.array(
    z.object({
      purpose: z.enum(['practice', 'diagnostic', 'control']),
      counts: reportCountsSchema,
    }),
  ),
  skills: z.array(reportSkillSchema),
  repeatedErrors: z.array(reportErrorSchema),
  planChangesCount: count,
  planChanges: reportChangesPageSchema,
  recentAttempts: reportAttemptsPageSchema,
  diagnostic: z
    .object({ summary: diagnosticSummarySchema, result: diagnosticResultSchema.nullable() })
    .nullable(),
  next: z.object({
    continueRun: runSummarySchema.nullable(),
    plan: planSummarySchema.nullable(),
    assignments: z.array(dashboardAssignmentSchema),
    outstandingAssignments: count,
  }),
});

const deductionSchema = z.object({
  code: z.string(),
  label: z.string(),
  reductionBasisPoints: count,
});
export const reportIntegrityAttemptSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  runTitle: z.string(),
  evaluatedAt: z.iso.datetime(),
  skillTitle: z.string(),
  independent: z.boolean(),
  correct: z.boolean(),
  teacherReviewed: z.boolean(),
  assessment: integrityAssessmentSchema,
  weightBasisPoints: count.max(10000),
  deductions: z.array(deductionSchema),
  unknownSignalCodes: z.array(z.string()),
  evidenceReductionBasisPoints: count,
});
export const reportIntegrityPageSchema = z.object({
  items: z.array(reportIntegrityAttemptSchema),
  nextCursor: cursor,
});
export const reportIntegritySchema = z.object({
  version: z.string(),
  policy: z.object({
    baseWeightBasisPoints: z.literal(10000),
    maxReductionBasisPoints: count,
    signals: z.array(deductionSchema),
  }),
  assessedAttempts: count,
  insufficientDataAttempts: count,
  flaggedAttempts: count,
  requiresReviewAttempts: count,
  independentCorrect: count,
  independentCorrectWithoutData: count,
  weightedEvidenceUnits: z.number().nonnegative(),
  evidenceReductionUnits: z.number().nonnegative(),
  signalImpact: z.array(
    deductionSchema.extend({
      attempts: count,
      independentCorrectAffected: count,
      evidenceReductionBasisPoints: count,
    }),
  ),
  skills: z.array(
    z.object({
      packageId: z.string(),
      packageVersion: count,
      skillId: z.string(),
      title: z.string(),
      independentCorrect: count,
      weightedEvidenceUnits: z.number().nonnegative(),
      evidenceReductionUnits: z.number().nonnegative(),
      insufficientDataAttempts: count,
      requiresReviewAttempts: count,
    }),
  ),
  attempts: reportIntegrityPageSchema,
});
export const learningReportViewSchema = z.object({
  report: learningReportSchema,
  reviewer: reportIntegritySchema.nullable(),
  refreshedAt: z.iso.datetime(),
});
export type LearningReport = z.infer<typeof learningReportSchema>;
export type ReportCounts = z.infer<typeof reportCountsSchema>;
export type ReportAttempt = z.infer<typeof reportAttemptSchema>;
export type ReportIntegrity = z.infer<typeof reportIntegritySchema>;
