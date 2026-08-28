import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  close: vi.fn(),
  closeHandler: undefined as ((event: { preventDefault(): void }) => Promise<void>) | undefined,
  destroy: vi.fn(),
  eventHandlers: new Map<string, () => void>(),
  hide: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  message: vi.fn(),
  onCloseRequested: vi.fn(),
  open: vi.fn(),
  openUrl: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    close: tauri.close,
    destroy: tauri.destroy,
    hide: tauri.hide,
    onCloseRequested: tauri.onCloseRequested,
    onDragDropEvent: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: tauri.message,
  open: tauri.open,
  save: tauri.save,
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: tauri.openUrl }));

import { createTauriBridge } from './tauri-bridge';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createTauriBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.eventHandlers.clear();
    tauri.closeHandler = undefined;
    tauri.invoke.mockResolvedValue(undefined);
    tauri.listen.mockImplementation(async (event: string, handler: () => void) => {
      tauri.eventHandlers.set(event, handler);
      return vi.fn();
    });
    tauri.onCloseRequested.mockImplementation(async (handler) => {
      tauri.closeHandler = handler;
      return vi.fn();
    });
  });

  it('lets only the newest overlapping watch reach the native watcher', async () => {
    const changeReady = deferred<() => void>();
    const errorReady = deferred<() => void>();
    tauri.listen
      .mockReturnValueOnce(changeReady.promise)
      .mockReturnValueOnce(errorReady.promise);
    const bridge = createTauriBridge();

    const first = bridge.watchDocument('/tmp/a.md', vi.fn(), vi.fn());
    changeReady.resolve(vi.fn());
    const second = bridge.watchDocument('/tmp/b.md', vi.fn(), vi.fn());
    errorReady.resolve(vi.fn());
    await Promise.all([first, second]);

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith('watch_document', { path: '/tmp/b.md' });
  });

  it.each([
    ['Save', 'save'],
    ['Discard', 'discard'],
    ['Cancel', 'cancel'],
  ] as const)('maps the %s close choice', async (choice, expected) => {
    tauri.message.mockResolvedValue(choice);

    await expect(createTauriBridge().confirmClose('Untitled 1')).resolves.toBe(expected);
  });

  it('does not write when the save dialog is cancelled', async () => {
    tauri.save.mockResolvedValue(null);

    await expect(createTauriBridge().saveDocument('Untitled 1', 'markdown', '# Draft'))
      .resolves.toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalledWith('write_document', expect.anything());
  });

  it('writes the selected save path', async () => {
    tauri.save.mockResolvedValue('/tmp/draft.md');

    await expect(createTauriBridge().saveDocument('Untitled 1', 'markdown', '# Draft'))
      .resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith('write_document', {
      path: '/tmp/draft.md',
      content: '# Draft',
    });
  });

  it('serializes recovery writes so an older write cannot finish last', async () => {
    const firstWrite = deferred<void>();
    tauri.invoke.mockImplementation((command: string) => {
      if (command === 'persist_recovery') return firstWrite.promise;
      return Promise.resolve();
    });
    const bridge = createTauriBridge();
    const first = bridge.persistRecovery([
      { name: 'Untitled 1', kind: 'markdown', content: '# First' },
    ]);
    const second = bridge.persistRecovery([
      { name: 'Untitled 2', kind: 'markdown', content: '# Second' },
    ]);

    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(tauri.invoke.mock.calls).toEqual([
      ['persist_recovery', {
        scratches: [{ name: 'Untitled 1', kind: 'markdown', content: '# First' }],
      }],
      ['persist_recovery', {
        scratches: [{ name: 'Untitled 2', kind: 'markdown', content: '# Second' }],
      }],
    ]);
  });

  it('passes the cache refresh contract to native document search', async () => {
    tauri.invoke.mockResolvedValue(['/tmp/readme.md']);

    await expect(createTauriBridge().searchDocuments('read', true, ['md', 'markdown']))
      .resolves.toEqual(['/tmp/readme.md']);
    expect(tauri.invoke).toHaveBeenCalledWith('search_documents', {
      query: 'read',
      refresh: true,
      extensions: ['md', 'markdown'],
    });
  });

  it('forwards native file-search menu requests', async () => {
    const handler = vi.fn();

    await createTauriBridge().onSearchFiles(handler);
    tauri.eventHandlers.get('search-files-requested')?.();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('replays a file-search shortcut queued before the listener was ready', async () => {
    const handler = vi.fn();
    tauri.invoke.mockResolvedValueOnce(true);

    await createTauriBridge().onSearchFiles(handler);

    expect(tauri.invoke).toHaveBeenCalledWith('mark_file_search_ready');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('prevents native close and hides the window without quitting', async () => {
    const preventDefault = vi.fn();
    const approve = vi.fn().mockResolvedValue(true);
    await createTauriBridge().onCloseRequested(approve);

    await tauri.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
    expect(tauri.hide).toHaveBeenCalledOnce();
  });

  it('requests the native close-window path', async () => {
    await createTauriBridge().closeWindow();

    expect(tauri.close).toHaveBeenCalledOnce();
  });

  it('exits for an approved quit request and stays open when rejected', async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await createTauriBridge().onCloseRequested(approve);
    const quit = tauri.eventHandlers.get('quit-requested');

    quit?.();
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(tauri.invoke).not.toHaveBeenCalledWith('exit_application');
    quit?.();
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('exit_application'));
  });
});
