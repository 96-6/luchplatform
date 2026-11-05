import { expect, test, type Page } from '@playwright/test';
import {
  login,
  root,
  csrf,
  videoBrowser,
  enter,
  connected,
  preparePlan,
  signalAccepted,
} from './meetings.helpers';
import { holdYes } from './hold.helpers';
import { contentPackageSchema, type RunView, type PlanView } from '@luch/contracts';
import { readFile } from 'node:fs/promises';
const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
async function create(p: Page, title: string) {
  const r = await p.request.post('/api/v1/meetings/adhoc', {
    headers: await csrf(p),
    data: {
      operationId: crypto.randomUUID(),
      title,
      language: 'ru',
      timeZone: 'Europe/Moscow',
      durationMinutes: null,
      reusable: true,
      allowGuests: true,
      expiresAt: null,
      lobbyEnabled: false,
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).data;
}
test('mistakes with default providers lead to playable remedial work and preserve prior feedback', async ({
  page,
}) => {
  await login(page, 'remedial-default');
  const planId = await preparePlan(page, 'ru');
  const plan = (await (await page.request.get(`/api/v1/plans/${planId}`)).json()).data as PlanView;
  const started = await page.request.post(
    `/api/v1/plans/${plan.plan.id}/assignments/${plan.nextAssignmentId}/start`,
    { headers: await csrf(page), data: {} },
  );
  let run = (await started.json()).data as RunView;
  while (run.current) {
    const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
    const answer =
      e.solution.type === 'short_text'
        ? { type: 'short_text', text: 'wrong' }
        : {
            type: 'choice',
            optionId:
              e.response.type === 'choice'
                ? e.response.options.find(
                    (o) =>
                      e.solution.type === 'choice' && !e.solution.correctOptionIds.includes(o.id),
                  )!.id
                : '',
          };
    expect(
      (
        await page.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
          headers: await csrf(page),
          data: { operationId: crypto.randomUUID(), turnId: run.current.turn.id, answer },
        })
      ).status(),
    ).toBe(200);
    run = (
      await (
        await page.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
          headers: await csrf(page),
          data: { turnId: run.current.turn.id },
        })
      ).json()
    ).data;
  }
  const next = (await (await page.request.get(`/api/v1/plans/${plan.plan.id}`)).json())
    .data as PlanView;
  const correction = next.assignments.find((a) => a.id === next.nextAssignmentId)!;
  expect(correction.kind).toBe('correction');
  await page.goto(`/plan/${plan.plan.id}`);
  const card = page.locator(`#assignment-${correction.id}`);
  await card.getByRole('button', { name: 'Начать задание', exact: true }).click();
  await expect(page).toHaveURL(/\/learning\/runs\//);
  await expect(
    page.getByText(
      'Продолжаем по сохранённому материалу. Знакомые задания могут повторяться для дополнительной практики.',
      { exact: true },
    ),
  ).toBeVisible();
  const id = page.url().split('/').at(-1)!,
    view = (await (await page.request.get(`/api/v1/engine/runs/${id}`)).json()).data;
  expect(view.current.turn.hadPriorFeedback).toBe(true);
  await page.screenshot({ path: 'test-results/remedial-default-repeat.png', fullPage: true });
});
test('IP ban registry ignores clicks and partial holds, records owners/history and supports root edits on mobile', async ({
  page,
}) => {
  test.setTimeout(60000);
  await root(page);
  const m = await create(page, 'IP ban confirmation test');
  await page.goto(`/meetings/${m.meeting.id}`);
  await page.getByText('Блокировки гостевых IP', { exact: true }).click();
  const register = page.getByRole('region', { name: 'База блокировок гостевых IP', exact: true });
  await register.getByRole('button', { name: 'Добавить блокировку IP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Заблокировать гостевой IP', exact: true });
  await dialog.getByLabel('IP-адрес', { exact: true }).fill('192.0.2.42');
  await dialog.getByLabel('Причина блокировки', { exact: true }).fill('Leaked invitation <script>');
  const yes = dialog.getByRole('button', { name: 'Да, удерживать 5 секунд', exact: true });
  await yes.click();
  expect(
    (await (await page.request.get(`/api/v1/meeting-ip-bans?meetingId=${m.meeting.id}`)).json())
      .data.items,
  ).toHaveLength(0);
  await yes.focus();
  await page.keyboard.down('Space');
  await expect.poll(() => dialog.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  await page.keyboard.up('Space');
  await expect(dialog).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/meeting-ip-bans?meetingId=${m.meeting.id}`)).json())
      .data.items,
  ).toHaveLength(0);
  await holdYes(page, dialog);
  await expect(register.getByRole('heading', { name: /192\.0\.2\.42/ })).toBeVisible();
  const item = (await (await page.request.get('/api/v1/meeting-ip-bans')).json()).data.items.find(
    (b: { meetingId: string }) => b.meetingId === m.meeting.id,
  );
  expect(item.history).toHaveLength(1);
  await page.goto('/admin?tab=meeting-bans');
  await page.getByLabel('Язык интерфейса').selectOption('en');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Edit ban 192.0.2.42', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit guest IP ban', exact: true });
  await edit.getByLabel('Ban is active', { exact: true }).uncheck();
  await edit.getByLabel('Reason for blocking', { exact: true }).fill('Accidental ban revoked');
  await page.screenshot({ path: 'test-results/guest-ip-ban-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await holdYes(page, edit);
  const updated = (
    await (await page.request.get('/api/v1/meeting-ip-bans')).json()
  ).data.items.find((b: { id: string }) => b.id === item.id);
  expect(updated.active).toBe(false);
  expect(updated.history).toHaveLength(2);
  expect(updated.owner.id).toBe(item.owner.id);
});
test('ordinary account ban disconnects real live media and rejects a still-valid ticket', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'CI supplies a real LiveKit SFU.');
  test.setTimeout(120000);
  const browser = await videoBrowser(playwright);
  try {
    const options = {
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
      permissions: ['camera', 'microphone'],
    };
    const rc = await browser.newContext(options),
      sc = await browser.newContext(options),
      admin = await rc.newPage(),
      student = await sc.newPage();
    await root(admin);
    const learner = await login(student, 'meeting-ban-student');
    const m = await create(admin, 'Account removal media');
    await pageJoin(student, m.invite.url);
    await enter(admin, m.meeting.id, true);
    const s = await enter(student, m.meeting.id);
    await connected(admin);
    await connected(student);
    await student.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await student.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    const tile = admin.locator(`[data-identity="${s.id}"]`);
    await expect
      .poll(
        () =>
          tile
            .locator('video')
            .evaluateAll((v) => v.some((x) => (x as HTMLVideoElement).videoWidth > 0)),
        { timeout: 25000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          admin
            .locator('audio')
            .evaluateAll((a) =>
              a.some(
                (el) =>
                  (el as HTMLAudioElement).srcObject instanceof MediaStream &&
                  (el as HTMLAudioElement).readyState >= 2,
              ),
            ),
        { timeout: 25000 },
      )
      .toBe(true);
    const ticket = (
      await (
        await student.request.post(`/api/v1/meetings/${m.meeting.id}/sessions/${s.id}/token`, {
          headers: await csrf(student),
          data: {},
        })
      ).json()
    ).data;
    const banned = await admin.request.post(`/api/v1/admin/accounts/${learner.user.id}`, {
      headers: await csrf(admin),
      data: { isBlocked: true, accessVerified: true, blockReason: 'Removed during call' },
    });
    expect(banned.status()).toBe(200);
    await expect(tile).toHaveCount(0, { timeout: 15000 });
    await expect(student.locator('.meeting-connection')).toHaveCount(0, { timeout: 15000 });
    expect(await signalAccepted(student, ticket.serverUrl, ticket.token)).toBe(false);
  } finally {
    await browser.close();
  }
});
async function pageJoin(p: Page, url: string) {
  const token = new URL(url).searchParams.get('token');
  const r = await p.request.post('/api/v1/meeting-invites/redeem', {
    headers: await csrf(p),
    data: { operationId: crypto.randomUUID(), token },
  });
  expect(r.status(), await r.text()).toBe(200);
}
test('guest IP ban removes real media and prevents a fresh anonymous identity from using the leaked link', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'CI supplies a real LiveKit SFU.');
  test.setTimeout(120000);
  const browser = await videoBrowser(playwright);
  try {
    const options = {
      locale: 'ru-RU',
      baseURL: 'http://127.0.0.1:3200',
      permissions: ['camera', 'microphone'],
    };
    const tc = await browser.newContext(options),
      gc = await browser.newContext(options),
      teacher = await tc.newPage(),
      guest = await gc.newPage();
    await login(teacher, 'meeting-ban-tutor');
    const m = await create(teacher, 'Leaked guest link');
    await enter(teacher, m.meeting.id, true);
    await connected(teacher);
    await guest.goto(m.invite.url);
    await guest.getByLabel('Ваше имя во встрече', { exact: true }).fill('Leak guest');
    await guest.getByRole('button', { name: 'Присоединиться по приглашению', exact: true }).click();
    const joinResponse = guest.waitForResponse(
      (r) => r.url().endsWith(`/meetings/${m.meeting.id}/join`) && r.request().method() === 'POST',
    );
    await guest.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    const s = (await (await joinResponse).json()).data.session;
    await connected(guest);
    await guest.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await guest.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    const tile = teacher.locator(`[data-identity="${s.id}"]`);
    await expect
      .poll(
        () =>
          tile
            .locator('video')
            .evaluateAll((v) => v.some((x) => (x as HTMLVideoElement).videoWidth > 0)),
        { timeout: 25000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          teacher
            .locator('audio')
            .evaluateAll((a) =>
              a.some(
                (el) =>
                  (el as HTMLAudioElement).srcObject instanceof MediaStream &&
                  (el as HTMLAudioElement).readyState >= 2,
              ),
            ),
        { timeout: 25000 },
      )
      .toBe(true);
    await teacher.bringToFront();
    await tile.getByText('Управление участником', { exact: true }).click();
    await tile.getByRole('button', { name: 'Заблокировать гостевой IP', exact: true }).click();
    const dialog = teacher.getByRole('dialog', { name: 'Заблокировать гостевой IP', exact: true });
    await dialog.getByLabel('Причина блокировки', { exact: true }).fill('Invitation leaked');
    await holdYes(teacher, dialog);
    await expect(tile).toHaveCount(0, { timeout: 15000 });
    await expect(guest.locator('.meeting-connection')).toHaveCount(0, { timeout: 15000 });
    const fresh = await browser.newContext(options),
      leak = await fresh.newPage();
    await leak.goto(m.invite.url);
    await leak.getByLabel('Ваше имя во встрече', { exact: true }).fill('Another name');
    await leak.getByRole('button', { name: 'Присоединиться по приглашению', exact: true }).click();
    await expect(leak.getByRole('alert')).toContainText(
      'Гостевой вход с этого IP-адреса заблокирован',
    );
    await connected(teacher);
  } finally {
    await browser.close();
  }
});
