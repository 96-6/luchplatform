import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page, type Playwright } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { contentPackageSchema, type RunView } from '@luch/contracts';
import { resolve } from 'node:path';
const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
export const keys = async () =>
  JSON.parse(await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'));
export async function csrf(p: Page) {
  return {
    'x-csrf-token': (await (await p.request.get('/api/v1/auth/session')).json()).data.csrfToken,
  };
}
export async function login(p: Page, prefix: string, offset = 0) {
  p.setDefaultTimeout(15000);
  const k = await keys(),
    email = `${prefix}-${test.info().retry}@example.test`;
  await p.request.post('/__e2e/isolate', { headers: { 'x-e2e-fixture': k.testIsolationToken } });
  await p.goto('/login');
  await p.getByLabel('Почта', { exact: true }).fill(email);
  await p.getByLabel('Код Authenticator').fill(
    new TOTP({
      issuer: 'ЛУЧ',
      label: email,
      secret: Secret.fromBase32(k[email]),
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    }).generate({ timestamp: Date.now() + offset }),
  );
  await p.getByLabel('Символы с картинки').fill('ABCDE');
  await p.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(p).toHaveURL(prefix.endsWith('-tutor') ? /\/teacher$/ : /\/student$/);
  return (await (await p.request.get('/api/v1/auth/session')).json()).data;
}
export async function root(p: Page) {
  const k = await keys();
  await p.goto('/login');
  await p.getByLabel('Почта', { exact: true }).fill(k.localAdminAlias);
  await p.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(p).toHaveURL(/\/admin$/);
  return (await (await p.request.get('/api/v1/auth/session')).json()).data;
}
export async function link(browser: Browser, tutor: string, students: string[]) {
  const c = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  try {
    const p = await c.newPage();
    await root(p);
    for (const id of students) {
      const r = await p.request.post('/api/v1/admin/teacher-students', {
        headers: await csrf(p),
        data: { teacherId: tutor, studentId: id },
      });
      expect(r.status(), await r.text()).toBe(200);
    }
  } finally {
    await c.close();
  }
}
export function answer(run: RunView) {
  const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  return e.solution.type === 'short_text'
    ? { type: 'short_text', text: e.solution.accepted[0] }
    : { type: 'choice', optionId: e.solution.correctOptionIds[0] };
}
export async function preparePlan(p: Page, language: 'ru' | 'en') {
  const headers = await csrf(p);
  let r = await p.request.post('/api/v1/learning/profile', {
    headers,
    data: { language, goal: 'daily_life', experience: 'none', minutesPerDay: 20, revision: 0 },
  });
  expect(r.status()).toBe(200);
  r = await p.request.post('/api/v1/diagnostics', { headers, data: { profileRevision: 1 } });
  expect(r.status()).toBe(200);
  const d = (await r.json()).data.diagnostic;
  let run = (await (await p.request.get(`/api/v1/engine/runs/${d.runId}`)).json()).data as RunView;
  while (run.current) {
    r = await p.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
      headers,
      data: { turnId: run.current.turn.id, operationId: crypto.randomUUID(), answer: answer(run) },
    });
    expect(r.status()).toBe(200);
    r = await p.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
      headers,
      data: { turnId: run.current.turn.id },
    });
    expect(r.status()).toBe(200);
    run = (await r.json()).data;
  }
  return (await (await p.request.get(`/api/v1/diagnostics/${d.id}`)).json()).data.planId as string;
}
export async function videoBrowser(playwright: Playwright) {
  return playwright.chromium.launch({
    headless: !process.env.LUCH_VIDEO_TEST_ENV,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('data/e2e-mic.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--auto-select-desktop-capture-source=Entire screen',
    ],
  });
}
export async function virtualNames(p: Page) {
  await p.addInitScript(() => {
    const d = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'label');
    if (d?.get)
      Object.defineProperty(MediaStreamTrack.prototype, 'label', {
        configurable: true,
        get() {
          const t = this as MediaStreamTrack;
          if (t.kind === 'video' && !t.getSettings().displaySurface) return 'OBS Virtual Camera';
          if (t.kind === 'audio') return 'Microphone (NVIDIA Broadcast)';
          return d.get!.call(this);
        },
      });
  });
}
export async function createUI(
  teacher: Page,
  studentNames: string[],
  language: 'ru' | 'en',
  title: string,
) {
  await teacher.goto('/schedule');
  await teacher.getByRole('button', { name: 'Запланировать занятие', exact: true }).click();
  const f = teacher.getByRole('region', { name: 'Новое видеозанятие', exact: true });
  await f.getByLabel('Название занятия', { exact: true }).fill(title);
  await f.getByLabel('Язык занятия', { exact: true }).selectOption(language);
  await f.getByLabel('Часовой пояс занятия', { exact: true }).selectOption('UTC');
  await f
    .getByLabel('Начало занятия', { exact: true })
    .fill(new Date(Date.now() - 60000).toISOString().slice(0, 16));
  for (const name of studentNames)
    await f.getByRole('checkbox', { name: new RegExp(name) }).check();
  await f.getByRole('button', { name: 'Создать занятие', exact: true }).click();
  await expect(teacher).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  return teacher.url().split('/').at(-1)!;
}
export async function enter(p: Page, id: string, organizer = false) {
  await p.goto(`/meetings/${id}/room`);
  const response = p.waitForResponse(
    (r) => r.url().endsWith(`/meetings/${id}/join`) && r.request().method() === 'POST',
  );
  await p
    .getByRole('button', { name: organizer ? 'Начать встречу' : 'Войти во встречу', exact: true })
    .click();
  const r = await response;
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).data.session;
}
export async function connected(p: Page) {
  await expect(p.locator('.meeting-connection')).toContainText('Соединение установлено', {
    timeout: 30000,
  });
}
export async function signalAccepted(page: Page, serverUrl: string, token: string) {
  return page.evaluate(
    ({ serverUrl, token }) =>
      new Promise<boolean>((resolve) => {
        const url = new URL(`${serverUrl.replace(/\/$/, '')}/rtc`);
        url.search = new URLSearchParams({
          access_token: token,
          auto_subscribe: '1',
          sdk: 'js',
          version: '2.23.0',
          protocol: '16',
        }).toString();
        const ws = new WebSocket(url);
        let done = false;
        const finish = (value: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ws.close();
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), 5000);
        ws.addEventListener('message', () => finish(true));
        ws.addEventListener('error', () => finish(false));
        ws.addEventListener('close', () => finish(false));
      }),
    { serverUrl, token },
  );
}
