import { z } from 'zod';
import { attemptSchema } from './engine.js';
import { contentIdSchema, exerciseSchema } from './content.js';
import { teacherReviewSchema } from './reviews.js';
import { speechInputSchema } from './speech.js';
export const learningPageQuerySchema = z
  .strictObject({
    userId: z.uuid().optional(),
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine(
    (q) => Boolean(q.beforeCreatedAt) === Boolean(q.beforeId),
    'Поля курсора требуются вместе.',
  );
const cursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable();
export const reviewedAttemptSchema = z.object({
  attempt: attemptSchema,
  runId: z.uuid(),
  runTitle: z.string(),
  purpose: z.enum(['practice', 'diagnostic', 'control']),
  runStatus: z.enum(['active', 'completed']),
  reviewable: z.boolean(),
});
export const attemptsPageSchema = z.object({
  items: z.array(reviewedAttemptSchema),
  nextCursor: cursor,
});
export const attemptDetailSchema = reviewedAttemptSchema.extend({
  solution: exerciseSchema.shape.solution.nullable(),
  speechInput: speechInputSchema.nullable(),
  reviews: z.array(teacherReviewSchema),
  nextReviewCursor: z.object({ revision: z.number().int().positive() }).nullable(),
});
export const teacherExerciseBankSchema = z.object({
  items: z.array(
    z.object({
      id: contentIdSchema,
      version: z.number().int().positive(),
      lessonId: contentIdSchema,
      lessonTitle: z.string(),
      skillId: contentIdSchema,
      skillTitle: z.string(),
      purpose: z.enum(['practice', 'control']),
      instruction: z.string(),
    }),
  ),
});
export const teacherAssignmentSchema = z.strictObject({
  operationId: z.uuid(),
  exerciseId: contentIdSchema,
  reason: z.string().trim().min(1).max(3000),
  dueAt: z.iso.datetime().nullable(),
  estimatedMinutes: z.number().int().min(1).max(60).default(3),
});
export const teacherAssignmentUpdateSchema = z.strictObject({
  operationId: z.uuid(),
  revision: z.number().int().nonnegative(),
  action: z.enum(['reschedule', 'cancel']),
  dueAt: z.iso.datetime().nullable(),
  reason: z.string().trim().min(1).max(3000),
});
export const teacherActionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['review', 'assignment_added', 'assignment_rescheduled', 'assignment_cancelled']),
  author: z.object({ id: z.uuid(), name: z.string() }),
  comment: z.string(),
  createdAt: z.iso.datetime(),
  planId: z.uuid().nullable(),
  assignmentId: z.uuid().nullable(),
  attemptId: z.uuid().nullable(),
  language: z.enum(['ru', 'en']),
  decision: z.enum(['comment', 'confirm', 'correct']).nullable(),
  correct: z.boolean().nullable(),
});
export const teacherActionsPageSchema = z.object({
  items: z.array(teacherActionSchema),
  nextCursor: cursor,
});
