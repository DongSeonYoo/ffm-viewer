import { describe, expect, it } from 'vitest';
import { formatJsonDocument } from './json-document';

describe('formatJsonDocument', () => {
  it('formats with two spaces without truncating large numbers', () => {
    expect(
      formatJsonDocument('{"id":9223372036854775807,"nested":{"ready":true}}'),
    ).toBe(`{
  "id": 9223372036854775807,
  "nested": {
    "ready": true
  }
}`);
  });

  it('returns a useful parse error instead of raw parser details', () => {
    expect(() => formatJsonDocument('{"broken": }')).toThrow(/Invalid JSON/);
  });
});
