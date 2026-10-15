import { teacherReviewSchema, exerciseSchema, reviewedAttemptSchema } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { studentAccess } from '../diagnostics/profile.js';
import { attemptSelect, attemptView, iso, type AttemptRow } from '../engine/repository.js';
export type ReviewedRow = AttemptRow & {
  run_title: string;
  run_purpose: 'practice' | 'control' | 'diagnostic';
  run_status: 'active' | 'completed';
  package_id: string;
  package_version: number;
  route_id: string;
};
export const reviewedSelect = `SELECT a.*,r.title AS run_title,r.purpose AS run_purpose,r.status AS run_status,r.package_id,r.package_version,r.route_id FROM (${attemptSelect}) a JOIN engine_runs r ON r.id=a.run_id`;
export function canReview(actor: Actor) {
  return actor.user.role === 'teacher' || actor.user.role === 'superadmin';
}
export async function teacherAccess(tx: QueryExecutor, actor: Actor, userId: string) {
  if (!canReview(actor))
    throw new AppError(
      403,
      'TEACHER_REQUIRED',
      'Изменение доступно преподавателю или суперадмину.',
    );
  const user = await studentAccess(tx, actor, userId);
  if (actor.user.role === 'teacher') {
    const link = await tx.query(
      'SELECT student_id FROM teacher_students WHERE teacher_id=$1 AND student_id=$2 FOR SHARE',
      [actor.user.id, userId],
    );
    if (!link.rows.length) throw new AppError(404, 'STUDENT_NOT_FOUND', 'Ученик не найден.');
  }
  return user;
}
export function reviewedView(actor: Actor, row: ReviewedRow) {
  const reveal = row.run_purpose === 'practice' || row.run_status === 'completed';
  return reviewedAttemptSchema.parse({
    attempt: attemptView(row, reveal),
    runId: row.run_id,
    runTitle: row.run_title,
    purpose: row.run_purpose,
    runStatus: row.run_status,
    reviewable: canReview(actor) && reveal,
  });
}
export async function attemptRow(tx: QueryExecutor, id: string) {
  const row = (await tx.query<ReviewedRow>(`${reviewedSelect} WHERE a.id=$1`, [id])).rows[0];
  if (!row) throw new AppError(404, 'ATTEMPT_NOT_FOUND', 'Ответ не найден.');
  return row;
}
export async function reviewHistory(tx: QueryExecutor, id: string, beforeRevision?: number) {
  const rows = (
    await tx.query<{
      id: string;
      revision: number;
      decision: string;
      correct: boolean | null;
      comment: string;
      author_id: string;
      author_name: string;
      created_at: Date | string;
    }>(
      `SELECT r.*,u.full_name AS author_name FROM teacher_reviews r JOIN users u ON u.id=r.author_id WHERE r.attempt_id=$1 AND ($2::integer IS NULL OR r.revision<$2) ORDER BY r.revision DESC LIMIT 21`,
      [id, beforeRevision ?? null],
    )
  ).rows;
  const items = rows.slice(0, 20).map((r) =>
    teacherReviewSchema.parse({
      id: r.id,
      revision: r.revision,
      decision: r.decision,
      correct: r.correct,
      comment: r.comment,
      author: { id: r.author_id, name: r.author_name },
      createdAt: iso(r.created_at),
    }),
  );
  return {
    reviews: items,
    nextReviewCursor: rows.length > 20 ? { revision: items.at(-1)!.revision } : null,
  };
}
export async function planChange(
  tx: QueryExecutor,
  input: {
    id: string;
    planId: string;
    assignmentId: string | null;
    action: string;
    skillId: string;
    outcome: string | null;
    reason: string;
    actorId: string;
    now: number;
  },
) {
  await tx.query(
    'INSERT INTO learning_plan_changes (id,plan_id,teacher_action_id,assignment_id,action,skill_id,outcome,reason,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      crypto.randomUUID(),
      input.planId,
      input.id,
      input.assignmentId,
      input.action,
      input.skillId,
      input.outcome,
      input.reason,
      input.actorId,
      new Date(input.now),
    ],
  );
}
export const pinnedExercise = (row: ReviewedRow) => exerciseSchema.parse(row.definition);
