import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { contentPackageSchema } from '@luch/contracts';

async function enroll(page: Page, email: string, register = true) {
  const captcha = async (purpose: string) => {
    const response = await page.request.get(`/api/v1/auth/captcha?purpose=${purpose}`);
    return { id: (await response.json()).data.id, answer: 'ABCDE' };
  };
  if (register) {
    const response = await page.request.post('/api/v1/auth/register', {
      data: { email, name: 'Ученик контента', role: 'student', captcha: await captcha('register') },
    });
    expect(response.status()).toBe(202);
  }
  const inbox = await page.request.get(`/api/v1/dev/mail?email=${encodeURIComponent(email)}`);
  const link = new URL((await inbox.json()).data[0].verificationUrl);
  expect(
    (
      await page.request.post('/api/v1/auth/verify-email', {
        data: { token: link.searchParams.get('token') },
      })
    ).status(),
  ).toBe(200);
  const response = await page.request.get('/api/v1/auth/enrollment');
  const key = (await response.json()).data.manualKey as string;
  const code = new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(key),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
  expect(
    (
      await page.request.post('/api/v1/auth/enrollment/confirm', {
        data: { code, captcha: await captcha('enrollment') },
      })
    ).status(),
  ).toBe(200);
}

test('a student reads both database routes, lesson media and distinct exercise banks', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await enroll(page, `content-reader-${Date.now()}@example.test`);
  await page.goto('/student');
  await page.getByRole('link', { name: 'Учебные маршруты →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Языковые маршруты' })).toBeVisible();
  for (const title of ['Русский как иностранный', 'Английский']) {
    const card = page
      .locator('.course-grid .panel')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toContainText('6 коротких уроков');
    await card.getByRole('link', { name: 'Открыть маршрут →' }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('.lesson-list > li')).toHaveCount(6);
    await page.getByRole('link', { name: 'Посмотреть урок →' }).first().click();
    await expect(page.getByRole('heading', { name: 'Короткое объяснение' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Слова и фразы' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Пример диалога' })).toBeVisible();
    const image = page.locator('.lesson-image');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
    const file = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Скачать фразы для знакомства' }).click();
    const downloaded = await file;
    expect(await downloaded.failure()).toBeNull();
    expect(await readFile((await downloaded.path())!, 'utf8')).toContain(
      title === 'Английский' ? 'My name is Anna.' : 'Меня зовут Анна.',
    );
    await expect(page.locator('.exercise-preview')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Диагностика', exact: true }).click();
    await expect(page.locator('.exercise-preview')).toHaveCount(1);
    const diagnostic = await page.locator('.exercise-preview').textContent();
    await page.getByRole('tab', { name: 'Контроль', exact: true }).click();
    await expect(page.locator('.exercise-preview')).toHaveCount(1);
    await expect(page.locator('.exercise-preview')).not.toHaveText(diagnostic!);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Контроль', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await page.getByRole('button', { name: /Проверить ответ|Подсказка/ }).count()).toBe(0);
    await page.goto('/courses');
  }
  expect((await page.request.get('/api/v1/admin/content/packages/luch-demo/export')).status()).toBe(
    403,
  );
  expect(failures).toEqual([]);
  await page.screenshot({ path: 'test-results/content-catalog.png', fullPage: true });
});

test('superadmin exports, reimports without duplicates and publishes a new version for students', async ({
  page,
  browser,
}) => {
  await enroll(page, 'content-admin@example.test', false);
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Учебный контент: импорт и экспорт →' }).click();
  await expect(page.getByRole('heading', { name: 'Учебный контент', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспортировать luch-demo' }).click();
  const exported = await download;
  expect(await exported.failure()).toBeNull();
  const text = await readFile((await exported.path())!, 'utf8');
  const manifest = contentPackageSchema.parse(JSON.parse(text));
  expect(manifest.lessons).toHaveLength(12);
  expect(manifest.exercises).toHaveLength(48);
  expect(manifest.exercises[0]!.solution).toBeDefined();
  await page.getByLabel('Файл контента JSON').setInputFiles({
    name: 'round-trip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await page.getByRole('button', { name: 'Импортировать пакет', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Дубликаты не созданы');
  manifest.package.version = 2;
  manifest.routes[0]!.title = 'РКИ — обновлённый демо-маршрут';
  manifest.exercises[0]!.version = 2;
  manifest.exercises[0]!.instruction = 'Обновлённое задание: выберите вежливое приветствие.';
  await page.getByLabel('Файл контента JSON').setInputFiles({
    name: 'updated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.getByRole('button', { name: 'Импортировать пакет', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Пакет загружен: 2 маршрута, 12 уроков, 48 заданий',
  );
  await expect(page.getByText('Версия 2 · Демо', { exact: true })).toBeVisible();
  const bad = structuredClone(manifest);
  bad.package.version = 3;
  bad.exercises[0]!.skillId = 'missing';
  await page.getByLabel('Файл контента JSON').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(page.getByRole('alert')).toContainText('Проверьте формат пакета');
  await expect(
    page.getByRole('button', { name: 'Импортировать пакет', exact: true }),
  ).toBeDisabled();
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const student = await context.newPage();
    await enroll(student, `content-update-${Date.now()}@example.test`);
    await student.goto('/courses');
    await expect(
      student.getByRole('heading', { name: 'РКИ — обновлённый демо-маршрут', exact: true }),
    ).toBeVisible();
    await student.goto(
      '/courses/luch-demo/rki-a1/lessons/rki-01?packageVersion=2&purpose=diagnostic',
    );
    await expect(
      student.getByText('Обновлённое задание: выберите вежливое приветствие.', { exact: true }),
    ).toBeVisible();
    const old = await student.request.get(
      '/api/v1/content/packages/luch-demo/lessons/rki-01?packageVersion=1&purpose=diagnostic',
    );
    expect(JSON.stringify((await old.json()).data)).not.toContain('Обновлённое задание');
  } finally {
    await context.close();
  }
});

test('catalog empty/error states, retry and a mobile lesson stay usable', async ({ page }) => {
  await enroll(page, `content-states-${Date.now()}@example.test`);
  await page.route('**/api/v1/content/routes', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [], requestId: 'empty' }),
    }),
  );
  await page.goto('/courses');
  await expect(page.getByRole('heading', { name: 'Материалы пока не загружены' })).toBeVisible();
  await page.unroute('**/api/v1/content/routes');
  await page.route('**/api/v1/content/routes', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Сервис временно недоступен.',
          requestId: 'retry',
        },
      }),
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Сервис временно недоступен');
  await page.unroute('**/api/v1/content/routes');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.locator('.course-grid .panel')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/courses/luch-demo/english-a1/lessons/english-01?packageVersion=1');
  await expect(
    page.getByRole('heading', { name: 'Introducing yourself', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/content-mobile.png', fullPage: true });
});
