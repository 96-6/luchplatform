import { StudentDirectory } from '../components/StudentDirectory';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  attemptDetailSchema,
  attemptsPageSchema,
  teacherActionsPageSchema,
  type saveTeacherReviewSchema,
  type EngineAttempt,
} from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState, EmptyState } from '../components/States';
type Detail = z.infer<typeof attemptDetailSchema>;
type AttemptPage = z.infer<typeof attemptsPageSchema>;
type Updates = z.infer<typeof teacherActionsPageSchema>;
const outcome = (value: boolean | null | undefined) =>
  value === null || value === undefined
    ? 'Оценка после завершения'
    : value
      ? 'Верно'
      : 'Есть ошибка';
export function answerText(a: EngineAttempt) {
  return a.answer.type === 'short_text'
    ? a.answer.text
    : a.response.type === 'choice'
      ? (a.response.options.find((o) => a.answer.type === 'choice' && o.id === a.answer.optionId)
          ?.text ?? a.answer.optionId)
      : a.answer.optionId;
}
export function RecentAttempts({ userId }: { userId: string }) {
  const [page, setPage] = useState<AttemptPage | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setPage(null);
    setError(null);
    void api(`/learning/attempts?userId=${userId}`, attemptsPageSchema, { signal: c.signal })
      .then((p) => {
        if (!c.signal.aborted) setPage(p);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [userId, reload]);
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    try {
      const q = new URLSearchParams({
          userId,
          beforeCreatedAt: page.nextCursor.createdAt,
          beforeId: page.nextCursor.id,
        }),
        p = await api(`/learning/attempts?${q}`, attemptsPageSchema);
      setPage({ ...p, items: [...page.items, ...p.items] });
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Последние ответы ученика</h2>
      {!page && !error && <LoadingState />}
      {error && (
        <ErrorState error={error} retry={() => (page ? void more() : setReload((v) => v + 1))} />
      )}{' '}
      {page &&
        (!page.items.length ? (
          <p>Ученик ещё не отправлял ответы.</p>
        ) : (
          <ul className="account-list">
            {page.items.map((r) => (
              <li key={r.attempt.id} data-testid="teacher-attempt">
                <strong>{r.runTitle}</strong>
                <p>{r.attempt.instruction}</p>
                <p>Ответ: {answerText(r.attempt)}</p>
                <span>
                  {outcome(r.attempt.evaluation?.correct)}
                  {r.attempt.teacherReview ? ' · Проверено преподавателем' : ''} ·{' '}
                  {r.attempt.independent ? 'Самостоятельно' : 'С помощью'}
                </span>
                <time dateTime={r.attempt.evaluatedAt}>
                  {new Date(r.attempt.evaluatedAt).toLocaleString('ru-RU')}
                </time>
                <Link to={`/learning/attempts/${r.attempt.id}`}>
                  Проверить ответ и комментарии →
                </Link>
              </li>
            ))}
          </ul>
        ))}
      {page?.nextCursor && (
        <button className="secondary" disabled={busy} onClick={() => void more()}>
          Предыдущие ответы
        </button>
      )}
    </section>
  );
}
export function AttemptReviewPage() {
  const { id } = useParams();
  return <AttemptReview key={id} id={id!} />;
}
function AttemptReview({ id }: { id: string }) {
  const { session } = useAuth();
  const [view, setView] = useState<Detail | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void api(`/learning/attempts/${id}`, attemptDetailSchema, { signal: c.signal })
      .then((v) => {
        if (!c.signal.aborted) setView(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e);
      });
    return () => c.abort();
  }, [id]);
  async function load() {
    setError(null);
    try {
      setView(await api(`/learning/attempts/${id}`, attemptDetailSchema));
    } catch (e) {
      setError(e as Error);
    }
  }
  async function older() {
    if (!view?.nextReviewCursor) return;
    setBusy(true);
    try {
      const p = await api(
        `/learning/attempts/${id}?beforeRevision=${view.nextReviewCursor.revision}`,
        attemptDetailSchema,
      );
      setView({ ...p, reviews: [...view.reviews, ...p.reviews] });
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return error ? <ErrorState error={error} retry={() => void load()} /> : <LoadingState />;
  const a = view.attempt,
    reviewer = session.user?.role === 'teacher' || session.user?.role === 'superadmin';
  return (
    <>
      <h1>Ответ и проверка преподавателя</h1>
      <p>
        <Link to={`/learning/runs/${view.runId}`}>{view.runTitle} — прохождение →</Link>
      </p>
      {reviewer && (
        <p>
          <Link to={`/teacher/students/${a.submittedFor}`}>Карточка ученика →</Link>
        </p>
      )}
      <section className="panel" aria-label="Сохранённый ответ">
        <h2>{a.instruction}</h2>
        <p className="content-text">
          <strong>Ответ ученика:</strong> {answerText(a)}
        </p>
        <p>
          {a.independent ? 'Самостоятельный ответ' : 'Ответ с помощью или после обратной связи'}
          {a.adminAssistance ? ' · Участие суперадмина' : ''}
          {a.assistantHelp ? ' · Помощь ассистента' : ''}
        </p>
        <p>
          Активное время: {(a.activeMilliseconds / 1000).toFixed(1)} с · Всего:{' '}
          {(a.elapsedMilliseconds / 1000).toFixed(1)} с
        </p>
        <p>
          <time dateTime={a.evaluatedAt}>{new Date(a.evaluatedAt).toLocaleString('ru-RU')}</time>
        </p>
        <h3>Использованные подсказки</h3>
        {a.usedHints.length ? (
          <ul>
            {a.usedHints.map((h) => (
              <li key={h.index}>{h.text}</li>
            ))}
          </ul>
        ) : (
          <p>Подсказки задания не использованы.</p>
        )}
        {view.speechInput && (
          <div>
            <h3>Голосовая реплика</h3>
            <p>Распознано: {view.speechInput.transcript}</p>
            <p>Подтверждено: {view.speechInput.confirmedText}</p>
            {view.speechInput.edited && (
              <p>Ученик исправил распознанный текст перед подтверждением.</p>
            )}
          </div>
        )}
        <h3>Автоматическая оценка</h3>
        <p>{outcome(a.automaticEvaluation?.correct)}</p>
        {a.automaticEvaluation && <p>{a.automaticEvaluation.explanation}</p>}
        {a.teacherReview && (
          <div className="notice" data-testid="current-teacher-grade">
            <h3>Текущая оценка преподавателя</h3>
            <p>
              {outcome(a.teacherReview.correct)} · {a.teacherReview.author.name}
            </p>
            <p className="content-text">{a.teacherReview.comment}</p>
          </div>
        )}
        {view.solution && (
          <details>
            <summary>Критерий закреплённого задания</summary>
            <p>
              {view.solution.type === 'short_text'
                ? view.solution.accepted.join(' / ')
                : a.response.type === 'choice'
                  ? a.response.options
                      .filter(
                        (o) =>
                          view.solution?.type === 'choice' &&
                          view.solution.correctOptionIds.includes(o.id),
                      )
                      .map((o) => o.text)
                      .join(' / ')
                  : ''}
            </p>
          </details>
        )}
      </section>
      {reviewer &&
        (view.reviewable ? (
          <ReviewForm view={view} saved={setView} refresh={load} />
        ) : (
          <p className="notice">
            Проверка преподавателя доступна после завершения диагностики или контроля.
          </p>
        ))}
      <section className="panel">
        <h2>Комментарии и история проверки</h2>
        {error && (
          <ErrorState
            error={error}
            retry={() => (view.nextReviewCursor ? void older() : void load())}
          />
        )}{' '}
        {!view.reviews.length ? (
          <p>Преподаватель ещё не оставил комментариев.</p>
        ) : (
          <ol className="change-list">
            {view.reviews.map((r) => (
              <li key={r.id} data-testid="teacher-review">
                <strong>{r.author.name}</strong> ·{' '}
                <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString('ru-RU')}</time>
                <p>
                  {r.decision === 'comment'
                    ? 'Комментарий'
                    : r.decision === 'confirm'
                      ? 'Оценка подтверждена'
                      : 'Оценка исправлена'}
                  {r.correct === null ? '' : ` · ${outcome(r.correct)}`}
                </p>
                <p className="content-text">{r.comment}</p>
              </li>
            ))}
          </ol>
        )}
        {view.nextReviewCursor && (
          <button className="secondary" disabled={busy} onClick={() => void older()}>
            Предыдущие проверки
          </button>
        )}
      </section>
      <Link to={`/feedback?userId=${a.submittedFor}`}>Комментарии и назначения →</Link>
    </>
  );
}
function ReviewForm({
  view,
  saved,
  refresh,
}: {
  view: Detail;
  saved: (v: Detail) => void;
  refresh: () => Promise<void>;
}) {
  const [decision, setDecision] = useState<'comment' | 'confirm' | 'correct'>('comment'),
    [correct, setCorrect] = useState('true'),
    [comment, setComment] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  const pending = useRef<z.infer<typeof saveTeacherReviewSchema> | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setDone(false);
    const body = pending.current ?? {
      operationId: crypto.randomUUID(),
      revision: view.attempt.reviewRevision,
      decision,
      comment,
      ...(decision === 'correct' ? { correct: correct === 'true' } : {}),
    };
    pending.current = body;
    try {
      const result = await api(
        `/teacher/attempts/${view.attempt.id}/reviews`,
        attemptDetailSchema,
        { body },
      );
      pending.current = null;
      saved(result);
      setComment('');
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status && e.status < 500) {
        pending.current = null;
        if (e.code === 'REVIEW_CHANGED') await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Проверка ответа">
      <h2>Проверить ответ</h2>
      <p>
        Решение обновит текущую оценку. Исходная автоматическая оценка и история комментариев
        сохранятся. При необходимости измените назначения в плане.
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy || Boolean(pending.current)}>
          <label htmlFor="review-decision">Решение преподавателя</label>
          <select
            id="review-decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
          >
            <option value="comment">Оставить комментарий</option>
            <option value="confirm">Подтвердить текущую оценку</option>
            <option value="correct">Исправить оценку</option>
          </select>
          {decision === 'correct' && (
            <>
              <label htmlFor="review-correct">Исправленная оценка</label>
              <select
                id="review-correct"
                value={correct}
                onChange={(e) => setCorrect(e.target.value)}
              >
                <option value="true">Верно</option>
                <option value="false">Есть ошибка</option>
              </select>
            </>
          )}
          <label htmlFor="review-comment">Комментарий преподавателя</label>
          <textarea
            id="review-comment"
            rows={4}
            maxLength={3000}
            required
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </fieldset>
        <button disabled={busy || !comment.trim()}>
          {busy
            ? 'Сохраняем проверку…'
            : pending.current
              ? 'Повторить сохранение проверки'
              : 'Сохранить проверку'}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p role="status">Проверка сохранена. Ученик увидит комментарий и текущую оценку.</p>}
    </section>
  );
}
export function TeacherUpdates({
  userId,
  compact = false,
}: {
  userId?: string | undefined;
  compact?: boolean;
}) {
  const q = new URLSearchParams({ limit: compact ? '5' : '20', ...(userId ? { userId } : {}) }),
    base = `/learning/teacher-updates?${q}`;
  const { state, refresh } = useResource(base, teacherActionsPageSchema),
    [extra, setExtra] = useState<Updates | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setExtra(null);
  }, [state]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  const page = extra ?? (state.status === 'ready' ? state.data : null);
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    try {
      const p = new URLSearchParams(q);
      p.set('beforeCreatedAt', page.nextCursor.createdAt);
      p.set('beforeId', page.nextCursor.id);
      const next = await api(`/learning/teacher-updates?${p}`, teacherActionsPageSchema);
      setExtra({ ...next, items: [...page.items, ...next.items] });
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const labels = {
    review: 'Проверка ответа',
    assignment_added: 'Назначено упражнение',
    assignment_rescheduled: 'Изменён срок задания',
    assignment_cancelled: 'Назначение отменено',
  };
  return (
    <section className="panel" aria-label="Комментарии и назначения">
      <h2>Комментарии и назначения преподавателя</h2>
      {state.status === 'loading' && <LoadingState />}
      {state.status === 'error' && <ErrorState error={state.error} retry={refresh} />}{' '}
      {error && <ErrorState error={error} retry={() => void more()} />}{' '}
      {page &&
        (!page.items.length ? (
          <p>Здесь появятся комментарии и изменения учебного плана.</p>
        ) : (
          <ul className="change-list">
            {page.items.map((a) => (
              <li key={a.id} data-testid="teacher-update">
                <strong>{labels[a.kind]}</strong> · {a.language === 'ru' ? 'РКИ' : 'Английский'}
                <p>
                  {a.author.name} ·{' '}
                  <time dateTime={a.createdAt}>
                    {new Date(a.createdAt).toLocaleString('ru-RU')}
                  </time>
                </p>
                {a.correct !== null && (
                  <p>
                    {a.decision === 'confirm' ? 'Оценка подтверждена' : 'Оценка исправлена'}:{' '}
                    {outcome(a.correct)}
                  </p>
                )}
                <p className="content-text">{a.comment}</p>
                {a.attemptId && (
                  <Link to={`/learning/attempts/${a.attemptId}`}>Ответ и история проверки →</Link>
                )}
                {a.planId && (
                  <Link
                    to={`/plan/${a.planId}${a.assignmentId ? `#assignment-${a.assignmentId}` : ''}`}
                  >
                    Открыть назначение в плане →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ))}{' '}
      {!compact && page?.nextCursor && (
        <button className="secondary" disabled={busy} onClick={() => void more()}>
          Предыдущие комментарии и назначения
        </button>
      )}
      {compact && (
        <p>
          <Link to={`/feedback${userId ? `?userId=${userId}` : ''}`}>
            Все комментарии и назначения →
          </Link>
        </p>
      )}
    </section>
  );
}
export function TeacherFeedbackPage() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  if (session.user?.role !== 'student' && !params.get('userId'))
    return (
      <>
        <h1>Комментарии и назначения</h1>
        <StudentDirectory path="/feedback" />
      </>
    );
  return (
    <>
      <h1>Комментарии и назначения</h1>
      <TeacherUpdates userId={params.get('userId') ?? undefined} />
    </>
  );
}
