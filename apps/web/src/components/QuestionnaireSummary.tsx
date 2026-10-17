import { t } from '../i18n';
import type { Questionnaire } from '@luch/contracts';

export const languageLabels = { ru: t('Русский как иностранный'), en: t('Английский') };
export const goalLabels = {
  daily_life: t('Повседневное общение'),
  travel: t('Путешествия'),
  work: t('Работа'),
  study: t('Учёба'),
};
export const experienceLabels = {
  none: t('Начинаю с нуля'),
  some: t('Уже немного изучал(а)'),
  regular: t('Изучаю или использую регулярно'),
};
export function QuestionnaireSummary({ data }: { data: Questionnaire }) {
  return (
    <p>
      {languageLabels[data.language]} · {goalLabels[data.goal]} ·{' '}
      {experienceLabels[data.experience]} · {data.minutesPerDay} {t(' мин. в день')}
    </p>
  );
}
