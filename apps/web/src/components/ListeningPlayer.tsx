import { t } from '../i18n';
import { useState } from 'react';
import { listeningResultSchema } from '@luch/contracts';
import { api, ApiError } from '../lib/api';
export function ListeningPlayer({
  runId,
  stepId,
  editable,
  initialUrl,
}: {
  runId: string;
  stepId: string;
  editable: boolean;
  initialUrl: string | null;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [operationId, setOperationId] = useState(() => crypto.randomUUID());
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const result = await api(
        `/engine/runs/${runId}/steps/${stepId}/listening`,
        listeningResultSchema,
        { body: { operationId } },
      );
      setUrl(result.url);
    } catch (e) {
      setError(e as Error);
      if (e instanceof ApiError && e.code === 'SPEECH_UNAVAILABLE')
        setOperationId(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h3>Listening</h3>
      <p>{t('Прослушайте учебную реплику и ответьте на вопрос. Озвучивание — ElevenLabs.')}</p>
      {url ? (
        <audio
          controls
          src={url}
          preload="metadata"
          aria-label={t('Аудиозадание')}
          onError={() =>
            setError(new Error(t('Аудио не удалось загрузить. Повторите подготовку.')))
          }
        />
      ) : editable ? (
        <button type="button" disabled={busy} onClick={() => void prepare()}>
          {busy ? t('Готовим аудио…') : t('Подготовить аудиозадание')}
        </button>
      ) : (
        <p>{t('Аудио подготавливается из кабинета ученика.')}</p>
      )}
      {error && (
        <div className="state error" role="alert">
          <p>{t(error.message)}</p>
          <p>
            {t(
              'Техническая ошибка не создаёт учебную попытку. Можно вернуться в план и выбрать другое готовое назначение.',
            )}
          </p>
          {editable && (
            <button type="button" disabled={busy} onClick={() => void prepare()}>
              {t('Повторить подготовку аудио')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
