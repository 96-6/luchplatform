import { expect, type Page, type Locator } from '@playwright/test';
export async function holdYes(page: Page, dialog: Locator) {
  await page.bringToFront();
  await dialog
    .getByRole('button', { name: /^(Да, удерживать 5 секунд|Yes, hold for 5 seconds)$/ })
    .focus();
  await page.keyboard.down('Space');
  try {
    await expect(dialog).toBeHidden({ timeout: 15000 });
  } finally {
    await page.keyboard.up('Space');
  }
}
