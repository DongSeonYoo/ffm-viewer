import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-shell';
import type {
  DesktopBridge,
  DocumentPayload,
  ScratchRecovery,
} from './lib/desktop-bridge';

const ALL_SEARCH_EXTENSIONS = [
  'md', 'markdown', 'json', 'txt', 'yaml', 'yml', 'toml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg',
] as const;

function markdownDocument(content = '# Read me'): DocumentPayload {
  return {
    path: '/tmp/readme.md',
    name: 'readme.md',
    kind: 'markdown',
    content,
  };
}

function jsonDocument(content = '{"service":{"name":"api"}}'): DocumentPayload {
  return {
    path: '/tmp/config.json',
    name: 'config.json',
    kind: 'json',
    content,
  };
}

function codeDocument(
  kind: 'text' | 'yaml' | 'toml',
  name: string,
  content: string,
): DocumentPayload {
  return { path: `/tmp/${name}`, name, kind, content };
}

function imageDocument(name = 'pixel.png'): DocumentPayload {
  return {
    path: `/tmp/${name}`,
    name,
    kind: 'image',
    content: 'data:image/png;base64,cGl4ZWw=',
  };
}

function pasteText(value: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => type === 'text/plain' ? value : '' },
  });
  window.dispatchEvent(event);
}

function createBridge(
  documents: Record<string, DocumentPayload> = {},
  recovery: readonly ScratchRecovery[] = [],
) {
  let openHandler: ((path: string) => void) | undefined;
  let changeHandler: ((path: string) => void) | undefined;
  let watchErrorHandler: ((path: string) => void) | undefined;
  let closeHandler: (() => Promise<boolean>) | undefined;
  let closeTabHandler: (() => void) | undefined;
  let searchFilesHandler: (() => void) | undefined;

  const bridge: DesktopBridge & {
    closeWindow: ReturnType<typeof vi.fn>;
  } = {
    chooseDocuments: vi.fn().mockResolvedValue([]),
    readDocument: vi.fn(async (path: string) => {
      const document = documents[path];
      if (!document) throw new Error('File could not be opened.');
      return document;
    }),
    watchDocument: vi.fn(async (_path, handler, onError) => {
      changeHandler = handler;
      watchErrorHandler = onError;
    }),
    takePendingOpen: vi.fn().mockResolvedValue([]),
    onOpenRequested: vi.fn(async (handler) => {
      openHandler = handler;
      return () => undefined;
    }),
    onFileDropped: vi.fn(async () => () => undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    resolveLocalImage: vi.fn().mockResolvedValue(null),
    confirmClose: vi.fn().mockResolvedValue('discard'),
    saveDocument: vi.fn().mockResolvedValue(false),
    loadRecovery: vi.fn().mockResolvedValue(recovery),
    persistRecovery: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn(async (handler) => {
      closeHandler = handler;
      return () => undefined;
    }),
    onCloseActiveTab: vi.fn(async (handler) => {
      closeTabHandler = handler;
      return () => undefined;
    }),
    onSearchFiles: vi.fn(async (handler) => {
      searchFilesHandler = handler;
      return () => undefined;
    }),
    searchDocuments: vi.fn().mockResolvedValue([]),
    closeWindow: vi.fn().mockResolvedValue(undefined),
  };

  return {
    bridge,
    requestOpen: (path: string) => openHandler?.(path),
    notifyChange: (path: string) => changeHandler?.(path),
    notifyWatchError: (path: string) => watchErrorHandler?.(path),
    requestClose: async () => closeHandler?.() ?? true,
    requestTabClose: () => closeTabHandler?.(),
    requestFileSearch: () => searchFilesHandler?.(),
  };
}

describe('createApp', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    document.body.innerHTML = '<div id="app"></div>';
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('starts with a quiet invitation to open or drop a supported document', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    expect(document.querySelector('.empty-state button')?.textContent).toMatch(/Open document/i);
    expect(document.body.textContent).toContain('supported local file');
  });

  it('uses the desktop open shortcut without adding editor chrome', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true }));
    await vi.waitFor(() => expect(bridge.chooseDocuments).toHaveBeenCalledOnce());
  });

  it('opens every document selected in the native dialog', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge } = createBridge({ [first.path]: first, [second.path]: second });
    vi.mocked(bridge.chooseDocuments).mockResolvedValue([first.path, second.path]);
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true }));

    await vi.waitFor(() => expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2));
    expect(Array.from(document.querySelectorAll('[role="tab"]'))
      .map((tab) => tab.textContent)).toEqual([
        expect.stringContaining('readme.md'),
        expect.stringContaining('second.md'),
      ]);
  });

  it('opens every queued startup document in order', async () => {
    const first = markdownDocument('# First');
    const second = { ...jsonDocument(), path: '/tmp/second.json', name: 'second.json' };
    const { bridge } = createBridge({ [first.path]: first, [second.path]: second });
    vi.mocked(bridge.takePendingOpen).mockResolvedValue([first.path, second.path]);

    await createApp(document.querySelector('#app')!, bridge);

    expect(Array.from(document.querySelectorAll('[role="tab"]'))
      .map((tab) => tab.textContent)).toEqual([
        expect.stringContaining('readme.md'),
        expect.stringContaining('second.json'),
      ]);
    expect(document.querySelector('.json-code-view')).not.toBeNull();
  });

  it('recovers dirty Scratch tabs before queued files without changing JSON digits', async () => {
    const pending = markdownDocument('# Pending file');
    const recovery: readonly ScratchRecovery[] = [{
      name: 'Untitled 7',
      kind: 'json',
      content: '{"id":9223372036854775807}',
    }];
    const { bridge } = createBridge({ [pending.path]: pending }, recovery);
    const order: string[] = [];
    vi.mocked(bridge.loadRecovery).mockImplementation(async () => {
      order.push('recovery');
      return recovery;
    });
    vi.mocked(bridge.takePendingOpen).mockImplementation(async () => {
      order.push('pending');
      return [pending.path];
    });

    await createApp(document.querySelector('#app')!, bridge);

    expect(order).toEqual(['recovery', 'pending']);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('[data-open-file="scratch:7"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent)
        .toContain('9223372036854775807');
    });
    expect(document.querySelector('.open-file-dirty')).not.toBeNull();
  });

  it('renders a selected Markdown file as an article', async () => {
    const payload = markdownDocument('# Calm reading\n\nNo editor chrome.');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => {
      expect(document.querySelector('.markdown-document h1')?.textContent).toBe('Calm reading');
    });
    expect(document.title).toContain('readme.md');
    expect(bridge.watchDocument).toHaveBeenCalledWith(
      payload.path,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('renders a JSON file as read-only code with a key outline', async () => {
    const payload = jsonDocument();
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.json-code-view')).not.toBeNull());
    expect(document.querySelector('.json-outline')?.textContent).toContain('service');
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(document.querySelector('.cm-content')?.getAttribute('aria-readonly')).toBe('true');
  });

  it('renders TXT, YAML, and TOML as read-only code without JSON parsing', async () => {
    const payloads = [
      codeDocument('text', 'notes.txt', 'plain notes'),
      codeDocument('yaml', 'config.yaml', 'server:\n  port: 4000'),
      codeDocument('toml', 'config.toml', '[server]\nport = 4000'),
    ];
    const documents = Object.fromEntries(payloads.map((payload) => [payload.path, payload]));
    const { bridge, requestOpen } = createBridge(documents);
    await createApp(document.querySelector('#app')!, bridge);

    for (const payload of payloads) {
      requestOpen(payload.path);
      await vi.waitFor(() => {
        expect(document.querySelector('.text-code-view')?.textContent).toContain(
          payload.content.split('\n').at(-1),
        );
      });
      expect(document.querySelector('[data-section-count="outline"]')?.textContent).toBe('0');
    }
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(Array.from(document.querySelectorAll('.document-tab .document-type'))
      .map((element) => element.textContent)).toEqual(['TXT', 'YAML', 'TOML']);
  });

  it('renders image documents through an img element without injecting SVG markup', async () => {
    const payload = {
      ...imageDocument('vector.svg'),
      content: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    };
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.image-document img')).not.toBeNull());
    expect(document.querySelector('.image-document img')?.getAttribute('src')).toBe(payload.content);
    expect(document.querySelector('.image-document script')).toBeNull();
    expect(document.querySelector('.document-tab .document-type')?.textContent).toBe('IMG');
  });

  it('shows a recoverable error when image bytes cannot be decoded', async () => {
    const payload = imageDocument();
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.image-document img')).not.toBeNull());

    document.querySelector('.image-document img')?.dispatchEvent(new Event('error'));

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Image could not be decoded',
    );
  });

  it('keeps opened documents in tabs and reuses an existing tab', async () => {
    const readme = markdownDocument('# Readme');
    const config = jsonDocument();
    const { bridge, requestOpen } = createBridge({
      [readme.path]: readme,
      [config.path]: config,
    });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(readme.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Readme'));
    requestOpen(config.path);
    await vi.waitFor(() => expect(document.querySelector('.json-code-view')).not.toBeNull());

    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-open-file]')).toHaveLength(2);
    expect(document.querySelector('[data-section-count="files"]')?.textContent).toBe('2');

    requestOpen(readme.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Readme'));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toContain('readme.md');
  });

  it('keeps the current document visible when another file cannot be opened', async () => {
    const current = markdownDocument('# Keep reading');
    const missingPath = '/tmp/missing.md';
    const { bridge, requestOpen } = createBridge({ [current.path]: current });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(current.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keep reading'));

    requestOpen(missingPath);

    await vi.waitFor(() => expect(bridge.readDocument).toHaveBeenCalledWith(missingPath));
    await vi.waitFor(() => {
      expect(document.querySelector('.watch-warning')?.textContent)
        .toContain('File could not be opened.');
    });
    expect(document.querySelector('.markdown-document h1')?.textContent).toBe('Keep reading');
    expect(document.querySelector('.error-state')).toBeNull();
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('readme.md');
  });

  it('wraps adjacent tab navigation and supports numbered file shortcuts', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const third = { ...markdownDocument('# Third'), path: '/tmp/third.md', name: 'third.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
      [third.path]: third,
    });
    await createApp(document.querySelector('#app')!, bridge);
    for (const payload of [first, second, third]) {
      requestOpen(payload.path);
      await vi.waitFor(() => expect(document.body.textContent).toContain(payload.content.slice(2)));
    }

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      metaKey: true,
      altKey: true,
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '9', metaKey: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Third'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
  });

  it('navigates document history with mouse buttons', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));

    document.querySelector<HTMLButtonElement>('[data-history="back"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    document.querySelector<HTMLButtonElement>('[data-history="forward"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
  });

  it('toggles the sidebar with Ctrl+B without adding navigation history', async () => {
    const payload = markdownDocument('# Sidebar');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Sidebar'));
    const sidebar = document.querySelector<HTMLElement>('.app-sidebar')!;
    const layout = document.querySelector<HTMLElement>('.app-layout')!;
    const back = document.querySelector<HTMLButtonElement>('[data-history="back"]')!;

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', code: 'KeyB', ctrlKey: true,
    }));

    expect(sidebar.hidden).toBe(true);
    expect(layout.classList.contains('is-sidebar-collapsed')).toBe(true);
    expect(back.disabled).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㅠ', code: 'KeyB', ctrlKey: true, altKey: true,
    }));

    expect(sidebar.hidden).toBe(false);
    expect(layout.classList.contains('is-sidebar-collapsed')).toBe(false);
    expect(back.disabled).toBe(true);
  });

  it('navigates sidebar and content focus with Cmd+Z and Cmd+Shift+Z', async () => {
    const payload = markdownDocument('# Focus history');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Focus history'));
    const sidebar = document.querySelector<HTMLElement>('.app-sidebar')!;
    const file = document.querySelector<HTMLButtonElement>('[data-open-file]')!;
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;

    file.focus();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    viewport.focus();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(sidebar.contains(document.activeElement)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(document.activeElement).toBe(viewport);
  });

  it('keeps the sidebar collapsed while navigating history', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    const sidebar = document.querySelector<HTMLElement>('.app-sidebar')!;

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', code: 'KeyB', ctrlKey: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    expect(sidebar.hidden).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true,
    }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    expect(sidebar.hidden).toBe(true);
  });

  it('does not add transient search and Settings focus to navigation history', async () => {
    const payload = markdownDocument('# Stable history');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Stable history'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    viewport.focus();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(viewport);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.querySelector<HTMLButtonElement>('[data-history="back"]')?.disabled)
      .toBe(true);
  });

  it('restores action scroll locations with the back and forward buttons', async () => {
    const payload = markdownDocument('# First\n\n## Second');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    viewport.scrollTop = 120;
    const heading = document.querySelectorAll<HTMLElement>('.markdown-document h2')[0]!;
    heading.scrollIntoView = () => { viewport.scrollTop = 240; };
    const outline = Array.from(document.querySelectorAll<HTMLButtonElement>('.outline-item'))
      .find((item) => item.textContent === 'Second')!;
    outline.focus();
    outline.click();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(240);

    document.querySelector<HTMLButtonElement>('[data-history="back"]')?.click();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(120);

    document.querySelector<HTMLButtonElement>('[data-history="forward"]')?.click();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(240);
  });

  it('keeps history entries intact during rapid back and forward shortcuts', async () => {
    const payload = markdownDocument('# First\n\n## Second');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    viewport.scrollTop = 120;
    const heading = document.querySelector<HTMLElement>('.markdown-document h2')!;
    heading.scrollIntoView = () => { viewport.scrollTop = 240; };
    const outline = Array.from(document.querySelectorAll<HTMLButtonElement>('.outline-item'))
      .find((item) => item.textContent === 'Second')!;
    outline.focus();
    outline.click();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(240);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(120);
  });

  it('cancels a deferred outline action when Cmd+Z runs immediately', async () => {
    const payload = markdownDocument('# First\n\n## Second');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    viewport.scrollTop = 120;
    const heading = document.querySelector<HTMLElement>('.markdown-document h2')!;
    heading.scrollIntoView = () => { viewport.scrollTop = 240; };
    const outline = Array.from(document.querySelectorAll<HTMLButtonElement>('.outline-item'))
      .find((item) => item.textContent === 'Second')!;

    outline.click();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(viewport.scrollTop).toBe(120);
    expect(document.querySelector<HTMLButtonElement>('[data-history="forward"]')?.disabled)
      .toBe(false);
  });

  it('cancels a deferred same-tab search reveal when Cmd+Z runs immediately', async () => {
    const payload = markdownDocument('# Search\n\nneedle target');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle target'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    viewport.scrollTop = 120;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(viewport.scrollTop).toBe(120);
    expect(window.getSelection()?.toString()).toBe('');
    expect(document.querySelector<HTMLButtonElement>('[data-history="forward"]')?.disabled)
      .toBe(false);
  });

  it('reapplies history focus after a watcher refresh rerenders the file', async () => {
    const payload = markdownDocument('# Before');
    const documents = { [payload.path]: payload };
    const { bridge, requestOpen, notifyChange } = createBridge(documents);
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Before'));
    const viewport = document.querySelector<HTMLElement>('.document-viewport')!;
    const sidebar = document.querySelector<HTMLElement>('.app-sidebar')!;
    const file = document.querySelector<HTMLButtonElement>('[data-open-file]')!;
    viewport.scrollTop = 80;
    file.focus();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    viewport.focus();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(sidebar.contains(document.activeElement)).toBe(true);

    let resolveRefresh!: (payload: DocumentPayload) => void;
    const refresh = new Promise<DocumentPayload>((resolve) => { resolveRefresh = resolve; });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => refresh);
    notifyChange(payload.path);
    resolveRefresh(markdownDocument('# After'));

    await vi.waitFor(() => expect(document.body.textContent).toContain('After'));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(80);
    expect(sidebar.contains(document.activeElement)).toBe(true);

    let resolveCanceledRefresh!: (payload: DocumentPayload) => void;
    const canceledRefresh = new Promise<DocumentPayload>((resolve) => {
      resolveCanceledRefresh = resolve;
    });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => canceledRefresh);
    notifyChange(payload.path);
    resolveCanceledRefresh(markdownDocument('# Again'));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.textContent).toContain('Again');
    viewport.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    viewport.focus();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(sidebar.contains(document.activeElement)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const searchInput = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let resolveSearchRefresh!: (payload: DocumentPayload) => void;
    const searchRefresh = new Promise<DocumentPayload>((resolve) => {
      resolveSearchRefresh = resolve;
    });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => searchRefresh);
    notifyChange(payload.path);
    resolveSearchRefresh(markdownDocument('# Final'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Final'));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(searchInput);
  });

  it('keeps history aligned when an earlier inactive tab closes', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const third = { ...markdownDocument('# Third'), path: '/tmp/third.md', name: 'third.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
      [third.path]: third,
    });
    await createApp(document.querySelector('#app')!, bridge);
    for (const payload of [first, second, third]) {
      requestOpen(payload.path);
      await vi.waitFor(() => expect(document.body.textContent).toContain(payload.content.slice(2)));
    }

    document.querySelector<HTMLButtonElement>('[data-history="back"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    document.querySelector<HTMLButtonElement>('[aria-label="Close readme.md"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-history="forward"]')?.click();

    await vi.waitFor(() => expect(document.body.textContent).toContain('Third'));
  });

  it('does not rebuild the active document when an inactive tab closes', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));
    document.querySelector<HTMLButtonElement>('[data-open-file="/tmp/readme.md"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    const article = document.querySelector('.markdown-document');

    document.querySelector<HTMLButtonElement>('[aria-label="Close second.md"]')?.click();

    expect(document.querySelector('.markdown-document')).toBe(article);
    expect(document.body.textContent).toContain('First');
  });

  it('searches content across open tabs with Cmd+K and jumps to the selected match', async () => {
    const first = markdownDocument('# Readme\n\nneedle first\n\nneedle second');
    const second = {
      ...markdownDocument('# Notes\n\nneedle in notes'),
      path: '/tmp/notes.md',
      name: 'notes.md',
    };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Readme'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Notes'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]');
    expect(input).not.toBeNull();
    input!.value = 'needle';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelectorAll('[data-open-tab-search-result]')).toHaveLength(3);
    expect(document.querySelector('[data-quick-switcher]')?.textContent).toContain('needle second');
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
        .toContain('readme.md');
      expect(window.getSelection()?.anchorNode?.parentElement?.textContent)
        .toContain('needle second');
    });
    expect(document.querySelector('[data-quick-switcher]')).toBeNull();
  });

  it('updates the large grouped content-search modal on every input event', async () => {
    const first = markdownDocument('# Readme\n\nneedle first\n\nneedle second');
    const second = {
      ...markdownDocument('# Notes\n\nneedle in notes'),
      path: '/tmp/notes.md',
      name: 'notes.md',
    };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Readme'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Notes'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expect(document.querySelector('[data-quick-switcher]')?.classList.contains('content-search'))
      .toBe(true);
    expect(document.querySelector('.quick-switcher-box')?.classList.contains(
      'content-search-box',
    )).toBe(true);
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(document.querySelector('[data-content-search-summary]')?.textContent)
      .toBe('3 results in 2 documents');
    expect(document.querySelectorAll('[data-content-search-group]')).toHaveLength(2);
    expect(document.querySelector('[data-content-search-group="/tmp/readme.md"]')?.textContent)
      .toContain('2');
    expect(document.querySelector('[data-content-search-group="/tmp/notes.md"]')?.textContent)
      .toContain('1');

    input.value = 'first';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(document.querySelector('[data-content-search-summary]')?.textContent)
      .toBe('1 result in 1 document');
    expect(document.querySelectorAll('[data-open-tab-search-result]')).toHaveLength(1);
    expect(document.querySelector('[data-content-search-group]')?.textContent)
      .toContain('readme.md');
  });

  it('opens the same open-tab content search with Cmd+Shift+F', async () => {
    const payload = markdownDocument('# Search me');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Search me'));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㄹ', code: 'KeyF', metaKey: true, shiftKey: true,
    }));

    expect(document.querySelector('[data-open-tab-search-input]')).not.toBeNull();
    expect(document.querySelector('[data-document-search]')).toBeNull();
  });

  it('jumps to a Markdown result after more than 500 earlier matches', async () => {
    const payload = markdownDocument(
      `# Many matches\n\n${'needle '.repeat(501)}\n\nneedle target`,
    );
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle target'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(window.getSelection()?.anchorNode?.parentElement?.textContent)
        .toContain('needle target');
    });
  });

  it('keeps later matching tabs visible when the first tab fills the result limit', async () => {
    const first = codeDocument(
      'text',
      'busy.txt',
      Array.from({ length: 100 }, (_, index) => `needle ${index}`).join('\n'),
    );
    const second = codeDocument('text', 'later.txt', 'needle in later tab');
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
        .toContain('busy.txt');
    });
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle in later tab'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(document.querySelector('[data-quick-switcher]')?.textContent).toContain('later.txt');
    expect(document.querySelectorAll('[data-open-tab-search-result]')).toHaveLength(100);
  });

  it('reveals the exact Unicode code match found by open-tab search', async () => {
    const payload = codeDocument('text', 'unicode.txt', 'first line\n\u03c2 target');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('\u03c2 target'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = '\u03c3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('.cm-activeLine')?.textContent).toContain('\u03c2 target');
    });
  });

  it('refreshes visible open-tab results before Enter after a watched file changes', async () => {
    const payload = codeDocument('text', 'watched.txt', 'needle old');
    const documents = { [payload.path]: payload };
    const { bridge, requestOpen, notifyChange } = createBridge(documents);
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle old'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('[data-quick-switcher]')?.textContent).toContain('needle old');

    documents[payload.path] = codeDocument('text', 'watched.txt', 'prefix\nneedle new');
    notifyChange(payload.path);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-quick-switcher]')?.textContent).toContain('needle new');
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('.cm-activeLine')?.textContent).toContain('needle new');
    });
  });

  it('does not apply stale code offsets when a watcher refresh wins before reveal', async () => {
    const payload = codeDocument('text', 'watched.txt', 'prefix\nneedle old');
    const { bridge, requestOpen, notifyChange } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle old'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    let resolveRefresh!: (payload: DocumentPayload) => void;
    const refresh = new Promise<DocumentPayload>((resolve) => { resolveRefresh = resolve; });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => refresh);
    notifyChange(payload.path);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    resolveRefresh({ ...payload, content: 'start\nwrong spot\nneedle new' });

    await vi.waitFor(() => expect(document.body.textContent).toContain('needle new'));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(document.querySelector('.cm-activeLine')?.textContent).toContain('start');
  });

  it('reveals an inactive-file result after its delayed refresh finishes', async () => {
    const first = markdownDocument('# Home');
    const second = codeDocument('text', 'watched.txt', 'prefix\nneedle old');
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle old'));
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Home'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    let resolveRefresh!: (payload: DocumentPayload) => void;
    const refresh = new Promise<DocumentPayload>((resolve) => { resolveRefresh = resolve; });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => refresh);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    resolveRefresh({ ...second, content: 'start\nneedle new' });

    await vi.waitFor(() => expect(document.body.textContent).toContain('needle new'));
    await vi.waitFor(() => {
      expect(document.querySelector('.cm-activeLine')?.textContent).toContain('needle new');
    });
  });

  it('can go back while an inactive search destination is still refreshing', async () => {
    const first = markdownDocument('# Home');
    const second = codeDocument('text', 'watched.txt', 'needle old');
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('needle old'));
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Home'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'needle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    let resolveRefresh!: (payload: DocumentPayload) => void;
    const refresh = new Promise<DocumentPayload>((resolve) => { resolveRefresh = resolve; });
    vi.mocked(bridge.readDocument).mockImplementationOnce(() => refresh);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z', code: 'KeyZ', metaKey: true,
    }));

    await vi.waitFor(() => expect(document.body.textContent).toContain('Home'));
    resolveRefresh({ ...second, content: 'needle new' });
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(document.body.textContent).toContain('Home');
  });

  it('creates a new Scratch tab with Cmd+T', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㅅ', code: 'KeyT', metaKey: true,
    }));

    expect(document.querySelector('[role="tab"]')?.textContent).toContain('Untitled 1');
    expect(document.body.textContent).toContain('Paste content to preview');
  });

  it('searches supported files with Cmd+P and opens the keyboard-selected result', async () => {
    const readme = markdownDocument('# Readme');
    const data = jsonDocument('{"selected":true}');
    const { bridge } = createBridge({ [readme.path]: readme, [data.path]: data });
    vi.mocked(bridge.searchDocuments).mockResolvedValue([readme.path, data.path]);
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㅔ', code: 'KeyP', metaKey: true,
    }));
    const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;
    expect(input).not.toBeNull();
    expect(document.querySelector('[data-file-search]')?.classList.contains('file-quick-open'))
      .toBe(true);
    expect(document.querySelector('[data-quick-switcher]')).toBeNull();
    input.value = 'read';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'read', true, ALL_SEARCH_EXTENSIONS,
    ));
    await vi.waitFor(() => expect(document.querySelector('.json-code-view')).not.toBeNull());
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('config.json');
  });

  it('opens Cmd+P from the top command center and closes it on an outside pointer', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    const commandCenter = document.querySelector<HTMLButtonElement>('.command-center')!;

    expect(commandCenter.textContent).toContain('⌘P');
    commandCenter.click();
    expect(document.querySelector('[data-file-search-input]')).not.toBeNull();

    document.querySelector<HTMLElement>('.app-sidebar')?.dispatchEvent(new Event(
      'pointerdown',
      { bubbles: true },
    ));

    expect(document.querySelector('[data-file-search]')).toBeNull();
  });

  it('opens Mac file search from the native menu request', async () => {
    const { bridge, requestFileSearch } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    requestFileSearch();

    expect(document.querySelector('[data-file-search-input]')).not.toBeNull();
  });

  it('replays startup Cmd+P after queued startup files finish opening', async () => {
    const payload = markdownDocument('# Startup file');
    const { bridge } = createBridge({ [payload.path]: payload });
    vi.mocked(bridge.takePendingOpen).mockResolvedValue([payload.path]);
    vi.mocked(bridge.onSearchFiles).mockImplementation(async (handler) => {
      handler();
      return () => undefined;
    });

    await createApp(document.querySelector('#app')!, bridge);

    expect(document.body.textContent).toContain('Startup file');
    expect(document.querySelector('[data-file-search-input]')).not.toBeNull();
  });

  it('handles global shortcuts before a focused code view stops bubbling', async () => {
    const payload = jsonDocument();
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    const editor = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('.cm-content');
      expect(element).not.toBeNull();
      return element!;
    });
    editor.addEventListener('keydown', (event) => event.stopPropagation());

    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㅔ', code: 'KeyP', metaKey: true, bubbles: true,
    }));

    expect(document.querySelector('[data-file-search-input]')).not.toBeNull();
  });

  it('closes transient search UI before opening an externally requested file', async () => {
    const payload = markdownDocument('# Opened outside');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    expect(document.querySelector('[data-file-search]')).not.toBeNull();
    requestOpen(payload.path);

    await vi.waitFor(() => expect(document.body.textContent).toContain('Opened outside'));
    expect(document.querySelector('[data-file-search]')).toBeNull();
  });

  it('serializes Cmd+P filename searches and keeps only the newest result', async () => {
    let resolveFirst!: (paths: readonly string[]) => void;
    const first = new Promise<readonly string[]>((resolve) => { resolveFirst = resolve; });
    const { bridge } = createBridge();
    vi.mocked(bridge.searchDocuments).mockImplementation((query) => (
      query === 'a' ? first : Promise.resolve(['/tmp/newer.md'])
    ));
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;

    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'a', true, expect.any(Array),
    ));
    input.value = 'new';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(bridge.searchDocuments).toHaveBeenCalledTimes(1);
    resolveFirst(['/tmp/older.md']);
    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'new', false, expect.any(Array),
    ));
    await vi.waitFor(() => expect(document.body.textContent).toContain('newer.md'));

    expect(document.body.textContent).not.toContain('older.md');
  });

  it('refreshes the filename cache once for every Cmd+P overlay', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    const search = async (query: string, refresh: boolean) => {
      const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
        query, refresh, expect.any(Array),
      ));
    };

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    await search('first', true);
    await search('second', false);

    document.querySelector<HTMLInputElement>('[data-file-search-input]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    await search('reopened', true);
  });

  it('keeps the filename refresh pending when the first search fails', async () => {
    const { bridge } = createBridge();
    vi.mocked(bridge.searchDocuments)
      .mockRejectedValueOnce(new Error('Search failed'))
      .mockResolvedValue([]);
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;
    input.value = 'first';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'first', true, expect.any(Array),
    ));
    await vi.waitFor(() => expect(document.body.textContent).toContain('File search is unavailable.'));

    input.value = 'retry';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'retry', true, expect.any(Array),
    ));
  });

  it('opens current-document search with Cmd+F when CodeMirror is not focused', async () => {
    const payload = jsonDocument();
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.json-code-view')).not.toBeNull());

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㄹ', code: 'KeyF', metaKey: true,
    }));

    await vi.waitFor(() => expect(document.querySelector('.cm-search')).not.toBeNull());
  });

  it('finds rendered Markdown text with Cmd+F', async () => {
    const payload = markdownDocument('# Read me\n\nFind this sentence.\n\nAcross\n\nblocks');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.markdown-document')).not.toBeNull());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-document-search-input]')!;
    expect(input).not.toBeNull();
    input.value = 'Find this';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.querySelector('.document-search-count')?.textContent).toBe('1/1');
    expect(document.activeElement).toBe(input);

    input.value = 'Acrossblocks';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('.document-search-count')?.textContent).toBe('0/0');
  });

  it('starts reverse Markdown search at the final match', async () => {
    const payload = markdownDocument('match first, match last');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.markdown-document')).not.toBeNull());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-document-search-input]')!;
    input.value = 'match';
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, bubbles: true,
    }));

    expect(document.querySelector('.document-search-count')?.textContent).toBe('2/2');
  });

  it('finds Markdown text after Unicode characters without corrupting Range offsets', async () => {
    const payload = markdownDocument('# İX marker');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.markdown-document')).not.toBeNull());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-document-search-input]')!;
    const addRange = vi.spyOn(window.getSelection()!, 'addRange');
    input.value = 'X';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.querySelector('.document-search-count')?.textContent).toBe('1/1');
    expect(addRange.mock.calls[0]?.[0].toString()).toBe('X');
    addRange.mockRestore();
  });

  it('closes one of several tabs with literal Ctrl+W without closing the window', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge, requestOpen } = createBridge({ [first.path]: first, [second.path]: second });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ㅈ', code: 'KeyW', ctrlKey: true, altKey: true,
    }));

    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(bridge.closeWindow).not.toHaveBeenCalled();
  });

  it('closes the window when Ctrl+W removes the last tab or no tab is open', async () => {
    const payload = markdownDocument('# Only');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Only'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    await vi.waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    await vi.waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(2));
  });

  it('keeps a dirty last tab and window open when Ctrl+W is cancelled', async () => {
    const { bridge } = createBridge();
    vi.mocked(bridge.confirmClose).mockResolvedValue('cancel');
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    pasteText('# Keep me');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));

    await vi.waitFor(() => expect(bridge.confirmClose).toHaveBeenCalled());
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(bridge.closeWindow).not.toHaveBeenCalled();
  });

  it('asks once when repeated Ctrl+W targets the same dirty Scratch tab', async () => {
    let resolveDecision!: (decision: 'discard') => void;
    const decision = new Promise<'discard'>((resolve) => { resolveDecision = resolve; });
    const { bridge } = createBridge();
    vi.mocked(bridge.confirmClose).mockImplementation(() => decision);
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    pasteText('# Close once');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));

    expect(bridge.confirmClose).toHaveBeenCalledTimes(1);
    resolveDecision('discard');
    await vi.waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('waits for Scratch recovery before accepting another tab or window close', async () => {
    let resolveRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { resolveRecovery = resolve; });
    const { bridge, requestClose } = createBridge();
    vi.mocked(bridge.confirmClose).mockResolvedValue('save');
    vi.mocked(bridge.saveDocument).mockResolvedValue(true);
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true }));
    pasteText('# Save once');
    await vi.waitFor(() => expect(bridge.persistRecovery).toHaveBeenCalled());
    vi.mocked(bridge.persistRecovery).mockClear();
    vi.mocked(bridge.persistRecovery).mockImplementation(() => recovery);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    await vi.waitFor(() => expect(bridge.persistRecovery).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));

    await expect(requestClose()).resolves.toBe(false);
    expect(bridge.confirmClose).toHaveBeenCalledTimes(1);
    expect(bridge.saveDocument).toHaveBeenCalledTimes(1);
    expect(bridge.persistRecovery).toHaveBeenCalledTimes(1);
    expect(bridge.closeWindow).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);

    resolveRecovery();
    await vi.waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('does not treat Control as Command', async () => {
    const payload = markdownDocument('# Keep shortcuts native');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keep shortcuts native'));

    for (const [key, code] of [
      ['ㄹ', 'KeyF'],
      ['ㅔ', 'KeyP'],
      ['ㅏ', 'KeyK'],
      ['ㅅ', 'KeyT'],
    ]) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true }));
    }

    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(document.querySelector('[data-document-search]')).toBeNull();
    expect(document.querySelector('[data-file-search]')).toBeNull();
    expect(document.querySelector('[data-quick-switcher]')).toBeNull();
  });

  it('opens Settings with Cmd+, and defaults to FFM Green', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="Open document"]')!;
    opener.focus();

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',',
      code: 'Comma',
      metaKey: true,
    }));

    expect(document.documentElement.dataset.theme).toBe('green');
    expect(document.querySelector('dialog[data-settings]')).not.toBeNull();
    const select = document.querySelector<HTMLSelectElement>('[name="theme"]')!;
    expect(select.value).toBe('green');
    const formatInputs = Array.from(document.querySelectorAll<HTMLInputElement>(
      '[name="search-format"]',
    ));
    const lastFormat = formatInputs.at(-1)!;
    lastFormat.focus();
    lastFormat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(
      document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]'),
    );
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
    }));
    expect(document.activeElement).toBe(lastFormat);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-settings]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes Settings when its backdrop is clicked', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="Open document"]')!;
    opener.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', metaKey: true,
    }));

    document.querySelector<HTMLElement>('.settings-overlay')?.click();

    expect(document.querySelector('[data-settings]')).toBeNull();
    expect(document.activeElement).toBe(opener);

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', metaKey: true,
    }));
    const dialog = document.querySelector<HTMLDialogElement>('[data-settings]')!;
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 300,
      top: 100,
      bottom: 300,
      width: 200,
      height: 200,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    dialog.dispatchEvent(new MouseEvent('click', {
      clientX: 50,
      clientY: 50,
      bubbles: true,
    }));

    expect(document.querySelector('[data-settings]')).toBeNull();
  });

  it('persists Cmd+P file type filters and sends only enabled extensions', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', metaKey: true,
    }));

    const all = document.querySelector<HTMLInputElement>('[data-search-format-all]')!;
    const formats = Array.from(document.querySelectorAll<HTMLInputElement>(
      '[name="search-format"]',
    ));
    expect(formats).toHaveLength(11);
    expect(all.checked).toBe(true);
    expect(formats.every(({ checked }) => checked)).toBe(true);

    all.click();
    expect(formats.every(({ checked }) => !checked)).toBe(true);
    expect(window.localStorage.getItem('ffm.searchFormats')).toBe('');
    all.click();
    expect(formats.every(({ checked }) => checked)).toBe(true);

    document.querySelector<HTMLInputElement>('[data-search-format="json"]')!.click();
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);

    document.body.innerHTML = '<div id="app"></div>';
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',', code: 'Comma', metaKey: true,
    }));
    expect(document.querySelector<HTMLInputElement>('[data-search-format="json"]')?.checked)
      .toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;
    input.value = 'config';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(bridge.searchDocuments).toHaveBeenCalledWith(
      'config',
      true,
      ALL_SEARCH_EXTENSIONS.filter((extension) => extension !== 'json'),
    ));
  });

  it('disables writing assistance in every app search input', async () => {
    const payload = markdownDocument('# Search input');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Search input'));

    const expectAssistanceOff = (input: HTMLInputElement) => {
      expect(input.autocomplete).toBe('off');
      expect(input.spellcheck).toBe(false);
      expect(input.getAttribute('autocorrect')).toBe('off');
      expect(input.getAttribute('autocapitalize')).toBe('off');
    };

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    expectAssistanceOff(document.querySelector('[data-file-search-input]')!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expectAssistanceOff(document.querySelector('[data-open-tab-search-input]')!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    expectAssistanceOff(document.querySelector('[data-document-search-input]')!);
  });

  it('persists the selected theme and restores it on the next launch', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',',
      code: 'Comma',
      metaKey: true,
    }));

    const select = document.querySelector<HTMLSelectElement>('[name="theme"]')!;
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('ffm.theme')).toBe('light');

    document.body.innerHTML = '<div id="app"></div>';
    delete document.documentElement.dataset.theme;
    await createApp(document.querySelector('#app')!, bridge);
    expect(document.documentElement.dataset.theme).toBe('light');

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',',
      code: 'Comma',
      metaKey: true,
    }));
    expect(document.querySelector<HTMLSelectElement>('[name="theme"]')?.value).toBe('light');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-settings]')).toBeNull();
  });

  it('falls back to FFM Green when the stored theme is invalid', async () => {
    window.localStorage.setItem('ffm.theme', 'unknown');
    const { bridge } = createBridge();

    await createApp(document.querySelector('#app')!, bridge);

    expect(document.documentElement.dataset.theme).toBe('green');
  });

  it('keeps theme switching usable when localStorage fails', async () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',',
      code: 'Comma',
      metaKey: true,
    }));

    const select = document.querySelector<HTMLSelectElement>('[name="theme"]')!;
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.documentElement.dataset.theme).toBe('light');
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('closes only the active tab when the native Close Tab menu fires', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const { bridge, requestOpen, requestTabClose } = createBridge({
      [first.path]: first,
      [second.path]: second,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));

    requestTabClose();

    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('First');
  });

  it('creates a Scratch tab with Cmd+N and previews pasted Markdown', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    expect(document.body.textContent).toContain('Paste content to preview');
    pasteText('# Pasted document');

    await vi.waitFor(() => {
      expect(document.querySelector('.markdown-document h1')?.textContent).toBe('Pasted document');
    });
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('Untitled 1');
    expect(document.querySelector('.open-file-dirty')).not.toBeNull();
  });

  it('keeps pasted content visible and warns when recovery persistence fails', async () => {
    const { bridge } = createBridge();
    vi.mocked(bridge.persistRecovery).mockRejectedValue(new Error('disk unavailable'));
    await createApp(document.querySelector('#app')!, bridge);

    pasteText('# Still visible');

    await vi.waitFor(() => {
      expect(document.querySelector('.markdown-document h1')?.textContent)
        .toBe('Still visible');
    });
    expect(document.querySelector('.watch-warning')?.textContent)
      .toContain('Recovery unavailable');
  });

  it('opens a second Scratch tab instead of replacing pasted content', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    pasteText('# First paste');
    pasteText('# Second paste');

    await vi.waitFor(() => expect(document.body.textContent).toContain('Second paste'));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('Untitled 2');
  });

  it('detects pasted JSON once and renders the formatted JSON viewer', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));

    pasteText('  {"id":9223372036854775807}');

    await vi.waitFor(() => expect(document.querySelector('.json-code-view')).not.toBeNull());
    expect(document.querySelector('.cm-content')?.textContent).toContain('9223372036854775807');
    expect(document.querySelector('.document-tab .document-type')?.textContent).toBe('JSON');
  });

  it('offers a nonblocking YAML hint and switches only after confirmation', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));

    pasteText('server:\n  port: 4000\n  host: localhost');

    await vi.waitFor(() => expect(document.querySelector('.markdown-document')).not.toBeNull());
    expect(document.querySelector<HTMLElement>('[data-format-hint]')?.hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-file-search-input]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('[data-file-search]')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-format-hint]')?.hidden).toBe(false);

    document.querySelector<HTMLButtonElement>('[data-view-as="yaml"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('.text-code-view')?.textContent).toContain('port: 4000');
    });
    expect(document.querySelector('.document-tab .document-type')?.textContent).toBe('YAML');
  });

  it('switches Scratch format through Cmd+K actions', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    pasteText('[server]\nport = 4000');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    const input = document.querySelector<HTMLInputElement>('[data-open-tab-search-input]')!;
    input.value = 'view';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelectorAll('[data-quick-action-kind]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-quick-action-kind].is-active')).toHaveLength(1);
    expect(document.querySelectorAll('[data-quick-action-kind][aria-selected="true"]'))
      .toHaveLength(1);

    input.value = 'toml';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-quick-action-kind="toml"]')).not.toBeNull();
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector('.text-code-view')?.textContent).toContain('port = 4000');
    });
    expect(document.querySelector('.document-tab .document-type')?.textContent).toBe('TOML');
  });

  it('keeps dirty Scratch content open when close is cancelled', async () => {
    const { bridge } = createBridge();
    vi.mocked(bridge.confirmClose).mockResolvedValue('cancel');
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    pasteText('# Keep me');

    document.querySelector<HTMLButtonElement>('[aria-label="Close Untitled 1"]')?.click();

    await vi.waitFor(() => expect(bridge.confirmClose).toHaveBeenCalledWith('Untitled 1'));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keep me'));
  });

  it('saves a dirty Scratch document before closing it', async () => {
    const { bridge } = createBridge();
    vi.mocked(bridge.confirmClose).mockResolvedValue('save');
    vi.mocked(bridge.saveDocument).mockResolvedValue(true);
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    pasteText('# Save me');

    document.querySelector<HTMLButtonElement>('[aria-label="Close Untitled 1"]')?.click();

    await vi.waitFor(() => expect(bridge.saveDocument).toHaveBeenCalledWith(
      'Untitled 1',
      'markdown',
      '# Save me',
    ));
    await vi.waitFor(() => expect(bridge.persistRecovery).toHaveBeenCalledWith([]));
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('removes discarded Scratch content from recovery before closing the tab', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);
    pasteText('# Discard me');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Discard me'));

    document.querySelector<HTMLButtonElement>('[aria-label="Close Untitled 1"]')?.click();

    await vi.waitFor(() => expect(bridge.persistRecovery).toHaveBeenCalledWith([]));
    await vi.waitFor(() => expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0));
  });

  it('cancels application close when any dirty Scratch refuses to close', async () => {
    const { bridge, requestClose } = createBridge();
    vi.mocked(bridge.confirmClose).mockResolvedValue('cancel');
    await createApp(document.querySelector('#app')!, bridge);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
    pasteText('# Unsaved');

    await expect(requestClose()).resolves.toBe(false);
    expect(document.body.textContent).toContain('Unsaved');
  });

  it('shows a recoverable error for malformed JSON', async () => {
    const payload = jsonDocument('{"broken": }');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.body.textContent).toContain('Invalid JSON');
    expect(document.body.textContent).toContain('Open another document');
  });

  it('refreshes the current document after a file-system change', async () => {
    const payload = markdownDocument('# Before');
    const documents = { [payload.path]: payload };
    const { bridge, requestOpen, notifyChange } = createBridge(documents);
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Before'));

    documents[payload.path] = markdownDocument('# After');
    notifyChange(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('After'));
    expect(bridge.watchDocument).toHaveBeenCalledTimes(1);
  });

  it('registers the watcher before reading the first snapshot', async () => {
    const payload = markdownDocument('# Watched');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    const order: string[] = [];
    vi.mocked(bridge.watchDocument).mockImplementation(async () => {
      order.push('watch');
    });
    vi.mocked(bridge.readDocument).mockImplementation(async () => {
      order.push('read');
      return payload;
    });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Watched'));
    expect(order.slice(0, 2)).toEqual(['watch', 'read']);
  });

  it('reasserts watcher ownership when a slow open becomes the active tab', async () => {
    const first = markdownDocument('# First');
    const second = { ...markdownDocument('# Second'), path: '/tmp/second.md', name: 'second.md' };
    const slow = { ...markdownDocument('# Slow'), path: '/tmp/slow.md', name: 'slow.md' };
    const { bridge, requestOpen } = createBridge({
      [first.path]: first,
      [second.path]: second,
      [slow.path]: slow,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(first.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('First'));
    requestOpen(second.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Second'));

    let releaseSlowWatch!: () => void;
    const slowWatch = new Promise<void>((resolve) => {
      releaseSlowWatch = resolve;
    });
    let heldSlowWatch = false;
    vi.mocked(bridge.watchDocument).mockClear();
    vi.mocked(bridge.watchDocument).mockImplementation(async (path) => {
      if (path === slow.path && !heldSlowWatch) {
        heldSlowWatch = true;
        await slowWatch;
      }
    });

    requestOpen(slow.path);
    await vi.waitFor(() => expect(bridge.watchDocument).toHaveBeenCalledWith(
      slow.path,
      expect.any(Function),
      expect.any(Function),
    ));
    document.querySelector<HTMLButtonElement>(`[data-open-file="${first.path}"]`)?.click();
    await vi.waitFor(() => expect(vi.mocked(bridge.watchDocument).mock.calls.at(-1)?.[0])
      .toBe(first.path));

    releaseSlowWatch();

    await vi.waitFor(() => expect(document.body.textContent).toContain('Slow'));
    await vi.waitFor(() => expect(vi.mocked(bridge.watchDocument).mock.calls.at(-1)?.[0])
      .toBe(slow.path));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
      .toContain('slow.md');
  });

  it('keeps a readable document visible and retries after watcher setup fails', async () => {
    const payload = markdownDocument('# Still readable');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    vi.mocked(bridge.watchDocument)
      .mockRejectedValueOnce(new Error('watch unavailable'))
      .mockResolvedValue(undefined);
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Still readable'));
    expect(document.body.textContent).toContain('Live refresh paused');

    requestOpen(payload.path);
    await vi.waitFor(() => expect(bridge.watchDocument).toHaveBeenCalledTimes(2));
  });

  it('surfaces an asynchronous watcher failure and allows a same-file retry', async () => {
    const payload = markdownDocument('# Keep reading');
    const { bridge, requestOpen, notifyWatchError } = createBridge({
      [payload.path]: payload,
    });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keep reading'));

    notifyWatchError(payload.path);
    expect(document.body.textContent).toContain('Live refresh paused');
    requestOpen(payload.path);
    await vi.waitFor(() => expect(bridge.watchDocument).toHaveBeenCalledTimes(2));
  });

  it('opens safe external Markdown links outside the preview window', async () => {
    const payload = markdownDocument('[OpenAI](https://openai.com)');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('a')).not.toBeNull());

    document.querySelector<HTMLAnchorElement>('a')?.click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://openai.com');
  });

  it('does not hand relative document links to the operating system', async () => {
    const payload = markdownDocument('[Sibling](../other.md)');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);
    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('a')).not.toBeNull());

    document.querySelector<HTMLAnchorElement>('a')?.click();
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });

  it('resolves relative Markdown images through the constrained desktop bridge', async () => {
    const payload = markdownDocument('![Diagram](./assets/diagram.png)');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    vi.mocked(bridge.resolveLocalImage).mockResolvedValue('data:image/png;base64,cGl4ZWw=');
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => {
      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,cGl4ZWw=',
      );
    });
    expect(bridge.resolveLocalImage).toHaveBeenCalledWith(
      payload.path,
      './assets/diagram.png',
    );
  });

  it('blocks remote Markdown images before the document can request them', async () => {
    const payload = markdownDocument('![Tracker](https://tracker.example/pixel.png)');
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
    expect(document.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(bridge.resolveLocalImage).not.toHaveBeenCalled();
  });

  it('deduplicates repeated local images before crossing the IPC boundary', async () => {
    const payload = markdownDocument(
      Array.from({ length: 20 }, () => '![Same](./same.png)').join('\n\n'),
    );
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    vi.mocked(bridge.resolveLocalImage).mockResolvedValue('data:image/png;base64,cGl4ZWw=');
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('img[src^="data:"]')).toHaveLength(20);
    });
    expect(bridge.resolveLocalImage).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent local-image IPC work', async () => {
    const payload = markdownDocument(
      Array.from({ length: 8 }, (_, index) => `![Image ${index}](./${index}.png)`).join(
        '\n\n',
      ),
    );
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    let active = 0;
    let maximumActive = 0;
    vi.mocked(bridge.resolveLocalImage).mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'data:image/png;base64,cGl4ZWw=';
    });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('img[src^="data:"]')).toHaveLength(8);
    });
    expect(maximumActive).toBeLessThanOrEqual(3);
  });
});
