import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
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

  const bridge: DesktopBridge = {
    chooseDocument: vi.fn().mockResolvedValue(null),
    readDocument: vi.fn(async (path: string) => {
      const document = documents[path];
      if (!document) throw new Error('File could not be opened.');
      return document;
    }),
    watchDocument: vi.fn(async (_path, handler) => {
      changeHandler = handler;
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
  };
}

describe('createApp', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('starts with a quiet invitation to open or drop a supported document', async () => {
    const { bridge } = createBridge();
    await createApp(document.querySelector('#app')!, bridge);

    expect(document.querySelector('button')?.textContent).toMatch(/Open document/i);
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
    expect(bridge.watchDocument).toHaveBeenCalledWith(payload.path, expect.any(Function));
  });

  it('renders a JSON file as an expandable inspector instead of editable text', async () => {
    const payload = jsonDocument();
    const { bridge, requestOpen } = createBridge({ [payload.path]: payload });
    await createApp(document.querySelector('#app')!, bridge);

    requestOpen(payload.path);
    await vi.waitFor(() => expect(document.querySelector('.json-tree')).not.toBeNull());
    expect(document.body.textContent).toContain('service');
    expect(document.querySelector('textarea')).toBeNull();
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
});
