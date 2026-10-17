import { StudentDirectory } from '../components/StudentDirectory';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import {
  learningReportViewSchema,
  reportAttemptsPageSchema,
  reportChangesPageSchema,
  reportIntegrityPageSchema,
  type LearningReport,
  type ReportIntegrity,
  type ReportAttempt,
} from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { LoadingState, ErrorState, EmptyState } from '../components/States';
import { goalLabels, languageLabels } from '../components/QuestionnaireSummary';

const date = (value: string) => new Date(value).toLocaleString('ru-RU');
const number = (value: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
const purposeLabels = {
  practice: 'Тренировка',
  diagnostic: 'Входная диагностика',
  control: 'Контрольная проверка',
};
const helpLabels = {
  hint: 'Подсказка',
  prior_feedback: 'После обратной связи',
  assistant: 'Помощник',
  administrator: 'Помощь администратора',
  other_actor: 'Ответил другой пользователь',
};
const skillLabels = {
  learning: 'Первые наблюдения',
  needs_practice: 'Нужна практика',
  supported: 'Успех с помощью',
  demonstrated: 'Самостоятельный успех',
  confirmed: 'Подтверждён повторением',
};
const changeLabels: Record<string, string> = {
  correction_added: 'Добавлена коррекция',
  correction_reused: 'Сохранена коррекция',
  supported_practice_added: 'Добавлена самостоятельная практика',
  supported_practice_reused: 'Сохранена самостоятельная практика',
  review_scheduled: 'Назначено повторение',
  review_reused: 'Сохранено повторение',
  next_step_ready: 'Доступен следующий шаг',
  review_confirmed: 'Повторение пройдено',
  bank_unavailable: 'Нужно пополнить банк заданий',
  teacher_assignment_added: 'Назначение преподавателя',
  teacher_assignment_rescheduled: 'Перенос назначения',
  teacher_assignment_cancelled: 'Отмена назначения',
  assessment_reviewed: 'Проверка оценки преподавателем',
};

export function ReportPage() {
  const { session } = useAuth(),
    [search] = useSearchParams(),
    user = session.user!;
  const subject = search.get('userId') ?? (user.role === 'student' ? user.id : null);
  if (user.role === 'admin')
    return (
      <>
        <h1>Учебный отчёт</h1>
        <EmptyState
          title="Нужен доступ к учебным данным"
          description="Отчёт доступен ученику, его преподавателю и суперадмину."
        />
      </>
    );
  if (!subject) return <ReportDirectory />;
  return (
    <ReportContent
      key={`${user.id}:${user.role}:${subject}:${search.get('language') ?? ''}`}
      userId={subject}
      language={search.get('language')}
    />
  );
}
function ReportDirectory() {
  return (
    <>
      <h1>Учебный отчёт</h1>
      <StudentDirectory path="/progress" />
    </>
  );
}
function ReportContent({ userId, language }: { userId: string; language: string | null }) {
  const [search, setSearch] = useSearchParams();
  const { state, refresh } = useResource(
    `/reports/${encodeURIComponent(userId)}${language ? `?language=${encodeURIComponent(language)}` : ''}`,
    learningReportViewSchema,
    true,
  );
  useEffect(() => {
    const fresh = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(fresh, 15000);
    window.addEventListener('focus', fresh);
    document.addEventListener('visibilitychange', fresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', fresh);
      document.removeEventListener('visibilitychange', fresh);
    };
  }, [refresh]);
  if (state.status === 'loading')
    return (
      <>
        <h1>Учебный отчёт</h1>
        <LoadingState text="Собираем сохранённые результаты…" />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        <h1>Учебный отчёт</h1>
        <ErrorState error={state.error} retry={refresh} />
      </>
    );
  const { report: r, reviewer, refreshedAt } = state.data;
  return (
    <>
      <p className="eyebrow">Прогресс и следующие шаги</p>
      <h1>Учебный отчёт</h1>
      <div className="report-toolbar">
        <div>
          <label htmlFor="report-language">Язык отчёта</label>
          <select
            id="report-language"
            value={r.language}
            onChange={(e) => {
              const q = new URLSearchParams(search);
              q.set('language', e.target.value);
              setSearch(q);
            }}
          >
            <option value="ru">РКИ</option>
            <option value="en">Английский</option>
          </select>
        </div>
        <button className="secondary" onClick={refresh}>
          Обновить отчёт
        </button>
      </div>
      <p className="muted" role="status">
        Обновляется автоматически · Получен {date(refreshedAt)}
      </p>
      <div className="report-public" data-testid="report-public" data-revision={r.revision}>
        <section className="panel">
          <h2>{r.user.name}</h2>
          <p>
            {r.user.email} · {languageLabels[r.language]}
          </p>
          {r.profile ? (
            <p>
              Цель: <strong>{goalLabels[r.profile.goal]}</strong> · {r.profile.minutesPerDay} мин. в
              день
            </p>
          ) : (
            <p>Анкета для этого языка ещё не сохранена.</p>
          )}
          <p className="muted">
            {r.updatedAt
              ? `Последнее учебное действие: ${date(r.updatedAt)}`
              : 'Учебных действий пока нет.'}
          </p>
          <Link to={`/progress?userId=${r.user.id}&language=${r.language}`}>
            Ссылка на этот отчёт
          </Link>
        </section>
        <PublicSummary report={r} />
        <NextSteps report={r} />
        <section className="panel" aria-labelledby="report-skills">
          <h2 id="report-skills">Состояние навыков</h2>
          {!r.skills.length ? (
            <p>Навыки появятся после загрузки учебного контента.</p>
          ) : (
            <ul className="skill-state-list">
              {r.skills.map((s) => (
                <li
                  key={`${s.packageId}:${s.packageVersion}:${s.skillId}`}
                  data-testid="report-skill"
                >
                  <h3>{s.title}</h3>
                  <p>
                    <span className="badge">
                      {s.state ? skillLabels[s.state.status] : 'Ещё нет наблюдений'}
                    </span>{' '}
                    · {s.packageId} v{s.packageVersion}
                  </p>
                  <p>{s.description}</p>
                  <p>
                    Самостоятельно верно: {s.counts.independentCorrect} · С подсказкой:{' '}
                    {s.counts.hintedCorrect} · С другой помощью: {s.counts.otherAssistedCorrect} ·
                    Ошибки: {s.counts.incorrectAttempts}
                  </p>
                  <p>Проверено преподавателем: {s.counts.teacherReviewedAttempts}</p>
                  {s.awaitingObservationAttempts > 0 && (
                    <p className="muted">
                      {s.awaitingObservationAttempts} попыток ожидают завершения назначения для
                      обновления состояния навыка.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="report-errors">
          <h2 id="report-errors">Повторяющиеся ошибки</h2>
          <p className="muted">
            Навыки с двумя и более ошибочными попытками по текущим оценкам. Исправления
            преподавателя уже учтены.
          </p>
          {!r.repeatedErrors.length ? (
            <p>Повторяющихся ошибок в доступных результатах пока нет.</p>
          ) : (
            <ul className="account-list">
              {r.repeatedErrors.map((e) => (
                <li key={`${e.packageId}:${e.packageVersion}:${e.skillId}`}>
                  <strong>{e.title}</strong>
                  <p>
                    Ошибок: {e.mistakes} · Разных заданий: {e.exercises} · Последняя:{' '}
                    {date(e.lastAt)}
                  </p>
                  <Link to={`/learning/attempts/${e.lastAttemptId}`}>
                    Посмотреть последний ответ →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="report-attempts">
          <h2 id="report-attempts">Попытки и результаты</h2>
          <Pager
            key={`attempts:${r.revision}`}
            initial={r.recentAttempts}
            schema={reportAttemptsPageSchema}
            endpoint={`/reports/${r.user.id}/attempts?language=${r.language}`}
            getKey={(a) => a.id}
            moreLabel="Предыдущие попытки"
            render={(a) => <Attempt item={a} />}
          />
        </section>
        <section className="panel" aria-labelledby="report-history">
          <h2 id="report-history">Изменения плана</h2>
          <p>
            Всего сохранённых изменений:{' '}
            <strong data-testid="report-change-count">{r.planChangesCount}</strong>
          </p>
          <Pager
            key={`changes:${r.revision}`}
            initial={r.planChanges}
            schema={reportChangesPageSchema}
            endpoint={`/reports/${r.user.id}/changes?language=${r.language}`}
            getKey={(c) => c.id}
            moreLabel="Предыдущие изменения"
            render={(c) => (
              <>
                <strong>
                  {changeLabels[c.action] ?? c.action} · {c.skillName}
                </strong>
                <p>{c.reason}</p>
                <p className="muted">
                  {date(c.createdAt)} · {c.createdByName ?? 'Сохранённое действие'}
                </p>
                <Link to={`/plan/${c.planId}`}>Открыть план →</Link>
                {c.attemptId && (
                  <>
                    {' '}
                    · <Link to={`/learning/attempts/${c.attemptId}`}>Ответ-основание</Link>
                  </>
                )}
              </>
            )}
          />
        </section>
      </div>
      {reviewer && (
        <Reviewer
          key={`private:${r.revision}`}
          data={reviewer}
          userId={r.user.id}
          language={r.language}
        />
      )}
      <p>
        <Link to={`/feedback?userId=${r.user.id}`}>Комментарии и назначения преподавателя →</Link> ·{' '}
        <Link to={`/learning?userId=${r.user.id}`}>История обучения →</Link>
      </p>
    </>
  );
}
function PublicSummary({ report: r }: { report: LearningReport }) {
  const c = r.counts;
  return (
    <section className="panel" aria-labelledby="report-summary">
      <h2 id="report-summary">Учебные результаты</h2>
      <dl className="dashboard-stats">
        <div>
          <dt>Самостоятельно верно</dt>
          <dd data-testid="report-independent">{c.independentCorrect}</dd>
        </div>
        <div>
          <dt>Верно с помощью</dt>
          <dd data-testid="report-assisted">{c.assistedCorrect}</dd>
        </div>
        <div>
          <dt>Попытки с ошибкой</dt>
          <dd data-testid="report-mistakes">{c.incorrectAttempts}</dd>
        </div>
        <div>
          <dt>Проверено преподавателем</dt>
          <dd data-testid="report-reviewed">{c.teacherReviewedAttempts}</dd>
        </div>
        <div>
          <dt>Выполнено шагов</dt>
          <dd data-testid="report-steps">{r.completion.completedSteps}</dd>
        </div>
        <div>
          <dt>Завершено назначений</dt>
          <dd data-testid="report-assignments">{r.completion.completedAssignments}</dd>
        </div>
      </dl>
      <p>
        Получено ответов: <strong data-testid="report-submitted">{c.submittedAttempts}</strong> ·
        Доступно оценок: {c.evaluatedAttempts} · Разных выполненных заданий:{' '}
        {r.completion.uniqueExercises}
      </p>
      <p>
        Успехи с подсказкой: {c.hintedCorrect} · С другой помощью или после обратной связи:{' '}
        {c.otherAssistedCorrect}
      </p>
      <p>
        Последние решения преподавателя: подтверждено {c.teacherConfirmedAttempts}, исправлено{' '}
        {c.teacherCorrectedAttempts}. Исходных автоматических ошибок: {c.automaticIncorrectAttempts}
        .
      </p>
      <p className="muted">
        Проверка преподавателя учитывается дополнительно к самостоятельности и помощи. Повторные
        попытки считаются отдельно; отменённые назначения не считаются выполненными.
      </p>
      {c.pendingEvaluationAttempts > 0 && (
        <p className="notice" data-testid="report-pending">
          Ожидают завершения диагностики или контроля: {c.pendingEvaluationAttempts}. Эти оценки ещё
          не включены в результаты.
        </p>
      )}
      {!c.evaluatedAttempts && (
        <p>
          Пока нет доступных оценок. Отправленные ответы и завершение обучения сохраняются
          автоматически.
        </p>
      )}
      <details>
        <summary>Подробности выполнения</summary>
        <p>
          Завершено прохождений: {r.completion.completedRuns} · Уроков из каталога:{' '}
          {r.completion.completedLessons} · Активных назначений: {r.completion.activeAssignments} ·
          Ещё не начато: {r.completion.pendingAssignments} · Отменено:{' '}
          {r.completion.cancelledAssignments}
        </p>
        <p>Активное время в оценённых попытках: {number(c.activeMilliseconds / 60000)} мин.</p>
        <ul>
          {r.byPurpose.map((p) => (
            <li key={p.purpose}>
              {purposeLabels[p.purpose]}: {p.counts.correctAttempts} верно из{' '}
              {p.counts.evaluatedAttempts} оценённых попыток
              {p.counts.pendingEvaluationAttempts > 0
                ? ` · ещё ${p.counts.pendingEvaluationAttempts} ожидают завершения`
                : ''}
            </li>
          ))}
        </ul>
      </details>
      {r.diagnostic && (
        <div className="report-diagnostic">
          <h3>Входная диагностика</h3>
          {r.diagnostic.result ? (
            <>
              <p>
                Предварительный результат: {r.diagnostic.result.correct} из{' '}
                {r.diagnostic.result.questions}. {r.diagnostic.result.notice}
              </p>
              <p className="muted">
                Снимок диагностики сохранён; последующие решения преподавателя учтены в текущих
                результатах выше.
              </p>
            </>
          ) : (
            <p>
              Диагностика не завершена: {r.diagnostic.summary.answeredQuestions} из{' '}
              {r.diagnostic.summary.totalQuestions} ответов.
            </p>
          )}
          <Link to={`/diagnostics/${r.diagnostic.summary.id}`}>Открыть диагностику →</Link>
        </div>
      )}
    </section>
  );
}
function NextSteps({ report: r }: { report: LearningReport }) {
  return (
    <section className="panel" aria-labelledby="report-next">
      <h2 id="report-next">Следующие учебные шаги</h2>
      {r.next.continueRun && (
        <p>
          <Link className="button-link" to={`/learning/runs/${r.next.continueRun.id}`}>
            Открыть текущий урок: {r.next.continueRun.title}
          </Link>
        </p>
      )}
      {r.next.plan && (
        <p>
          В текущем плане выполнено {r.next.plan.completedAssignments} из{' '}
          {r.next.plan.totalAssignments} назначений.{' '}
          <Link to={`/plan/${r.next.plan.id}`}>Открыть план →</Link>
        </p>
      )}
      {r.profile && r.next.plan && r.profile.revision !== r.next.plan.profileRevision && (
        <p className="notice">
          Анкета обновлена после создания этого плана. Для нового плана можно пройти диагностику
          заново.
        </p>
      )}
      <ul className="account-list">
        {r.next.assignments.map((a) => (
          <li key={a.id}>
            <strong>{a.title}</strong>
            <p>{a.reason}</p>
            <p>
              {a.status === 'active'
                ? 'Уже начато'
                : a.canStart
                  ? 'Доступно'
                  : a.dueAt
                    ? `Откроется ${date(a.dueAt)}`
                    : 'Ожидает начала'}
              {a.kind === 'review' ? ' · Повторение' : ''}
            </p>
            <Link to={`/plan/${a.planId}`}>Открыть назначение в плане →</Link>
          </li>
        ))}
      </ul>
      {!r.next.assignments.length && !r.next.continueRun && (
        <p>
          {r.next.plan
            ? 'Незавершённых назначений нет. Можно посмотреть пройденные задания или обновить диагностику.'
            : 'Для индивидуальных назначений сохраните анкету и завершите входную диагностику.'}{' '}
          <Link to={`/onboarding?userId=${r.user.id}`}>Анкета и диагностика →</Link>
        </p>
      )}
      {r.next.outstandingAssignments > r.next.assignments.length && (
        <p>
          Ещё назначений: {r.next.outstandingAssignments - r.next.assignments.length}. Они доступны
          в планах.
        </p>
      )}
    </section>
  );
}
function Attempt({ item: a }: { item: ReportAttempt }) {
  return (
    <>
      <strong>{a.runTitle}</strong>
      <p>{a.instruction}</p>
      <p>
        {a.correct === null
          ? 'Оценка после завершения набора'
          : a.correct
            ? 'Верно'
            : 'Есть ошибка'}{' '}
        · {purposeLabels[a.purpose]} · {a.skillTitle}
      </p>
      {a.independent !== null && (
        <p>
          {a.independent
            ? 'Самостоятельно'
            : a.help.map((h) => helpLabels[h]).join(' · ') || 'С помощью'}
        </p>
      )}
      {a.teacherReview && (
        <p>
          Проверено: {a.teacherReview.author.name} ·{' '}
          {a.teacherReview.decision === 'confirm' ? 'Подтверждено' : 'Исправлена оценка'}.{' '}
          {a.teacherReview.comment} · Исходная оценка: {a.automaticCorrect ? 'верно' : 'ошибка'}.
        </p>
      )}
      <p className="muted">
        {date(a.evaluatedAt)} · Попытка {a.number}
      </p>
      <Link to={`/learning/attempts/${a.id}`}>Ответ и история проверки →</Link>
    </>
  );
}

function Reviewer({
  data: d,
  userId,
  language,
}: {
  data: ReportIntegrity;
  userId: string;
  language: 'ru' | 'en';
}) {
  return (
    <section
      className="panel report-reviewer"
      aria-labelledby="report-private"
      data-testid="report-reviewer"
    >
      <p className="eyebrow">Только преподавателю и суперадмину</p>
      <h2 id="report-private">Контекст честности и вес свидетельств</h2>
      <p>
        Условные веса помогают оценить сохранённые наблюдения. Это не вероятность нарушения и не
        учебный балл. Сигналы требуют проверки с учётом устройства, доступности и объяснения
        ученика.
      </p>
      <dl className="dashboard-stats">
        <div>
          <dt>Самостоятельных успехов</dt>
          <dd>{d.independentCorrect}</dd>
        </div>
        <div>
          <dt>Вес этих свидетельств</dt>
          <dd data-testid="report-weighted">{number(d.weightedEvidenceUnits)}</dd>
        </div>
        <div>
          <dt>Влияние наблюдений</dt>
          <dd data-testid="report-weight-loss">−{number(d.evidenceReductionUnits)}</dd>
        </div>
      </dl>
      <p>
        Попыток с данными: {d.assessedAttempts} · Без достаточных данных:{' '}
        {d.insufficientDataAttempts} · С наблюдениями: {d.flaggedAttempts} · С сохранённым флагом
        проверки: {d.requiresReviewAttempts}.
      </p>
      <p className="muted">
        Для {d.independentCorrectWithoutData} самостоятельных успехов данных недостаточно: вес не
        снижен, честность этим не подтверждена. Учебная проверка преподавателя показывается отдельно
        и не удаляет исходные наблюдения.
      </p>
      <details>
        <summary>Как рассчитано влияние</summary>
        <p>
          Базовый вес попытки — 1. Каждый вид наблюдения учитывается один раз; суммарное снижение
          ограничено {d.policy.maxReductionBasisPoints / 100}%. При ограничении вклады
          распределяются пропорционально. Версия правил: {d.version}.
        </p>
        <div className="report-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Наблюдение</th>
                <th>Снижение веса попытки</th>
                <th>Попыток</th>
                <th>Вклад в снижение свидетельств</th>
              </tr>
            </thead>
            <tbody>
              {d.signalImpact.map((s) => (
                <tr key={s.code}>
                  <td>{s.label}</td>
                  <td>{s.reductionBasisPoints / 100}%</td>
                  <td>{s.attempts}</td>
                  <td>{number(s.evidenceReductionBasisPoints / 10000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          В общую разницу входят только успешные самостоятельные ответы. Ошибки и ответы с помощью
          сохраняют свой учебный результат. Неизвестным видам сигналов эта версия правил не
          назначает снижение.
        </p>
      </details>
      <details>
        <summary>Вес свидетельств по навыкам</summary>
        <ul className="account-list">
          {d.skills.map((s) => (
            <li key={`${s.packageId}:${s.packageVersion}:${s.skillId}`}>
              <strong>{s.title}</strong>
              <span>
                {s.packageId} v{s.packageVersion} · Самостоятельных успехов {s.independentCorrect} ·
                Вес {number(s.weightedEvidenceUnits)} · Изменение −
                {number(s.evidenceReductionUnits)}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <h3>Попытки с наблюдениями</h3>
      <Pager
        initial={d.attempts}
        schema={reportIntegrityPageSchema}
        endpoint={`/reports/${userId}/integrity?language=${language}`}
        getKey={(a) => a.id}
        moreLabel="Предыдущие наблюдения"
        render={(a) => (
          <>
            <strong>
              {a.runTitle} · {a.skillTitle}
            </strong>
            <p>
              {date(a.evaluatedAt)} · Вес попытки {a.weightBasisPoints / 100}% · Вклад в снижение
              свидетельств {number(a.evidenceReductionBasisPoints / 10000)}
            </p>
            <p>
              {a.correct ? 'Верно' : 'Есть ошибка'} ·{' '}
              {a.independent ? 'Самостоятельно' : 'С помощью'}
              {a.teacherReviewed ? ' · Учебная оценка проверена преподавателем' : ''}
            </p>
            <ul>
              {a.assessment.signals.map((s, i) => (
                <li key={`${s.code}:${i}`}>
                  <strong>{s.label}</strong>: {s.context} ·{' '}
                  {s.source === 'server' ? 'Серверное наблюдение' : 'Сообщено браузером'}
                </li>
              ))}
            </ul>
            {a.unknownSignalCodes.length > 0 && (
              <p>Без правила веса: {a.unknownSignalCodes.join(', ')}.</p>
            )}
            <p className="muted">
              Версия наблюдений {a.assessment.assessorVersion} · Пакетов {a.assessment.packetCount}
            </p>
            <Link to={`/learning/attempts/${a.id}`}>Проверить ответ и оставить комментарий →</Link>
          </>
        )}
      />
    </section>
  );
}
type Page<T> = { items: T[]; nextCursor: { createdAt: string; id: string } | null };
function Pager<T>({
  initial,
  schema,
  endpoint,
  getKey,
  render,
  moreLabel,
}: {
  initial: Page<T>;
  schema: z.ZodType<Page<T>>;
  endpoint: string;
  getKey: (item: T) => string;
  render: (item: T) => ReactNode;
  moreLabel: string;
}) {
  const [page, setPage] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function more() {
    if (!page.nextCursor || busy) return;
    setBusy(true);
    const c = new AbortController();
    controller.current = c;
    try {
      const result = await api(
        `${endpoint}&beforeCreatedAt=${encodeURIComponent(page.nextCursor.createdAt)}&beforeId=${page.nextCursor.id}`,
        schema,
        { signal: c.signal },
      );
      if (c.signal.aborted) return;
      const items = [
        ...new Map([...page.items, ...result.items].map((item) => [getKey(item), item])).values(),
      ];
      setPage({ ...result, items });
      setError(null);
    } catch (e) {
      if (!c.signal.aborted) setError(e as Error);
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      {!page.items.length ? (
        <p>Записей пока нет.</p>
      ) : (
        <ul className="account-list report-history">
          {page.items.map((item) => (
            <li key={getKey(item)}>{render(item)}</li>
          ))}
        </ul>
      )}
      {error && <ErrorState error={error} retry={() => void more()} />}
      {page.nextCursor && (
        <button className="secondary" disabled={busy} onClick={() => void more()}>
          {busy ? 'Загружаем…' : moreLabel}
        </button>
      )}
    </>
  );
}
