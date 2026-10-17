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
  const [label, setLabel] = useState('Проверка сохранения');
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
      setError(new Error(input.error.issues[0]?.message ?? 'Проверьте данные.'));
      return;
    }
    pending.current = input.data;
    setSaving(true);
    setError(null);
    setSuccess('');
    try {
      const saved = await api('/dev/records', probeSchema, { body: input.data });
      setSuccess(`Запись «${saved.label}» сохранена в базе.`);
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
      <p className="eyebrow">Для разработки и проверки</p>
      <h1>Проверка системы</h1>
      <p className="lead">
        Создайте тестовую запись, затем обновите страницу. Запись должна остаться в списке.
      </p>
      <section className="panel" aria-label="Состояние базы">
        <h2>Соединение с базой</h2>
        {health.state.status === 'loading' && <LoadingState text="Проверяем соединение…" />}
        {health.state.status === 'error' && (
          <ErrorState error={health.state.error} retry={health.refresh} />
        )}
        {health.state.status === 'ready' && (
          <p className="success" role="status">
            Сервер и база данных готовы.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Тестовая запись</h2>
        <form
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <label htmlFor="probe-label">Текст записи</label>
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
              {saving ? 'Сохраняем…' : 'Сохранить в базу'}
            </button>
          </div>
          <p className="muted">До 120 символов. Используйте только тестовые данные.</p>
        </form>
        {saving && <LoadingState text="Сохраняем запись…" />}
        {error && (
          <div className="error inline-message" role="alert">
            {error.message} Повторите сохранение.
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
          <h2>Последние записи</h2>
          <button
            className="secondary"
            onClick={records.refresh}
            disabled={records.state.status === 'loading'}
          >
            Обновить список
          </button>
        </div>
        {records.state.status === 'loading' && <LoadingState />}
        {records.state.status === 'error' && (
          <ErrorState error={records.state.error} retry={records.refresh} />
        )}
        {records.state.status === 'ready' &&
          (records.state.data.length === 0 ? (
            <EmptyState
              title="Записей пока нет"
              description="Сохраните первую тестовую запись с помощью формы выше."
            />
          ) : (
            <ul className="record-list">
              {records.state.data.map((record) => (
                <li key={record.id}>
                  <strong>{record.label}</strong>
                  <time dateTime={record.createdAt}>
                    {new Date(record.createdAt).toLocaleString('ru-RU')}
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
