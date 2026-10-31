import { useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  browserAccessLinkSchema,
  browserAccessLinksSchema,
  browserAccessDevicesSchema,
  browserNames,
  type BrowserAccessLink,
  type BrowserAccessDevice,
} from '@luch/contracts';
import { t, dateLocale } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useResource } from '../lib/useResource';
import { ErrorState, LoadingState } from '../components/States';

const root = '/admin/browser-access-links';
const ok = z.object({ ok: z.literal(true) });
type Cursor = { createdAt: string; id: string } | null;
const pageQuery = (cursor: NonNullable<Cursor>) =>
  '?' + new URLSearchParams({ beforeCreatedAt: cursor.createdAt, beforeId: cursor.id });
const when = (date: string) => new Date(date).toLocaleString(dateLocale);
const status = (s: BrowserAccessLink['status']) =>
  ({
    active: t('Ссылка действует'),
    used: t('Одноразовая ссылка использована'),
    expired: t('Срок ссылки истёк'),
    revoked: t('Ссылка отозвана'),
  })[s];
export function BrowserManualAccessSettings() {
  const { state, refresh } = useResource(root, browserAccessLinksSchema);
  const [label, setLabel] = useState(''),
    [singleUse, setSingleUse] = useState(true),
    [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [created, setCreated] = useState<BrowserAccessLink | null>(null),
    [extra, setExtra] = useState<BrowserAccessLink[]>([]),
    [cursor, setCursor] = useState<Cursor | undefined>();
  const [selected, setSelected] = useState<string | null>(null),
    [confirm, setConfirm] = useState<string | null>(null),
    [epoch, setEpoch] = useState(0);
  const pending = useRef<{
    operationId: string;
    label: string;
    singleUse: boolean;
    expiresAt: string | null;
  } | null>(null);
  const items = state.status === 'ready' ? [...state.data.items, ...extra] : [];
  const next =
    cursor === undefined ? (state.status === 'ready' ? state.data.nextCursor : null) : cursor;
  function reload() {
    setExtra([]);
    setCursor(undefined);
    setEpoch((v) => v + 1);
    refresh();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      pending.current ??= {
        operationId: crypto.randomUUID(),
        label,
        singleUse,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      };
      const value = await api(root, browserAccessLinkSchema, { body: pending.current });
      pending.current = null;
      setCreated(value);
      setSelected(value.id);
      setLabel('');
      setExpires('');
      setNotice(t('Ссылка ручного допуска создана.'));
      reload();
    } catch (e) {
      setError(t((e as Error).message));
      if (e instanceof ApiError && e.status && e.status < 500) pending.current = null;
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!next) return;
    setBusy(true);
    setError('');
    try {
      const page = await api(root + pageQuery(next), browserAccessLinksSchema);
      setExtra((v) => [...v, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(t((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`${root}/${id}/revoke`, ok, { body: {} });
      setConfirm(null);
      setNotice(t('Ссылка и её допуски отозваны.'));
      reload();
    } catch (e) {
      setError(t((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      if (!navigator.clipboard) throw new Error();
      await navigator.clipboard.writeText(value);
      setNotice(t('Ссылка скопирована.'));
    } catch {
      setError(t('Выделите ссылку и скопируйте её вручную.'));
    }
  }
  return (
    <section className="panel browser-manual-access" aria-label={t('Разрешить вход вручную')}>
      <h2>{t('Разрешить вход вручную')}</h2>
      <p>
        {t(
          'Суперадмин создаёт ссылку для обхода обеих проверок браузера. Получатель подтверждает допуск кнопкой; открытие ссылки само по себе его не расходует.',
        )}
      </p>
      <p className="muted">
        {t(
          'Одна запись — один браузер или профиль, а не физическое устройство. Допуск действует до 365 дней; удаление cookie требует нового допуска. Авторизация, 2FA и остальные правила сохраняются.',
        )}
      </p>
      <form onSubmit={(e) => void create(e)}>
        <fieldset disabled={busy || Boolean(pending.current)} className="form-grid">
          <label>
            {t('Название ссылки')}
            <input
              required
              maxLength={120}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label>
            {t('Тип ссылки')}
            <select
              aria-label={t('Тип ссылки')}
              value={singleUse ? 'single' : 'multiple'}
              onChange={(e) => setSingleUse(e.target.value === 'single')}
            >
              <option value="single">{t('Одноразовая')}</option>
              <option value="multiple">{t('Многоразовая')}</option>
            </select>
          </label>
          <label>
            {t('Срок ссылки (необязательно)')}
            <input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </label>
        </fieldset>
        <p className="muted">
          {t(
            'Срок ссылки ограничивает новые допуски. Отзыв ссылки закрывает и все ранее выданные по ней допуски.',
          )}
        </p>
        <button disabled={busy}>
          {busy
            ? t('Сохраняем…')
            : pending.current
              ? t('Повторить создание ссылки')
              : t('Создать ссылку ручного допуска')}
        </button>
      </form>
      {created && (
        <div className="browser-access-created">
          <label>
            {t('Созданная ссылка')}
            <input readOnly value={created.url} onFocus={(e) => e.target.select()} />
          </label>
          <button className="secondary" onClick={() => void copy(created.url)}>
            {t('Скопировать ссылку')}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="button-row">
        <h3>{t('Выданные ссылки')}</h3>
        <button className="secondary" disabled={busy} onClick={reload}>
          {t('Обновить ручные допуски')}
        </button>
      </div>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={reload} />
      ) : (
        <>
          {!items.length && <p>{t('Ссылки ручного допуска ещё не создавались.')}</p>}
          <div className="browser-access-list">
            {items.map((l) => (
              <article
                className="browser-access-card"
                key={l.id}
                data-testid="browser-access-link"
                data-id={l.id}
              >
                <h3>{l.label}</h3>
                <p>
                  {l.singleUse ? t('Одноразовая') : t('Многоразовая')} · {status(l.status)}
                </p>
                <p>
                  {t('Создал: {0} ({1})', [l.creator.name, l.creator.email])}
                  <br />
                  {t('Создана: {0}', [when(l.createdAt)])}
                  <br />
                  {l.expiresAt
                    ? t('Новые допуски до: {0}', [when(l.expiresAt)])
                    : t('Срок ссылки не ограничен')}
                </p>
                {l.revokedBy && <p>{t('Отозвал: {0}', [l.revokedBy.email])}</p>}
                <details>
                  <summary>{t('Показать ссылку')}</summary>
                  <input
                    aria-label={t('Ссылка: {0}', [l.label])}
                    value={l.url}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                </details>
                <div className="button-row">
                  <button
                    className="secondary"
                    aria-expanded={selected === l.id}
                    onClick={() => setSelected(selected === l.id ? null : l.id)}
                  >
                    {t('Запомнено: {0} · Активно: {1}', [l.totalDevices, l.activeDevices])}
                  </button>
                  <button
                    className="secondary danger"
                    disabled={busy || l.status === 'revoked'}
                    onClick={() => setConfirm(l.id)}
                  >
                    {t('Отозвать ссылку')}
                  </button>
                </div>
                {confirm === l.id && (
                  <div className="inline-message">
                    <p>{t('Все допуски этой ссылки перестанут обходить проверку браузера.')}</p>
                    <div className="button-row">
                      <button className="danger" disabled={busy} onClick={() => void revoke(l.id)}>
                        {t('Подтвердить отзыв ссылки')}
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirm(null)}
                      >
                        {t('Отмена')}
                      </button>
                    </div>
                  </div>
                )}
                {selected === l.id && (
                  <BrowserDevices key={`${l.id}:${epoch}`} linkId={l.id} changed={reload} />
                )}
              </article>
            ))}
          </div>
          {next && (
            <button className="secondary" disabled={busy} onClick={() => void more()}>
              {t('Показать ещё ссылки')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
function BrowserDevices({ linkId, changed }: { linkId: string; changed: () => void }) {
  const path = `${root}/${linkId}/devices`,
    { state, refresh } = useResource(path, browserAccessDevicesSchema);
  const [extra, setExtra] = useState<BrowserAccessDevice[]>([]),
    [cursor, setCursor] = useState<Cursor | undefined>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const next =
    cursor === undefined ? (state.status === 'ready' ? state.data.nextCursor : null) : cursor;
  async function more() {
    if (!next) return;
    setBusy(true);
    setError('');
    try {
      const page = await api(path + pageQuery(next), browserAccessDevicesSchema);
      setExtra((v) => [...v, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(t((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${path}/${id}/revoke`, ok, { body: {} });
      changed();
    } catch (e) {
      setError(t((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const items = [...state.data.items, ...extra];
  return (
    <section className="browser-access-devices" aria-label={t('Запомненные браузеры')}>
      <h4>{t('Запомненные браузеры')}</h4>
      <p className="muted">
        {t(
          'Названия браузера и ОС — переданные клиентом сведения. После отзыва отдельного допуска обладатель действующей многоразовой ссылки может получить новый; для закрытия всех допусков отзовите ссылку.',
        )}
      </p>
      {!items.length && <p>{t('По этой ссылке ещё не запомнено ни одного браузера.')}</p>}
      {items.map((d) => (
        <article key={d.id} className="browser-access-device" data-testid="browser-access-device">
          <h4>{d.label}</h4>
          <p>
            {browserNames[d.browser]} · {d.platform} ·{' '}
            {d.active ? t('Допуск действует') : t('Допуск не действует')}
          </p>
          <dl>
            <dt>{t('Первое использование')}</dt>
            <dd>{when(d.createdAt)}</dd>
            <dt>{t('Последнее обращение')}</dt>
            <dd>{when(d.lastSeenAt)}</dd>
            <dt>{t('Допуск до')}</dt>
            <dd>{when(d.expiresAt)}</dd>
            <dt>{t('IP: первый / последний')}</dt>
            <dd>
              {d.firstIp} / {d.lastIp}
            </dd>
            <dt>{t('Последний вошедший аккаунт')}</dt>
            <dd>
              {d.lastUser ? `${d.lastUser.name} (${d.lastUser.email})` : t('Без входа в аккаунт')}
            </dd>
          </dl>
          <details>
            <summary>{t('Сведения браузера')}</summary>
            <p>{d.userAgent || t('Неизвестный браузер')}</p>
          </details>
          {d.revokedBy && <p>{t('Отозвал: {0}', [d.revokedBy.email])}</p>}
          <button
            className="secondary danger"
            disabled={busy || !d.active}
            onClick={() => void revoke(d.id)}
          >
            {t('Отозвать допуск: {0}', [d.label])}
          </button>
        </article>
      ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {next && (
        <button className="secondary" disabled={busy} onClick={() => void more()}>
          {t('Показать ещё браузеры')}
        </button>
      )}
    </section>
  );
}
