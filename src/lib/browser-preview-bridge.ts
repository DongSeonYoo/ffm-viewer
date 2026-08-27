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

const SINGLE_FIXTURES = {
  markdown: MARKDOWN_FIXTURE,
  json: JSON_FIXTURE,
  'json-large': LARGE_JSON_FIXTURE,
} as const;

export function createBrowserPreviewBridge(
  fixture: 'markdown' | 'json' | 'json-large' | 'multi',
): DesktopBridge {
  const payloads = fixture === 'multi'
    ? [
        MARKDOWN_FIXTURE,
        JSON_FIXTURE,
        {
          ...MARKDOWN_FIXTURE,
          path: '/fixtures/notes.md',
          name: 'notes.md',
          content: '# Notes\n\nA second Markdown document.',
        },
      ]
    : [SINGLE_FIXTURES[fixture]];
  let pending = true;
  let nextChoice = fixture === 'multi' ? 1 : 0;

  return {
    chooseDocument: async () => payloads[Math.min(nextChoice++, payloads.length - 1)]?.path ?? null,
    readDocument: async (path) => {
      const payload = payloads.find((candidate) => candidate.path === path);
      if (!payload) throw new Error('Fixture not found.');
      return payload;
    },
    watchDocument: async () => undefined,
    takePendingOpen: async () => {
      if (!pending) return null;
      pending = false;
      return payloads[0]?.path ?? null;
    },
    onOpenRequested: async () => () => undefined,
    onFileDropped: async () => () => undefined,
    openExternal: async () => undefined,
    resolveLocalImage: async () => null,
  };
}
