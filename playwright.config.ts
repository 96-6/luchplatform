import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    locale: 'ru-RU',
    baseURL: 'http://127.0.0.1:3200',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? {
          executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
          args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage'],
        }
      : {},
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:3200/api/v1/health/ready',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
