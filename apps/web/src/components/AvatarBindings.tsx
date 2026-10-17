import { t } from '../i18n';
import { useEffect, useState } from 'react';
import { avatarBindingsSchema } from '@luch/contracts';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { ErrorState, LoadingState } from './States';
import type { z } from 'zod';

export function AvatarBindings({ changed }: { changed: () => void }) {
  const resource = useResource('/admin/assistant/avatars', avatarBindingsSchema),
    [data, setData] = useState<z.infer<typeof avatarBindingsSchema> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (resource.state.status === 'ready') setData(resource.state.data);
  }, [resource.state]);
  if (!data)
    return resource.state.status === 'error' ? (
      <ErrorState error={resource.state.error} retry={resource.refresh} />
    ) : (
      <LoadingState />
    );
  return (
    <section className="panel">
      <h2>{t('Персонажи и голоса HeyGen')}</h2>
      <p>
        {t(
          'Укажите ID подготовленных аватаров и голосов из своего аккаунта HeyGen. После изменения подтвердите цену подключения заново.',
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void api('/admin/assistant/avatars', avatarBindingsSchema, { body: data })
            .then((result) => {
              setData(result);
              setSaved(true);
              changed();
            })
            .catch((e) => setError(e as Error))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <div className="provider-grid">
            {data.items.map((item, index) => (
              <section key={item.id}>
                <h3>{{ mentor: t('Мира'), partner: t('Алекс'), guide: t('Искра') }[item.id]}</h3>
                {(['avatarId', 'voiceRu', 'voiceEn'] as const).map((field) => (
                  <div key={field}>
                    <label htmlFor={`heygen-${item.id}-${field}`}>
                      {field === 'avatarId'
                        ? t('ID аватара HeyGen')
                        : field === 'voiceRu'
                          ? t('ID голоса для РКИ')
                          : t('ID голоса для английского')}
                    </label>
                    <input
                      id={`heygen-${item.id}-${field}`}
                      value={item[field]}
                      maxLength={100}
                      onChange={(e) => {
                        setSaved(false);
                        setData({
                          ...data,
                          items: data.items.map((x, i) =>
                            i === index ? { ...x, [field]: e.target.value } : x,
                          ),
                        });
                      }}
                    />
                  </div>
                ))}
              </section>
            ))}
          </div>
          <button>{t('Сохранить персонажей HeyGen')}</button>
        </fieldset>
      </form>
      {saved && <p role="status">{t('Персонажи сохранены.')}</p>}
      {error && <ErrorState error={error} retry={resource.refresh} />}
    </section>
  );
}
