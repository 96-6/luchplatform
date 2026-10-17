import { t, dateLocale } from '../i18n';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  completionSchema,
  enrollmentSchema,
  mailSchema,
  messageSchema,
  sessionSchema,
} from '@luch/contracts';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
import { useAuth } from '../auth/AuthContext';
import { useSecurity } from '../auth/SecurityGate';
import { CaptchaField, useCaptcha } from '../auth/Captcha';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const captcha = useCaptcha('login');
  const auth = useAuth();
  const navigate = useNavigate();
  const { policy } = useSecurity();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const check = captcha.image && captcha.answer.trim() ? captcha.submission() : undefined;
      const session = await api('/auth/login', sessionSchema, {
        body: { email: email.trim(), code, ...(check ? { captcha: check } : {}) },
      });
      auth.accept(session);
      navigate(session.dashboardPath ?? '/student', { replace: true });
    } catch (failure) {
      setError(failure as Error);
      captcha.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card panel">
      <h1>{t('Вход в аккаунт')}</h1>
      <p>{t('Введите почту и текущий код из вашего приложения Authenticator.')}</p>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label htmlFor="login-email">{t('Почта')}</label>
        <input
          id="login-email"
          type="text"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
        />
        <label htmlFor="login-code">{t('Код Authenticator')}</label>
        <input
          id="login-code"
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
          <p className="error inline-message" role="alert">
            {t(error.message)}
          </p>
        )}
        <button disabled={busy}>{busy ? t('Входим…') : t('Войти')}</button>
      </form>
      <p className="auth-links">
        {t('Нет аккаунта? ')}
        <Link to="/register">{t('Создать аккаунт')}</Link>
      </p>
      {policy.localMailboxEnabled && (
        <div className="notice">
          <strong>{t('Демонстрационные аккаунты')}</strong>
          <p>student@example.test · teacher@example.test · admin@example.test</p>
          <Link to="/demo-mail">{t('Открыть демо-почту и подключить Authenticator →')}</Link>
        </div>
      )}
    </section>
  );
}
export function RegisterPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
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
      const check = captcha.submission();
      const result = await api('/auth/register', messageSchema, {
        body: {
          email: email.trim().toLowerCase(),
          name: name.trim(),
          role,
          ...(check ? { captcha: check } : {}),
        },
      });
      setMessage(t(result.message));
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
        {t('Подтвердите почту, затем подключите Authenticator по QR-коду. Пароль не требуется.')}
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
      navigate('/authenticator', { replace: true });
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
          <p>{t('Подтвердите адрес, чтобы перейти к подключению Authenticator.')}</p>
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
        <Link to="/register">{t('Запросить новое письмо')}</Link>
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
            <p>{t('Перейдите по ссылке, чтобы подтвердить почту и подключить Authenticator.')}</p>
            <Link
              className="text-link"
              to={`${new URL(mail.verificationUrl).pathname}${new URL(mail.verificationUrl).search}`}
            >
              {index === 0
                ? t('Открыть последнее письмо подтверждения')
                : t('Открыть письмо подтверждения')}
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
