import { test, expect, type Page } from '@playwright/test';
import { login, link, root, csrf, keys, preparePlan } from './meetings.helpers';
import { resolve } from 'node:path';

async function ready(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('page-status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
}
test('all four roles can open every visible navigation item and mobile menus without dead pages', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const variants = [
    { prefix: 'audit-student', dashboard: /\/student$/, mobile: '/progress' },
    { prefix: 'audit-tutor', dashboard: /\/teacher$/, mobile: '/plan' },
    { prefix: 'audit-admin', dashboard: /\/operations$/, mobile: '/schedule' },
    { prefix: 'audit-superadmin', dashboard: /\/admin$/, mobile: '/operations' },
  ];
  for (const v of variants) {
    const context = await browser.newContext({ locale: 'ru-RU' });
    try {
      const page = await context.newPage(),
        failures: string[] = [];
      page.on('pageerror', (e) => failures.push(e.message));
      await login(page, v.prefix, 0, v.dashboard);
      await ready(page);
      const nav = page.getByRole('navigation', { name: 'Основная навигация' });
      const hrefs = await nav
        .locator('a')
        .evaluateAll((links) => links.map((a) => a.getAttribute('href')!));
      expect(new Set(hrefs).size).toBe(hrefs.length);
      if (v.prefix === 'audit-admin')
        expect(hrefs).not.toEqual(expect.arrayContaining(['/learning', '/assistant', '/progress']));
      for (const href of hrefs) {
        await nav.locator(`a[href="${href}"]`).click();
        await ready(page);
      }
      // Preview is usable for staff and never offers an action that creates an invalid staff run.
      await page.goto('/courses');
      await page.getByRole('link', { name: 'Открыть маршрут →', exact: true }).first().click();
      await page.getByRole('link', { name: 'Посмотреть урок →' }).first().click();
      await ready(page);
      if (v.prefix !== 'audit-student')
        await expect(
          page.getByRole('button', { name: 'Начать или продолжить тренировку' }),
        ).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      await nav.locator(`a[href="${v.mobile}"]`).click();
      await ready(page);
      await expect(page.getByRole('button', { name: 'Открыть меню' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
test('teacher and superadmin choose a student in the UI; revoking assignment immediately closes old links', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const sc = await browser.newContext({ locale: 'ru-RU' }),
    tc = await browser.newContext({ locale: 'ru-RU' }),
    rc = await browser.newContext({ locale: 'ru-RU' });
  try {
    const student = await sc.newPage(),
      teacher = await tc.newPage(),
      admin = await rc.newPage();
    const s = await login(student, 'audit-select-student'),
      t = await login(teacher, 'audit-select-tutor');
    await link(browser, t.user.id, [s.user.id]);
    await root(admin);
    for (const path of ['/plan', '/onboarding', '/assistant', '/progress']) {
      await teacher.goto(path);
      await teacher.getByLabel('Найти ученика', { exact: true }).fill(s.user.email);
      await teacher.getByRole('link', { name: 'Открыть →', exact: true }).click();
      await ready(teacher);
      expect(new URL(teacher.url()).searchParams.get('userId')).toBe(s.user.id);
    }
    await expect(teacher.getByTestId('report-reviewer')).toBeVisible();
    await admin.goto('/progress');
    await admin.getByLabel('Найти ученика', { exact: true }).fill(s.user.email);
    await admin.getByRole('link', { name: 'Открыть →', exact: true }).click();
    await ready(admin);
    await admin.goto('/admin');
    await admin.getByLabel('Найти аккаунт', { exact: true }).fill(s.user.email);
    await admin.getByRole('button', { name: 'Найти', exact: true }).click();
    await admin.getByRole('button', { name: `Открыть ${s.user.email}`, exact: true }).click();
    const removed = admin.waitForResponse(
      (r) => r.url().endsWith('/api/v1/admin/teacher-students/remove') && r.status() === 200,
    );
    await admin
      .getByRole('button', { name: `Снять закрепление ${t.user.email}`, exact: true })
      .click();
    await removed;
    await expect(
      admin.getByRole('button', { name: `Снять закрепление ${t.user.email}`, exact: true }),
    ).toHaveCount(0);
    const old = await teacher.goto(`/progress?userId=${s.user.id}`);
    expect(old?.status()).toBe(404);
    await expect(teacher.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    expect((await teacher.request.get(`/api/v1/reports/${s.user.id}`)).status()).toBe(404);
    await student.goto('/progress');
    await ready(student);
  } finally {
    await sc.close();
    await tc.close();
    await rc.close();
  }
});
test('maintenance uses the UI and persists one operation when the first response is lost', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const rc = await browser.newContext({ locale: 'ru-RU' }),
    ac = await browser.newContext({ locale: 'ru-RU' });
  try {
    const r = await rc.newPage(),
      a = await ac.newPage();
    await login(r, 'audit-maint-superadmin', 0, /\/admin$/);
    await r.goto('/operations');
    await ready(r);
    let lost = true;
    const sent: string[] = [];
    await r.route('**/api/v1/operations/actions', async (route) => {
      sent.push(route.request().postDataJSON().operationId);
      if (lost) {
        lost = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await r
      .getByRole('button', { name: 'Загрузить демонстрационные материалы', exact: true })
      .click();
    await expect(r.getByRole('alert')).toContainText('Не удалось связаться с сервером');
    await r.getByRole('button', { name: 'Повторить получение результата', exact: true }).click();
    await expect(
      r.getByRole('status').filter({ hasText: 'Демоматериалы уже загружены' }),
    ).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    await r.reload();
    await ready(r);
    await expect(r.getByRole('heading', { name: 'Последние операции' })).toBeVisible();
    const view = (await (await r.request.get('/api/v1/operations')).json()).data;
    expect(
      view.recentOperations.filter(
        (x: { kind: string; actorName: string }) =>
          x.kind === 'seed_content' && x.actorName.includes('audit-maint-superadmin'),
      ),
    ).toHaveLength(1);
    await login(a, 'audit-maint-admin', 0, /\/operations$/);
    await ready(a);
    await expect(
      a.getByRole('button', { name: 'Загрузить демонстрационные материалы', exact: true }),
    ).toHaveCount(0);
    await expect(
      a.getByText('Расширенное обслуживание и серверная консоль', { exact: true }),
    ).toHaveCount(0);
    await a
      .getByRole('button', { name: 'Восстановить обработку учебных событий', exact: true })
      .click();
    await expect(
      a.getByRole('status').filter({ hasText: 'Сохранённые учебные события обработаны' }),
    ).toBeVisible();
    expect(
      (
        await a.request.post('/api/v1/operations/actions', {
          headers: await csrf(a),
          data: { kind: 'expire_audio', operationId: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await rc.close();
    await ac.close();
  }
});
test('direct links and client navigation reject forged context while valid saved plans survive a reload', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'ru-RU' });
  try {
    const page = await context.newPage();
    await login(page, 'audit-links-student');
    const plan = await preparePlan(page, 'ru');
    const saved = await page.goto(`/plan/${plan}`);
    expect(saved?.status()).toBe(200);
    await ready(page);
    await page.reload();
    await ready(page);
    await page.evaluate(() => {
      history.pushState(null, '', '/admin');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByTestId('page-status')).toHaveAttribute('data-status', '403');
    for (const [path, status] of [
      ['/admin', 403],
      ['/admin/providers', 403],
      [`/plan/${crypto.randomUUID()}`, 404],
      ['/login?next=https%3A%2F%2Fevil.example', 400],
      ['/index.html', 404],
      ['/temporary/private.json', 404],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(status);
      await expect(page.getByRole('heading', { name: new RegExp(`^${status} ·`) })).toBeVisible();
    }
    await page.goto(`/plan/${plan}`);
    await ready(page);
  } finally {
    await context.close();
  }
});
test('verification and Authenticator pages require a live one-time link and enrollment cookie', async ({
  browser,
}) => {
  const c = await browser.newContext({ locale: 'ru-RU' }),
    stranger = await browser.newContext({ locale: 'ru-RU' });
  try {
    const page = await c.newPage();
    const k = await keys();
    await page.request.post('/__e2e/isolate', {
      headers: { 'x-e2e-fixture': k.testIsolationToken },
    });
    for (const [path, status] of [
      ['/authenticator', 401],
      ['/verify-email', 400],
    ] as const)
      expect((await page.goto(path))?.status()).toBe(status);
    const email = `audit-enrollment-${crypto.randomUUID()}@example.test`;
    const cap = (await (await page.request.get('/api/v1/auth/captcha?purpose=register')).json())
      .data;
    expect(
      (
        await page.request.post('/api/v1/auth/register', {
          data: {
            email,
            name: 'Проверка временной ссылки',
            role: 'student',
            captcha: { id: cap.id, answer: 'ABCDE' },
          },
        })
      ).status(),
    ).toBe(202);
    await page.goto(`/demo-mail?email=${encodeURIComponent(email)}`);
    const confirmation = page.getByRole('link', {
      name: 'Открыть последнее письмо подтверждения',
      exact: true,
    });
    const old = await confirmation.getAttribute('href');
    await confirmation.click();
    await page.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Подключить Authenticator', exact: true }),
    ).toBeVisible();
    await expect(page.getByAltText('QR-код подключения Authenticator')).toBeVisible();
    const attacker = await stranger.newPage();
    expect((await attacker.goto('/authenticator'))?.status()).toBe(401);
    expect((await attacker.goto(old!))?.status()).toBe(410);
    await c.clearCookies();
    expect((await page.reload())?.status()).toBe(401);
    await expect(page.getByRole('heading', { name: 'Требуется вход' })).toBeVisible();
  } finally {
    await c.close();
    await stranger.close();
  }
});
test('development server enforces the same direct-page and media access rules', async ({
  page,
}) => {
  const { createServer } = await import('vite');
  const previous = process.env.API_PORT;
  process.env.API_PORT = '3200';
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    vite = await createServer({
      root: resolve('apps/web'),
      configFile: resolve('apps/web/vite.config.ts'),
      server: { host: '127.0.0.1', port: 3210, strictPort: true },
    });
    await vite.listen();
    const dev = 'http://127.0.0.1:3210';
    for (const [path, status] of [
      ['/login', 200],
      ['/student', 401],
      ['/authenticator', 401],
      ['/temporary/private.json', 404],
      ['/index.html', 404],
      ['/login?next=https%3A%2F%2Fevil.example', 400],
    ] as const)
      expect(
        (await page.request.get(dev + path, { headers: { accept: 'text/html' } })).status(),
        path,
      ).toBe(status);
    expect((await page.request.get(dev + '/learning-media/phrases-ru-v1.txt')).status()).toBe(401);
    expect(
      (await page.request.get(dev + '/student', { headers: { accept: '*/*' } })).status(),
    ).toBe(401);
    expect(
      (
        await page.request.get(dev + '/temporary/private.json', {
          headers: { accept: 'application/json' },
        })
      ).status(),
    ).toBe(404);
    for (const file of [
      'content/demo/luch-demo.json',
      'apps/api/src/config.ts',
      'node_modules/@luch/api/src/config.ts',
      'node_modules/@luch/contracts/src/index.ts',
    ])
      expect([403, 404]).toContain(
        (
          await page.request.get(dev + '/@fs' + resolve(file), { headers: { accept: '*/*' } })
        ).status(),
      );
    await page.goto(dev + '/login');
    await expect(page.getByRole('heading', { name: 'Вход в аккаунт', exact: true })).toBeVisible();
    await login(page, 'audit-dev-student');
    expect(
      (await page.request.get(dev + '/student', { headers: { accept: 'text/html' } })).status(),
    ).toBe(200);
    expect(
      (await page.request.get(dev + '/admin', { headers: { accept: 'text/html' } })).status(),
    ).toBe(403);
    expect((await page.request.get(dev + '/learning-media/phrases-ru-v1.txt')).status()).toBe(200);
  } finally {
    await vite?.close();
    if (previous === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previous;
  }
});
