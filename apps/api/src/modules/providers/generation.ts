import { CachedContentService } from './cache.js';
import { randomUUID } from 'node:crypto';
import { exerciseSchema, type Exercise } from '@luch/contracts';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { studentAccess } from '../diagnostics/profile.js';
import { ProviderBudget, type Reservation } from './budget.js';
import { TextGenerationAdapter } from './adapters.js';
import { ProviderSettingsService } from './settings.js';
import { configuration } from './settings.js';

export class GenerationService {
  readonly budget: ProviderBudget;
  constructor(
    readonly settings: ProviderSettingsService,
    readonly adapter = new TextGenerationAdapter(),
  ) {
    this.budget = new ProviderBudget(settings);
  }
  async prepare(actor: Actor, planId: string, assignmentId: string) {
    await this.generate(actor, planId, assignmentId);
    await new CachedContentService(this.settings.db).ensureAvailable(actor, planId, assignmentId);
  }
  private async generate(actor: Actor, planId: string, assignmentId: string) {
    let base: Exercise | undefined,
      context = '',
      reservation: Reservation | undefined;
    try {
      const prepared = await this.settings.db.transaction(async (tx) => {
        const assignment = (
          await tx.query<{
            user_id: string;
            kind: string;
            run_id: string | null;
            cancelled_at: Date | string | null;
            due_at: Date | string | null;
          }>('SELECT * FROM plan_assignments WHERE id=$1 AND plan_id=$2', [assignmentId, planId])
        ).rows[0];
        if (!assignment)
          throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Назначение не найдено в этом плане.');
        await studentAccess(tx, actor, assignment.user_id, true);
        if (assignment.cancelled_at)
          throw new AppError(409, 'ASSIGNMENT_CANCELLED', 'Назначение отменено преподавателем.');
        if (
          assignment.due_at &&
          new Date(assignment.due_at).getTime() > this.settings.now() &&
          actor.user.role !== 'superadmin'
        )
          throw new AppError(409, 'ASSIGNMENT_NOT_DUE', 'Время задания ещё не наступило.');
        if (
          assignment.run_id ||
          (assignment.kind !== 'correction' && assignment.kind !== 'supported_practice')
        )
          return null;
        const row = (
          await tx.query<{ definition: unknown; description: string }>(
            `SELECT e.definition,k.definition->>'description' AS description FROM plan_assignment_exercises x
          JOIN learning_exercises e ON e.package_id=x.package_id AND e.package_version=x.package_version AND e.id=x.exercise_id
          JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id WHERE x.assignment_id=$1`,
            [assignmentId],
          )
        ).rows[0]!;
        base = exerciseSchema.parse(row.definition);
        context = JSON.stringify({
          language: base.language,
          level: base.level,
          skillId: base.skillId,
          skill: row.description.slice(0, 800),
          reason: assignment.kind,
          instruction: base.instruction.slice(0, 1000),
          solution: base.solution,
          material: base.blocks
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .slice(0, 1200),
        });
        const inputBound = this.adapter.inputBound(context);
        if (inputBound > 16_384) return null;
        return this.budget.reserve(tx, actor, assignment.user_id, {
          resourceKey: `adaptive:${assignmentId}`,
          kind: 'adaptive_exercise',
          assignmentId,
          inputBound,
        });
      });
      if (!prepared) return;
      if ('existing' in prepared) {
        if (prepared.existing.status === 'reserved')
          throw new AppError(
            409,
            'PROVIDER_IN_PROGRESS',
            'Вариант задания уже готовится. Повторите открытие через несколько секунд.',
          );
        return;
      }
      reservation = prepared.reservation;
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          'PROVIDER_DISABLED',
          'PROVIDER_UNAVAILABLE',
          'PROVIDER_BUDGET_LIMIT',
          'PROVIDER_INPUT_LIMIT',
        ].includes(error.code)
      )
        return;
      throw error;
    }
    const r = reservation!;
    try {
      const generated = await this.adapter.generate(r, context);
      if (generated.input > r.inputBound || generated.output > r.outputBound) {
        await this.settings.db.transaction((tx) =>
          this.budget.settle(tx, r, generated, 'USAGE_EXCEEDED'),
        );
        return;
      }
      const question = generated.question,
        id = randomUUID();
      if (r.withListening && !question.listeningText) throw new Error('PROVIDER_INVALID_OUTPUT');
      const currentConfiguration = await configuration(this.settings.db);
      if (
        question.listeningText &&
        question.listeningText.length >
          Math.min(
            currentConfiguration.ceilings.maxTtsCharacters,
            currentConfiguration.controls.maxTtsCharacters,
          )
      )
        throw new Error('PROVIDER_INVALID_OUTPUT');
      const definition = exerciseSchema.parse({
        ...base!,
        instruction: question.instruction,
        blocks: question.listeningText
          ? []
          : question.material
            ? [{ id: 'generated-material', type: 'text', text: question.material }]
            : [],
        response: { type: 'choice', options: question.options },
        solution: { type: 'choice', correctOptionIds: [question.correctOptionId] },
        explanation: question.explanation,
        hints: [question.hint],
        listening: question.listeningText ? { text: question.listeningText } : undefined,
        author: `${r.provider.id} / ${r.provider.model}`,
        license: 'Демонстрационный сгенерированный учебный материал',
        rubric: {
          id: `ai-${id}`,
          version: 1,
          maxScore: 1,
          criteria: ['Выбрать верный вариант сгенерированного задания.'],
        },
        review: { status: 'demo' },
      });
      await this.settings.db.transaction(async (tx) => {
        const assignment = (
          await tx.query<{ run_id: string | null }>(
            'SELECT run_id FROM plan_assignments WHERE id=$1 FOR UPDATE',
            [assignmentId],
          )
        ).rows[0];
        if (!assignment || assignment.run_id) throw new Error('ASSIGNMENT_ALREADY_STARTED');
        await tx.query(
          'INSERT INTO generated_exercises (id,assignment_id,package_id,package_version,exercise_id,exercise_version,definition,provider,model,created_at) SELECT $1,$2,x.package_id,x.package_version,x.exercise_id,x.exercise_version,$3,$4,$5,$6 FROM plan_assignment_exercises x WHERE x.assignment_id=$2',
          [
            id,
            assignmentId,
            JSON.stringify(definition),
            r.provider.id,
            r.provider.model,
            new Date(this.settings.now()),
          ],
        );
        await tx.query(
          'UPDATE plan_assignment_exercises SET generated_exercise_id=$2 WHERE assignment_id=$1',
          [assignmentId, id],
        );
        await this.budget.settle(tx, r, {
          input: generated.input,
          output: generated.output,
          resultId: id,
        });
      });
    } catch {
      // Ambiguous network failures retain the reserved amount. The bank assignment remains usable.
      await this.settings.db.transaction((tx) =>
        this.budget.settle(tx, r, null, 'GENERATION_UNAVAILABLE'),
      );
    }
  }
}
