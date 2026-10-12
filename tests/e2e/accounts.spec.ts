import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

function code(email: string, key: string, offset = 0) {
  return new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(key),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: Date.now() + offset });
}
async function fillCaptcha(page: Page) {
  const field = page.getByLabel('Символы с картинки');
  if (await field.count()) {
    await expect(page.getByAltText('Капча: пять символов')).toBeVisible();
    await field.fill('ABCDE');
  }
}
async function enroll(page: Page, email: string) {
  await page.goto(`/demo-mail?email=${encodeURIComponent(email)}`);
  await page.getByRole('link', { name: 'Открыть последнее письмо подтверждения' }).click();
  await page.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Подключить Authenticator' })).toBeVisible();
  await expect(page.getByAltText('QR-код подключения Authenticator')).toBeVisible();
  const key = (await page.getByTestId('manual-key').textContent())!;
  await page.getByLabel('Код Authenticator').fill(code(email, key));
  await fillCaptcha(page);
  await page.getByRole('button', { name: 'Подключить и войти' }).click();
  return key;
}
async function session(page: Page) {
  const response = await page.request.get('/api/v1/auth/session');
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function saveSettings(page: Page) {
  const updated = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/admin/security') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/session') && response.status() === 200,
  );
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  await updated;
  await refreshed;
  await expect(page.getByRole('heading', { name: 'Кабинет суперадмина' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить настройки' })).toBeEnabled();
}

test('email, Authenticator, three roles, shared assignments and security settings work together', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const studentContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  const teacherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  const adminContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  const student = await studentContext.newPage();
  const teacher = await teacherContext.newPage();
  const admin = await adminContext.newPage();
  const failures: string[] = [];
  for (const page of [student, teacher, admin])
    page.on('pageerror', (error) => failures.push(error.message));
  try {
    const email = `browser-${Date.now()}@example.test`;
    await student.goto('/register');
    await student.getByLabel('Имя', { exact: true }).fill('Браузерный ученик');
    await student.getByLabel('Почта', { exact: true }).fill(email);
    await fillCaptcha(student);
    await student.getByRole('button', { name: 'Отправить письмо подтверждения' }).click();
    await expect(student.getByRole('status')).toContainText('письмо подтверждения отправлено');
    const studentKey = await enroll(student, email);
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible();
    const studentSession = await session(student);
    await student.reload();
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible();
    await student.screenshot({ path: 'test-results/student.png', fullPage: true });
    await student.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(student.getByRole('heading', { name: 'Вход в аккаунт' })).toBeVisible();
    await student.getByLabel('Почта', { exact: true }).fill(email);
    await student.getByLabel('Код Authenticator').fill(code(email, studentKey, 30000));
    await fillCaptcha(student);
    await student.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible();

    await enroll(teacher, 'teacher@example.test');
    await expect(teacher.getByRole('heading', { name: 'Кабинет преподавателя' })).toBeVisible();
    const teacherSession = await session(teacher);
    expect((await student.request.get(`/api/v1/users/${teacherSession.user.id}`)).status()).toBe(
      404,
    );
    expect((await teacher.request.get(`/api/v1/users/${studentSession.user.id}`)).status()).toBe(
      404,
    );
    await teacher.getByRole('link', { name: 'Открыть карточку →' }).click();
    await expect(teacher.getByRole('heading', { name: 'Карточка ученика' })).toBeVisible();
    await teacher.screenshot({ path: 'test-results/teacher.png', fullPage: true });

    await enroll(admin, 'admin@example.test');
    await expect(admin.getByRole('heading', { name: 'Кабинет суперадмина' })).toBeVisible();
    await admin.getByRole('button', { name: `Открыть ${email}`, exact: true }).click();
    await expect(
      admin.getByRole('heading', { name: 'Карточка аккаунта для отладки' }),
    ).toBeVisible();
    await admin.getByLabel('Проверка доступа подтверждена').check();
    await admin.getByRole('button', { name: 'Сохранить доступ' }).click();
    await expect(admin.getByText('Доступ аккаунта обновлён.')).toBeVisible();
    await admin.getByLabel('Преподаватель', { exact: true }).selectOption(teacherSession.user.id);
    await admin.getByLabel('Ученик', { exact: true }).selectOption(studentSession.user.id);
    await admin.getByRole('button', { name: 'Назначить преподавателя' }).click();
    await expect(admin.getByText('Ученик закреплён за преподавателем.')).toBeVisible();
    await teacher.goto('/teacher');
    await expect(teacher.locator('.account-list')).toContainText('Браузерный ученик');
    expect((await teacher.request.get(`/api/v1/users/${studentSession.user.id}`)).status()).toBe(
      200,
    );

    await admin.getByRole('tab', { name: 'Настройки безопасности' }).click();
    await admin.getByLabel('Капча на страницах авторизации').uncheck();
    await saveSettings(admin);
    await expect(admin.getByLabel('Капча на страницах авторизации')).not.toBeChecked();
    const anonymous = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
    const loginPage = await anonymous.newPage();
    await loginPage.goto('/login');
    await expect(loginPage.getByRole('heading', { name: 'Вход в аккаунт' })).toBeVisible();
    await expect(loginPage.getByLabel('Символы с картинки')).toHaveCount(0);
    await anonymous.close();
    await admin.getByLabel('Капча на страницах авторизации').check();
    await admin.getByRole('button', { name: 'Добавить текущий IP' }).click();
    await admin.getByLabel('Проверка доступа пользователей с VPN').check();
    await saveSettings(admin);
    await expect(admin.getByLabel('Проверка доступа пользователей с VPN')).toBeChecked();
    await admin.screenshot({ path: 'test-results/admin-security.png', fullPage: true });

    const denied = await student.request.post('/api/v1/security/evaluate', {
      data: { resourceResults: [{ id: 'youtube', loaded: true }], jsProxyHint: true },
    });
    expect((await denied.json()).data.allowed).toBe(false);
    expect((await student.request.get(`/api/v1/users/${studentSession.user.id}`)).status()).toBe(
      403,
    );
    await student.reload();
    await expect(
      student.getByRole('heading', { name: 'вы используете VPN - сервис недоступен', exact: true }),
    ).toBeVisible();
    await admin.getByLabel('Проверка доступа пользователей с VPN').uncheck();
    await saveSettings(admin);
    await expect(admin.getByLabel('Проверка доступа пользователей с VPN')).not.toBeChecked();
    await student.goto('/student');
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible();
    expect(failures).toEqual([]);
  } finally {
    await studentContext.close();
    await teacherContext.close();
    await adminContext.close();
  }
});

test('unauthenticated users are redirected away from protected cabinets', async ({ page }) => {
  for (const path of ['/student', '/teacher', '/admin', '/plan', '/courses', '/admin/content']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Вход в аккаунт', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
  }
  expect((await page.request.get('/api/v1/admin/accounts')).status()).toBe(401);
});
