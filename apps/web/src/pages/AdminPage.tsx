import { MeetingFileSettings } from './meetings/MeetingExtras';
import { t, dateLocale } from '../i18n';
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
import { AdminCreateAccount, AdminAuthenticator, AdminPassword } from './AdminCredentials';

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'accounts';
  return (
    <>
      <p className="eyebrow">{t('Управление платформой')}</p>
      <h1>{t('Кабинет суперадмина')}</h1>
      <p>
        <Link className="button-link" to="/operations">
          {t('Состояние и обслуживание платформы →')}
        </Link>
      </p>
      <p>
        <Link to="/admin/content">{t('Учебный контент: импорт и экспорт →')}</Link>
      </p>
      <p>
        <Link to="/admin/learning">{t('Все прохождения и результаты →')}</Link>
      </p>
      <div className="tabs" role="tablist" aria-label={t('Разделы суперадмина')}>
        {[
          ['accounts', t('Аккаунты пользователей')],
          ['security', t('Настройки безопасности')],
          ['audit', t('Журнал действий')],
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
          <MeetingFileSettings />
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
        <label htmlFor="account-search">{t('Найти аккаунт')}</label>
        <input
          id="account-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('Имя или почта')}
          maxLength={100}
        />
        <button>{t('Найти')}</button>
      </form>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <>
          <section className="panel">
            <h2>{t('Аккаунты пользователей')}</h2>
            <ul className="account-list">
              {state.data.map((user) => (
                <li key={user.id}>
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                  <span className="badge">
                    {user.role === 'student'
                      ? t('Ученик')
                      : user.role === 'teacher'
                        ? t('Преподаватель')
                        : user.role === 'admin'
                          ? t('Администратор')
                          : t('Суперадмин')}
                    {!user.isActive ? t(' · деактивирован') : ''}
                    {user.isBlocked ? t(' · заблокирован') : ''}
                  </span>
                  <button
                    className="secondary"
                    onClick={() => setSelected(user.id)}
                    aria-label={t('Открыть {0}', [user.email])}
                  >
                    {t('Открыть')}
                  </button>
                </li>
              ))}
            </ul>
            {!state.data.length && <p>{t('Аккаунты не найдены.')}</p>}
          </section>
          {selected && (
            <AccountDetail key={selected} id={selected} version={detailVersion} onSaved={saved} />
          )}
          <AssignTeacher onSaved={saved} version={detailVersion} />
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
    true,
  );
  const [blocked, setBlocked] = useState(false);
  const [active, setActive] = useState(true);
  const [blockReason, setBlockReason] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (state.status === 'ready') {
      setBlocked(state.data.user.isBlocked);
      setActive(state.data.user.isActive);
      setBlockReason(state.data.user.blockReason);
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
        body: { isBlocked: blocked, isActive: active, blockReason, accessVerified: verified },
      });
      setMessage(t('Доступ аккаунта обновлён.'));
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
      setMessage(t(result.message));
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function unassign(teacherId: string, studentId: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api('/admin/teacher-students/remove', messageSchema, {
        body: { teacherId, studentId },
      });
      setMessage(t(result.message));
      refresh();
      onSaved();
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
      <h2>{t('Карточка аккаунта для отладки')}</h2>
      <UserSummary user={state.data.user} />
      <AdminPassword
        key={id}
        userId={id}
        configured={state.data.user.passwordConfigured}
        changed={onSaved}
      />
      <AdminAuthenticator userId={id} changed={onSaved} />
      <p className="muted">
        {t('Создан: ')}
        {new Date(state.data.user.createdAt).toLocaleString(dateLocale)}
      </p>
      <p>
        {t('Прохождений: ')}
        {state.data.progress.runs} {t(' · Завершено: ')}
        {state.data.progress.completedRuns} {t(' · Попыток: ')}
        {state.data.progress.attempts} {t(' · Верных: ')}
        {state.data.progress.correctAttempts} {t(' · С помощью: ')}
        {state.data.progress.assistedAttempts}
      </p>
      {state.data.user.role === 'student' && (
        <>
          <p>
            <Link to={`/assistant?userId=${id}`}>{t('Персонаж и переписка помощника →')}</Link> ·{' '}
            <Link to={`/progress?userId=${id}`}>{t('Учебный отчёт →')}</Link> ·{' '}
            <Link to={`/onboarding?userId=${id}`}>{t('Анкета и диагностика →')}</Link>
          </p>
          <RunList userId={id} />
          <ProfileOverview userId={id} />
          <PlanOverview userId={id} />
          <DiagnosticHistory userId={id} />
          <SkillStates userId={id} />
        </>
      )}
      <p>
        {t('Преподаватели: ')}
        {state.data.teachers.map((user) => user.name).join(', ') || t('не назначены')}
      </p>
      <p>
        {t('Ученики: ')}
        {state.data.students.map((user) => user.name).join(', ') || t('не назначены')}
      </p>
      {(state.data.teachers.length > 0 || state.data.students.length > 0) && (
        <ul className="account-list">
          {[
            ...state.data.teachers.map((user) => ({ user, teacherId: user.id, studentId: id })),
            ...state.data.students.map((user) => ({ user, teacherId: id, studentId: user.id })),
          ].map(({ user, teacherId, studentId }) => (
            <li key={user.id}>
              <strong>{user.name}</strong>
              <span>{user.email}</span>
              {user.role === 'student' && (
                <Link to={`/teacher/students/${user.id}`}>{t('Карточка ученика →')}</Link>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void unassign(teacherId, studentId)}
                aria-label={t('Снять закрепление {0}', [user.email])}
              >
                {t('Снять закрепление')}
              </button>
            </li>
          ))}
        </ul>
      )}
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
          {t('Проверка доступа подтверждена')}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={blocked}
            onChange={(event) => {
              setBlocked(event.target.checked);
              if (event.target.checked) setActive(true);
            }}
          />
          {t('Заблокировать аккаунт')}
        </label>
        {blocked && (
          <label>
            {t('Причина блокировки')}
            <textarea
              maxLength={1000}
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value)}
            />
          </label>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
              if (!event.target.checked) {
                setBlocked(false);
                setBlockReason('');
              }
            }}
          />
          {t('Аккаунт активен')}
        </label>
        <div className="form-actions">
          <button disabled={busy}>{t('Сохранить доступ')}</button>
          <button
            type="button"
            disabled={busy}
            className="secondary"
            onClick={() => {
              void revoke();
            }}
          >
            {t('Завершить все сессии')}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="error inline-message">
          {t(error.message)}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      <h3>{t('Последние проверки соединения')}</h3>
      {state.data.assessments.length ? (
        state.data.assessments.map((assessment) => (
          <details key={assessment.id}>
            <summary>
              {assessment.ip} ·{' '}
              {assessment.denied ? t('Доступ ограничен') : t('Проверка завершена')} ·{' '}
              {new Date(assessment.createdAt).toLocaleString(dateLocale)}
            </summary>
            <ul>
              {assessment.observations.map((observation) => (
                <li key={t(observation.label)}>
                  {t(observation.label)}:{' '}
                  {observation.status === 'observed'
                    ? t('есть признак')
                    : observation.status === 'not_observed'
                      ? t('не обнаружен')
                      : t('нет измерения')}
                </li>
              ))}
            </ul>
          </details>
        ))
      ) : (
        <p className="muted">{t('Проверки не записаны.')}</p>
      )}
    </section>
  );
}
function AssignTeacher({ onSaved, version }: { onSaved: () => void; version: number }) {
  const [teacherSearch, setTeacherSearch] = useState(''),
    [studentSearch, setStudentSearch] = useState(''),
    [teacherFilter, setTeacherFilter] = useState(''),
    [studentFilter, setStudentFilter] = useState('');
  const teachers = useResource(
    `/admin/accounts?role=teacher&search=${encodeURIComponent(teacherFilter)}`,
    usersSchema,
  );
  const students = useResource(
    `/admin/accounts?role=student&search=${encodeURIComponent(studentFilter)}`,
    usersSchema,
  );
  useEffect(() => {
    if (version > 0) {
      teachers.refresh();
      students.refresh();
    }
  }, [version, teachers.refresh, students.refresh]);
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
      setMessage(t(result.message));
      onSaved();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t('Закрепить ученика')}</h2>
      <form
        onSubmit={(event) => {
          void assign(event);
        }}
      >
        <label htmlFor="teacher-lookup">{t('Поиск преподавателя')}</label>
        <input
          id="teacher-lookup"
          value={teacherSearch}
          onChange={(e) => setTeacherSearch(e.target.value)}
          maxLength={100}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setTeacherId('');
            setTeacherFilter(teacherSearch);
          }}
        >
          {t('Найти преподавателя')}
        </button>
        <label htmlFor="assign-teacher">{t('Преподаватель')}</label>
        <select
          id="assign-teacher"
          value={teacherId}
          onChange={(event) => setTeacherId(event.target.value)}
          required
        >
          <option value="">{t('Выберите преподавателя')}</option>
          {(teachers.state.status === 'ready' ? teachers.state.data : []).map((user) => (
            <option value={user.id} key={user.id}>
              {user.name} · {user.email}
            </option>
          ))}
        </select>
        <label htmlFor="student-lookup">{t('Поиск ученика для закрепления')}</label>
        <input
          id="student-lookup"
          value={studentSearch}
          onChange={(e) => setStudentSearch(e.target.value)}
          maxLength={100}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setStudentId('');
            setStudentFilter(studentSearch);
          }}
        >
          {t('Найти ученика')}
        </button>
        <label htmlFor="assign-student">{t('Ученик')}</label>
        <select
          id="assign-student"
          value={studentId}
          onChange={(event) => setStudentId(event.target.value)}
          required
        >
          <option value="">{t('Выберите ученика')}</option>
          {(students.state.status === 'ready' ? students.state.data : []).map((user) => (
            <option value={user.id} key={user.id}>
              {user.name} · {user.email}
            </option>
          ))}
        </select>
        <button disabled={busy}>{t('Назначить преподавателя')}</button>
      </form>
      {teachers.state.status === 'error' && (
        <ErrorState error={teachers.state.error} retry={teachers.refresh} />
      )}
      {students.state.status === 'error' && (
        <ErrorState error={students.state.error} retry={students.refresh} />
      )}
      {error && (
        <p role="alert" className="error inline-message">
          {t(error.message)}
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
      <h2>{t('Настройки безопасности')}</h2>
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
          {t('Капча на страницах авторизации')}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={vpn} onChange={(event) => setVpn(event.target.checked)} />
          {t('Проверка доступа пользователей с VPN')}
        </label>
        <p className="muted">
          {t(
            'При включённой проверке нужен подтверждённый доступ аккаунта и IP из белого списка. При срабатывании проверки сервис недоступен.',
          )}
        </p>
        <label htmlFor="allowed-ips">{t('Белый список IP и сетей')}</label>
        <textarea
          id="allowed-ips"
          value={ranges}
          onChange={(event) => setRanges(event.target.value)}
          rows={5}
          placeholder={t('По одному адресу или сети на строку')}
        />
        <p>
          {t('Текущий IP: ')}
          <code>{state.data.currentIp}</code>{' '}
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
            {t('Добавить текущий IP')}
          </button>
        </p>
        <label htmlFor="session-hours">{t('Срок сессии, часы')}</label>
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
            {t(error.message)}
          </p>
        )}
        <button disabled={busy}>{busy ? t('Сохраняем…') : t('Сохранить настройки')}</button>
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
      <h2>{t('Последние действия')}</h2>
      <ul className="account-list">
        {state.data.map((item) => (
          <li key={item.id}>
            <strong>{item.action}</strong>
            <span>{item.actorEmail ?? t('Системная операция')}</span>
            <span>{item.targetEmail ?? ''}</span>
            <time dateTime={item.createdAt}>
              {new Date(item.createdAt).toLocaleString(dateLocale)}
            </time>
          </li>
        ))}
      </ul>
      <button className="secondary" onClick={refresh}>
        {t('Обновить журнал')}
      </button>
    </section>
  );
}
