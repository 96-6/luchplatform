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
  initial: 'Урок маршрута',
  correction: 'Дополнительная практика',
  supported_practice: 'Практика самостоятельности',
  review: 'Отсроченная проверка',
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
      <p className="eyebrow">Ваше пространство</p>
      <h1>Кабинет ученика</h1>
      {state.status === 'loading' ? (
        <LoadingState text="Загружаем ваш учебный день…" />
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
  function assignmentButton(a: DashboardAssignment, label = 'Начать задание') {
    return a.runId ? (
      <Link className="button-link" to={`/learning/runs/${a.runId}`}>
        Продолжить задание
      </Link>
    ) : (
      <button
        disabled={busy || !a.canStart}
        onClick={() => void start({ kind: 'assignment', planId: a.planId, assignmentId: a.id })}
      >
        {busy && retryAction?.kind === 'assignment' && retryAction.assignmentId === a.id
          ? 'Открываем…'
          : label}
      </button>
    );
  }
  const formatDate = (value: string) =>
    new Date(value).toLocaleString('ru-RU', {
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
            {a.estimatedMinutes} мин. ·{' '}
            {a.status === 'active'
              ? `${a.completedSteps}/${a.totalSteps} заданий завершено`
              : 'Не начато'}
          </p>
          <p className="muted">{a.reason}</p>
          {a.dueAt && (
            <p>
              <time dateTime={a.dueAt}>{formatDate(a.dueAt)}</time> ·{' '}
              {a.canStart ? 'Доступно' : 'Откроется позже'}
            </p>
          )}
          <Link to={`/plan/${a.planId}#assignment-${a.id}`}>Назначение в плане →</Link>
        </div>
        {assignmentButton(
          a,
          a.kind === 'review'
            ? 'Начать повторение'
            : a.kind === 'initial'
              ? 'Начать урок'
              : 'Начать практику',
        )}
      </li>
    );
  }
  return (
    <>
      <section className="panel" aria-labelledby="learning-goal">
        <h2 id="learning-goal">{profile ? languageLabels[profile.language] : 'С чего начнём'}</h2>
        {(plan?.isDemo || continueRun?.isDemo) && <p className="badge">Демонстрационный контент</p>}
        {profile ? (
          <p className="lead">
            Цель: <strong>{goalLabels[profile.goal]}</strong> · {profile.minutesPerDay} мин. в день
          </p>
        ) : (
          <p>
            Выберите язык, цель и время на занятия. После короткой диагностики появится ваш план.
          </p>
        )}
        {continueRun ? (
          <div className="dashboard-next" data-testid="dashboard-next">
            <h3>{continueRun.title}</h3>
            <p>
              {continueRun.completedSteps}/{continueRun.totalSteps} заданий завершено. Ответы и
              черновик сохранены.
            </p>
            <Link className="button-link" to={`/learning/runs/${continueRun.id}`}>
              {continueRun.purpose === 'diagnostic'
                ? 'Продолжить диагностику →'
                : 'Продолжить урок →'}
            </Link>
          </div>
        ) : nextAssignment ? (
          <div className="dashboard-next" data-testid="dashboard-next">
            <h3>{nextAssignment.title}</h3>
            <p>
              {kindLabels[nextAssignment.kind]} · {nextAssignment.estimatedMinutes} мин.
            </p>
            {assignmentButton(nextAssignment, 'Начать следующее назначение')}
          </div>
        ) : !profile ? (
          <Link className="button-link" to="/onboarding">
            Заполнить анкету
          </Link>
        ) : !plan ? (
          data.diagnostic?.status === 'completed' &&
          data.diagnostic.profileRevision === profile.revision ? (
            <div>
              <p>Диагностика завершена. Можно сформировать план по сохранённому результату.</p>
              <button
                disabled={busy}
                onClick={() => void start({ kind: 'plan', diagnosticId: data.diagnostic!.id })}
              >
                Сформировать план
              </button>
            </div>
          ) : (
            <div>
              <p>Пройдите короткую диагностику, чтобы получить первоначальный план.</p>
              <button disabled={busy} onClick={() => void start({ kind: 'diagnostic' })}>
                {busy ? 'Открываем диагностику…' : 'Начать диагностику'}
              </button>
            </div>
          )
        ) : (
          <p role="status">
            {plan.status === 'completed'
              ? 'Все назначения плана завершены.'
              : 'Доступные задания выполнены. Следующая проверка откроется в указанное время.'}
          </p>
        )}
        {profile && (
          <p>
            <Link to="/onboarding">Изменить анкету и пройти диагностику →</Link>
          </p>
        )}
        {data.profileChangedSincePlan && plan && (
          <div className="notice">
            <p>Анкета изменена. Текущий план сохраняет прежнюю цель и нагрузку:</p>
            <QuestionnaireSummary data={plan.questionnaire} />
            <Link to="/onboarding">Обновить план через новую диагностику →</Link>
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
        <h2 id="today-heading">Задания на сегодня</h2>
        <p className="muted">
          {new Date(data.asOf).toLocaleDateString('ru-RU', {
            timeZone: data.timeZone,
            dateStyle: 'long',
          })}{' '}
          · {data.timeZone}
        </p>
        {plan && (
          <p>
            Рекомендуемый день {data.recommendedDay}. Незавершённые задания предыдущих дней остаются
            в списке. Распределение можно проходить в своём темпе.
          </p>
        )}
        {data.today.length ? (
          <ul className="dashboard-list">{data.today.map(assignment)}</ul>
        ) : (
          <p>
            {plan
              ? 'Незавершённых уроков на сегодня нет. Повторения показаны отдельно; при желании можно перейти к следующему шагу плана.'
              : 'Здесь появятся уроки и дополнительные упражнения из вашего плана.'}
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="reviews-heading">
        <h2 id="reviews-heading">Назначенные повторения</h2>
        {data.reviews.length ? (
          <>
            <p className="muted">
              Время указано для {data.timeZone}. Проверки открываются в назначенное время.
            </p>
            <ul className="dashboard-list">{data.reviews.map(assignment)}</ul>
          </>
        ) : (
          <p>Повторения появятся после самостоятельных успешных ответов.</p>
        )}
      </section>
      <section className="panel" aria-labelledby="progress-heading">
        <h2 id="progress-heading">Краткий прогресс</h2>
        <p>
          Завершено уроков:{' '}
          <strong data-testid="dashboard-completed-lessons">{progress.completedLessons}</strong>
        </p>
        {plan && (
          <>
            <p>
              В текущем плане завершено назначений:{' '}
              <strong>
                {plan.completedAssignments}/{plan.totalAssignments}
              </strong>
            </p>
            <progress
              aria-label="Выполнение текущего плана"
              max={plan.totalAssignments}
              value={plan.completedAssignments}
            />
          </>
        )}
        <dl className="dashboard-stats" data-testid="dashboard-stats">
          <div>
            <dt>Самостоятельно верно</dt>
            <dd>{progress.independentCorrect}</dd>
          </div>
          <div>
            <dt>Верно с помощью</dt>
            <dd>{progress.assistedCorrect}</dd>
          </div>
          <div>
            <dt>Попытки с ошибкой</dt>
            <dd>{progress.incorrectAttempts}</dd>
          </div>
        </dl>
        <p className="muted">
          {progress.evaluatedAttempts} проверенных попыток
          {profile ? ` · ${languageLabels[profile.language]}` : ''}. Повторные попытки учитываются
          отдельно. Учебные оценки предварительные и не подтверждают общий уровень языка.
        </p>
        {progress.pendingEvaluationAttempts > 0 && (
          <p>
            Ожидают завершения диагностики или контроля: {progress.pendingEvaluationAttempts}. Их
            оценки пока не включены в сводку.
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="results-heading">
        <h2 id="results-heading">Последние результаты</h2>
        {data.recentResults.length ? (
          <ul className="account-list" data-testid="dashboard-results">
            {data.recentResults.map((r) => (
              <li key={r.id}>
                <strong>{r.title}</strong>
                <span>
                  {r.correct === null
                    ? 'Ответ сохранён · оценка после завершения'
                    : r.correct
                      ? r.independent
                        ? 'Верно самостоятельно'
                        : 'Верно с помощью'
                      : 'Есть ошибка'}
                </span>
                <time dateTime={r.evaluatedAt}>{formatDate(r.evaluatedAt)}</time>
                <Link to={`/learning/runs/${r.runId}`}>Открыть ответ →</Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Пока нет ответов"
            description="После первого ответа здесь появится сохранённый результат."
          />
        )}
        <p>
          <Link to="/learning">Все прохождения и ответы →</Link>
        </p>
      </section>
      <nav className="next-grid" aria-label="Разделы ученика">
        <Link to={plan ? `/plan/${plan.id}` : '/plan'}>
          <strong>Мой план</strong>
          <span>Назначения и причины изменений →</span>
        </Link>
        <Link to="/assistant">
          <strong>Помощник</strong>
          <span>Персонаж, объяснения и переписка →</span>
        </Link>
        <Link to="/schedule">
          <strong>Расписание</strong>
          <span>Занятия с преподавателем →</span>
        </Link>
        <Link to="/progress">
          <strong>Учебный отчёт</strong>
          <span>Прогресс и результаты →</span>
        </Link>
      </nav>
      <details className="panel">
        <summary>Профиль и доступ</summary>
        <UserSummary user={data.user} />
      </details>
      <p>
        <Link to="/courses">Учебные маршруты →</Link>
      </p>
    </>
  );
}
