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
  recover_learning: 'Восстановить обработку учебных событий',
  retry_video: 'Повторить готовые команды видеосервера',
  seed_content: 'Загрузить демонстрационные материалы',
  expire_audio: 'Очистить истёкшие аудиозаписи',
};
const descriptions: Record<MaintenanceKind, string> = {
  recover_learning:
    'Обрабатывает до 50 готовых прохождений за одно действие. Незавершённые закрытые проверки ожидают ученика. Повторы не создают вторые оценки или назначения.',
  retry_video:
    'Доставляет уже сохранённые команды модерации. При недоступности сервера очередь остаётся для следующей попытки.',
  seed_content:
    'Загружает готовый банк РКИ и английского без дубликатов. Пользователи, ответы и действующие версии материалов сохраняются.',
  expire_audio:
    'Удаляет только сырые записи с истёкшим сроком хранения. Текст, результаты и аудио обратной связи сохраняются.',
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
  if (state.status === 'loading') return <LoadingState text="Проверяем состояние платформы…" />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const v = state.data,
    c = v.counts;
  return (
    <>
      <p className="eyebrow">Состояние платформы и повседневные действия</p>
      <h1>{root ? 'Обслуживание платформы' : 'Кабинет администратора'}</h1>
      <div className="section-heading">
        <p role="status">
          База готова · Обновлено {new Date(v.refreshedAt).toLocaleString('ru-RU')}
        </p>
        <button className="secondary" onClick={refresh}>
          Обновить сводку
        </button>
      </div>
      <section className="panel">
        <h2>Рабочие разделы</h2>
        <div className="button-row">
          <Link className="button-link" to="/schedule">
            Расписание и видеозанятия
          </Link>
          <Link className="button-link" to="/admin/providers">
            AI, озвучивание и расходы →
          </Link>
          <Link to="/courses">Учебные маршруты</Link>
          {root && (
            <>
              <Link to="/admin">Аккаунты и преподаватели</Link>
              <Link to="/admin/content">Импорт и экспорт материалов</Link>
              <Link to="/admin/learning">Прохождения и ответы</Link>
              <Link to="/progress">Учебные отчёты</Link>
              <Link to="/admin?tab=security">Настройки безопасности</Link>
              <Link to="/admin?tab=audit">Журнал действий</Link>
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <h2>Фактическое состояние</h2>
        <dl className="dashboard-stats" data-testid="operations-counts">
          <div>
            <dt>Ученики</dt>
            <dd>{c.students}</dd>
          </div>
          <div>
            <dt>Преподаватели</dt>
            <dd>{c.teachers}</dd>
          </div>
          <div>
            <dt>Маршруты / уроки</dt>
            <dd>
              {c.routes} / {c.lessons}
            </dd>
          </div>
          <div>
            <dt>Запланировано занятий</dt>
            <dd>{c.scheduledMeetings}</dd>
          </div>
          <div>
            <dt>Идут встречи</dt>
            <dd>{c.liveMeetings}</dd>
          </div>
          <div>
            <dt>Готовые учебные события</dt>
            <dd data-testid="operations-learning-ready">{c.learningReady}</dd>
          </div>
        </dl>
        <p>
          Ожидают завершения учеником: {c.learningDeferred} · Команд видеосервера в очереди:{' '}
          {c.videoPending} · Неудачных распознаваний: {c.speechErrors} · Неопределённых обращений к
          провайдерам: {c.unknownProviderRequests}
        </p>
        <p className="muted">
          Это техническая сводка. Сбой распознавания или провайдера не считается учебной ошибкой.
          Платные обращения автоматически не повторяются; их состояние видно в журнале расходов.
        </p>
      </section>
      <section className="panel">
        <h2>Подключения</h2>
        <ul className="account-list">
          {v.integrations.map((i) => (
            <li key={i.id}>
              <strong>{i.title}</strong>
              <span className="badge">{i.configured ? 'Настроено' : 'Требуется настройка'}</span>
              <p>{i.detail}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Обслуживание без консоли</h2>
        <p>
          Каждое действие сохраняется с автором. Повтор после разрыва соединения получает результат
          той же операции.
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
                ? 'Выполняем…'
                : pending.current?.kind === kind
                  ? 'Повторить получение результата'
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
            {result.result?.message}
            {result.result?.processed !== undefined
              ? ` Обработано: ${result.result.processed}.`
              : ''}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Последние операции</h2>
        {v.recentOperations.length ? (
          <ul className="account-list">
            {v.recentOperations.map((o) => (
              <li key={o.id}>
                <strong>{actionLabels[o.kind]}</strong>
                <p>
                  {o.actorName} · {new Date(o.createdAt).toLocaleString('ru-RU')} ·{' '}
                  {o.status === 'completed'
                    ? 'Завершена'
                    : o.status === 'failed'
                      ? 'Ошибка'
                      : 'Выполняется или прервана'}
                </p>
                <p>{o.result?.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>Операций обслуживания пока не было.</p>
        )}
      </section>
      {root && (
        <details className="panel">
          <summary>Расширенное обслуживание и серверная консоль</summary>
          <p>
            Консоль оператора сервера остаётся доступна через ваш терминал/SSH. Первичная установка,
            миграции перед запуском и аварийное восстановление доступа выполняются там; обычные
            действия доступны выше.
          </p>
          <p>
            Версия структуры базы: {v.schemaVersion}. Истёкших сырых записей: {c.expiredAudio}.
          </p>
          <p>
            Команды сохранены в инструкции репозитория. Произвольный запуск команд из веб-страницы
            не предоставляется.
          </p>
        </details>
      )}
    </>
  );
}
