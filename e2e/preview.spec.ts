import { expect, test } from '@playwright/test';

test('Markdown opens as a focused article rather than an editor', async ({ page }) => {
  await page.goto('/?fixture=markdown');

  await expect(page.getByRole('heading', { name: 'A quiet document' })).toBeVisible();
  await expect(page.locator('.markdown-document pre')).toContainText('render');
  await expect(page.locator('textarea')).toHaveCount(0);

  const article = await page.locator('.markdown-document').boundingBox();
  expect(article?.width).toBeLessThanOrEqual(768);
});

test('JSON reveals nested structure on demand', async ({ page }) => {
  await page.goto('/?fixture=json');

  await expect(page.locator('.json-tree')).toBeVisible();
  await expect(page.getByText('"service"', { exact: true })).toBeVisible();
  await expect(page.getByText('api', { exact: false })).toHaveCount(0);

  await page.locator('[data-path="$.service"] [data-action="toggle"]').click();
  await expect(page.getByText('"api"', { exact: true })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('the reading surface follows dark appearance without changing its hierarchy', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?fixture=markdown');

  const colors = await page.locator('body').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  });
  expect(colors.background).not.toBe('rgb(255, 255, 255)');
  expect(colors.background).not.toBe(colors.text);
});
