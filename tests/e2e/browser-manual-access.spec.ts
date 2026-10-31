import { expect, test, type Page } from '@playwright/test';
import { csrf, keys, root } from './meetings.helpers';
const blockedUA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 YaBrowser/26.10.0.0 Yowser/2.5';
async function create(p: Page, label: string, type = 'multiple') {
  await p.goto('/admin?tab=security');
  const panel = p.getByRole('region', { name: 'Разрешить вход вручную', exact: true });
  await panel.getByLabel('Название ссылки', { exact: true }).fill(label);
  await panel.getByLabel('Тип ссылки', { exact: true }).selectOption(type);
  await panel.getByRole('button', { name: 'Создать ссылку ручного допуска', exact: true }).click();
  await expect(panel.getByText('Ссылка ручного допуска создана.', { exact: true })).toBeVisible();
  const url = await panel.getByLabel('Созданная ссылка', { exact: true }).inputValue();
  return {
    panel,
    url,
    card: panel
      .getByTestId('browser-access-link')
      .filter({ has: p.getByRole('heading', { name: label, exact: true }) }),
  };
}
async function reset(p: Page) {
  const k = await keys();
  expect(
    (
      await p.request.post('/__e2e/browser-policy-reset', {
        headers: { 'x-e2e-fixture': k.testIsolationToken },
      })
    ).status(),
  ).toBe(204);
}

test('superadmin issues reusable access, remembers a blocked browser without JavaScript and revokes individual permits and the link', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  await root(page);
  const { panel, url, card } = await create(page, 'Ручной допуск группы');
  const policy = (await (await page.request.get('/api/v1/admin/browser-policy')).json()).data;
  const save = await page.request.post('/api/v1/admin/browser-policy', {
    headers: await csrf(page),
    data: { ...policy, enhancedEnabled: true },
  });
  expect(save.status(), await save.text()).toBe(200);
  const a = await browser.newContext({
    locale: 'ru-RU',
    userAgent: blockedUA,
    javaScriptEnabled: false,
    baseURL: 'http://127.0.0.1:3200',
  });
  const b = await browser.newContext({
    locale: 'ru-RU',
    userAgent: blockedUA,
    baseURL: 'http://127.0.0.1:3200',
  });
  try {
    const first = await a.newPage();
    await first.goto(url);
    await first
      .getByLabel('Название устройства (необязательно)', { exact: true })
      .fill('Рабочий ноутбук');
    await first.getByRole('button', { name: 'Разрешить этот браузер', exact: true }).click();
    await expect(first).toHaveURL('http://127.0.0.1:3200/');
    expect(
      (await (await first.request.get('/api/v1/security/browser/bootstrap')).json()).data.decision
        .reason,
    ).toBe('manual');
    const storage = await a.storageState();
    await a.close();
    const restored = await browser.newContext({
      locale: 'ru-RU',
      userAgent: blockedUA,
      baseURL: 'http://127.0.0.1:3200',
      storageState: storage,
    });
    try {
      const remembered = await restored.newPage();
      await remembered.goto('/login');
      await expect(
        remembered.getByRole('heading', { name: 'Вход в аккаунт', exact: true }),
      ).toBeVisible();
      expect((await remembered.request.get('/api/v1/admin/browser-access-links')).status()).toBe(
        401,
      );
      const second = await b.newPage();
      await second.goto('/login');
      await expect(
        second.getByText('Ваш браузер несовместим с платформой', { exact: true }),
      ).toBeVisible();
      await second.goto(url);
      await second
        .getByLabel('Название устройства (необязательно)', { exact: true })
        .fill('Личный компьютер');
      await second.getByRole('button', { name: 'Разрешить этот браузер', exact: true }).click();
      await expect(second).toHaveURL('http://127.0.0.1:3200/');
      await second.goto('/login');
      await expect(
        second.getByRole('heading', { name: 'Вход в аккаунт', exact: true }),
      ).toBeVisible();
      await panel.getByRole('button', { name: 'Обновить ручные допуски', exact: true }).click();
      await expect(
        card.getByRole('button', { name: 'Запомнено: 2 · Активно: 2', exact: true }),
      ).toBeVisible();
      if (
        (await card
          .getByRole('button', { name: 'Запомнено: 2 · Активно: 2', exact: true })
          .getAttribute('aria-expanded')) === 'false'
      )
        await card.getByRole('button', { name: 'Запомнено: 2 · Активно: 2', exact: true }).click();
      await expect(card.getByText(/Создал:/)).toBeVisible();
      await expect(
        card.getByRole('heading', { name: 'Рабочий ноутбук', exact: true }),
      ).toBeVisible();
      await card
        .getByRole('button', { name: 'Отозвать допуск: Рабочий ноутбук', exact: true })
        .click();
      await remembered.reload();
      await expect(
        remembered.getByText('Ваш браузер несовместим с платформой', { exact: true }),
      ).toBeVisible();
      await second.reload();
      await expect(
        second.getByRole('heading', { name: 'Вход в аккаунт', exact: true }),
      ).toBeVisible();
      await card.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
      await card.getByRole('button', { name: 'Подтвердить отзыв ссылки', exact: true }).click();
      await expect(panel.getByText('Ссылка и её допуски отозваны.', { exact: true })).toBeVisible();
      await second.reload();
      await expect(
        second.getByText('Ваш браузер несовместим с платформой', { exact: true }),
      ).toBeVisible();
    } finally {
      await restored.close();
    }
  } finally {
    await a.close().catch(() => {});
    await b.close();
    await reset(page);
  }
});
test('single-use link is not spent by opening and cannot remember a second browser', async ({
  page,
  browser,
}) => {
  await root(page);
  const { url, card, panel } = await create(page, 'Одно устройство', 'single');
  const contexts = await Promise.all([
    browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' }),
    browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' }),
  ]);
  try {
    const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
    await Promise.all([a!.goto(url), b!.goto(url)]);
    await panel.getByRole('button', { name: 'Обновить ручные допуски', exact: true }).click();
    await expect(
      card.getByRole('button', { name: 'Запомнено: 0 · Активно: 0', exact: true }),
    ).toBeVisible();
    await a!.getByRole('button', { name: 'Разрешить этот браузер', exact: true }).click();
    await expect(a!).toHaveURL('http://127.0.0.1:3200/');
    await b!.getByRole('button', { name: 'Разрешить этот браузер', exact: true }).click();
    await expect(
      b!.getByText('Ссылка ручного допуска недоступна. Запросите новую ссылку у суперадмина.', {
        exact: true,
      }),
    ).toBeVisible();
    await a!.goto(url);
    await expect(
      a!.getByText('Этот браузер уже запомнен. Можно перейти на платформу.', { exact: true }),
    ).toBeVisible();
  } finally {
    for (const c of contexts) await c.close();
  }
});
test('lost creation response reuses one link and manual access controls fit an English mobile screen', async ({
  page,
}) => {
  await root(page);
  await page.goto('/admin?tab=security');
  const panel = page.getByRole('region', { name: 'Разрешить вход вручную', exact: true });
  await panel.getByLabel('Название ссылки', { exact: true }).fill('Повтор создания');
  let lost = true;
  const ops: string[] = [];
  await page.route('**/api/v1/admin/browser-access-links', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ops.push(route.request().postDataJSON().operationId);
    if (lost) {
      lost = false;
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await panel.getByRole('button', { name: 'Создать ссылку ручного допуска', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Не удалось связаться');
  await panel.getByRole('button', { name: 'Повторить создание ссылки', exact: true }).click();
  await expect(panel.getByText('Ссылка ручного допуска создана.', { exact: true })).toBeVisible();
  expect(ops).toHaveLength(2);
  expect(ops[0]).toBe(ops[1]);
  await page.unroute('**/api/v1/admin/browser-access-links');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await page.getByLabel('Язык интерфейса', { exact: true }).selectOption('en');
  const english = page.getByRole('region', { name: 'Allow browser access manually', exact: true });
  await expect(
    english.getByRole('heading', { name: 'Повтор создания', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await english.getByLabel('Link name', { exact: true }).focus();
  await english.evaluate((e) =>
    window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 82),
  );
  await page.screenshot({ path: 'test-results/browser-manual-access-en-mobile.png' });
});
