import { StudentDirectory } from '../components/StudentDirectory';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  diagnosticViewSchema,
  diagnosticsPageSchema,
  profileViewSchema,
  type Questionnaire,
} from '@luch/contracts';
import type { z } from 'zod';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
import {
  QuestionnaireSummary,
  languageLabels,
  goalLabels,
  experienceLabels,
} from '../components/QuestionnaireSummary';
import { DiagnosticPlanLink } from './PlanPages';

export function ProfileOverview({ userId }: { userId: string }) {
  const { state, refresh } = useResource(`/learning/profile?userId=${userId}`, profileViewSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>Учебная анкета</h2>
      {state.data.profile ? (
        <>
          <QuestionnaireSummary data={state.data.profile} />
          <p className="muted">Версия анкеты: {state.data.profile.revision}</p>
        </>
      ) : (
        <p>Анкета ещё не заполнена.</p>
      )}
      {state.data.writable && (
        <Link to={`/onboarding?userId=${userId}`}>Анкета и входная диагностика →</Link>
      )}
    </section>
  );
}
export function OnboardingPage() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const userId =
    params.get('userId') ?? (session.user!.role === 'student' ? session.user!.id : null);
  if (!userId)
    return (
      <>
        <h1>Анкеты и диагностика учеников</h1>
        <StudentDirectory path="/onboarding" />
      </>
    );
  return <ProfileEditor key={userId} userId={userId} />;
}
function ProfileEditor({ userId }: { userId: string }) {
  const resource = useResource(`/learning/profile?userId=${userId}`, profileViewSchema);
  const [view, setView] = useState<z.infer<typeof profileViewSchema> | null>(null);
  const [data, setData] = useState<Questionnaire>({
    language: 'ru',
    goal: 'daily_life',
    experience: 'none',
    minutesPerDay: 20,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    if (resource.state.status === 'ready') {
      setView(resource.state.data);
      if (resource.state.data.profile) setData(resource.state.data.profile);
    }
  }, [resource.state]);
  const dirty =
    !view?.profile ||
    Object.keys(data)
      .filter((k) => ['language', 'goal', 'experience', 'minutesPerDay'].includes(k))
      .some((k) => data[k as keyof Questionnaire] !== view.profile![k as keyof Questionnaire]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!view) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      setView(
        await api('/learning/profile', profileViewSchema, {
          body: {
            language: data.language,
            goal: data.goal,
            experience: data.experience,
            minutesPerDay: data.minutesPerDay,
            userId,
            revision: view.profile?.revision ?? 0,
          },
        }),
      );
      setMessage('Анкета сохранена.');
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function start(restart = false) {
    if (!view?.profile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api('/diagnostics', diagnosticViewSchema, {
        body: { userId, profileRevision: view.profile.revision, restart },
      });
      navigate(
        result.diagnostic.status === 'completed'
          ? `/diagnostics/${result.diagnostic.id}`
          : `/learning/runs/${result.diagnostic.runId}`,
      );
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return resource.state.status === 'error' ? (
      <ErrorState error={resource.state.error} retry={resource.refresh} />
    ) : (
      <LoadingState />
    );
  return (
    <>
      <p className="eyebrow">Первый шаг обучения</p>
      <h1>Анкета и входная диагностика</h1>
      <p>
        {view.user.name} · {view.user.email}
      </p>
      <section className="panel">
        <h2>Ваши цели и время</h2>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={!view.writable || busy}>
            <label htmlFor="profile-language">Язык обучения</label>
            <select
              id="profile-language"
              value={data.language}
              onChange={(e) =>
                setData({ ...data, language: e.target.value as Questionnaire['language'] })
              }
            >
              {Object.entries(languageLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="profile-goal">Учебная цель</label>
            <select
              id="profile-goal"
              value={data.goal}
              onChange={(e) => setData({ ...data, goal: e.target.value as Questionnaire['goal'] })}
            >
              {Object.entries(goalLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="profile-experience">Опыт изучения языка</label>
            <select
              id="profile-experience"
              value={data.experience}
              onChange={(e) =>
                setData({ ...data, experience: e.target.value as Questionnaire['experience'] })
              }
            >
              {Object.entries(experienceLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor="profile-minutes">Доступное время в день, минуты</label>
            <input
              id="profile-minutes"
              type="number"
              min={5}
              max={120}
              step={1}
              required
              value={data.minutesPerDay}
              onChange={(e) => setData({ ...data, minutesPerDay: Number(e.target.value) })}
            />
            {view.writable && <button>Сохранить анкету</button>}
          </fieldset>
        </form>
        {message && (
          <p role="status" className="success">
            {message}
          </p>
        )}
        {view.profile && (
          <p className="muted">
            Сохранённая версия: {view.profile.revision}. Изменение анкеты сохраняет прежние
            результаты диагностики.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Короткая диагностика</h2>
        <p>
          Шесть заданий из отдельного банка выбранного языка. Можно сохранить ответ и вернуться
          после перерыва. Подсказки отключены, результаты откроются после завершения.
        </p>
        <p className="muted">Оценка предварительная; она не подтверждает уровень языка.</p>
        {view.writable && (
          <div className="form-actions">
            <button disabled={busy || dirty} onClick={() => void start()}>
              Начать или продолжить диагностику
            </button>
            <button className="secondary" disabled={busy || dirty} onClick={() => void start(true)}>
              Пройти диагностику ещё раз
            </button>
          </div>
        )}
        {dirty && view.writable && <p>Сначала сохраните анкету.</p>}
      </section>
      {error && <ErrorState error={error} retry={resource.refresh} />}
      <DiagnosticHistory userId={userId} />
    </>
  );
}
export function DiagnosticHistory({ userId }: { userId: string }) {
  const [page, setPage] = useState<z.infer<typeof diagnosticsPageSchema> | null>(null),
    [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null);
    setError(null);
    void api(`/diagnostics?userId=${userId}`, diagnosticsPageSchema, {
      signal: controller.signal,
    }).then(
      (value) => {
        if (!controller.signal.aborted) setPage(value);
      },
      (failure) => {
        if (!controller.signal.aborted) setError(failure as Error);
      },
    );
    return () => controller.abort();
  }, [userId, revision]);
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api(
        `/diagnostics?userId=${userId}&beforeCreatedAt=${encodeURIComponent(page.nextCursor.createdAt)}&beforeId=${page.nextCursor.id}`,
        diagnosticsPageSchema,
      );
      setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor });
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Сохранённые диагностики</h2>
      {!page && !error && <LoadingState />}
      {page &&
        (!page.items.length ? (
          <p>Диагностика ещё не начата.</p>
        ) : (
          <ul className="account-list">
            {page.items.map((d) => (
              <li key={d.id}>
                <strong>{languageLabels[d.questionnaire.language]}</strong>
                <span>
                  {d.answeredQuestions}/{d.totalQuestions} ответов · анкета v{d.profileRevision}
                </span>
                <span>{new Date(d.createdAt).toLocaleString('ru-RU')}</span>
                <Link
                  to={
                    d.status === 'completed' ? `/diagnostics/${d.id}` : `/learning/runs/${d.runId}`
                  }
                >
                  {d.status === 'completed'
                    ? 'Предварительный результат →'
                    : 'Продолжить диагностику →'}
                </Link>
              </li>
            ))}
          </ul>
        ))}
      {error && <ErrorState error={error} retry={() => setRevision((value) => value + 1)} />}
      {page?.nextCursor && (
        <button disabled={busy} className="secondary" onClick={() => void more()}>
          Показать предыдущие диагностики
        </button>
      )}
    </section>
  );
}
export function DiagnosticResultPage() {
  const { id } = useParams();
  const { state, refresh } = useResource(`/diagnostics/${id}`, diagnosticViewSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const { diagnostic, result, writable, planId } = state.data;
  return (
    <>
      <p className="eyebrow">
        Входная диагностика{diagnostic.isDemo ? ' · демонстрационный контент' : ''}
      </p>
      <h1>Предварительный результат диагностики</h1>
      <p>
        {diagnostic.user.name} · {diagnostic.user.email}
      </p>
      <QuestionnaireSummary data={diagnostic.questionnaire} />
      <p className="muted">
        Анкета v{diagnostic.profileRevision} · пакет {diagnostic.packageId} v
        {diagnostic.packageVersion}
      </p>
      {diagnostic.teacherReviewedAttempts > 0 && (
        <aside className="notice">
          <p>
            Преподаватель проверил ответов: {diagnostic.teacherReviewedAttempts}. Ниже сохранён
            исходный снимок автоматической диагностики, по которому был создан план.
          </p>
          <Link to={`/learning/runs/${diagnostic.runId}`}>
            Текущие оценки и комментарии к ответам →
          </Link>
        </aside>
      )}
      {!result ? (
        <section className="panel">
          <h2>Диагностика не завершена</h2>
          <p>
            Сохранено {diagnostic.answeredQuestions} из {diagnostic.totalQuestions} ответов.
          </p>
          <Link to={`/learning/runs/${diagnostic.runId}`}>
            {writable ? 'Продолжить диагностику →' : 'Посмотреть прохождение →'}
          </Link>
        </section>
      ) : (
        <>
          <section className="notice">
            <strong>Предварительная оценка</strong>
            <p>{result.notice}</p>
            <p>
              Верных ответов: {result.correct} из {result.questions} · {result.percent}%
            </p>
          </section>
          <DiagnosticPlanLink diagnosticId={diagnostic.id} planId={planId} writable={writable} />
          <div className="diagnostic-columns">
            <section className="panel">
              <h2>Сильные стороны в этом наборе</h2>
              {result.strengthIds.length ? (
                <ul>
                  {result.skills
                    .filter((s) => result.strengthIds.includes(s.skillId))
                    .map((s) => (
                      <li key={s.skillId}>{s.name}</li>
                    ))}
                </ul>
              ) : (
                <p>Пока не отмечены. Следующая практика поможет уточнить результат.</p>
              )}
            </section>
            <section className="panel">
              <h2>Что стоит потренировать</h2>
              {result.difficultyIds.length ? (
                <ul>
                  {result.skills
                    .filter((s) => result.difficultyIds.includes(s.skillId))
                    .map((s) => (
                      <li key={s.skillId}>{s.name}</li>
                    ))}
                </ul>
              ) : (
                <p>В этом наборе затруднений не отмечено.</p>
              )}
            </section>
          </div>
          <h2>Результаты по навыкам</h2>
          <div className="skill-results">
            {result.skills.map((skill) => (
              <article className="panel" key={skill.skillId} data-testid="skill-result">
                <h3>{skill.name}</h3>
                <p>{skill.description}</p>
                <p>
                  {skill.correct}/{skill.questions} верно · {skill.percent}%
                </p>
                <progress
                  max={100}
                  value={skill.percent}
                  aria-label={`${skill.name}: ${skill.percent}%`}
                />
                <p className="muted">
                  Самостоятельно верно: {skill.independentCorrect} · С помощью или после обратной
                  связи: {skill.assistedCorrect}
                </p>
                <p className="muted">
                  Короткий набор: {skill.questions} {skill.questions === 1 ? 'задание' : 'заданий'}{' '}
                  по этому навыку.
                </p>
              </article>
            ))}
          </div>
          <p>Результат сохранён: {new Date(result.evaluatedAt).toLocaleString('ru-RU')}</p>
        </>
      )}
      <p>
        <Link to={`/learning/runs/${diagnostic.runId}`}>Ответы и история прохождения →</Link>
      </p>
      {writable && (
        <p>
          <Link to={`/onboarding?userId=${diagnostic.user.id}`}>
            Анкета и повторная диагностика →
          </Link>
        </p>
      )}
    </>
  );
}
