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
  await expect(page.locator('.sidebar-outline')).not.toBeVisible();
  await expect(page.locator('.markdown-toc')).toHaveCount(0);

  const article = await page.locator('.markdown-document').boundingBox();
  expect(article?.width).toBeLessThanOrEqual(768);
});

test('long Markdown uses a wide-screen reading rail instead of the left sidebar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+t');
  await pasteText(page, [
    '# Guide',
    '',
    '## Start',
    '',
    'Read the start.',
    '',
    '### Details',
    '',
    'Read the details.',
    '',
    '## Finish',
    '',
    'Finish reading.',
  ].join('\n'));

  const toc = page.getByRole('navigation', { name: 'Document sections' });
  await expect(toc).toBeVisible();
  await expect(toc.locator('.markdown-toc-link')).toHaveText(['Start', 'Details', 'Finish']);
  await expect(page.locator('.sidebar-outline')).not.toBeVisible();

  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(toc).not.toBeVisible();
});

test('JSON opens as formatted code with a key outline', async ({ page }) => {
  await page.goto('/?fixture=json');

  await expect(page.locator('.json-code-view')).toBeVisible();
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(page.locator('.json-outline')).toContainText('service');
  await expect(page.locator('.json-outline')).not.toContainText('name');
  await expect(page.locator('.cm-content')).toContainText('api');
  await expect(page.locator('[data-ffm-diagnostics]')).toHaveCount(0);
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
  await page.getByRole('button', { name: /Search files on this Mac/ }).focus();
  await page.keyboard.press('Meta+f');
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await content.focus();
  await page.keyboard.press('Meta+p');
  await expect(page.locator('[data-file-search-input]')).toBeVisible();
  await expect(page.locator('.file-quick-open')).toBeVisible();
  await expect(page.locator('[data-quick-switcher]')).toHaveCount(0);
});

test('Cmd+F finds rendered Markdown text', async ({ page }) => {
  await page.goto('/?fixture=markdown');
  await page.locator('.markdown-document p').first().evaluate((paragraph) => {
    paragraph.innerHTML = paragraph.innerHTML.replace(
      'calm reading',
      'calm <strong>reading</strong>',
    );
  });

  await page.keyboard.press('Meta+f');
  const input = page.locator('[data-document-search-input]');
  await input.pressSequentially('calm reading');
  await input.press('Enter');

  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('calm reading');
  await expect(page.locator('.document-search-count')).toHaveText('1/1');
  await expect(input).toBeFocused();
});

test('System theme follows macOS appearance without changing hierarchy', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+,');
  await page.locator('[name="theme"]').selectOption('system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(252, 252, 250)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 26, 25)');
  await expect(page.getByRole('heading', { name: 'A quiet document' })).toBeVisible();

  const colors = await page.locator('body').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  });
  expect(colors.background).not.toBe('rgb(255, 255, 255)');
  expect(contrastRatio(colors.background, colors.text)).toBeGreaterThanOrEqual(4.5);
});

test('FFM Green is the default and Settings persists appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?fixture=markdown');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'green');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 26, 25)');

  const opener = page.getByRole('button', { name: 'Open document' });
  await opener.focus();
  await page.keyboard.press('Meta+,');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  const select = page.locator('[name="theme"]');
  await expect(select).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
  await select.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(252, 252, 250)');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(252, 252, 250)');
});

test('Settings remains visible when showModal is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/?fixture=markdown');

  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.settings-overlay')).toHaveCSS('position', 'fixed');
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
});

test('Settings keeps every file type reachable at the minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 420 });
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+,');

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const svg = page.getByRole('checkbox', { name: 'SVG .svg' });
  await svg.scrollIntoViewIfNeeded();
  await svg.click();
  await expect(svg).not.toBeChecked();
});

test('Settings closes when its backdrop is clicked', async ({ page }) => {
  await page.goto('/?fixture=markdown');
  await page.keyboard.press('Meta+,');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

  await page.mouse.click(20, 20);

  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
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

  await page.keyboard.press('Meta+Shift+f');
  await expect(page.locator('[data-open-tab-search-input]')).toBeVisible();
  await expect(page.locator('.content-search-box')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  const input = page.locator('[data-open-tab-search-input]');
  await input.fill('service');
  await expect(page.locator('[data-content-search-summary]')).toHaveText(
    '1 result in 1 document',
  );
  await expect(page.locator('[data-content-search-group]')).toHaveCount(1);
  await expect(page.locator('[data-content-search-group]')).toContainText('service.json');
  await expect(page.locator('[data-open-tab-search-result]')).toContainText('service');
  await input.press('Enter');
  await expect(page.locator('.json-code-view')).toBeVisible();
  await expect(page.locator('.cm-activeLine')).toContainText('service');
});

test('Ctrl+B toggles the sidebar and Cmd+Z navigates actions', async ({ page }) => {
  await page.goto('/?fixture=multi');
  const sidebar = page.locator('.app-sidebar');

  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeHidden();
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeVisible();

  await page.getByRole('button', { name: 'Open document', exact: true }).click();
  await expect(page.locator('.json-code-view')).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(page.getByRole('heading', { name: 'A quiet document' })).toBeVisible();
  await page.keyboard.press('Meta+Shift+z');
  await expect(page.locator('.json-code-view')).toBeVisible();
});

test('Cmd+P searches filenames and opens the keyboard-selected result', async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 420 });
  await page.goto('/?fixture=multi');

  await page.keyboard.press('Meta+p');
  await expect(page.locator('.file-quick-open')).toBeVisible();
  await expect(page.locator('.command-center-slot > .file-quick-open')).toBeVisible();
  await expect(page.locator('[data-quick-switcher]')).toHaveCount(0);
  expect((await page.locator('.file-quick-open').boundingBox())?.y).toBeLessThan(40);
  const inputBounds = await page.locator('[data-file-search-input]').boundingBox();
  const listBounds = await page.locator('#file-quick-open-results').boundingBox();
  expect(listBounds?.y).toBeGreaterThanOrEqual(
    (inputBounds?.y ?? 0) + (inputBounds?.height ?? 0),
  );
  await page.getByRole('button', { name: 'Open document', exact: true }).click();
  await expect(page.locator('.file-quick-open')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(2);

  await page.keyboard.press('Meta+p');
  const input = page.locator('[data-file-search-input]');
  await input.fill('md');
  await expect(page.locator('[data-file-search-result]')).toHaveCount(2);
  await input.press('ArrowDown');
  await input.press('Enter');

  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
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
  await page.keyboard.press('Meta+t');
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
