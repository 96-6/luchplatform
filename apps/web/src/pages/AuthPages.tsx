import { t, dateLocale } from '../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  completionSchema,
  enrollmentSchema,
  mailSchema,
  messageSchema,
  sessionSchema,
  loginResponseSchema,
  loginChallengeSchema,
  type Session,
} from '@luch/contracts';
import { api, ApiError } from '../lib/api';
import { PasswordFields } from '../components/PasswordFields';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
import { useAuth } from '../auth/AuthContext';
import { useSecurity } from '../auth/SecurityGate';
import { CaptchaField, useCaptcha } from '../auth/Captcha';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<{ csrfToken: string; expiresAt: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const captcha = useCaptcha('login');
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { policy } = useSecurity();
  useEffect(() => {
    const controller = new AbortController();
    void api('/auth/login/challenge', loginChallengeSchema, { signal: controller.signal })
      .then(
        (value) => {
          if (!controller.signal.aborted && value?.step === 'totp') setStep(value);
        },
        (failure) => {
          if (!controller.signal.aborted) setError(failure as Error);
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, []);
  function accept(session: Session) {
    auth.accept(session);
    const returnTo = location.state?.returnTo;
    navigate(
      typeof returnTo === 'string' && /^\/meeting-invite\?token=[A-Za-z0-9_-]{43}$/.test(returnTo)
        ? returnTo
        : (session.dashboardPath ?? '/student'),
      { replace: true },
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step) {
        accept(
          await api('/auth/login/confirm', sessionSchema, {
            body: { code },
            loginCsrf: step.csrfToken,
          }),
        );
      } else {
        const check = captcha.image && captcha.answer.trim() ? captcha.submission() : undefined;
        const result = await api('/auth/login', loginResponseSchema, {
          body: { email: email.trim(), password, ...(check ? { captcha: check } : {}) },
        });
        setPassword('');
        if ('step' in result) {
          if (result.step === 'enrollment') navigate('/authenticator', { replace: true });
          else setStep(result);
        } else accept(result);
      }
    } catch (failure) {
      setError(failure as Error);
      setCode('');
      if (failure instanceof ApiError && failure.code === 'LOGIN_EXPIRED') setStep(null);
      if (!step) captcha.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function restart() {
    setBusy(true);
    try {
      await auth.logout();
      setStep(null);
      setCode('');
      setError(null);
      captcha.refresh();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  if (checking) return <LoadingState />;
  return (
    <section className="auth-card panel">
      <h1>{step ? t('Подтверждение входа') : t('Вход в аккаунт')}</h1>
      <p>
        {step
          ? t('Введите текущий код из приложения Authenticator. Это второй шаг входа.')
          : t('Введите почту и пароль. На следующем шаге подтвердите вход кодом Authenticator.')}
      </p>
      {location.state?.verified && !step && (
        <p className="success" role="status">
          {t('Почта подтверждена. Войдите с выбранным паролем, чтобы подключить 2FA.')}
        </p>
      )}
      {location.state?.passwordChanged && !step && (
        <p className="success" role="status">
          {t('Пароль сохранён. Войдите с новым паролем и кодом Authenticator.')}
        </p>
      )}
      <form noValidate onSubmit={(event) => void submit(event)}>
        {step ? (
          <>
            <label htmlFor="login-code">{t('Код Authenticator')}</label>
            <input
              id="login-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="login-email">{t('Почта')}</label>
            <input
              id="login-email"
              type="text"
              inputMode="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
            <label htmlFor="login-password">{t('Пароль')}</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={128}
              required
            />
            <CaptchaField captcha={captcha} />
          </>
        )}
        {error && (
          <p className="error inline-message" role="alert">
            {t(error.message)}
          </p>
        )}
        <div className="form-actions">
          <button disabled={busy}>
            {busy ? t('Входим…') : step ? t('Подтвердить вход') : t('Войти')}
          </button>
          {step && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void restart()}
            >
              {t('Вернуться к почте и паролю')}
            </button>
          )}
        </div>
      </form>
      {!step && (
        <p className="auth-links">
          <Link to="/forgot-password">{t('Установить или восстановить пароль')}</Link>
        </p>
      )}
      <p className="auth-links">
        {t('Нет аккаунта? ')}
        <Link to="/register">{t('Создать аккаунт')}</Link>
      </p>
      {policy.localMailboxEnabled && !step && (
        <div className="notice">
          <strong>{t('Демонстрационные аккаунты')}</strong>
          <p>student@example.test · teacher@example.test · admin@example.test</p>
          <Link to="/demo-mail">{t('Открыть демо-почту для настройки входа →')}</Link>
        </div>
      )}
    </section>
  );
}
export function RegisterPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  const captcha = useCaptcha('register');
  const { policy } = useSecurity();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (password !== confirmation) throw new Error(t('Пароли не совпадают.'));
      const check = captcha.submission();
      const result = await api('/auth/register', messageSchema, {
        body: {
          email: email.trim().toLowerCase(),
          name: name.trim(),
          password,
          role,
          ...(check ? { captcha: check } : {}),
        },
      });
      setMessage(t(result.message));
      setPassword('');
      setConfirmation('');
      captcha.refresh();
    } catch (failure) {
      setError(failure as Error);
      captcha.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Создать аккаунт')}</h1>
      <p>
        {t('Выберите пароль, подтвердите почту и подключите Authenticator для второго шага входа.')}
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label htmlFor="register-name">{t('Имя')}</label>
        <input
          id="register-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          minLength={2}
          maxLength={100}
          required
        />
        <label htmlFor="register-email">{t('Почта')}</label>
        <input
          id="register-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          maxLength={254}
          required
        />
        <PasswordFields
          prefix="register"
          password={password}
          confirmation={confirmation}
          setPassword={setPassword}
          setConfirmation={setConfirmation}
        />
        <label htmlFor="register-role">{t('Я регистрируюсь как')}</label>
        <select
          id="register-role"
          value={role}
          onChange={(event) => setRole(event.target.value as 'student' | 'teacher')}
        >
          <option value="student">{t('Ученик')}</option>
          <option value="teacher">{t('Преподаватель')}</option>
        </select>
        <CaptchaField captcha={captcha} />
        {error && (
          <p className="error inline-message" role="alert">
            {t(error.message)}
          </p>
        )}
        <button disabled={busy}>
          {busy ? t('Отправляем…') : t('Отправить письмо подтверждения')}
        </button>
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
        <Link to="/login">{t('Уже есть аккаунт? Войти')}</Link>
      </p>
    </section>
  );
}
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const value = params.get('token');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const navigate = useNavigate();
  async function verify() {
    setBusy(true);
    try {
      await api('/auth/verify-email', messageSchema, { body: { token: value } });
      navigate('/login', { replace: true, state: { verified: true } });
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Подтверждение почты')}</h1>
      {value ? (
        <>
          <p>{t('Подтвердите адрес, затем войдите с паролем для подключения Authenticator.')}</p>
          <button
            disabled={busy}
            onClick={() => {
              void verify();
            }}
          >
            {busy ? t('Подтверждаем…') : t('Подтвердить почту')}
          </button>
        </>
      ) : (
        <p>{t('Откройте ссылку из письма подтверждения.')}</p>
      )}
      {error && (
        <p className="error inline-message" role="alert">
          {t(error.message)}
        </p>
      )}
      <p className="auth-links">
        <Link to="/register">{t('Запросить новое письмо')}</Link>
      </p>
    </section>
  );
}
export function AuthenticatorPage() {
  const { state, refresh } = useResource('/auth/enrollment', enrollmentSchema);
  const captcha = useCaptcha('enrollment');
  const auth = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const check = captcha.submission();
      const result = await api('/auth/enrollment/confirm', completionSchema, {
        body: { code, ...(check ? { captcha: check } : {}) },
      });
      auth.accept(result.session);
      if (result.awaitingReview) setAwaiting(true);
      else navigate(result.session.dashboardPath ?? '/student', { replace: true });
    } catch (failure) {
      setError(failure as Error);
      captcha.refresh();
    } finally {
      setBusy(false);
    }
  }
  if (awaiting)
    return (
      <section className="auth-card panel">
        <h1>{t('Authenticator подключён')}</h1>
        <p>{t('Доступ ожидает проверки администратором.')}</p>
        <Link to="/login">{t('Вернуться ко входу')}</Link>
      </section>
    );
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error')
    return (
      <>
        <ErrorState error={state.error} retry={refresh} />
        <Link to="/login">{t('Вернуться ко входу')}</Link>
      </>
    );
  return (
    <section className="auth-card panel">
      <p className="eyebrow">{t('Почта подтверждена')}</p>
      <h1>{t('Подключить Authenticator')}</h1>
      <p>{state.data.email}</p>
      <p>
        {t(
          'Добавьте аккаунт в Google Authenticator, Microsoft Authenticator или другое совместимое приложение.',
        )}
      </p>
      <img
        className="auth-qr"
        src={state.data.qrDataUrl}
        width={240}
        height={240}
        alt={t('QR-код подключения Authenticator')}
      />
      <details>
        <summary>{t('Ввести ключ вручную')}</summary>
        <code className="manual-key" data-testid="manual-key">
          {state.data.manualKey}
        </code>
      </details>
      <p className="muted">
        {t('QR-код и ключ нужны только для подключения. Не передавайте их другим людям.')}
      </p>
      <form
        onSubmit={(event) => {
          void confirm(event);
        }}
      >
        <label htmlFor="setup-code">{t('Код Authenticator')}</label>
        <input
          id="setup-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          required
        />
        <CaptchaField captcha={captcha} />
        {error && (
          <p role="alert" className="error inline-message">
            {t(error.message)}
          </p>
        )}
        <button disabled={busy}>{busy ? t('Подключаем…') : t('Подключить и войти')}</button>
      </form>
    </section>
  );
}
export function DemoMailPage() {
  const { policy } = useSecurity();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? 'student@example.test');
  if (!policy.localMailboxEnabled) return <p>{t('Демо-почта недоступна в этой среде.')}</p>;
  return (
    <>
      <p className="eyebrow">{t('Локальная демонстрация')}</p>
      <h1>{t('Демо-почта')}</h1>
      <p className="lead">
        {t(
          'Письма показаны здесь вместо отправки на настоящий адрес. Для обычных аккаунтов на хостинге используется почтовая отправка.',
        )}
      </p>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ email });
        }}
      >
        <label htmlFor="mail-email">{t('Почта аккаунта')}</label>
        <div className="form-row">
          <input
            id="mail-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <button>{t('Открыть письма')}</button>
        </div>
        <div className="demo-choices">
          {['student@example.test', 'teacher@example.test', 'admin@example.test'].map((address) => (
            <button
              type="button"
              className="secondary"
              key={address}
              onClick={() => {
                setEmail(address);
                setParams({ email: address });
              }}
            >
              {address}
            </button>
          ))}
        </div>
      </form>
      <LocalInbox email={params.get('email') ?? 'student@example.test'} />
    </>
  );
}
function LocalInbox({ email }: { email: string }) {
  const { state, refresh } = useResource(
    `/dev/mail?email=${encodeURIComponent(email)}`,
    mailSchema,
  );
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  return (
    <section className="panel">
      <h2>
        {t('Письма для ')}
        {email}
      </h2>
      {!state.data.length ? (
        <p>
          {t(
            'Писем пока нет. Создайте аккаунт или загрузите демонстрационные аккаунты по инструкции.',
          )}
        </p>
      ) : (
        state.data.map((mail, index) => (
          <article key={mail.id} className="mail-item">
            <h3>{mail.subject}</h3>
            <time dateTime={mail.createdAt}>
              {new Date(mail.createdAt).toLocaleString(dateLocale)}
            </time>
            <p>{t('Откройте письмо, чтобы подтвердить почту или установить пароль.')}</p>
            <Link
              className="text-link"
              to={`${new URL(mail.verificationUrl).pathname}${new URL(mail.verificationUrl).search}`}
            >
              {index === 0 ? t('Открыть последнее письмо') : t('Открыть письмо')}
            </Link>
          </article>
        ))
      )}
      <button className="secondary" onClick={refresh}>
        {t('Обновить письма')}
      </button>
    </section>
  );
}
