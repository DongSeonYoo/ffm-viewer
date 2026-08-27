import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonTree } from './json-tree';
import { parseJsonDocument } from '../lib/json-document';

describe('createJsonTree', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('shows the root and its immediate children while nested containers stay collapsed', () => {
    const tree = createJsonTree(
      parseJsonDocument('{"service":{"name":"api"},"ready":true}'),
    );
    document.body.append(tree);

    expect(tree.textContent).toContain('service');
    expect(tree.textContent).toContain('ready');
    expect(tree.textContent).not.toContain('name');
    expect(tree.querySelectorAll('[data-json-node]')).toHaveLength(3);
  });

  it('materializes nested children only after the user expands a node', () => {
    const tree = createJsonTree(
      parseJsonDocument('{"service":{"name":"api","ready":true}}'),
    );
    document.body.append(tree);

    const serviceToggle = tree.querySelector<HTMLButtonElement>(
      '[data-path="$.service"] [data-action="toggle"]',
    );
    serviceToggle?.click();

    expect(tree.textContent).toContain('name');
    expect(tree.textContent).toContain('api');
    expect(serviceToggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('reveals large collections in pages instead of creating an unbounded DOM', () => {
    const root = parseJsonDocument(JSON.stringify(Array.from({ length: 140 }, (_, i) => i)));
    const tree = createJsonTree(root);
    document.body.append(tree);

    expect(tree.querySelectorAll('[data-json-node]')).toHaveLength(101);
    const more = tree.querySelector<HTMLButtonElement>('[data-action="more"]');
    expect(more?.textContent).toContain('40 more');

    more?.click();
    expect(tree.querySelectorAll('[data-json-node]')).toHaveLength(141);
    expect(tree.querySelector('[data-action="more"]')).toBeNull();
  });

  it('copies a node path without enabling content editing', async () => {
    const tree = createJsonTree(parseJsonDocument('{"service":{"name":"api"}}'));
    document.body.append(tree);
    tree
      .querySelector<HTMLButtonElement>('[data-path="$.service"] [data-action="copy-path"]')
      ?.click();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('$.service');
    expect(tree.querySelector('textarea, input:not([type="checkbox"])')).toBeNull();
  });
});
