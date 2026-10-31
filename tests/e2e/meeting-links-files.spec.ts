import { reloadMeeting } from './meetings.helpers';
import { expect, test, type Page } from '@playwright/test';
import { passwordUI, secondFactorUI } from './password.helpers';
import { csrf, login, root, videoBrowser, enter, connected, keys } from './meetings.helpers';

if (process.env.CI && !process.env.LUCH_VIDEO_TEST_ENV)
  throw new Error('CI must configure real LiveKit for guest meeting acceptance.');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
async function createAdhoc(p: Page, title: string, guest = true, reusable = true) {
  await p.goto('/schedule');
  await p.getByRole('button', { name: 'Внеплановая встреча', exact: true }).click();
  await p.getByLabel('Название встречи', { exact: true }).fill(title);
  await p.getByRole('checkbox', { name: 'Без ограничения длительности', exact: true }).check();
  if (!reusable) await p.getByLabel('Тип приглашения', { exact: true }).selectOption('once');
  if (guest)
    await p
      .getByRole('checkbox', { name: 'Разрешить гостей без регистрации', exact: true })
      .check();
  await p.getByRole('button', { name: 'Создать встречу', exact: true }).click();
  await expect(p).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  const id = p.url().split('/').at(-1)!;
  const invitation = p.getByLabel('Ссылка для участников', { exact: true });
  await expect(invitation).toHaveValue(/meeting-invite\?token=/);
  return { id, url: await invitation.inputValue() };
}
async function guestJoin(p: Page, url: string, name: string) {
  await p.goto(url);
  await p.getByLabel('Ваше имя во встрече', { exact: true }).fill(name);
  await p.getByRole('button', { name: 'Присоединиться по приглашению', exact: true }).click();
  await expect(p).toHaveURL(/\/guest\/meetings\/[0-9a-f-]{36}\/room$/);
}

test('guest invitation uses real media, persists images and files, and reuses the URL with separate history', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'Real LiveKit is required; CI supplies the SFU.');
  test.setTimeout(180000);
  const browser = await videoBrowser(playwright);
  try {
    const options = {
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
      permissions: ['camera', 'microphone'],
    };
    const tc = await browser.newContext(options),
      gc = await browser.newContext(options);
    const teacher = await tc.newPage(),
      guest = await gc.newPage();
    await login(teacher, 'meeting-adhoc-tutor');
    const { id, url } = await createAdhoc(teacher, 'Внеплановая встреча с гостем');
    await reloadMeeting(teacher);
    await expect(teacher.getByLabel('Ссылка для участников', { exact: true })).toHaveValue(url);
    await enter(teacher, id, true);
    await connected(teacher);
    await guestJoin(guest, url, 'Приглашённый гость');
    expect((await guest.request.get('/api/v1/auth/session')).status()).toBe(200);
    expect((await (await guest.request.get('/api/v1/auth/session')).json()).data.user).toBeNull();
    expect((await guest.request.get('/api/v1/learning/profile')).status()).toBe(401);
    const joined = guest.waitForResponse(
      (r) => r.url().endsWith(`/meetings/${id}/join`) && r.request().method() === 'POST',
    );
    await guest.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    const session = (await (await joined).json()).data.session;
    await expect(guest.getByRole('heading', { name: 'Зал ожидания', exact: true })).toBeVisible();
    await teacher
      .getByRole('button', { name: 'Допустить: Приглашённый гость', exact: true })
      .click();
    await connected(guest);
    await guest.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await guest.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    const tile = teacher.locator(`[data-identity="${session.id}"]`);
    await expect
      .poll(
        async () =>
          tile
            .locator('video')
            .evaluateAll((es) =>
              es.some(
                (e) =>
                  (e as HTMLVideoElement).videoWidth > 0 && (e as HTMLVideoElement).readyState >= 2,
              ),
            ),
        { timeout: 25000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          teacher
            .locator('audio')
            .evaluateAll((es) => es.some((e) => e.srcObject && !e.paused && e.currentTime > 0)),
        { timeout: 25000 },
      )
      .toBe(true);
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await teacher.getByRole('button', { name: 'Чат', exact: true }).click();
    const chat = guest.getByRole('region', { name: 'Чат видеовстречи', exact: true });
    await chat.getByLabel('Файлы и изображения для чата', { exact: true }).setInputFiles([
      { name: 'пример.png', mimeType: 'image/png', buffer: png },
      { name: 'задание.txt', mimeType: 'text/plain', buffer: Buffer.from('Гостевой файл встречи') },
    ]);
    await expect(chat.getByText('Файл загружен', { exact: true })).toHaveCount(2);
    await chat.getByRole('button', { name: 'Отправить в чат', exact: true }).click();
    await expect(
      teacher.getByRole('log').getByRole('img', { name: 'пример.png', exact: true }),
    ).toBeVisible();
    const img = teacher.getByRole('log').getByRole('img', { name: 'пример.png', exact: true });
    await expect
      .poll(async () => img.evaluate((e) => (e as HTMLImageElement).naturalWidth))
      .toBe(1);
    const attachment = teacher
      .getByRole('log')
      .getByRole('link', { name: 'задание.txt', exact: true });
    await expect(attachment).toBeVisible();
    const download = teacher.waitForEvent('download');
    await attachment.click();
    expect((await download).suggestedFilename()).toBe('задание.txt');
    await reloadMeeting(guest);
    await expect(
      guest.getByRole('button', { name: 'Войти во встречу', exact: true }),
    ).toBeEnabled();
    await guest.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    await connected(guest);
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(
      guest.getByRole('log').getByRole('link', { name: 'задание.txt', exact: true }),
    ).toBeVisible();
    await guest.setViewportSize({ width: 390, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.screenshot({ path: 'test-results/meeting-guest-files-mobile.png', fullPage: true });
    const m = (await (await teacher.request.get(`/api/v1/meetings/${id}`)).json()).data;
    const end = await teacher.request.post(`/api/v1/meetings/${id}/moderate`, {
      headers: await csrf(teacher),
      data: { operationId: crypto.randomUUID(), action: 'end', revision: m.revision },
    });
    expect(end.status(), await end.text()).toBe(200);
    await reloadMeeting(guest);
    await expect(
      guest.getByRole('log').getByRole('link', { name: 'задание.txt', exact: true }),
    ).toBeVisible();
    await expect(guest.getByLabel('Сообщение в чат', { exact: true })).toHaveCount(0);
    await teacher.goto(`/meetings/${id}`);
    const restarting = teacher.waitForResponse(
      (r) => r.url().endsWith(`/meetings/${id}/invite/restart`) && r.request().method() === 'POST',
    );
    await teacher
      .getByRole('button', { name: 'Начать новую встречу по этой ссылке', exact: true })
      .click();
    const response = await restarting;
    expect(response.status(), await response.text()).toBe(200);
    const next = (await response.json()).data.meeting.id;
    await expect(teacher).toHaveURL(new RegExp(`/meetings/${next}$`));
    expect(next).not.toBe(id);
    await expect(teacher.getByLabel('Ссылка для участников', { exact: true })).toHaveValue(url);
    await guestJoin(guest, url, 'Новая встреча');
    await expect(guest).toHaveURL(new RegExp(`/guest/meetings/${next}/room$`));
    expect(
      (await (await teacher.request.get(`/api/v1/meetings/${next}/messages`)).json()).data.items,
    ).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('single-use registered invitation returns through password login and rejects another recipient', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  await login(page, 'meeting-single-tutor');
  const { id, url } = await createAdhoc(page, 'Личная ссылка', false, false);
  const sc = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  const gc = await browser.newContext({ locale: 'en-US', baseURL: 'http://127.0.0.1:3200' });
  try {
    const student = await sc.newPage(),
      anonymous = await gc.newPage();
    await anonymous.goto(url);
    await expect(
      anonymous.getByText('The organizer only allows registered users to join.', { exact: true }),
    ).toBeVisible();
    await expect(anonymous.getByLabel('Your name in the meeting', { exact: true })).toHaveCount(0);
    await anonymous.setViewportSize({ width: 390, height: 844 });
    await anonymous.screenshot({
      path: 'test-results/meeting-invitation-en-mobile.png',
      fullPage: true,
    });
    await student.goto(url);
    await student.getByRole('link', { name: 'Войти в аккаунт', exact: true }).click();
    const email = `meeting-single-student-${test.info().retry}@example.test`;
    expect((await passwordUI(student, email)).status()).toBe(200);
    await secondFactorUI(student, email, (await keys())[email]);
    await expect(student).toHaveURL(url);
    await student
      .getByRole('button', { name: 'Присоединиться по приглашению', exact: true })
      .click();
    await expect(student).toHaveURL(new RegExp(`/meetings/${id}/room$`));
    await reloadMeeting(student);
    await expect(
      student.getByRole('heading', { name: 'Личная ссылка', exact: true }),
    ).toBeVisible();
    const response = await anonymous.request.post('/api/v1/meeting-invites/redeem', {
      data: {
        token: new URL(url).searchParams.get('token'),
        name: 'Other guest',
        operationId: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(401);
    const pc = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
    try {
      const peer = await pc.newPage();
      await login(peer, 'meeting-single-peer');
      await peer.goto(url);
      await peer
        .getByRole('button', { name: 'Присоединиться по приглашению', exact: true })
        .click();
      await expect(peer.getByRole('alert')).toContainText(
        'Одноразовое приглашение уже использовано.',
      );
    } finally {
      await pc.close();
    }
  } finally {
    await sc.close();
    await gc.close();
  }
});

test('superadmin configures file limits and upload failures can be retried without duplicate attachments', async ({
  page,
  browser,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'CI supplies a real SFU for the room controls.');
  test.setTimeout(90000);
  await login(page, 'meeting-files-tutor');
  const rc = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' });
  try {
    const admin = await rc.newPage();
    await root(admin);
    await admin.goto('/admin?tab=security');
    await admin.getByLabel('Максимальный размер файла, МБ', { exact: true }).fill('1');
    await admin.getByLabel('Удалять файлы размером больше, МБ', { exact: true }).fill('0');
    await admin.getByLabel('Срок хранения больших файлов, дней', { exact: true }).fill('2');
    await admin.getByRole('button', { name: 'Сохранить настройки файлов', exact: true }).click();
    await expect(admin.getByText('Настройки файлов сохранены.', { exact: true })).toBeVisible();
    await reloadMeeting(admin);
    await expect(admin.getByLabel('Максимальный размер файла, МБ', { exact: true })).toHaveValue(
      '1',
    );
    const { id } = await createAdhoc(page, 'Проверка вложений');
    await enter(page, id, true);
    await connected(page);
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    const chat = page.getByRole('region', { name: 'Чат видеовстречи', exact: true });
    await chat.getByLabel('Файлы и изображения для чата', { exact: true }).setInputFiles({
      name: 'too-large.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(1024 * 1024 + 1),
    });
    await expect(chat.getByRole('alert')).toContainText('Выберите непустые файлы не больше 1 МБ.');
    let lost = true;
    const ids: string[] = [];
    await page.route('**/api/v1/meetings/*/files/*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().url().split('/').at(-1)!);
      if (lost) {
        lost = false;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await chat.getByLabel('Файлы и изображения для чата', { exact: true }).setInputFiles({
      name: 'retry.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Retry safely'),
    });
    await expect(
      chat.getByRole('button', { name: 'Повторить загрузку', exact: true }),
    ).toBeVisible();
    await chat.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await expect(chat.getByText('Файл загружен', { exact: true })).toBeVisible();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    await expect(chat.getByText(/^Будет удалён/)).toBeVisible();
    await chat.getByRole('button', { name: 'Отправить в чат', exact: true }).click();
    await expect(
      chat.getByRole('log').getByRole('link', { name: 'retry.txt', exact: true }),
    ).toHaveCount(1);
    await page.screenshot({ path: 'test-results/meeting-file-retry.png', fullPage: true });
    const current = (await (await admin.request.get('/api/v1/admin/meeting-file-policy')).json())
      .data;
    expect(
      (
        await admin.request.post('/api/v1/admin/meeting-file-policy', {
          headers: await csrf(admin),
          data: { maxFileMb: 125, largeFileMb: 50, retentionDays: 10, revision: current.revision },
        })
      ).status(),
    ).toBe(200);
  } finally {
    await rc.close();
  }
});
