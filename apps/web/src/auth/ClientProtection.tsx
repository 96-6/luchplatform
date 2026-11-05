import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CLIENT_PROTECTION_MESSAGE,
  clientProtectionStateSchema,
  type ClientProtectionState,
} from '@luch/contracts';
import { t } from '../i18n';
import { LoadingState, ErrorState } from '../components/States';
import { useAuth } from './AuthContext';
import { api } from '../lib/api';

type Runtime = { checkClient(options: { force: boolean; signal: AbortSignal }): Promise<unknown> };
const modulePath = '/api/v1/security/client/runtime.js';
let runtime: Promise<Runtime> | undefined;
let importAttempt = 0;
function loadRuntime(signal: AbortSignal) {
  runtime ??= import(/* @vite-ignore */ `${modulePath}?attempt=${importAttempt++}`).catch(
    (error) => {
      runtime = undefined;
      throw error;
    },
  );
  return new Promise<Runtime>((resolve, reject) => {
    const abort = () => reject(new Error('Client check interrupted'));
    const timer = setTimeout(abort, 15000);
    signal.addEventListener('abort', abort, { once: true });
    void runtime!.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    });
    if (signal.aborted) abort();
  });
}
export function ClientProtection({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const user = auth.session.user;
  const owner = user && user.role !== 'superadmin' ? `${user.id}:${user.role}` : '';
  const [state, setState] = useState<{
    owner: string;
    policy: ClientProtectionState | null;
    error: Error | null;
    passed: boolean;
  }>({ owner: '', policy: null, error: null, passed: false });
  const [revision, retry] = useState(0);
  const policy = useRef<ClientProtectionState | null>(null);
  useEffect(() => {
    policy.current = null;
    if (!owner) return;
    const controller = new AbortController();
    let busy = false;
    const check = async (force = false) => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        let result = await api('/security/client/bootstrap', clientProtectionStateSchema, {
          signal: controller.signal,
        });
        policy.current = result;
        if (result.blockersRequired)
          result = clientProtectionStateSchema.parse(
            await (
              await loadRuntime(controller.signal)
            ).checkClient({ force, signal: controller.signal }),
          );
        if (controller.signal.aborted) return;
        policy.current = result;
        setState({ owner, policy: result, error: null, passed: true });
      } catch (e) {
        if (!controller.signal.aborted)
          setState((old) => ({
            owner,
            policy: policy.current,
            error: e as Error,
            passed: old.owner === owner && old.passed,
          }));
      } finally {
        busy = false;
      }
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') void check(true);
    };
    void check();
    const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    window.addEventListener('luch:client-check', refresh);
    const menu = (event: MouseEvent) => {
      if (!policy.current?.interactionRestricted) return;
      const path = event.composedPath().filter((node): node is Element => node instanceof Element);
      if (!path.some((node) => node.matches('#content'))) return;
      if (
        path.some((node) =>
          node.matches(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"]),a,button,[role="button"],audio[controls],video[controls],[data-context-menu="allow"]',
          ),
        )
      )
        return;
      event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (!policy.current?.interactionRestricted) return;
      const code = event.code || event.key;
      if (
        event.key === 'F12' ||
        code === 'F12' ||
        (event.ctrlKey &&
          event.shiftKey &&
          ['KeyI', 'KeyJ', 'KeyC', 'i', 'j', 'c'].includes(code)) ||
        (event.metaKey &&
          (event.altKey || (event.shiftKey && code === 'KeyC')) &&
          ['KeyI', 'KeyJ', 'KeyC', 'i', 'j', 'c'].includes(code))
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('contextmenu', menu, true);
    document.addEventListener('keydown', key, true);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('luch:client-check', refresh);
      document.removeEventListener('contextmenu', menu, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [owner, revision]);
  if (auth.loading)
    return (
      <main className="access-screen">
        <LoadingState />
      </main>
    );
  if (auth.error)
    return (
      <main className="access-screen">
        <ErrorState error={auth.error} retry={auth.refresh} />
      </main>
    );
  if (!owner) return children;
  if (state.owner !== owner || (!state.policy && !state.error))
    return (
      <main className="access-screen">
        <LoadingState text={t('Проверяем настройки браузера…')} />
      </main>
    );
  return (
    <>
      {state.error && !state.policy?.blockersRequired && (
        <ErrorState error={state.error} retry={() => retry((old) => old + 1)} />
      )}
      {state.error && state.policy?.blockersRequired && (
        <section
          className="client-protection-denied"
          role="alert"
          aria-label={t('Доступ запрещён')}
        >
          <div className="panel">
            <span className="status-code">403</span>
            <h1>{t('Доступ запрещён')}</h1>
            <p>{t(CLIENT_PROTECTION_MESSAGE)}</p>
            <button onClick={() => retry((old) => old + 1)}>{t('Повторить проверку')}</button>
            <button className="secondary" onClick={() => void auth.logout()}>
              {t('Сменить аккаунт')}
            </button>
          </div>
        </section>
      )}
      {state.passed && (
        <div
          hidden={Boolean(state.error && state.policy?.blockersRequired)}
          inert={Boolean(state.error && state.policy?.blockersRequired)}
        >
          {children}
        </div>
      )}
    </>
  );
}
