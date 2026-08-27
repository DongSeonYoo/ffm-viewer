import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders readable headings, paragraphs, and stable heading anchors', () => {
    const html = renderMarkdown('# Hello world\n\nA calm paragraph.');

    expect(html).toContain('<h1 id="hello-world">Hello world</h1>');
    expect(html).toContain('<p>A calm paragraph.</p>');
  });

  it('supports the GFM structures common in developer documents', () => {
    const html = renderMarkdown(
      '- [x] shipped\n- [ ] pending\n\n| key | value |\n| --- | --- |\n| mode | fast |\n\n~~old~~',
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<table>');
    expect(html).toContain('<del>old</del>');
  });

  it('highlights known fenced-code languages without changing the code text', () => {
    const html = renderMarkdown('```typescript\nconst ready: boolean = true;\n```');

    expect(html).toContain('class="language-typescript"');
    expect(html).toContain('token keyword');
    expect(html).toContain('ready');
  });

  it('keeps unknown fenced-code languages readable as escaped plain text', () => {
    const html = renderMarkdown('```unknown\n<tag>& value\n```');

    expect(html).toContain('class="language-unknown"');
    expect(html).toContain('&lt;tag&gt;&amp; value');
  });

  it('does not execute or preserve raw HTML from a local document', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('removes unsafe URL protocols while preserving visible link text', () => {
    const html = renderMarkdown('[safe](https://example.com) [unsafe](javascript:alert(1))');

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('safe');
    expect(html).toContain('unsafe');
    expect(html).not.toContain('javascript:');
  });
});
