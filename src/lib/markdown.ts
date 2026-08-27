import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';
import Prism from 'prismjs';

import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';

const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stripMarkup(value: string): string {
  const template = document.createElement('template');
  template.innerHTML = value;
  return template.content.textContent ?? '';
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'section';
}

function createRenderer(): Renderer {
  const renderer = new Renderer();
  const slugs = new Map<string, number>();

  renderer.heading = function ({ tokens, depth }) {
    const content = this.parser.parseInline(tokens);
    const base = slugify(stripMarkup(content));
    const count = slugs.get(base) ?? 0;
    slugs.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    return `<h${depth} id="${escapeHtml(id)}">${content}</h${depth}>\n`;
  };

  renderer.code = function ({ text, lang }) {
    const language = lang?.trim().split(/\s+/)[0]?.toLocaleLowerCase() || 'text';
    const grammar = Prism.languages[language];
    const highlighted = grammar
      ? Prism.highlight(text, grammar, language)
      : escapeHtml(text);

    return `<pre><code class="language-${escapeHtml(language)}">${highlighted}</code></pre>\n`;
  };

  renderer.html = function () {
    return '';
  };

  return renderer;
}

export function renderMarkdown(source: string): string {
  const parser = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    renderer: createRenderer(),
  });
  const rendered = parser.parse(source) as string;

  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [
      'alt',
      'checked',
      'class',
      'disabled',
      'href',
      'id',
      'src',
      'title',
      'type',
    ],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
  });
}
