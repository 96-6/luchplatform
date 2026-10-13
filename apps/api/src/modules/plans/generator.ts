import { randomUUID } from 'node:crypto';
import {
  PLAN_RULES_VERSION,
  contentPackageSchema,
  diagnosticResultSchema,
  questionnaireSchema,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import { selectInitialLessons } from './rules.js';

export async function persistInitialPlan(
  tx: QueryExecutor,
  diagnosticId: string,
  createdBy: string,
  now: number,
  allowEmpty = false,
) {
  const diagnostic = (
    await tx.query<{
      id: string;
      user_id: string;
      package_id: string;
      package_version: number;
      route_id: string;
      questionnaire: unknown;
      result: unknown;
    }>('SELECT * FROM diagnostic_sessions WHERE id=$1 FOR UPDATE', [diagnosticId])
  ).rows[0];
  if (!diagnostic) throw new AppError(404, 'DIAGNOSTIC_NOT_FOUND', 'Диагностика не найдена.');
  if (!diagnostic.result)
    throw new AppError(409, 'DIAGNOSTIC_INCOMPLETE', 'Сначала завершите входную диагностику.');
  const existing = (
    await tx.query<{ id: string }>('SELECT id FROM learning_plans WHERE diagnostic_id=$1', [
      diagnosticId,
    ])
  ).rows[0];
  if (existing) return existing.id;
  const revision = (
    await tx.query<{ manifest: unknown }>(
      'SELECT manifest FROM content_revisions WHERE package_id=$1 AND version=$2',
      [diagnostic.package_id, diagnostic.package_version],
    )
  ).rows[0]!;
  const lessons = selectInitialLessons(
    contentPackageSchema.parse(revision.manifest),
    diagnostic.route_id,
    questionnaireSchema.parse(diagnostic.questionnaire),
    diagnosticResultSchema.parse(diagnostic.result),
  );
  if (!lessons.length) {
    if (allowEmpty) return null;
    throw new AppError(
      409,
      'PLAN_CONTENT_UNAVAILABLE',
      'В маршруте пока нет тренировочных заданий для плана.',
    );
  }
  const id = randomUUID();
  await tx.query(
    'INSERT INTO learning_plans (id,diagnostic_id,user_id,package_id,package_version,route_id,rules_version,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      diagnostic.id,
      diagnostic.user_id,
      diagnostic.package_id,
      diagnostic.package_version,
      diagnostic.route_id,
      PLAN_RULES_VERSION,
      createdBy,
      new Date(now),
    ],
  );
  for (const item of lessons) {
    const assignmentId = randomUUID();
    await tx.query(
      'INSERT INTO plan_assignments (id,plan_id,user_id,package_id,package_version,route_id,lesson_id,position,recommended_day,estimated_minutes,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        assignmentId,
        id,
        diagnostic.user_id,
        diagnostic.package_id,
        diagnostic.package_version,
        diagnostic.route_id,
        item.lesson.id,
        item.position,
        item.recommendedDay,
        item.lesson.estimatedMinutes,
        JSON.stringify(item.reason),
      ],
    );
    for (const [position, exercise] of item.exercises.entries())
      await tx.query(
        'INSERT INTO plan_assignment_exercises (assignment_id,package_id,package_version,exercise_id,exercise_version,position) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          assignmentId,
          diagnostic.package_id,
          diagnostic.package_version,
          exercise.id,
          exercise.version,
          position,
        ],
      );
  }
  await audit(tx, createdBy, 'plan.created', diagnostic.user_id);
  return id;
}
