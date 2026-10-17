import { locales } from '@luch/contracts';
import { locale, changeLocale, t } from './index';
export function LanguageSelector() {
  return (
    <label className="language-selector">
      <span>{t('Язык интерфейса')}</span>
      <select
        aria-label={t('Язык интерфейса')}
        value={locale}
        onChange={(event) => changeLocale(event.target.value)}
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
