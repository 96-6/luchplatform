import { test, expect, type Page } from '@playwright/test';
import type { RunView } from '@luch/contracts';
import { login, link, csrf, preparePlan, answer } from './meetings.helpers';

async function report(page: Page, userId: string, language: 'ru' | 'en') {
  const r = await page.request.get(`/api/v1/reports/${userId}?language=${language}`);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).data;
}
for (const language of ['ru', 'en'] as const)
  test(`${language}: one live report, private evidence weights, teacher confirmation and relogin`, async ({
    browser,
  }) => {
    test.setTimeout(150000);
    const studentContext = await browser.newContext({ locale: 'ru-RU' }),
      teacherContext = await browser.newContext({ locale: 'ru-RU' });
    try {
      const student = await studentContext.newPage(),
        teacher = await teacherContext.newPage();
      const s = await login(student, `report-${language}-student`),
        t = await login(teacher, `report-${language}-tutor`);
      await link(browser, t.user.id, [s.user.id]);
      const planId = await preparePlan(student, language);
      await student.goto(`/progress?language=${language}`);
      await expect(
        student.getByRole('heading', { name: 'Учебный отчёт', exact: true }),
      ).toBeVisible();
      await expect(student.getByTestId('report-independent')).toHaveText('6');
      await student.bringToFront();
      const plan = (await (await student.request.get(`/api/v1/plans/${planId}`)).json()).data;
      let r = await student.request.post(
        `/api/v1/plans/${planId}/assignments/${plan.assignments[0].id}/start`,
        { headers: await csrf(student), data: {} },
      );
      expect(r.status(), await r.text()).toBe(200);
      let run = (await r.json()).data as RunView;
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/integrity`, {
        headers: await csrf(student),
        data: {
          turnId: run.current!.turn.id,
          batchId: crypto.randomUUID(),
          stats: {
            durationMilliseconds: 2000,
            hiddenMilliseconds: 500,
            tabHides: 1,
            pasteEvents: 1,
          },
        },
      });
      expect(r.status()).toBe(200);
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
        headers: await csrf(student),
        data: {
          turnId: run.current!.turn.id,
          operationId: crypto.randomUUID(),
          answer: answer(run),
        },
      });
      expect(r.status(), await r.text()).toBe(200);
      run = (await r.json()).data.view;
      const firstAttempt = run.current!.attempt!.id;
      // No navigation or manual refresh: the open report must discover a newly saved result.
      await expect(student.getByTestId('report-independent')).toHaveText('7', { timeout: 25000 });
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
        headers: await csrf(student),
        data: { turnId: run.current!.turn.id },
      });
      expect(r.status()).toBe(200);
      run = (await r.json()).data;
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/hint`, {
        headers: await csrf(student),
        data: { turnId: run.current!.turn.id, index: 0 },
      });
      expect(r.status()).toBe(200);
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/answer`, {
        headers: await csrf(student),
        data: {
          turnId: run.current!.turn.id,
          operationId: crypto.randomUUID(),
          answer: answer(run),
        },
      });
      expect(r.status()).toBe(200);
      r = await student.request.post(`/api/v1/engine/runs/${run.run.id}/next`, {
        headers: await csrf(student),
        data: { turnId: run.current!.turn.id },
      });
      expect(r.status()).toBe(200);
      await student.getByRole('button', { name: 'Обновить отчёт', exact: true }).click();
      await expect(student.getByTestId('report-assisted')).toHaveText('1');
      await expect(student.getByTestId('report-assignments')).toHaveText('1');
      await expect(student.getByTestId('report-reviewer')).toHaveCount(0);
      const publicView = await report(student, s.user.id, language);
      expect(publicView.reviewer).toBeNull();
      expect(JSON.stringify(publicView)).not.toMatch(
        /answer_paste|window_changes|weightedEvidenceUnits/,
      );
      expect(
        (
          await student.request.get(`/api/v1/reports/${s.user.id}/integrity?language=${language}`)
        ).status(),
      ).toBe(403);

      await teacher.goto(`/teacher/students/${s.user.id}`);
      await teacher.getByRole('link', { name: 'Открыть учебный отчёт →', exact: true }).click();
      await expect(teacher.getByLabel('Язык отчёта', { exact: true })).toHaveValue(language);
      await expect(teacher.getByTestId('report-reviewer')).toBeVisible();
      const reviewed = await report(teacher, s.user.id, language);
      expect(reviewed.report).toEqual(publicView.report);
      expect(reviewed.reviewer.weightedEvidenceUnits).toBeLessThan(
        reviewed.reviewer.independentCorrect,
      );
      await teacher.getByText('Как рассчитано влияние', { exact: true }).click();
      await expect(
        teacher.getByRole('cell', { name: 'Вставка в ответ', exact: true }),
      ).toBeVisible();
      await expect(teacher.getByTestId('report-reviewer')).toContainText('Уход из окна упражнения');
      await teacher.goto(`/learning/attempts/${firstAttempt}`);
      await teacher.getByLabel('Решение преподавателя', { exact: true }).selectOption('confirm');
      await teacher
        .getByLabel('Комментарий преподавателя', { exact: true })
        .fill(`Подтверждено для отчёта ${language}.`);
      await teacher.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
      await expect(teacher.getByTestId('current-teacher-grade')).toContainText(
        `Подтверждено для отчёта ${language}.`,
      );
      await student.bringToFront();
      await expect(student.getByTestId('report-reviewed')).toHaveText('1', { timeout: 25000 });
      await expect(student.getByTestId('report-public')).toContainText(
        `Подтверждено для отчёта ${language}.`,
      );
      const actual = await report(student, s.user.id, language),
        forTeacher = await report(teacher, s.user.id, language);
      expect(actual.report).toEqual(forTeacher.report);
      expect(actual.report.counts.correctAttempts).toBe(8);
      expect(forTeacher.reviewer.weightedEvidenceUnits).toBe(
        reviewed.reviewer.weightedEvidenceUnits,
      );
      await student.setViewportSize({ width: 390, height: 844 });
      expect(
        await student.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await student.reload();
      await expect(student.getByTestId('report-reviewed')).toHaveText('1');
      await student.request.post('/api/v1/auth/logout', { headers: await csrf(student), data: {} });
      await login(student, `report-${language}-student`, 30000);
      await student.goto(`/progress?language=${language}`);
      await expect(student.getByTestId('report-reviewed')).toHaveText('1');
      await expect(student.getByTestId('report-assisted')).toHaveText('1');
    } finally {
      await studentContext.close();
      await teacherContext.close();
    }
  });

test('report loading failure can be retried and an empty account shows no invented results', async ({
  page,
}) => {
  await login(page, 'report-empty');
  let fail = true;
  await page.route('**/api/v1/reports/**', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Отчёт временно недоступен.',
            requestId: crypto.randomUUID(),
          },
        }),
      });
    } else await route.continue();
  });
  await page.goto('/progress');
  await expect(page.getByRole('alert')).toContainText('Отчёт временно недоступен.');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByTestId('report-submitted')).toHaveText('0');
  await expect(page.getByTestId('report-public')).toContainText('Учебных действий пока нет.');
  await expect(page.getByTestId('report-reviewer')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Следующие учебные шаги', exact: true }),
  ).toBeVisible();
});
