import { t, dateLocale } from '../i18n';
import { UpcomingMeetings } from './meetings/shared';
import { TeacherUpdates } from './TeacherPages';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  diagnosticViewSchema,
  planViewSchema,
  runViewSchema,
  studentDashboardSchema,
  type DashboardAssignment,
  type StudentDashboard,
} from '@luch/contracts';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import {
  goalLabels,
  languageLabels,
  QuestionnaireSummary,
} from '../components/QuestionnaireSummary';
import { UserSummary } from './AccountPages';

type Action =
  | { kind: 'assignment'; planId: string; assignmentId: string }
  | { kind: 'diagnostic' }
  | { kind: 'plan'; diagnosticId: string };
const kindLabels = {
  initial: t('Урок маршрута'),
  correction: t('Дополнительная практика'),
  supported_practice: t('Практика самостоятельности'),
  review: t('Отсроченная проверка'),
  teacher: t('Назначение преподавателя'),
};
export function StudentPage() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { state, refresh } = useResource(
    `/student/dashboard?${new URLSearchParams({ timeZone })}`,
    studentDashboardSchema,
  );
  // Return visits, another tab's work and a review becoming due must refresh the saved state.
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (state.status !== 'ready') return;
    const future = state.data.reviews
      .filter((a) => !a.canStart && a.dueAt)
      .map((a) => new Date(a.dueAt!).getTime());
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(midnight.getTime(), ...future);
    const timer = setTimeout(refresh, Math.max(100, next - Date.now() + 100));
    return () => clearTimeout(timer);
  }, [state, refresh]);
  return (
    <>
      <h1>{t('Кабинет ученика')}</h1>
      {state.status === 'loading' ? (
        <LoadingState text={t('Загружаем ваш учебный день…')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <Dashboard data={state.data} refresh={refresh} />
      )}
    </>
  );
}

function Dashboard({ data, refresh }: { data: StudentDashboard; refresh: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [retryAction, setRetryAction] = useState<Action | null>(null);
  const { profile, plan, continueRun, nextAssignment, progress } = data;
  async function start(action: Action) {
    setBusy(true);
    setError(null);
    setRetryAction(action);
    try {
      if (action.kind === 'assignment') {
        const view = await api(
          `/plans/${action.planId}/assignments/${action.assignmentId}/start`,
          runViewSchema,
          { body: {} },
        );
        navigate(`/learning/runs/${view.run.id}`);
      } else if (action.kind === 'diagnostic' && profile) {
        const view = await api('/diagnostics', diagnosticViewSchema, {
          body: {
            profileRevision: profile.revision,
            restart: data.diagnostic?.status === 'completed',
          },
        });
        navigate(
          view.diagnostic.status === 'completed'
            ? `/diagnostics/${view.diagnostic.id}`
            : `/learning/runs/${view.diagnostic.runId}`,
        );
      } else if (action.kind === 'plan') {
        const view = await api('/plans', planViewSchema, {
          body: { diagnosticId: action.diagnosticId },
        });
        navigate(`/plan/${view.plan.id}`);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  function assignmentButton(a: DashboardAssignment, label = t('Начать задание')) {
    return a.runId ? (
      <Link className="button-link" to={`/learning/runs/${a.runId}`}>
        {t('Продолжить задание')}
      </Link>
    ) : (
      <button
        disabled={busy || !a.canStart}
        onClick={() => void start({ kind: 'assignment', planId: a.planId, assignmentId: a.id })}
      >
        {busy && retryAction?.kind === 'assignment' && retryAction.assignmentId === a.id
          ? t('Открываем…')
          : label}
      </button>
    );
  }
  const formatDate = (value: string) =>
    new Date(value).toLocaleString(dateLocale, {
      timeZone: data.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  function assignment(a: DashboardAssignment) {
    return (
      <li
        key={a.id}
        className="dashboard-assignment"
        data-testid="dashboard-assignment"
        data-kind={a.kind}
        data-id={a.id}
      >
        <div>
          <span className="badge">{kindLabels[a.kind]}</span>
          <h3>{a.title}</h3>
          <p>
            {a.estimatedMinutes} {t(' мин. ·')}{' '}
            {a.status === 'active'
              ? t('{0}/{1} заданий завершено', [a.completedSteps, a.totalSteps])
              : t('Не начато')}
          </p>
          <p className="muted">{a.kind === 'teacher' ? a.reason : t(a.reason)}</p>
          {a.dueAt && (
            <p>
              <time dateTime={a.dueAt}>{formatDate(a.dueAt)}</time> ·{' '}
              {a.canStart ? t('Доступно') : t('Откроется позже')}
            </p>
          )}
          <Link to={`/plan/${a.planId}#assignment-${a.id}`}>{t('Назначение в плане →')}</Link>
        </div>
        {assignmentButton(
          a,
          a.kind === 'review'
            ? t('Начать повторение')
            : a.kind === 'initial'
              ? t('Начать урок')
              : t('Начать практику'),
        )}
      </li>
    );
  }
  return (
    <>
      <section className="panel" aria-labelledby="learning-goal">
        <h2 id="learning-goal">
          {profile ? languageLabels[profile.language] : t('С чего начнём')}
        </h2>
        {(plan?.isDemo || continueRun?.isDemo) && (
          <p className="badge">{t('Демонстрационный контент')}</p>
        )}
        {profile ? (
          <p className="lead">
            {t('Цель: ')}
            <strong>{goalLabels[profile.goal]}</strong> · {profile.minutesPerDay}{' '}
            {t(' мин. в день')}
          </p>
        ) : (
          <p>
            {t(
              'Выберите язык, цель и время на занятия. После короткой диагностики появится ваш план.',
            )}
          </p>
        )}
        {continueRun ? (
          <div className="dashboard-next" data-testid="dashboard-next">
            <h3>{continueRun.title}</h3>
            <p>
              {continueRun.completedSteps}/{continueRun.totalSteps}{' '}
              {t(' заданий завершено. Ответы и черновик сохранены.')}
            </p>
            <Link className="button-link" to={`/learning/runs/${continueRun.id}`}>
              {continueRun.purpose === 'diagnostic'
                ? t('Продолжить диагностику →')
                : t('Продолжить урок →')}
            </Link>
          </div>
        ) : nextAssignment ? (
          <div className="dashboard-next" data-testid="dashboard-next">
            <h3>{nextAssignment.title}</h3>
            <p>
              {kindLabels[nextAssignment.kind]} · {nextAssignment.estimatedMinutes} {t(' мин.')}
            </p>
            {assignmentButton(nextAssignment, t('Начать следующее назначение'))}
          </div>
        ) : !profile ? (
          <Link className="button-link" to="/onboarding">
            {t('Заполнить анкету')}
          </Link>
        ) : !plan ? (
          data.diagnostic?.status === 'completed' &&
          data.diagnostic.profileRevision === profile.revision ? (
            <div>
              <p>
                {t('Диагностика завершена. Можно сформировать план по сохранённому результату.')}
              </p>
              <button
                disabled={busy}
                onClick={() => void start({ kind: 'plan', diagnosticId: data.diagnostic!.id })}
              >
                {t('Сформировать план')}
              </button>
            </div>
          ) : (
            <div>
              <p>{t('Пройдите короткую диагностику, чтобы получить первоначальный план.')}</p>
              <button disabled={busy} onClick={() => void start({ kind: 'diagnostic' })}>
                {busy ? t('Открываем диагностику…') : t('Начать диагностику')}
              </button>
            </div>
          )
        ) : (
          <p role="status">
            {plan.status === 'completed'
              ? t('Активных незавершённых назначений в плане нет.')
              : t('Доступные задания выполнены. Следующая проверка откроется в указанное время.')}
          </p>
        )}
        {profile && (
          <p>
            <Link to="/onboarding">{t('Изменить анкету и пройти диагностику →')}</Link>
          </p>
        )}
        {data.profileChangedSincePlan && plan && (
          <div className="notice">
            <p>{t('Анкета изменена. Текущий план сохраняет прежнюю цель и нагрузку:')}</p>
            <QuestionnaireSummary data={plan.questionnaire} />
            <Link to="/onboarding">{t('Обновить план через новую диагностику →')}</Link>
          </div>
        )}
      </section>
      {error && (
        <ErrorState
          error={error}
          retry={() => (retryAction ? void start(retryAction) : refresh())}
        />
      )}
      <section className="panel" aria-labelledby="today-heading">
        <h2 id="today-heading">{t('Задания на сегодня')}</h2>
        <p className="muted">
          {new Date(data.asOf).toLocaleDateString(dateLocale, {
            timeZone: data.timeZone,
            dateStyle: 'long',
          })}{' '}
          · {data.timeZone}
        </p>
        {plan && (
          <p>
            {t('Рекомендуемый день ')}
            {data.recommendedDay}
            {t('. Незавершённые задания предыдущих дней остаются в списке.')}
          </p>
        )}
        {data.today.length ? (
          <ul className="dashboard-list">{data.today.map(assignment)}</ul>
        ) : (
          <p>
            {plan
              ? t(
                  'Незавершённых уроков на сегодня нет. Повторения показаны отдельно; при желании можно перейти к следующему шагу плана.',
                )
              : t('Здесь появятся уроки и дополнительные упражнения из вашего плана.')}
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="reviews-heading">
        <h2 id="reviews-heading">{t('Назначенные повторения')}</h2>
        {data.reviews.length ? (
          <>
            <p className="muted">
              {t('Время указано для ')}
              {data.timeZone}
              {t('. Проверки открываются в назначенное время.')}
            </p>
            <ul className="dashboard-list">{data.reviews.map(assignment)}</ul>
          </>
        ) : (
          <p>{t('Повторения появятся после самостоятельных успешных ответов.')}</p>
        )}
      </section>
      <section className="panel" aria-labelledby="progress-heading">
        <h2 id="progress-heading">{t('Краткий прогресс')}</h2>
        <p>
          {t('Завершено уроков:')}{' '}
          <strong data-testid="dashboard-completed-lessons">{progress.completedLessons}</strong>
        </p>
        {plan && (
          <>
            <p>
              {t('В текущем плане завершено назначений:')}{' '}
              <strong>
                {plan.completedAssignments}/{plan.totalAssignments}
              </strong>
            </p>
            <progress
              aria-label={t('Выполнение текущего плана')}
              max={Math.max(1, plan.totalAssignments)}
              value={plan.completedAssignments}
            />
          </>
        )}
        <dl className="dashboard-stats" data-testid="dashboard-stats">
          <div>
            <dt>{t('Самостоятельно верно')}</dt>
            <dd>{progress.independentCorrect}</dd>
          </div>
          <div>
            <dt>{t('Верно с помощью')}</dt>
            <dd>{progress.assistedCorrect}</dd>
          </div>
          <div>
            <dt>{t('Попытки с ошибкой')}</dt>
            <dd>{progress.incorrectAttempts}</dd>
          </div>
        </dl>
        <p>
          {t('Проверено преподавателем: ')}
          {progress.teacherReviewedAttempts}
        </p>
        <p className="muted">
          {progress.evaluatedAttempts} {t(' проверенных попыток')}
          {profile ? ` · ${languageLabels[profile.language]}` : ''}
          {t(
            '. Повторные попытки учитываются отдельно. Учебные оценки предварительные и не подтверждают общий уровень языка.',
          )}
        </p>
        {progress.pendingEvaluationAttempts > 0 && (
          <p>
            {t('Ожидают завершения диагностики или контроля: ')}
            {progress.pendingEvaluationAttempts}
            {t('. Их оценки пока не включены в сводку.')}
          </p>
        )}
      </section>
      <UpcomingMeetings />
      <TeacherUpdates compact />
      <section className="panel" aria-labelledby="results-heading">
        <h2 id="results-heading">{t('Последние результаты')}</h2>
        {data.recentResults.length ? (
          <ul className="account-list" data-testid="dashboard-results">
            {data.recentResults.map((r) => (
              <li key={r.id}>
                <strong>{r.title}</strong>
                <span>
                  {r.correct === null
                    ? t('Ответ сохранён · оценка после завершения')
                    : r.correct
                      ? r.independent
                        ? t('Верно самостоятельно')
                        : t('Верно с помощью')
                      : t('Есть ошибка')}
                </span>
                {r.teacherReviewed && (
                  <span className="badge">{t('Проверено преподавателем')}</span>
                )}
                <time dateTime={r.evaluatedAt}>{formatDate(r.evaluatedAt)}</time>
                <Link to={`/learning/runs/${r.runId}`}>{t('Открыть ответ →')}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={t('Пока нет ответов')}
            description={t('После первого ответа здесь появится сохранённый результат.')}
          />
        )}
        <p>
          <Link to="/learning">{t('Все прохождения и ответы →')}</Link>
        </p>
      </section>
      <nav className="next-grid" aria-label={t('Разделы ученика')}>
        <Link to={plan ? `/plan/${plan.id}` : '/plan'}>
          <strong>{t('Мой план')}</strong>
          <span>{t('Назначения и причины изменений →')}</span>
        </Link>
        <Link to="/assistant">
          <strong>{t('Помощник')}</strong>
          <span>{t('Персонаж, объяснения и переписка →')}</span>
        </Link>
        <Link to="/schedule">
          <strong>{t('Расписание')}</strong>
          <span>{t('Занятия с преподавателем →')}</span>
        </Link>
        <Link to="/progress">
          <strong>{t('Учебный отчёт')}</strong>
          <span>{t('Прогресс и результаты →')}</span>
        </Link>
      </nav>
      <details className="panel">
        <summary>{t('Профиль и доступ')}</summary>
        <UserSummary user={data.user} />
      </details>
      <p>
        <Link to="/courses">{t('Учебные маршруты →')}</Link>
      </p>
    </>
  );
}
