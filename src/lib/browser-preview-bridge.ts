import type { DesktopBridge, DocumentPayload, ScratchRecovery } from './desktop-bridge';

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

const TEXT_FIXTURE: DocumentPayload = {
  path: '/fixtures/notes.txt',
  name: 'notes.txt',
  kind: 'text',
  content: 'Plain text stays plain.\nLine two stays visible.',
};

const YAML_FIXTURE: DocumentPayload = {
  path: '/fixtures/config.yaml',
  name: 'config.yaml',
  kind: 'yaml',
  content: 'server:\n  port: 4000',
};

const TOML_FIXTURE: DocumentPayload = {
  path: '/fixtures/config.toml',
  name: 'config.toml',
  kind: 'toml',
  content: '[server]\nport = 4000',
};

const IMAGE_FIXTURE: DocumentPayload = {
  path: '/fixtures/pixel.png',
  name: 'pixel.png',
  kind: 'image',
  content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
};

const SINGLE_FIXTURES = {
  markdown: MARKDOWN_FIXTURE,
  json: JSON_FIXTURE,
  'json-large': LARGE_JSON_FIXTURE,
  text: TEXT_FIXTURE,
  yaml: YAML_FIXTURE,
  toml: TOML_FIXTURE,
  image: IMAGE_FIXTURE,
} as const;

export function createBrowserPreviewBridge(
  fixture: keyof typeof SINGLE_FIXTURES | 'multi',
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
  let recovery: readonly ScratchRecovery[] = [];

  return {
    chooseDocuments: async () => {
      const path = payloads[Math.min(nextChoice++, payloads.length - 1)]?.path;
      return path ? [path] : [];
    },
    readDocument: async (path) => {
      const payload = payloads.find((candidate) => candidate.path === path);
      if (!payload) throw new Error('Fixture not found.');
      return payload;
    },
    watchDocument: async () => undefined,
    takePendingOpen: async () => {
      if (!pending) return [];
      pending = false;
      const path = payloads[0]?.path;
      return path ? [path] : [];
    },
    onOpenRequested: async () => () => undefined,
    onFileDropped: async () => () => undefined,
    openExternal: async () => undefined,
    resolveLocalImage: async () => null,
    confirmClose: async () => 'discard',
    saveDocument: async () => false,
    loadRecovery: async () => recovery,
    persistRecovery: async (scratches) => {
      recovery = scratches.map((scratch) => ({ ...scratch }));
    },
    searchDocuments: async (query, _refresh, extensions) => payloads
      .filter(({ name }) => extensions.includes(name.split('.').pop()?.toLocaleLowerCase() ?? '')
        && name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map(({ path }) => path),
    closeWindow: async () => undefined,
    onCloseActiveTab: async () => () => undefined,
    onSearchFiles: async () => () => undefined,
    onCloseRequested: async () => () => undefined,
  };
}
