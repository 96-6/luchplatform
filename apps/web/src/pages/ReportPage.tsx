import { t, dateLocale } from '../i18n';
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

const date = (value: string) => new Date(value).toLocaleString(dateLocale);
const number = (value: number) =>
  new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 4 }).format(value);
const purposeLabels = {
  practice: t('Тренировка'),
  diagnostic: t('Входная диагностика'),
  control: t('Контрольная проверка'),
};
const helpLabels = {
  hint: t('Подсказка'),
  prior_feedback: t('После обратной связи'),
  assistant: t('Помощник'),
  administrator: t('Помощь администратора'),
  other_actor: t('Ответил другой пользователь'),
};
const skillLabels = {
  learning: t('Первые наблюдения'),
  needs_practice: t('Нужна практика'),
  supported: t('Успех с помощью'),
  demonstrated: t('Самостоятельный успех'),
  confirmed: t('Подтверждён повторением'),
};
const changeLabels: Record<string, string> = {
  correction_added: t('Добавлена коррекция'),
  correction_reused: t('Сохранена коррекция'),
  supported_practice_added: t('Добавлена самостоятельная практика'),
  supported_practice_reused: t('Сохранена самостоятельная практика'),
  review_scheduled: t('Назначено повторение'),
  review_reused: t('Сохранено повторение'),
  next_step_ready: t('Доступен следующий шаг'),
  review_confirmed: t('Повторение пройдено'),
  bank_unavailable: t('Нужно пополнить банк заданий'),
  teacher_assignment_added: t('Назначение преподавателя'),
  teacher_assignment_rescheduled: t('Перенос назначения'),
  teacher_assignment_cancelled: t('Отмена назначения'),
  assessment_reviewed: t('Проверка оценки преподавателем'),
};

export function ReportPage() {
  const { session } = useAuth(),
    [search] = useSearchParams(),
    user = session.user!;
  const subject = search.get('userId') ?? (user.role === 'student' ? user.id : null);
  if (user.role === 'admin')
    return (
      <>
        <h1>{t('Учебный отчёт')}</h1>
        <EmptyState
          title={t('Нужен доступ к учебным данным')}
          description={t('Отчёт доступен ученику, его преподавателю и суперадмину.')}
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
      <h1>{t('Учебный отчёт')}</h1>
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
        <h1>{t('Учебный отчёт')}</h1>
        <LoadingState text={t('Собираем сохранённые результаты…')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        <h1>{t('Учебный отчёт')}</h1>
        <ErrorState error={state.error} retry={refresh} />
      </>
    );
  const { report: r, reviewer, refreshedAt } = state.data;
  return (
    <>
      <p className="eyebrow">{t('Прогресс и следующие шаги')}</p>
      <h1>{t('Учебный отчёт')}</h1>
      <div className="report-toolbar">
        <div>
          <label htmlFor="report-language">{t('Язык отчёта')}</label>
          <select
            id="report-language"
            value={r.language}
            onChange={(e) => {
              const q = new URLSearchParams(search);
              q.set('language', e.target.value);
              setSearch(q);
            }}
          >
            <option value="ru">{t('РКИ')}</option>
            <option value="en">{t('Английский')}</option>
          </select>
        </div>
        <button className="secondary" onClick={refresh}>
          {t('Обновить отчёт')}
        </button>
      </div>
      <p className="muted" role="status">
        {t('Обновляется автоматически · Получен ')}
        {date(refreshedAt)}
      </p>
      <div className="report-public" data-testid="report-public" data-revision={r.revision}>
        <section className="panel">
          <h2>{r.user.name}</h2>
          <p>
            {r.user.email} · {languageLabels[r.language]}
          </p>
          {r.profile ? (
            <p>
              {t('Цель: ')}
              <strong>{goalLabels[r.profile.goal]}</strong> · {r.profile.minutesPerDay}{' '}
              {t(' мин. в день')}
            </p>
          ) : (
            <p>{t('Анкета для этого языка ещё не сохранена.')}</p>
          )}
          <p className="muted">
            {r.updatedAt
              ? t('Последнее учебное действие: {0}', [date(r.updatedAt)])
              : t('Учебных действий пока нет.')}
          </p>
          <Link to={`/progress?userId=${r.user.id}&language=${r.language}`}>
            {t('Ссылка на этот отчёт')}
          </Link>
        </section>
        <PublicSummary report={r} />
        <NextSteps report={r} />
        <section className="panel" aria-labelledby="report-skills">
          <h2 id="report-skills">{t('Состояние навыков')}</h2>
          {!r.skills.length ? (
            <p>{t('Навыки появятся после загрузки учебного контента.')}</p>
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
                      {s.state ? skillLabels[s.state.status] : t('Ещё нет наблюдений')}
                    </span>{' '}
                    · {s.packageId} v{s.packageVersion}
                  </p>
                  <p>{s.description}</p>
                  <p>
                    {t('Самостоятельно верно: ')}
                    {s.counts.independentCorrect} {t(' · С подсказкой:')} {s.counts.hintedCorrect}{' '}
                    {t(' · С другой помощью: ')}
                    {s.counts.otherAssistedCorrect} {t(' · Ошибки: ')}
                    {s.counts.incorrectAttempts}
                  </p>
                  <p>
                    {t('Проверено преподавателем: ')}
                    {s.counts.teacherReviewedAttempts}
                  </p>
                  {s.awaitingObservationAttempts > 0 && (
                    <p className="muted">
                      {s.awaitingObservationAttempts}{' '}
                      {t(' попыток ожидают завершения назначения для обновления состояния навыка.')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="report-errors">
          <h2 id="report-errors">{t('Повторяющиеся ошибки')}</h2>
          <p className="muted">
            {t(
              'Навыки с двумя и более ошибочными попытками по текущим оценкам. Исправления преподавателя уже учтены.',
            )}
          </p>
          {!r.repeatedErrors.length ? (
            <p>{t('Повторяющихся ошибок в доступных результатах пока нет.')}</p>
          ) : (
            <ul className="account-list">
              {r.repeatedErrors.map((e) => (
                <li key={`${e.packageId}:${e.packageVersion}:${e.skillId}`}>
                  <strong>{e.title}</strong>
                  <p>
                    {t('Ошибок: ')}
                    {e.mistakes} {t(' · Разных заданий: ')}
                    {e.exercises} {t(' · Последняя:')} {date(e.lastAt)}
                  </p>
                  <Link to={`/learning/attempts/${e.lastAttemptId}`}>
                    {t('Посмотреть последний ответ →')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="report-attempts">
          <h2 id="report-attempts">{t('Попытки и результаты')}</h2>
          <Pager
            key={`attempts:${r.revision}`}
            initial={r.recentAttempts}
            schema={reportAttemptsPageSchema}
            endpoint={`/reports/${r.user.id}/attempts?language=${r.language}`}
            getKey={(a) => a.id}
            moreLabel={t('Предыдущие попытки')}
            render={(a) => <Attempt item={a} />}
          />
        </section>
        <section className="panel" aria-labelledby="report-history">
          <h2 id="report-history">{t('Изменения плана')}</h2>
          <p>
            {t('Всего сохранённых изменений:')}{' '}
            <strong data-testid="report-change-count">{r.planChangesCount}</strong>
          </p>
          <Pager
            key={`changes:${r.revision}`}
            initial={r.planChanges}
            schema={reportChangesPageSchema}
            endpoint={`/reports/${r.user.id}/changes?language=${r.language}`}
            getKey={(c) => c.id}
            moreLabel={t('Предыдущие изменения')}
            render={(c) => (
              <>
                <strong>
                  {changeLabels[c.action] ?? c.action} · {c.skillName}
                </strong>
                <p>{c.action.startsWith('teacher_') ? c.reason : t(c.reason)}</p>
                <p className="muted">
                  {date(c.createdAt)} · {c.createdByName ?? t('Сохранённое действие')}
                </p>
                <Link to={`/plan/${c.planId}`}>{t('Открыть план →')}</Link>
                {c.attemptId && (
                  <>
                    {' '}
                    · <Link to={`/learning/attempts/${c.attemptId}`}>{t('Ответ-основание')}</Link>
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
        <Link to={`/feedback?userId=${r.user.id}`}>
          {t('Комментарии и назначения преподавателя →')}
        </Link>{' '}
        · <Link to={`/learning?userId=${r.user.id}`}>{t('История обучения →')}</Link>
      </p>
    </>
  );
}
function PublicSummary({ report: r }: { report: LearningReport }) {
  const c = r.counts;
  return (
    <section className="panel" aria-labelledby="report-summary">
      <h2 id="report-summary">{t('Учебные результаты')}</h2>
      <dl className="dashboard-stats">
        <div>
          <dt>{t('Самостоятельно верно')}</dt>
          <dd data-testid="report-independent">{c.independentCorrect}</dd>
        </div>
        <div>
          <dt>{t('Верно с помощью')}</dt>
          <dd data-testid="report-assisted">{c.assistedCorrect}</dd>
        </div>
        <div>
          <dt>{t('Попытки с ошибкой')}</dt>
          <dd data-testid="report-mistakes">{c.incorrectAttempts}</dd>
        </div>
        <div>
          <dt>{t('Проверено преподавателем')}</dt>
          <dd data-testid="report-reviewed">{c.teacherReviewedAttempts}</dd>
        </div>
        <div>
          <dt>{t('Выполнено шагов')}</dt>
          <dd data-testid="report-steps">{r.completion.completedSteps}</dd>
        </div>
        <div>
          <dt>{t('Завершено назначений')}</dt>
          <dd data-testid="report-assignments">{r.completion.completedAssignments}</dd>
        </div>
      </dl>
      <p>
        {t('Получено ответов: ')}
        <strong data-testid="report-submitted">{c.submittedAttempts}</strong>{' '}
        {t(' · Доступно оценок: ')}
        {c.evaluatedAttempts} {t(' · Разных выполненных заданий:')} {r.completion.uniqueExercises}
      </p>
      <p>
        {t('Успехи с подсказкой: ')}
        {c.hintedCorrect} {t(' · С другой помощью или после обратной связи:')}{' '}
        {c.otherAssistedCorrect}
      </p>
      <p>
        {t('Последние решения преподавателя: подтверждено ')}
        {c.teacherConfirmedAttempts}
        {t(', исправлено')} {c.teacherCorrectedAttempts}
        {t('. Исходных автоматических ошибок: ')}
        {c.automaticIncorrectAttempts}.
      </p>
      <p className="muted">
        {t(
          'Проверка преподавателя учитывается дополнительно к самостоятельности и помощи. Повторные попытки считаются отдельно; отменённые назначения не считаются выполненными.',
        )}
      </p>
      {c.pendingEvaluationAttempts > 0 && (
        <p className="notice" data-testid="report-pending">
          {t('Ожидают завершения диагностики или контроля: ')}
          {c.pendingEvaluationAttempts}
          {t('. Эти оценки ещё не включены в результаты.')}
        </p>
      )}
      {!c.evaluatedAttempts && (
        <p>
          {t(
            'Пока нет доступных оценок. Отправленные ответы и завершение обучения сохраняются автоматически.',
          )}
        </p>
      )}
      <details>
        <summary>{t('Подробности выполнения')}</summary>
        <p>
          {t('Завершено прохождений: ')}
          {r.completion.completedRuns} {t(' · Уроков из каталога:')} {r.completion.completedLessons}{' '}
          {t(' · Активных назначений: ')}
          {r.completion.activeAssignments} {t(' · Ещё не начато: ')}
          {r.completion.pendingAssignments} {t(' · Отменено:')} {r.completion.cancelledAssignments}
        </p>
        <p>
          {t('Активное время в оценённых попытках: ')}
          {number(c.activeMilliseconds / 60000)} {t(' мин.')}
        </p>
        <ul>
          {r.byPurpose.map((p) => (
            <li key={p.purpose}>
              {purposeLabels[p.purpose]}: {p.counts.correctAttempts} {t(' верно из')}{' '}
              {p.counts.evaluatedAttempts} {t(' оценённых попыток')}
              {p.counts.pendingEvaluationAttempts > 0
                ? t(' · ещё {0} ожидают завершения', [p.counts.pendingEvaluationAttempts])
                : ''}
            </li>
          ))}
        </ul>
      </details>
      {r.diagnostic && (
        <div className="report-diagnostic">
          <h3>{t('Входная диагностика')}</h3>
          {r.diagnostic.result ? (
            <>
              <p>
                {t('Предварительный результат: ')}
                {r.diagnostic.result.correct} {t(' из')} {r.diagnostic.result.questions}.{' '}
                {r.diagnostic.result.notice}
              </p>
              <p className="muted">
                {t(
                  'Снимок диагностики сохранён; последующие решения преподавателя учтены в текущих результатах выше.',
                )}
              </p>
            </>
          ) : (
            <p>
              {t('Диагностика не завершена: ')}
              {r.diagnostic.summary.answeredQuestions} {t(' из')}{' '}
              {r.diagnostic.summary.totalQuestions} {t(' ответов.')}
            </p>
          )}
          <Link to={`/diagnostics/${r.diagnostic.summary.id}`}>{t('Открыть диагностику →')}</Link>
        </div>
      )}
    </section>
  );
}
function NextSteps({ report: r }: { report: LearningReport }) {
  return (
    <section className="panel" aria-labelledby="report-next">
      <h2 id="report-next">{t('Следующие учебные шаги')}</h2>
      {r.next.continueRun && (
        <p>
          <Link className="button-link" to={`/learning/runs/${r.next.continueRun.id}`}>
            {t('Открыть текущий урок: ')}
            {r.next.continueRun.title}
          </Link>
        </p>
      )}
      {r.next.plan && (
        <p>
          {t('В текущем плане выполнено ')}
          {r.next.plan.completedAssignments} {t(' из')} {r.next.plan.totalAssignments}{' '}
          {t(' назначений.')} <Link to={`/plan/${r.next.plan.id}`}>{t('Открыть план →')}</Link>
        </p>
      )}
      {r.profile && r.next.plan && r.profile.revision !== r.next.plan.profileRevision && (
        <p className="notice">
          {t(
            'Анкета обновлена после создания этого плана. Для нового плана можно пройти диагностику заново.',
          )}
        </p>
      )}
      <ul className="account-list">
        {r.next.assignments.map((a) => (
          <li key={a.id}>
            <strong>{a.title}</strong>
            <p>{a.kind === 'teacher' ? a.reason : t(a.reason)}</p>
            <p>
              {a.status === 'active'
                ? t('Уже начато')
                : a.canStart
                  ? t('Доступно')
                  : a.dueAt
                    ? t('Откроется {0}', [date(a.dueAt)])
                    : t('Ожидает начала')}
              {a.kind === 'review' ? t(' · Повторение') : ''}
            </p>
            <Link to={`/plan/${a.planId}`}>{t('Открыть назначение в плане →')}</Link>
          </li>
        ))}
      </ul>
      {!r.next.assignments.length && !r.next.continueRun && (
        <p>
          {r.next.plan
            ? t(
                'Незавершённых назначений нет. Можно посмотреть пройденные задания или обновить диагностику.',
              )
            : t(
                'Для индивидуальных назначений сохраните анкету и завершите входную диагностику.',
              )}{' '}
          <Link to={`/onboarding?userId=${r.user.id}`}>{t('Анкета и диагностика →')}</Link>
        </p>
      )}
      {r.next.outstandingAssignments > r.next.assignments.length && (
        <p>
          {t('Ещё назначений: ')}
          {r.next.outstandingAssignments - r.next.assignments.length}
          {t('. Они доступны в планах.')}
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
          ? t('Оценка после завершения набора')
          : a.correct
            ? t('Верно')
            : t('Есть ошибка')}{' '}
        · {purposeLabels[a.purpose]} · {a.skillTitle}
      </p>
      {a.independent !== null && (
        <p>
          {a.independent
            ? t('Самостоятельно')
            : a.help.map((h) => helpLabels[h]).join(' · ') || t('С помощью')}
        </p>
      )}
      {a.teacherReview && (
        <p>
          {t('Проверено: ')}
          {a.teacherReview.author.name} ·{' '}
          {a.teacherReview.decision === 'confirm' ? t('Подтверждено') : t('Исправлена оценка')}.{' '}
          {a.teacherReview.comment} {t(' · Исходная оценка: ')}
          {a.automaticCorrect ? t('верно') : t('ошибка')}.
        </p>
      )}
      <p className="muted">
        {date(a.evaluatedAt)} {t(' · Попытка ')}
        {a.number}
      </p>
      <Link to={`/learning/attempts/${a.id}`}>{t('Ответ и история проверки →')}</Link>
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
      <p className="eyebrow">{t('Только преподавателю и суперадмину')}</p>
      <h2 id="report-private">{t('Контекст честности и вес свидетельств')}</h2>
      <p>
        {t(
          'Условные веса помогают оценить сохранённые наблюдения. Это не вероятность нарушения и не учебный балл. Сигналы требуют проверки с учётом устройства, доступности и объяснения ученика.',
        )}
      </p>
      <dl className="dashboard-stats">
        <div>
          <dt>{t('Самостоятельных успехов')}</dt>
          <dd>{d.independentCorrect}</dd>
        </div>
        <div>
          <dt>{t('Вес этих свидетельств')}</dt>
          <dd data-testid="report-weighted">{number(d.weightedEvidenceUnits)}</dd>
        </div>
        <div>
          <dt>{t('Влияние наблюдений')}</dt>
          <dd data-testid="report-weight-loss">−{number(d.evidenceReductionUnits)}</dd>
        </div>
      </dl>
      <p>
        {t('Попыток с данными: ')}
        {d.assessedAttempts} {t(' · Без достаточных данных:')} {d.insufficientDataAttempts}{' '}
        {t(' · С наблюдениями: ')}
        {d.flaggedAttempts} {t(' · С сохранённым флагом проверки: ')}
        {d.requiresReviewAttempts}.
      </p>
      <p className="muted">
        {t('Для ')}
        {d.independentCorrectWithoutData}{' '}
        {t(
          ' самостоятельных успехов данных недостаточно: вес не снижен, честность этим не подтверждена. Учебная проверка преподавателя показывается отдельно и не удаляет исходные наблюдения.',
        )}
      </p>
      <details>
        <summary>{t('Как рассчитано влияние')}</summary>
        <p>
          {t(
            'Базовый вес попытки — 1. Каждый вид наблюдения учитывается один раз; суммарное снижение ограничено ',
          )}
          {d.policy.maxReductionBasisPoints / 100}
          {t('%. При ограничении вклады распределяются пропорционально. Версия правил: ')}
          {d.version}.
        </p>
        <div className="report-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Наблюдение')}</th>
                <th>{t('Снижение веса попытки')}</th>
                <th>{t('Попыток')}</th>
                <th>{t('Вклад в снижение свидетельств')}</th>
              </tr>
            </thead>
            <tbody>
              {d.signalImpact.map((s) => (
                <tr key={s.code}>
                  <td>{t(s.label)}</td>
                  <td>{s.reductionBasisPoints / 100}%</td>
                  <td>{s.attempts}</td>
                  <td>{number(s.evidenceReductionBasisPoints / 10000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          {t(
            'В общую разницу входят только успешные самостоятельные ответы. Ошибки и ответы с помощью сохраняют свой учебный результат. Неизвестным видам сигналов эта версия правил не назначает снижение.',
          )}
        </p>
      </details>
      <details>
        <summary>{t('Вес свидетельств по навыкам')}</summary>
        <ul className="account-list">
          {d.skills.map((s) => (
            <li key={`${s.packageId}:${s.packageVersion}:${s.skillId}`}>
              <strong>{s.title}</strong>
              <span>
                {s.packageId} v{s.packageVersion} {t(' · Самостоятельных успехов ')}
                {s.independentCorrect} {t(' · Вес ')}
                {number(s.weightedEvidenceUnits)} {t(' · Изменение −')}
                {number(s.evidenceReductionUnits)}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <h3>{t('Попытки с наблюдениями')}</h3>
      <Pager
        initial={d.attempts}
        schema={reportIntegrityPageSchema}
        endpoint={`/reports/${userId}/integrity?language=${language}`}
        getKey={(a) => a.id}
        moreLabel={t('Предыдущие наблюдения')}
        render={(a) => (
          <>
            <strong>
              {a.runTitle} · {a.skillTitle}
            </strong>
            <p>
              {date(a.evaluatedAt)} {t(' · Вес попытки ')}
              {a.weightBasisPoints / 100}
              {t('% · Вклад в снижение свидетельств ')}
              {number(a.evidenceReductionBasisPoints / 10000)}
            </p>
            <p>
              {a.correct ? t('Верно') : t('Есть ошибка')} ·{' '}
              {a.independent ? t('Самостоятельно') : t('С помощью')}
              {a.teacherReviewed ? t(' · Учебная оценка проверена преподавателем') : ''}
            </p>
            <ul>
              {a.assessment.signals.map((s, i) => (
                <li key={`${s.code}:${i}`}>
                  <strong>{t(s.label)}</strong>: {t(s.context)} ·{' '}
                  {s.source === 'server' ? t('Серверное наблюдение') : t('Сообщено браузером')}
                </li>
              ))}
            </ul>
            {a.unknownSignalCodes.length > 0 && (
              <p>
                {t('Без правила веса: ')}
                {a.unknownSignalCodes.join(', ')}.
              </p>
            )}
            <p className="muted">
              {t('Версия наблюдений ')}
              {a.assessment.assessorVersion} {t(' · Пакетов ')}
              {a.assessment.packetCount}
            </p>
            <Link to={`/learning/attempts/${a.id}`}>
              {t('Проверить ответ и оставить комментарий →')}
            </Link>
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
        <p>{t('Записей пока нет.')}</p>
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
          {busy ? t('Загружаем…') : moreLabel}
        </button>
      )}
    </>
  );
}
