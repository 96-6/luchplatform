import { ENGINE_VERSION, type Answer, type Exercise } from '@luch/contracts';
import { AppError } from '../../errors.js';

export function validateAnswer(
  exercise: Exercise,
  answer: Answer | { type: 'short_text'; text: string } | null,
  draft = false,
) {
  if (answer === null && draft) return;
  if (!answer || answer.type !== exercise.response.type)
    throw new AppError(400, 'ANSWER_TYPE_INVALID', 'Ответ не соответствует типу задания.');
  if (
    answer.type === 'choice' &&
    exercise.response.type === 'choice' &&
    !exercise.response.options.some((option) => option.id === answer.optionId)
  )
    throw new AppError(400, 'ANSWER_OPTION_INVALID', 'Выберите вариант из этого задания.');
  if (
    answer.type === 'short_text' &&
    exercise.response.type === 'short_text' &&
    (answer.text.length > exercise.response.maxLength || (!draft && !answer.text.trim()))
  )
    throw new AppError(
      400,
      'ANSWER_TEXT_INVALID',
      `Введите ответ длиной до ${exercise.response.maxLength} символов.`,
    );
}
function normalize(value: string, exercise: Exercise): string {
  if (exercise.solution.type !== 'short_text') return value;
  const rules = exercise.solution.normalization;
  let result = value.normalize(rules.unicode);
  if (rules.trim) result = result.trim();
  if (rules.collapseWhitespace) result = result.replace(/\s+/gu, ' ');
  if (!rules.caseSensitive) result = result.toLocaleLowerCase(exercise.language);
  return result;
}
export function evaluate(exercise: Exercise, answer: Answer) {
  validateAnswer(exercise, answer);
  const correct =
    exercise.solution.type === 'choice' && answer.type === 'choice'
      ? exercise.solution.correctOptionIds.includes(answer.optionId)
      : exercise.solution.type === 'short_text' &&
        answer.type === 'short_text' &&
        exercise.solution.accepted.some(
          (variant) => normalize(variant, exercise) === normalize(answer.text, exercise),
        );
  return {
    correct,
    score: correct ? 1 : 0,
    maxScore: 1 as const,
    source: 'luch-engine' as const,
    engineVersion: ENGINE_VERSION,
    rubricId: exercise.rubric.id,
    rubricVersion: exercise.rubric.version,
    explanation: exercise.explanation,
  };
}
