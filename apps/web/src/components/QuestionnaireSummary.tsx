import type { Questionnaire } from '@luch/contracts';

export const languageLabels = { ru: 'Русский как иностранный', en: 'Английский' };
export const goalLabels = {
  daily_life: 'Повседневное общение',
  travel: 'Путешествия',
  work: 'Работа',
  study: 'Учёба',
};
export const experienceLabels = {
  none: 'Начинаю с нуля',
  some: 'Уже немного изучал(а)',
  regular: 'Изучаю или использую регулярно',
};
export function QuestionnaireSummary({ data }: { data: Questionnaire }) {
  return (
    <p>
      {languageLabels[data.language]} · {goalLabels[data.goal]} ·{' '}
      {experienceLabels[data.experience]} · {data.minutesPerDay} мин. в день
    </p>
  );
}
