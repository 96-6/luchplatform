import { test, expect } from '@playwright/test';
import { login } from './meetings.helpers';
test('superadmin checks the persisted release, sees a red dot and cannot apply without a managed agent', async ({
  page,
}) => {
  await login(page, 'audit-updates-superadmin', 0, /\/admin$/);
  await page.getByRole('tab', { name: 'Обновления', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить обновления', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Доступно обновление' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновить систему', exact: true })).toBeDisabled();
  await expect(page.getByText(/Агент обновления недоступен/)).toBeVisible();
  const data = (await (await page.request.get('/api/v1/admin/updates')).json()).data;
  expect(data.updateAvailable).toBe(true);
  expect(data.latest.commit).toBe('2'.repeat(40));
  expect(Date.parse(data.nextCheckAt) - Date.parse(data.checkedAt)).toBe(21600000);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Доступно обновление' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('server diagnostics retain the last reading on connection loss and are linked for superadmin', async ({
  page,
}) => {
  await login(page, 'audit-status-superadmin', 0, /\/admin$/);
  await page.getByRole('tab', { name: 'Система', exact: true }).click();
  await expect(page.getByText('Соединение установлено', { exact: false })).toBeVisible();
  await expect(page.getByText('027_platform_updates.sql', { exact: false })).toBeVisible();
  await page.route('**/api/v1/admin/system-status', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Актуальное состояние неизвестно');
  await expect(page.getByText('Нет свежих данных', { exact: false })).toBeVisible();
  await page.unroute('**/api/v1/admin/system-status');
  await page.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('link', { name: 'Проверка системы', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Состояние сервера', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/superadmin-server-status.png', fullPage: true });
});
test('ordinary users cannot view update or server diagnostics APIs', async ({ page }) => {
  await login(page, 'audit-updates-student');
  for (const path of ['/admin/updates', '/admin/system-status'])
    expect((await page.request.get('/api/v1' + path)).status()).toBe(403);
  await expect(page.getByRole('tab', { name: 'Обновления', exact: true })).toHaveCount(0);
});
