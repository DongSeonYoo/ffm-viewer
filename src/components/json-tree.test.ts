import { beforeEach, describe, expect, it } from 'vitest';
import { createJsonCodeView } from './json-tree';
import { formatJsonDocument } from '../lib/json-document';

describe('createJsonCodeView', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows formatted read-only code and top-level outline keys', () => {
    const source = formatJsonDocument(
      '{"service":{"name":"api"},"ready":true}',
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    const outline = viewer.querySelector('.json-outline');
    expect(outline?.textContent).toContain('service');
    expect(outline?.textContent).toContain('ready');
    expect(outline?.textContent).not.toContain('name');
    expect(viewer.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(viewer.querySelector('.cm-content')?.getAttribute('aria-readonly')).toBe('true');
    viewer.destroy();
  });

  it('expands nested keys and jumps to the selected code line', () => {
    const source = formatJsonDocument(
      '{"service":{"name":"api","port":4000}}',
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    viewer
      .querySelector<HTMLButtonElement>('[data-outline-label="service"] [data-action="toggle"]')
      ?.click();
    const name = viewer.querySelector<HTMLButtonElement>(
      '[data-action="jump"][data-outline-label="name"]',
    );
    expect(name).not.toBeNull();

    name?.click();
    expect(viewer.querySelector('.cm-activeLine')?.textContent).toContain('"name"');
    viewer.destroy();
  });

  it('pages large arrays instead of filling the outline DOM', () => {
    const source = formatJsonDocument(
      JSON.stringify(Array.from({ length: 140 }, (_, index) => ({ index }))),
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    expect(viewer.querySelectorAll('[data-action="jump"]')).toHaveLength(100);
    const more = viewer.querySelector<HTMLButtonElement>('[data-action="more"]');
    expect(more?.textContent).toContain('more');

    more?.click();
    expect(viewer.querySelectorAll('[data-action="jump"]')).toHaveLength(140);
    viewer.destroy();
  });
});
