import { t, dateLocale } from '../../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  adhocResultSchema,
  meetingInviteSchema,
  meetingInvitePreviewSchema,
  redeemMeetingInviteResultSchema,
  meetingFilePolicySchema,
  type Meeting,
} from '@luch/contracts';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';
import { useAuth } from '../../auth/AuthContext';
import { browserZone, dateParts, zonedDate } from './shared';

export function AdhocMeetingEditor({ zone, close }: { zone: string; close: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(t('Внеплановая встреча')),
    [language, setLanguage] = useState<'ru' | 'en'>('ru'),
    [planned, setPlanned] = useState(false),
    [starts, setStarts] = useState(dateParts(new Date(), zone));
  const [unlimited, setUnlimited] = useState(false),
    [duration, setDuration] = useState(60),
    [reusable, setReusable] = useState(true),
    [guests, setGuests] = useState(false),
    [limitedLink, setLimitedLink] = useState(false),
    [expires, setExpires] = useState(dateParts(new Date(Date.now() + 86400000), zone)),
    [lobby, setLobby] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const pending = useRef<{ request: string; id: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = {
        title,
        language,
        timeZone: zone,
        durationMinutes: unlimited ? null : duration,
        reusable,
        allowGuests: guests,
        expiresAt: limitedLink ? zonedDate(expires, zone) : null,
        lobbyEnabled: lobby,
        ...(planned ? { startsAt: zonedDate(starts, zone) } : {}),
      };
      const request = JSON.stringify(input);
      if (pending.current?.request !== request)
        pending.current = { request, id: crypto.randomUUID() };
      const result = await api('/meetings/adhoc', adhocResultSchema, {
        body: { ...input, operationId: pending.current.id },
      });
      navigate(`/meetings/${result.meeting.id}`);
    } catch (f) {
      setError(f as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t('Создать внеплановую встречу')}</h2>
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <label htmlFor="adhoc-title">{t('Название встречи')}</label>
          <input
            id="adhoc-title"
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <label htmlFor="adhoc-language">{t('Язык встречи')}</label>
          <select
            id="adhoc-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as 'ru' | 'en')}
          >
            <option value="ru">{t('Русский')}</option>
            <option value="en">English</option>
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={planned}
              onChange={(e) => setPlanned(e.target.checked)}
            />
            {t('Назначить время')}
          </label>
          {planned && (
            <>
              <label htmlFor="adhoc-start">{t('Начало встречи')}</label>
              <input
                id="adhoc-start"
                type="datetime-local"
                required
                value={starts}
                onChange={(e) => setStarts(e.target.value)}
              />
              <p className="muted">{zone}</p>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => setUnlimited(e.target.checked)}
            />
            {t('Без ограничения длительности')}
          </label>
          {!unlimited && (
            <>
              <label htmlFor="adhoc-duration">{t('Длительность встречи, минуты')}</label>
              <input
                id="adhoc-duration"
                type="number"
                min={1}
                max={10080}
                required
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
              <p className="muted">{t('Отсчёт начинается, когда организатор начинает встречу.')}</p>
            </>
          )}
          <label htmlFor="adhoc-link">{t('Тип приглашения')}</label>
          <select
            id="adhoc-link"
            value={reusable ? 'reusable' : 'once'}
            onChange={(e) => setReusable(e.target.value === 'reusable')}
          >
            <option value="reusable">{t('Многоразовая ссылка')}</option>
            <option value="once">{t('Одноразовая ссылка')}</option>
          </select>
          <p className="muted">
            {reusable
              ? t(
                  'Ссылка подходит для нескольких участников. После завершения можно начать по ней новую встречу.',
                )
              : t(
                  'Приглашение закрепляется за первым участником. Он сможет вернуться после перезагрузки.',
                )}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={limitedLink}
              onChange={(e) => setLimitedLink(e.target.checked)}
            />
            {t('Ограничить срок действия ссылки')}
          </label>
          {limitedLink && (
            <>
              <label htmlFor="adhoc-expires">{t('Ссылка действует до')}</label>
              <input
                id="adhoc-expires"
                type="datetime-local"
                required
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />
            {t('Разрешить гостей без регистрации')}
          </label>
          <label className="check">
            <input type="checkbox" checked={lobby} onChange={(e) => setLobby(e.target.checked)} />
            {t('Зал ожидания')}
          </label>
          <div className="form-actions">
            <button>{busy ? t('Создаём…') : t('Создать встречу')}</button>
            <button type="button" className="secondary" onClick={close}>
              {t('Отмена')}
            </button>
          </div>
        </fieldset>
      </form>
      {error && <ErrorState error={error} retry={() => setError(null)} />}
    </section>
  );
}
export function MeetingInvitePanel({ meeting }: { meeting: Meeting }) {
  const navigate = useNavigate(),
    { state, refresh } = useResource(`/meetings/${meeting.id}/invite`, meetingInviteSchema, true);
  const [guests, setGuests] = useState(false),
    [revoked, setRevoked] = useState(false),
    [limited, setLimited] = useState(false),
    [expires, setExpires] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState('');
  const pending = useRef<{ key: string; operationId: string } | null>(null);
  useEffect(() => {
    if (state.status === 'ready') {
      setGuests(state.data.allowGuests);
      setRevoked(state.data.revoked);
      setLimited(Boolean(state.data.expiresAt));
      setExpires(
        state.data.expiresAt
          ? dateParts(new Date(state.data.expiresAt), meeting.timeZone)
          : dateParts(new Date(Date.now() + 86400000), meeting.timeZone),
      );
    }
  }, [state, meeting.timeZone]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      const input = {
          revision: state.data.revision,
          allowGuests: guests,
          revoked,
          expiresAt: limited ? zonedDate(expires, meeting.timeZone) : null,
        },
        key = JSON.stringify(input);
      if (pending.current?.key !== key) pending.current = { key, operationId: crypto.randomUUID() };
      await api(`/meetings/${meeting.id}/invite`, meetingInviteSchema, {
        body: { ...input, operationId: pending.current.operationId },
      });
      pending.current = null;
      setMessage(t('Приглашение обновлено.'));
      refresh();
    } catch (f) {
      setError(f as Error);
    } finally {
      setBusy(false);
    }
  }
  async function restart() {
    setBusy(true);
    setError(null);
    try {
      if (pending.current?.key !== 'restart')
        pending.current = { key: 'restart', operationId: crypto.randomUUID() };
      const result = await api(`/meetings/${meeting.id}/invite/restart`, adhocResultSchema, {
        body: { operationId: pending.current.operationId },
      });
      pending.current = null;
      navigate(`/meetings/${result.meeting.id}`);
    } catch (f) {
      setError(f as Error);
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>{t('Приглашение во встречу')}</h2>
      <label htmlFor="meeting-invite-url">{t('Ссылка для участников')}</label>
      <input id="meeting-invite-url" readOnly value={state.data.url} />
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          void (
            navigator.clipboard
              ? navigator.clipboard.writeText(state.data.url)
              : Promise.reject(new Error('clipboard unavailable'))
          )
            .then(() => setMessage(t('Ссылка скопирована.')))
            .catch(() => setError(new Error(t('Скопируйте ссылку из поля вручную.'))))
        }
      >
        {t('Скопировать ссылку')}
      </button>
      <p>
        {state.data.reusable ? t('Многоразовая ссылка') : t('Одноразовая ссылка')}
        {state.data.used && !state.data.reusable ? ' · ' + t('Приглашение уже использовано') : ''}
      </p>
      {state.data.meetingId !== meeting.id && (
        <Link to={`/meetings/${state.data.meetingId}`}>
          {t('Открыть текущую встречу по ссылке')}
        </Link>
      )}
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy}>
          <label className="check">
            <input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />
            {t('Разрешить гостей без регистрации')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={limited}
              onChange={(e) => setLimited(e.target.checked)}
            />
            {t('Ограничить срок действия ссылки')}
          </label>
          {limited && (
            <>
              <label htmlFor="invite-expires">{t('Ссылка действует до')}</label>
              <input
                id="invite-expires"
                type="datetime-local"
                value={expires}
                required
                onChange={(e) => setExpires(e.target.value)}
              />
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={revoked}
              onChange={(e) => setRevoked(e.target.checked)}
            />
            {t('Отключить приглашение')}
          </label>
          <p className="muted">
            {t(
              'Запрет гостевого доступа отключает гостей от встречи. Срок ссылки ограничивает новые приглашения.',
            )}
          </p>
          <button>{busy ? t('Сохраняем…') : t('Сохранить приглашение')}</button>
        </fieldset>
      </form>
      {state.data.reusable && ['completed', 'cancelled'].includes(meeting.status) && (
        <button className="secondary" disabled={busy} onClick={() => void restart()}>
          {t('Начать новую встречу по этой ссылке')}
        </button>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      {error && <ErrorState error={error} retry={() => setError(null)} />}
    </section>
  );
}
export function MeetingInvitationPage() {
  const [params] = useSearchParams(),
    value = params.get('token') ?? '',
    auth = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const { state, refresh } = useResource(
    `/meeting-invites/preview?token=${encodeURIComponent(value)}`,
    meetingInvitePreviewSchema,
  );
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const operationId = useRef(crypto.randomUUID());
  async function join(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api('/meeting-invites/redeem', redeemMeetingInviteResultSchema, {
        body: {
          operationId: operationId.current,
          token: value,
          ...(!auth.session.user ? { name } : {}),
        },
      });
      navigate(result.path);
    } catch (f) {
      setError(f as Error);
    } finally {
      setBusy(false);
    }
  }
  if (auth.loading || state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const m = state.data,
    closed = ['completed', 'cancelled'].includes(m.status);
  return (
    <section className="auth-card panel">
      <h1>{m.title}</h1>
      <p>{t('Организатор: {0}', [m.organizer])}</p>
      <p>
        {new Date(m.startsAt).toLocaleString(dateLocale)} ·{' '}
        {m.endsAt
          ? new Date(m.endsAt).toLocaleTimeString(dateLocale)
          : t('Без ограничения длительности')}
      </p>
      {closed ? (
        <>
          <p role="status">{t('Встреча завершена. Дождитесь новой встречи от организатора.')}</p>
          <button className="secondary" onClick={refresh}>
            {t('Обновить приглашение')}
          </button>
        </>
      ) : !auth.session.user && !m.allowGuests ? (
        <>
          <p>{t('Организатор разрешил вход только зарегистрированным пользователям.')}</p>
          <Link to="/login" state={{ returnTo: location.pathname + location.search }}>
            {t('Войти в аккаунт')}
          </Link>
        </>
      ) : (
        <form onSubmit={(e) => void join(e)}>
          {!auth.session.user && (
            <>
              <label htmlFor="meeting-guest-name">{t('Ваше имя во встрече')}</label>
              <input
                id="meeting-guest-name"
                required
                minLength={1}
                maxLength={100}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p>{t('Вы войдёте как гость. Регистрация не требуется.')}</p>
            </>
          )}
          <button disabled={busy}>
            {busy ? t('Подключаем…') : t('Присоединиться по приглашению')}
          </button>
        </form>
      )}
      {error && <ErrorState error={error} retry={() => setError(null)} />}
    </section>
  );
}
export function MeetingFileSettings() {
  const { state, refresh } = useResource(
    '/admin/meeting-file-policy',
    meetingFilePolicySchema,
    true,
  );
  const [maximum, setMaximum] = useState(125),
    [threshold, setThreshold] = useState(50),
    [days, setDays] = useState(10),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (state.status === 'ready') {
      setMaximum(state.data.maxFileMb);
      setThreshold(state.data.largeFileMb);
      setDays(state.data.retentionDays);
    }
  }, [state]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/meeting-file-policy', meetingFilePolicySchema, {
        body: {
          maxFileMb: maximum,
          largeFileMb: threshold,
          retentionDays: days,
          revision: state.data.revision,
        },
      });
      setSaved(true);
      refresh();
    } catch (f) {
      setError(f as Error);
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>{t('Файлы в видеовстречах')}</h2>
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy}>
          <label htmlFor="meeting-file-max">{t('Максимальный размер файла, МБ')}</label>
          <input
            id="meeting-file-max"
            type="number"
            min={1}
            max={1024}
            required
            value={maximum}
            onChange={(e) => setMaximum(Number(e.target.value))}
          />
          <label htmlFor="meeting-file-threshold">{t('Удалять файлы размером больше, МБ')}</label>
          <input
            id="meeting-file-threshold"
            type="number"
            min={0}
            max={maximum}
            required
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <label htmlFor="meeting-file-days">{t('Срок хранения больших файлов, дней')}</label>
          <input
            id="meeting-file-days"
            type="number"
            min={1}
            max={3650}
            required
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
          <p className="muted">
            {t(
              'Новые правила применяются к новым файлам. Файлы не больше порога хранятся без автоматического удаления.',
            )}
          </p>
          <button>{busy ? t('Сохраняем…') : t('Сохранить настройки файлов')}</button>
        </fieldset>
      </form>
      {saved && (
        <p role="status" className="success">
          {t('Настройки файлов сохранены.')}
        </p>
      )}
      {error && <ErrorState error={error} retry={refresh} />}
    </section>
  );
}
