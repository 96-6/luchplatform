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
import { contentPackageSchema, type RunView, type StudentDashboard } from '@luch/contracts';

const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
async function login(page: Page, prefix: string, offset = 0) {
  const keys = JSON.parse(
    await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
  );
  await page.request.post('/__e2e/isolate', {
    headers: { 'x-e2e-fixture': keys.testIsolationToken },
  });
  const email = `${prefix}-${test.info().retry}@example.test`;
  const captcha = (await (await page.request.get('/api/v1/auth/captcha?purpose=login')).json())
    .data;
  const code = new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(keys[email]),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: Date.now() + offset });
  const response = await apiPasswordLogin(page, {
    data: { email, code, captcha: { id: captcha.id, answer: 'ABCDE' } },
  });
  expect(response.status(), await response.text()).toBe(200);
  await page.goto('/');
  await expect(page).toHaveURL(/\/student$/);
  await expect(page.getByRole('heading', { name: 'Кабинет ученика', exact: true })).toBeVisible();
}
async function csrf(page: Page) {
  return {
    'x-csrf-token': (await (await page.request.get('/api/v1/auth/session')).json()).data.csrfToken,
  };
}
async function dashboard(page: Page): Promise<StudentDashboard> {
  const res = await page.request.get('/api/v1/student/dashboard?timeZone=Europe%2FMoscow');
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data;
}
async function current(page: Page): Promise<RunView> {
  await expect(page).toHaveURL(/\/learning\/runs\/[0-9a-f-]{36}$/);
  return (
    await (
      await page.request.get(
        `/api/v1/engine/runs/${new URL(page.url()).pathname.split('/').at(-1)}`,
      )
    ).json()
  ).data;
}
function answer(run: RunView, correct = true) {
  const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.solution.type === 'short_text')
    return { type: 'short_text', text: correct ? e.solution.accepted[0]! : 'wrong' };
  if (e.response.type !== 'choice') throw new Error('Unexpected response');
  const solution = e.solution;
  return {
    type: 'choice',
    optionId: e.response.options.find((o) => solution.correctOptionIds.includes(o.id) === correct)!
      .id,
  };
}
async function finishDiagnostic(page: Page, run: RunView) {
  const headers = await csrf(page);
  while (run.current) {
    let res = await page.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
      headers,
      data: { turnId: run.current.turn.id, operationId: crypto.randomUUID(), answer: answer(run) },
    });
    expect(res.status(), await res.text()).toBe(200);
    run = (await res.json()).data.view;
    res = await page.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
      headers,
      data: { turnId: run.current!.turn.id },
    });
    expect(res.status(), await res.text()).toBe(200);
    run = (await res.json()).data;
  }
}
async function fillAnswer(page: Page, run: RunView, correct: boolean) {
  const a = answer(run, correct);
  if (a.type === 'short_text')
    await page.getByLabel('Короткий ответ', { exact: true }).fill(a.text!);
  else {
    const response = run.current!.exercise.response;
    if (response.type !== 'choice') throw new Error('Choice expected');
    await page
      .getByRole('radio', {
        name: response.options.find((o) => o.id === a.optionId)!.text,
        exact: true,
      })
      .check();
  }
}
async function prepare(page: Page, language: 'ru' | 'en') {
  await page.getByRole('link', { name: 'Заполнить анкету', exact: true }).click();
  await page.getByLabel('Язык обучения').selectOption(language);
  await page.getByLabel('Учебная цель').selectOption('travel');
  await page.getByLabel('Доступное время в день, минуты').fill('10');
  await page.getByRole('button', { name: 'Сохранить анкету', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Анкета сохранена' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Начать диагностику', exact: true }).click();
  await finishDiagnostic(page, await current(page));
  await page.goto('/');
  await expect(page.getByTestId('dashboard-next')).toBeVisible();
}

for (const language of ['ru', 'en'] as const)
  test(`${language}: starts from home, resumes saved work after login and shows actual adaptation and navigation`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(e.message));
    await login(page, `dashboard-${language}`);
    await prepare(page, language);
    await expect(page.locator('#learning-goal')).toHaveText(
      language === 'ru' ? 'Русский как иностранный' : 'Английский',
    );
    await expect(page.getByText('Цель:', { exact: false }).first()).toContainText('Путешествия');
    const data = await dashboard(page);
    expect(data.today).toHaveLength(1);
    expect(data.today[0]!.planId).toBe(data.plan!.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/plans/*/assignments/*/start', async (route) => {
      await gate;
      await route.continue();
    });
    await page
      .getByTestId('dashboard-next')
      .getByRole('button', { name: 'Начать следующее назначение', exact: true })
      .click();
    await expect(
      page.getByTestId('dashboard-next').getByRole('button', { name: 'Открываем…', exact: true }),
    ).toBeDisabled();
    release();
    let run = await current(page);
    await page.unroute('**/api/v1/plans/*/assignments/*/start');
    await fillAnswer(page, run, false);
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await expect(page.locator('.feedback h3')).toHaveText('Нужно исправить');
    await page.getByRole('button', { name: 'Следующее задание', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Задание 2 из 2', exact: true })).toBeVisible();
    run = await current(page);
    await fillAnswer(page, run, true);
    await page.getByRole('button', { name: 'Сохранить и выйти', exact: true }).click();
    await expect(
      page
        .getByTestId('dashboard-next')
        .getByRole('link', { name: 'Продолжить урок →', exact: true }),
    ).toHaveAttribute('href', `/learning/runs/${run.run.id}`);
    await page.reload();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await login(page, `dashboard-${language}`, 30000);
    await page
      .getByTestId('dashboard-next')
      .getByRole('link', { name: 'Продолжить урок →', exact: true })
      .click();
    const restored = await current(page);
    expect(restored.run.id).toBe(run.run.id);
    expect(restored.current!.turn.draftAnswer).toEqual(answer(run));
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await expect(page.locator('.feedback h3')).toHaveText('Верно');
    await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
    await page.goto('/');
    await expect(page.getByTestId('dashboard-completed-lessons')).toHaveText('1');
    await expect(
      page.getByTestId('dashboard-assignment').filter({ hasText: 'Дополнительная практика' }),
    ).toBeVisible();
    const saved = await dashboard(page);
    expect(saved.continueRun).toBeNull();
    expect(saved.progress).toMatchObject({
      evaluatedAttempts: 8,
      independentCorrect: 7,
      assistedCorrect: 0,
      incorrectAttempts: 1,
    });
    expect(saved.reviews.length).toBeGreaterThan(0);
    await expect(
      page.getByRole('button', { name: 'Начать повторение', exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId('dashboard-results').locator('li')).toHaveCount(5);
    if (language === 'en') {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.screenshot({ path: `test-results/dashboard-${language}.png`, fullPage: true });
    for (const [name, path, heading] of [
      ['Помощник', '/assistant', 'Ваш помощник'],
      ['Расписание', '/schedule', 'Расписание'],
      ['Учебный отчёт', '/progress', 'Учебный отчёт'],
      ['Мой план', `/plan/${saved.plan!.id}`, 'Индивидуальный план'],
    ]) {
      await page
        .getByRole('navigation', { name: 'Разделы ученика' })
        .getByRole('link', { name: new RegExp(`^${name}`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await page.goto('/');
    }
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    expect(failures).toEqual([]);
  });

test('dashboard loading, empty, failed and invalid responses recover without creating learning work', async ({
  page,
}) => {
  await login(page, 'dashboard-empty');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/student/dashboard?**', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/student', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Загружаем ваш учебный день…', { exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('link', { name: 'Заполнить анкету', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Пока нет ответов', exact: true })).toBeVisible();
  await page.unroute('**/api/v1/student/dashboard?**');
  for (const invalid of [false, true]) {
    await page.route('**/api/v1/student/dashboard?**', (route) =>
      route.fulfill({
        status: invalid ? 200 : 503,
        json: invalid
          ? { data: {}, requestId: 'dashboard-invalid' }
          : {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Повторите загрузку главной.',
                requestId: 'dashboard-failure',
              },
            },
      }),
    );
    await page.reload();
    await expect(page.getByRole('alert')).toContainText(
      invalid ? 'Получен неполный ответ сервера' : 'Повторите загрузку главной.',
    );
    await page.unroute('**/api/v1/student/dashboard?**');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Заполнить анкету', exact: true })).toBeVisible();
  }
  expect((await dashboard(page)).progress.evaluatedAttempts).toBe(0);
  expect((await (await page.request.get('/api/v1/engine/runs')).json()).data.items).toEqual([]);
});

test('retries a lost assignment response from home without creating a second run or a learning penalty', async ({
  page,
}) => {
  await login(page, 'dashboard-retry');
  await prepare(page, 'ru');
  const initial = await dashboard(page);
  let first = true;
  await page.route('**/api/v1/plans/*/assignments/*/start', async (route) => {
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Ответ сервера потерян. Повторите открытие.',
            requestId: 'lost-dashboard-response',
          },
        },
      });
    } else await route.continue();
  });
  await page
    .getByTestId('dashboard-next')
    .getByRole('button', { name: 'Начать следующее назначение', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Ответ сервера потерян.');
  const saved = await dashboard(page);
  expect(saved.continueRun).not.toBeNull();
  expect(saved.progress).toEqual(initial.progress);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  expect((await current(page)).run.id).toBe(saved.continueRun!.id);
  const runs = (await (await page.request.get('/api/v1/engine/runs')).json()).data.items;
  expect(runs.filter((r: { purpose: string }) => r.purpose === 'practice')).toHaveLength(1);
});
