import type { DesktopBridge, DocumentPayload } from './desktop-bridge';

const MARKDOWN_FIXTURE: DocumentPayload = {
  path: '/fixtures/quiet-document.md',
  name: 'quiet-document.md',
  kind: 'markdown',
  content: [
    '# A quiet document',
    '',
    'FFM Viewer turns source syntax into a calm reading surface.',
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

const LARGE_JSON_FIXTURE: DocumentPayload = {
  path: '/fixtures/large-response.json',
  name: 'large-response.json',
  kind: 'json',
  content: JSON.stringify(
    Array.from({ length: 20_000 }, (_, id) => ({
      id,
      status: id % 2 === 0 ? 'ready' : 'pending',
      metadata: { region: 'local', attempts: id % 4 },
    })),
  ),
};

export function createBrowserPreviewBridge(
  fixture: 'markdown' | 'json' | 'json-large',
): DesktopBridge {
  const payload = fixture === 'json-large'
    ? LARGE_JSON_FIXTURE
    : fixture === 'json'
      ? JSON_FIXTURE
      : MARKDOWN_FIXTURE;
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
