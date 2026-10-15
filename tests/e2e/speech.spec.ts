import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Browser } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { contentPackageSchema, type RunView } from '@luch/contracts';
const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
const audioArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('../../data/e2e-mic.wav', import.meta.url))}`,
];
test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', ...audioArgs],
  },
});
async function keys() {
  return JSON.parse(
    await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
  );
}
async function mode(page: Page, value: Record<string, unknown> = {}) {
  const k = await keys();
  expect(
    (
      await page.request.post('/__e2e/speech-mode', {
        headers: { 'x-e2e-fixture': k.testIsolationToken },
        data: value,
      })
    ).status(),
  ).toBe(204);
}
async function login(page: Page, prefix: string, offset = 0) {
  const k = await keys(),
    email = `${prefix}-${test.info().retry}@example.test`;
  await page.request.post('/__e2e/isolate', { headers: { 'x-e2e-fixture': k.testIsolationToken } });
  const captcha = (await (await page.request.get('/api/v1/auth/captcha?purpose=login')).json())
    .data;
  const code = new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    secret: Secret.fromBase32(k[email]),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: Date.now() + offset });
  const r = await page.request.post('/api/v1/auth/login', {
    data: { email, code, captcha: { id: captcha.id, answer: 'ABCDE' } },
  });
  expect(r.status(), await r.text()).toBe(200);
  await page.goto('/student');
}
async function token(page: Page) {
  return {
    'x-csrf-token': (await (await page.request.get('/api/v1/auth/session')).json()).data.csrfToken,
  };
}
async function configure(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' }),
    root = await ctx.newPage();
  try {
    const k = await keys();
    await root.goto('/login');
    await root.getByLabel('Почта', { exact: true }).fill(k.localAdminAlias);
    await root.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(
      root.getByRole('heading', { name: 'Кабинет суперадмина', exact: true }),
    ).toBeVisible();
    const headers = await token(root);
    let v = (await (await root.request.get('/api/v1/admin/providers')).json()).data;
    let r = await root.request.post('/api/v1/admin/providers/ceilings', {
      headers,
      data: {
        revision: v.revision,
        ceilings: {
          ...v.ceilings,
          lifetimeMicros: 10000000,
          dailyMicros: 10000000,
          monthlyMicros: 10000000,
          perUserDailyMicros: 10000000,
          requestsPerUserDay: 100,
          maxRecordingSeconds: 5,
          maxTtsCharacters: 3000,
        },
      },
    });
    expect(r.status(), await r.text()).toBe(200);
    v = (await r.json()).data;
    r = await root.request.post('/api/v1/admin/providers/controls', {
      headers,
      data: {
        revision: v.revision,
        controls: {
          ...v.controls,
          enabled: false,
          transcriptionEnabled: true,
          assistantSpeechEnabled: true,
          maxRecordingSeconds: 5,
          maxTtsCharacters: 3000,
          dailyMicros: 10000000,
          monthlyMicros: 10000000,
          perUserDailyMicros: 10000000,
          requestsPerUserDay: 100,
        },
      },
    });
    expect(r.status(), await r.text()).toBe(200);
    v = (await r.json()).data;
    for (const id of ['elevenlabs_stt', 'elevenlabs']) {
      const p = v.providers.find((p: { id: string }) => p.id === id);
      r = await root.request.post(`/api/v1/admin/providers/${id}`, {
        headers,
        data: {
          revision: p.revision,
          enabled: true,
          model: id === 'elevenlabs_stt' ? 'scribe_v2' : 'eleven_multilingual_v2',
          voiceRu: id === 'elevenlabs' ? 'voice-ru' : '',
          voiceEn: id === 'elevenlabs' ? 'voice-en' : '',
          inputRate: null,
          outputRate: null,
          characterRate: id === 'elevenlabs' ? 100000 : null,
          minuteRate: id === 'elevenlabs_stt' ? 20000 : null,
          confirmPricing: true,
          apiKey: 'e2e-only-elevenlabs-key',
        },
      });
      expect(r.status(), await r.text()).toBe(200);
      v = (await r.json()).data;
    }
    await root.goto('/admin/providers');
    await expect(root.getByLabel('Модель ElevenLabs Scribe STT', { exact: true })).toHaveValue(
      'scribe_v2',
    );
    await expect(
      root.getByLabel('Разрешить распознавание ElevenLabs Scribe', { exact: true }),
    ).toBeChecked();
    await expect(
      root.getByLabel('Озвучивать ответы помощника через ElevenLabs', { exact: true }),
    ).toBeChecked();
  } finally {
    await ctx.close();
  }
}
async function current(page: Page): Promise<RunView> {
  await expect(page).toHaveURL(/\/learning\/runs\/[0-9a-f-]{36}$/);
  return (
    await (
      await page.request.get(
        `/api/v1/engine/runs/${new URL(page.url()).pathname.split('/').at(-1)}`,
      )
    ).json()
  ).data;
}
function answer(run: RunView) {
  const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.solution.type === 'short_text') return { type: 'short_text', text: e.solution.accepted[0] };
  return { type: 'choice', optionId: e.solution.correctOptionIds[0] };
}
async function prepared(page: Page, language: 'ru' | 'en') {
  const headers = await token(page);
  let r = await page.request.post('/api/v1/learning/profile', {
    headers,
    data: { language, goal: 'daily_life', experience: 'none', minutesPerDay: 20, revision: 0 },
  });
  expect(r.status()).toBe(200);
  r = await page.request.post('/api/v1/diagnostics', { headers, data: { profileRevision: 1 } });
  expect(r.status()).toBe(200);
  let run = (
    await (
      await page.request.get(`/api/v1/engine/runs/${(await r.json()).data.diagnostic.runId}`)
    ).json()
  ).data as RunView;
  while (run.current) {
    r = await page.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
      headers,
      data: { turnId: run.current.turn.id, operationId: crypto.randomUUID(), answer: answer(run) },
    });
    expect(r.status()).toBe(200);
    r = await page.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
      headers,
      data: { turnId: run.current.turn.id },
    });
    expect(r.status()).toBe(200);
    run = (await r.json()).data;
  }
}
async function planRun(page: Page, language: 'ru' | 'en') {
  const headers = await token(page);
  await prepared(page, language);
  const summary = (
    await (await page.request.get(`/api/v1/plans?language=${language}&limit=1`)).json()
  ).data.items[0];
  const p = (await (await page.request.get(`/api/v1/plans/${summary.id}`)).json()).data;
  const r = await page.request.post(
    `/api/v1/plans/${p.plan.id}/assignments/${p.assignments[0].id}/start`,
    { headers, data: {} },
  );
  expect(r.status(), await r.text()).toBe(200);
  const run = (await r.json()).data as RunView;
  await page.goto(`/learning/runs/${run.run.id}`);
  return run;
}
async function capture(page: Page) {
  const panel = page.getByRole('region', { name: 'Голосовой ответ', exact: true });
  await panel.getByRole('button', { name: 'Начать запись', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Завершить запись', exact: true })).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: 'Идёт запись: 1' })).toBeVisible();
  await panel.getByRole('button', { name: 'Завершить запись', exact: true }).click();
  return panel;
}
async function played(page: Page) {
  const player = page
    .getByRole('region', { name: 'Голосовой ответ', exact: true })
    .getByLabel('Голосовой ответ помощника', { exact: true });
  await expect(player).toHaveAttribute('src', /\/api\/v1\/assistant\/messages\//);
  await player.evaluate((node: HTMLAudioElement) => node.play());
  await expect
    .poll(() => player.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(0);
}
test.beforeEach(async ({ browser, page }) => {
  test.setTimeout(120000);
  await configure(browser);
  await mode(page);
});
test.afterEach(async ({ page }) => {
  await mode(page);
});
for (const language of ['ru', 'en'] as const)
  test(`${language}: real microphone recording, persisted transcript, confirmed evaluation, audible feedback and correction`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page, `speech-${language}`);
    const run = await planRun(page, language);
    const panel = await capture(page);
    await expect(panel.getByLabel('Распознанная реплика', { exact: true })).toHaveValue(
      language === 'ru' ? 'Меня зовут Анна.' : 'I am Anna.',
    );
    expect((await current(page)).current!.attempt).toBeNull();
    await page.reload();
    await expect(page.getByLabel('Распознанная реплика', { exact: true })).toHaveValue(
      language === 'ru' ? 'Меня зовут Анна.' : 'I am Anna.',
    );
    const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
    if (e.solution.type !== 'choice' || e.response.type !== 'choice')
      throw new Error('choice expected');
    const solution = e.solution,
      wrong = e.response.options.find((o) => !solution.correctOptionIds.includes(o.id))!;
    await page.getByLabel('Распознанная реплика', { exact: true }).fill(wrong.text);
    await page
      .getByRole('button', { name: 'Подтвердить реплику и проверить', exact: true })
      .click();
    await expect(page.locator('.feedback h3')).toHaveText('Нужно исправить');
    await expect(page.getByRole('region', { name: 'Голосовой ответ', exact: true })).toContainText(
      'В ответе есть ошибка.',
    );
    await played(page);
    expect((await current(page)).attempts[0]!.independent).toBe(true);
    await page.getByRole('button', { name: 'Открыть назначенное упражнение', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`/learning/runs/${run.run.id}$`));
    const correction = await current(page);
    expect(correction.run.id).not.toBe(run.run.id);
    expect(correction.run.sourceType).toBe('assignment');
    const response = answer(correction);
    if (response.type !== 'short_text') throw new Error('Unseen short text expected');
    await mode(page, { transcript: response.text });
    await capture(page);
    await expect(page.getByLabel('Распознанная реплика', { exact: true })).toHaveValue(
      response.text!,
    );
    await page
      .getByRole('button', { name: 'Подтвердить реплику и проверить', exact: true })
      .click();
    await expect(page.locator('.feedback h3')).toHaveText('Верно');
    await played(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('region', { name: 'Голосовой ответ', exact: true }).screenshot({
      path: `test-results/speech-${language}.png`,
    });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Голосовой ответ', exact: true })).toContainText(
      'Подтверждённая реплика',
    );
    await expect(
      page
        .getByRole('region', { name: 'Голосовой ответ', exact: true })
        .getByLabel('Голосовой ответ помощника', { exact: true }),
    ).toHaveAttribute('src', /audio/);
    expect(errors).toEqual([]);
  });
test('STT and TTS outages, retries, re-recording and text fallback preserve grades and attempts', async ({
  page,
}) => {
  await login(page, 'speech-failure');
  let run = await planRun(page, 'ru');
  await mode(page, { sttFailure: true });
  await capture(page);
  const panel = page.getByRole('region', { name: 'Голосовой ответ', exact: true });
  await expect(
    panel.getByRole('button', { name: 'Повторить распознавание', exact: true }),
  ).toBeVisible();
  expect((await current(page)).current!.attempt).toBeNull();
  await mode(page);
  await panel.getByRole('button', { name: 'Повторить распознавание', exact: true }).click();
  await expect(page.getByLabel('Распознанная реплика', { exact: true })).toHaveValue(
    'Меня зовут Анна.',
  );
  await panel.getByRole('button', { name: 'Записать заново', exact: true }).click();
  await expect(page.getByLabel('Распознанная реплика', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Ввести реплику текстом', exact: true }).click();
  await page.getByLabel('Текст реплики', { exact: true }).fill('Меня зовут Анна.');
  await mode(page, { ttsFailure: true });
  await page.getByRole('button', { name: 'Отправить текстовый ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Верно');
  await expect(
    panel.getByRole('button', { name: 'Повторить озвучивание', exact: true }),
  ).toBeVisible();
  run = await current(page);
  expect(run.attempts[0]!.independent).toBe(true);
  const id = run.attempts[0]!.id;
  await mode(page);
  await panel.getByRole('button', { name: 'Повторить озвучивание', exact: true }).click();
  await played(page);
  expect((await current(page)).attempts[0]!.id).toBe(id);
});
test('denied microphone permission offers text and control voice feedback does not reveal a grade', async ({
  page,
}) => {
  await login(page, 'speech-permission');
  const headers = await token(page);
  const response = await page.request.post('/api/v1/engine/runs', {
    headers,
    data: { packageId: 'luch-demo', source: { type: 'lesson', id: 'rki-01', purpose: 'control' } },
  });
  expect(response.status()).toBe(200);
  const run = (await response.json()).data as RunView;
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      },
    });
  });
  await page.goto(`/learning/runs/${run.run.id}`);
  const panel = page.getByRole('region', { name: 'Голосовой ответ', exact: true });
  await panel.getByRole('button', { name: 'Начать запись', exact: true }).click();
  await expect(panel).toContainText('Доступ к микрофону не разрешён');
  await expect(page.getByLabel('Текст реплики', { exact: true })).toBeVisible();
  await page.getByLabel('Текст реплики', { exact: true }).fill('Здравствуйте.');
  if (run.current!.exercise.response.type === 'choice')
    await page
      .getByLabel('Вариант ответа по реплике', { exact: true })
      .selectOption(run.current!.exercise.response.options[0]!.id);
  await page.getByRole('button', { name: 'Отправить текстовый ответ', exact: true }).click();
  await expect(panel).toContainText('Оценка и объяснение появятся после завершения всей проверки.');
  expect((await current(page)).attempts[0]!.evaluation).toBeNull();
  await expect(
    page.getByRole('button', { name: 'Подсказка помощника', exact: true }),
  ).toBeDisabled();
});
