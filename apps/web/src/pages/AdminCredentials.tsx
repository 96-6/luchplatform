import { useRef, useState, type FormEvent } from 'react';
import { accountAuthenticatorSchema, type User } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';

type Setup = z.infer<typeof accountAuthenticatorSchema>;
function SetupCard({ setup, close }: { setup: Setup; close: () => void }) {
  return (
    <section className="credential-setup">
      <h3>Authenticator для {setup.user.email}</h3>
      <img
        className="auth-qr"
        src={setup.qrDataUrl}
        width={240}
        height={240}
        alt="QR-код Authenticator пользователя"
      />
      <details>
        <summary>Ключ для ручного подключения</summary>
        <code className="manual-key" data-testid="admin-manual-key">
          {setup.manualKey}
        </code>
      </details>
      <p>
        {setup.user.emailVerified && setup.user.authenticatorEnabled
          ? 'Аккаунт готов к входу по почте и текущему коду Authenticator.'
          : 'Подключение ещё не завершено.'}
      </p>
      {setup.user.isBlocked && (
        <p>Доступ аккаунта заблокирован. Измените доступ в карточке пользователя.</p>
      )}
      <button type="button" className="secondary" onClick={close}>
        Скрыть QR-код
      </button>
    </section>
  );
}
export function AdminCreateAccount({ created }: { created: (user: User) => void }) {
  const [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [role, setRole] = useState<User['role']>('student');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [setup, setSetup] = useState<Setup | null>(null);
  const pending = useRef<{ payload: string; operationId: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input = { email: email.trim().toLowerCase(), name: name.trim(), role },
      payload = JSON.stringify(input);
    if (pending.current?.payload !== payload)
      pending.current = { payload, operationId: crypto.randomUUID() };
    try {
      const value = await api('/admin/accounts', accountAuthenticatorSchema, {
        body: { ...input, operationId: pending.current.operationId },
      });
      setSetup(value);
      created(value.user);
      pending.current = null;
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Создать пользователя</h2>
      <p>
        Аккаунт будет сразу подтверждён. Для входа пользователь сканирует QR-код и вводит почту с
        текущим кодом Authenticator.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy}>
          <label htmlFor="admin-new-email">Почта нового пользователя</label>
          <input
            id="admin-new-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="admin-new-name">Имя нового пользователя</label>
          <input
            id="admin-new-name"
            required
            minLength={2}
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="admin-new-role">Роль нового пользователя</label>
          <select
            id="admin-new-role"
            value={role}
            onChange={(e) => setRole(e.target.value as User['role'])}
          >
            <option value="student">Ученик</option>
            <option value="teacher">Преподаватель</option>
            <option value="admin">Администратор</option>
            <option value="superadmin">Суперадмин</option>
          </select>
          <button>Создать и показать QR-код</button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {error.message}
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
      <h3>Управление Authenticator</h3>
      <div className="form-actions">
        <button className="secondary" disabled={busy} onClick={() => void show()}>
          Показать QR-код 2FA
        </button>
        <button className="secondary" disabled={busy} onClick={() => void reset()}>
          Сбросить 2FA и создать новый QR
        </button>
      </div>
      <p className="muted">
        Сброс заменяет ключ и завершает все сессии этого пользователя. Новый ключ сразу действует
        для входа.
      </p>
      {error && (
        <p role="alert" className="error">
          {error.message}
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
