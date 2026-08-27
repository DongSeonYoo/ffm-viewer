import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  DesktopBridge,
  Dispose,
  DocumentPayload,
  PathHandler,
} from './desktop-bridge';

interface PathEvent {
  path: string;
}

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
  };
}
