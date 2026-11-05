import { expect, test, type Page } from '@playwright/test';
import { csrf, login, root } from './meetings.helpers';

async function policy(page: Page, patch: Record<string, unknown>) {
  const current = await page.request.get('/api/v1/admin/client-protection');
  expect(current.status()).toBe(200);
  const response = await page.request.post('/api/v1/admin/client-protection', {
    headers: await csrf(page),
    data: { ...(await current.json()).data, ...patch },
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function refresh(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('luch:client-check')));
}
async function restricted(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('#content')!;
    const events = (element: Element) =>
      !element.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true }),
      );
    const input = document.createElement('textarea');
    const link = document.createElement('a');
    link.href = '/';
    content.append(input, link);
    const f12 = !document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true, cancelable: true }),
    );
    const inspect = !document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'I',
        code: 'KeyI',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const copy = !input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const result = {
      content: events(content),
      editable: events(input),
      link: events(link),
      f12,
      inspect,
      copy,
    };
    input.remove();
    link.remove();
    return result;
  });
}
test('superadmin saves independent role lists, defaults and English mobile settings', async ({
  page,
}) => {
  await root(page);
  try {
    await page.goto('/admin?tab=security');
    const panel = page.getByRole('region', { name: 'Защита функций браузера', exact: true });
    const interaction = panel.getByRole('group', {
      name: 'Ограничение правого клика и F12',
      exact: true,
    });
    const blockers = panel.getByRole('group', { name: 'Защита от блокировщиков', exact: true });
    await expect(
      interaction.getByRole('checkbox', { name: 'Включить ограничение правого клика и F12' }),
    ).not.toBeChecked();
    await expect(
      blockers.getByRole('checkbox', { name: 'Включить защиту от блокировщиков' }),
    ).not.toBeChecked();
    await interaction
      .getByRole('checkbox', { name: 'Включить ограничение правого клика и F12' })
      .check();
    await interaction.getByRole('checkbox', { name: 'Ученик', exact: true }).uncheck();
    await blockers.getByRole('checkbox', { name: 'Включить защиту от блокировщиков' }).check();
    await blockers.getByRole('checkbox', { name: 'Преподаватель', exact: true }).uncheck();
    await panel.getByRole('button', { name: 'Сохранить защиту функций браузера' }).click();
    await expect(panel.getByRole('status')).toHaveText(
      'Настройки защиты функций браузера сохранены.',
    );
    await page.reload();
    await expect(
      interaction.getByRole('checkbox', { name: 'Ученик', exact: true }),
    ).not.toBeChecked();
    await expect(
      interaction.getByRole('checkbox', { name: 'Преподаватель', exact: true }),
    ).toBeChecked();
    await expect(blockers.getByRole('checkbox', { name: 'Ученик', exact: true })).toBeChecked();
    await expect(
      blockers.getByRole('checkbox', { name: 'Преподаватель', exact: true }),
    ).not.toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    await page.getByLabel('Язык интерфейса', { exact: true }).selectOption('en');
    const english = page.getByRole('region', { name: 'Browser feature protection', exact: true });
    await expect(english).toContainText('Superadmins are exempt');
    await expect(english).toContainText('Cannot detect every extension');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await english.screenshot({ path: 'test-results/client-protection-settings-mobile.png' });
  } finally {
    await policy(page, {
      interactionEnabled: false,
      blockersEnabled: false,
      interactionRoles: ['student', 'teacher'],
      blockersRoles: ['student', 'teacher'],
    });
  }
});

test('student and teacher shortcuts and content menus follow roles without disabling editing or links', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const studentContext = await browser.newContext({
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
  });
  const teacherContext = await browser.newContext({
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
  });
  const student = await studentContext.newPage(),
    teacher = await teacherContext.newPage();
  await root(page);
  try {
    await student.route('**/api/v1/security/client/runtime.js*', (route) =>
      route.abort('blockedbyclient'),
    );
    await login(student, 'client-protection-student');
    await login(teacher, 'client-protection-tutor');
    await expect.poll(() => restricted(student)).toMatchObject({ content: false, f12: false });
    await policy(page, { interactionEnabled: true, interactionRoles: ['student', 'teacher'] });
    await refresh(student);
    await refresh(teacher);
    const expected = {
      content: true,
      editable: false,
      link: false,
      f12: true,
      inspect: true,
      copy: false,
    };
    await expect.poll(() => restricted(student)).toEqual(expected);
    await expect.poll(() => restricted(teacher)).toEqual(expected);
    await expect.poll(() => restricted(page)).toMatchObject({ content: false, f12: false });
    await student.evaluate(() => {
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'F12')
            document.documentElement.setAttribute(
              'data-f12-cancelled',
              String(event.defaultPrevented),
            );
        },
        true,
      );
    });
    await student.keyboard.press('F12');
    await expect(student.locator('html')).toHaveAttribute('data-f12-cancelled', 'true');
    await policy(page, { interactionRoles: ['teacher'] });
    await refresh(student);
    await refresh(teacher);
    await expect.poll(() => restricted(student)).toMatchObject({ content: false, f12: false });
    await expect.poll(() => restricted(teacher)).toEqual(expected);
  } finally {
    await policy(page, { interactionEnabled: false, interactionRoles: ['student', 'teacher'] });
    await studentContext.close();
    await teacherContext.close();
  }
});

test('blocked scripts or filtering styles deny selected roles, recover without losing session, and render 403 with JavaScript disabled', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  const teacherContext = await browser.newContext({
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
  });
  const student = await context.newPage(),
    teacher = await teacherContext.newPage();
  await root(page);
  try {
    await login(student, 'client-blockers-student');
    await login(teacher, 'client-blockers-tutor');
    await policy(page, { blockersEnabled: true, blockersRoles: ['student'] });
    await refresh(student);
    await expect.poll(async () => (await student.request.get('/api/v1/system')).status()).toBe(200);
    expect((await context.cookies()).find((c) => c.name === 'luch_client')?.httpOnly).toBe(true);
    const withoutJS = await browser.newContext({
      javaScriptEnabled: false,
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
    });
    try {
      await withoutJS.addCookies((await context.cookies()).filter((c) => c.name !== 'luch_client'));
      const nojs = await withoutJS.newPage();
      const denied = await nojs.goto('/student');
      expect(denied!.status()).toBe(403);
      await expect(nojs.getByRole('heading', { name: 'Доступ запрещён' })).toBeVisible();
      await expect(
        nojs.getByRole('button', { name: 'Повторить проверку', exact: true }),
      ).toBeVisible();
      await nojs.screenshot({ path: 'test-results/client-protection-no-javascript.png' });
    } finally {
      await withoutJS.close();
    }
    await student.route('**/api/v1/security/client/ads.js*', (route) =>
      route.abort('blockedbyclient'),
    );
    await refresh(student);
    await expect(student.getByRole('alert', { name: 'Доступ запрещён' })).toBeVisible({
      timeout: 25000,
    });
    expect((await student.request.get('/api/v1/system')).status()).toBe(403);
    await teacher.route('**/api/v1/security/client/ads.js*', (route) =>
      route.abort('blockedbyclient'),
    );
    await refresh(teacher);
    expect((await teacher.request.get('/api/v1/system')).status()).toBe(200);
    expect((await page.request.get('/api/v1/admin/client-protection')).status()).toBe(200);
    await student.unroute('**/api/v1/security/client/ads.js*');
    await student.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
    await expect(student.getByRole('alert', { name: 'Доступ запрещён' })).toHaveCount(0);
    expect((await student.request.get('/api/v1/system')).status()).toBe(200);
    const sessionBefore = (await (await student.request.get('/api/v1/auth/session')).json()).data
      .user.id;
    await student.route('**/api/v1/security/client/probe.css', (route) =>
      route.fulfill({
        contentType: 'text/css',
        body: '.luch-client-control,.luch-client-probe{position:fixed;left:-10000px;top:0;width:4px;height:4px}.adsbox{display:none!important}',
      }),
    );
    await refresh(student);
    await expect(student.getByRole('alert', { name: 'Доступ запрещён' })).toBeVisible();
    expect((await student.request.get('/api/v1/system')).status()).toBe(403);
    await student.unroute('**/api/v1/security/client/probe.css');
    await student.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
    await expect(student.getByRole('alert', { name: 'Доступ запрещён' })).toHaveCount(0);
    await context.clearCookies({ name: 'luch_client' });
    const response = await student.goto('/student');
    expect(response!.status()).toBe(403);
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible();
    expect((await (await student.request.get('/api/v1/auth/session')).json()).data.user.id).toBe(
      sessionBefore,
    );
  } finally {
    await policy(page, { blockersEnabled: false, blockersRoles: ['student', 'teacher'] });
    await context.close();
    await teacherContext.close();
  }
});
