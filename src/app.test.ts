import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app-shell';
import type { DesktopBridge, DocumentPayload } from './lib/desktop-bridge';

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

function createBridge(documents: Record<string, DocumentPayload> = {}) {
  let openHandler: ((path: string) => void) | undefined;
  let changeHandler: ((path: string) => void) | undefined;
  let watchErrorHandler: ((path: string) => void) | undefined;

  const bridge: DesktopBridge = {
    chooseDocument: vi.fn().mockResolvedValue(null),
    readDocument: vi.fn(async (path: string) => {
      const document = documents[path];
      if (!document) throw new Error('File could not be opened.');
      return document;
    }),
    watchDocument: vi.fn(async (_path, handler, onError) => {
      changeHandler = handler;
      watchErrorHandler = onError;
    }),
    takePendingOpen: vi.fn().mockResolvedValue(null),
    onOpenRequested: vi.fn(async (handler) => {
      openHandler = handler;
      return () => undefined;
    }),
    onFileDropped: vi.fn(async () => () => undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    resolveLocalImage: vi.fn().mockResolvedValue(null),
  };

  return {
    bridge,
    requestOpen: (path: string) => openHandler?.(path),
    notifyChange: (path: string) => changeHandler?.(path),
    notifyWatchError: (path: string) => watchErrorHandler?.(path),
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
    expect(document.body.textContent).toContain('Markdown or JSON');
  });

  it('uses the desktop open shortcut without adding editor chrome', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true }));
    await vi.waitFor(() => expect(bridge.chooseDocument).toHaveBeenCalledOnce());
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
