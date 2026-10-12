import { useEffect, useState } from 'react';
import { captchaSchema } from '@luch/contracts';
import type { z } from 'zod';
import { api } from '../lib/api';
import { useSecurity } from './SecurityGate';

export function useCaptcha(purpose: 'login' | 'register' | 'enrollment') {
  const { policy } = useSecurity();
  const [image, setImage] = useState<z.infer<typeof captchaSchema> | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setImage(null);
    setAnswer('');
    setError(null);
    if (policy.captchaEnabled)
      void api(`/auth/captcha?purpose=${purpose}`, captchaSchema, {
        signal: controller.signal,
      }).then(
        (value) => {
          if (!controller.signal.aborted) setImage(value);
        },
        (failure: Error) => {
          if (!controller.signal.aborted) setError(failure);
        },
      );
    return () => controller.abort();
  }, [purpose, revision, policy.captchaEnabled]);
  return {
    enabled: policy.captchaEnabled,
    image,
    answer,
    setAnswer,
    error,
    refresh,
    submission: () => {
      if (!policy.captchaEnabled) return undefined;
      if (!image || !answer.trim()) throw new Error('Введите символы с картинки.');
      return { id: image.id, answer: answer.trim() };
    },
  };
}
export function CaptchaField({ captcha }: { captcha: ReturnType<typeof useCaptcha> }) {
  if (!captcha.enabled) return null;
  return (
    <div className="captcha-field">
      <label htmlFor="captcha-answer">Символы с картинки</label>
      <div className="captcha-image">
        {captcha.image ? (
          <img
            src={captcha.image.imageDataUrl}
            alt="Капча: пять символов"
            width={240}
            height={82}
          />
        ) : (
          <p role="status">Загружаем капчу…</p>
        )}
        <button type="button" className="secondary" onClick={captcha.refresh}>
          Новая картинка
        </button>
      </div>
      {captcha.error && <p role="alert">{captcha.error.message}</p>}
      <input
        id="captcha-answer"
        value={captcha.answer}
        onChange={(event) => captcha.setAnswer(event.target.value)}
        autoComplete="off"
        maxLength={5}
        required
      />
    </div>
  );
}
