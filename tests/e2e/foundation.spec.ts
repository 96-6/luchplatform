import { expect, test } from '@playwright/test';

test('saves a real record, keeps it after refresh and disables a pending submission', async ({
  page,
}) => {
  await page.goto('/system');
  await expect(page.getByText('Сервер и база данных готовы.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Записей пока нет' })).toBeVisible();
  await page.getByLabel('Текст записи').fill('Браузер — проверка сохранения');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/dev/records', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Сохранить в базу' }).click();
  await expect(page.getByRole('button', { name: 'Сохраняем…' })).toBeDisabled();
  release();
  await expect(page.locator('.record-list')).toContainText('Браузер — проверка сохранения');
  await page.reload();
  await expect(page.locator('.record-list')).toContainText('Браузер — проверка сохранения');
});

test('shows the loading state until the API responds', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/system', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Подключаемся к платформе…')).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: /Больше уверенности/ })).toBeVisible();
});

test('shows an API error and recovers with retry', async ({ page }) => {
  await page.route('**/api/v1/system', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Тестовый сбой соединения',
          requestId: 'test-request',
        },
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Тестовый сбой соединения');
  await page.unroute('**/api/v1/system');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Больше уверенности/ })).toBeVisible();
});

test('rejects an invalid server response and allows recovery', async ({ page }) => {
  await page.route('**/api/v1/system', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{},"requestId":"test"}' }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Получен неполный ответ сервера');
});

test('opens all sections and preserves a nested URL after refresh', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Больше уверенности/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/home.png', fullPage: true });
  for (const [path, title] of [
    ['/login', 'Вход в аккаунт'],
    ['/register', 'Создать аккаунт'],
    ['/demo-mail', 'Демо-почта'],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  expect(failures).toEqual([]);
});

test('offers usable mobile navigation without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть меню' }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Регистрация' }).click();
  await expect(page.getByRole('heading', { name: 'Создать аккаунт', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть меню' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
