import { useEffect, useState, type FormEvent } from 'react';
import { meetingRecordingPolicySchema } from '@luch/contracts';
import { t } from '../../i18n';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';
import { ErrorState, LoadingState } from '../../components/States';

export function MeetingRecordingSettings() {
  const { state, refresh } = useResource(
    '/admin/meeting-recording-policy',
    meetingRecordingPolicySchema,
  );
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (state.status === 'ready') setEnabled(state.data.enabled);
  }, [state]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/meeting-recording-policy', meetingRecordingPolicySchema, {
        body: { enabled, revision: state.data.revision },
      });
      setSaved(true);
      refresh();
    } catch (failure) {
      setError(failure as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t('Защита видеовстреч')}>
      <h2>{t('Защита видеовстреч')}</h2>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={enabled}
                aria-describedby="meeting-recording-help"
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setSaved(false);
                }}
              />
              {t('Защита от записи видеозвонка')}
            </label>
            <p id="meeting-recording-help" className="muted">
              {t(
                'Добавляет персональные водяные знаки на видео и демонстрации экрана, ограничивает меню видео, картинку в картинке и печать. Применяется ко всем участникам, включая гостей, и к текущим звонкам после обновления состояния.',
              )}
            </p>
            <p className="warning">
              {t(
                'Это меры сдерживания, а не DRM. В браузере нельзя гарантированно запретить OBS, системную запись экрана, скриншоты или съёмку другим устройством на компьютере и телефоне.',
              )}
            </p>
            <button>{t('Сохранить защиту видеовстреч')}</button>
          </fieldset>
          {saved && <p role="status">{t('Настройки защиты видеовстреч сохранены.')}</p>}
          {error && <ErrorState error={error} retry={refresh} />}
        </form>
      )}
    </section>
  );
}
