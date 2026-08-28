import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonLanguage } from '@codemirror/lang-json';
import { createJsonCodeView, createTextCodeView } from './json-tree';
import { formatJsonDocument } from '../lib/json-document';

const diagnosticsEnabled = import.meta.env.VITE_FFM_DIAGNOSTICS === '1';
const diagnosticsIt = diagnosticsEnabled ? it : it.skip;
let diagnosticsResizeObserverDisconnects = 0;

class TestResizeObserver {
  private observed = 0;
  observe(): void { this.observed += 1; }
  disconnect(): void {
    if (this.observed === 5) diagnosticsResizeObserverDisconnects += 1;
  }
}

describe('createJsonCodeView', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    diagnosticsResizeObserverDisconnects = 0;
    if (diagnosticsEnabled) vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterAll(() => vi.unstubAllGlobals());

  it('applies the Tauri CSP nonce to CodeMirror runtime styles', () => {
    const nonceSource = document.createElement('style');
    nonceSource.id = 'ffm-csp-nonce-source';
    nonceSource.nonce = 'ffm-test-nonce';
    nonceSource.textContent = ':root {}';
    document.head.append(nonceSource);
    const existingStyles = new Set(document.head.querySelectorAll('style'));
    const viewer = createJsonCodeView(formatJsonDocument('{"ready":true}'));
    document.body.append(viewer);

    const codeMirrorStyle = Array.from(document.head.querySelectorAll('style'))
      .find((style) => !existingStyles.has(style));
    expect(codeMirrorStyle?.nonce).toBe('ffm-test-nonce');
    viewer.destroy();
    nonceSource.remove();
  });

  it('defers outline work until after the code view is available', async () => {
    const parse = vi.spyOn(jsonLanguage.parser, 'parse');
    const viewer = createJsonCodeView(formatJsonDocument('{"ready":true}'));
    document.body.append(viewer);

    expect(viewer.querySelector('.cm-content')).not.toBeNull();
    expect(viewer.querySelectorAll('[data-action="jump"]')).toHaveLength(0);
    expect(viewer.querySelector('.json-outline')?.getAttribute('aria-busy')).toBe('true');
    expect(viewer.querySelector('.json-outline-status')?.textContent).toContain('Building');
    expect(parse).not.toHaveBeenCalled();
    viewer.destroy();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('keeps very large JSON responsive without building an outline', () => {
    const parse = vi.spyOn(jsonLanguage.parser, 'parse');
    const viewer = createJsonCodeView(`{"value":"${'x'.repeat(3_000_000)}"}`);
    document.body.append(viewer);

    const outline = viewer.querySelector('.json-outline');
    expect(outline?.getAttribute('aria-busy')).toBeNull();
    expect(outline?.textContent).toContain('Outline is off');
    expect(parse).not.toHaveBeenCalled();
    viewer.destroy();
    parse.mockRestore();
  });

  it('cancels outline parsing when the view closes after its paint frame', async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => frames.push(callback));
    const parse = vi.spyOn(jsonLanguage.parser, 'parse');
    const viewer = createJsonCodeView(formatJsonDocument('{"ready":true}'));

    frames.at(-1)?.(0);
    viewer.destroy();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(parse).not.toHaveBeenCalled();
    requestFrame.mockRestore();
    parse.mockRestore();
  });

  it('shows formatted read-only code and top-level outline keys', async () => {
    const source = formatJsonDocument(
      '{"service":{"name":"api"},"ready":true}',
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    const outline = viewer.querySelector('.json-outline');
    await vi.waitFor(() => expect(outline?.textContent).toContain('service'));
    expect(outline?.textContent).toContain('ready');
    expect(outline?.textContent).not.toContain('name');
    expect(viewer.querySelector('.cm-lineNumbers')).not.toBeNull();
    const content = viewer.querySelector<HTMLElement>('.cm-content');
    expect(content?.getAttribute('aria-readonly')).toBe('true');
    expect(content?.getAttribute('autocomplete')).toBe('off');
    expect(content?.getAttribute('autocorrect')).toBe('off');
    expect(content?.getAttribute('autocapitalize')).toBe('off');
    expect(content?.getAttribute('spellcheck')).toBe('false');
    viewer.openSearch();
    const searchInput = viewer.querySelector<HTMLInputElement>('.cm-search input');
    expect(searchInput?.autocomplete).toBe('off');
    expect(searchInput?.spellcheck).toBe(false);
    expect(searchInput?.getAttribute('autocorrect')).toBe('off');
    expect(searchInput?.getAttribute('autocapitalize')).toBe('off');
    viewer.destroy();
  });

  it('expands nested keys and jumps to the selected code line', async () => {
    const source = formatJsonDocument(
      '{"service":{"name":"api","port":4000}}',
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    const toggle = await vi.waitFor(() => {
      const button = viewer.querySelector<HTMLButtonElement>(
        '[data-outline-label="service"] [data-action="toggle"]',
      );
      expect(button).not.toBeNull();
      return button;
    });
    toggle?.click();
    const name = viewer.querySelector<HTMLButtonElement>(
      '[data-action="jump"][data-outline-label="name"]',
    );
    expect(name).not.toBeNull();

    name?.click();
    expect(viewer.querySelector('.cm-activeLine')?.textContent).toContain('"name"');
    expect(name?.getAttribute('aria-current')).toBe('location');

    const service = viewer.querySelector<HTMLButtonElement>(
      '[data-action="jump"][data-outline-label="service"]',
    );
    service?.click();
    expect(service?.getAttribute('aria-current')).toBe('location');
    expect(name?.hasAttribute('aria-current')).toBe(false);
    expect(name?.closest('.json-outline-node')?.classList.contains('is-active')).toBe(false);
    expect(service?.closest('.json-outline-node')?.classList.contains('is-active')).toBe(true);
    expect(viewer.querySelectorAll('.json-outline-node.is-active')).toHaveLength(1);
    viewer.destroy();
  });

  diagnosticsIt('replaces and cleans up the dev diagnostics panel', () => {
    const removeEventListener = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const first = createJsonCodeView(formatJsonDocument('{"first":true}'));
    const second = createJsonCodeView(formatJsonDocument('{"second":true}'));
    document.body.append(first, second);

    expect(document.querySelectorAll('[data-ffm-diagnostics]')).toHaveLength(1);
    first.destroy();
    expect(document.querySelectorAll('[data-ffm-diagnostics]')).toHaveLength(1);
    second.destroy();
    expect(document.querySelector('[data-ffm-diagnostics]')).toBeNull();
    expect(diagnosticsResizeObserverDisconnects).toBe(2);
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(cancelAnimationFrame).toHaveBeenCalled();
    removeEventListener.mockRestore();
    removeWindowListener.mockRestore();
    cancelAnimationFrame.mockRestore();
  });

  it('pages large arrays instead of filling the outline DOM', async () => {
    const source = formatJsonDocument(
      JSON.stringify(Array.from({ length: 140 }, (_, index) => ({ index }))),
    );
    const viewer = createJsonCodeView(source);
    document.body.append(viewer);

    await vi.waitFor(() => {
      expect(viewer.querySelectorAll('[data-action="jump"]')).toHaveLength(100);
    });
    const more = viewer.querySelector<HTMLButtonElement>('[data-action="more"]');
    expect(more?.textContent).toContain('more');

    more?.click();
    expect(viewer.querySelectorAll('[data-action="jump"]')).toHaveLength(140);
    viewer.destroy();
  });
});

describe('createTextCodeView', () => {
  beforeEach(() => {
    if (diagnosticsEnabled) vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterAll(() => vi.unstubAllGlobals());

  it('shows arbitrary text as searchable read-only code without a JSON outline', () => {
    const viewer = createTextCodeView('server:\n  port: 4000');
    document.body.append(viewer);

    expect(viewer.querySelector('.cm-content')?.textContent).toContain('port: 4000');
    expect(viewer.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(viewer.querySelector('.cm-content')?.getAttribute('aria-readonly')).toBe('true');
    expect(viewer.querySelector('.json-outline')).toBeNull();
    viewer.destroy();
  });

  it('reveals a selected source range', () => {
    const viewer = createTextCodeView('needle first\nsecond needle');
    document.body.append(viewer);

    viewer.revealRange(20, 26);

    expect(viewer.querySelector('.cm-activeLine')?.textContent).toContain('second needle');
    viewer.destroy();
  });
});
