import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MEETING_BAN_HOLD_MS } from '@luch/contracts';
import { t } from '../i18n';

export function HoldToConfirm<T>({
  title,
  children,
  prepare,
  confirm,
  cancel,
  valid = true,
}: {
  title: string;
  children: ReactNode;
  prepare: () => Promise<T>;
  confirm: (prepared: T) => Promise<void>;
  cancel: () => void;
  valid?: boolean;
}) {
  const helpId = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    held = useRef(false),
    generation = useRef(0),
    saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'holding' | 'saving'>('idle'),
    [progress, setProgress] = useState(0),
    [error, setError] = useState('');
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    if (ticker.current) clearInterval(ticker.current);
    timer.current = null;
    ticker.current = null;
  }
  function stop() {
    if (saving.current) return;
    held.current = false;
    generation.current++;
    clear();
    setPhase('idle');
    setProgress(0);
  }
  useEffect(() => {
    const node = dialog.current!,
      previous = document.activeElement;
    node.showModal();
    const end = () => stop(),
      visibility = () => {
        if (document.hidden) stop();
      };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      held.current = false;
      generation.current++;
      clear();
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', visibility);
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  async function start() {
    if (!valid || held.current || saving.current) return;
    held.current = true;
    const gen = ++generation.current;
    setError('');
    setPhase('preparing');
    setProgress(0);
    try {
      const prepared = await prepare();
      if (!held.current || gen !== generation.current) return;
      setPhase('holding');
      const started = performance.now();
      ticker.current = setInterval(
        () => setProgress(Math.min(5, (performance.now() - started) / 1000)),
        50,
      );
      timer.current = setTimeout(() => {
        if (!held.current || gen !== generation.current) return;
        clear();
        saving.current = true;
        setPhase('saving');
        setProgress(5);
        void confirm(prepared)
          .catch((e: Error) => {
            setError(t(e.message));
          })
          .finally(() => {
            saving.current = false;
            held.current = false;
            setPhase('idle');
            setProgress(0);
          });
      }, MEETING_BAN_HOLD_MS);
    } catch (e) {
      if (gen === generation.current) {
        stop();
        setError(t((e as Error).message));
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className="hold-confirmation-dialog"
      aria-label={title}
      aria-describedby={helpId}
      onCancel={(e) => {
        e.preventDefault();
        if (!saving.current) {
          stop();
          cancel();
        }
      }}
    >
      <h2>{title}</h2>
      <fieldset disabled={phase !== 'idle'}>{children}</fieldset>
      <p id={helpId}>
        {t(
          'Вы уверены? Для подтверждения удерживайте «Да» пять секунд. Короткое нажатие ничего не меняет.',
        )}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div
        role="progressbar"
        aria-label={t('Подтверждение блокировки')}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-valuenow={Math.floor(progress)}
        className="hold-confirm-progress"
      >
        <span>
          {phase === 'preparing'
            ? t('Подготавливаем подтверждение…')
            : phase === 'holding'
              ? t('Удерживайте ещё {0} с', [String(Math.ceil(5 - progress))])
              : phase === 'saving'
                ? t('Сохраняем…')
                : t('Удерживайте «Да» 5 секунд')}
        </span>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          autoFocus
          disabled={phase === 'saving'}
          onClick={() => {
            stop();
            cancel();
          }}
        >
          {t('Нет')}
        </button>
        <button
          type="button"
          className="danger hold-confirm-yes"
          disabled={!valid || phase === 'saving'}
          aria-label={t('Да, удерживать 5 секунд')}
          onClick={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button === 0) {
              e.preventDefault();
              e.currentTarget.focus();
              void start();
            }
          }}
          onPointerLeave={stop}
          onPointerMove={(e) => {
            const bounds = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < bounds.left ||
              e.clientX > bounds.right ||
              e.clientY < bounds.top ||
              e.clientY > bounds.bottom
            )
              stop();
          }}
          onPointerCancel={stop}
          onPointerUp={stop}
          onBlur={stop}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              if (!e.repeat) void start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              stop();
            }
          }}
        >
          {t('Да')}
        </button>
      </div>
    </dialog>
  );
}
