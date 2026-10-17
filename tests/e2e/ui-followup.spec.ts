import { test, expect, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { root, csrf, preparePlan, answer, keys } from './meetings.helpers';
import type { RunView } from '@luch/contracts';

function otp(email: string, secret: string) {
  return new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
}
async function create(admin: Page, role: 'student' | 'teacher') {
  const email = `ui-${role}-${crypto.randomUUID()}@example.test`;
  const response = await admin.request.post('/api/v1/admin/accounts', {
    headers: await csrf(admin),
    data: { email, name: `UI ${role}`, role, operationId: crypto.randomUUID() },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as {
    user: { id: string; email: string; name: string };
    manualKey: string;
  };
}
async function attemptLogin(page: Page, setup: { user: { email: string }; manualKey: string }) {
  const fixture = await keys();
  await page.request.post('/__e2e/isolate', {
    headers: { 'x-e2e-fixture': fixture.testIsolationToken },
  });
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill(setup.user.email);
  await page.getByLabel('Код Authenticator').fill(otp(setup.user.email, setup.manualKey));
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}
async function saveAccess(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/v1\/admin\/accounts\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Сохранить доступ', exact: true })).toBeEnabled();
}
test('browser locale, persistent choice and styled HTTP error pages work without a session', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'en-US' });
  try {
    const page = await context.newPage();
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('heading', { name: 'Sign in to your account', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Interface language')).toHaveValue('en');
    const denied = await page.goto('/student');
    expect(denied?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Sign-in required' })).toBeVisible();
    await expect(page.locator('.card')).toHaveCSS('border-radius', '20px');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.screenshot({ path: 'test-results/http-error-en.png', fullPage: true });
    await page.getByRole('link', { name: 'Sign in to your account', exact: true }).click();
    await page.getByLabel('Interface language').selectOption('ru');
    await expect(page.getByRole('heading', { name: 'Вход в аккаунт', exact: true })).toBeVisible();
    await expect(page.getByLabel('Язык интерфейса')).toHaveValue('ru');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    const missing = await page.goto('/missing-ui-page');
    expect(missing?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: 'Страница не найдена', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.card')).toHaveCSS('border-radius', '20px');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/http-error-ru-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('link', { name: 'На главную', exact: true }).click();
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    await expect(page.getByLabel('Язык интерфейса')).toBeVisible();
    await page.getByLabel('Язык интерфейса').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await expect(page.getByLabel('Interface language')).toBeVisible();
    await page.screenshot({ path: 'test-results/language-menu-mobile.png', fullPage: true });
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
});

test('deactivation and a reasoned ban are managed in the account form and shown clearly at sign-in', async ({
  browser,
}) => {
  const ac = await browser.newContext({ locale: 'ru-RU' }),
    sc = await browser.newContext({ locale: 'ru-RU' });
  try {
    const admin = await ac.newPage(),
      student = await sc.newPage();
    await root(admin);
    const setup = await create(admin, 'student');
    await admin.goto('/admin');
    await admin.getByLabel('Найти аккаунт', { exact: true }).fill(setup.user.email);
    await admin.getByRole('button', { name: 'Найти', exact: true }).click();
    await admin.getByRole('button', { name: `Открыть ${setup.user.email}`, exact: true }).click();
    await admin.getByLabel('Аккаунт активен', { exact: true }).uncheck();
    await saveAccess(admin);
    await expect(
      admin.getByRole('status').filter({ hasText: 'Доступ аккаунта обновлён.' }),
    ).toBeVisible();
    await attemptLogin(student, setup);
    await expect(student.getByRole('alert')).toContainText(
      'Ваш аккаунт деактивирован администратором',
    );
    await admin.getByLabel('Аккаунт активен', { exact: true }).check();
    await admin.getByLabel('Заблокировать аккаунт', { exact: true }).check();
    const reason = 'Нарушение правил <img src=x onerror=alert(1)>';
    await admin.getByLabel('Причина блокировки', { exact: true }).fill(reason);
    await saveAccess(admin);
    await expect(admin.getByLabel('Причина блокировки')).toHaveValue(reason);
    await attemptLogin(student, setup);
    await expect(student.getByRole('alert')).toContainText('Ваша учетная запись заблокирована');
    await expect(student.getByRole('alert')).toContainText(reason);
    await expect(student.getByRole('alert').locator('img')).toHaveCount(0);
    await student.screenshot({ path: 'test-results/account-blocked.png', fullPage: true });
    await admin.getByLabel('Заблокировать аккаунт', { exact: true }).uncheck();
    await saveAccess(admin);
    await expect(admin.getByLabel('Причина блокировки')).toHaveCount(0);
    await attemptLogin(student, setup);
    await expect(student).toHaveURL(/\/student$/);
  } finally {
    await ac.close();
    await sc.close();
  }
});

test('saved suspicious observations create yellow task markers for reviewers and stay hidden from the student', async ({
  browser,
}) => {
  const ac = await browser.newContext({ locale: 'ru-RU' }),
    sc = await browser.newContext({ locale: 'ru-RU' }),
    tc = await browser.newContext({ locale: 'ru-RU' });
  try {
    const admin = await ac.newPage(),
      student = await sc.newPage(),
      teacher = await tc.newPage();
    await root(admin);
    const s = await create(admin, 'student'),
      t = await create(admin, 'teacher');
    const linked = await admin.request.post('/api/v1/admin/teacher-students', {
      headers: await csrf(admin),
      data: { teacherId: t.user.id, studentId: s.user.id },
    });
    expect(linked.status()).toBe(200);
    await attemptLogin(student, s);
    await expect(student).toHaveURL(/\/student$/);
    await attemptLogin(teacher, t);
    await expect(teacher).toHaveURL(/\/teacher$/);
    await preparePlan(student, 'ru');
    const plans = (await (await student.request.get('/api/v1/plans')).json()).data;
    const plan = (await (await student.request.get(`/api/v1/plans/${plans.items[0].id}`)).json())
      .data;
    const started = await student.request.post(
      `/api/v1/plans/${plan.plan.id}/assignments/${plan.nextAssignmentId}/start`,
      { headers: await csrf(student), data: {} },
    );
    expect(started.status(), await started.text()).toBe(200);
    const run = (await started.json()).data as RunView;
    const observed = await student.request.post(`/api/v1/engine/runs/${run.run.id}/integrity`, {
      headers: await csrf(student),
      data: {
        turnId: run.current!.turn.id,
        batchId: crypto.randomUUID(),
        stats: {
          durationMilliseconds: 8000,
          hiddenMilliseconds: 2000,
          tabHides: 1,
          focusLosses: 1,
          pasteEvents: 1,
          inputEvents: 1,
        },
      },
    });
    expect(observed.status()).toBe(200);
    const checked = await student.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
      headers: await csrf(student),
      data: { turnId: run.current!.turn.id, operationId: crypto.randomUUID(), answer: answer(run) },
    });
    expect(checked.status()).toBe(200);
    await student.goto(`/learning/runs/${run.run.id}`);
    await expect(student.getByTestId('integrity-flag')).toHaveCount(0);
    await expect(
      student.getByText('Учебные действия и состояние окна сохраняются для проверки результата.'),
    ).toHaveCount(0);
    await teacher.goto(`/teacher/students/${s.user.id}`);
    const flag = teacher.getByTestId('integrity-flag').first();
    await expect(flag).toBeVisible();
    await expect(flag).toHaveCSS('background-color', 'rgb(255, 242, 179)');
    await expect(flag).toHaveAttribute('title', /Уход с вкладки/);
    await teacher
      .getByRole('link', { name: 'Проверить ответ и комментарии →', exact: true })
      .first()
      .click();
    await expect(teacher.getByTestId('integrity-flag')).toBeVisible();
    await teacher.getByText('Наблюдения по выполнению', { exact: true }).click();
    await expect(teacher.getByText(/Уходов с вкладки:/)).toContainText('1');
    await teacher.screenshot({ path: 'test-results/teacher-integrity-mark.png', fullPage: true });
  } finally {
    await ac.close();
    await sc.close();
    await tc.close();
  }
});
