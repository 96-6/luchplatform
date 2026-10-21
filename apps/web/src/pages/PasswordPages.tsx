import { t } from '../i18n';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { messageSchema } from '@luch/contracts';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { useSecurity } from '../auth/SecurityGate';
import { CaptchaField, useCaptcha } from '../auth/Captcha';
import { PasswordFields } from '../components/PasswordFields';

export function PasswordRequestPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  const captcha = useCaptcha('password');
  const { policy } = useSecurity();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const check = captcha.submission();
      const result = await api('/auth/password/request', messageSchema, {
        body: { email: email.trim().toLowerCase(), ...(check ? { captcha: check } : {}) },
      });
      setMessage(t(result.message));
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
      captcha.refresh();
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Установить или восстановить пароль')}</h1>
      <p>
        {t(
          'Укажите почту аккаунта. Мы отправим ссылку для установки нового пароля. Подключённый Authenticator сохранится.',
        )}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="password-email">{t('Почта')}</label>
        <input
          id="password-email"
          type="email"
          autoComplete="username"
          maxLength={254}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <CaptchaField captcha={captcha} />
        {error && (
          <p role="alert" className="error inline-message">
            {t(error.message)}
          </p>
        )}
        <button disabled={busy}>{busy ? t('Отправляем…') : t('Отправить ссылку')}</button>
      </form>
      {message && (
        <div className="success" role="status">
          {message}
          {policy.localMailboxEnabled && (
            <p>
              <Link to={`/demo-mail?email=${encodeURIComponent(email.trim())}`}>
                {t('Посмотреть письмо в демо-почте')}
              </Link>
            </p>
          )}
        </div>
      )}
      <p className="auth-links">
        <Link to="/login">{t('Вернуться ко входу')}</Link>
      </p>
    </section>
  );
}
export function PasswordResetPage() {
  const [params] = useSearchParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (password !== confirmation) throw new Error(t('Пароли не совпадают.'));
      const result = await api('/auth/password/reset', messageSchema, {
        body: { token: params.get('token'), password },
      });
      setPassword('');
      setConfirmation('');
      setMessage(t(result.message));
      auth.accept({ user: null, csrfToken: null, dashboardPath: null });
      navigate('/login', { replace: true, state: { passwordChanged: true } });
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Установка пароля')}</h1>
      {message ? (
        <>
          <p className="success" role="status">
            {message}
          </p>
          <Link className="button" to="/login">
            {t('Войти в аккаунт')}
          </Link>
        </>
      ) : (
        <>
          <p>
            {t(
              'После сохранения все прежние сессии будут завершены. Для входа понадобится новый пароль и Authenticator.',
            )}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <PasswordFields
              prefix="reset"
              password={password}
              confirmation={confirmation}
              setPassword={setPassword}
              setConfirmation={setConfirmation}
            />
            {error && (
              <p role="alert" className="error inline-message">
                {t(error.message)}
              </p>
            )}
            <button disabled={busy}>{busy ? t('Сохраняем…') : t('Сохранить пароль')}</button>
          </form>
          <p className="auth-links">
            <Link to="/forgot-password">{t('Запросить новую ссылку')}</Link>
          </p>
        </>
      )}
    </section>
  );
}
export function AccountSecurityPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (password !== confirmation) throw new Error(t('Пароли не совпадают.'));
      const result = await api('/auth/password/change', messageSchema, {
        body: { currentPassword, password, code },
      });
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
      setCode('');
      setMessage(t(result.message));
      auth.accept({ user: null, csrfToken: null, dashboardPath: null });
      navigate('/login', { replace: true, state: { passwordChanged: true } });
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Безопасность аккаунта')}</h1>
      <p>{auth.session.user?.email}</p>
      {message ? (
        <>
          <p className="success" role="status">
            {message}
          </p>
          <Link to="/login">{t('Войти в аккаунт')}</Link>
        </>
      ) : (
        <>
          <h2>{t('Изменить пароль')}</h2>
          <p>
            {t(
              'Подтвердите изменение текущим паролем и новым кодом Authenticator. Все сессии на ваших устройствах завершатся.',
            )}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="current-password">{t('Текущий пароль')}</label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <PasswordFields
              prefix="change"
              password={password}
              confirmation={confirmation}
              setPassword={setPassword}
              setConfirmation={setConfirmation}
            />
            <label htmlFor="change-code">{t('Код Authenticator')}</label>
            <input
              id="change-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
            {error && (
              <p role="alert" className="error inline-message">
                {t(error.message)}
              </p>
            )}
            <button disabled={busy}>{busy ? t('Сохраняем…') : t('Изменить пароль')}</button>
          </form>
        </>
      )}
    </section>
  );
}
