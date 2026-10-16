import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  attemptDetailSchema,
  teacherActionSchema,
  exerciseSchema,
  questionnaireSchema,
  type learningPageQuerySchema,
  type saveTeacherReviewSchema,
  type teacherAssignmentSchema,
  type teacherAssignmentUpdateSchema,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { studentAccess } from '../diagnostics/profile.js';
import { canonicalJson } from '../content/service.js';
import { iso } from '../engine/repository.js';
import { readPlan } from '../plans/repository.js';
import { applyReviewedObservation } from '../adaptation/reviews.js';
import { speechSelect, speechView, type SpeechRow } from '../speech/repository.js';
import {
  attemptRow,
  reviewedSelect,
  reviewedView,
  reviewHistory,
  teacherAccess,
  canReview,
  planChange,
  pinnedExercise,
  type ReviewedRow,
} from './repository.js';
type Query = z.infer<typeof learningPageQuerySchema>;
export class TeacherService {
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {}
  private async operationLock(tx: QueryExecutor, actor: Actor, operationId: string) {
    if (!canReview(actor))
      throw new AppError(
        403,
        'TEACHER_REQUIRED',
        'Изменение доступно преподавателю или суперадмину.',
      );
    if (this.db.kind === 'postgres')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `teacher:${actor.user.id}:${operationId}`,
      ]);
  }
  private async replay(
    tx: QueryExecutor,
    actor: Actor,
    operationId: string,
    kind: string,
    request: unknown,
  ) {
    const old = (
      await tx.query<{ id: string; kind: string; request: unknown }>(
        'SELECT * FROM teacher_actions WHERE actor_id=$1 AND operation_id=$2',
        [actor.user.id, operationId],
      )
    ).rows[0];
    if (old && (old.kind !== kind || canonicalJson(old.request) !== canonicalJson(request)))
      throw new AppError(
        409,
        'TEACHER_OPERATION_CONFLICT',
        'Эта операция уже сохранена с другими данными.',
      );
    return old;
  }
  async attempts(actor: Actor, input: Query) {
    return this.db.transaction(async (tx) => {
      const userId = input.userId ?? actor.user.id;
      await studentAccess(tx, actor, userId);
      const rows = (
        await tx.query<ReviewedRow>(
          `${reviewedSelect} WHERE a.user_id=$1 AND ($2::timestamptz IS NULL OR (a.evaluated_at,a.id)<($2,$3::uuid)) ORDER BY a.evaluated_at DESC,a.id DESC LIMIT $4`,
          [userId, input.beforeCreatedAt ?? null, input.beforeId ?? null, input.limit + 1],
        )
      ).rows;
      const items = rows.slice(0, input.limit).map((r) => reviewedView(actor, r)),
        last = items.at(-1)?.attempt;
      return {
        items,
        nextCursor:
          rows.length > input.limit && last ? { createdAt: last.evaluatedAt, id: last.id } : null,
      };
    });
  }
  detail(actor: Actor, id: string, beforeRevision?: number) {
    return this.db.transaction(async (tx) => {
      const row = await attemptRow(tx, id);
      await studentAccess(tx, actor, row.user_id);
      const view = reviewedView(actor, row);
      const speech = row.speech_input_id
        ? (await tx.query<SpeechRow>(`${speechSelect} WHERE s.id=$1`, [row.speech_input_id]))
            .rows[0]
        : null;
      return attemptDetailSchema.parse({
        ...view,
        solution: view.reviewable ? pinnedExercise(row).solution : null,
        speechInput: speech ? speechView(speech, this.now()) : null,
        ...(await reviewHistory(tx, id, beforeRevision)),
      });
    });
  }
  async review(actor: Actor, id: string, input: z.infer<typeof saveTeacherReviewSchema>) {
    await this.db.transaction(async (tx) => {
      await this.operationLock(tx, actor, input.operationId);
      let row = await attemptRow(tx, id);
      await teacherAccess(tx, actor, row.user_id);
      await tx.query('SELECT id FROM engine_runs WHERE id=$1 FOR UPDATE', [row.run_id]);
      await tx.query('SELECT id FROM engine_attempts WHERE id=$1 FOR UPDATE', [id]);
      row = await attemptRow(tx, id);
      const request = { attemptId: id, ...input };
      if (await this.replay(tx, actor, input.operationId, 'review', request)) return;
      if (row.run_purpose !== 'practice' && row.run_status !== 'completed')
        throw new AppError(
          409,
          'ASSESSMENT_INCOMPLETE',
          'Проверка преподавателя доступна после завершения диагностики или контроля.',
        );
      if (input.revision !== (row.review_revision ?? 0))
        throw new AppError(
          409,
          'REVIEW_CHANGED',
          'Ответ уже проверен другим действием. Обновите историю.',
        );
      const current = row.teacher_correct ?? row.is_correct;
      if (input.decision === 'correct' && input.correct === current)
        throw new AppError(
          400,
          'REVIEW_UNCHANGED',
          'Оценка не изменилась. Выберите подтверждение оценки.',
        );
      await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [row.user_id]);
      const actionId = randomUUID(),
        now = this.now(),
        revision = (row.review_revision ?? 0) + 1;
      const correct =
        input.decision === 'comment'
          ? null
          : input.decision === 'confirm'
            ? current
            : input.correct!;
      await tx.query(
        "INSERT INTO teacher_actions (id,actor_id,student_id,operation_id,kind,request,attempt_id,comment,created_at) VALUES ($1,$2,$3,$4,'review',$5,$6,$7,$8)",
        [
          actionId,
          actor.user.id,
          row.user_id,
          input.operationId,
          JSON.stringify(request),
          id,
          input.comment,
          new Date(now),
        ],
      );
      await tx.query(
        'INSERT INTO teacher_reviews (id,attempt_id,student_id,author_id,revision,decision,correct,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          actionId,
          id,
          row.user_id,
          actor.user.id,
          revision,
          input.decision,
          correct,
          input.comment,
          new Date(now),
        ],
      );
      if (correct !== null) {
        await tx.query(
          'UPDATE engine_attempts SET teacher_correct=$2,teacher_review_id=$3,review_revision=$4 WHERE id=$1',
          [id, correct, actionId, revision],
        );
        await applyReviewedObservation(tx, id, actionId, correct);
      } else
        await tx.query('UPDATE engine_attempts SET review_revision=$2 WHERE id=$1', [id, revision]);
      const plans = (
        await tx.query<{ id: string }>(
          `SELECT p.id FROM learning_plans p WHERE p.user_id=$1 AND p.package_id=$2 AND p.package_version=$3 AND p.route_id=$4 AND (p.id IN (SELECT plan_id FROM plan_assignments WHERE run_id=$5) OR (NOT EXISTS(SELECT 1 FROM plan_assignments WHERE run_id=$5) AND p.id=(SELECT id FROM learning_plans WHERE user_id=$1 AND package_id=$2 AND package_version=$3 AND route_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1))) ORDER BY p.id FOR UPDATE`,
          [row.user_id, row.package_id, row.package_version, row.route_id, row.run_id],
        )
      ).rows;
      const skill = pinnedExercise(row).skillId,
        outcome =
          correct === null
            ? null
            : !correct
              ? 'mistake'
              : row.independent
                ? 'independent_success'
                : row.used_hints instanceof Array && row.used_hints.length
                  ? 'hinted_success'
                  : 'assisted_success';
      for (const p of plans)
        await planChange(tx, {
          id: actionId,
          planId: p.id,
          assignmentId: null,
          action: 'assessment_reviewed',
          skillId: skill,
          outcome,
          reason: input.comment,
          actorId: actor.user.id,
          now,
        });
      await audit(tx, actor.user.id, 'teacher.answer_reviewed', row.user_id);
    });
    return this.detail(actor, id);
  }
  private async lockedPlan(tx: QueryExecutor, actor: Actor, id: string) {
    if (!canReview(actor))
      throw new AppError(
        403,
        'TEACHER_REQUIRED',
        'Изменение доступно преподавателю или суперадмину.',
      );
    const owner = (
      await tx.query<{ user_id: string }>('SELECT user_id FROM learning_plans WHERE id=$1', [id])
    ).rows[0];
    if (!owner) throw new AppError(404, 'PLAN_NOT_FOUND', 'Учебный план не найден.');
    await teacherAccess(tx, actor, owner.user_id);
    await tx.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [owner.user_id]);
    const p = (
      await tx.query<{
        id: string;
        user_id: string;
        package_id: string;
        package_version: number;
        route_id: string;
        created_at: Date | string;
        questionnaire: unknown;
      }>(
        `SELECT p.*,d.questionnaire FROM learning_plans p JOIN diagnostic_sessions d ON d.id=p.diagnostic_id WHERE p.id=$1 FOR UPDATE OF p`,
        [id],
      )
    ).rows[0];
    if (!p) throw new AppError(404, 'PLAN_NOT_FOUND', 'Учебный план не найден.');
    await teacherAccess(tx, actor, p.user_id);
    return p;
  }
  bank(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const p = await this.lockedPlan(tx, actor, id);
      const rows = (
        await tx.query<{
          id: string;
          exercise_version: number;
          lesson_id: string;
          skill_id: string;
          purpose: string;
          definition: unknown;
          lesson_title: string;
          skill_title: string;
        }>(
          `SELECT e.*,l.definition->>'title' AS lesson_title,k.definition->>'title' AS skill_title FROM learning_exercises e JOIN learning_lessons l ON l.package_id=e.package_id AND l.package_version=e.package_version AND l.id=e.lesson_id JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id WHERE e.package_id=$1 AND e.package_version=$2 AND l.route_id=$3 AND e.purpose IN ('practice','control') ORDER BY l.position,e.purpose,e.position,e.id`,
          [p.package_id, p.package_version, p.route_id],
        )
      ).rows;
      return {
        items: rows.map((e) => ({
          id: e.id,
          version: e.exercise_version,
          lessonId: e.lesson_id,
          lessonTitle: e.lesson_title,
          skillId: e.skill_id,
          skillTitle: e.skill_title,
          purpose: e.purpose,
          instruction: exerciseSchema.parse(e.definition).instruction,
        })),
      };
    });
  }
  async assign(actor: Actor, planId: string, input: z.infer<typeof teacherAssignmentSchema>) {
    await this.db.transaction((tx) => this.assignInTransaction(tx, actor, planId, input));
    return this.db.transaction((tx) => readPlan(tx, actor, planId, this.now()));
  }
  async assignInTransaction(
    tx: QueryExecutor,
    actor: Actor,
    planId: string,
    input: z.infer<typeof teacherAssignmentSchema>,
  ) {
    await this.operationLock(tx, actor, input.operationId);
    const p = await this.lockedPlan(tx, actor, planId),
      request = { planId, ...input };
    if (await this.replay(tx, actor, input.operationId, 'assignment_added', request))
      return (
        await tx.query<{ assignment_id: string }>(
          'SELECT assignment_id FROM teacher_actions WHERE actor_id=$1 AND operation_id=$2',
          [actor.user.id, input.operationId],
        )
      ).rows[0]!.assignment_id;
    const row = (
      await tx.query<{ definition: unknown; skill_title: string }>(
        `SELECT e.definition,k.definition->>'title' AS skill_title FROM learning_exercises e JOIN learning_lessons l ON l.package_id=e.package_id AND l.package_version=e.package_version AND l.id=e.lesson_id JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id WHERE e.package_id=$1 AND e.package_version=$2 AND l.route_id=$3 AND e.id=$4 AND e.purpose IN ('practice','control')`,
        [p.package_id, p.package_version, p.route_id, input.exerciseId],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        400,
        'INVALID_TEACHER_EXERCISE',
        'Выберите тренировку или контроль из закреплённого маршрута плана.',
      );
    const e = exerciseSchema.parse(row.definition),
      id = randomUUID(),
      actionId = randomUUID(),
      now = this.now();
    const pos = (
      await tx.query<{ position: number }>(
        'SELECT COALESCE(max(position),-1)+1 AS position FROM plan_assignments WHERE plan_id=$1',
        [planId],
      )
    ).rows[0]!.position;
    const day = Math.max(
      1,
      Math.floor(
        ((input.dueAt ? new Date(input.dueAt).getTime() : now) - new Date(p.created_at).getTime()) /
          86400000,
      ) + 1,
    );
    const reason = {
      kind: 'teacher',
      text: input.reason,
      goal: questionnaireSchema.parse(p.questionnaire).goal,
      goalMatched: false,
      skills: [
        {
          skillId: e.skillId,
          name: row.skill_title,
          correct: 0,
          questions: 1,
          independentCorrect: 0,
        },
      ],
    };
    await tx.query(
      "INSERT INTO plan_assignments (id,plan_id,user_id,package_id,package_version,route_id,lesson_id,purpose,position,recommended_day,estimated_minutes,reason,kind,skill_id,created_at,due_at,teacher_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'teacher',$13,$14,$15,$16)",
      [
        id,
        planId,
        p.user_id,
        p.package_id,
        p.package_version,
        p.route_id,
        e.lessonId,
        e.purpose,
        pos,
        day,
        input.estimatedMinutes,
        JSON.stringify(reason),
        e.skillId,
        new Date(now),
        input.dueAt,
        input.reason,
      ],
    );
    await tx.query(
      'INSERT INTO plan_assignment_exercises (assignment_id,package_id,package_version,exercise_id,exercise_version,position) VALUES ($1,$2,$3,$4,$5,0)',
      [id, p.package_id, p.package_version, e.id, e.version],
    );
    await tx.query(
      "INSERT INTO teacher_actions (id,actor_id,student_id,operation_id,kind,request,plan_id,assignment_id,comment,created_at) VALUES ($1,$2,$3,$4,'assignment_added',$5,$6,$7,$8,$9)",
      [
        actionId,
        actor.user.id,
        p.user_id,
        input.operationId,
        JSON.stringify(request),
        planId,
        id,
        input.reason,
        new Date(now),
      ],
    );
    await planChange(tx, {
      id: actionId,
      planId,
      assignmentId: id,
      action: 'teacher_assignment_added',
      skillId: e.skillId,
      outcome: null,
      reason: input.reason,
      actorId: actor.user.id,
      now,
    });
    await audit(tx, actor.user.id, 'teacher.exercise_assigned', p.user_id);
    return (
      await tx.query<{ assignment_id: string }>(
        'SELECT assignment_id FROM teacher_actions WHERE actor_id=$1 AND operation_id=$2',
        [actor.user.id, input.operationId],
      )
    ).rows[0]!.assignment_id;
  }
  async updateAssignment(
    actor: Actor,
    planId: string,
    id: string,
    input: z.infer<typeof teacherAssignmentUpdateSchema>,
  ) {
    await this.db.transaction(async (tx) => {
      await this.operationLock(tx, actor, input.operationId);
      const p = await this.lockedPlan(tx, actor, planId),
        request = { planId, assignmentId: id, ...input },
        kind = input.action === 'cancel' ? 'assignment_cancelled' : 'assignment_rescheduled';
      if (await this.replay(tx, actor, input.operationId, kind, request)) return;
      const a = (
        await tx.query<{
          run_id: string | null;
          teacher_revision: number;
          cancelled_at: Date | string | null;
          due_at: Date | string | null;
          recommended_day: number;
          reason: unknown;
          skill_id: string | null;
        }>('SELECT * FROM plan_assignments WHERE id=$1 AND plan_id=$2 FOR UPDATE', [id, planId])
      ).rows[0];
      if (!a)
        throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Назначение не найдено в этом плане.');
      if (a.teacher_revision !== input.revision)
        throw new AppError(409, 'ASSIGNMENT_CHANGED', 'Назначение уже изменено. Обновите план.');
      if (a.run_id || a.cancelled_at)
        throw new AppError(
          409,
          'ASSIGNMENT_LOCKED',
          'Изменять можно только ещё не начатое и не отменённое назначение.',
        );
      const actionId = randomUUID(),
        now = this.now(),
        day = Math.max(
          1,
          Math.floor(
            ((input.dueAt ? new Date(input.dueAt).getTime() : now) -
              new Date(p.created_at).getTime()) /
              86400000,
          ) + 1,
        );
      await tx.query(
        'UPDATE plan_assignments SET due_at=CASE WHEN $2 THEN due_at ELSE $3::timestamptz END,recommended_day=CASE WHEN $2 THEN recommended_day ELSE $4 END,cancelled_at=CASE WHEN $2 THEN $5::timestamptz ELSE NULL END,closed_at=CASE WHEN $2 THEN $5::timestamptz ELSE closed_at END,teacher_note=$6,teacher_revision=teacher_revision+1 WHERE id=$1',
        [id, input.action === 'cancel', input.dueAt, day, new Date(now), input.reason],
      );
      await tx.query(
        'INSERT INTO teacher_actions (id,actor_id,student_id,operation_id,kind,request,before_state,plan_id,assignment_id,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          actionId,
          actor.user.id,
          p.user_id,
          input.operationId,
          kind,
          JSON.stringify(request),
          JSON.stringify({
            dueAt: a.due_at ? iso(a.due_at) : null,
            recommendedDay: a.recommended_day,
            reason: a.reason,
          }),
          planId,
          id,
          input.reason,
          new Date(now),
        ],
      );
      const skill =
        a.skill_id ??
        (
          await tx.query<{ skill_id: string }>(
            `SELECT e.skill_id FROM plan_assignment_exercises x JOIN learning_exercises e ON e.package_id=x.package_id AND e.package_version=x.package_version AND e.id=x.exercise_id WHERE x.assignment_id=$1 ORDER BY x.position LIMIT 1`,
            [id],
          )
        ).rows[0]!.skill_id;
      await planChange(tx, {
        id: actionId,
        planId,
        assignmentId: id,
        action: `teacher_${kind}`,
        skillId: skill,
        outcome: null,
        reason: input.reason,
        actorId: actor.user.id,
        now,
      });
      await audit(tx, actor.user.id, `teacher.${kind}`, p.user_id);
    });
    return this.db.transaction((tx) => readPlan(tx, actor, planId, this.now()));
  }
  updates(actor: Actor, input: Query) {
    return this.db.transaction(async (tx) => {
      const userId = input.userId ?? actor.user.id;
      await studentAccess(tx, actor, userId);
      const rows = (
        await tx.query<{
          id: string;
          kind: string;
          actor_id: string;
          author_name: string;
          comment: string;
          created_at: Date | string;
          plan_id: string | null;
          assignment_id: string | null;
          attempt_id: string | null;
          language: string;
          decision: string | null;
          correct: boolean | null;
        }>(
          `SELECT t.*,u.full_name AS author_name,v.decision,v.correct,COALESCE(d.questionnaire->>'language',l.definition->>'language') AS language FROM teacher_actions t JOIN users u ON u.id=t.actor_id LEFT JOIN teacher_reviews v ON v.id=t.id LEFT JOIN learning_plans p ON p.id=t.plan_id LEFT JOIN diagnostic_sessions d ON d.id=p.diagnostic_id LEFT JOIN engine_attempts a ON a.id=t.attempt_id LEFT JOIN engine_runs r ON r.id=a.run_id LEFT JOIN learning_routes l ON l.package_id=r.package_id AND l.package_version=r.package_version AND l.id=r.route_id WHERE t.student_id=$1 AND ($2::timestamptz IS NULL OR (t.created_at,t.id)<($2,$3::uuid)) ORDER BY t.created_at DESC,t.id DESC LIMIT $4`,
          [userId, input.beforeCreatedAt ?? null, input.beforeId ?? null, input.limit + 1],
        )
      ).rows;
      const items = rows.slice(0, input.limit).map((r) =>
          teacherActionSchema.parse({
            id: r.id,
            kind: r.kind,
            author: { id: r.actor_id, name: r.author_name },
            comment: r.comment,
            createdAt: iso(r.created_at),
            planId: r.plan_id,
            assignmentId: r.assignment_id,
            attemptId: r.attempt_id,
            language: r.language,
            decision: r.decision,
            correct: r.correct,
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
