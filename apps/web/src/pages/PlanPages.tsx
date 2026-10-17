import { StudentDirectory } from '../components/StudentDirectory';
import { TeacherAssignExercise, TeacherEditAssignment } from '../components/TeacherPlanControls';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { planViewSchema, plansPageSchema, runViewSchema } from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { QuestionnaireSummary, languageLabels } from '../components/QuestionnaireSummary';
import { SkillStates, PlanChanges } from './AdaptationViews';

const statusLabels = {
  pending: 'Не начато',
  active: 'В процессе',
  completed: 'Завершено',
  cancelled: 'Отменено преподавателем',
};
const kindLabels = {
  initial: 'Шаг маршрута',
  correction: 'Дополнительная практика',
  supported_practice: 'Практика самостоятельности',
  review: 'Отсроченная проверка',
  teacher: 'Назначение преподавателя',
};
export function DiagnosticPlanLink({
  diagnosticId,
  planId,
  writable,
}: {
  diagnosticId: string;
  planId: string | null;
  writable: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const view = await api('/plans', planViewSchema, { body: { diagnosticId } });
      navigate(`/plan/${view.plan.id}`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Индивидуальный план</h2>
      {planId ? (
        <>
          <p>План сохранён по этой диагностике. У каждого урока есть причина назначения.</p>
          <Link className="button-link" to={`/plan/${planId}`}>
            Открыть индивидуальный план →
          </Link>
        </>
      ) : writable ? (
        <>
          <p>
            По этому результату план ещё не создан. Сформируйте его из сохранённой анкеты и
            тренировочных уроков.
          </p>
          <button disabled={busy} onClick={() => void generate()}>
            {busy ? 'Формируем план…' : 'Сформировать индивидуальный план'}
          </button>
        </>
      ) : (
        <p>План по этой диагностике ещё не создан.</p>
      )}
      {error && <ErrorState error={error} retry={() => void generate()} />}
    </section>
  );
}
export function PlanOverview({ userId }: { userId: string }) {
  const { state, refresh } = useResource(`/plans?userId=${userId}&limit=1`, plansPageSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const latest = state.data.items[0];
  return (
    <section className="panel">
      <h2>Индивидуальный план</h2>
      {latest ? (
        <>
          <QuestionnaireSummary data={latest.questionnaire} />
          <p>
            Завершено назначений: {latest.completedAssignments}/{latest.totalAssignments} ·{' '}
            {statusLabels[latest.status]}
          </p>
          <Link to={`/plan/${latest.id}`}>Открыть план и назначения →</Link>
        </>
      ) : (
        <p>План появится после завершения входной диагностики.</p>
      )}
      <p>
        <Link to={`/plan?userId=${userId}`}>Все сохранённые планы →</Link>
      </p>
    </section>
  );
}
export function PlansPage() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const userId =
    params.get('userId') ?? (session.user!.role === 'student' ? session.user!.id : null);
  return (
    <>
      <h1>Индивидуальные планы</h1>
      {userId ? <PlanHistory key={userId} userId={userId} /> : <StudentDirectory path="/plan" />}
    </>
  );
}
function PlanHistory({ userId }: { userId: string }) {
  const [page, setPage] = useState<z.infer<typeof plansPageSchema> | null>(null);
  const [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setPage(null);
    void api(`/plans?userId=${userId}`, plansPageSchema, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setPage(data);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e);
      });
    return () => controller.abort();
  }, [userId, revision]);
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        userId,
        beforeCreatedAt: page.nextCursor.createdAt,
        beforeId: page.nextCursor.id,
      });
      const data = await api(`/plans?${query}`, plansPageSchema);
      setPage({ ...data, items: [...page.items, ...data.items] });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!page && !error && <LoadingState text="Загружаем планы…" />}
      {error && (
        <ErrorState error={error} retry={() => (page ? void more() : setRevision((r) => r + 1))} />
      )}
      {page && (
        <>
          <p>
            {page.user.name} · {page.user.email}
          </p>
          {!page.items.length ? (
            <>
              <EmptyState
                title="План ещё не сформирован"
                description="Завершите входную диагностику. План сохранится автоматически."
              />
              <Link to={`/onboarding?userId=${userId}`}>Анкета и диагностика →</Link>
            </>
          ) : (
            <ul className="account-list">
              {page.items.map((p) => (
                <li key={p.id}>
                  <strong>{languageLabels[p.questionnaire.language]}</strong>
                  <QuestionnaireSummary data={p.questionnaire} />
                  <span>
                    {p.completedAssignments}/{p.totalAssignments} назначений завершено ·{' '}
                    {statusLabels[p.status]}
                  </span>
                  <span>{new Date(p.createdAt).toLocaleString('ru-RU')}</span>
                  <Link to={`/plan/${p.id}`}>План и последовательность уроков →</Link>
                </li>
              ))}
            </ul>
          )}
          {page.nextCursor && (
            <button className="secondary" disabled={busy} onClick={() => void more()}>
              Показать предыдущие планы
            </button>
          )}
        </>
      )}
    </>
  );
}
export function PlanDetailPage() {
  const { id } = useParams();
  return <PlanDetail key={id} id={id!} />;
}
function PlanDetail({ id }: { id: string }) {
  const { session } = useAuth();
  const { state, refresh } = useResource(`/plans/${id}`, planViewSchema, true);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [adminControl, setAdminControl] = useState(false);
  const [retryAssignmentId, setRetryAssignmentId] = useState<string | null>(null);
  async function start(assignmentId: string) {
    setBusy(true);
    setError(null);
    setRetryAssignmentId(assignmentId);
    try {
      const view = await api(`/plans/${id}/assignments/${assignmentId}/start`, runViewSchema, {
        body: {},
      });
      navigate(`/learning/runs/${view.run.id}`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState text="Загружаем индивидуальный план…" />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const { plan, assignments, writable, nextAssignmentId } = state.data;
  const own = session.user!.id === plan.user.id,
    editable = writable && (own || adminControl);
  const next = assignments.find((a) => a.id === nextAssignmentId);
  return (
    <>
      <Link to={`/plan?userId=${plan.user.id}`}>← Сохранённые планы</Link>
      <p className="eyebrow">
        Индивидуальный план{plan.isDemo ? ' · демонстрационный контент' : ''}
      </p>
      <h1>Индивидуальный план</h1>
      <p>
        {plan.user.name} · {plan.user.email}
      </p>
      <QuestionnaireSummary data={plan.questionnaire} />
      <section className="notice">
        <p>
          Сначала — навыки, вызвавшие затруднения в предварительной диагностике, затем — практика по
          цели и остальные шаги маршрута.
        </p>
        <p>
          Новые ответы добавляют практику и повторения. Подсказки и помощь учитываются отдельно от
          самостоятельного успеха.
        </p>
        <p>
          Рекомендуемое распределение: {plan.recommendedDays} дн. При нехватке времени урок можно
          прервать и продолжить. Это ориентир без обязательных дат.
        </p>
      </section>
      <p>
        Завершено назначений:{' '}
        <strong>
          {plan.completedAssignments}/{plan.totalAssignments}
        </strong>{' '}
        · {statusLabels[plan.status]}
      </p>
      {plan.cancelledAssignments > 0 && (
        <p>
          Отменено преподавателем: {plan.cancelledAssignments}. Отменённые задания не входят в
          счётчик выполнения.
        </p>
      )}
      <progress
        max={Math.max(1, plan.totalAssignments)}
        value={plan.completedAssignments}
        aria-label="Выполнение плана"
      />
      {!own && writable && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={adminControl}
            onChange={(e) => setAdminControl(e.target.checked)}
          />
          Управлять планом пользователя
        </label>
      )}
      {!writable && (
        <p className="muted">Просмотр плана ученика. Ответы и начало уроков доступны ученику.</p>
      )}
      {next && editable && (
        <p>
          <button disabled={busy} onClick={() => void start(next.id)}>
            {busy
              ? 'Открываем урок…'
              : next.status === 'active'
                ? 'Продолжить назначенный урок'
                : next.kind === 'correction'
                  ? 'Начать дополнительную практику'
                  : next.kind === 'review'
                    ? 'Начать отсроченную проверку'
                    : next.kind === 'supported_practice'
                      ? 'Потренироваться самостоятельно'
                      : 'Начать следующее назначение'}
          </button>
        </p>
      )}
      {!next && (
        <p role="status">
          {plan.totalAssignments === 0
            ? 'Активных назначений в плане нет. Преподаватель может добавить новую практику.'
            : plan.status === 'completed'
              ? 'Активных незавершённых назначений в плане нет. Результаты доступны в уроках.'
              : 'Готовых назначений сейчас нет. Повторения откроются в указанное время.'}
        </p>
      )}
      {error && (
        <ErrorState
          error={error}
          retry={() => (editable && retryAssignmentId ? void start(retryAssignmentId) : refresh())}
        />
      )}
      {state.data.manageable && <TeacherAssignExercise plan={state.data} changed={refresh} />}
      <ol className="plan-list">
        {assignments.map((a) => (
          <li
            key={a.id}
            id={`assignment-${a.id}`}
            className="panel"
            data-testid="plan-assignment"
            data-status={a.status}
            data-kind={a.kind}
          >
            <p className="eyebrow">
              Шаг {a.position + 1} · рекомендуемый день {a.recommendedDay}
            </p>
            <p className="badge">{kindLabels[a.kind]}</p>
            <h2>{a.title}</h2>
            <p>
              <span className="badge">{statusLabels[a.status]}</span> · {a.estimatedMinutes} мин. ·{' '}
              {a.completedSteps}/{a.exercises.length} заданий завершено
            </p>
            <p>
              <strong>Причина назначения:</strong> {a.reason.text}
            </p>
            {a.reason.goalMatched &&
              (a.reason.kind === 'diagnostic_gap' || a.reason.kind === 'guided_success') && (
                <p className="muted">Также соответствует выбранной учебной цели.</p>
              )}
            {a.completedAt && (
              <p className="muted">Завершено: {new Date(a.completedAt).toLocaleString('ru-RU')}</p>
            )}
            {a.dueAt && (
              <p className="muted">
                Время повторения:{' '}
                <time dateTime={a.dueAt}>{new Date(a.dueAt).toLocaleString('ru-RU')}</time>
                {!a.canStart ? ' · пока недоступно' : ''}
              </p>
            )}
            {a.teacherNote && (
              <p className="content-text">
                <strong>Комментарий преподавателя:</strong> {a.teacherNote}
              </p>
            )}
            {state.data.manageable && (
              <TeacherEditAssignment
                key={`edit:${a.id}:${a.revision}`}
                planId={id}
                assignment={a}
                changed={refresh}
              />
            )}
            {a.status === 'cancelled' ? (
              <p>Назначение отменено. Оно сохранено в истории и не считается выполненным.</p>
            ) : a.status === 'completed' ? (
              <Link to={`/learning/runs/${a.runId}`}>Результаты урока →</Link>
            ) : editable ? (
              <button
                className="secondary"
                disabled={busy || !a.canStart}
                onClick={() => void start(a.id)}
              >
                {a.status === 'active'
                  ? 'Продолжить урок'
                  : a.dueAt && new Date(a.dueAt).getTime() > Date.now() && !own
                    ? 'Открыть досрочно (отладка)'
                    : a.kind === 'initial'
                      ? 'Начать урок'
                      : 'Начать задание'}
              </button>
            ) : (
              a.runId && <Link to={`/learning/runs/${a.runId}`}>Посмотреть прохождение →</Link>
            )}
          </li>
        ))}
      </ol>
      <PlanChanges
        key={state.data.assignments.map((a) => `${a.id}:${a.revision}`).join(',')}
        id={plan.id}
      />
      <SkillStates userId={plan.user.id} />
      <p>
        <Link to={`/diagnostics/${plan.diagnosticId}`}>Диагностика, на которой основан план →</Link>
      </p>
      <p className="muted">
        Анкета v{plan.profileRevision} · пакет {plan.packageId} v{plan.packageVersion} · правила{' '}
        {plan.rulesVersion}. Создан {new Date(plan.createdAt).toLocaleString('ru-RU')}.
      </p>
      <p className="muted">
        Изменение анкеты не меняет сохранённый план. Новая завершённая диагностика создаёт отдельный
        план.
      </p>
    </>
  );
}
