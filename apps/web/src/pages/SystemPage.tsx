import { t, dateLocale } from '../i18n';
import { useRef, useState, type FormEvent } from 'react';
import {
  createProbeSchema,
  healthSchema,
  probeSchema,
  probesSchema,
  type CreateProbe,
} from '@luch/contracts';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, EmptyState, ErrorState, StatusState } from '../components/States';

export function SystemPage({ enabled }: { enabled: boolean }) {
  if (!enabled) return <StatusState status={404} />;
  return <SystemCheck />;
}
function SystemCheck() {
  const health = useResource('/health/ready', healthSchema);
  const records = useResource('/dev/records', probesSchema);
  const [label, setLabel] = useState(t('Проверка сохранения'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [success, setSuccess] = useState('');
  const pending = useRef<CreateProbe | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = createProbeSchema.safeParse(
      pending.current ?? { label, operationId: crypto.randomUUID() },
    );
    if (!input.success) {
      setError(new Error(input.error.issues[0]?.message ?? t('Проверьте данные.')));
      return;
    }
    pending.current = input.data;
    setSaving(true);
    setError(null);
    setSuccess('');
    try {
      const saved = await api('/dev/records', probeSchema, { body: input.data });
      setSuccess(t('Запись «{0}» сохранена в базе.', [saved.label]));
      pending.current = null;
      records.refresh();
      health.refresh();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <p className="eyebrow">{t('Для разработки и проверки')}</p>
      <h1>{t('Проверка системы')}</h1>
      <p className="lead">
        {t('Создайте тестовую запись, затем обновите страницу. Запись должна остаться в списке.')}
      </p>
      <section className="panel" aria-label={t('Состояние базы')}>
        <h2>{t('Соединение с базой')}</h2>
        {health.state.status === 'loading' && <LoadingState text={t('Проверяем соединение…')} />}
        {health.state.status === 'error' && (
          <ErrorState error={health.state.error} retry={health.refresh} />
        )}
        {health.state.status === 'ready' && (
          <p className="success" role="status">
            {t('Сервер и база данных готовы.')}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>{t('Тестовая запись')}</h2>
        <form
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <label htmlFor="probe-label">{t('Текст записи')}</label>
          <div className="form-row">
            <input
              id="probe-label"
              value={label}
              maxLength={120}
              required
              disabled={saving}
              onChange={(event) => {
                setLabel(event.target.value);
                pending.current = null;
                setSuccess('');
                setError(null);
              }}
            />
            <button type="submit" disabled={saving}>
              {saving ? t('Сохраняем…') : t('Сохранить в базу')}
            </button>
          </div>
          <p className="muted">{t('До 120 символов. Используйте только тестовые данные.')}</p>
        </form>
        {saving && <LoadingState text={t('Сохраняем запись…')} />}
        {error && (
          <div className="error inline-message" role="alert">
            {t(error.message)} {t(' Повторите сохранение.')}
          </div>
        )}
        {success && (
          <p className="success" role="status">
            {success}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>{t('Последние записи')}</h2>
          <button
            className="secondary"
            onClick={records.refresh}
            disabled={records.state.status === 'loading'}
          >
            {t('Обновить список')}
          </button>
        </div>
        {records.state.status === 'loading' && <LoadingState />}
        {records.state.status === 'error' && (
          <ErrorState error={records.state.error} retry={records.refresh} />
        )}
        {records.state.status === 'ready' &&
          (records.state.data.length === 0 ? (
            <EmptyState
              title={t('Записей пока нет')}
              description={t('Сохраните первую тестовую запись с помощью формы выше.')}
            />
          ) : (
            <ul className="record-list">
              {records.state.data.map((record) => (
                <li key={record.id}>
                  <strong>{record.label}</strong>
                  <time dateTime={record.createdAt}>
                    {new Date(record.createdAt).toLocaleString(dateLocale)}
                  </time>
                  <code>{record.id}</code>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </>
  );
}
