import type { z } from 'zod';
import type { plansQuerySchema } from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import type { Actor } from '../auth/service.js';
import { studentAccess } from '../diagnostics/profile.js';
import { LuchEngine } from '../engine/service.js';
import { persistInitialPlan } from './generator.js';
import { planSelect, planSummary, readPlan, type PlanRow } from './repository.js';

export class PlansService {
  readonly engine: LuchEngine;
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
    readonly prepare?: (actor: Actor, planId: string, assignmentId: string) => Promise<void>,
  ) {
    this.engine = new LuchEngine(db, now);
  }
  async generate(actor: Actor, diagnosticId: string) {
    const id = await this.db.transaction(async (tx) => {
      const d = (
        await tx.query<{ user_id: string }>('SELECT user_id FROM diagnostic_sessions WHERE id=$1', [
          diagnosticId,
        ])
      ).rows[0];
      if (!d) throw new AppError(404, 'DIAGNOSTIC_NOT_FOUND', 'Диагностика не найдена.');
      await studentAccess(tx, actor, d.user_id, true);
      return persistInitialPlan(tx, diagnosticId, actor.user.id, this.now());
    });
    return this.read(actor, id!);
  }
  read(actor: Actor, id: string) {
    return this.db.transaction((tx) => readPlan(tx, actor, id, this.now()));
  }
  async list(actor: Actor, input: z.infer<typeof plansQuerySchema>) {
    return this.db.transaction(async (tx) => {
      const user = await studentAccess(tx, actor, input.userId ?? actor.user.id);
      const rows = (
        await tx.query<PlanRow>(
          `${planSelect} WHERE p.user_id=$1
        AND ($2::text IS NULL OR d.questionnaire->>'language'=$2)
        AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4::uuid))
        ORDER BY p.created_at DESC,p.id DESC LIMIT $5`,
          [
            user.id,
            input.language ?? null,
            input.beforeCreatedAt ?? null,
            input.beforeId ?? null,
            input.limit + 1,
          ],
        )
      ).rows;
      const items = rows.slice(0, input.limit).map(planSummary),
        last = items.at(-1);
      if (actor.user.role === 'superadmin')
        await audit(tx, actor.user.id, 'plan.list_view', user.id);
      return {
        user: { id: user.id, name: user.full_name, email: user.email },
        items,
        nextCursor:
          rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }
  async startAssignment(actor: Actor, planId: string, assignmentId: string) {
    await this.prepare?.(actor, planId, assignmentId);
    const id = await this.db.transaction(async (tx) => {
      const a = (
        await tx.query<{
          user_id: string;
          package_id: string;
          package_version: number;
          lesson_id: string;
          run_id: string | null;
          id: string;
          route_id: string;
          purpose: 'practice' | 'control';
          kind: string;
          due_at: Date | string | null;
        }>('SELECT * FROM plan_assignments WHERE id=$1 AND plan_id=$2 FOR UPDATE', [
          assignmentId,
          planId,
        ])
      ).rows[0];
      if (!a)
        throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Назначение не найдено в этом плане.');
      await studentAccess(tx, actor, a.user_id, true);
      if (a.run_id) return a.run_id;
      if (a.due_at && new Date(a.due_at).getTime() > this.now() && actor.user.role !== 'superadmin')
        throw new AppError(
          409,
          'ASSIGNMENT_NOT_DUE',
          'Время отсроченной проверки ещё не наступило.',
        );
      const runId =
        a.kind !== 'initial'
          ? await this.engine.startAssignedExerciseInTransaction(tx, actor, a)
          : await this.engine.startInTransaction(tx, actor, {
              userId: a.user_id,
              packageId: a.package_id,
              packageVersion: a.package_version,
              source: { type: 'lesson', id: a.lesson_id, purpose: 'practice' },
              restart: true,
            });
      const mismatch = (
        await tx.query(
          `SELECT 1 FROM
        (SELECT * FROM engine_steps WHERE run_id=$1) s FULL JOIN
        (SELECT * FROM plan_assignment_exercises WHERE assignment_id=$2) e
        ON e.position=s.position AND e.exercise_id=s.exercise_id AND e.exercise_version=s.exercise_version
        WHERE s.id IS NULL OR e.assignment_id IS NULL OR s.generated_exercise_id IS DISTINCT FROM e.generated_exercise_id LIMIT 1`,
          [runId, assignmentId],
        )
      ).rows;
      if (mismatch.length)
        throw new AppError(
          409,
          'ASSIGNMENT_CONTENT_CHANGED',
          'Состав урока не совпадает с назначением.',
        );
      await tx.query(
        'UPDATE plan_assignments SET run_id=$2,started_by=$3,started_at=$4 WHERE id=$1',
        [assignmentId, runId, actor.user.id, new Date(this.now())],
      );
      await audit(tx, actor.user.id, 'plan.assignment_started', a.user_id);
      return runId;
    });
    return this.engine.repository.view(actor, id);
  }
}
