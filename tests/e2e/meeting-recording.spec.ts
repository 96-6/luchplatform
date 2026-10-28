import { expect, test, type Page } from '@playwright/test';
import { connected, csrf, enter, login, root, videoBrowser } from './meetings.helpers';

if (process.env.CI && !process.env.LUCH_VIDEO_TEST_ENV)
  throw new Error('CI must configure real LiveKit for recording protection acceptance.');

async function setProtection(admin: Page, enabled: boolean) {
  const policy = (await (await admin.request.get('/api/v1/admin/meeting-recording-policy')).json())
    .data;
  const result = await admin.request.post('/api/v1/admin/meeting-recording-policy', {
    headers: await csrf(admin),
    data: { enabled, revision: policy.revision },
  });
  expect(result.status(), await result.text()).toBe(200);
}

test('superadmin saves recording protection and sees its limits in Russian and English on mobile', async ({
  page,
}) => {
  await root(page);
  try {
    await page.goto('/admin?tab=security');
    const settings = page.getByRole('region', { name: 'Защита видеовстреч', exact: true });
    await settings.getByRole('checkbox', { name: 'Защита от записи видеозвонка' }).check();
    await settings.getByRole('button', { name: 'Сохранить защиту видеовстреч' }).click();
    await expect(settings.getByRole('status')).toHaveText(
      'Настройки защиты видеовстреч сохранены.',
    );
    await page.reload();
    await expect(settings.getByRole('checkbox')).toBeChecked();
    await expect(settings).toContainText('Это меры сдерживания, а не DRM.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Язык интерфейса', { exact: true }).selectOption('en');
    const english = page.getByRole('region', { name: 'Meeting protection', exact: true });
    await expect(english.getByRole('checkbox')).toBeChecked();
    await expect(english).toContainText('These are deterrents, not DRM.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await english.screenshot({ path: 'test-results/meeting-protection-settings-en-mobile.png' });
  } finally {
    await setProtection(page, false);
  }
});

test('real guest media keeps personal watermarks in fullscreen, restricts printing and updates the running call', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'Real LiveKit is required; CI supplies the SFU.');
  test.setTimeout(120000);
  const browser = await videoBrowser(playwright);
  const contextOptions = {
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
    permissions: ['camera', 'microphone'],
  };
  const admin = await (await browser.newContext(contextOptions)).newPage();
  try {
    await root(admin);
    await setProtection(admin, true);
    const teacher = await (await browser.newContext(contextOptions)).newPage(),
      guest = await (await browser.newContext(contextOptions)).newPage();
    const tutor = await login(teacher, 'meeting-protection-tutor');
    const created = await teacher.request.post('/api/v1/meetings/adhoc', {
      headers: await csrf(teacher),
      data: {
        operationId: crypto.randomUUID(),
        title: 'Защищённая видеовстреча',
        language: 'ru',
        timeZone: 'Europe/Moscow',
        durationMinutes: null,
        reusable: true,
        allowGuests: true,
        expiresAt: null,
        lobbyEnabled: false,
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const { meeting, invite } = (await created.json()).data;
    const own = await enter(teacher, meeting.id, true);
    await connected(teacher);
    await guest.goto(invite.url);
    await guest.getByLabel('Ваше имя во встрече', { exact: true }).fill('Гость защиты');
    await guest.getByRole('button', { name: 'Присоединиться по приглашению', exact: true }).click();
    await expect(guest.getByRole('note')).toContainText('Веб-защита не блокирует OBS');
    const joined = guest.waitForResponse(
      (r) => r.url().endsWith(`/meetings/${meeting.id}/join`) && r.request().method() === 'POST',
    );
    await guest.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    const session = (await (await joined).json()).data.session;
    await connected(guest);
    await guest.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    const tile = teacher.locator(`[data-identity="${session.id}"]`),
      video = tile.locator('video');
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 25000 })
      .toBeGreaterThan(0);
    const mark = tile.getByTestId('recording-watermark');
    await expect(mark).toContainText(tutor.user.name);
    await expect(mark).toContainText(own.id.replaceAll('-', '').slice(0, 12));
    const guestMark = guest.getByTestId('recording-watermark').first();
    await expect(guestMark).toContainText('Гость защиты');
    await expect(guestMark).toContainText(session.id.replaceAll('-', '').slice(0, 12));
    await expect(video).toHaveJSProperty('disablePictureInPicture', true);
    await expect(video).toHaveJSProperty('disableRemotePlayback', true);
    expect(
      await video.evaluate((v) =>
        v.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      ),
    ).toBe(false);
    await tile.getByRole('button', { name: 'На весь экран', exact: true }).click();
    await expect
      .poll(() => teacher.evaluate(() => document.fullscreenElement?.getAttribute('data-identity')))
      .toBe(session.id);
    await expect(mark).toBeVisible();
    await teacher.evaluate(() => document.exitFullscreen());
    await guest.getByRole('button', { name: 'Демонстрация экрана', exact: true }).click();
    const screens = teacher.getByRole('region', { name: 'Демонстрации экрана', exact: true });
    await expect(screens.getByTestId('recording-watermark')).toContainText(tutor.user.name);
    await expect(screens.locator('video')).toHaveJSProperty('disablePictureInPicture', true);
    await expect
      .poll(() => screens.locator('video').evaluate((v) => (v as HTMLVideoElement).videoWidth), {
        timeout: 25000,
      })
      .toBeGreaterThan(0);
    await teacher.emulateMedia({ media: 'print' });
    await expect(tile).toBeHidden();
    await expect(screens).toBeHidden();
    await teacher.emulateMedia({ media: 'screen' });
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await guest.getByLabel('Сообщение в чат', { exact: true }).fill('Чат доступен с защитой');
    await guest.getByRole('button', { name: 'Отправить в чат', exact: true }).click();
    await expect(guest.getByRole('log')).toContainText('Чат доступен с защитой');
    await guest.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.screenshot({
      path: 'test-results/meeting-protection-guest-mobile.png',
      fullPage: true,
    });
    await setProtection(admin, false);
    for (const page of [teacher, guest]) {
      await expect(page.getByTestId('recording-watermark')).toHaveCount(0);
      await expect(page.getByRole('note')).toHaveCount(0);
      await connected(page);
    }
    await expect(video).toHaveJSProperty('disablePictureInPicture', false);
    expect(
      await video.evaluate((v) =>
        v.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      ),
    ).toBe(true);
    await setProtection(admin, true);
    await expect(mark).toBeVisible();
    await expect(video).toHaveJSProperty('disablePictureInPicture', true);
    await guest.reload();
    await expect(guest.getByRole('note')).toBeVisible();
  } finally {
    await setProtection(admin, false);
    await browser.close();
  }
});
