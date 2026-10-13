import { skillStateSchema, planChangeSchema, type planChangesQuerySchema } from '@luch/contracts';
import type { z } from 'zod';
import type { Database } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { studentAccess } from '../diagnostics/profile.js';
import { readPlan } from '../plans/repository.js';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export class AdaptationService {
  constructor(readonly db: Database) {}
  skills(actor: Actor, userId = actor.user.id) {
    return this.db.transaction(async (tx) => {
      await studentAccess(tx, actor, userId);
      const rows = (
        await tx.query<{
          package_id: string;
          package_version: number;
          skill_id: string;
          title: string;
          description: string;
          attempts: number;
          independent_successes: number;
          hinted_successes: number;
          assisted_successes: number;
          mistakes: number;
          diagnostic_attempts: number;
          control_attempts: number;
          independent_streak: number;
          status: string;
          last_outcome: string;
          last_attempt_id: string;
          last_observed_at: Date | string;
          last_independent_at: Date | string | null;
          last_review_at: Date | string | null;
        }>(
          `SELECT s.*,k.definition->>'title' AS title,k.definition->>'description' AS description
        FROM student_skill_states s JOIN learning_skills k ON k.package_id=s.package_id AND k.package_version=s.package_version AND k.id=s.skill_id
        WHERE s.user_id=$1 ORDER BY s.package_id,s.package_version,s.skill_id`,
          [userId],
        )
      ).rows;
      if (actor.user.role === 'superadmin')
        await audit(tx, actor.user.id, 'skills.debug_view', userId);
      return {
        userId,
        items: rows.map((s) =>
          skillStateSchema.parse({
            packageId: s.package_id,
            packageVersion: s.package_version,
            skillId: s.skill_id,
            title: s.title,
            description: s.description,
            attempts: s.attempts,
            independentSuccesses: s.independent_successes,
            hintedSuccesses: s.hinted_successes,
            assistedSuccesses: s.assisted_successes,
            mistakes: s.mistakes,
            diagnosticAttempts: s.diagnostic_attempts,
            controlAttempts: s.control_attempts,
            independentStreak: s.independent_streak,
            status: s.status,
            lastOutcome: s.last_outcome,
            lastAttemptId: s.last_attempt_id,
            lastObservedAt: iso(s.last_observed_at),
            lastIndependentAt: iso(s.last_independent_at),
            lastReviewAt: iso(s.last_review_at),
          }),
        ),
      };
    });
  }
  history(actor: Actor, id: string, input: z.infer<typeof planChangesQuerySchema>) {
    return this.db.transaction(async (tx) => {
      await readPlan(tx, actor, id);
      const rows = (
        await tx.query<{
          id: string;
          attempt_id: string;
          assignment_id: string | null;
          action: string;
          skill_id: string;
          skill_name: string;
          outcome: string;
          reason: string;
          created_by: string;
          created_at: Date | string;
        }>(
          `SELECT c.*,v.attempt_id,k.definition->>'title' AS skill_name FROM learning_plan_changes c JOIN engine_events v ON v.id=c.event_id
        JOIN learning_plans p ON p.id=c.plan_id JOIN learning_skills k ON k.package_id=p.package_id AND k.package_version=p.package_version AND k.id=c.skill_id WHERE c.plan_id=$1
        AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2,$3::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT $4`,
          [id, input.beforeCreatedAt ?? null, input.beforeId ?? null, input.limit + 1],
        )
      ).rows;
      const items = rows.slice(0, input.limit).map((c) =>
          planChangeSchema.parse({
            id: c.id,
            attemptId: c.attempt_id,
            assignmentId: c.assignment_id,
            action: c.action,
            skillId: c.skill_id,
            skillName: c.skill_name,
            outcome: c.outcome,
            reason: c.reason,
            createdBy: c.created_by,
            createdAt: iso(c.created_at),
          }),
        ),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      };
    });
  }
}
