import { expect, test } from '@playwright/test';

test('Markdown opens as a focused article rather than an editor', async ({ page }) => {
  await page.goto('/?fixture=markdown');

  await expect(page.getByRole('heading', { name: 'A quiet document' })).toBeVisible();
  await expect(page.locator('.markdown-document pre')).toContainText('render');
  await expect(page.locator('textarea')).toHaveCount(0);

  const article = await page.locator('.markdown-document').boundingBox();
  expect(article?.width).toBeLessThanOrEqual(768);
});

test('JSON opens as formatted code with a key outline', async ({ page }) => {
  await page.goto('/?fixture=json');

  await expect(page.locator('.json-code-view')).toBeVisible();
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(page.locator('.json-outline')).toContainText('service');
  await expect(page.locator('.json-outline')).not.toContainText('name');
  await expect(page.locator('.cm-content')).toContainText('api');
  const viewport = await page.locator('.document-viewport').boundingBox();
  const editor = await page.locator('.cm-editor').boundingBox();
  expect(editor?.height).toBe(viewport?.height);

  await page
    .locator('[data-outline-label="service"] [data-action="toggle"]')
    .click();
  await expect(page.locator('.json-outline')).toContainText('name');
  await page.locator('[data-action="jump"][data-outline-label="name"]').click();
  await expect(page.locator('.cm-activeLine')).toContainText('"name"');
  const content = page.locator('.cm-content');
  const source = await content.textContent();
  await content.press('a');
  await expect(content).toHaveText(source ?? '');
  await content.press('Meta+f');
  await expect(page.locator('.cm-search')).toBeVisible();
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

test('large JSON reaches first paint without filling the outline DOM', async ({ page }) => {
  await page.goto('/?fixture=json-large');

  await expect(page.locator('.json-code-view')).toBeVisible();
  await expect(page.locator('[data-action="jump"]')).toHaveCount(100);
  await expect(page.locator('[data-action="more"]')).toBeVisible();
  const renderValue = await page.locator('#app').getAttribute('data-render-ms');
  expect(renderValue).not.toBeNull();
  const renderMs = Number(renderValue);
  expect(Number.isFinite(renderMs)).toBe(true);
  expect(renderMs).toBeGreaterThanOrEqual(0);
  expect(renderMs).toBeLessThan(500);
});

test('multiple files stay open and keyboard navigation wraps', async ({ page }) => {
  await page.goto('/?fixture=multi');
  await expect(page.getByRole('tab')).toHaveCount(1);

  await page.getByRole('button', { name: 'Open document' }).click();
  await page.getByRole('button', { name: 'Open document' }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('[data-open-file]')).toHaveCount(3);
  await expect(page.locator('[data-section-count="files"]')).toHaveText('3');

  await page.keyboard.press('Meta+Alt+ArrowRight');
  await expect(page.getByRole('heading', { name: 'A quiet document' })).toBeVisible();
  await page.keyboard.press('Meta+9');
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();

  await page.keyboard.press('Meta+k');
  await page.locator('[data-quick-switch-input]').fill('service');
  await page.locator('[data-quick-switch-input]').press('Enter');
  await expect(page.locator('.json-code-view')).toBeVisible();
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
