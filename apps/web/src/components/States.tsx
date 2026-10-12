import { ApiError } from '../lib/api';
export function LoadingState({ text = 'Загружаем данные…' }: { text?: string }) {
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
  return (
    <div className="state error" role="alert">
      <h2>Не удалось загрузить данные</h2>
      <p>{error.message}</p>
      {error instanceof ApiError && error.requestId && (
        <p className="muted request-id">Код обращения: {error.requestId}</p>
      )}
      <button onClick={retry}>Повторить</button>
    </div>
  );
}
