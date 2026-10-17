import { t } from '../i18n';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authPolicySchema, networkAccessSchema } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
import { LoadingState, ErrorState } from '../components/States';
import { collectNetworkEvidence } from './network';

const SecurityContext = createContext<{
  policy: z.infer<typeof authPolicySchema>;
  recheck: () => void;
} | null>(null);
export function useSecurity() {
  const value = useContext(SecurityContext);
  if (!value) throw new Error('Security context unavailable');
  return value;
}
export function SecurityGate({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: Error }
    | { status: 'denied'; message: string }
    | { status: 'ready'; policy: z.infer<typeof authPolicySchema> }
  >({ status: 'loading' });
  const recheck = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      const policy = await api('/security/bootstrap', authPolicySchema, {
        signal: controller.signal,
      });
      if (policy.networkChecksEnabled) {
        const evidence = await collectNetworkEvidence(policy.probeTargets, policy.stunUrls);
        if (controller.signal.aborted) return;
        const access = await api('/security/evaluate', networkAccessSchema, {
          body: evidence,
          signal: controller.signal,
        });
        if (!access.allowed) {
          setState({ status: 'denied', message: access.message ?? t('Сервис недоступен') });
          return;
        }
      }
      if (!controller.signal.aborted) setState({ status: 'ready', policy });
    })().catch((error: Error) => {
      if (!controller.signal.aborted) setState({ status: 'error', error });
    });
    return () => controller.abort();
  }, [revision]);
  if (state.status === 'loading')
    return (
      <main className="access-screen">
        <LoadingState text={t('Проверяем доступ к платформе…')} />
      </main>
    );
  if (state.status === 'error')
    return (
      <main className="access-screen">
        <ErrorState error={state.error} retry={recheck} />
      </main>
    );
  if (state.status === 'denied')
    return (
      <main className="access-screen" role="alert">
        <h1>{t(state.message)}</h1>
        <button onClick={recheck}>{t('Проверить соединение ещё раз')}</button>
      </main>
    );
  return (
    <SecurityContext.Provider value={{ policy: state.policy, recheck }}>
      {children}
    </SecurityContext.Provider>
  );
}
