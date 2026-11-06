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
export async function holdYesWithMouse(page: Page, dialog: Locator) {
  await page.bringToFront();
  const yes = dialog.getByRole('button', {
    name: /^(Да, удерживать 5 секунд|Yes, hold for 5 seconds)$/,
  });
  await yes.scrollIntoViewIfNeeded();
  const bounds = (await yes.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  try {
    await expect(dialog).toBeHidden({ timeout: 15000 });
  } finally {
    await page.mouse.up();
  }
}
