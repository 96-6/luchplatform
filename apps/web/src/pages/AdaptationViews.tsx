import { t, dateLocale } from '../i18n';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { skillStatesSchema, planChangesPageSchema } from '@luch/contracts';
import type { z } from 'zod';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { LoadingState, ErrorState } from '../components/States';
const stateLabels = {
  learning: t('Первые наблюдения'),
  needs_practice: t('Нужна практика'),
  supported: t('Успех с помощью'),
  demonstrated: t('Самостоятельный успех'),
  confirmed: t('Подтверждён повторением'),
};
const outcomeLabels = {
  mistake: t('Ошибка'),
  independent_success: t('Самостоятельный успех'),
  hinted_success: t('Успех с подсказкой'),
  assisted_success: t('Успех с помощью / после обратной связи'),
};
export function SkillStates({ userId }: { userId: string }) {
  const { state, refresh } = useResource(`/learning/skills?userId=${userId}`, skillStatesSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>{t('Состояние навыков')}</h2>
      <p className="muted">
        {t(
          'Наблюдения по фактическим ответам. Демонстрационные результаты не подтверждают уровень языка.',
        )}
      </p>
      {!state.data.items.length ? (
        <p>{t('Пока нет завершённых проверок или тренировочных ответов.')}</p>
      ) : (
        <ul className="skill-state-list">
          {state.data.items.map((s) => (
            <li key={`${s.packageId}:${s.packageVersion}:${s.skillId}`} data-testid="skill-state">
              <h3>{s.title}</h3>
              <p>
                <span className="badge">{stateLabels[s.status]}</span> · {s.packageId} v
                {s.packageVersion}
              </p>
              <p>
                {t('Самостоятельно: ')}
                {s.independentSuccesses} {t(' · С подсказкой: ')}
                {s.hintedSuccesses} {t(' · С другой помощью: ')}
                {s.assistedSuccesses} {t(' · Ошибки: ')}
                {s.mistakes}
              </p>
              <p className="muted">
                {t('Диагностических ответов: ')}
                {s.diagnosticAttempts} {t(' · Контрольных: ')}
                {s.controlAttempts} {t(' · Последний результат: ')}
                {outcomeLabels[s.lastOutcome]}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
const teacherChangeLabels: Record<string, string> = {
  teacher_assignment_added: t('Назначение преподавателя'),
  teacher_assignment_rescheduled: t('Изменён срок задания'),
  teacher_assignment_cancelled: t('Назначение отменено'),
  assessment_reviewed: t('Проверка преподавателя'),
};
export function PlanChanges({ id }: { id: string }) {
  const [page, setPage] = useState<z.infer<typeof planChangesPageSchema> | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    setError(null);
    void api(`/plans/${id}/history`, planChangesPageSchema, { signal: c.signal })
      .then((p) => {
        if (!c.signal.aborted) setPage(p);
      })
      .catch((e: Error) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [id, revision]);
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({
          beforeCreatedAt: page.nextCursor.createdAt,
          beforeId: page.nextCursor.id,
        }),
        next = await api(`/plans/${id}/history?${q}`, planChangesPageSchema);
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t('История изменений плана')}</h2>
      {!page && !error && <LoadingState />}
      {error && (
        <ErrorState error={error} retry={() => (page ? void more() : setRevision((r) => r + 1))} />
      )}
      {page &&
        (!page.items.length ? (
          <p>{t('Изменений после диагностики пока нет. Они появятся по результатам практики.')}</p>
        ) : (
          <ol className="change-list">
            {page.items.map((c) => (
              <li key={c.id} data-testid="plan-change">
                <p>
                  <strong>
                    {teacherChangeLabels[c.action] ??
                      (c.outcome ? outcomeLabels[c.outcome] : t('Решение преподавателя'))}
                  </strong>{' '}
                  ·{' '}
                  <time dateTime={c.createdAt}>
                    {new Date(c.createdAt).toLocaleString(dateLocale)}
                  </time>
                </p>
                {c.createdByName && (
                  <p className="muted">
                    {t('Автор: ')}
                    {c.createdByName}
                  </p>
                )}
                <p className="content-text">
                  {c.action.startsWith('teacher_') ? c.reason : t(c.reason)}
                </p>
                {c.assignmentId && (
                  <Link to={`/plan/${id}#assignment-${c.assignmentId}`}>{t('Назначение →')}</Link>
                )}
                <p className="muted">
                  {t('Навык: ')}
                  {c.skillName}
                </p>
              </li>
            ))}
          </ol>
        ))}
      {page?.nextCursor && (
        <button className="secondary" disabled={busy} onClick={() => void more()}>
          {t('Предыдущие изменения')}
        </button>
      )}
    </section>
  );
}
