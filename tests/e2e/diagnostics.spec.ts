import {
  testPassword,
  signInUI,
  newPasswordUI,
  passwordUI,
  secondFactorUI,
  enrollAPI,
} from './password.helpers';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { contentPackageSchema } from '@luch/contracts';

const demo = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
const code = (email: string, secret: string) =>
  new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
async function adminAlias() {
  return (
    JSON.parse(
      await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
    ) as Record<string, string>
  ).localAdminAlias!;
}
async function localLogin(page: Page, alias: string) {
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill(alias);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: alias.startsWith('testuser') ? 'Кабинет ученика' : 'Кабинет суперадмина',
      exact: true,
    }),
  ).toBeVisible();
}
async function ordinaryLogin(page: Page, email: string, secret: string) {
  await signInUI(page, email, secret);
  const accepted = (await (await page.request.get('/api/v1/auth/session')).json()).data;
  await expect(page).toHaveURL(accepted.dashboardPath);
}
async function session(page: Page) {
  return (await (await page.request.get('/api/v1/auth/session')).json()).data;
}
async function current(page: Page) {
  await expect(page).toHaveURL(/\/learning\/runs\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').at(-1);
  return (await (await page.request.get(`/api/v1/engine/runs/${id}`)).json()).data;
}
async function select(page: Page, correct: boolean) {
  const view = await current(page),
    exercise = demo.exercises.find((e) => e.id === view.current.exercise.id)!;
  if (exercise.response.type !== 'choice' || exercise.solution.type !== 'choice')
    throw new Error('Choice bank expected');
  const option = exercise.response.options.find(
    (o) =>
      exercise.solution.type === 'choice' &&
      exercise.solution.correctOptionIds.includes(o.id) === correct,
  )!;
  await page.getByRole('radio', { name: option.text, exact: true }).check();
  return option.id;
}
async function complete(page: Page, answers: boolean[]) {
  let run = await current(page);
  while (run.current) {
    if (!run.current.attempt) {
      await select(page, answers[run.current.position] ?? false);
      await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
      await expect(page.locator('.feedback h3')).toHaveText('Ответ сохранён');
    }
    await page
      .getByRole('button', {
        name:
          run.current.position + 1 === run.run.totalSteps
            ? 'Завершить диагностику'
            : 'Следующее задание',
        exact: true,
      })
      .click();
    await expect
      .poll(async () => {
        const data = await current(page);
        return data.run.status === 'completed' ? data.run.totalSteps : data.current.position;
      })
      .toBe(run.current.position + 1);
    run = await current(page);
  }
  await expect(
    page.getByRole('heading', { name: 'Диагностика завершена', exact: true }),
  ).toBeVisible();
  const diagnosticId = run.run.diagnosticId as string;
  await page
    .getByRole('link', { name: 'Результат входной диагностики по навыкам →', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Предварительный результат диагностики', exact: true }),
  ).toBeVisible();
  return diagnosticId;
}
async function finishInterruptedRetry(page: Page) {
  if (!test.info().retry) return;
  const saved = (await (await page.request.get('/api/v1/diagnostics')).json()).data.items;
  for (const item of saved.filter((d: { status: string }) => d.status === 'active')) {
    await page.goto(`/learning/runs/${item.runId}`);
    await complete(page, [false, false, false, false, false, false]);
  }
}

test('superadmin creates a ready account, shows its QR and resets 2FA for ordinary login', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Неверная почта или пароль.');
  await localLogin(page, await adminAlias());
  const email = `created-in-browser-${Date.now()}@example.test`;
  await page.getByLabel('Почта нового пользователя').fill(email);
  await page.getByLabel('Имя нового пользователя').fill('Создан без SMTP');
  await newPasswordUI(page, 'admin-new');
  await page.getByRole('button', { name: 'Создать и показать QR-код', exact: true }).click();
  await expect(page.locator('.credential-setup')).toContainText('Аккаунт готов к входу');
  await expect(page.getByAltText('QR-код Authenticator пользователя')).toBeVisible();
  const key = (await page.getByTestId('admin-manual-key').textContent())!.trim();
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const student = await context.newPage();
    await ordinaryLogin(student, email, key);
    await expect(
      student.getByRole('heading', { name: 'Кабинет ученика', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Скрыть QR-код', exact: true }).click();
    await page
      .getByRole('button', { name: 'Сбросить 2FA и создать новый QR', exact: true })
      .click();
    const newKey = await page.getByTestId('admin-manual-key').textContent();
    expect(newKey!.trim()).not.toBe(key);
    const expired = await student.reload();
    expect(expired?.status()).toBe(401);
    await expect(
      student.getByRole('heading', { name: 'Требуется вход', exact: true }),
    ).toBeVisible();
    await ordinaryLogin(student, email, newKey!.trim());
    await expect(
      student.getByRole('heading', { name: 'Кабинет ученика', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Скрыть QR-код', exact: true }).click();
    await page.getByRole('button', { name: 'Показать QR-код 2FA', exact: true }).click();
    expect((await page.getByTestId('admin-manual-key').textContent())!.trim()).toBe(newKey!.trim());
  } finally {
    await context.close();
  }
});

test('questionnaire, English resume, two different skill results and reviewer access work together', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await localLogin(page, 'testuser1');
  await finishInterruptedRetry(page);
  await page.goto('/onboarding');
  await page.getByLabel('Язык обучения').selectOption('en');
  await page.getByLabel('Учебная цель').selectOption('work');
  await page.getByLabel('Опыт изучения языка').selectOption('some');
  await page.getByLabel('Доступное время в день, минуты').fill('25');
  await page.getByRole('button', { name: 'Сохранить анкету', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Анкета сохранена' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Язык обучения')).toHaveValue('en');
  await expect(page.getByLabel('Доступное время в день, минуты')).toHaveValue('25');
  await page
    .getByRole('button', {
      name: test.info().retry ? 'Пройти диагностику ещё раз' : 'Начать или продолжить диагностику',
      exact: true,
    })
    .click();
  await expect(page.getByRole('button', { name: 'Подсказка', exact: true })).toBeDisabled();
  await select(page, true);
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await page.getByRole('button', { name: 'Следующее задание', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задание 2 из 6', exact: true })).toBeVisible();
  const chosen = await select(page, false);
  await page.getByRole('button', { name: 'Сохранить и выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Кабинет ученика', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await localLogin(page, 'testuser1');
  await page.getByRole('link', { name: 'Продолжить диагностику →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задание 2 из 6', exact: true })).toBeVisible();
  expect((await current(page)).current.turn.draftAnswer.optionId).toBe(chosen);
  const id = await complete(page, [true, false, true, false, true, false]);
  await expect(page.getByText('Верных ответов: 3 из 6 · 50%', { exact: true })).toBeVisible();
  await expect(page.getByTestId('skill-result')).toHaveCount(6);
  await page.reload();
  await expect(page.getByText('Верных ответов: 3 из 6 · 50%', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/diagnostic-result.png', fullPage: true });
  const studentId = (await session(page)).user.id as string;
  const rootContext = await browser.newContext({
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
    }),
    otherContext = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' }),
    teacherContext = await browser.newContext({
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
    });
  try {
    const admin = await rootContext.newPage();
    await localLogin(admin, await adminAlias());
    await admin.goto(`/diagnostics/${id}`);
    await expect(admin.getByText('Верных ответов: 3 из 6 · 50%', { exact: true })).toBeVisible();
    const adminSession = await session(admin),
      teacherEmail = `diagnostic-teacher-${Date.now()}@example.test`;
    const created = await admin.request.post('/api/v1/admin/accounts', {
      headers: { 'x-csrf-token': adminSession.csrfToken },
      data: {
        password: testPassword,
        email: teacherEmail,
        name: 'Преподаватель диагностики',
        role: 'teacher',
        operationId: crypto.randomUUID(),
      },
    });
    expect(created.status()).toBe(200);
    const credentials = (await created.json()).data;
    expect(
      (
        await admin.request.post('/api/v1/admin/teacher-students', {
          headers: { 'x-csrf-token': adminSession.csrfToken },
          data: { teacherId: credentials.user.id, studentId },
        })
      ).status(),
    ).toBe(200);
    const teacher = await teacherContext.newPage();
    await ordinaryLogin(teacher, teacherEmail, credentials.manualKey);
    await teacher.goto(`/diagnostics/${id}`);
    await expect(teacher.getByText('Верных ответов: 3 из 6 · 50%', { exact: true })).toBeVisible();
    await expect(
      teacher.getByRole('link', { name: 'Анкета и повторная диагностика →', exact: true }),
    ).toHaveCount(0);
    const other = await otherContext.newPage();
    await other.setViewportSize({ width: 390, height: 844 });
    await localLogin(other, 'testuser2');
    await finishInterruptedRetry(other);
    expect((await other.request.get(`/api/v1/diagnostics/${id}`)).status()).toBe(404);
    await other.goto('/onboarding');
    await other.getByLabel('Учебная цель').selectOption('travel');
    await other.getByLabel('Доступное время в день, минуты').fill('10');
    await other.getByRole('button', { name: 'Сохранить анкету', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Анкета сохранена' })).toBeVisible();
    await other
      .getByRole('button', {
        name: test.info().retry
          ? 'Пройти диагностику ещё раз'
          : 'Начать или продолжить диагностику',
        exact: true,
      })
      .click();
    await complete(other, [false, false, false, false, false, false]);
    await expect(other.getByText('Верных ответов: 0 из 6 · 0%', { exact: true })).toBeVisible();
    await expect(other.getByTestId('skill-result')).toHaveCount(6);
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await other.screenshot({ path: 'test-results/diagnostic-mobile.png', fullPage: true });
  } finally {
    await rootContext.close();
    await otherContext.close();
    await teacherContext.close();
  }
  expect(errors).toEqual([]);
});

test('questionnaire empty and error states recover without starting or losing a diagnostic', async ({
  page,
}) => {
  await localLogin(page, 'testuser3');
  let fail = true;
  await page.route('**/api/v1/learning/profile?**', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Повторите попытку.',
            requestId: 'browser-error',
          },
        },
      });
    } else await route.continue();
  });
  await page.goto('/onboarding');
  await expect(page.getByRole('alert')).toContainText('Повторите попытку.');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByText('Сначала сохраните анкету.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Начать или продолжить диагностику', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('Диагностика ещё не начата.', { exact: true })).toBeVisible();
});
