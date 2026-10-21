import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

// Synthetic credentials for isolated browser fixtures only.
export const testPassword = 'Browser fixture password 2026!';
export function otp(email: string, secret: string, offset = 0) {
  return new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: Date.now() + offset });
}
export async function passwordUI(page: Page, email: string, password = testPassword) {
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  if (await page.getByLabel('Символы с картинки').count()) {
    await expect(page.getByAltText('Капча: пять символов')).toBeVisible();
    await page.getByLabel('Символы с картинки').fill('ABCDE');
  }
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  return response;
}
export async function secondFactorUI(page: Page, email: string, secret: string, offset = 0) {
  await page.getByLabel('Код Authenticator').fill(otp(email, secret, offset));
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/auth/login/confirm') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Подтвердить вход', exact: true }).click();
  const verified = await response;
  expect(verified.status(), await verified.text()).toBe(200);
  return verified;
}
export async function signInUI(
  page: Page,
  email: string,
  secret: string,
  offset = 0,
  password = testPassword,
) {
  await page.goto('/login');
  const response = await passwordUI(page, email, password);
  expect(response.status(), await response.text()).toBe(200);
  const verified = await secondFactorUI(page, email, secret, offset);
  await expect(page).toHaveURL((await verified.json()).data.dashboardPath);
}
export async function newPasswordUI(page: Page, prefix: string, password = testPassword) {
  await page.locator(`#${prefix}-password`).fill(password);
  await page.locator(`#${prefix}-confirmation`).fill(password);
}
export async function apiPasswordLogin(
  page: Page,
  options: { data: { email: string; code: string; captcha?: unknown; password?: string } },
) {
  const { code, ...data } = options.data;
  const first = await page.request.post('/api/v1/auth/login', {
    data: { ...data, password: data.password ?? testPassword },
  });
  if (!first.ok() || (await first.json()).data.step !== 'totp') return first;
  return page.request.post('/api/v1/auth/login/confirm', {
    data: { code },
    headers: { 'x-login-csrf': (await first.json()).data.csrfToken },
  });
}
export async function enrollAPI(page: Page, email: string, role = 'student', register = true) {
  const captcha = async (purpose: string) => ({
    id: (await (await page.request.get(`/api/v1/auth/captcha?purpose=${purpose}`)).json()).data.id,
    answer: 'ABCDE',
  });
  if (register) {
    const registered = await page.request.post('/api/v1/auth/register', {
      data: {
        email,
        name: 'Браузерный аккаунт',
        role,
        password: testPassword,
        captcha: await captcha('register'),
      },
    });
    expect(registered.status(), await registered.text()).toBe(202);
  }
  const link = new URL(
    (await (await page.request.get(`/api/v1/dev/mail?email=${encodeURIComponent(email)}`)).json())
      .data[0].verificationUrl,
  );
  const verified = await page.request.post(
    link.pathname === '/set-password' ? '/api/v1/auth/password/reset' : '/api/v1/auth/verify-email',
    {
      data: {
        token: link.searchParams.get('token'),
        ...(link.pathname === '/set-password' ? { password: testPassword } : {}),
      },
    },
  );
  expect(verified.status(), await verified.text()).toBe(200);
  const primary = await page.request.post('/api/v1/auth/login', {
    data: { email, password: testPassword, captcha: await captcha('login') },
  });
  expect(primary.status(), await primary.text()).toBe(200);
  expect((await primary.json()).data.step).toBe('enrollment');
  const key = (await (await page.request.get('/api/v1/auth/enrollment')).json()).data
    .manualKey as string;
  const completed = await page.request.post('/api/v1/auth/enrollment/confirm', {
    data: { code: otp(email, key), captcha: await captcha('enrollment') },
  });
  expect(completed.status(), await completed.text()).toBe(200);
  return key;
}
