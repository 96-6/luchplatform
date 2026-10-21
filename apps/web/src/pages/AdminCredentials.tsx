import { t } from '../i18n';
import { useRef, useState, type FormEvent } from 'react';
import { accountAuthenticatorSchema, userSchema, type User } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PasswordFields } from '../components/PasswordFields';

type Setup = z.infer<typeof accountAuthenticatorSchema>;
function SetupCard({ setup, close }: { setup: Setup; close: () => void }) {
  return (
    <section className="credential-setup">
      <h3>
        {t('Authenticator для ')}
        {setup.user.email}
      </h3>
      <img
        className="auth-qr"
        src={setup.qrDataUrl}
        width={240}
        height={240}
        alt={t('QR-код Authenticator пользователя')}
      />
      <details>
        <summary>{t('Ключ для ручного подключения')}</summary>
        <code className="manual-key" data-testid="admin-manual-key">
          {setup.manualKey}
        </code>
      </details>
      <p>
        {setup.user.emailVerified &&
        setup.user.authenticatorEnabled &&
        setup.user.passwordConfigured
          ? t('Аккаунт готов к входу по почте, паролю и коду Authenticator.')
          : t('Подключение ещё не завершено.')}
      </p>
      {setup.user.isBlocked && (
        <p>{t('Доступ аккаунта заблокирован. Измените доступ в карточке пользователя.')}</p>
      )}
      <button type="button" className="secondary" onClick={close}>
        {t('Скрыть QR-код')}
      </button>
    </section>
  );
}
export function AdminCreateAccount({ created }: { created: (user: User) => void }) {
  const [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [role, setRole] = useState<User['role']>('student');
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [setup, setSetup] = useState<Setup | null>(null);
  const pending = useRef<{ payload: string; operationId: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input = { email: email.trim().toLowerCase(), name: name.trim(), role, password },
      payload = JSON.stringify(input);
    if (pending.current?.payload !== payload)
      pending.current = { payload, operationId: crypto.randomUUID() };
    try {
      if (password !== confirmation) throw new Error(t('Пароли не совпадают.'));
      const value = await api('/admin/accounts', accountAuthenticatorSchema, {
        body: { ...input, operationId: pending.current.operationId },
      });
      setSetup(value);
      created(value.user);
      pending.current = null;
      setPassword('');
      setConfirmation('');
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>{t('Создать пользователя')}</h2>
      <p>
        {t(
          'Задайте начальный пароль. Пользователь подключает Authenticator по QR-коду, затем входит с почтой, паролем и одноразовым кодом.',
        )}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="admin-new-email">{t('Почта нового пользователя')}</label>
          <input
            id="admin-new-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="admin-new-name">{t('Имя нового пользователя')}</label>
          <input
            id="admin-new-name"
            required
            minLength={2}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="admin-new-role">{t('Роль нового пользователя')}</label>
          <select
            id="admin-new-role"
            value={role}
            onChange={(e) => setRole(e.target.value as User['role'])}
          >
            <option value="student">{t('Ученик')}</option>
            <option value="teacher">{t('Преподаватель')}</option>
            <option value="admin">{t('Администратор')}</option>
            <option value="superadmin">{t('Суперадмин')}</option>
          </select>
          <PasswordFields
            prefix="admin-new"
            password={password}
            confirmation={confirmation}
            setPassword={setPassword}
            setConfirmation={setConfirmation}
          />
          <button>{t('Создать и показать QR-код')}</button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {t(error.message)}
        </p>
      )}
      {setup && <SetupCard setup={setup} close={() => setSetup(null)} />}
    </section>
  );
}
export function AdminAuthenticator({ userId, changed }: { userId: string; changed: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const operation = useRef<string | null>(null);
  async function show() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api(`/admin/accounts/${userId}/authenticator`, accountAuthenticatorSchema));
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError(null);
    operation.current ??= crypto.randomUUID();
    try {
      setSetup(
        await api(`/admin/accounts/${userId}/authenticator/reset`, accountAuthenticatorSchema, {
          body: { operationId: operation.current },
        }),
      );
      operation.current = null;
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{t('Управление Authenticator')}</h3>
      <div className="form-actions">
        <button className="secondary" disabled={busy} onClick={() => void show()}>
          {t('Показать QR-код 2FA')}
        </button>
        <button className="secondary" disabled={busy} onClick={() => void reset()}>
          {t('Сбросить 2FA и создать новый QR')}
        </button>
      </div>
      <p className="muted">
        {t(
          'Сброс заменяет ключ и завершает все сессии этого пользователя. Новый ключ сразу действует для входа.',
        )}
      </p>
      {error && (
        <p role="alert" className="error">
          {t(error.message)}
        </p>
      )}
      {setup && (
        <SetupCard
          setup={setup}
          close={() => {
            setSetup(null);
            changed();
          }}
        />
      )}
    </section>
  );
}

export function AdminPassword({
  userId,
  configured,
  changed,
}: {
  userId: string;
  configured: boolean;
  changed: () => void;
}) {
  const { session } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = useRef<{ password: string; operationId: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (password !== confirmation) throw new Error(t('Пароли не совпадают.'));
      if (pending.current?.password !== password)
        pending.current = { password, operationId: crypto.randomUUID() };
      await api(`/admin/accounts/${userId}/password/reset`, userSchema, {
        body: { password, operationId: pending.current.operationId },
      });
      setPassword('');
      setConfirmation('');
      pending.current = null;
      setSaved(true);
      changed();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{t('Пароль аккаунта')}</h3>
      <p>{configured ? t('Пароль установлен') : t('Пароль ещё не установлен')}</p>
      {userId === session.user?.id ? (
        <Link to="/account/security">{t('Изменить свой пароль')}</Link>
      ) : (
        <>
          <p className="muted">
            {t(
              'Можно задать новый пароль. Прежний пароль недоступен для просмотра. Сброс завершит все сессии пользователя и сохранит его Authenticator.',
            )}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <fieldset disabled={busy}>
              <PasswordFields
                prefix="admin-reset"
                password={password}
                confirmation={confirmation}
                setPassword={setPassword}
                setConfirmation={setConfirmation}
              />
              <button className="secondary">{t('Задать новый пароль пользователю')}</button>
            </fieldset>
          </form>
          {error && (
            <p role="alert" className="error inline-message">
              {t(error.message)}
            </p>
          )}
          {saved && (
            <p role="status" className="success">
              {t('Новый пароль установлен. Все сессии пользователя завершены.')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
