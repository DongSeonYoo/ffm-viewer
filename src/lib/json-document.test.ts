import { describe, expect, it } from 'vitest';
import {
  getJsonChildren,
  parseJsonDocument,
  toJsonPath,
} from './json-document';

describe('JSON document model', () => {
  it('parses an object without eagerly materializing descendant view nodes', () => {
    const root = parseJsonDocument('{"service":{"name":"api","ports":[80,443]},"ready":true}');

    expect(root.kind).toBe('object');
    expect(root.childCount).toBe(2);
    expect(root.path).toBe('$');
    expect(root.children).toBeUndefined();
  });

  it('materializes one bounded child page on demand', () => {
    const values = Array.from({ length: 140 }, (_, index) => index);
    const root = parseJsonDocument(JSON.stringify(values));
    const page = getJsonChildren(root, 0, 100);

    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(100);
    expect(page.items[99]?.path).toBe('$[99]');
  });

  it('preserves JSON primitive types for semantic coloring', () => {
    const root = parseJsonDocument('[null,true,3.5,"hello"]');
    const page = getJsonChildren(root, 0, 10);

    expect(page.items.map((item) => item.kind)).toEqual([
      'null',
      'boolean',
      'number',
      'string',
    ]);
  });

  it('builds unambiguous paths for identifier and non-identifier keys', () => {
    expect(toJsonPath('$', 'plain')).toBe('$.plain');
    expect(toJsonPath('$', 'with space')).toBe('$["with space"]');
    expect(toJsonPath('$', 'quote"key')).toBe('$["quote\\"key"]');
  });

  it('returns a useful parse error instead of throwing raw engine details', () => {
    expect(() => parseJsonDocument('{"broken": }')).toThrow(/Invalid JSON/);
  });
});
