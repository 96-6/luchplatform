import { t, locale } from '../i18n';
import { pageStatusTitle } from '@luch/contracts';
import { ApiError } from '../lib/api';
import { Link } from 'react-router-dom';
export function StatusState({
  status,
  message,
  requestId,
}: {
  status: number;
  message?: string;
  requestId?: string | undefined;
}) {
  const title = pageStatusTitle(status, locale);
  return (
    <section className="state error" role="alert" data-testid="page-status" data-status={status}>
      <span className="status-badge">{status}</span>
      <h1>{title}</h1>
      <p>{message ?? t('Проверьте адрес и доступ к ресурсу.')}</p>
      {requestId && (
        <p className="muted request-id">
          {t('Код обращения: ')}
          {requestId}
        </p>
      )}
      <p>
        <Link to="/">{t('На главную')}</Link>
        {status === 401 && (
          <>
            {' '}
            · <Link to="/login">{t('Войти в аккаунт')}</Link>
          </>
        )}
        {status === 410 && (
          <>
            {' '}
            · <Link to="/register">{t('Запросить новое письмо')}</Link>
          </>
        )}
      </p>
    </section>
  );
}
export function LoadingState({ text = t('Загружаем данные…') }: { text?: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </div>
  );
}
export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="state empty">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
export function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  if (error instanceof ApiError && error.status && [401, 403, 404, 410].includes(error.status))
    return (
      <StatusState status={error.status} message={t(error.message)} requestId={error.requestId} />
    );
  return (
    <div className="state error" role="alert">
      <h2>{t('Не удалось загрузить данные')}</h2>
      <p>{t(error.message)}</p>
      {error instanceof ApiError && error.requestId && (
        <p className="muted request-id">
          {t('Код обращения: ')}
          {error.requestId}
        </p>
      )}
      <button onClick={retry}>{t('Повторить')}</button>
    </div>
  );
}
