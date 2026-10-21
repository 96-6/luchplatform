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
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { aiControlsSchema, aiCeilingsSchema } from '@luch/contracts';
async function login(page: Page, prefix: string, offset = 0) {
  const email = `${prefix}-${test.info().retry}@example.test`,
    keys = JSON.parse(
      await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
    );
  await page.request.post('/__e2e/isolate', {
    headers: { 'x-e2e-fixture': keys.testIsolationToken },
  });
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
  const res = await apiPasswordLogin(page, {
    data: { email, code, captcha: { id: captcha.id, answer: 'ABCDE' } },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto('/student');
}
async function start(page: Page, language: 'ru' | 'en' = 'ru', purpose = 'practice') {
  const session = (await (await page.request.get('/api/v1/auth/session')).json()).data;
  const r = await page.request.post('/api/v1/engine/runs', {
    headers: { 'x-csrf-token': session.csrfToken },
    data: {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: language === 'ru' ? 'rki-01' : 'english-01', purpose },
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  const run = (await r.json()).data;
  await page.goto(`/learning/runs/${run.run.id}`);
  return run;
}
test('avatar preferences and contextual chat survive reload and another login in both languages', async ({
  page,
}) => {
  for (const language of ['ru', 'en'] as const) {
    await login(page, `assistant-${language}`);
    await page.goto('/assistant');
    await page.getByRole('radio', { name: 'Алекс' }).check();
    await page.getByLabel('Голос персонажа для видео').selectOption('guide');
    await page.getByLabel('Обращение', { exact: true }).selectOption('informal');
    await page.getByLabel('Темп видео').selectOption('slow');
    await page.getByRole('button', { name: 'Сохранить помощника', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Помощник сохранён' })).toBeVisible();
    const run = await start(page, language),
      panel = page.getByRole('region', { name: 'Чат с помощником' });
    await panel.getByRole('button', { name: 'Объяснить задание', exact: true }).click();
    await expect(panel.getByRole('log')).toContainText(run.current.exercise.instruction);
    await panel.getByRole('button', { name: 'Подсказка помощника', exact: true }).click();
    await expect(panel.getByRole('log')).toContainText('Подсказка к текущему заданию');
    await panel.getByRole('button', { name: 'Диалог по теме', exact: true }).click();
    await expect(panel.getByRole('log')).toContainText('Тема —');
    await page.reload();
    await expect(panel.locator('.chat-message')).toHaveCount(6);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await login(page, `assistant-${language}`, 30_000);
    await page.goto(`/learning/runs/${run.run.id}`);
    await expect(panel.locator('.chat-message')).toHaveCount(6);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole('heading', { name: 'Демо-помощник', exact: true })).toBeVisible();
    await page.goto('/assistant');
    await expect(page.getByRole('radio', { name: 'Алекс' })).toBeChecked();
    await expect(page.getByLabel('Голос персонажа для видео')).toHaveValue('guide');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  }
});
test('assistant shows waiting and errors, safely repeats a lost reply and disables exam hints', async ({
  page,
}) => {
  await login(page, 'assistant-error');
  const run = await start(page),
    panel = page.getByRole('region', { name: 'Чат с помощником' });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let intercepted = false;
  await page.route('**/api/v1/assistant/runs/*/messages', async (route) => {
    if (route.request().method() === 'POST' && !intercepted) {
      intercepted = true;
      await route.fetch();
      await gate;
      await route.abort('failed');
    } else await route.continue();
  });
  await panel.getByRole('button', { name: 'Объяснить задание', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'Помощник готовит ответ' }),
  ).toBeVisible();
  release();
  await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(panel.locator('.chat-message')).toHaveCount(2);
  expect(
    (await (await page.request.get(`/api/v1/assistant/runs/${run.run.id}/messages`)).json()).data
      .messages,
  ).toHaveLength(2);
  await page.unroute('**/api/v1/assistant/runs/*/messages');
  await start(page, 'ru', 'control');
  await expect(
    panel.getByRole('button', { name: 'Подсказка помощника', exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Диалог по теме', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Объяснить задание', exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Учебные подсказки и диалог здесь отключены');
});
test('superadmin configures HeyGen and a saved video plays after generation is turned off', async ({
  page,
}) => {
  await login(page, 'assistant-admin');
  const session = (await (await page.request.get('/api/v1/auth/session')).json()).data,
    headers = { 'x-csrf-token': session.csrfToken };
  let config = (await (await page.request.get('/api/v1/admin/providers')).json()).data;
  config = (
    await (
      await page.request.post('/api/v1/admin/providers/ceilings', {
        headers,
        data: {
          revision: config.revision,
          ceilings: aiCeilingsSchema.parse({
            ...config.ceilings,
            lifetimeMicros: 10_000_000,
            dailyMicros: 10_000_000,
            monthlyMicros: 10_000_000,
            perUserDailyMicros: 10_000_000,
            requestsPerUserDay: 50,
            maxVideoCharacters: 1200,
            maxVideoSeconds: 300,
          }),
        },
      })
    ).json()
  ).data;
  await page.goto('/admin/providers');
  await expect(
    page.getByRole('heading', { name: 'Персонажи и голоса HeyGen', exact: true }),
  ).toBeVisible();
  for (const id of ['mentor', 'partner', 'guide']) {
    await page.locator(`#heygen-${id}-avatarId`).fill(`${id}-avatar`);
    await page.locator(`#heygen-${id}-voiceRu`).fill(`${id}-ru`);
    await page.locator(`#heygen-${id}-voiceEn`).fill(`${id}-en`);
  }
  await page.getByRole('button', { name: 'Сохранить персонажей HeyGen', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Персонажи сохранены' })).toBeVisible();
  const card = page.getByTestId('provider-heygen');
  await card.getByLabel('Включить HeyGen', { exact: true }).check();
  await card.getByLabel('Верхняя цена HeyGen, USD за минуту видео', { exact: true }).fill('1');
  await card.getByLabel('Новый ключ HeyGen', { exact: true }).fill(randomBytes(24).toString('hex'));
  await card.getByLabel('Подтверждаю верхние цены текущего тарифа HeyGen', { exact: true }).check();
  await card.getByRole('button', { name: 'Сохранить подключение HeyGen', exact: true }).click();
  await expect(card).toContainText('Ключ: настроен');
  config = (await (await page.request.get('/api/v1/admin/providers')).json()).data;
  const r = await page.request.post('/api/v1/admin/providers/controls', {
    headers,
    data: {
      revision: config.revision,
      controls: aiControlsSchema.parse({
        ...config.controls,
        videoEnabled: true,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 50,
        maxVideoCharacters: 1200,
        maxVideoSeconds: 300,
      }),
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  await start(page);
  const panel = page.getByRole('region', { name: 'Чат с помощником' });
  await panel.getByRole('button', { name: 'Объяснить задание', exact: true }).click();
  await panel.getByRole('button', { name: 'Видео с аватаром', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'HeyGen готовит видео' })).toBeVisible();
  const video = panel.locator('video');
  await expect(video).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  config = (await (await page.request.get('/api/v1/admin/providers')).json()).data;
  expect(
    (
      await page.request.post('/api/v1/admin/providers/controls', {
        headers,
        data: { revision: config.revision, controls: { ...config.controls, videoEnabled: false } },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await expect(video).toBeVisible();
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
});
