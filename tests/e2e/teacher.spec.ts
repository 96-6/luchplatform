import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Browser } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { contentPackageSchema, type RunView, type PlanView } from '@luch/contracts';
const bank = contentPackageSchema.parse(
  JSON.parse(await readFile(new URL('../../content/demo/luch-demo.json', import.meta.url), 'utf8')),
);
async function keys() {
  return JSON.parse(
    await readFile(new URL('../../data/e2e-accounts.json', import.meta.url), 'utf8'),
  );
}
async function login(page: Page, prefix: string, offset = 0) {
  const k = await keys(),
    email = `${prefix}-${test.info().retry}@example.test`;
  await page.request.post('/__e2e/isolate', { headers: { 'x-e2e-fixture': k.testIsolationToken } });
  await page.goto('/login');
  await page.getByLabel('Почта', { exact: true }).fill(email);
  await page.getByLabel('Код Authenticator').fill(
    new TOTP({
      issuer: 'ЛУЧ',
      label: email,
      secret: Secret.fromBase32(k[email]),
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    }).generate({ timestamp: Date.now() + offset }),
  );
  await page.getByLabel('Символы с картинки').fill('ABCDE');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(prefix.endsWith('-tutor') ? /\/teacher$/ : /\/student$/);
  return (await (await page.request.get('/api/v1/auth/session')).json()).data;
}
async function csrf(page: Page) {
  return {
    'x-csrf-token': (await (await page.request.get('/api/v1/auth/session')).json()).data.csrfToken,
  };
}
async function link(browser: Browser, teacherId: string, studentId: string) {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' });
  try {
    const page = await ctx.newPage(),
      k = await keys();
    await page.goto('/login');
    await page.getByLabel('Почта', { exact: true }).fill(k.localAdminAlias);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    const r = await page.request.post('/api/v1/admin/teacher-students', {
      headers: await csrf(page),
      data: { teacherId, studentId },
    });
    expect(r.status(), await r.text()).toBe(200);
  } finally {
    await ctx.close();
  }
}
function answer(run: RunView, correct = true) {
  const e = bank.exercises.find((e) => e.id === run.current!.exercise.id)!;
  if (e.solution.type === 'short_text')
    return { type: 'short_text', text: correct ? e.solution.accepted[0]! : 'wrong' };
  const solution = e.solution;
  if (e.response.type !== 'choice') throw new Error('Choice expected');
  return {
    type: 'choice',
    optionId: e.response.options.find((o) => solution.correctOptionIds.includes(o.id) === correct)!
      .id,
  };
}
async function prepared(page: Page, language: 'ru' | 'en') {
  const headers = await csrf(page);
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
    run = (await r.json()).data;
  }
  const summary = (
    await (await page.request.get(`/api/v1/plans?language=${language}&limit=1`)).json()
  ).data.items[0];
  const plan = (await (await page.request.get(`/api/v1/plans/${summary.id}`)).json())
    .data as PlanView;
  r = await page.request.post(
    `/api/v1/plans/${plan.plan.id}/assignments/${plan.assignments[0]!.id}/start`,
    { headers, data: {} },
  );
  expect(r.status()).toBe(200);
  run = (await r.json()).data;
  await page.goto(`/learning/runs/${run.run.id}`);
  return { plan, run };
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
async function fill(page: Page, run: RunView, correct = true) {
  const a = answer(run, correct);
  if (a.type === 'short_text')
    await page.getByLabel('Короткий ответ', { exact: true }).fill(a.text!);
  else {
    if (run.current!.exercise.response.type !== 'choice') throw new Error('Choice');
    const text = run.current!.exercise.response.options.find((o) => o.id === a.optionId)!.text;
    await page.getByRole('radio', { name: text, exact: true }).check();
  }
}
for (const language of ['ru', 'en'] as const)
  test(`${language}: teacher reviews an answer, changes plan and student resumes saved work`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const student = await login(page, `teacher-${language}`),
      { plan, run } = await prepared(page, language);
    await page.getByRole('button', { name: 'Подсказка', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Использованные подсказки', exact: true }),
    ).toBeVisible();
    await fill(page, run, false);
    await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
    await expect(page.locator('.feedback h3')).toHaveText('Нужно исправить');
    const saved = await current(page),
      attempt = saved.attempts[0]!;
    const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' }),
      teacher = await ctx.newPage();
    try {
      const tutor = await login(teacher, `teacher-${language}-tutor`);
      await link(browser, tutor.user.id, student.user.id);
      await teacher.reload();
      await teacher
        .locator('.account-list li')
        .filter({ hasText: student.user.email })
        .getByRole('link', { name: 'Открыть карточку →', exact: true })
        .click();
      await expect(
        teacher.getByRole('heading', { name: 'Карточка ученика', exact: true }),
      ).toBeVisible();
      await expect(
        teacher.getByRole('heading', { name: 'Сохранённые диагностики', exact: true }),
      ).toBeVisible();
      await teacher
        .getByTestId('teacher-attempt')
        .first()
        .getByRole('link', { name: 'Проверить ответ и комментарии →', exact: true })
        .click();
      await expect(teacher).toHaveURL(new RegExp(`/learning/attempts/${attempt.id}$`));
      await expect(
        teacher.getByRole('region', { name: 'Сохранённый ответ', exact: true }),
      ).toContainText(attempt.usedHints[0]!.text);
      const comment = `Ответ ${language} принят после проверки контекста.`;
      await teacher.getByLabel('Решение преподавателя', { exact: true }).selectOption('correct');
      await teacher.getByLabel('Исправленная оценка', { exact: true }).selectOption('true');
      await teacher.getByLabel('Комментарий преподавателя', { exact: true }).fill(comment);
      await teacher.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
      await expect(teacher.getByTestId('current-teacher-grade')).toContainText(comment);
      await teacher.reload();
      await expect(teacher.getByTestId('teacher-review')).toHaveCount(1);
      await page.reload();
      await expect(page.locator('.feedback h3')).toHaveText('Верно');
      expect((await current(page)).attempts[0]!.independent).toBe(false);
      await page.goto('/student');
      await expect(
        page.getByRole('region', { name: 'Комментарии и назначения', exact: true }),
      ).toContainText(comment);
      await teacher.goto(`/plan/${plan.plan.id}`);
      const assign = teacher.getByRole('region', { name: 'Назначение преподавателя', exact: true }),
        exerciseId = language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text';
      await assign.getByLabel('Упражнение для ученика', { exact: true }).selectOption(exerciseId);
      await assign
        .getByLabel('Причина назначения', { exact: true })
        .fill('Повторяем материал после проверки.');
      await assign.getByRole('button', { name: 'Назначить ученику', exact: true }).click();
      const assigned = teacher
        .getByTestId('plan-assignment')
        .filter({ hasText: 'Повторяем материал после проверки.' });
      await expect(assigned).toHaveCount(1);
      const assignmentId = (await assigned.getAttribute('id'))!.replace('assignment-', '');
      await assigned.getByText('Изменить назначение', { exact: true }).click();
      await assigned.getByLabel('Новая дата доступности', { exact: true }).fill('2030-06-01T12:00');
      await assigned
        .getByLabel('Причина изменения', { exact: true })
        .fill('Переносим по согласованию с учеником.');
      await assigned
        .getByRole('button', { name: 'Сохранить изменение назначения', exact: true })
        .click();
      await expect(assigned).toContainText('Переносим по согласованию с учеником.');
      await page.goto(`/plan/${plan.plan.id}`);
      let learnerAssignment = page.locator(`#assignment-${assignmentId}`);
      await expect(learnerAssignment).toContainText('Переносим по согласованию с учеником.');
      await expect(
        learnerAssignment.getByRole('button', { name: 'Начать задание', exact: true }),
      ).toBeDisabled();
      const forbidden = await page.request.post(
        `/api/v1/plans/${plan.plan.id}/assignments/${assignmentId}/start`,
        { headers: await csrf(page), data: {} },
      );
      expect(forbidden.status()).toBe(409);
      await assigned.getByText('Изменить назначение', { exact: true }).click();
      await assigned.getByLabel('Изменение назначения', { exact: true }).selectOption('cancel');
      await assigned
        .getByLabel('Причина изменения', { exact: true })
        .fill('Заменяем назначение новым сроком практики.');
      await assigned
        .getByRole('button', { name: 'Сохранить изменение назначения', exact: true })
        .click();
      await expect(assigned).toHaveAttribute('data-status', 'cancelled');
      await assign.getByLabel('Упражнение для ученика', { exact: true }).selectOption(exerciseId);
      await assign
        .getByLabel('Причина назначения', { exact: true })
        .fill('Практика доступна сейчас.');
      await assign.getByRole('button', { name: 'Назначить ученику', exact: true }).click();
      await expect(
        teacher.getByTestId('plan-assignment').filter({ hasText: 'Практика доступна сейчас.' }),
      ).toHaveCount(1);
      await page.goto('/student');
      await expect(
        page.getByRole('region', { name: 'Комментарии и назначения', exact: true }),
      ).toContainText('Практика доступна сейчас.');
      const today = page
        .getByTestId('dashboard-assignment')
        .filter({ hasText: 'Практика доступна сейчас.' });
      await today.getByRole('button', { name: 'Начать практику', exact: true }).click();
      const next = await current(page);
      expect(next.current!.exercise.id).toBe(exerciseId);
      expect(next.run.sourceType).toBe('assignment');
      await fill(page, next, true);
      await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
      await expect(page.locator('.feedback h3')).toHaveText('Верно');
      await page.getByRole('button', { name: 'Завершить урок', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Урок завершён', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Выйти', exact: true }).click();
      await login(page, `teacher-${language}`, 30000);
      await page.goto(`/learning/attempts/${attempt.id}`);
      await expect(page.getByTestId('teacher-review')).toContainText(comment);
      await expect(page.getByTestId('current-teacher-grade')).toContainText('Верно');
      await page.reload();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page
        .getByRole('region', { name: 'Сохранённый ответ', exact: true })
        .screenshot({ path: `test-results/teacher-student-${language}.png` });
      await teacher.goto(`/learning/attempts/${attempt.id}`);
      await teacher.setViewportSize({ width: 390, height: 844 });
      expect(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await teacher
        .getByRole('region', { name: 'Проверка ответа', exact: true })
        .screenshot({ path: `test-results/teacher-review-${language}.png` });
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
test('a lost teacher review response and assignment response can be retried without duplication', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const student = await login(page, 'teacher-retry-student'),
    { plan, run } = await prepared(page, 'ru');
  await fill(page, run, false);
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).click();
  await expect(page.locator('.feedback h3')).toHaveText('Нужно исправить');
  const id = (await current(page)).attempts[0]!.id;
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:3200' }),
    teacher = await ctx.newPage();
  try {
    const tutor = await login(teacher, 'teacher-retry-tutor');
    await link(browser, tutor.user.id, student.user.id);
    await teacher.goto(`/learning/attempts/${id}`);
    let lost = true;
    const operations: string[] = [];
    await teacher.route(`**/api/v1/teacher/attempts/${id}/reviews`, async (route) => {
      operations.push(route.request().postDataJSON().operationId);
      if (lost) {
        lost = false;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await teacher
      .getByLabel('Комментарий преподавателя', { exact: true })
      .fill('Комментарий сохраняется при потере ответа.');
    await teacher.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
    await expect(teacher.getByRole('alert')).toContainText('Не удалось связаться с сервером.');
    await teacher
      .getByRole('button', { name: 'Повторить сохранение проверки', exact: true })
      .click();
    await expect(teacher.getByTestId('teacher-review')).toHaveCount(1);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
    await teacher.goto(`/plan/${plan.plan.id}`);
    lost = true;
    const assignments: string[] = [];
    await teacher.route(`**/api/v1/teacher/plans/${plan.plan.id}/assignments`, async (route) => {
      assignments.push(route.request().postDataJSON().operationId);
      if (lost) {
        lost = false;
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    const form = teacher.getByRole('region', { name: 'Назначение преподавателя', exact: true });
    await form
      .getByLabel('Упражнение для ученика', { exact: true })
      .selectOption('rki-02-practice-text');
    await form
      .getByLabel('Причина назначения', { exact: true })
      .fill('Назначение при повторе запроса.');
    await form.getByRole('button', { name: 'Назначить ученику', exact: true }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    await form.getByRole('button', { name: 'Повторить назначение', exact: true }).click();
    await expect(
      teacher.getByTestId('plan-assignment').filter({ hasText: 'Назначение при повторе запроса.' }),
    ).toHaveCount(1);
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toBe(assignments[1]);
    await page.goto('/feedback');
    await expect(
      page
        .getByTestId('teacher-update')
        .filter({ hasText: 'Комментарий сохраняется при потере ответа.' }),
    ).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});
test('empty and failed teacher workspaces recover and foreign student cards stay inaccessible', async ({
  page,
}) => {
  test.setTimeout(60000);
  await login(page, 'teacher-empty-tutor');
  await expect(
    page.getByRole('heading', { name: 'Ученики пока не назначены', exact: true }),
  ).toBeVisible();
  let fail = true;
  await page.route('**/api/v1/teacher/students', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Временно не удалось загрузить учеников.',
            requestId: 'teacher-test',
          },
        },
      });
    } else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Временно не удалось загрузить учеников.');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Ученики пока не назначены', exact: true }),
  ).toBeVisible();
  const stranger = crypto.randomUUID();
  expect((await page.request.get(`/api/v1/learning/attempts?userId=${stranger}`)).status()).toBe(
    404,
  );
  const denied = await page.goto(`/teacher/students/${stranger}`);
  expect(denied?.status()).toBe(404);
  await expect(page.getByRole('alert')).toContainText('Аккаунт не найден.');
});
