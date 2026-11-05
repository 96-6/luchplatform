import { useEffect, useState, type FormEvent } from 'react';
import {
  clientProtectionPolicySchema,
  clientProtectionRoles,
  DEFAULT_CLIENT_PROTECTION_POLICY,
  type ClientProtectionPolicy,
} from '@luch/contracts';
import { t } from '../i18n';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { ErrorState, LoadingState } from '../components/States';

export function ClientProtectionSettings() {
  const { state, refresh } = useResource('/admin/client-protection', clientProtectionPolicySchema);
  const [value, setValue] = useState<ClientProtectionPolicy>(
    structuredClone(DEFAULT_CLIENT_PROTECTION_POLICY),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (state.status === 'ready') setValue(state.data);
  }, [state]);
  function change(patch: Partial<ClientProtectionPolicy>) {
    setValue((old) => ({ ...old, ...patch }));
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api('/admin/client-protection', clientProtectionPolicySchema, {
        body: value,
      });
      setValue(result);
      setSaved(true);
      refresh();
      window.dispatchEvent(new Event('luch:client-check'));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label={t('Защита функций браузера')}>
      <h2>{t('Защита функций браузера')}</h2>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <form onSubmit={(event) => void save(event)}>
          {(['interaction', 'blockers'] as const).map((kind) => {
            const field = kind === 'interaction' ? 'interactionRoles' : 'blockersRoles';
            const enabled = kind === 'interaction' ? 'interactionEnabled' : 'blockersEnabled';
            return (
              <fieldset key={kind} disabled={busy}>
                <legend>
                  {kind === 'interaction'
                    ? t('Ограничение правого клика и F12')
                    : t('Защита от блокировщиков')}
                </legend>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={value[enabled]}
                    onChange={(event) => change({ [enabled]: event.target.checked })}
                  />
                  {kind === 'interaction'
                    ? t('Включить ограничение правого клика и F12')
                    : t('Включить защиту от блокировщиков')}
                </label>
                <p className="muted">
                  {kind === 'interaction'
                    ? t(
                        'Ограничивает контекстное меню в содержимом страниц и сочетания открытия DevTools. Поля ввода, ссылки, кнопки и стандартное управление медиа сохраняются. Сайт не может полностью запретить инструменты разработчика браузера.',
                      )
                    : t(
                        'Проверяет JavaScript, cookies, загрузку проверочного ресурса и признаки рекламной фильтрации. При отказе закрывает страницы и API выбранных ролей с HTTP 403. Не определяет все расширения: полностью контролируемый клиент может подделать веб-проверку.',
                      )}
                </p>
                <p>{t('Применять к ролям:')}</p>
                <div className="browser-policy-list">
                  {clientProtectionRoles.map((role) => (
                    <label key={role} className="checkbox">
                      <input
                        type="checkbox"
                        checked={value[field].includes(role)}
                        onChange={(event) =>
                          change({
                            [field]: event.target.checked
                              ? [...value[field], role]
                              : value[field].filter((item) => item !== role),
                          })
                        }
                      />
                      {role === 'student'
                        ? t('Ученик')
                        : role === 'teacher'
                          ? t('Преподаватель')
                          : t('Администратор')}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
          <p className="muted">
            {t(
              'Обе защиты выключены по умолчанию. Роль определяется сервером после входа. Суперадмин исключён из ограничений для восстановления доступа и управления настройками.',
            )}
          </p>
          <div className="button-row">
            <button disabled={busy}>{t('Сохранить защиту функций браузера')}</button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                change({
                  ...structuredClone(DEFAULT_CLIENT_PROTECTION_POLICY),
                  revision: value.revision,
                })
              }
            >
              {t('Вернуть значения по умолчанию')}
            </button>
          </div>
          {saved && <p role="status">{t('Настройки защиты функций браузера сохранены.')}</p>}
          {error && <ErrorState error={error} retry={refresh} />}
        </form>
      )}
    </section>
  );
}
