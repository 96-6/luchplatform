import { useEffect, useState, type FormEvent } from 'react';
import {
  browserPolicySchema,
  browserIds,
  browserNames,
  DEFAULT_BROWSER_POLICY,
  type BrowserPolicy,
} from '@luch/contracts';
import { t } from '../i18n';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { LoadingState, ErrorState } from '../components/States';
import { useBrowserSecurity } from '../auth/BrowserGate';

export function BrowserSecuritySettings() {
  const { state, refresh } = useResource('/admin/browser-policy', browserPolicySchema);
  const { recheck } = useBrowserSecurity();
  const [value, setValue] = useState<BrowserPolicy>(structuredClone(DEFAULT_BROWSER_POLICY)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (state.status === 'ready') setValue(state.data);
  }, [state]);
  function change(patch: Partial<BrowserPolicy>) {
    setValue((old) => ({ ...old, ...patch }));
    setSaved(false);
  }
  function toggle(
    field: 'blockedBrowsers' | 'allowedBrowsers',
    id: (typeof browserIds)[number],
    checked: boolean,
  ) {
    change({ [field]: checked ? [...value[field], id] : value[field].filter((v) => v !== id) });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await recheck(true);
      await api('/admin/browser-policy', browserPolicySchema, {
        body: { ...value, revision: state.data.revision },
      });
      setSaved(true);
      refresh();
      await recheck();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t('Безопасность браузеров')}>
      <h2>{t('Безопасность браузеров')}</h2>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value.outdatedEnabled}
                onChange={(e) => change({ outdatedEnabled: e.target.checked })}
              />
              {t('Защита от устаревших браузеров')}
            </label>
            <p className="muted">
              {t(
                'Включена по умолчанию. Запрещает выбранные браузеры и версии ниже заданного минимума. Актуальный Яндекс Браузер допускается с предупреждением при первом входе.',
              )}
            </p>
            <details>
              <summary>{t('Список запрещённых браузеров')}</summary>
              <div className="browser-policy-list">
                {browserIds.map((id) => (
                  <label key={id} className="checkbox">
                    <input
                      type="checkbox"
                      aria-label={t('Запрещать: {0}', [browserNames[id]])}
                      checked={value.blockedBrowsers.includes(id)}
                      onChange={(e) => toggle('blockedBrowsers', id, e.target.checked)}
                    />
                    {browserNames[id]}
                  </label>
                ))}
              </div>
            </details>
          </fieldset>
          <fieldset disabled={busy}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value.enhancedEnabled}
                onChange={(e) => change({ enhancedEnabled: e.target.checked })}
              />
              {t('Усиленная защита')}
            </label>
            <p className="muted">
              {t(
                'Выключена по умолчанию. Разрешает только выбранные браузеры. Яндекс Браузер всегда запрещён, в том числе для администраторов. При включении обоих режимов действуют более строгие ограничения.',
              )}
            </p>
            <details>
              <summary>{t('Список разрешённых браузеров')}</summary>
              <div className="browser-policy-list">
                {browserIds
                  .filter((id) => !['yandex', 'unknown'].includes(id))
                  .map((id) => (
                    <label key={id} className="checkbox">
                      <input
                        type="checkbox"
                        aria-label={t('Разрешать: {0}', [browserNames[id]])}
                        checked={value.allowedBrowsers.includes(id)}
                        onChange={(e) => toggle('allowedBrowsers', id, e.target.checked)}
                      />
                      {browserNames[id]}
                    </label>
                  ))}
              </div>
            </details>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>{t('Минимальные версии движков')}</legend>
            <p className="muted">
              {t(
                'Основной номер версии, без номера сборки. Эти минимумы действуют в обоих режимах. Порог совместимости не заменяет установку обновлений безопасности.',
              )}
            </p>
            <div className="form-grid">
              {(['chromium', 'firefox', 'webkit'] as const).map((engine) => (
                <label key={engine}>
                  {engine === 'webkit'
                    ? 'Safari / iOS'
                    : engine === 'firefox'
                      ? 'Firefox / ESR'
                      : 'Chromium'}
                  <input
                    type="number"
                    min={1}
                    max={999}
                    required
                    value={value.minimumVersions[engine]}
                    onChange={(e) =>
                      change({
                        minimumVersions: {
                          ...value.minimumVersions,
                          [engine]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <p className="warning">
            {t(
              'Сверяются HTTP-заголовки, Client Hints, страница, Web Worker и необходимые возможности браузера. Несогласованная подмена блокируется. Расширение с полным контролем всех признаков может обойти веб-проверку: это не аттестация браузера. Chromium-браузеры, включая Vanadium, могут представляться как Chrome и не всегда различимы.',
            )}
          </p>
          <div className="button-row">
            <button disabled={busy}>{t('Сохранить защиту браузеров')}</button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                change({ ...structuredClone(DEFAULT_BROWSER_POLICY), revision: value.revision })
              }
            >
              {t('Вернуть значения по умолчанию')}
            </button>
          </div>
          {saved && <p role="status">{t('Настройки защиты браузеров сохранены.')}</p>}
          {error && (
            <ErrorState
              error={error}
              retry={() => {
                setError(null);
                refresh();
              }}
            />
          )}
        </form>
      )}
    </section>
  );
}
