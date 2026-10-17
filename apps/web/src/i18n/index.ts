import { locales, resolveLocale, translate, translateMessage, type Locale } from '@luch/contracts';
export const locale: Locale = resolveLocale(document.cookie, navigator.languages.join(','));
export const t = (source: string | null | undefined, values: readonly unknown[] = []) => {
  const text = source ?? '';
  const result = translate(text, locale, values);
  return locale !== 'ru' && result === text && /[А-Яа-яЁё]/.test(text)
    ? translateMessage(text, locale)
    : result;
};
export const errorText = (source: string) => translateMessage(source, locale);
export const dateLocale = locales.find((item) => item.code === locale)!.dateLocale;
document.documentElement.lang = locale;
document.title = locale === 'en' ? 'LUCH' : 'ЛУЧ';
export function changeLocale(value: string) {
  if (!locales.some((item) => item.code === value)) return;
  document.cookie = `luch_locale=${value}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  // Reload also updates module-level labels and server-rendered access pages.
  location.reload();
}
