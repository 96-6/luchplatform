import { t } from '../i18n';
import type { IntegrityAssessment } from '@luch/contracts';

export function IntegrityFlag({
  assessment,
}: {
  assessment: IntegrityAssessment | null | undefined;
}) {
  if (
    !assessment ||
    (!assessment.requiresReview &&
      !assessment.stats.tabHides &&
      !assessment.stats.focusLosses &&
      !assessment.signals.length)
  )
    return null;
  const detail = [
    assessment.stats.tabHides ? t('Уход с вкладки: {0}', [assessment.stats.tabHides]) : '',
    assessment.stats.focusLosses ? t('Потеря фокуса: {0}', [assessment.stats.focusLosses]) : '',
    ...assessment.signals.map((signal) => `${t(signal.label)}: ${t(signal.context)}`),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span
      className="integrity-flag"
      role="img"
      aria-label={t('Требует внимания преподавателя')}
      title={detail}
      data-testid="integrity-flag"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m12 3 10 18H2Z" />
        <path d="M12 9v5m0 3v1" />
      </svg>
      <span>{t('Требует внимания')}</span>
    </span>
  );
}
