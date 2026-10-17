import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import {
  contentPackageSchema,
  type RunView,
  type PlanView,
  providerSettingsSchema,
} from '@luch/contracts';
// Isolate added cases from earlier clients while retaining the real authorization checks.
async function isolate(request: import('@playwright/test').APIRequestContext) {
  const { testIsolationToken } = JSON.parse(
    await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
  );
  expect(
    (
      await request.post('/__e2e/isolate', { headers: { 'x-e2e-fixture': testIsolationToken } })
    ).status(),
  ).toBe(204);
}
test.beforeEach(async ({ request }) => isolate(request));
test.afterEach(async ({ request }) => isolate(request));
const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
async function login(page: Page, prefix: string) {
  const email = `${prefix}-${test.info().retry}@example.test`,
    keys = JSON.parse(
      await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
  await ordinaryLogin(
    page,
    email,
    keys[email]!,
    prefix.includes('admin') ? 'Кабинет суперадмина' : 'Кабинет ученика',
  );
}
async function ordinaryLogin(page: Page, email: string, key: string, heading: string) {
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Код Authenticator').fill(
    new TOTP({
      issuer: 'ЛУЧ',
      label: email,
      secret: Secret.fromBase32(key),
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    }).generate(),
  );
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}
async function run(page: Page): Promise<RunView> {
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
  const view = await run(page),
    exercise = bank.exercises.find((e) => e.id === view.current!.exercise.id)!;
  if (exercise.response.type === 'choice' && exercise.solution.type === 'choice') {
    const solution = exercise.solution;
    await page
      .getByRole('radio', {
        name: exercise.response.options.find(
          (o) => solution.correctOptionIds.includes(o.id) === correct,
        )!.text,
        exact: true,
      })
      .check();
  } else if (exercise.solution.type === 'short_text')
    await page
      .getByLabel('Короткий ответ', { exact: true })
      .fill(correct ? exercise.solution.accepted[0]! : 'wrong');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toBeVisible();
}
async function diagnostic(page: Page, language: 'ru' | 'en') {
  await page.goto('/onboarding');
  await page.getByLabel('Язык обучения').selectOption(language);
  await page.getByRole('button', { name: 'Сохранить анкету', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Анкета сохранена' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Начать или продолжить диагностику', exact: true })
    .click();
  for (let pos = 0; pos < 6; pos++) {
    await expect(
      page.getByRole('heading', { name: `Задание ${pos + 1} из 6`, exact: true }),
    ).toBeVisible();
    await answer(page, true);
    await page
      .getByRole('button', {
        name: pos === 5 ? 'Завершить диагностику' : 'Следующее задание',
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
  return plan(page);
}
async function plan(page: Page): Promise<PlanView> {
  return (
    await (
      await page.request.get(`/api/v1/plans/${new URL(page.url()).pathname.split('/').at(-1)}`)
    ).json()
  ).data;
}
async function completeLesson(page: Page, correct: boolean) {
  for (let pos = 0; pos < 2; pos++) {
    await expect(
      page.getByRole('heading', { name: `Задание ${pos + 1} из 2`, exact: true }),
    ).toBeVisible();
    await answer(page, correct);
    await page
      .getByRole('button', { name: pos ? 'Завершить урок' : 'Следующее задание', exact: true })
      .click();
  }
  await page
    .getByRole('link', { name: 'Вернуться к индивидуальному плану →', exact: true })
    .click();
}

test('mistakes and independent success produce different next tasks and persistent reasons in both languages', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'adapt-error');
  const a = await diagnostic(page, 'ru');
  await page.getByRole('button', { name: 'Начать следующее назначение', exact: true }).click();
  await completeLesson(page, false);
  await expect(page.locator('[data-kind="correction"]')).toHaveCount(1);
  await expect(page.getByTestId('plan-change').filter({ hasText: 'ошибка' }).first()).toBeVisible();
  const first = await plan(page),
    next = first.assignments.find((x) => x.id === first.nextAssignmentId)!;
  expect(next.kind).toBe('correction');
  await page.reload();
  await expect(page.locator('[data-kind="correction"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Начать дополнительную практику', exact: true }).click();
  // Both bank exercises were already viewed. New task-9 behavior reports exhaustion.
  await expect(
    page.getByRole('alert').filter({ hasText: 'Ошибка генерации контента' }),
  ).toBeVisible();
  const unchanged = await plan(page);
  expect(unchanged.assignments.find((x) => x.id === next.id)!.status).toBe('pending');
  const other = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const good = await other.newPage();
    await good.setViewportSize({ width: 390, height: 844 });
    await login(good, 'adapt-success');
    const b = await diagnostic(good, 'en');
    await good.getByRole('button', { name: 'Начать следующее назначение', exact: true }).click();
    await completeLesson(good, true);
    await expect(good.locator('[data-kind="review"]')).toHaveCount(1);
    await expect(
      good
        .locator('[data-kind="review"]')
        .getByRole('button', { name: 'Начать задание', exact: true }),
    ).toBeDisabled();
    await expect(
      good.getByTestId('plan-change').filter({ hasText: 'Самостоятельный успех' }).first(),
    ).toBeVisible();
    const current = await plan(good);
    expect(current.assignments.find((x) => x.id === current.nextAssignmentId)!.kind).toBe(
      'initial',
    );
    const review = current.assignments.find((x) => x.kind === 'review')!;
    const session = (await (await good.request.get('/api/v1/auth/session')).json()).data;
    expect(
      (
        await good.request.post(`/api/v1/plans/${b.plan.id}/assignments/${review.id}/start`, {
          headers: { 'x-csrf-token': session.csrfToken },
          data: {},
        })
      ).status(),
    ).toBe(409);
    expect((await good.request.get(`/api/v1/plans/${a.plan.id}/history`)).status()).toBe(404);
    expect(await good.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await good.screenshot({ path: 'test-results/adaptation-mobile.png', fullPage: true });
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});

test('root sets budgets and provider keys; a created administrator can change only limited controls; listening is cached', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  await login(page, 'adapt-providers-admin');
  await page.goto('/admin/providers');
  const ceilings = page
    .getByRole('heading', { name: 'Ограничения суперадмина', exact: true })
    .locator('..');
  for (const label of [
    'Общий бюджет, USD',
    'Лимит в день, USD',
    'Лимит в месяц, USD',
    'На одного ученика в день, USD',
  ])
    await ceilings.getByLabel(label, { exact: true }).fill('1');
  await ceilings.getByLabel('Запросов на ученика в день', { exact: true }).fill('20');
  await ceilings.getByLabel('Максимум символов озвучивания', { exact: true }).fill('2000');
  await ceilings
    .getByRole('button', { name: 'Сохранить верхние ограничения', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Настройки сохранены' })).toBeVisible();
  for (const [id, name, input, output] of [
    ['openai', 'OpenAI', '0.4', '1.6'],
    ['neuroapi', 'NeuroAPI', '0.1', '0.4'],
  ] as const) {
    const panel = page.getByTestId(`provider-${id}`);
    await panel.getByLabel(`Включить ${name}`, { exact: true }).check();
    await panel.getByLabel(`Цена входа ${name}, USD за 1 млн токенов`, { exact: true }).fill(input);
    await panel
      .getByLabel(`Цена выхода ${name}, USD за 1 млн токенов`, { exact: true })
      .fill(output);
    await panel
      .getByLabel(`Новый ключ ${name}`, { exact: true })
      .fill(randomBytes(24).toString('hex'));
    await panel
      .getByLabel(`Подтверждаю верхние цены текущего тарифа ${name}`, { exact: true })
      .check();
    await panel.getByRole('button', { name: `Сохранить подключение ${name}`, exact: true }).click();
    await expect(
      panel.getByText('Ключ: настроен · подключение включено', { exact: true }),
    ).toBeVisible();
  }
  const eleven = page.getByTestId('provider-elevenlabs');
  await eleven.getByLabel('Включить ElevenLabs', { exact: true }).check();
  await eleven.getByLabel('Верхняя цена USD за 1000 символов', { exact: true }).fill('0.1');
  await eleven.getByLabel('Голос ElevenLabs для РКИ', { exact: true }).fill('demoRuVoice');
  await eleven.getByLabel('Голос ElevenLabs для английского', { exact: true }).fill('demoEnVoice');
  await eleven
    .getByLabel('Новый ключ ElevenLabs', { exact: true })
    .fill(randomBytes(24).toString('hex'));
  await eleven
    .getByLabel('Подтверждаю верхние цены текущего тарифа ElevenLabs', { exact: true })
    .check();
  await eleven
    .getByRole('button', { name: 'Сохранить подключение ElevenLabs', exact: true })
    .click();
  await expect(
    eleven.getByText('Ключ: настроен · подключение включено', { exact: true }),
  ).toBeVisible();
  const operational = page
    .getByRole('heading', { name: 'Настройки адаптации', exact: true })
    .locator('..');
  await operational
    .getByLabel('Генерировать варианты дополнительных заданий', { exact: true })
    .check();
  await operational.getByLabel('Разрешить озвучивание ElevenLabs', { exact: true }).check();
  await operational
    .getByLabel('Добавлять listening-варианты при генерации', { exact: true })
    .check();
  for (const label of ['Лимит в день, USD', 'Лимит в месяц, USD', 'На одного ученика в день, USD'])
    await operational.getByLabel(label, { exact: true }).fill('1');
  await operational.getByLabel('Запросов на ученика в день', { exact: true }).fill('20');
  await operational.getByLabel('Максимум символов озвучивания', { exact: true }).fill('2000');
  await operational
    .getByRole('button', { name: 'Сохранить настройки адаптации', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Настройки сохранены' })).toBeVisible();
  await page.goto('/admin');
  const email = `operator-in-browser-${Date.now()}@example.test`;
  await page.getByLabel('Почта нового пользователя').fill(email);
  await page.getByLabel('Имя нового пользователя').fill('Администратор адаптации');
  await page.getByLabel('Роль нового пользователя').selectOption('admin');
  await page.getByRole('button', { name: 'Создать и показать QR-код', exact: true }).click();
  await expect(page.getByAltText('QR-код Authenticator пользователя')).toBeVisible();
  const key = (await page.getByTestId('admin-manual-key').textContent())!.trim();
  const operator = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' }),
    student = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const admin = await operator.newPage();
    await ordinaryLogin(admin, email, key, 'Кабинет администратора');
    await admin.getByRole('link', { name: 'AI, озвучивание и расходы →', exact: true }).click();
    await expect(
      admin.getByRole('heading', { name: 'Ограничения суперадмина', exact: true }),
    ).toHaveCount(0);
    await expect(admin.getByLabel('Новый ключ OpenAI', { exact: true })).toHaveCount(0);
    await admin.getByLabel('Повторение через, часы', { exact: true }).fill('24');
    await admin.getByRole('button', { name: 'Сохранить настройки адаптации', exact: true }).click();
    await expect(
      admin.getByRole('status').filter({ hasText: 'Настройки сохранены' }),
    ).toBeVisible();
    expect((await admin.request.get('/api/v1/admin/accounts')).status()).toBe(403);
    const learner = await student.newPage();
    await login(learner, 'adapt-listening');
    await diagnostic(learner, 'ru');
    await learner.getByRole('button', { name: 'Начать следующее назначение', exact: true }).click();
    await completeLesson(learner, false);
    await learner
      .getByRole('button', { name: 'Начать дополнительную практику', exact: true })
      .click();
    await expect(
      learner.getByText(
        'Сгенерированный демонстрационный вариант задания. Результат предварительный.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(learner.getByText('Здравствуйте. Меня зовут Анна.', { exact: true })).toHaveCount(
      0,
    );
    await learner.getByRole('button', { name: 'Подготовить аудиозадание', exact: true }).click();
    await expect(learner.locator('audio')).toBeVisible();
    await expect
      .poll(() => learner.locator('audio').evaluate((a: HTMLAudioElement) => a.readyState))
      .toBeGreaterThanOrEqual(2);
    await learner.locator('audio').evaluate((a: HTMLAudioElement) => a.play());
    await expect
      .poll(() => learner.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(0);
    await learner.reload();
    await expect(learner.locator('audio')).toBeVisible();
    await expect(
      learner.getByRole('button', { name: 'Подготовить аудиозадание', exact: true }),
    ).toHaveCount(0);
    await learner.getByRole('radio', { name: 'Анна', exact: true }).check();
    await learner.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await learner.getByRole('button', { name: 'Завершить урок', exact: true }).click();
    await learner
      .getByRole('link', { name: 'Вернуться к индивидуальному плану →', exact: true })
      .click();
    await expect(
      learner.getByTestId('plan-change').filter({ hasText: 'Самостоятельный успех' }).first(),
    ).toBeVisible();
    const requests = (await (await page.request.get('/api/v1/admin/providers/requests')).json())
      .data.items;
    expect(requests.filter((r: { kind: string }) => r.kind === 'adaptive_exercise')).toHaveLength(
      1,
    );
    expect(requests.filter((r: { kind: string }) => r.kind === 'listening')).toHaveLength(1);
    expect(requests.find((r: { kind: string }) => r.kind === 'adaptive_exercise').provider).toBe(
      'neuroapi',
    );
    await page.goto('/admin/providers');
    await page.screenshot({ path: 'test-results/provider-settings.png', fullPage: true });
    providerSettingsSchema.parse(
      (await (await page.request.get('/api/v1/admin/providers')).json()).data,
    );
  } finally {
    await operator.close();
    await student.close();
  }
});
