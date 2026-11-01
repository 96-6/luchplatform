import { useEffect, useState, useCallback } from 'react';
import { systemStatusSchema } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
import { t, dateLocale } from '../i18n';
import { LoadingState } from '../components/States';
export function SystemStatusPanel() {
  const [data, setData] = useState<z.infer<typeof systemStatusSchema> | null>(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setData(await api('/admin/system-status', systemStatusSchema));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  return (
    <section className="panel" aria-label={t('Состояние сервера')}>
      <div className="section-heading">
        <h2>{t('Состояние сервера')}</h2>
        <button
          className="secondary"
          onClick={() => {
            void refresh();
          }}
        >
          {t('Обновить состояние')}
        </button>
      </div>
      <p className="muted">
        {t(
          'Показатели запрашиваются у сервера платформы и доступны с любого компьютера с доступом к платформе.',
        )}
      </p>
      {error && (
        <p className="error inline-message" role="alert">
          {t(error)}{' '}
          {t('Актуальное состояние неизвестно. Последние данные могут быть устаревшими.')}
        </p>
      )}
      {!data && !error && <LoadingState />}
      {data && (
        <>
          <dl className={`system-facts${error ? ' stale' : ''}`}>
            <dt>{t('База данных')}</dt>
            <dd className={!error && data.database.available ? 'success' : 'error'}>
              {error
                ? t('Нет свежих данных')
                : data.database.available
                  ? t('Соединение установлено')
                  : t('База недоступна')}{' '}
              · {data.database.driver === 'postgres' ? 'PostgreSQL' : 'PGlite'}
            </dd>
            <dt>{t('Схема базы')}</dt>
            <dd>
              {data.database.schemaVersion ?? '—'} ·{' '}
              {data.database.schemaCurrent ? t('Актуальна') : t('Нужна миграция')}
            </dd>
            <dt>{t('Задержка базы')}</dt>
            <dd>{t('{0} мс', [data.database.latencyMs])}</dd>
            <dt>{t('Время работы сервера')}</dt>
            <dd>{t('{0} мин', [Math.floor(data.uptimeSeconds / 60)])}</dd>
            <dt>{t('Память процесса')}</dt>
            <dd>{t('{0} МБ', [data.memoryMb])}</dd>
            <dt>{t('Версия / сборка')}</dt>
            <dd>
              {data.build.version} · {data.build.commit?.slice(0, 12) ?? '—'}
            </dd>
            <dt>{t('Видеосервер')}</dt>
            <dd>
              {!data.video.configured
                ? t('Не настроен')
                : data.video.available
                  ? t('Доступен')
                  : t('Недоступен')}
            </dd>
            <dt>{t('Почта')}</dt>
            <dd>
              {data.mail === 'smtp'
                ? 'SMTP'
                : data.mail === 'local'
                  ? t('Локальная доставка')
                  : t('Не настроена')}
            </dd>
            <dt>{t('Агент обновления')}</dt>
            <dd>{data.agent.available ? t('Доступен') : t('Недоступен')}</dd>
          </dl>
          <p className="muted">
            {t('Данные обновлены: {0}', [new Date(data.refreshedAt).toLocaleString(dateLocale)])}
          </p>
        </>
      )}
    </section>
  );
}
