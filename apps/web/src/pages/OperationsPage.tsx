import { t, dateLocale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  maintenanceOperationSchema,
  operationsOverviewSchema,
  type MaintenanceKind,
  type MaintenanceOperation,
} from '@luch/contracts';
import { useAuth } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
const actionLabels: Record<MaintenanceKind, string> = {
  recover_learning: t('Восстановить обработку учебных событий'),
  retry_video: t('Повторить готовые команды видеосервера'),
  seed_content: t('Загрузить демонстрационные материалы'),
  expire_audio: t('Очистить истёкшие аудиозаписи'),
};
const descriptions: Record<MaintenanceKind, string> = {
  recover_learning: t(
    'Обрабатывает до 50 готовых прохождений за одно действие. Незавершённые закрытые проверки ожидают ученика. Повторы не создают вторые оценки или назначения.',
  ),
  retry_video: t(
    'Доставляет уже сохранённые команды модерации. При недоступности сервера очередь остаётся для следующей попытки.',
  ),
  seed_content: t(
    'Загружает готовый банк РКИ и английского без дубликатов. Пользователи, ответы и действующие версии материалов сохраняются.',
  ),
  expire_audio: t(
    'Удаляет только сырые записи с истёкшим сроком хранения. Текст, результаты и аудио обратной связи сохраняются.',
  ),
};
export function OperationsPage() {
  const { session } = useAuth(),
    root = session.user?.role === 'superadmin';
  const { state, refresh } = useResource('/operations', operationsOverviewSchema, true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [result, setResult] = useState<MaintenanceOperation | null>(null);
  const pending = useRef<{ kind: MaintenanceKind; operationId: string } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 20000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function execute(kind: MaintenanceKind) {
    setBusy(true);
    setError(null);
    setResult(null);
    pending.current ??= { kind, operationId: crypto.randomUUID() };
    try {
      setResult(
        await api('/operations/actions', maintenanceOperationSchema, {
          body: pending.current,
          timeoutMs: 60000,
        }),
      );
      pending.current = null;
      refresh();
    } catch (e) {
      setError(e as Error);
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading')
    return <LoadingState text={t('Проверяем состояние платформы…')} />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const v = state.data,
    c = v.counts;
  return (
    <>
      <p className="eyebrow">{t('Состояние платформы и повседневные действия')}</p>
      <h1>{root ? t('Обслуживание платформы') : t('Кабинет администратора')}</h1>
      <div className="section-heading">
        <p role="status">
          {t('База готова · Обновлено ')}
          {new Date(v.refreshedAt).toLocaleString(dateLocale)}
        </p>
        <button className="secondary" onClick={refresh}>
          {t('Обновить сводку')}
        </button>
      </div>
      <section className="panel">
        <h2>{t('Рабочие разделы')}</h2>
        <div className="button-row">
          <Link className="button-link" to="/schedule">
            {t('Расписание и видеозанятия')}
          </Link>
          <Link className="button-link" to="/admin/providers">
            {t('AI, озвучивание и расходы →')}
          </Link>
          <Link to="/courses">{t('Учебные маршруты')}</Link>
          {root && (
            <>
              <Link to="/admin">{t('Аккаунты и преподаватели')}</Link>
              <Link to="/admin/content">{t('Импорт и экспорт материалов')}</Link>
              <Link to="/admin/learning">{t('Прохождения и ответы')}</Link>
              <Link to="/progress">{t('Учебные отчёты')}</Link>
              <Link to="/admin?tab=security">{t('Настройки безопасности')}</Link>
              <Link to="/admin?tab=audit">{t('Журнал действий')}</Link>
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>{t('Фактическое состояние')}</h2>
        <dl className="dashboard-stats" data-testid="operations-counts">
          <div>
            <dt>{t('Ученики')}</dt>
            <dd>{c.students}</dd>
          </div>
          <div>
            <dt>{t('Преподаватели')}</dt>
            <dd>{c.teachers}</dd>
          </div>
          <div>
            <dt>{t('Маршруты / уроки')}</dt>
            <dd>
              {c.routes} / {c.lessons}
            </dd>
          </div>
          <div>
            <dt>{t('Запланировано занятий')}</dt>
            <dd>{c.scheduledMeetings}</dd>
          </div>
          <div>
            <dt>{t('Идут встречи')}</dt>
            <dd>{c.liveMeetings}</dd>
          </div>
          <div>
            <dt>{t('Готовые учебные события')}</dt>
            <dd data-testid="operations-learning-ready">{c.learningReady}</dd>
          </div>
        </dl>
        <p>
          {t('Ожидают завершения учеником: ')}
          {c.learningDeferred} {t(' · Команд видеосервера в очереди:')} {c.videoPending}{' '}
          {t(' · Неудачных распознаваний: ')}
          {c.speechErrors} {t(' · Неопределённых обращений к провайдерам: ')}
          {c.unknownProviderRequests}
        </p>
        <p className="muted">
          {t(
            'Это техническая сводка. Сбой распознавания или провайдера не считается учебной ошибкой. Платные обращения автоматически не повторяются; их состояние видно в журнале расходов.',
          )}
        </p>
      </section>
      <section className="panel">
        <h2>{t('Подключения')}</h2>
        <ul className="account-list">
          {v.integrations.map((i) => (
            <li key={i.id}>
              <strong>{t(i.title)}</strong>
              <span className="badge">
                {i.configured ? t('Настроено') : t('Требуется настройка')}
              </span>
              <p>{t(i.detail)}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>{t('Обслуживание без консоли')}</h2>
        <p>
          {t(
            'Каждое действие сохраняется с автором. Повтор после разрыва соединения получает результат той же операции.',
          )}
        </p>
        {v.actions.map((kind) => (
          <article className="operation-action" key={kind}>
            <h3>{actionLabels[kind]}</h3>
            <p>{descriptions[kind]}</p>
            <button
              disabled={busy || Boolean(pending.current && pending.current.kind !== kind)}
              onClick={() => void execute(kind)}
            >
              {busy && pending.current?.kind === kind
                ? t('Выполняем…')
                : pending.current?.kind === kind
                  ? t('Повторить получение результата')
                  : actionLabels[kind]}
            </button>
          </article>
        ))}
        {error && (
          <ErrorState
            error={error}
            retry={() => (pending.current ? void execute(pending.current.kind) : refresh())}
          />
        )}
        {result && (
          <p
            role={result.status === 'failed' ? 'alert' : 'status'}
            className={result.status === 'failed' ? 'error' : 'success'}
          >
            {t(result.result?.message)}
            {result.result?.processed !== undefined
              ? t(' Обработано: {0}.', [result.result.processed])
              : ''}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>{t('Последние операции')}</h2>
        {v.recentOperations.length ? (
          <ul className="account-list">
            {v.recentOperations.map((o) => (
              <li key={o.id}>
                <strong>{actionLabels[o.kind]}</strong>
                <p>
                  {o.actorName} · {new Date(o.createdAt).toLocaleString(dateLocale)} ·{' '}
                  {o.status === 'completed'
                    ? t('Завершена')
                    : o.status === 'failed'
                      ? t('Ошибка')
                      : t('Выполняется или прервана')}
                </p>
                <p>{t(o.result?.message)}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('Операций обслуживания пока не было.')}</p>
        )}
      </section>
      {root && (
        <details className="panel">
          <summary>{t('Расширенное обслуживание и серверная консоль')}</summary>
          <p>
            {t(
              'Консоль оператора сервера остаётся доступна через ваш терминал/SSH. Первичная установка, миграции перед запуском и аварийное восстановление доступа выполняются там; обычные действия доступны выше.',
            )}
          </p>
          <p>
            {t('Версия структуры базы: ')}
            {v.schemaVersion}
            {t('. Истёкших сырых записей: ')}
            {c.expiredAudio}.
          </p>
          <p>
            {t(
              'Команды сохранены в инструкции репозитория. Произвольный запуск команд из веб-страницы не предоставляется.',
            )}
          </p>
        </details>
      )}
    </>
  );
}
