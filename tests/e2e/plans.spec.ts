import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { contentPackageSchema, type RunView, type PlanView } from '@luch/contracts';

const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
async function login(page: Page, prefix: string, offset = 0) {
  const email = `${prefix}-${test.info().retry}@example.test`;
  const keys = JSON.parse(
    await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const code = new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(keys[email]!),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: Date.now() + offset });
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Код Authenticator').fill(code);
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(
    prefix === 'plan-admin' ? /\/admin$/ : prefix === 'plan-teacher' ? /\/teacher$/ : /\/student$/,
  );
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
async function answer(page: Page, correct: boolean) {
  const run = await current(page),
    e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.response.type === 'choice' && e.solution.type === 'choice') {
    const solution = e.solution;
    await page
      .getByRole('radio', {
        name: e.response.options.find((o) => solution.correctOptionIds.includes(o.id) === correct)!
          .text,
        exact: true,
      })
      .check();
  } else if (e.solution.type === 'short_text') {
    await page
      .getByLabel('Короткий ответ', { exact: true })
      .fill(correct ? e.solution.accepted[0]! : 'wrong');
  } else throw new Error('Unexpected response');
}
async function completeDiagnostic(page: Page, language: 'ru' | 'en') {
  await page.goto('/onboarding');
  await page.getByLabel('Язык обучения').selectOption(language);
  await page.getByLabel('Учебная цель').selectOption('travel');
  await page.getByLabel('Доступное время в день, минуты').fill('10');
  await page.getByRole('button', { name: 'Сохранить анкету', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Анкета сохранена' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Начать или продолжить диагностику', exact: true })
    .click();
  for (let position = 0; position < 6; position++) {
    await expect(
      page.getByRole('heading', { name: `Задание ${position + 1} из 6`, exact: true }),
    ).toBeVisible();
    await answer(page, position !== 1);
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await expect(page.locator('.feedback h3')).toHaveText('Ответ сохранён');
    await page
      .getByRole('button', {
        name: position === 5 ? 'Завершить диагностику' : 'Следующее задание',
        exact: true,
      })
      .click();
  }
  await page
    .getByRole('link', { name: 'Результат входной диагностики по навыкам →', exact: true })
    .click();
  await page.getByRole('link', { name: 'Открыть индивидуальный план →', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Индивидуальный план', exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  return (await (await page.request.get(`/api/v1/plans/${id}`)).json()).data as PlanView;
}

test('both languages create an ordered plan, recover a failed start and resume a real assignment after login', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const language of ['ru', 'en'] as const) {
    await login(page, `plan-${language}`);
    const plan = await completeDiagnostic(page, language),
      path = `/plan/${plan.plan.id}`;
    expect(plan.assignments[0]!.lessonId).toBe(language === 'ru' ? 'rki-02' : 'english-02');
    expect(plan.assignments[0]!.reason.kind).toBe('diagnostic_gap');
    await expect(page.getByTestId('plan-assignment')).toHaveCount(6);
    await expect(page.getByTestId('plan-assignment').first()).toContainText('Причина назначения:');
    await page.reload();
    let fail = true;
    await page.route('**/api/v1/plans/*/assignments/*/start', async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Повторите открытие урока.',
              requestId: 'plan-test',
            },
          },
        });
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Начать следующее назначение', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Повторите открытие урока.');
    const unchanged = (await (await page.request.get(`/api/v1/plans/${plan.plan.id}`)).json())
      .data as PlanView;
    expect(unchanged.assignments.every((a) => a.runId === null)).toBe(true);
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await page.unroute('**/api/v1/plans/*/assignments/*/start');
    await answer(page, false);
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await page.getByRole('button', { name: 'Следующее задание', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Задание 2 из 2', exact: true })).toBeVisible();
    await answer(page, true);
    const before = await current(page),
      runId = before.run.id;
    await page.getByRole('button', { name: 'Сохранить и выйти', exact: true }).click();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await login(page, `plan-${language}`, 30000);
    await page.goto(path);
    await expect(page.getByTestId('plan-assignment').first()).toHaveAttribute(
      'data-status',
      'active',
    );
    await page.getByRole('button', { name: 'Продолжить назначенный урок', exact: true }).click();
    expect((await current(page)).run.id).toBe(runId);
    const e = bank.exercises.find((e) => e.id === before.current!.exercise.id)!;
    if (e.solution.type !== 'short_text') throw new Error('Text expected');
    await expect(page.getByLabel('Короткий ответ', { exact: true })).toHaveValue(
      e.solution.accepted[0]!,
    );
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
    await page
      .getByRole('link', { name: 'Вернуться к индивидуальному плану →', exact: true })
      .click();
    await expect(page.getByTestId('plan-assignment').first()).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(
      page
        .getByTestId('plan-assignment')
        .first()
        .getByRole('link', { name: 'Результаты урока →', exact: true }),
    ).toBeVisible();
    expect(
      (await (await page.request.get(`/api/v1/plans/${plan.plan.id}`)).json()).data.plan
        .completedAssignments,
    ).toBe(1);
    if (language === 'en') {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: 'test-results/plan-mobile.png', fullPage: true });
    } else await page.screenshot({ path: 'test-results/plan-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test('teacher and superadmin see the same plan; peers are denied and empty/error states recover', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  await login(page, 'plan-review');
  await page.goto('/plan');
  await expect(
    page.getByRole('heading', { name: 'План ещё не сформирован', exact: true }),
  ).toBeVisible();
  const plan = await completeDiagnostic(page, 'ru');
  const root = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' }),
    teacher = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' }),
    peer = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  try {
    const adminPage = await root.newPage(),
      teacherPage = await teacher.newPage(),
      otherPage = await peer.newPage();
    await login(adminPage, 'plan-admin');
    const rootSession = (await (await adminPage.request.get('/api/v1/auth/session')).json()).data;
    await login(teacherPage, 'plan-teacher');
    const teacherSession = (await (await teacherPage.request.get('/api/v1/auth/session')).json())
      .data;
    expect(
      (
        await adminPage.request.post('/api/v1/admin/teacher-students', {
          headers: { 'x-csrf-token': rootSession.csrfToken },
          data: { teacherId: teacherSession.user.id, studentId: plan.plan.user.id },
        })
      ).status(),
    ).toBe(200);
    await teacherPage.goto(`/teacher/students/${plan.plan.user.id}`);
    await teacherPage
      .getByRole('link', { name: 'Открыть план и назначения →', exact: true })
      .click();
    await expect(teacherPage.getByTestId('plan-assignment')).toHaveCount(6);
    await expect(teacherPage.getByRole('button', { name: 'Начать урок', exact: true })).toHaveCount(
      0,
    );
    await adminPage.goto(`/plan/${plan.plan.id}`);
    await expect(adminPage.getByTestId('plan-assignment')).toHaveCount(6);
    await expect(
      adminPage.getByRole('button', { name: 'Начать следующее назначение', exact: true }),
    ).toHaveCount(0);
    await adminPage.getByLabel('Управлять планом пользователя').check();
    await adminPage
      .getByRole('button', { name: 'Начать следующее назначение', exact: true })
      .click();
    const started = await current(adminPage);
    expect(started.run.user.id).toBe(plan.plan.user.id);
    await page.reload();
    await expect(page.getByTestId('plan-assignment').first()).toHaveAttribute(
      'data-status',
      'active',
    );
    await login(otherPage, 'plan-other');
    expect((await otherPage.request.get(`/api/v1/plans/${plan.plan.id}`)).status()).toBe(404);
    await otherPage.goto(`/plan/${plan.plan.id}`);
    await expect(otherPage.getByRole('alert')).toContainText('Прохождение не найдено.');
    let fail = true;
    await page.route('**/api/v1/plans?**', async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Попробуйте загрузить планы ещё раз.',
              requestId: 'plans-test',
            },
          },
        });
      } else await route.continue();
    });
    await page.goto('/plan');
    await expect(page.getByRole('alert')).toContainText('Попробуйте загрузить планы ещё раз.');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'План и последовательность уроков →', exact: true }),
    ).toBeVisible();
  } finally {
    await root.close();
    await teacher.close();
    await peer.close();
  }
});
