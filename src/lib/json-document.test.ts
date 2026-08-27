import { describe, expect, it, vi } from 'vitest';
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

  it('accepts deeply nested data without recursively walking the whole document', () => {
    const depth = 4_000;
    const source = `${'['.repeat(depth)}0${']'.repeat(depth)}`;

    const root = parseJsonDocument(source);
    expect(root.kind).toBe('array');
    expect(root.childCount).toBe(1);
  });

  it('preserves numeric lexemes outside the JavaScript safe range', () => {
    const root = parseJsonDocument('[9223372036854775807,2.3e+500]');
    const values = getJsonChildren(root, 0, 10).items;

    expect(String(values[0]?.value)).toBe('9223372036854775807');
    expect(String(values[1]?.value)).toBe('2.3e+500');
  });

  it('reuses object keys instead of enumerating the whole object for every page', () => {
    const root = parseJsonDocument(
      JSON.stringify(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`key${i}`, i]))),
    );
    const entries = vi.spyOn(Object, 'entries');

    getJsonChildren(root, 0, 100);
    getJsonChildren(root, 100, 100);
    expect(entries).not.toHaveBeenCalled();
    entries.mockRestore();
  });
});
