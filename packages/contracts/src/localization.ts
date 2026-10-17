import { english } from './locales/en.js';

export const locales = [
  { code: 'ru', label: 'Русский', dateLocale: 'ru-RU' },
  { code: 'en', label: 'English', dateLocale: 'en-GB' },
] as const;
export type Locale = (typeof locales)[number]['code'];
export const localeCatalogs: Record<Locale, Readonly<Record<string, string>>> = {
  ru: {},
  en: english,
};
export function resolveLocale(cookie = '', acceptLanguage = ''): Locale {
  const preference = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('luch_locale='))
    ?.slice(12);
  if (locales.some((item) => item.code === preference)) return preference as Locale;
  const languages = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', quality] = part.trim().split(';');
      const q = quality?.trim().startsWith('q=') ? Number(quality.trim().slice(2)) : 1;
      return { tag: tag.toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((item) => item.tag && item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const item of languages)
    if (locales.some((locale) => locale.code === item.tag)) return item.tag as Locale;
  return languages.length ? 'en' : 'ru';
}
export function translate(source: string, locale: Locale, values: readonly unknown[] = []): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  const catalog = localeCatalogs[locale];
  const translation = Object.hasOwn(catalog, normalized) ? catalog[normalized] : undefined;
  const result =
    translation === undefined
      ? source
      : (source.match(/^\s*/)?.[0] ?? '') + translation + (source.match(/\s*$/)?.[0] ?? '');
  return result.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : placeholder,
  );
}
export function translateMessage(message: string, locale: Locale): string {
  // Administrative reasons and other user-provided lines stay verbatim.
  const [first = '', ...reason] = message.split('\n');
  let result = translate(first, locale);
  if (locale !== 'ru' && result === first) {
    for (const [source, translated] of Object.entries(localeCatalogs[locale])) {
      if (!/\{\d+\}/.test(source)) continue;
      const indexes: number[] = [];
      const escaped = source
        .split(/(\{\d+\})/)
        .map((part) => {
          if (/^\{\d+\}$/.test(part)) {
            indexes.push(Number(part.slice(1, -1)));
            return '(.*?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      const match = new RegExp('^' + escaped + '$').exec(first);
      if (match) {
        const values: string[] = [];
        indexes.forEach((index, position) => {
          values[index] = match[position + 1]!;
        });
        result = translated.replace(
          /\{(\d+)\}/g,
          (_, index: string) => values[Number(index)] ?? '',
        );
        break;
      }
    }
  }
  return [result, ...reason].join('\n');
}
