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
  expect(contrastRatio(colors.background, colors.text)).toBeGreaterThanOrEqual(4.5);
});

test('large JSON reaches first paint without materializing the full tree', async ({ page }) => {
  await page.goto('/?fixture=json-large');

  await expect(page.locator('.json-tree')).toBeVisible();
  await expect(page.locator('[data-json-node]')).toHaveCount(101);
  const renderValue = await page.locator('#app').getAttribute('data-render-ms');
  expect(renderValue).not.toBeNull();
  const renderMs = Number(renderValue);
  expect(Number.isFinite(renderMs)).toBe(true);
  expect(renderMs).toBeGreaterThanOrEqual(0);
  expect(renderMs).toBeLessThan(500);
});

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
    const linear = channels.map((value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
