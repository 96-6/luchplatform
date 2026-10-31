import { expect, test } from '@playwright/test';
import {
  connected,
  createUI,
  csrf,
  enter,
  link,
  login,
  root,
  videoBrowser,
} from './meetings.helpers';

if (process.env.CI && !process.env.LUCH_VIDEO_TEST_ENV)
  throw new Error('CI must configure real LiveKit for VANISH acceptance.');

test('superadmin chooses VANISH, receives real media invisibly, reconnects hidden and can rejoin visibly', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'Real LiveKit is required; CI supplies the SFU.');
  test.setTimeout(150000);
  const browser = await videoBrowser(playwright);
  const options = {
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
    permissions: ['camera', 'microphone'],
  };
  try {
    const teacher = await (await browser.newContext(options)).newPage();
    const studentPage = await (await browser.newContext(options)).newPage();
    const admin = await (await browser.newContext(options)).newPage();
    const tutor = await login(teacher, 'meeting-vanish-tutor');
    const student = await login(studentPage, 'meeting-vanish-student');
    await link(browser, tutor.user.id, [student.user.id]);
    await root(admin);
    const id = await createUI(teacher, [student.user.name], 'ru', 'Проверка VANISH');
    await admin.goto(`/meetings/${id}/room`);
    await expect(admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' })).not.toBeChecked();
    await expect(admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' })).toBeDisabled();
    const t = await enter(teacher, id, true);
    await connected(teacher);
    await expect(teacher.getByText('Войти в VANISH-режиме', { exact: true })).toHaveCount(0);
    const s = await enter(studentPage, id);
    await teacher
      .getByRole('button', { name: `Допустить: ${student.user.name}`, exact: true })
      .click();
    await connected(studentPage);
    await teacher.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await teacher.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(2);
    await admin.reload();
    await admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' }).check();
    const operations: string[] = [];
    let lost = true;
    await admin.route(`**/api/v1/meetings/${id}/join`, async (route) => {
      const body = route.request().postDataJSON();
      expect(body.vanish).toBe(true);
      operations.push(body.operationId);
      if (lost) {
        lost = false;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await admin.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    await expect(admin.getByRole('alert')).toContainText('Не удалось связаться');
    await expect(admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' })).toBeDisabled();
    await admin.getByRole('button', { name: 'Повторить подключение', exact: true }).click();
    await connected(admin);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
    await admin.unroute(`**/api/v1/meetings/${id}/join`);
    await expect(admin.getByTestId('vanish-status')).toBeVisible();
    for (const name of [
      'Включить микрофон',
      'Включить камеру',
      'Демонстрация экрана',
      'Поднять руку',
    ])
      await expect(admin.getByRole('button', { name, exact: true })).toBeDisabled();
    for (const p of [teacher, studentPage, admin]) {
      await expect(p.getByTestId('meeting-participant')).toHaveCount(2);
      await expect(p.locator('.meeting-connection')).toContainText('Участников: 2');
      const state = (await (await p.request.get(`/api/v1/meetings/${id}/room-state`)).json()).data;
      expect(state.participants.map((x: { identity: string }) => x.identity).sort()).toEqual(
        [s.id, t.id].sort(),
      );
    }
    const hidden = (await (await admin.request.get(`/api/v1/meetings/${id}/room-state`)).json())
      .data.self;
    expect(hidden.vanish).toBe(true);
    await expect
      .poll(
        async () =>
          admin
            .locator(`[data-identity="${t.id}"] video`)
            .evaluateAll((es) =>
              es.some(
                (e) =>
                  (e as HTMLVideoElement).videoWidth > 0 && (e as HTMLVideoElement).readyState >= 2,
              ),
            ),
        { timeout: 20000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          admin
            .locator('audio')
            .evaluateAll((es) =>
              es.some(
                (e) =>
                  e.readyState >= 2 &&
                  (e.srcObject as MediaStream | null)
                    ?.getAudioTracks()
                    .some((t) => t.readyState === 'live'),
              ),
            ),
        { timeout: 20000 },
      )
      .toBe(true);
    await admin.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(admin.getByRole('textbox', { name: 'Сообщение' })).toHaveCount(0);
    const denied = await admin.request.post(`/api/v1/meetings/${id}/messages`, {
      headers: await csrf(admin),
      data: { operationId: crypto.randomUUID(), text: 'Запрещено в VANISH' },
    });
    expect(denied.status()).toBe(403);
    await admin.reload();
    await admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' }).check();
    await admin.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    await connected(admin);
    expect(
      (await (await admin.request.get(`/api/v1/meetings/${id}/room-state`)).json()).data.self.id,
    ).toBe(hidden.id);
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(2);
    await admin.setViewportSize({ width: 390, height: 844 });
    await admin.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    await admin.getByLabel('Язык интерфейса', { exact: true }).selectOption('en');
    await admin.getByRole('button', { name: 'Close menu', exact: true }).click();
    await expect(admin.getByTestId('vanish-status')).toContainText('VANISH mode is active');
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await admin.screenshot({ path: 'test-results/meeting-vanish-en-mobile.png', fullPage: true });
    await admin.getByRole('button', { name: 'Open menu', exact: true }).click();
    await admin.getByLabel('Interface language', { exact: true }).selectOption('ru');
    await admin.getByRole('button', { name: 'Закрыть меню', exact: true }).click();
    await admin.getByRole('button', { name: 'Покинуть встречу', exact: true }).click();
    await expect(admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' })).toBeVisible();
    await admin.getByRole('checkbox', { name: 'Войти в VANISH-режиме' }).uncheck();
    await admin.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    await connected(admin);
    await expect(admin.getByTestId('vanish-status')).toHaveCount(0);
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(3);
    await admin.getByRole('button', { name: 'Покинуть встречу', exact: true }).click();
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(2);
  } finally {
    await browser.close();
  }
});
