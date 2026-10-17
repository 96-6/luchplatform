import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { navigationAccessSchema } from '@luch/contracts';
import { useResource } from '../lib/useResource';
import { ApiError } from '../lib/api';
import { LoadingState, ErrorState, StatusState } from './States';
export function PageAccess({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <Check key={location.pathname + location.search} path={location.pathname + location.search}>
      {children}
    </Check>
  );
}
function Check({ path, children }: { path: string; children: ReactNode }) {
  const { state, refresh } = useResource(
    `/navigation/access?path=${encodeURIComponent(path)}`,
    navigationAccessSchema,
  );
  if (state.status === 'loading') return <LoadingState text="Проверяем доступ к странице…" />;
  if (state.status === 'error')
    return state.error instanceof ApiError &&
      state.error.status &&
      [400, 401, 403, 404, 410].includes(state.error.status) ? (
      <StatusState
        status={state.error.status}
        message={state.error.message}
        requestId={state.error.requestId}
      />
    ) : (
      <ErrorState error={state.error} retry={refresh} />
    );
  return children;
}
