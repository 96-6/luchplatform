import { useCallback, useEffect, useRef, useState } from 'react';
import {
  updateOverviewSchema,
  updateJobSchema,
  updateProgressSchema,
  type UpdateJob,
  type UpdateOverview,
} from '@luch/contracts';
import { api, ApiError } from '../lib/api';
import { t, dateLocale } from '../i18n';
import { LoadingState } from '../components/States';

const terminal = (job: UpdateJob) => ['completed', 'failed', 'rollback_failed'].includes(job.phase);
const time = (value: string | null) => (value ? new Date(value).toLocaleString(dateLocale) : '—');
export const phaseText = (phase: UpdateJob['phase']) =>
  ({
    queued: t('В очереди'),
    fetching: t('Получение исходников'),
    installing: t('Установка зависимостей'),
    building: t('Сборка приложения'),
    waiting_for_meetings: t('Ожидание завершения встреч'),
    stopping: t('Остановка сервера'),
    backing_up: t('Резервное копирование'),
    migrating: t('Обновление базы'),
    starting: t('Запуск сервера'),
    verifying: t('Проверка готовности'),
    rolling_back: t('Восстановление прежней версии'),
    completed: t('Обновление завершено'),
    failed: t('Обновление не выполнено'),
    rollback_failed: t('Требуется восстановление оператором'),
  })[phase];
export function usePlatformUpdates() {
  const [data, setData] = useState<UpdateOverview | null>(null),
    [job, setJob] = useState<UpdateJob | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [maintenance, setMaintenance] = useState(false);
  const currentJob = useRef<UpdateJob | null>(null),
    pending = useRef(false),
    operation = useRef<{ operationId: string; targetCommit: string } | null>(null);
  const accept = useCallback((view: UpdateOverview) => {
    setData(view);
    if (view.latestJob) {
      currentJob.current = view.latestJob;
      setJob(view.latestJob);
    }
    setError('');
    setMaintenance(false);
  }, []);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      accept(await api('/admin/updates', updateOverviewSchema));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
    }
  }, [accept]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 60000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    let stopped = false,
      running = false;
    const poll = async () => {
      const active = currentJob.current;
      if (!active || terminal(active) || running) return;
      running = true;
      try {
        const progress = await api(
          `/admin/updates/progress?jobId=${active.id}`,
          updateProgressSchema,
        );
        if (stopped) return;
        currentJob.current = progress.job;
        setJob(progress.job);
        setMaintenance(progress.transport === 'maintenance');
        setError('');
        if (terminal(progress.job)) {
          operation.current = null;
          void refresh();
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [refresh]);
  async function check() {
    setBusy(true);
    try {
      accept(
        await api('/admin/updates/check', updateOverviewSchema, { body: {}, timeoutMs: 30000 }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!data?.latest) return;
    setBusy(true);
    try {
      operation.current ??= { operationId: crypto.randomUUID(), targetCommit: data.latest.commit };
      const started = await api('/admin/updates/apply', updateJobSchema, {
        body: operation.current,
        timeoutMs: 30000,
      });
      currentJob.current = started;
      setJob(started);
      setError('');
      void refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status && e.status < 500) operation.current = null;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { data, job, error, busy, maintenance, check, apply, refresh };
}
export function UpdatesPanel({ updates }: { updates: ReturnType<typeof usePlatformUpdates> }) {
  const { data, job, error, busy, maintenance } = updates;
  const [confirm, setConfirm] = useState(false),
    [clock, setClock] = useState(Date.now());
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [job?.logs.length, job?.logs.at(-1)?.sequence]);
  const active = job && !terminal(job),
    stale = active && clock - Date.parse(job.heartbeatAt) > 20000;
  return (
    <section className="panel updates-panel" aria-label={t('Обновления платформы')}>
      <h2>{t('Обновления')}</h2>
      <p>{t('Официальная ветка GitHub: main. Автоматическая проверка каждые 6 часов.')}</p>
      {error && (
        <p className="error inline-message" role="alert">
          {t(error)}{' '}
          <button
            className="secondary"
            onClick={() => {
              void updates.refresh();
            }}
          >
            {t('Повторить')}
          </button>
        </p>
      )}
      {!data && !error && <LoadingState />}
      {data && (
        <>
          <p className={data.updateAvailable ? 'update-available' : 'success'} role="status">
            {
              {
                unknown: t('Версия ещё не проверена'),
                current: t('Установлена актуальная сборка'),
                outdated: t('Доступно обновление'),
                different: t('Установленная сборка отличается от main'),
                ahead: t('Установленная сборка новее main'),
              }[data.status]
            }
          </p>
          <dl className="system-facts">
            <dt>{t('Установленная версия')}</dt>
            <dd>
              {data.current.version} ·{' '}
              <code>{data.current.commit?.slice(0, 12) ?? t('Архив исходников')}</code>
            </dd>
            <dt>{t('Дата сборки')}</dt>
            <dd>{time(data.current.builtAt)}</dd>
            <dt>{t('Последняя сборка GitHub')}</dt>
            <dd>
              {data.latest ? (
                <a
                  href={`https://github.com/96-6/luchplatform/commit/${data.latest.commit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {data.latest.commit.slice(0, 12)}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt>{t('Последняя проверка')}</dt>
            <dd>{time(data.checkedAt)}</dd>
            <dt>{t('Следующая проверка')}</dt>
            <dd>{time(data.nextCheckAt)}</dd>
          </dl>
          {data.lastError && (
            <p role="alert" className="error">
              {t(data.lastError)}
            </p>
          )}
          <div className="form-row">
            <button
              className="secondary"
              disabled={busy || data.checking || Boolean(active)}
              onClick={() => {
                void updates.check();
              }}
            >
              {busy || data.checking ? t('Проверяем…') : t('Проверить обновления')}
            </button>
            <button
              disabled={busy || !data.canUpdate || Boolean(active)}
              onClick={() => setConfirm(true)}
            >
              {t('Обновить систему')}
            </button>
          </div>
          {!data.agent.available && (
            <p className="muted">
              {t(
                'Агент обновления недоступен. Для Node.js один раз запустите npm run start:managed вместо обычного сервера; в Docker Compose агент подключается автоматически. На хостинге нужна поддержка постоянных процессов.',
              )}
            </p>
          )}
          {(data.current.kind === 'development' || data.current.modified) && (
            <p className="muted">
              {t(
                'Для обновления через интерфейс нужна собранная версия без локальных изменений. Сохраните изменения и запустите управляемый сервер.',
              )}
            </p>
          )}
          {confirm && !active && (
            <div className="inline-message">
              <p>
                {t(
                  'Установить выбранную сборку main? Перед переключением будет создана резервная копия базы. Активные встречи будут дожидаться завершения. Страница покажет ход обновления и перезапуск сервера.',
                )}
              </p>
              <div className="form-row">
                <button
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    void updates.apply();
                  }}
                >
                  {t('Начать обновление')}
                </button>
                <button className="secondary" onClick={() => setConfirm(false)}>
                  {t('Отмена')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {job && (
        <section aria-label={t('Ход обновления')}>
          <h3>{phaseText(job.phase)}</h3>
          <p>{t('Запустил: {0}. Сборка: {1}.', [job.actorName, job.targetCommit.slice(0, 12)])}</p>
          {active && (
            <p className={stale ? 'error' : 'muted'} role="status">
              {stale
                ? t('Агент давно не отвечал. Журнал сохранён; ожидаем восстановления связи.')
                : t('Процесс работает. Последний сигнал: {0}.', [time(job.heartbeatAt)])}
            </p>
          )}
          {maintenance && active && (
            <p>
              {t(
                'Сервер перезапускается. Эта страница остаётся открытой; связь восстановится автоматически.',
              )}
            </p>
          )}
          {job.error && (
            <p className="error" role="alert">
              {t(job.error)}
            </p>
          )}
          {job.restored && <p>{t('Прежняя версия и база восстановлены.')}</p>}
          <pre ref={log} className="update-log" tabIndex={0} aria-label={t('Журнал обновления')}>
            {job.logs.length
              ? job.logs
                  .map(
                    (line) => `[${new Date(line.at).toLocaleTimeString(dateLocale)}] ${line.text}`,
                  )
                  .join('\n')
              : t('Ожидаем первого сообщения агента…')}
          </pre>
          {job.phase === 'completed' && (
            <button className="secondary" onClick={() => window.location.reload()}>
              {t('Обновить интерфейс')}
            </button>
          )}
        </section>
      )}
      {data && data.history.length > 0 && (
        <details>
          <summary>{t('История обновлений')}</summary>
          <ul className="record-list">
            {data.history.map((item) => (
              <li key={item.id}>
                <strong>{phaseText(item.phase)}</strong>
                <span>
                  {item.actorName} · {item.targetCommit.slice(0, 12)}
                </span>
                <time>{time(item.createdAt)}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
