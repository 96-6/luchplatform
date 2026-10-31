import { locales } from '@luch/contracts';
import { locale, changeLocale, openLocaleWindow, t } from './index';
import { useMeetingNavigation } from '../pages/meetings/MeetingNavigation';
export function LanguageSelector() {
  const navigation = useMeetingNavigation();
  return (
    <label className="language-selector">
      <span>{t('Язык интерфейса')}</span>
      <select
        aria-label={t('Язык интерфейса')}
        value={locale}
        onChange={(event) => {
          const value = event.target.value;
          navigation.request({
            href: location.href,
            action: () => changeLocale(value),
            openNew: () => openLocaleWindow(value),
          });
        }}
      >
        {locales.map((item) => (
          <option key={item.code} value={item.code} lang={item.code}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
