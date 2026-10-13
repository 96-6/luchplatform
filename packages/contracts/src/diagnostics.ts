import { z } from 'zod';
import { contentIdSchema } from './content.js';
import { userSchema } from './accounts.js';

export const learningGoalSchema = z.enum(['daily_life', 'travel', 'work', 'study']);
export const learningExperienceSchema = z.enum(['none', 'some', 'regular']);
export const questionnaireSchema = z.strictObject({
  language: z.enum(['ru', 'en']),
  goal: learningGoalSchema,
  experience: learningExperienceSchema,
  minutesPerDay: z.number().int().min(5).max(120),
});
export const studentProfileSchema = questionnaireSchema.extend({
  userId: z.uuid(),
  revision: z.number().int().positive(),
  updatedBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const profileViewSchema = z.object({
  user: userSchema,
  profile: studentProfileSchema.nullable(),
  writable: z.boolean(),
});
export const saveQuestionnaireSchema = questionnaireSchema.extend({
  userId: z.uuid().optional(),
  revision: z.number().int().nonnegative(),
});
export const studentQuerySchema = z.object({ userId: z.uuid().optional() });
export const startDiagnosticSchema = z.strictObject({
  userId: z.uuid().optional(),
  profileRevision: z.number().int().positive(),
  restart: z.boolean().default(false),
});
export const skillDiagnosticSchema = z.object({
  skillId: contentIdSchema,
  name: z.string(),
  description: z.string(),
  questions: z.number().int().positive(),
  correct: z.number().int().nonnegative(),
  independentCorrect: z.number().int().nonnegative(),
  assistedCorrect: z.number().int().nonnegative(),
  score: z.number().int().nonnegative(),
  maxScore: z.number().int().positive(),
  percent: z.number().int().min(0).max(100),
  status: z.enum(['strength', 'difficulty', 'mixed']),
});
export const diagnosticResultSchema = z.object({
  preliminary: z.literal(true),
  notice: z.string(),
  evaluatorVersion: z.string(),
  evaluatedAt: z.iso.datetime(),
  questions: z.number().int().positive(),
  correct: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  skills: z.array(skillDiagnosticSchema).min(1),
  strengthIds: z.array(contentIdSchema),
  difficultyIds: z.array(contentIdSchema),
});
export const diagnosticSummarySchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  user: userSchema.pick({ id: true, email: true, name: true }),
  profileRevision: z.number().int().positive(),
  questionnaire: questionnaireSchema,
  packageId: contentIdSchema,
  packageVersion: z.number().int().positive(),
  routeId: contentIdSchema,
  setId: contentIdSchema,
  title: z.string(),
  isDemo: z.boolean(),
  status: z.enum(['active', 'completed']),
  answeredQuestions: z.number().int().nonnegative(),
  totalQuestions: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export const diagnosticViewSchema = z.object({
  diagnostic: diagnosticSummarySchema,
  result: diagnosticResultSchema.nullable(),
  writable: z.boolean(),
});
export const diagnosticsQuerySchema = studentQuerySchema
  .extend({
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (q) => Boolean(q.beforeCreatedAt) === Boolean(q.beforeId),
    'Cursor fields are required together.',
  );
export const diagnosticsPageSchema = z.object({
  items: z.array(diagnosticSummarySchema),
  nextCursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable(),
});
export type Questionnaire = z.infer<typeof questionnaireSchema>;
export type StudentProfile = z.infer<typeof studentProfileSchema>;
export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;
