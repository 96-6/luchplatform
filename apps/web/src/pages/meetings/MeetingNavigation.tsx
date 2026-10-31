import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useBeforeUnload, useBlocker, type BlockerFunction } from 'react-router-dom';
import { t } from '../../i18n';

type Intent = { href: string; action: () => void | Promise<void>; openNew?: () => void };
type Active = { id: string; leave: () => Promise<void> };
const Context = createContext<{
  register: (id: string, leave: () => Promise<void>) => () => void;
  request: (intent: Intent) => void;
} | null>(null);
export function useMeetingNavigation() {
  const value = useContext(Context);
  if (!value) throw Error('Meeting navigation context unavailable');
  return value;
}
export function MeetingNavigationProvider({ children }: { children: ReactNode }) {
  const active = useRef<Active | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const [intent, setIntent] = useState<Intent | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const register = useCallback((id: string, leave: () => Promise<void>) => {
    active.current = { id, leave };
    return () => {
      if (active.current?.id === id) active.current = null;
    };
  }, []);
  const request = useCallback((value: Intent) => {
    if (active.current) {
      setIntent(value);
      setError('');
    } else void value.action();
  }, []);
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        Boolean(active.current) &&
        (currentLocation.pathname !== nextLocation.pathname ||
          currentLocation.search !== nextLocation.search),
      [],
    ),
  );
  const blocked = blocker.state === 'blocked';
  const href =
    intent?.href ??
    (blocked ? blocker.location.pathname + blocker.location.search + blocker.location.hash : '');
  const opened = Boolean(intent) || blocked;
  useBeforeUnload(
    useCallback((event) => {
      if (active.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    }, []),
  );
  useEffect(() => {
    const handle = (event: MouseEvent) => {
      if (
        !active.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      )
        return;
      const url = new URL(anchor.href, location.href);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.href === location.href ||
        (url.origin === location.origin &&
          url.pathname === location.pathname &&
          url.search === location.search)
      )
        return;
      event.preventDefault();
      request({ href: url.href, action: () => location.assign(url.href) });
    };
    document.addEventListener('click', handle);
    return () => document.removeEventListener('click', handle);
  }, [request]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (opened && !node.open) node.showModal();
    else if (!opened && node.open) node.close();
  }, [opened]);
  function cancel() {
    setIntent(null);
    setError('');
    if (blocker.state === 'blocked') blocker.reset();
  }
  function newWindow() {
    if (intent?.openNew) intent.openNew();
    else window.open(new URL(href, location.href), '_blank', 'noopener,noreferrer');
    cancel();
  }
  async function proceed() {
    setBusy(true);
    setError('');
    try {
      await active.current?.leave();
      active.current = null;
      if (intent) {
        const next = intent;
        setIntent(null);
        await next.action();
      } else if (blocker.state === 'blocked') blocker.proceed();
    } catch (e) {
      setError(t((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Context.Provider value={{ register, request }}>
      {children}
      <dialog
        className="meeting-navigation-dialog"
        ref={dialog}
        aria-labelledby="meeting-navigation-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) cancel();
        }}
      >
        <h2 id="meeting-navigation-title">
          {t('Идёт встреча. Вы хотите перейти на другую страницу?')}
        </h2>
        <p>{t('Можно открыть страницу в новом окне и продолжить звонок здесь.')}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button disabled={busy} onClick={newWindow}>
            {t('Открыть в новом окне')}
          </button>
          <button className="secondary danger" disabled={busy} onClick={() => void proceed()}>
            {busy ? t('Выходим…') : t('Выйти из встречи и перейти в этом окне')}
          </button>
          <button className="secondary" disabled={busy} autoFocus onClick={cancel}>
            {t('Остаться во встрече')}
          </button>
        </div>
      </dialog>
    </Context.Provider>
  );
}
