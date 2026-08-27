import { describe, expect, it } from 'vitest';
import { isPastedDocumentTooLarge, preparePastedDocument } from './pasted-document';

describe('preparePastedDocument', () => {
  it('detects object and array JSON after whitespace or a BOM', () => {
    expect(preparePastedDocument('\uFEFF  {"id":9223372036854775807}')).toEqual({
      kind: 'json',
      content: '{\n  "id": 9223372036854775807\n}',
    });
    expect(preparePastedDocument('\n [1,2]')).toMatchObject({
      kind: 'json',
      content: '[\n  1,\n  2\n]',
    });
  });

  it('rejects pasted UTF-8 content beyond the configured byte ceiling', () => {
    expect(isPastedDocumentTooLarge('1234', 4)).toBe(false);
    expect(isPastedDocumentTooLarge('한글', 4)).toBe(true);
  });

  it('falls back to Markdown when bracketed text is not valid JSON', () => {
    expect(preparePastedDocument('{not JSON}')).toEqual({
      kind: 'markdown',
      content: '{not JSON}',
    });
  });

  it('suggests YAML or TOML only when multiple structural signals agree', () => {
    expect(preparePastedDocument('server:\n  port: 4000\n  host: localhost').hint).toBe('yaml');
    expect(preparePastedDocument('[server]\nport = 4000').hint).toBe('toml');
    expect(preparePastedDocument('Title: one ordinary sentence').hint).toBeUndefined();
  });
});
