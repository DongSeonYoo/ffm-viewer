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
  let changeListener: Promise<UnlistenFn> | undefined;
  let changeTimer: number | undefined;

  return {
    async chooseDocument() {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: 'Developer documents',
            extensions: ['md', 'markdown', 'json'],
          },
        ],
      });
      return typeof selected === 'string' ? selected : null;
    },

    readDocument(path) {
      return invoke<DocumentPayload>('read_document', { path });
    },

    async watchDocument(path, onChange) {
      currentPath = path;
      currentChangeHandler = onChange;
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
      await changeListener;
      await invoke('watch_document', { path });
    },

    takePendingOpen() {
      return invoke<string | null>('take_pending_open');
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
          const firstPath = event.payload.paths[0];
          if (firstPath) handler(firstPath);
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
