import { t, dateLocale } from '../i18n';
import { IntegrityFlag } from '../components/IntegrityFlag';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  runViewSchema,
  runsPageSchema,
  submitResultSchema,
  integrityPolicySchema,
  type Answer,
  type DraftAnswer,
  type EngineAttempt,
  type RunView,
} from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { LoadingState, ErrorState, EmptyState } from '../components/States';
import { ContentBlocks } from './ContentPages';
import { monitorIntegrity } from '../lib/integrity';
import { useResource } from '../lib/useResource';
import { VoiceAnswer } from '../components/VoiceAnswer';
import { AssistantChat } from '../components/AssistantChat';
import { ListeningPlayer } from '../components/ListeningPlayer';

const labels = { practice: t('Тренировка'), diagnostic: t('Диагностика'), control: t('Контроль') };
export function RunList({
  userId,
  title = t('Сохранённые уроки'),
}: {
  userId?: string | undefined;
  title?: string;
}) {
  const [page, setPage] = useState<ReturnType<typeof runsPageSchema.parse> | null>(null);
  const [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async (more = false) => {
      setBusy(true);
      setError(null);
      try {
        const query = new URLSearchParams();
        if (userId) query.set('userId', userId);
        if (more && page?.nextCursor) {
          query.set('beforeCreatedAt', page.nextCursor.createdAt);
          query.set('beforeId', page.nextCursor.id);
        }
        const result = await api(`/engine/runs?${query}`, runsPageSchema);
        setPage((previous) => ({
          ...result,
          items: more && previous ? [...previous.items, ...result.items] : result.items,
        }));
      } catch (failure) {
        setError(failure as Error);
      } finally {
        setBusy(false);
      }
    },
    [userId, page?.nextCursor],
  );
  useEffect(() => {
    void load();
  }, [userId]);
  return (
    <section className="panel">
      <h2>{title}</h2>
      {error ? (
        <ErrorState error={error} retry={() => void load()} />
      ) : !page ? (
        <LoadingState />
      ) : page.items.length ? (
        <>
          <ul className="account-list">
            {page.items.map((run) => (
              <li key={run.id}>
                <div>
                  <strong>{run.title}</strong>
                  <p>
                    {run.user.name} · {labels[run.purpose]} · {run.completedSteps}/{run.totalSteps}{' '}
                    {t('заданий · ')}
                    {run.status === 'completed' ? t('Завершено') : t('В процессе')}
                  </p>
                  <small>
                    {t('Версия ')}
                    {run.packageVersion} {t(' · Прохождение ')}
                    {run.cycle}
                  </small>
                </div>
                <Link to={`/learning/runs/${run.id}`}>
                  {run.status === 'active' ? t('Продолжить урок →') : t('Посмотреть результаты →')}
                </Link>
              </li>
            ))}
          </ul>
          {page.nextCursor && (
            <button className="secondary" disabled={busy} onClick={() => void load(true)}>
              {t('Загрузить ещё')}
            </button>
          )}
        </>
      ) : (
        <EmptyState
          title={t('Прохождений пока нет')}
          description={t('Откройте маршрут, выберите урок и начните тренировку.')}
        />
      )}
    </section>
  );
}
export function EngineHistoryPage() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  return (
    <>
      <h1>{session.user?.role === 'superadmin' ? t('Все прохождения') : t('Обучение')}</h1>
      <Link to="/courses">{t('Выбрать учебный маршрут →')}</Link>
      <RunList userId={params.get('userId') ?? undefined} />
    </>
  );
}
export function StartLessonButton({
  packageId,
  packageVersion,
  lessonId,
  purpose,
}: {
  packageId: string;
  packageVersion: number;
  lessonId: string;
  purpose: 'practice' | 'diagnostic' | 'control';
}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function start() {
    setBusy(true);
    setError('');
    try {
      const view = await api('/engine/runs', runViewSchema, {
        body: { packageId, packageVersion, source: { type: 'lesson', id: lessonId, purpose } },
      });
      navigate(`/learning/runs/${view.run.id}`);
    } catch (failure) {
      setError(t((failure as Error).message));
    } finally {
      setBusy(false);
    }
  }
  if (!['student', 'superadmin'].includes(session.user?.role ?? ''))
    return (
      <p className="muted">
        {t('Предварительный просмотр материалов.')}
        {session.user?.role !== 'admin' && (
          <>
            {' '}
            <Link to="/plan">{t('Открыть планы учеников →')}</Link>
          </>
        )}
      </p>
    );
  return (
    <div className="start-lesson">
      <button disabled={busy} onClick={() => void start()}>
        {busy
          ? t('Открываем…')
          : session.user?.role === 'superadmin'
            ? t('Проверить учебный движок')
            : purpose === 'practice'
              ? t('Начать или продолжить тренировку')
              : t('Начать или продолжить проверку')}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
export function ExerciseRunPage() {
  const { id } = useParams();
  return <RunSession key={id} id={id!} />;
}
function RunSession({ id }: { id: string }) {
  const [voiceBusy, setVoiceBusy] = useState(false);
  const { session } = useAuth();
  const [view, setView] = useState<RunView | null>(null),
    [error, setError] = useState<Error | null>(null);
  const [adminControl, setAdminControl] = useState(false),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(async () => {
    try {
      setError(null);
      setView(await api(`/engine/runs/${id}`, runViewSchema));
    } catch (failure) {
      setError(failure as Error);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const action = async (name: 'next' | 'retry', turnId: string) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api(`/engine/runs/${id}/${name}`, runViewSchema, { body: { turnId } }));
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  };
  async function restart() {
    if (!view) return;
    if (view.run.diagnosticId) {
      navigate(`/onboarding?userId=${view.run.user.id}`);
      return;
    }
    if (view.run.sourceType === 'assignment') {
      navigate(`/plan/${view.run.planIds[0]}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api('/engine/runs', runViewSchema, {
        body: {
          packageId: view.run.packageId,
          packageVersion: view.run.packageVersion,
          source:
            view.run.sourceType === 'lesson'
              ? { type: 'lesson', id: view.run.sourceId, purpose: view.run.purpose }
              : { type: 'set', id: view.run.sourceId },
          userId: view.run.user.id,
          restart: true,
        },
      });
      navigate(`/learning/runs/${result.run.id}`);
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return error ? <ErrorState error={error} retry={() => void load()} /> : <LoadingState />;
  const own = session.user!.id === view.run.user.id,
    editable = view.writable && (own || adminControl);
  return (
    <>
      <Link to="/learning">{t('← Сохранённые уроки')}</Link>
      {view.run.planIds.map((planId) => (
        <p key={planId}>
          <Link to={`/plan/${planId}`}>{t('Вернуться к индивидуальному плану →')}</Link>
        </p>
      ))}
      <p className="eyebrow">
        {labels[view.run.purpose]} ·{' '}
        {view.run.isDemo ? t('Демонстрационный контент') : t('Учебный контент')}
      </p>
      <h1>{view.run.title}</h1>
      <p>
        {view.run.completedSteps}/{view.run.totalSteps} {t(' заданий завершено')}
      </p>
      {!own && (
        <p>
          {t('Ученик: ')}
          {view.run.user.name} · {view.run.user.email}
        </p>
      )}
      {view.writable && !own && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={adminControl}
            onChange={(event) => setAdminControl(event.target.checked)}
          />
          {t('Управлять прохождением пользователя')}
        </label>
      )}
      {error && <ErrorState error={error} retry={() => void load()} />}
      {view.run.status === 'completed' ? (
        <section className="panel" role="status">
          <h2>{view.run.diagnosticId ? t('Диагностика завершена') : t('Урок завершён')}</h2>
          <p>
            {t('Результаты сохранены. Верных ответов:')}{' '}
            {view.attempts.filter((attempt) => attempt.evaluation?.correct).length} {t(' из')}{' '}
            {view.attempts.length} {t(' попыток.')}
          </p>
          {view.run.diagnosticId && (
            <p>
              <Link to={`/diagnostics/${view.run.diagnosticId}`}>
                {t('Результат входной диагностики по навыкам →')}
              </Link>
            </p>
          )}
          {view.writable && (
            <button disabled={busy} onClick={() => void restart()}>
              {t('Пройти ещё раз')}
            </button>
          )}
          <p>
            <Link
              to={`/courses/${view.run.packageId}/${view.run.routeId}?packageVersion=${view.run.packageVersion}`}
            >
              {t('Вернуться к маршруту →')}
            </Link>
          </p>
        </section>
      ) : (
        view.current && (
          <>
            <h2>
              {t('Задание ')}
              {view.current.position + 1} {t(' из ')}
              {view.run.totalSteps}
            </h2>
            {view.run.cachedContent && (
              <p className="notice">
                {t('Продолжаем по сохранённому материалу, который вы ещё не просматривали.')}
              </p>
            )}
            {view.current.generatedExerciseId && (
              <p className="notice">
                {t('Сгенерированный демонстрационный вариант задания. Результат предварительный.')}
              </p>
            )}
            {view.current.exercise.hasListening && (
              <ListeningPlayer
                key={view.current.stepId}
                runId={id!}
                stepId={view.current.stepId}
                editable={editable}
                initialUrl={view.current.listeningUrl}
              />
            )}
            {view.material.length > 0 && (
              <section className="panel">
                <h3>{t('Учебный материал')}</h3>
                <ContentBlocks blocks={view.material} assets={view.assets} />
              </section>
            )}
            <Question
              key={`question:${view.current.turn.id}`}
              view={view}
              editable={editable && !voiceBusy}
              changed={setView}
              refresh={load}
            />
            <VoiceAnswer
              key={`voice:${view.current.turn.id}`}
              view={view}
              editable={editable}
              changed={setView}
              refresh={load}
              onBusy={setVoiceBusy}
            />
            {view.current.attempt && editable && (
              <div className="form-actions">
                <button disabled={busy} onClick={() => void action('next', view.current!.turn.id)}>
                  {view.current.position + 1 === view.run.totalSteps
                    ? view.run.diagnosticId
                      ? t('Завершить диагностику')
                      : t('Завершить урок')
                    : t('Следующее задание')}
                </button>
                {view.run.purpose === 'practice' && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void action('retry', view.current!.turn.id)}
                  >
                    {t('Попробовать ещё раз')}
                  </button>
                )}
              </div>
            )}
          </>
        )
      )}
      <AssistantChat key={view.run.id} view={view} editable={editable} refresh={load} />
      <AttemptHistory attempts={view.attempts} showActor={session.user?.role === 'superadmin'} />
      {view.debug && (
        <details className="panel">
          <summary>{t('Все данные luch engine для отладки')}</summary>
          <pre className="engine-debug">
            {JSON.stringify({ run: view.run, steps: view.debug, attempts: view.attempts }, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}
function Question({
  view,
  editable,
  changed,
  refresh,
}: {
  view: RunView;
  editable: boolean;
  changed: (view: RunView) => void;
  refresh: () => Promise<void>;
}) {
  const current = view.current!,
    { turn, exercise } = current,
    { session } = useAuth(),
    navigate = useNavigate();
  const [draft, setDraft] = useState<DraftAnswer>(turn.draftAnswer),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [saved, setSaved] = useState(t('Черновик сохранён')),
    [pending, setPending] = useState<{
      turnId: string;
      operationId: string;
      answer: Answer;
    } | null>(null);
  const latest = useRef({ draft: turn.draftAnswer, revision: turn.draftRevision }),
    enabled = useRef(editable && !current.attempt);
  const inFlight = useRef<Set<Promise<unknown>>>(new Set());
  const mounted = useRef(true);
  enabled.current = editable && !current.attempt;
  useEffect(() => {
    if (current.attempt) {
      setDraft(turn.draftAnswer);
      setPending(null);
    }
  }, [current.attempt?.id]);
  const base = `/engine/runs/${view.run.id}`;
  const monitor = useRef<ReturnType<typeof monitorIntegrity> | null>(null);
  useEffect(() => {
    if (
      !view.integrityEnabled ||
      !editable ||
      current.attempt ||
      session.user!.id !== view.run.user.id
    )
      return;
    const tracking = monitorIntegrity(base, turn.id);
    monitor.current = tracking;
    return () => {
      monitor.current = null;
      tracking.dispose();
    };
  }, [view.integrityEnabled, editable, Boolean(current.attempt), base, turn.id]);
  const persist = useCallback(
    async (paused = false, keepalive = false) => {
      if (!enabled.current) return;
      const snapshot = { ...latest.current };
      const promise = api(`${base}/save`, runViewSchema, {
        body: { turnId: turn.id, draftAnswer: snapshot.draft, revision: snapshot.revision, paused },
        keepalive,
      });
      inFlight.current.add(promise);
      try {
        const result = await promise;
        if (mounted.current && latest.current.revision === snapshot.revision)
          setSaved(t('Черновик сохранён'));
        return result;
      } catch (failure) {
        if (mounted.current && latest.current.revision === snapshot.revision)
          setSaved(t('Черновик пока не сохранён: {0}', [(failure as Error).message]));
        return undefined;
      } finally {
        inFlight.current.delete(promise);
      }
    },
    [base, turn.id],
  );
  useEffect(() => {
    if (!editable || current.attempt) return;
    const timer = setTimeout(() => {
      void persist();
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, editable, current.attempt, persist]);
  useEffect(() => {
    mounted.current = true;
    if (!editable || current.attempt) return;
    void api(`${base}/resume`, runViewSchema, { body: { turnId: turn.id } })
      .then((result) => {
        if (mounted.current) changed(result);
      })
      .catch((failure) => {
        if (mounted.current) setError(t((failure as Error).message));
      });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void persist();
    }, 15000);
    const visibility = () => {
      if (document.visibilityState === 'hidden') void persist(true, true);
      else
        void api(`${base}/resume`, runViewSchema, { body: { turnId: turn.id } }).catch(
          () => undefined,
        );
    };
    const hide = () => {
      void persist(true, true);
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      void persist(true, true);
      mounted.current = false;
    };
  }, [editable, Boolean(current.attempt), base, turn.id, persist]);
  const update = (answer: DraftAnswer) => {
    latest.current = { draft: answer, revision: latest.current.revision + 1 };
    setDraft(answer);
    setSaved(t('Сохраняем черновик…'));
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    const body = pending ?? {
      turnId: turn.id,
      operationId: crypto.randomUUID(),
      answer: draft as Answer,
    };
    setPending(body);
    try {
      await monitor.current?.flush();
      const result = await api(`${base}/answer`, submitResultSchema, { body });
      setPending(null);
      changed(result.view);
    } catch (failure) {
      setError(t('{0} Можно повторить отправку.', [(failure as Error).message]));
    } finally {
      setBusy(false);
    }
  }
  async function hint() {
    setBusy(true);
    setError('');
    try {
      changed(
        await api(`${base}/hint`, runViewSchema, {
          body: { turnId: turn.id, index: turn.usedHints.length },
        }),
      );
    } catch (failure) {
      setError(t((failure as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function pause() {
    setBusy(true);
    setError('');
    enabled.current = false;
    try {
      await Promise.allSettled([...inFlight.current]);
      const result = await api(`${base}/save`, runViewSchema, {
        body: {
          turnId: turn.id,
          draftAnswer: latest.current.draft,
          revision: latest.current.revision,
          paused: true,
        },
      });
      changed(result);
      navigate(session.dashboardPath ?? '/learning');
    } catch (failure) {
      enabled.current = true;
      setError(t((failure as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const valid =
    draft?.type === 'choice' || (draft?.type === 'short_text' && draft.text.trim().length > 0);
  return (
    <section className="panel">
      <p className="exercise-instruction">{exercise.instruction}</p>
      <ContentBlocks blocks={exercise.blocks} assets={view.assets} />
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !editable || Boolean(current.attempt) || Boolean(pending)}>
          <legend>{t('Ваш ответ')}</legend>
          {exercise.response.type === 'choice' ? (
            exercise.response.options.map((option) => (
              <label className="answer-option" key={option.id}>
                <input
                  type="radio"
                  name="answer"
                  checked={draft?.type === 'choice' && draft.optionId === option.id}
                  onChange={() => update({ type: 'choice', optionId: option.id })}
                />
                {option.text}
              </label>
            ))
          ) : (
            <>
              <label htmlFor="short-answer">{t('Короткий ответ')}</label>
              <input
                id="short-answer"
                value={draft?.type === 'short_text' ? draft.text : ''}
                maxLength={exercise.response.maxLength}
                placeholder={exercise.response.placeholder}
                autoComplete="off"
                onChange={(event) => update({ type: 'short_text', text: event.target.value })}
              />
            </>
          )}
        </fieldset>
        {editable && !current.attempt && (
          <div className="form-actions">
            <button disabled={busy || !valid}>
              {busy ? t('Проверяем…') : pending ? t('Повторить отправку') : t('Проверить ответ')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || Boolean(pending) || current.hintsRemaining === 0}
              onClick={() => void hint()}
            >
              {t('Подсказка')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || Boolean(pending)}
              onClick={() => void pause()}
            >
              {t('Сохранить и выйти')}
            </button>
          </div>
        )}
      </form>
      {editable && !current.attempt && (
        <p className="muted" role="status">
          {saved}
        </p>
      )}
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          <button className="secondary" onClick={() => void refresh()}>
            {t('Проверить сохранённое состояние')}
          </button>
        </div>
      )}
      {turn.usedHints.length > 0 && (
        <aside className="hint">
          <h3>{t('Использованные подсказки')}</h3>
          {turn.usedHints.map((hint) => (
            <p key={hint.index}>{hint.text}</p>
          ))}
        </aside>
      )}
      {view.run.purpose !== 'practice' && (
        <p className="muted">
          {t('Подсказки отключены. Оценка и объяснения появятся после завершения проверки.')}
        </p>
      )}
      {current.attempt && (
        <div className="feedback" role="status">
          <h3>
            {current.attempt.evaluation
              ? current.attempt.evaluation.correct
                ? t('Верно')
                : t('Нужно исправить')
              : t('Ответ сохранён')}
          </h3>
          {current.attempt.teacherReview && (
            <p className="badge">
              {t('Оценка преподавателя: ')}
              {current.attempt.teacherReview.author.name}
            </p>
          )}
          {current.attempt.evaluation && <p>{current.attempt.evaluation.explanation}</p>}
          <Link to={`/learning/attempts/${current.attempt.id}`}>
            {t('Комментарии и история проверки →')}
          </Link>
          <p>
            {t('Время активности: ')}
            {(current.attempt.activeMilliseconds / 1000).toFixed(1)} {t(' с')}
            {current.attempt.adminAssistance
              ? t(' · С участием суперадмина')
              : current.attempt.independent
                ? t(' · Без помощи')
                : t(' · С помощью или после объяснения')}
          </p>
        </div>
      )}
    </section>
  );
}
function AttemptHistory({
  attempts,
  showActor,
}: {
  attempts: EngineAttempt[];
  showActor: boolean;
}) {
  return (
    <section className="panel">
      <h2>{t('История попыток')}</h2>
      {attempts.length ? (
        attempts.map((attempt) => (
          <details className="attempt-item" key={attempt.id}>
            <summary>
              <IntegrityFlag assessment={attempt.integrity} /> {t('Попытка ')}
              {attempt.number}:{' '}
              {attempt.evaluation
                ? attempt.evaluation.correct
                  ? t('верно')
                  : t('ошибка')
                : t('ответ сохранён')}{' '}
              · {new Date(attempt.evaluatedAt).toLocaleString(dateLocale)}
            </summary>
            <p>{attempt.instruction}</p>
            <p>
              <strong>{t('Ответ:')}</strong>{' '}
              {attempt.answer.type === 'short_text' ? (
                <span className="content-text">{attempt.answer.text}</span>
              ) : attempt.response.type === 'choice' ? (
                attempt.response.options.find(
                  (option) => option.id === (attempt.answer as { optionId: string }).optionId,
                )?.text
              ) : (
                attempt.answer.optionId
              )}
            </p>
            {attempt.teacherReview && (
              <p className="badge">
                {t('Проверено преподавателем: ')}
                {attempt.teacherReview.author.name}
              </p>
            )}
            {attempt.evaluation && <p>{attempt.evaluation.explanation}</p>}
            <p>
              <Link to={`/learning/attempts/${attempt.id}`}>
                {t('Ответ и комментарии преподавателя →')}
              </Link>
            </p>
            {attempt.integrity && (
              <aside className="integrity-review">
                <strong>
                  {t('Контекст честности:')}{' '}
                  {attempt.integrity.requiresReview
                    ? t('Требует внимания')
                    : attempt.integrity.status === 'insufficient_data'
                      ? t('Недостаточно наблюдений')
                      : t('Пометки нет')}
                </strong>
                <p>{t('Фоновые сигналы требуют проверки человеком.')}</p>
                <ul>
                  {attempt.integrity.signals.map((signal) => (
                    <li key={signal.code}>
                      {t(signal.label)}: {t(signal.context)}
                    </li>
                  ))}
                </ul>
              </aside>
            )}
            <p>
              {attempt.adminAssistance
                ? t('С участием суперадмина')
                : attempt.independent
                  ? t('Самостоятельно')
                  : t('С подсказкой или после объяснения')}{' '}
              {t('· Активность ')}
              {(attempt.activeMilliseconds / 1000).toFixed(1)} {t(' с · От открытия до ответа ')}
              {(attempt.elapsedMilliseconds / 1000).toFixed(1)} {t(' с')}
            </p>
            {attempt.usedHints.map((hint) => (
              <p key={hint.index}>
                {t('Подсказка: ')}
                {hint.text}
              </p>
            ))}
            {showActor && (
              <p>
                {t('Автор отправки: ')}
                {attempt.submittedBy} {t(' · Версия задания ')}
                {attempt.exerciseVersion} {t(' · Движок ')}
                {attempt.evaluation?.engineVersion}
              </p>
            )}
          </details>
        ))
      ) : (
        <p className="muted">{t('Ответов ещё нет.')}</p>
      )}
    </section>
  );
}
export function IntegrityControls() {
  const { state, refresh } = useResource('/admin/engine/integrity-policy', integrityPolicySchema);
  const [enabled, setEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    if (state.status === 'ready') setEnabled(state.data.enabled);
  }, [state]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api('/admin/engine/integrity-policy', integrityPolicySchema, { body: { enabled } });
      setMessage(t('Параметры честности сохранены.'));
      refresh();
    } catch (failure) {
      setMessage(t((failure as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t('Честность прохождения')}</h2>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t('Фоновая проверка прохождения')}
          </label>
          <button disabled={busy}>{t('Сохранить параметры честности')}</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
