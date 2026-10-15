import { z } from 'zod';
export const teacherReviewSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  decision: z.enum(['comment', 'confirm', 'correct']),
  correct: z.boolean().nullable(),
  comment: z.string(),
  author: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.iso.datetime(),
});
export const saveTeacherReviewSchema = z
  .strictObject({
    operationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    decision: z.enum(['comment', 'confirm', 'correct']),
    correct: z.boolean().optional(),
    comment: z.string().trim().min(1).max(3000),
  })
  .refine(
    (v) => (v.decision === 'correct') === (v.correct !== undefined),
    'Укажите оценку только при исправлении результата.',
  );
