import { expect, test } from '@playwright/test';
import { csrf, keys, login, root } from './meetings.helpers';

const yandex =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 YaBrowser/26.10.0.0 Yowser/2.5';
const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0';

test('superadmin configures both browser modes, preserves lists and restores defaults on an English mobile screen', async ({
  page,
}) => {
  test.setTimeout(60000);
  const k = await keys();
  await root(page);
  try {
    await page.goto('/admin?tab=security');
    const panel = page.getByRole('region', { name: 'Безопасность браузеров', exact: true });
    await expect(
      panel.getByRole('checkbox', { name: 'Защита от устаревших браузеров', exact: true }),
    ).toBeChecked();
    await expect(
      panel.getByRole('checkbox', { name: 'Усиленная защита', exact: true }),
    ).not.toBeChecked();
    await panel.getByText('Список запрещённых браузеров', { exact: true }).click();
    await expect(
      panel.getByRole('checkbox', { name: 'Запрещать: Internet Explorer', exact: true }),
    ).toBeChecked();
    await expect(
      panel.getByRole('checkbox', { name: 'Запрещать: Yandex Browser', exact: true }),
    ).not.toBeChecked();
    await panel.getByRole('checkbox', { name: 'Запрещать: DuckDuckGo', exact: true }).check();
    await panel.getByText('Список разрешённых браузеров', { exact: true }).click();
    for (const name of ['Google Chrome', 'Chromium', 'Opera / Opera GX', 'Vanadium'])
      await expect(
        panel.getByRole('checkbox', { name: `Разрешать: ${name}`, exact: true }),
      ).toBeChecked();
    await expect(
      panel.getByRole('checkbox', { name: 'Разрешать: Yandex Browser', exact: true }),
    ).toHaveCount(0);
    await panel.getByRole('checkbox', { name: 'Усиленная защита', exact: true }).check();
    await panel.getByLabel('Chromium', { exact: true }).fill('155');
    await page.route('**/api/v1/security/browser/bootstrap*', (route) => route.abort('failed'));
    await page.evaluate(() => window.dispatchEvent(new Event('luch:browser-check')));
    const retry = page.getByTestId('browser-check-error');
    await expect(retry).toBeVisible();
    await expect(
      panel.getByRole('checkbox', { name: 'Усиленная защита', exact: true }),
    ).toBeChecked();
    await expect(panel.getByLabel('Chromium', { exact: true })).toHaveValue('155');
    await page.unroute('**/api/v1/security/browser/bootstrap*');
    await retry.getByRole('button', { name: 'Повторить проверку браузера', exact: true }).click();
    await expect(retry).toHaveCount(0);
    await expect(panel.getByLabel('Chromium', { exact: true })).toHaveValue('155');
    await panel.getByRole('button', { name: 'Сохранить защиту браузеров', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Настройки защиты браузеров сохранены.');
    await page.reload();
    await expect(
      panel.getByRole('checkbox', { name: 'Усиленная защита', exact: true }),
    ).toBeChecked();
    await expect(panel.getByLabel('Chromium', { exact: true })).toHaveValue('155');
    const denied = await page.request.get('/api/v1/auth/session', {
      headers: { 'user-agent': yandex },
    });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.message).toBe('Ваш браузер несовместим с платформой');
    await panel.getByRole('button', { name: 'Вернуть значения по умолчанию', exact: true }).click();
    await panel.getByRole('button', { name: 'Сохранить защиту браузеров', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Настройки защиты браузеров сохранены.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    await page.getByLabel('Язык интерфейса', { exact: true }).selectOption('en');
    const english = page.getByRole('region', { name: 'Browser security', exact: true });
    await expect(
      english.getByRole('checkbox', { name: 'Outdated browser protection', exact: true }),
    ).toBeChecked();
    await expect(
      english.getByRole('checkbox', { name: 'Enhanced protection', exact: true }),
    ).not.toBeChecked();
    await expect(english).toContainText('this is not browser attestation');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await english.screenshot({ path: 'test-results/browser-security-settings-en-mobile.png' });
  } finally {
    const r = await page.request.post('/__e2e/browser-policy-reset', {
      headers: { 'x-e2e-fixture': k.testIsolationToken },
    });
    expect(r.status()).toBe(204);
  }
});

test('Yandex signals allow first sign-in with a persistent notice, then strict mode blocks the same browser and its APIs', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const k = await keys(),
    context = await browser.newContext({
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
      userAgent: yandex,
    }),
    adminContext = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  const page = await context.newPage(),
    admin = await adminContext.newPage();
  try {
    await login(page, 'browser-yandex-student');
    const banner = page.locator('.browser-warning');
    await expect(banner).toContainText('Ваш браузер может быть несовместим с платформой');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: 'test-results/browser-yandex-first-sign-in-mobile.png',
      fullPage: true,
    });
    await banner.getByRole('button', { name: 'Понятно', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Кабинет ученика', exact: true })).toBeVisible();
    await expect(banner).toHaveCount(0);
    expect(
      (await (await page.request.get('/api/v1/security/browser/notice')).json()).data.show,
    ).toBe(false);
    await root(admin);
    const p = (await (await admin.request.get('/api/v1/admin/browser-policy')).json()).data;
    const saved = await admin.request.post('/api/v1/admin/browser-policy', {
      headers: await csrf(admin),
      data: { ...p, enhancedEnabled: true },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const deniedApi = await page.request.get('/api/v1/auth/session');
    expect(deniedApi.status()).toBe(403);
    expect((await deniedApi.json()).error.message).toBe('Ваш браузер несовместим с платформой');
    const deniedPage = await page.goto('/student');
    expect(deniedPage?.status()).toBe(403);
    await expect(
      page.getByText('Ваш браузер несовместим с платформой', { exact: true }),
    ).toBeVisible();
  } finally {
    await admin.request.post('/__e2e/browser-policy-reset', {
      headers: { 'x-e2e-fixture': k.testIsolationToken },
    });
    await context.close();
    await adminContext.close();
  }
});

for (const changed of ['page', 'headers', 'both'] as const)
  test(`detects User-Agent spoofing in ${changed} while the independent worker retains its real identity`, async ({
    page,
  }) => {
    if (changed !== 'headers')
      await page.addInitScript(
        ({ ua, maskHints }) => {
          Object.defineProperty(Navigator.prototype, 'userAgent', {
            configurable: true,
            get: () => ua,
          });
          if (maskHints)
            Object.defineProperty(Navigator.prototype, 'userAgentData', {
              configurable: true,
              get: () => undefined,
            });
        },
        { ua: firefox, maskHints: changed === 'both' },
      );
    if (changed !== 'page')
      await page.route('**/*', async (route) => {
        const headers = { ...route.request().headers(), 'user-agent': firefox };
        for (const key of Object.keys(headers))
          if (key.startsWith('sec-ch-ua')) delete headers[key];
        await route.continue({ headers });
      });
    await page.goto('/login');
    await expect(
      page.getByText(
        'Данные браузера противоречат друг другу. Отключите подмену User-Agent и повторите проверку.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    const status = await page.evaluate(async () => (await fetch('/api/v1/system')).status);
    expect([403, 428]).toContain(status);
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0);
  });
