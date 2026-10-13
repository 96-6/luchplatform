import type { Database } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { studentAccess } from '../diagnostics/profile.js';
import { AppError } from '../../errors.js';

// Only new remedial practice needs unseen content. Deliberate delayed reviews remain repeatable.
export class CachedContentService {
  constructor(readonly db: Database) {}
  async ensureAvailable(actor: Actor, planId: string, assignmentId: string) {
    await this.db.transaction(async (tx) => {
      const a = (
        await tx.query<{ user_id: string; run_id: string | null; kind: string }>(
          'SELECT * FROM plan_assignments WHERE id=$1 AND plan_id=$2 FOR UPDATE',
          [assignmentId, planId],
        )
      ).rows[0];
      if (!a) throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Назначение не найдено.');
      await studentAccess(tx, actor, a.user_id, true);
      if (a.run_id || !['correction', 'supported_practice'].includes(a.kind)) return;
      const x = (
        await tx.query<{
          package_id: string;
          package_version: number;
          exercise_id: string;
          exercise_version: number;
          generated_exercise_id: string | null;
          skill_id: string;
          lesson_id: string;
        }>(
          `SELECT x.*,e.skill_id,e.lesson_id FROM plan_assignment_exercises x JOIN learning_exercises e ON e.package_id=x.package_id AND e.package_version=x.package_version AND e.id=x.exercise_id WHERE x.assignment_id=$1`,
          [assignmentId],
        )
      ).rows[0]!;
      const key = x.generated_exercise_id
        ? `generated:${x.generated_exercise_id}`
        : `bank:${x.package_id}:${x.package_version}:${x.exercise_id}:${x.exercise_version}`;
      if (
        !(
          await tx.query(
            'SELECT 1 FROM learning_content_views WHERE user_id=$1 AND content_key=$2',
            [a.user_id, key],
          )
        ).rows.length
      ) {
        if (!x.generated_exercise_id)
          await tx.query('UPDATE plan_assignments SET cache_fallback=true WHERE id=$1', [
            assignmentId,
          ]);
        return;
      }
      const generated = (
        await tx.query<{ id: string }>(
          `SELECT g.id FROM generated_exercises g WHERE g.package_id=$1 AND g.package_version=$2 AND g.exercise_id=$3 AND NOT EXISTS(SELECT 1 FROM learning_content_views v WHERE v.user_id=$4 AND v.content_key='generated:'||g.id::text) ORDER BY g.created_at,g.id LIMIT 1`,
          [x.package_id, x.package_version, x.exercise_id, a.user_id],
        )
      ).rows[0];
      if (generated)
        await tx.query(
          'UPDATE plan_assignment_exercises SET generated_exercise_id=$2 WHERE assignment_id=$1',
          [assignmentId, generated.id],
        );
      else {
        const bank = (
          await tx.query<{ id: string; version: number }>(
            `SELECT e.id,e.exercise_version AS version FROM learning_exercises e WHERE e.package_id=$1 AND e.package_version=$2 AND e.skill_id=$3 AND e.lesson_id=$4 AND e.purpose='practice' AND NOT EXISTS(SELECT 1 FROM learning_content_views v WHERE v.user_id=$5 AND v.content_key='bank:'||e.package_id||':'||e.package_version::text||':'||e.id||':'||e.exercise_version::text) ORDER BY e.id LIMIT 1`,
            [x.package_id, x.package_version, x.skill_id, x.lesson_id, a.user_id],
          )
        ).rows[0];
        if (!bank)
          throw new AppError(
            503,
            'CONTENT_GENERATION_UNAVAILABLE',
            'Ошибка генерации контента: подходящие сохранённые задания уже просмотрены, а новый материал сейчас недоступен. Повторите позже.',
          );
        await tx.query(
          'UPDATE plan_assignment_exercises SET exercise_id=$2,exercise_version=$3,generated_exercise_id=NULL WHERE assignment_id=$1',
          [assignmentId, bank.id, bank.version],
        );
      }
      await tx.query('UPDATE plan_assignments SET cache_fallback=true WHERE id=$1', [assignmentId]);
    });
  }
}
