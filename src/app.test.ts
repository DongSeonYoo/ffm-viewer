import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-shell';
import type {
  DesktopBridge,
  DocumentPayload,
  ScratchRecovery,
} from './lib/desktop-bridge';

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

  const bridge: DesktopBridge = {
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
  };

  return {
    bridge,
    requestOpen: (path: string) => openHandler?.(path),
    notifyChange: (path: string) => changeHandler?.(path),
    notifyWatchError: (path: string) => watchErrorHandler?.(path),
    requestClose: async () => closeHandler?.() ?? true,
    requestTabClose: () => closeTabHandler?.(),
  };
}

describe('createApp', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
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

  it('quickly switches open files with Cmd+K', async () => {
    const first = markdownDocument('# Readme');
    const second = { ...markdownDocument('# Notes'), path: '/tmp/notes.md', name: 'notes.md' };
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
    const input = document.querySelector<HTMLInputElement>('[data-quick-switch-input]');
    expect(input).not.toBeNull();
    input!.value = 'read';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => expect(document.body.textContent).toContain('Readme'));
    expect(document.querySelector('[data-quick-switcher]')).toBeNull();
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
    const input = document.querySelector<HTMLInputElement>('[data-quick-switch-input]')!;
    input.value = 'toml';
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
