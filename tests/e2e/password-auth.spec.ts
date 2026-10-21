import { expect, test } from '@playwright/test';
import {
  newPasswordUI,
  otp,
  passwordUI,
  secondFactorUI,
  signInUI,
  testPassword,
} from './password.helpers';
import { root } from './meetings.helpers';

test('registration, password-first enrollment, separate 2FA and email recovery work through the interface', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const email = `password-ui-${crypto.randomUUID()}@example.test`,
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/register');
  await page.getByLabel('Имя', { exact: true }).fill('Новая авторизация');
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await newPasswordUI(page, 'register');
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Отправить письмо подтверждения', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'письмо подтверждения отправлено' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Посмотреть письмо в демо-почте', exact: true }).click();
  await page.getByRole('link', { name: 'Открыть последнее письмо', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в аккаунт', exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/auth/enrollment')).status()).toBe(401);
  expect((await passwordUI(page, email)).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Подключить Authenticator', exact: true }),
  ).toBeVisible();
  const key = (await page.getByTestId('manual-key').textContent())!.trim();
  await page.getByLabel('Код Authenticator').fill(otp(email, key));
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Подключить и войти', exact: true }).click();
  await expect(page).toHaveURL(/\/student$/);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await passwordUI(page, email)).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Подтверждение входа', exact: true }),
  ).toBeVisible();
  expect((await (await page.request.get('/api/v1/auth/session')).json()).data.user).toBeNull();
  expect((await page.request.get('/api/v1/learning/profile')).status()).toBe(401);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Подтверждение входа', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/auth-second-factor.png', fullPage: true });
  await secondFactorUI(page, email, key, 30000);
  await expect(page).toHaveURL(/\/student$/);
  const recoveryContext = await browser.newContext({ locale: 'ru-RU' });
  try {
    const recovery = await recoveryContext.newPage();
    await recovery.goto('/forgot-password');
    await recovery.getByLabel('Почта', { exact: true }).fill(email);
    await recovery.getByLabel('Символы с картинки').fill('ABCDE');
    await recovery.getByRole('button', { name: 'Отправить ссылку', exact: true }).click();
    await expect(recovery.getByRole('status')).toContainText(
      'письмо для установки нового пароля отправлено',
    );
    await recovery
      .getByRole('link', { name: 'Посмотреть письмо в демо-почте', exact: true })
      .click();
    await recovery.getByRole('link', { name: 'Открыть последнее письмо', exact: true }).click();
    const replacement = 'Changed browser passphrase 2026!';
    await newPasswordUI(recovery, 'reset', replacement);
    await recovery.getByRole('button', { name: 'Сохранить пароль', exact: true }).click();
    await expect(recovery).toHaveURL(/\/login$/);
    await expect(recovery.getByRole('status')).toContainText('Пароль сохранён');
    expect((await page.reload())?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Требуется вход', exact: true })).toBeVisible();
    expect((await passwordUI(recovery, email, testPassword)).status()).toBe(401);
    expect((await passwordUI(recovery, email, replacement)).status()).toBe(200);
    await expect(
      recovery.getByRole('heading', { name: 'Подтверждение входа', exact: true }),
    ).toBeVisible();
    expect(
      (await (await recovery.request.get('/api/v1/auth/session')).json()).data.user,
    ).toBeNull();
  } finally {
    await recoveryContext.close();
  }
  expect(errors).toEqual([]);
});

test('superadmin password reset is available in the account card and English forms fit a mobile screen', async ({
  page,
  browser,
}) => {
  await root(page);
  const email = `reset-ui-${crypto.randomUUID()}@example.test`;
  await page.getByLabel('Почта нового пользователя').fill(email);
  await page.getByLabel('Имя нового пользователя').fill('Сброс пароля');
  await newPasswordUI(page, 'admin-new');
  await page.getByRole('button', { name: 'Создать и показать QR-код', exact: true }).click();
  await expect(page.getByAltText('QR-код Authenticator пользователя')).toBeVisible();
  const key = (await page.getByTestId('admin-manual-key').textContent())!.trim();
  const context = await browser.newContext({ locale: 'ru-RU' });
  try {
    const student = await context.newPage();
    await signInUI(student, email, key);
    await expect(student).toHaveURL(/\/student$/);
    const replacement = 'Reset through admin form 2026!';
    await newPasswordUI(page, 'admin-reset', replacement);
    await page
      .getByRole('button', { name: 'Задать новый пароль пользователю', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Новый пароль установлен' }),
    ).toBeVisible();
    expect((await student.reload())?.status()).toBe(401);
    await student.goto('/login');
    expect((await passwordUI(student, email, replacement)).status()).toBe(200);
    await expect(
      student.getByRole('heading', { name: 'Подтверждение входа', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
  const english = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 390, height: 844 },
  });
  try {
    const mobile = await english.newPage();
    await mobile.goto('/register');
    await expect(mobile.getByLabel('New password', { exact: true })).toBeVisible();
    await expect(mobile.getByLabel('Confirm new password', { exact: true })).toBeVisible();
    await expect(mobile.getByText('Use 12 to 128 characters.', { exact: false })).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await mobile.screenshot({ path: 'test-results/auth-register-en-mobile.png', fullPage: true });
    await mobile.goto('/forgot-password');
    await expect(
      mobile.getByRole('heading', { name: 'Set or recover your password', exact: true }),
    ).toBeVisible();
    await expect(mobile.getByRole('button', { name: 'Send link', exact: true })).toBeVisible();
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await mobile.screenshot({ path: 'test-results/auth-recovery-en-mobile.png', fullPage: true });
  } finally {
    await english.close();
  }
});
