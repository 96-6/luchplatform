import { expect, test } from '@playwright/test';
import { connected, createUI, enter, link, login, videoBrowser } from './meetings.helpers';
if (process.env.CI && !process.env.LUCH_VIDEO_TEST_ENV)
  throw Error('Real LiveKit is required for meeting layout and navigation acceptance.');
test('meeting fills the workspace, docks chat, preserves disconnected tiles and confirms navigation', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'CI supplies real LiveKit.');
  test.setTimeout(150000);
  const browser = await videoBrowser(playwright),
    options = {
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
      permissions: ['camera', 'microphone'],
    };
  const tc = await browser.newContext({ ...options, viewport: { width: 1440, height: 1000 } });
  let sc = await browser.newContext(options);
  try {
    const teacher = await tc.newPage();
    teacher.setDefaultTimeout(15000);
    let studentPage = await sc.newPage();
    const tutor = await login(teacher, 'meeting-layout-tutor'),
      student = await login(studentPage, 'meeting-layout-student');
    await link(browser, tutor.user.id, [student.user.id]);
    const id = await createUI(teacher, [student.user.name], 'ru', 'Адаптивная встреча');
    await teacher.getByRole('link', { name: 'Начать видеозанятие', exact: true }).click();
    await teacher.getByRole('button', { name: 'Начать встречу', exact: true }).click();
    await connected(teacher);
    const s = await enter(studentPage, id),
      row = teacher.locator('.meeting-lobby-person').filter({ hasText: student.user.name });
    const admit = row.getByRole('button', { name: `Допустить: ${student.user.name}`, exact: true });
    await expect(admit).toHaveText('Допустить');
    await expect(
      row.getByRole('button', { name: `Отказать: ${student.user.name}`, exact: true }),
    ).toHaveText('Отказать');
    const nameBox = await row.locator('strong').boundingBox(),
      buttonBox = await admit.boundingBox();
    expect(buttonBox!.x - nameBox!.x - nameBox!.width).toBeGreaterThanOrEqual(12);
    await row.scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: 'test-results/meeting-lobby-buttons.png', fullPage: true });
    await admit.click();
    await connected(studentPage);
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(2);
    await teacher.getByRole('button', { name: 'Чат', exact: true }).click();
    const stage = teacher.getByTestId('meeting-stage'),
      chat = teacher.locator('.meeting-chat-panel'),
      room = teacher.getByTestId('video-conference');
    const stageBox = await stage.boundingBox(),
      chatBox = await chat.boundingBox(),
      roomBox = await room.boundingBox();
    expect(chatBox!.x).toBeGreaterThanOrEqual(stageBox!.x + stageBox!.width);
    expect(roomBox!.y + roomBox!.height).toBeLessThanOrEqual(1001);
    const workspace = await teacher.locator('.workspace').boundingBox();
    expect(roomBox!.width).toBeGreaterThanOrEqual(workspace!.width - 34);
    const filename = '1234567890123456789012345678901234567890123456789012345678901234567890.txt';
    const composer = teacher.getByRole('region', { name: 'Чат видеовстречи', exact: true });
    await composer.getByLabel('Файлы и изображения для чата', { exact: true }).setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from('Файл встречи'),
    });
    await expect(composer.getByText('Файл загружен', { exact: true })).toBeVisible();
    await composer.getByRole('button', { name: 'Отправить в чат', exact: true }).click();
    const attachment = composer.getByRole('log').getByRole('link', { name: filename, exact: true });
    await expect(attachment).toBeVisible();
    await expect(attachment).not.toContainText(filename);
    await expect(attachment).toContainText('МБ');
    const download = teacher.waitForEvent('download');
    await attachment.click();
    expect((await download).suggestedFilename()).toBe(filename);
    await teacher.screenshot({
      path: 'test-results/meeting-docked-chat-desktop.png',
      fullPage: true,
    });
    await teacher.setViewportSize({ width: 390, height: 844 });
    const ms = await stage.boundingBox(),
      mc = await chat.boundingBox();
    expect(mc!.y).toBeGreaterThanOrEqual(ms!.y + ms!.height);
    expect(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await teacher.screenshot({
      path: 'test-results/meeting-docked-chat-mobile.png',
      fullPage: true,
    });
    await teacher.setViewportSize({ width: 1440, height: 1000 });
    await teacher.getByRole('button', { name: 'Закрыть чат', exact: true }).click();
    await expect
      .poll(async () => {
        const state = (
          await (await teacher.request.get(`/api/v1/meetings/${id}/room-state`)).json()
        ).data;
        return state.participants.find((p: { identity: string }) => p.identity === s.id)
          ?.connectionState;
      })
      .toBe('connected');
    const storage = await sc.storageState();
    await sc.close();
    const tile = teacher.locator(`[data-identity="${s.id}"]`);
    await expect(tile).toHaveAttribute('data-connection', 'reconnecting', { timeout: 30000 });
    await expect(
      tile.getByText('У участника проблемы с соединением', { exact: true }),
    ).toBeVisible();
    await expect(tile.locator('.connection-spinner')).toBeVisible();
    await expect(teacher.getByTestId('meeting-participant')).toHaveCount(2);
    await teacher.screenshot({
      path: 'test-results/meeting-reconnecting-participant.png',
      fullPage: true,
    });
    sc = await browser.newContext({ ...options, storageState: storage });
    studentPage = await sc.newPage();
    const resumed = await enter(studentPage, id);
    expect(resumed.id).toBe(s.id);
    await connected(studentPage);
    await expect(tile).toHaveAttribute('data-connection', 'connected');
    const teacherSession = (
      await (await teacher.request.get(`/api/v1/meetings/${id}/room-state`)).json()
    ).data.self.id;
    await teacher.getByRole('link', { name: 'Расписание', exact: true }).click();
    const dialog = teacher.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Остаться во встрече', exact: true }).click();
    await expect(teacher).toHaveURL(new RegExp(`/meetings/${id}/room$`));
    await connected(teacher);
    await teacher.getByRole('link', { name: 'Расписание', exact: true }).click();
    const popup = tc.waitForEvent('page');
    await dialog.getByRole('button', { name: 'Открыть в новом окне', exact: true }).click();
    const opened = await popup;
    await expect(opened).toHaveURL(/\/schedule$/);
    await opened.close();
    await connected(teacher);
    await expect(teacher).toHaveURL(new RegExp(`/meetings/${id}/room$`));
    await teacher.evaluate(() => history.back());
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Остаться во встрече', exact: true }).click();
    await teacher.getByRole('link', { name: 'Расписание', exact: true }).click();
    await teacher.screenshot({
      path: 'test-results/meeting-navigation-confirmation.png',
      fullPage: true,
    });
    await dialog
      .getByRole('button', { name: 'Выйти из встречи и перейти в этом окне', exact: true })
      .click();
    await expect(teacher).toHaveURL(/\/schedule$/);
    await expect(studentPage.locator(`[data-identity="${teacherSession}"]`)).toHaveCount(0);
    const state = (
      await (await studentPage.request.get(`/api/v1/meetings/${id}/room-state`)).json()
    ).data;
    expect(
      state.participants.some((p: { identity: string }) => p.identity === teacherSession),
    ).toBe(false);
  } finally {
    await sc.close().catch(() => {});
    await tc.close();
    await browser.close();
  }
});
