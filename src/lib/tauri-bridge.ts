import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message, open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  DesktopBridge,
  DocumentKind,
  Dispose,
  DocumentPayload,
  PathHandler,
  ScratchRecovery,
} from './desktop-bridge';

interface PathEvent {
  path: string;
}

const SAVE_FORMATS: Record<Exclude<DocumentKind, 'image'>, {
  readonly name: string;
  readonly extension: string;
}> = {
  markdown: { name: 'Markdown', extension: 'md' },
  json: { name: 'JSON', extension: 'json' },
  text: { name: 'Plain text', extension: 'txt' },
  yaml: { name: 'YAML', extension: 'yaml' },
  toml: { name: 'TOML', extension: 'toml' },
};

function normalizeDispose(unlisten: UnlistenFn): Dispose {
  return () => unlisten();
}

export function createTauriBridge(): DesktopBridge {
  let currentPath = '';
  let currentChangeHandler: PathHandler | undefined;
  let currentErrorHandler: PathHandler | undefined;
  let changeListener: Promise<UnlistenFn> | undefined;
  let errorListener: Promise<UnlistenFn> | undefined;
  let changeTimer: number | undefined;
  let watchGeneration = 0;
  let recoveryWrite: Promise<void> = Promise.resolve();

  return {
    async chooseDocuments() {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: 'Developer documents',
            extensions: [
              'md', 'markdown', 'json', 'txt', 'yaml', 'yml', 'toml',
              'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg',
            ],
          },
        ],
      });
      if (Array.isArray(selected)) return selected;
      return typeof selected === 'string' ? [selected] : [];
    },

    readDocument(path) {
      return invoke<DocumentPayload>('read_document', { path });
    },

    async watchDocument(path, onChange, onError) {
      const generation = ++watchGeneration;
      currentPath = path;
      currentChangeHandler = onChange;
      currentErrorHandler = onError;
      if (!changeListener) {
        changeListener = listen<PathEvent>('document-changed', ({ payload }) => {
          if (payload.path !== currentPath) return;
          if (changeTimer !== undefined) window.clearTimeout(changeTimer);
          changeTimer = window.setTimeout(() => {
            currentChangeHandler?.(payload.path);
            changeTimer = undefined;
          }, 90);
        });
      }
      if (!errorListener) {
        errorListener = listen<PathEvent>('document-watch-error', ({ payload }) => {
          if (payload.path === currentPath) currentErrorHandler?.(payload.path);
        });
      }
      await changeListener;
      await errorListener;
      if (generation !== watchGeneration) return;
      await invoke('watch_document', { path });
    },

    takePendingOpen() {
      return invoke<string[]>('take_pending_open');
    },

    async onOpenRequested(handler) {
      const unlisten = await listen<PathEvent>('file-open-requested', ({ payload }) => {
        handler(payload.path);
      });
      return normalizeDispose(unlisten);
    },

    async onFileDropped(handler) {
      const unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          event.payload.paths.forEach(handler);
        }
      });
      return normalizeDispose(unlisten);
    },

    async openExternal(value) {
      const url = new URL(value);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        throw new Error('Unsupported link protocol.');
      }
      await openUrl(value);
    },

    resolveLocalImage(documentPath, source) {
      return invoke<string | null>('read_local_image', { documentPath, source });
    },

    async confirmClose(name) {
      const result = await message(`Save changes to ${name}?`, {
        title: 'FFM Viewer',
        kind: 'warning',
        buttons: { yes: 'Save', no: 'Discard', cancel: 'Cancel' },
      });
      if (result === 'Save') return 'save';
      if (result === 'Discard') return 'discard';
      return 'cancel';
    },

    async saveDocument(baseName, kind, content) {
      const format = SAVE_FORMATS[kind];
      const path = await save({
        defaultPath: `${baseName}.${format.extension}`,
        filters: [{ name: format.name, extensions: [format.extension] }],
      });
      if (!path) return false;
      await invoke<void>('write_document', { path, content });
      return true;
    },

    loadRecovery() {
      return invoke<ScratchRecovery[]>('load_recovery');
    },

    persistRecovery(scratches) {
      const snapshot = scratches.map((scratch) => ({ ...scratch }));
      const queued = recoveryWrite.then(
        () => invoke<void>('persist_recovery', { scratches: snapshot }),
        () => invoke<void>('persist_recovery', { scratches: snapshot }),
      );
      recoveryWrite = queued.catch(() => undefined);
      return queued;
    },

    searchDocuments(query, refresh, extensions) {
      return invoke<string[]>('search_documents', { query, refresh, extensions });
    },

    closeWindow() {
      return getCurrentWebviewWindow().close();
    },

    async onCloseRequested(handler) {
      const window = getCurrentWebviewWindow();
      let handling = false;
      const canClose = async () => {
        if (handling) return false;
        handling = true;
        try {
          return await handler();
        } finally {
          handling = false;
        }
      };
      const unlisten = await window.onCloseRequested(async (event) => {
        event.preventDefault();
        await window.hide();
      });
      const unlistenQuit = await listen('quit-requested', () => {
        void canClose().then((approved) => {
          if (approved) return invoke<void>('exit_application');
          return undefined;
        });
      });
      return () => {
        unlisten();
        unlistenQuit();
      };
    },

    async onCloseActiveTab(handler) {
      const unlisten = await listen('close-active-tab', handler);
      return normalizeDispose(unlisten);
    },

    async onSearchFiles(handler) {
      const unlisten = await listen('search-files-requested', handler);
      if (await invoke<boolean>('mark_file_search_ready')) handler();
      return normalizeDispose(unlisten);
    },
  };
}
