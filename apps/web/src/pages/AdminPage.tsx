import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  accountDetailSchema,
  auditSchema,
  messageSchema,
  securitySettingsSchema,
  userSchema,
  usersSchema,
  type User,
} from '@luch/contracts';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { LoadingState, ErrorState } from '../components/States';
import { useSecurity } from '../auth/SecurityGate';
import { UserSummary } from './AccountPages';
import { RunList, IntegrityControls } from './EnginePages';
import { ProfileOverview, DiagnosticHistory } from './DiagnosticPages';
import { PlanOverview } from './PlanPages';
import { SkillStates } from './AdaptationViews';
import { AdminCreateAccount, AdminAuthenticator } from './AdminCredentials';

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'accounts';
  return (
    <>
      <p className="eyebrow">Управление платформой</p>
      <h1>Кабинет суперадмина</h1>
      <p>
        <Link to="/admin/content">Учебный контент: импорт и экспорт →</Link>
      </p>
      <p>
        <Link to="/admin/learning">Все прохождения и результаты →</Link>
      </p>
      <div className="tabs" role="tablist" aria-label="Разделы суперадмина">
        {[
          ['accounts', 'Аккаунты пользователей'],
          ['security', 'Настройки безопасности'],
          ['audit', 'Журнал действий'],
        ].map(([value, label]) => (
          <button
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? '' : 'secondary'}
            key={value}
            onClick={() => setParams({ tab: value! })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'security' ? (
        <>
          <SecuritySettings />
          <IntegrityControls />
        </>
      ) : tab === 'audit' ? (
        <AuditLog />
      ) : (
        <Accounts />
      )}
    </>
  );
}
function Accounts() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const { state, refresh } = useResource(
    `/admin/accounts?search=${encodeURIComponent(filter)}`,
    usersSchema,
    true,
  );
  const saved = () => {
    refresh();
    setDetailVersion((value) => value + 1);
  };
  return (
    <>
      <AdminCreateAccount
        created={(user) => {
          setSelected(user.id);
          saved();
        }}
      />
      <form
        className="panel form-row"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter(search);
        }}
      >
        <label htmlFor="account-search">Найти аккаунт</label>
        <input
          id="account-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Имя или почта"
          maxLength={100}
        />
        <button>Найти</button>
      </form>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <>
          <section className="panel">
            <h2>Аккаунты пользователей</h2>
            <ul className="account-list">
              {state.data.map((user) => (
                <li key={user.id}>
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                  <span className="badge">
                    {user.role === 'student'
                      ? 'Ученик'
                      : user.role === 'teacher'
                        ? 'Преподаватель'
                        : 'Суперадмин'}
                    {user.isBlocked ? ' · заблокирован' : ''}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => setSelected(user.id)}
                    aria-label={`Открыть ${user.email}`}
                  >
                    Открыть
                  </button>
                </li>
              ))}
            </ul>
            {!state.data.length && <p>Аккаунты не найдены.</p>}
          </section>
          {selected && (
            <AccountDetail key={selected} id={selected} version={detailVersion} onSaved={saved} />
          )}
          <AssignTeacher users={state.data} onSaved={saved} />
        </>
      )}
    </>
  );
}
function AccountDetail({
  id,
  version,
  onSaved,
}: {
  id: string;
  version: number;
  onSaved: () => void;
}) {
  const { state, refresh } = useResource(
    `/admin/accounts/${id}?refresh=${version}`,
    accountDetailSchema,
  );
  const [blocked, setBlocked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (state.status === 'ready') {
      setBlocked(state.data.user.isBlocked);
      setVerified(state.data.user.accessVerified);
      setError(null);
    }
  }, [state]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/accounts/${id}`, userSchema, {
        body: { isBlocked: blocked, accessVerified: verified },
      });
      setMessage('Доступ аккаунта обновлён.');
      refresh();
      onSaved();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/admin/accounts/${id}/revoke-sessions`, messageSchema, {
        body: {},
      });
      setMessage(result.message);
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>Карточка аккаунта для отладки</h2>
      <UserSummary user={state.data.user} />
      <AdminAuthenticator userId={id} changed={onSaved} />
      <p className="muted">Создан: {new Date(state.data.user.createdAt).toLocaleString('ru-RU')}</p>
      <p>
        Прохождений: {state.data.progress.runs} · Завершено: {state.data.progress.completedRuns} ·
        Попыток: {state.data.progress.attempts} · Верных: {state.data.progress.correctAttempts} · С
        помощью: {state.data.progress.assistedAttempts}
      </p>
      <p>
        <Link to={`/assistant?userId=${id}`}>Персонаж и переписка помощника →</Link>
      </p>
      <RunList userId={id} />
      {state.data.user.role === 'student' && (
        <>
          <ProfileOverview userId={id} />
          <PlanOverview userId={id} />
          <DiagnosticHistory userId={id} />
          <SkillStates userId={id} />
        </>
      )}
      <p>
        Преподаватели: {state.data.teachers.map((user) => user.name).join(', ') || 'не назначены'}
      </p>
      <p>Ученики: {state.data.students.map((user) => user.name).join(', ') || 'не назначены'}</p>
      <form
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={verified}
            onChange={(event) => setVerified(event.target.checked)}
          />
          Проверка доступа подтверждена
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={blocked}
            onChange={(event) => setBlocked(event.target.checked)}
          />
          Заблокировать аккаунт
        </label>
        <div className="form-actions">
          <button disabled={busy}>Сохранить доступ</button>
          <button
            type="button"
            disabled={busy}
            className="secondary"
            onClick={() => {
              void revoke();
            }}
          >
            Завершить все сессии
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error inline-message">
          {error.message}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      <h3>Последние проверки соединения</h3>
      {state.data.assessments.length ? (
        state.data.assessments.map((assessment) => (
          <details key={assessment.id}>
            <summary>
              {assessment.ip} · {assessment.denied ? 'Доступ ограничен' : 'Проверка завершена'} ·{' '}
              {new Date(assessment.createdAt).toLocaleString('ru-RU')}
            </summary>
            <ul>
              {assessment.observations.map((observation) => (
                <li key={observation.label}>
                  {observation.label}:{' '}
                  {observation.status === 'observed'
                    ? 'есть признак'
                    : observation.status === 'not_observed'
                      ? 'не обнаружен'
                      : 'нет измерения'}
                </li>
              ))}
            </ul>
          </details>
        ))
      ) : (
        <p className="muted">Проверки не записаны.</p>
      )}
    </section>
  );
}
function AssignTeacher({ users, onSaved }: { users: User[]; onSaved: () => void }) {
  const [teacherId, setTeacherId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  async function assign(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api('/admin/teacher-students', messageSchema, {
        body: { teacherId, studentId },
      });
      setMessage(result.message);
      onSaved();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Закрепить ученика</h2>
      <form
        onSubmit={(event) => {
          void assign(event);
        }}
      >
        <label htmlFor="assign-teacher">Преподаватель</label>
        <select
          id="assign-teacher"
          value={teacherId}
          onChange={(event) => setTeacherId(event.target.value)}
          required
        >
          <option value="">Выберите преподавателя</option>
          {users
            .filter((user) => user.role === 'teacher')
            .map((user) => (
              <option value={user.id} key={user.id}>
                {user.name} · {user.email}
              </option>
            ))}
        </select>
        <label htmlFor="assign-student">Ученик</label>
        <select
          id="assign-student"
          value={studentId}
          onChange={(event) => setStudentId(event.target.value)}
          required
        >
          <option value="">Выберите ученика</option>
          {users
            .filter((user) => user.role === 'student')
            .map((user) => (
              <option value={user.id} key={user.id}>
                {user.name} · {user.email}
              </option>
            ))}
        </select>
        <button disabled={busy}>Назначить преподавателя</button>
      </form>
      {error && (
        <p role="alert" className="error inline-message">
          {error.message}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
    </section>
  );
}
function SecuritySettings() {
  const { state, refresh } = useResource('/admin/security', securitySettingsSchema);
  const { recheck } = useSecurity();
  const [captcha, setCaptcha] = useState(true);
  const [vpn, setVpn] = useState(false);
  const [ranges, setRanges] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (state.status === 'ready') {
      setCaptcha(state.data.captchaEnabled);
      setVpn(state.data.vpnCheckEnabled);
      setRanges(state.data.ipAllowlist.join('\n'));
      setHours(state.data.sessionHours);
    }
  }, [state]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await api('/admin/security', securitySettingsSchema, {
        body: {
          captchaEnabled: captcha,
          vpnCheckEnabled: vpn,
          ipAllowlist: ranges.split(/[\s,]+/).filter(Boolean),
          sessionHours: hours,
          revision: state.data.revision,
        },
      });
      recheck();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>Настройки безопасности</h2>
      <form
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={captcha}
            onChange={(event) => setCaptcha(event.target.checked)}
          />
          Капча на страницах авторизации
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={vpn} onChange={(event) => setVpn(event.target.checked)} />
          Проверка доступа пользователей с VPN
        </label>
        <p className="muted">
          При включённой проверке нужен подтверждённый доступ аккаунта и IP из белого списка. При
          срабатывании проверки сервис недоступен.
        </p>
        <label htmlFor="allowed-ips">Белый список IP и сетей</label>
        <textarea
          id="allowed-ips"
          value={ranges}
          onChange={(event) => setRanges(event.target.value)}
          rows={5}
          placeholder="По одному адресу или сети на строку"
        />
        <p>
          Текущий IP: <code>{state.data.currentIp}</code>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setRanges((value) =>
                [...new Set([...value.split(/[\s,]+/).filter(Boolean), state.data.currentIp])].join(
                  '\n',
                ),
              )
            }
          >
            Добавить текущий IP
          </button>
        </p>
        <label htmlFor="session-hours">Срок сессии, часы</label>
        <input
          id="session-hours"
          type="number"
          min={1}
          max={168}
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
        />
        {error && (
          <p role="alert" className="error inline-message">
            {error.message}
          </p>
        )}
        <button disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить настройки'}</button>
      </form>
    </section>
  );
}
function AuditLog() {
  const { state, refresh } = useResource('/admin/audit', auditSchema);
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>Последние действия</h2>
      <ul className="account-list">
        {state.data.map((item) => (
          <li key={item.id}>
            <strong>{item.action}</strong>
            <span>{item.actorEmail ?? 'Системная операция'}</span>
            <span>{item.targetEmail ?? ''}</span>
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString('ru-RU')}
            </time>
          </li>
        ))}
      </ul>
      <button className="secondary" onClick={refresh}>
        Обновить журнал
      </button>
    </section>
  );
}
