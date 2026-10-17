import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { assistantSpeechSchema } from '@luch/contracts';
import { api, ApiError } from '../lib/api';
const statusSchema = z.object({ url: z.string().nullable() });
export function AssistantReplyAudio({
  messageId,
  editable,
  auto = false,
}: {
  messageId: string;
  editable: boolean;
  auto?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef<string | null>(null),
    mounted = useRef(true),
    audio = useRef<HTMLAudioElement>(null);
  const base = `/assistant/messages/${messageId}/audio`;
  async function prepare() {
    setBusy(true);
    setError('');
    operation.current ??= crypto.randomUUID();
    try {
      const result = await api(base, assistantSpeechSchema, {
        body: { operationId: operation.current },
      });
      operation.current = null;
      if (mounted.current) setUrl(result.url);
    } catch (e) {
      if (mounted.current) {
        setError(t((e as Error).message));
        if (e instanceof ApiError && e.code !== 'PROVIDER_IN_PROGRESS') operation.current = null;
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api(base, statusSchema, { signal: controller.signal })
      .then((s) => {
        if (controller.signal.aborted) return;
        if (s.url) setUrl(s.url);
        else if (auto && editable) void prepare();
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(t((e as Error).message));
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [base]);
  useEffect(() => {
    if (url && auto) void audio.current?.play().catch(() => {});
  }, [url, auto]);
  return (
    <div className="assistant-audio">
      {url ? (
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={url}
          aria-label={t('Голосовой ответ помощника')}
          onError={() =>
            setError(
              t(
                'Не удалось воспроизвести аудио. Повторите воспроизведение; текст ответа сохранён.',
              ),
            )
          }
        />
      ) : (
        editable && (
          <button className="secondary" disabled={busy} onClick={() => void prepare()}>
            {busy ? t('Готовим голосовой ответ…') : t('Прослушать ответ помощника')}
          </button>
        )
      )}
      {busy && <p role="status">{t('Озвучиваем ответ через ElevenLabs…')}</p>}
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (url) {
                audio.current?.load();
                void audio.current?.play().catch(() => {});
                setError('');
              } else void prepare();
            }}
          >
            {t('Повторить озвучивание')}
          </button>
        </div>
      )}
      {url && (
        <p className="muted">
          {t('Если звук не начался автоматически, нажмите воспроизведение. Текст доступен в чате.')}
        </p>
      )}
    </div>
  );
}
