import { describe, expect, it } from 'vitest';
import { resolveLocale, translate, translateMessage, pageErrorDocument } from '@luch/contracts';

describe('interface localization', () => {
  it('uses a saved choice before browser preferences, including regional and unsupported languages', () => {
    expect(resolveLocale('', 'en-US,en;q=0.9,ru;q=0.5')).toBe('en');
    expect(resolveLocale('', 'ru-RU,ru;q=0.9,en;q=0.7')).toBe('ru');
    expect(resolveLocale('other=x; luch_locale=ru', 'en-US')).toBe('ru');
    expect(resolveLocale('luch_locale=en', 'ru-RU')).toBe('en');
    expect(resolveLocale('luch_locale=invalid', 'de-DE')).toBe('en');
    expect(resolveLocale('', 'ru;q=0,en;q=0.8')).toBe('en');
    expect(resolveLocale('', '')).toBe('ru');
  });
  it('keeps interpolation values, administrative reasons and unknown content verbatim', () => {
    expect(translate('  Продолжить  ', 'en')).toBe('  Continue  ');
    expect(translate('{0}/{1} заданий завершено', 'en', [2, 7])).toBe('2/7 exercises completed');
    expect(translateMessage('Введите ответ длиной до 42 символов.', 'en')).toBe(
      'Enter an answer of up to 42 characters.',
    );
    expect(
      translateMessage('Ваша учетная запись заблокирована\nПричина администратора <test>', 'en'),
    ).toBe('Your account has been blocked\nПричина администратора <test>');
    expect(translate('Ответ пользователя на русском', 'en')).toBe('Ответ пользователя на русском');
  });
  it('renders escaped localized HTTP errors with standalone styling and recovery links', () => {
    const html = pageErrorDocument(403, '<img src=x onerror=alert(1)>', '<script>x</script>', 'en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Access denied');
    expect(html).toContain('<style>');
    expect(html).toContain('class="card"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
  });
});
