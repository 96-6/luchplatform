import {
  testPassword,
  apiPasswordLogin,
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
async function enroll(
  page: Page,
  email: string,
  role: 'student' | 'teacher' | 'superadmin' = 'student',
) {
  return enrollAPI(page, email, role, role !== 'superadmin');
}
async function choose(page: Page, exerciseId: string, incorrect = false) {
  const exercise = demo.exercises.find((item) => item.id === exerciseId)!;
  if (exercise.response.type !== 'choice' || exercise.solution.type !== 'choice')
    throw new Error('Choice fixture required');
  const option = exercise.response.options.find(
    (item) =>
      exercise.solution.type === 'choice' &&
      exercise.solution.correctOptionIds.includes(item.id) !== incorrect,
  )!;
  await page.getByRole('radio', { name: option.text, exact: true }).check();
}
async function loginFixture(page: Page, prefix: string) {
  const email = `${prefix}-${test.info().retry}@example.test`,
    keys = JSON.parse(
      await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
    ) as Record<string, string>,
    captcha = (await (await page.request.get('/api/v1/auth/captcha?purpose=login')).json()).data;
  expect(
    (
      await apiPasswordLogin(page, {
        data: {
          email,
          code: code(email, keys[email]!),
          captcha: { id: captcha.id, answer: 'ABCDE' },
        },
      })
    ).status(),
  ).toBe(200);
}
async function runData(page: Page) {
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  return (await (await page.request.get(`/api/v1/engine/runs/${id}`)).json()).data;
}

test('luch engine saves both languages, resumes after login and shares all evidence with superadmin', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const email = `engine-browser-${Date.now()}@example.test`,
    key = await enroll(page, email);
  await page.goto('/courses/luch-demo/rki-a1/lessons/rki-01?packageVersion=1');
  await page.getByRole('button', { name: 'Начать или продолжить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задание 1 из 2', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Учебный материал', exact: true })).toBeVisible();
  await choose(page, 'rki-01-practice-choice');
  await page.getByRole('button', { name: 'Подсказка', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Использованные подсказки', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  await page.getByRole('button', { name: 'Следующее задание', exact: true }).click();
  await page.getByLabel('Короткий ответ', { exact: true }).fill('  ЗОВУТ  ');
  await expect(page.getByRole('status').filter({ hasText: 'Черновик сохранён' })).toBeVisible();
  const stored = await runData(page),
    runId = stored.run.id,
    userId = stored.run.user.id;
  await page.getByRole('button', { name: 'Сохранить и выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Кабинет ученика', exact: true })).toBeVisible();
  const adminContext = await browser.newContext({
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
    }),
    teacherContext = await browser.newContext({
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
    });
  try {
    const admin = await adminContext.newPage();
    await enroll(admin, 'engine-admin@example.test', 'superadmin');
    await admin.goto('/admin');
    await admin.getByRole('link', { name: 'Все прохождения и результаты →', exact: true }).click();
    await expect(
      admin.getByRole('heading', { name: 'Все прохождения', exact: true }),
    ).toBeVisible();
    await admin.locator(`a[href="/learning/runs/${runId}"]`).click();
    await expect(admin.getByLabel('Короткий ответ', { exact: true })).toHaveValue('  ЗОВУТ  ');
    await expect(admin.getByLabel('Короткий ответ', { exact: true })).toBeDisabled();
    await expect(
      admin.getByText('Все данные luch engine для отладки', { exact: true }),
    ).toBeVisible();
    const adminView = await runData(admin);
    expect(adminView.debug).toHaveLength(2);
    expect(adminView.attempts[0].usedHints).toHaveLength(1);
    await admin.screenshot({ path: 'test-results/engine-admin.png', fullPage: true });
    const teacher = await teacherContext.newPage();
    await enroll(teacher, `engine-teacher-${Date.now()}@example.test`, 'teacher');
    const teacherUser = (await (await teacher.request.get('/api/v1/auth/session')).json()).data
        .user,
      adminSession = (await (await admin.request.get('/api/v1/auth/session')).json()).data;
    expect(
      (
        await admin.request.post('/api/v1/admin/teacher-students', {
          headers: { 'x-csrf-token': adminSession.csrfToken },
          data: { teacherId: teacherUser.id, studentId: userId },
        })
      ).status(),
    ).toBe(200);
    await teacher.goto(`/learning/runs/${runId}`);
    await expect(teacher.getByLabel('Короткий ответ', { exact: true })).toHaveValue('  ЗОВУТ  ');
    await expect(teacher.getByLabel('Короткий ответ', { exact: true })).toBeDisabled();
    expect((await runData(teacher)).debug).toBeNull();
  } finally {
    await adminContext.close();
    await teacherContext.close();
  }
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в аккаунт', exact: true })).toBeVisible();
  await signInUI(page, email, key, 30000);
  await expect(page.getByRole('heading', { name: 'Кабинет ученика', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Продолжить урок →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задание 2 из 2', exact: true })).toBeVisible();
  await expect(page.getByLabel('Короткий ответ', { exact: true })).toHaveValue('  ЗОВУТ  ');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Урок завершён', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Урок завершён', exact: true })).toBeVisible();
  const completed = await runData(page);
  expect(completed.attempts).toHaveLength(2);
  expect(completed.attempts[0].independent).toBe(false);
  expect(completed.attempts[1].independent).toBe(true);
  await page.goto('/courses/luch-demo/english-a1/lessons/english-01?packageVersion=1');
  await page.getByRole('button', { name: 'Начать или продолжить тренировку', exact: true }).click();
  await choose(page, 'english-01-practice-choice', true);
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Нужно исправить');
  await page.getByRole('button', { name: 'Попробовать ещё раз', exact: true }).click();
  await choose(page, 'english-01-practice-choice');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  await page.getByRole('button', { name: 'Следующее задание', exact: true }).click();
  await page.getByLabel('Короткий ответ', { exact: true }).fill(' ＩＳ ');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Урок завершён', exact: true })).toBeVisible();
  expect((await runData(page)).attempts).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('a lost answer response can be retried without duplicating the stored attempt', async ({
  page,
}) => {
  await loginFixture(page, 'engine-retry');
  await page.goto('/courses/luch-demo/rki-a1/lessons/rki-02?packageVersion=1');
  await page.getByRole('button', { name: 'Начать или продолжить тренировку', exact: true }).click();
  await choose(page, 'rki-02-practice-choice');
  let first = true;
  await page.route('**/api/v1/engine/runs/*/answer', async (route) => {
    if (first) {
      first = false;
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Можно повторить отправку');
  await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  expect((await runData(page)).attempts).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  expect((await runData(page)).attempts).toHaveLength(1);
});

test('mobile control has no hint or material and releases feedback only at completion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginFixture(page, 'engine-control');
  await page.goto('/courses/luch-demo/rki-a1/lessons/rki-01?packageVersion=1&purpose=control');
  await page.getByRole('button', { name: 'Начать или продолжить проверку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Учебный материал', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Подсказка', exact: true })).toBeDisabled();
  await page.getByLabel('Короткий ответ', { exact: true }).fill('зовут');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Ответ сохранён');
  expect((await runData(page)).attempts[0].evaluation).toBeNull();
  await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Урок завершён', exact: true })).toBeVisible();
  expect((await runData(page)).attempts[0].evaluation.correct).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/engine-mobile.png', fullPage: true });
});

test('background integrity signals stay out of learner feedback and are available to superadmin', async ({
  page,
  browser,
}) => {
  await loginFixture(page, 'engine-integrity');
  await page.goto('/courses/luch-demo/rki-a1/lessons/rki-03?packageVersion=1');
  await page.getByRole('button', { name: 'Начать или продолжить тренировку', exact: true }).click();
  await choose(page, 'rki-03-practice-choice');
  await page.evaluate(() => {
    const target = document.querySelector('.exercise-instruction')!;
    for (let i = 0; i < 6; i++) target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    target.dispatchEvent(new Event('paste', { bubbles: true }));
    window.dispatchEvent(new Event('blur'));
  });
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  const data = await runData(page);
  expect(data.attempts[0].integrity).toBeNull();
  await expect(page.getByText('Контекст честности:', { exact: false })).toHaveCount(0);
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const admin = await context.newPage();
    await loginFixture(admin, 'engine-integrity-admin');
    await admin.goto(`/learning/runs/${data.run.id}`);
    await admin.locator('.attempt-item summary').click();
    await expect(admin.locator('.integrity-review')).toContainText('Требует внимания');
    const privileged = await runData(admin);
    expect(privileged.attempts[0].evaluation.score).toBe(1);
    expect(privileged.attempts[0].integrity.requiresReview).toBe(true);
    await admin.goto('/admin?tab=security');
    await admin.getByLabel('Фоновая проверка прохождения').uncheck();
    await admin.getByRole('button', { name: 'Сохранить параметры честности', exact: true }).click();
    await expect(
      admin.getByRole('status').filter({ hasText: 'Параметры честности сохранены' }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await admin.request.get('/api/v1/admin/engine/integrity-policy')).json()).data
            .enabled,
      )
      .toBe(false);
    await admin.getByLabel('Фоновая проверка прохождения').check();
    await admin.getByRole('button', { name: 'Сохранить параметры честности', exact: true }).click();
  } finally {
    await context.close();
  }
});
