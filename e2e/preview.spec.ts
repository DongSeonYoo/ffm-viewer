import { expect, test, type Page } from '@playwright/test';

async function pasteText(page: Page, value: string): Promise<void> {
  await page.evaluate((text) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', text);
    window.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  }, value);
}

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

for (const [fixture, label, content] of [
  ['text', 'TXT', 'Line two stays visible.'],
  ['yaml', 'YAML', 'port: 4000'],
  ['toml', 'TOML', 'port = 4000'],
] as const) {
  test(`${label} opens as read-only code`, async ({ page }) => {
    await page.goto(`/?fixture=${fixture}`);

    await expect(page.locator('.text-code-view')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText(content);
    await expect(page.locator('.document-tab .document-type')).toHaveText(label);
    await expect(page.locator('[data-section-count="outline"]')).toHaveText('0');
  });
}

test('images open inside the minimal image surface', async ({ page }) => {
  await page.goto('/?fixture=image');

  const image = page.locator('.image-document img');
  await expect(image).toBeVisible();
  await expect(page.locator('.document-tab .document-type')).toHaveText('IMG');
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
});

test('Scratch previews pasted Markdown and opens a new tab for the next paste', async ({ page }) => {
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+n');
  await expect(page.getByRole('heading', { name: 'Paste content to preview' })).toBeVisible();

  await pasteText(page, '# Notion paste\n\n| key | value |\n| --- | --- |\n| speed | fast |');
  await expect(page.getByRole('heading', { name: 'Notion paste' })).toBeVisible();
  await expect(page.locator('.markdown-document table')).toContainText('fast');

  await pasteText(page, '{"id":9223372036854775807}');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.json-code-view')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('9223372036854775807');
});

test('Scratch suggests YAML without switching until the user accepts', async ({ page }) => {
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+n');
  await pasteText(page, 'server:\n  port: 4000\n  host: localhost');

  await expect(page.locator('[data-format-hint]')).toBeVisible();
  await expect(page.locator('.markdown-document')).toBeVisible();
  await page.locator('[data-view-as="yaml"]').click();
  await expect(page.locator('.text-code-view')).toBeVisible();
  await expect(page.locator('.document-tab.is-active .document-type')).toHaveText('YAML');
});

test('the horizontal tab strip keeps the active tab visible', async ({ page }) => {
  await page.goto('/?fixture=markdown');
  for (let index = 0; index < 12; index += 1) await page.keyboard.press('Meta+n');

  const strip = await page.locator('.document-tabs').boundingBox();
  const active = await page.locator('.document-tab.is-active').boundingBox();

  expect(active).not.toBeNull();
  expect(strip).not.toBeNull();
  expect(active!.x).toBeGreaterThanOrEqual(strip!.x);
  expect(active!.x + active!.width).toBeLessThanOrEqual(strip!.x + strip!.width + 1);
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
