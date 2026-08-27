import type { DesktopBridge, DocumentPayload } from './desktop-bridge';

const MARKDOWN_FIXTURE: DocumentPayload = {
  path: '/fixtures/quiet-document.md',
  name: 'quiet-document.md',
  kind: 'markdown',
  content: [
    '# A quiet document',
    '',
    'Dev Preview turns source syntax into a calm reading surface.',
    '',
    '> Structure should be visible without becoming decoration.',
    '',
    '```typescript',
    'const render = (source: string) => source;',
    '```',
  ].join('\n'),
};

const JSON_FIXTURE: DocumentPayload = {
  path: '/fixtures/service.json',
  name: 'service.json',
  kind: 'json',
  content: JSON.stringify({
    service: { name: 'api', ready: true, ports: [80, 443] },
    environment: 'local',
  }),
};

export function createBrowserPreviewBridge(
  fixture: 'markdown' | 'json',
): DesktopBridge {
  const payload = fixture === 'json' ? JSON_FIXTURE : MARKDOWN_FIXTURE;
  let pending = true;

  return {
    chooseDocument: async () => payload.path,
    readDocument: async () => payload,
    watchDocument: async () => undefined,
    takePendingOpen: async () => {
      if (!pending) return null;
      pending = false;
      return payload.path;
    },
    onOpenRequested: async () => () => undefined,
    onFileDropped: async () => () => undefined,
    openExternal: async () => undefined,
    resolveLocalImage: async () => null,
  };
}
