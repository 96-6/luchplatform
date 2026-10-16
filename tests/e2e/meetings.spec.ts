import { expect, test, type Page } from '@playwright/test';
import {
  csrf,
  login,
  link,
  root,
  preparePlan,
  answer,
  videoBrowser,
  virtualNames,
  createUI,
  enter,
  connected,
  signalAccepted,
} from './meetings.helpers';
if (process.env.CI && !process.env.LUCH_VIDEO_TEST_ENV)
  throw new Error('CI must configure a real self-hosted LiveKit server for meeting acceptance.');
test('calendar persists a group meeting, retries lost create, reschedules and cancels for both participants', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const student = await login(page, 'meeting-calendar-student');
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  try {
    const teacher = await ctx.newPage(),
      tutor = await login(teacher, 'meeting-calendar-tutor');
    const peerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
    const peer = await login(await peerContext.newPage(), 'meeting-calendar-peer');
    await peerContext.close();
    await link(browser, tutor.user.id, [student.user.id, peer.user.id]);
    await teacher.goto('/schedule');
    await teacher.getByRole('button', { name: 'Запланировать занятие', exact: true }).click();
    const f = teacher.getByRole('region', { name: 'Новое видеозанятие', exact: true });
    await f.getByLabel('Название занятия', { exact: true }).fill('Календарь и сохранение занятия');
    await f.getByLabel('Язык занятия', { exact: true }).selectOption('en');
    await f
      .getByLabel('Начало занятия', { exact: true })
      .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
    await f.getByRole('checkbox', { name: new RegExp(student.user.name) }).check();
    await f.getByRole('checkbox', { name: new RegExp(peer.user.name) }).check();
    let lost = true;
    const operations: string[] = [];
    await teacher.route('**/api/v1/meetings', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      operations.push(route.request().postDataJSON().operationId);
      if (lost) {
        lost = false;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await f.getByRole('button', { name: 'Создать занятие', exact: true }).click();
    await expect(f.getByRole('alert')).toContainText('Не удалось связаться');
    await f.getByRole('button', { name: 'Повторить сохранение занятия', exact: true }).click();
    await expect(teacher).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
    const id = teacher.url().split('/').at(-1)!;
    await page.goto('/schedule');
    await page.getByRole('link', { name: 'Календарь и сохранение занятия', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Календарь и сохранение занятия', exact: true }),
    ).toBeVisible();
    await page.reload();
    await teacher.getByRole('button', { name: 'Изменить расписание', exact: true }).click();
    const edit = teacher.getByRole('region', { name: 'Изменение видеозанятия', exact: true });
    await edit
      .getByLabel('Начало занятия', { exact: true })
      .fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16));
    await edit.getByRole('button', { name: 'Сохранить расписание', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await teacher.request.get(`/api/v1/meetings/${id}`)).json()).data.revision,
      )
      .toBe(2);
    await teacher.getByRole('button', { name: 'Отменить занятие', exact: true }).click();
    await expect(teacher.locator('.eyebrow')).toContainText('Отменено');
    await page.reload();
    await expect(page.locator('.eyebrow')).toContainText('Отменено');
    await expect(page.getByRole('link', { name: 'Открыть видеовстречу', exact: true })).toHaveCount(
      0,
    );
    await page.goto('/schedule');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Вид календаря').selectOption('month');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/meeting-calendar-mobile.png', fullPage: true });
  } finally {
    await ctx.close();
  }
});
for (const language of ['ru', 'en'] as const)
  test(`${language}: real browser audio/video, private virtual-device alerts, shared chat and persistent lesson homework`, async ({
    playwright,
  }) => {
    test.skip(
      !process.env.LUCH_VIDEO_TEST_ENV,
      'Real LiveKit is required; CI runs this scenario with the pinned open-source server.',
    );
    test.setTimeout(180000);
    const browser = await videoBrowser(playwright),
      contexts = [];
    try {
      const sctx = await browser.newContext({
          baseURL: 'http://127.0.0.1:3200',
          permissions: ['camera', 'microphone'],
        }),
        tctx = await browser.newContext({
          baseURL: 'http://127.0.0.1:3200',
          permissions: ['camera', 'microphone'],
        });
      contexts.push(sctx, tctx);
      const studentPage = await sctx.newPage(),
        teacher = await tctx.newPage();
      await virtualNames(studentPage);
      const student = await login(studentPage, `meeting-${language}-student`),
        tutor = await login(teacher, `meeting-${language}-tutor`);
      await link(browser, tutor.user.id, [student.user.id]);
      await preparePlan(studentPage, language);
      const id = await createUI(teacher, [student.user.name], language, `Живой урок ${language}`);
      await enter(teacher, id, true);
      await connected(teacher);
      const s = await enter(studentPage, id);
      await expect(
        studentPage.getByRole('heading', { name: 'Зал ожидания', exact: true }),
      ).toBeVisible();
      await teacher
        .getByRole('button', { name: `Допустить: ${student.user.name}`, exact: true })
        .click();
      await connected(studentPage);
      await studentPage.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
      await expect(
        studentPage.getByRole('button', { name: 'Выключить микрофон', exact: true }),
      ).toBeVisible();
      await studentPage.getByRole('button', { name: 'Включить камеру', exact: true }).click();
      const tile = teacher.locator(`[data-identity="${s.id}"]`);
      await expect
        .poll(
          async () =>
            tile
              .locator('video')
              .evaluateAll((es) =>
                es.some(
                  (e) =>
                    (e as HTMLVideoElement).videoWidth > 0 &&
                    (e as HTMLVideoElement).readyState >= 2,
                ),
              ),
          { timeout: 20000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () =>
            teacher
              .locator('audio')
              .evaluateAll((es) => es.some((e) => e.srcObject && !e.paused && e.currentTime > 0)),
          { timeout: 20000 },
        )
        .toBe(true);
      await expect(
        tile.getByRole('button', { name: 'Предупреждение о виртуальной камере', exact: true }),
      ).toBeVisible();
      await tile
        .getByRole('button', { name: 'Предупреждение о виртуальной камере', exact: true })
        .click();
      await expect(tile.getByRole('note')).toContainText('OBS Virtual Camera');
      await tile
        .getByRole('button', { name: 'Предупреждение о виртуальном микрофоне', exact: true })
        .click();
      await expect(tile.getByRole('note')).toContainText('NVIDIA Broadcast');
      await expect(
        studentPage.getByRole('button', { name: /Предупреждение о виртуальном/ }),
      ).toHaveCount(0);
      const privateState = (
        await (
          await studentPage.request.get(`/api/v1/meetings/${id}/room-state?sessionId=${s.id}`)
        ).json()
      ).data;
      expect(JSON.stringify(privateState)).not.toContain('OBS Virtual Camera');
      expect(
        privateState.participants.every((p: { warnings: unknown[] }) => p.warnings.length === 0),
      ).toBe(true);
      await studentPage.getByRole('button', { name: 'Поднять руку', exact: true }).click();
      await expect(tile.getByLabel('Рука поднята', { exact: true })).toBeVisible();
      const chat = studentPage.getByRole('region', { name: 'Чат видеовстречи', exact: true });
      await chat
        .getByLabel('Сообщение в чат', { exact: true })
        .fill('Можно повторить последний пример?');
      await chat.getByRole('button', { name: 'Отправить в чат', exact: true }).click();
      await expect(teacher.getByRole('log')).toContainText('Можно повторить последний пример?');
      await teacher.setViewportSize({ width: 390, height: 844 });
      expect(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await tile.screenshot({ path: `test-results/meeting-warning-${language}.png` });
      await teacher.setViewportSize({ width: 1280, height: 900 });
      await teacher
        .getByRole('button', { name: 'Завершить встречу для всех', exact: true })
        .click();
      await teacher
        .getByRole('button', { name: 'Подтвердить завершение для всех', exact: true })
        .click();
      await expect(
        studentPage.getByRole('heading', { name: 'Встреча завершена', exact: true }),
      ).toBeVisible();
      await teacher.goto(`/meetings/${id}`);
      const summary = teacher.getByRole('region', { name: 'Итог преподавателя', exact: true });
      await summary
        .getByLabel('Итоговый комментарий', { exact: true })
        .fill(`Итог ${language}: закрепляем материал после видеозанятия.`);
      await summary
        .getByRole('checkbox', {
          name: `Назначить домашнюю работу: ${student.user.name}`,
          exact: true,
        })
        .check();
      await summary
        .getByLabel('Упражнение для домашней работы', { exact: true })
        .selectOption(language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text');
      await summary
        .getByRole('button', { name: 'Сохранить итог и назначения', exact: true })
        .click();
      await expect(
        teacher.getByRole('link', { name: 'Открыть домашнее задание в плане →', exact: true }),
      ).toBeVisible();
      await studentPage.goto(`/meetings/${id}`);
      await expect(
        studentPage.getByText(`Итог ${language}: закрепляем материал после видеозанятия.`, {
          exact: true,
        }),
      ).toBeVisible();
      const m = (await (await studentPage.request.get(`/api/v1/meetings/${id}`)).json()).data,
        h = m.homework[0];
      await studentPage
        .getByRole('link', { name: 'Открыть домашнее задание в плане →', exact: true })
        .click();
      await studentPage
        .locator(`#assignment-${h.assignmentId}`)
        .getByRole('button', { name: 'Начать задание', exact: true })
        .click();
      await expect(studentPage).toHaveURL(/\/learning\/runs\/[0-9a-f-]{36}$/);
      const runId = studentPage.url().split('/').at(-1)!,
        run = (await (await studentPage.request.get(`/api/v1/engine/runs/${runId}`)).json()).data;
      const a = answer(run);
      if (a.type !== 'short_text') throw Error('Short text homework expected');
      await studentPage.getByLabel('Короткий ответ', { exact: true }).fill(a.text!);
      await studentPage.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
      await expect(studentPage.locator('.feedback h3')).toHaveText('Верно');
      await studentPage.getByRole('button', { name: 'Завершить урок', exact: true }).click();
      await expect(
        studentPage.getByRole('heading', { name: 'Урок завершён', exact: true }),
      ).toBeVisible();
      await studentPage.getByRole('button', { name: 'Выйти', exact: true }).click();
      await login(studentPage, `meeting-${language}-student`, 30000);
      await studentPage.goto(`/meetings/${id}`);
      await studentPage.reload();
      await expect(
        studentPage.getByRole('link', { name: 'Открыть домашнее задание в плане →', exact: true }),
      ).toBeVisible();
    } finally {
      for (const c of contexts) await c.close();
      await browser.close();
    }
  });
test('real screen share, moderation, permission failure, locked reconnect, root observation and revoked-token rejection', async ({
  playwright,
}) => {
  test.skip(!process.env.LUCH_VIDEO_TEST_ENV, 'Real LiveKit is required; CI runs this scenario.');
  test.setTimeout(180000);
  const browser = await videoBrowser(playwright),
    contexts = [];
  try {
    const tctx = await browser.newContext({
        baseURL: 'http://127.0.0.1:3200',
        permissions: ['camera', 'microphone'],
      }),
      sctx = await browser.newContext({
        baseURL: 'http://127.0.0.1:3200',
        permissions: ['camera', 'microphone'],
      }),
      rctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
    contexts.push(tctx, sctx, rctx);
    const teacher = await tctx.newPage(),
      studentPage = await sctx.newPage(),
      observer = await rctx.newPage();
    await virtualNames(studentPage);
    const tutor = await login(teacher, 'meeting-moderation-tutor'),
      student = await login(studentPage, 'meeting-moderation-student');
    const pctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
    contexts.push(pctx);
    const peerPage = await pctx.newPage(),
      peer = await login(peerPage, 'meeting-moderation-peer');
    await link(browser, tutor.user.id, [student.user.id, peer.user.id]);
    const id = await createUI(
      teacher,
      [student.user.name, peer.user.name],
      'ru',
      'Управление видеовстречей',
    );
    await enter(teacher, id, true);
    await connected(teacher);
    const s = await enter(studentPage, id);
    await teacher
      .getByRole('button', { name: `Допустить: ${student.user.name}`, exact: true })
      .click();
    await connected(studentPage);
    await studentPage.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let first = true;
      navigator.mediaDevices.getUserMedia = async (c) => {
        if (first && c?.video) {
          first = false;
          throw new DOMException('Fixture denial', 'NotAllowedError');
        }
        return original(c);
      };
    });
    await studentPage.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect(studentPage.getByRole('alert')).toContainText('Проверьте разрешения');
    await studentPage.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await enter(peerPage, id);
    await teacher
      .getByRole('button', { name: `Допустить: ${peer.user.name}`, exact: true })
      .click();
    await connected(peerPage);
    await root(observer);
    await enter(observer, id);
    await connected(observer);
    const rootTile = observer.locator(`[data-identity="${s.id}"]`);
    await expect(
      rootTile.getByRole('button', { name: 'Предупреждение о виртуальной камере', exact: true }),
    ).toBeVisible();
    await studentPage.getByRole('button', { name: 'Демонстрация экрана', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Остановить демонстрацию', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const screens = teacher.getByRole('region', { name: 'Демонстрации экрана', exact: true });
    await expect
      .poll(
        async () =>
          screens
            .locator('video')
            .evaluateAll((es) => es.some((e) => (e as HTMLVideoElement).videoWidth > 0)),
        { timeout: 20000 },
      )
      .toBe(true);
    await rootTile.getByText('Управление участником', { exact: true }).click();
    await rootTile.getByRole('button', { name: 'Запретить демонстрацию', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Демонстрация экрана', exact: true }),
    ).toBeDisabled();
    await rootTile.getByRole('button', { name: 'Отключить микрофон', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Включить микрофон', exact: true }),
    ).toBeDisabled();
    await expect(rootTile).toContainText('Микрофон выключен');
    await rootTile.getByRole('button', { name: 'Разрешить микрофон', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Включить микрофон', exact: true }),
    ).toBeEnabled();
    await teacher.getByRole('button', { name: 'Закрыть вход', exact: true }).click();
    await studentPage.reload();
    await studentPage.getByRole('button', { name: 'Войти во встречу', exact: true }).click();
    await connected(studentPage);
    const ticket = (
      await (
        await studentPage.request.post(`/api/v1/meetings/${id}/sessions/${s.id}/token`, {
          headers: await csrf(studentPage),
          data: {},
        })
      ).json()
    ).data;
    if (!(await rootTile.locator('details').evaluate((e) => (e as HTMLDetailsElement).open)))
      await rootTile.getByText('Управление участником', { exact: true }).click();
    await rootTile.getByRole('button', { name: 'Удалить из встречи', exact: true }).click();
    await expect(
      studentPage.getByRole('heading', { name: 'Организатор удалил вас из встречи', exact: true }),
    ).toBeVisible();
    const denied = await studentPage.request.post(`/api/v1/meetings/${id}/join`, {
      headers: await csrf(studentPage),
      data: { operationId: crypto.randomUUID() },
    });
    expect(denied.status()).toBe(403);
    expect(await signalAccepted(studentPage, ticket.serverUrl, ticket.token)).toBe(false);
    const serverState = (
      await (await teacher.request.get(`/api/v1/meetings/${id}/room-state`)).json()
    ).data;
    expect(serverState.available).toBe(true);
    await observer.getByRole('button', { name: 'Завершить встречу для всех', exact: true }).click();
    await observer
      .getByRole('button', { name: 'Подтвердить завершение для всех', exact: true })
      .click();
    await expect(
      teacher.getByRole('heading', { name: 'Встреча завершена', exact: true }),
    ).toBeVisible();
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
  }
});
