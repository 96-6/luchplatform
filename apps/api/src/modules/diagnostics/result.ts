import {
  diagnosticResultSchema,
  evaluationSchema,
  skillSchema,
  type DiagnosticResult,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { persistInitialPlan } from '../plans/generator.js';

export async function persistDiagnosticResult(
  tx: QueryExecutor,
  runId: string,
  now: number,
  actorId: string,
) {
  const diagnostic = (
    await tx.query<{
      id: string;
      result: unknown;
      package_id: string;
      package_version: number;
    }>('SELECT * FROM diagnostic_sessions WHERE run_id=$1 FOR UPDATE', [runId])
  ).rows[0];
  if (!diagnostic || diagnostic.result) return;
  const run = (
    await tx.query<{ status: string; total_steps: number }>(
      'SELECT status,total_steps FROM engine_runs WHERE id=$1',
      [runId],
    )
  ).rows[0]!;
  if (run.status !== 'completed')
    throw new AppError(409, 'DIAGNOSTIC_INCOMPLETE', 'Сначала завершите диагностику.');
  const rows = (
    await tx.query<{
      evaluation: unknown;
      independent: boolean;
      skill_definition: unknown;
    }>(
      `SELECT a.evaluation,a.independent,k.definition AS skill_definition
      FROM engine_steps s JOIN engine_attempts a ON a.step_id=s.id AND a.turn_id=s.current_turn_id
      JOIN learning_exercises e ON e.package_id=s.package_id AND e.package_version=s.package_version AND e.id=s.exercise_id
      JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id
      WHERE s.run_id=$1 ORDER BY s.position`,
      [runId],
    )
  ).rows;
  if (rows.length !== run.total_steps)
    throw new AppError(409, 'DIAGNOSTIC_INCOMPLETE', 'Не все ответы сохранены.');
  const grouped = new Map<string, DiagnosticResult['skills'][number]>();
  for (const row of rows) {
    const skill = skillSchema.parse(row.skill_definition),
      evaluation = evaluationSchema.parse(row.evaluation);
    const item = grouped.get(skill.id) ?? {
      skillId: skill.id,
      name: skill.title,
      description: skill.description,
      questions: 0,
      correct: 0,
      independentCorrect: 0,
      assistedCorrect: 0,
      score: 0,
      maxScore: 0,
      percent: 0,
      status: 'mixed' as const,
    };
    item.questions++;
    item.correct += Number(evaluation.correct);
    item.independentCorrect += Number(evaluation.correct && row.independent);
    item.assistedCorrect += Number(evaluation.correct && !row.independent);
    item.score += evaluation.score;
    item.maxScore += evaluation.maxScore;
    grouped.set(skill.id, item);
  }
  const skills = [...grouped.values()].map((skill) => ({
    ...skill,
    percent: Math.round((skill.score / skill.maxScore) * 100),
    status:
      skill.correct === skill.questions
        ? ('strength' as const)
        : skill.correct === 0
          ? ('difficulty' as const)
          : ('mixed' as const),
  }));
  const correct = skills.reduce((sum, skill) => sum + skill.correct, 0);
  const result = diagnosticResultSchema.parse({
    preliminary: true,
    notice:
      'Это предварительная оценка по короткому набору заданий. Она показывает первые наблюдения по навыкам и не подтверждает уровень языка. Для уточнения нужны дальнейшая практика и оценка преподавателя.',
    evaluatorVersion: '1.0.0',
    evaluatedAt: new Date(now).toISOString(),
    questions: rows.length,
    correct,
    percent: Math.round((correct / rows.length) * 100),
    skills,
    strengthIds: skills.filter((s) => s.status === 'strength').map((s) => s.skillId),
    difficultyIds: skills.filter((s) => s.status !== 'strength').map((s) => s.skillId),
  });
  for (const skill of skills)
    await tx.query(
      'INSERT INTO diagnostic_skill_results (diagnostic_id,package_id,package_version,skill_id,questions,correct,independent_correct,assisted_correct,score,max_score,percent,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        diagnostic.id,
        diagnostic.package_id,
        diagnostic.package_version,
        skill.skillId,
        skill.questions,
        skill.correct,
        skill.independentCorrect,
        skill.assistedCorrect,
        skill.score,
        skill.maxScore,
        skill.percent,
        skill.status,
      ],
    );
  await tx.query('UPDATE diagnostic_sessions SET result=$2,completed_at=$3 WHERE id=$1', [
    diagnostic.id,
    JSON.stringify(result),
    new Date(now),
  ]);
  await persistInitialPlan(tx, diagnostic.id, actorId, now, true);
}
