import { expect, test } from '@playwright/test';
import { newPasswordUI, otp, passwordUI, signInUI } from './password.helpers';
import { keys, root } from './meetings.helpers';

test('self-registered teacher waits after email and 2FA until a superadmin approves the registration', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const options = { locale: 'ru-RU', baseURL: 'http://127.0.0.1:3200' };
  const tc = await browser.newContext(options),
    rc = await browser.newContext(options);
  try {
    const teacher = await tc.newPage(),
      admin = await rc.newPage();
    teacher.setDefaultTimeout(15000);
    const fixture = await keys();
    await teacher.request.post('/__e2e/isolate', {
      headers: { 'x-e2e-fixture': fixture.testIsolationToken },
    });
    const email = `teacher-approval-${Date.now()}@example.test`;
    await teacher.goto('/register');
    await teacher.getByLabel('Имя', { exact: true }).fill('Преподаватель на подтверждении');
    await teacher.getByLabel('Почта', { exact: true }).fill(email);
    await newPasswordUI(teacher, 'register');
    await teacher.getByLabel('Я регистрируюсь как', { exact: true }).selectOption('teacher');
    await expect(
      teacher.getByText(
        'Для доступа преподавателя требуется подтверждение регистрации суперадмином.',
        { exact: true },
      ),
    ).toBeVisible();
    if (await teacher.getByLabel('Символы с картинки').count())
      await teacher.getByLabel('Символы с картинки').fill('ABCDE');
    await teacher
      .getByRole('button', { name: 'Отправить письмо подтверждения', exact: true })
      .click();
    await expect(
      teacher.getByRole('status').filter({ hasText: 'письмо подтверждения отправлено' }),
    ).toBeVisible();
    await teacher.goto(`/demo-mail?email=${encodeURIComponent(email)}`);
    await teacher.getByRole('link', { name: 'Открыть последнее письмо', exact: true }).click();
    await teacher.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
    expect((await passwordUI(teacher, email)).status()).toBe(200);
    await expect(
      teacher.getByRole('heading', { name: 'Подключить Authenticator', exact: true }),
    ).toBeVisible();
    const secret = (await teacher.getByTestId('manual-key').textContent())!;
    await teacher.getByLabel('Код Authenticator', { exact: true }).fill(otp(email, secret));
    if (await teacher.getByLabel('Символы с картинки').count())
      await teacher.getByLabel('Символы с картинки').fill('ABCDE');
    await teacher.getByRole('button', { name: 'Подключить и войти', exact: true }).click();
    await expect(
      teacher.getByText('Регистрация преподавателя ожидает подтверждения суперадмином.', {
        exact: true,
      }),
    ).toBeVisible();
    expect((await (await teacher.request.get('/api/v1/auth/session')).json()).data.user).toBeNull();
    expect((await teacher.request.get('/api/v1/teacher/students')).status()).toBe(401);
    await teacher.getByRole('link', { name: 'Вернуться ко входу', exact: true }).click();
    expect((await passwordUI(teacher, email)).status()).toBe(403);
    await expect(teacher.getByRole('alert')).toContainText(
      'Регистрация преподавателя ожидает подтверждения суперадмином.',
    );
    await root(admin);
    await admin
      .getByLabel('Только преподаватели, ожидающие подтверждения', { exact: true })
      .check();
    const account = admin.locator('.account-list > li').filter({ hasText: email });
    await expect(account).toContainText('ожидает подтверждения регистрации');
    await account.getByRole('button', { name: `Открыть ${email}`, exact: true }).click();
    const approval = admin.getByRole('region', {
      name: 'Подтверждение регистрации преподавателя',
      exact: true,
    });
    await admin.setViewportSize({ width: 390, height: 844 });
    await approval.scrollIntoViewIfNeeded();
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await admin.screenshot({ path: 'test-results/teacher-approval-pending-mobile.png' });
    const approved = admin.waitForResponse(
      (r) => r.url().endsWith('/approve-teacher') && r.request().method() === 'POST',
    );
    await approval
      .getByRole('button', { name: 'Подтвердить регистрацию преподавателя', exact: true })
      .click();
    expect((await approved).status()).toBe(200);
    await expect(approval).toContainText('Регистрацию подтвердил:');
    await admin.reload();
    await admin.getByRole('button', { name: `Открыть ${email}`, exact: true }).click();
    await expect(approval).toContainText('Регистрацию подтвердил:');
    await approval.screenshot({ path: 'test-results/teacher-approval-author.png' });
    await signInUI(teacher, email, secret, 30000);
    await expect(teacher).toHaveURL(/\/teacher$/);
    expect((await teacher.request.get('/api/v1/teacher/students')).status()).toBe(200);
  } finally {
    await tc.close();
    await rc.close();
  }
});
