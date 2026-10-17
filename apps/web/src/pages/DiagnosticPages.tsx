import { t, dateLocale } from '../i18n';
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
      <h2>{t('Учебная анкета')}</h2>
      {state.data.profile ? (
        <>
          <QuestionnaireSummary data={state.data.profile} />
          <p className="muted">
            {t('Версия анкеты: ')}
            {state.data.profile.revision}
          </p>
        </>
      ) : (
        <p>{t('Анкета ещё не заполнена.')}</p>
      )}
      {state.data.writable && (
        <Link to={`/onboarding?userId=${userId}`}>{t('Анкета и входная диагностика →')}</Link>
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
        <h1>{t('Анкеты и диагностика учеников')}</h1>
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
      setMessage(t('Анкета сохранена.'));
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
      <p className="eyebrow">{t('Первый шаг обучения')}</p>
      <h1>{t('Анкета и входная диагностика')}</h1>
      <p>
        {view.user.name} · {view.user.email}
      </p>
      <section className="panel">
        <h2>{t('Ваши цели и время')}</h2>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={!view.writable || busy}>
            <label htmlFor="profile-language">{t('Язык обучения')}</label>
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
            <label htmlFor="profile-goal">{t('Учебная цель')}</label>
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
            <label htmlFor="profile-experience">{t('Опыт изучения языка')}</label>
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
            <label htmlFor="profile-minutes">{t('Доступное время в день, минуты')}</label>
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
            {view.writable && <button>{t('Сохранить анкету')}</button>}
          </fieldset>
        </form>
        {message && (
          <p role="status" className="success">
            {message}
          </p>
        )}
        {view.profile && (
          <p className="muted">
            {t('Сохранённая версия: ')}
            {view.profile.revision}
            {t('. Изменение анкеты сохраняет прежние результаты диагностики.')}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>{t('Короткая диагностика')}</h2>
        <p>
          {t(
            'Шесть заданий из отдельного банка выбранного языка. Можно сохранить ответ и вернуться после перерыва. Подсказки отключены, результаты откроются после завершения.',
          )}
        </p>
        <p className="muted">{t('Оценка предварительная; она не подтверждает уровень языка.')}</p>
        {view.writable && (
          <div className="form-actions">
            <button disabled={busy || dirty} onClick={() => void start()}>
              {t('Начать или продолжить диагностику')}
            </button>
            <button className="secondary" disabled={busy || dirty} onClick={() => void start(true)}>
              {t('Пройти диагностику ещё раз')}
            </button>
          </div>
        )}
        {dirty && view.writable && <p>{t('Сначала сохраните анкету.')}</p>}
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
      <h2>{t('Сохранённые диагностики')}</h2>
      {!page && !error && <LoadingState />}
      {page &&
        (!page.items.length ? (
          <p>{t('Диагностика ещё не начата.')}</p>
        ) : (
          <ul className="account-list">
            {page.items.map((d) => (
              <li key={d.id}>
                <strong>{languageLabels[d.questionnaire.language]}</strong>
                <span>
                  {d.answeredQuestions}/{d.totalQuestions} {t(' ответов · анкета v')}
                  {d.profileRevision}
                </span>
                <span>{new Date(d.createdAt).toLocaleString(dateLocale)}</span>
                <Link
                  to={
                    d.status === 'completed' ? `/diagnostics/${d.id}` : `/learning/runs/${d.runId}`
                  }
                >
                  {d.status === 'completed'
                    ? t('Предварительный результат →')
                    : t('Продолжить диагностику →')}
                </Link>
              </li>
            ))}
          </ul>
        ))}
      {error && <ErrorState error={error} retry={() => setRevision((value) => value + 1)} />}
      {page?.nextCursor && (
        <button disabled={busy} className="secondary" onClick={() => void more()}>
          {t('Показать предыдущие диагностики')}
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
        {t('Входная диагностика')}
        {diagnostic.isDemo ? t(' · демонстрационный контент') : ''}
      </p>
      <h1>{t('Предварительный результат диагностики')}</h1>
      <p>
        {diagnostic.user.name} · {diagnostic.user.email}
      </p>
      <QuestionnaireSummary data={diagnostic.questionnaire} />
      <p className="muted">
        {t('Анкета v')}
        {diagnostic.profileRevision} {t(' · пакет ')}
        {diagnostic.packageId} v{diagnostic.packageVersion}
      </p>
      {diagnostic.teacherReviewedAttempts > 0 && (
        <aside className="notice">
          <p>
            {t('Преподаватель проверил ответов: ')}
            {diagnostic.teacherReviewedAttempts}
            {t(
              '. Ниже сохранён исходный снимок автоматической диагностики, по которому был создан план.',
            )}
          </p>
          <Link to={`/learning/runs/${diagnostic.runId}`}>
            {t('Текущие оценки и комментарии к ответам →')}
          </Link>
        </aside>
      )}
      {!result ? (
        <section className="panel">
          <h2>{t('Диагностика не завершена')}</h2>
          <p>
            {t('Сохранено ')}
            {diagnostic.answeredQuestions} {t(' из ')}
            {diagnostic.totalQuestions} {t(' ответов.')}
          </p>
          <Link to={`/learning/runs/${diagnostic.runId}`}>
            {writable ? t('Продолжить диагностику →') : t('Посмотреть прохождение →')}
          </Link>
        </section>
      ) : (
        <>
          <section className="notice">
            <strong>{t('Предварительная оценка')}</strong>
            <p>{result.notice}</p>
            <p>
              {t('Верных ответов: ')}
              {result.correct} {t(' из ')}
              {result.questions} · {result.percent}%
            </p>
          </section>
          <DiagnosticPlanLink diagnosticId={diagnostic.id} planId={planId} writable={writable} />
          <div className="diagnostic-columns">
            <section className="panel">
              <h2>{t('Сильные стороны в этом наборе')}</h2>
              {result.strengthIds.length ? (
                <ul>
                  {result.skills
                    .filter((s) => result.strengthIds.includes(s.skillId))
                    .map((s) => (
                      <li key={s.skillId}>{s.name}</li>
                    ))}
                </ul>
              ) : (
                <p>{t('Пока не отмечены. Следующая практика поможет уточнить результат.')}</p>
              )}
            </section>
            <section className="panel">
              <h2>{t('Что стоит потренировать')}</h2>
              {result.difficultyIds.length ? (
                <ul>
                  {result.skills
                    .filter((s) => result.difficultyIds.includes(s.skillId))
                    .map((s) => (
                      <li key={s.skillId}>{s.name}</li>
                    ))}
                </ul>
              ) : (
                <p>{t('В этом наборе затруднений не отмечено.')}</p>
              )}
            </section>
          </div>
          <h2>{t('Результаты по навыкам')}</h2>
          <div className="skill-results">
            {result.skills.map((skill) => (
              <article className="panel" key={skill.skillId} data-testid="skill-result">
                <h3>{skill.name}</h3>
                <p>{skill.description}</p>
                <p>
                  {skill.correct}/{skill.questions} {t(' верно · ')}
                  {skill.percent}%
                </p>
                <progress
                  max={100}
                  value={skill.percent}
                  aria-label={`${skill.name}: ${skill.percent}%`}
                />
                <p className="muted">
                  {t('Самостоятельно верно: ')}
                  {skill.independentCorrect} {t(' · С помощью или после обратной связи: ')}
                  {skill.assistedCorrect}
                </p>
                <p className="muted">
                  {t('Короткий набор: ')}
                  {skill.questions} {skill.questions === 1 ? t('задание') : t('заданий')}{' '}
                  {t('по этому навыку.')}
                </p>
              </article>
            ))}
          </div>
          <p>
            {t('Результат сохранён: ')}
            {new Date(result.evaluatedAt).toLocaleString(dateLocale)}
          </p>
        </>
      )}
      <p>
        <Link to={`/learning/runs/${diagnostic.runId}`}>{t('Ответы и история прохождения →')}</Link>
      </p>
      {writable && (
        <p>
          <Link to={`/onboarding?userId=${diagnostic.user.id}`}>
            {t('Анкета и повторная диагностика →')}
          </Link>
        </p>
      )}
    </>
  );
}
