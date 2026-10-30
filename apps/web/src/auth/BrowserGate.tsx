import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { browserNoticeSchema, type browserAssessmentSchema } from '@luch/contracts';
import type { z } from 'zod';
import { t } from '../i18n';
import { api } from '../lib/api';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';
import { checkBrowser } from './browser';
type Assessment = z.infer<typeof browserAssessmentSchema>;
const BrowserContext = createContext<{
  assessment: Assessment;
  recheck: (force?: boolean) => Promise<Assessment>;
} | null>(null);
export function useBrowserSecurity() {
  const value = useContext(BrowserContext);
  if (!value) throw Error('Browser security context unavailable');
  return value;
}
export function BrowserGate({ children }: { children: ReactNode }) {
  const [assessment, setAssessment] = useState<Assessment | null>(null),
    [error, setError] = useState<Error | null>(null);
  const mounted = useRef(false);
  const recheck = useCallback(async (force = false) => {
    try {
      const value = await checkBrowser(force);
      if (mounted.current) {
        setAssessment(value);
        setError(null);
      }
      return value;
    } catch (e) {
      if (mounted.current) setError(e as Error);
      throw e;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      void recheck().catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener('luch:browser-check', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener('luch:browser-check', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [recheck]);
  const failure = error ? (
    <section className="state error" role="alert">
      <h2>{t('Проверка браузера не завершена')}</h2>
      <p>{t(error.message)}</p>
      <button
        onClick={() => {
          void recheck(true).catch(() => {});
        }}
      >
        {t('Повторить проверку браузера')}
      </button>
    </section>
  ) : null;
  if (error && !assessment?.decision.allowed)
    return <main className="access-screen">{failure}</main>;
  if (!assessment)
    return (
      <main className="access-screen">
        <LoadingState text={t('Проверяем совместимость браузера…')} />
      </main>
    );
  if (!assessment.decision.allowed)
    return (
      <main className="access-screen" role="alert">
        <h1>{t(assessment.decision.message!)}</h1>
        <p>
          {t(
            'Используйте обновлённый совместимый браузер. Проверка относится к браузеру и не меняет учебные результаты.',
          )}
        </p>
        <button
          onClick={() => {
            void recheck(true).catch(() => {});
          }}
        >
          {t('Повторить проверку браузера')}
        </button>
      </main>
    );
  return (
    <BrowserContext.Provider value={{ assessment, recheck }}>
      {error && (
        <aside className="browser-warning" data-testid="browser-check-error">
          {failure}
        </aside>
      )}
      {children}
    </BrowserContext.Provider>
  );
}
export function BrowserWarningBanner() {
  const { session, loading } = useAuth(),
    { assessment } = useBrowserSecurity(),
    location = useLocation();
  const [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const userId = session.user?.id,
    guest = location.pathname.startsWith('/guest/meetings/');
  useEffect(() => {
    let active = true;
    setShow(false);
    if (!loading && assessment.decision.warning && (userId || guest))
      void api('/security/browser/notice', browserNoticeSchema)
        .then((value) => {
          if (active) setShow(value.show);
        })
        .catch(() => {
          if (active) setShow(true);
        });
    return () => {
      active = false;
    };
  }, [userId, guest, loading, assessment.decision.warning]);
  if (!show) return null;
  return (
    <aside className="browser-warning" role="alert">
      <strong>{t('Ваш браузер может быть несовместим с платформой')}</strong>
      <p>{t('Если возникают ошибки, откройте платформу в обновлённом совместимом браузере.')}</p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void api('/security/browser/notice', browserNoticeSchema, {
            body: { token: assessment.noticeToken },
          })
            .then(() => setShow(false))
            .catch((e: Error) => setError(t(e.message)))
            .finally(() => setBusy(false));
        }}
      >
        {t('Понятно')}
      </button>
      {error && <p className="error">{error}</p>}
    </aside>
  );
}
