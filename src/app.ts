import { createJsonTree } from './components/json-tree';
import type { DesktopBridge, DocumentPayload } from './lib/desktop-bridge';
import { parseJsonDocument } from './lib/json-document';
import { renderMarkdown } from './lib/markdown';

let activeKeydownListener: ((event: KeyboardEvent) => void) | undefined;

async function hydrateLocalImages(
  article: HTMLElement,
  payload: DocumentPayload,
  bridge: DesktopBridge,
): Promise<void> {
  const images = Array.from(article.querySelectorAll<HTMLImageElement>('img[src]'));
  await Promise.all(
    images.map(async (image) => {
      const source = image.getAttribute('src');
      if (!source || /^(?:https?:|data:)/i.test(source)) return;
      try {
        const resolved = await bridge.resolveLocalImage(payload.path, source);
        if (resolved) image.src = resolved;
        else image.classList.add('is-unavailable');
      } catch {
        image.classList.add('is-unavailable');
      }
    }),
  );
}

function createOpenButton(
  label: string,
  onOpen: () => Promise<void>,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'open-document';
  button.textContent = label;
  button.addEventListener('click', () => void onOpen());
  return button;
}

function createHeader(
  payload: DocumentPayload,
  onOpen: () => Promise<void>,
): HTMLElement {
  const header = document.createElement('header');
  header.className = 'document-header';

  const identity = document.createElement('div');
  identity.className = 'document-identity';
  const type = document.createElement('span');
  type.className = 'document-kind';
  type.textContent = payload.kind === 'markdown' ? 'MD' : 'JSON';
  const name = document.createElement('span');
  name.className = 'document-name';
  name.textContent = payload.name;
  identity.append(type, name);

  header.append(identity, createOpenButton('Open', onOpen));
  return header;
}

function createEmptyState(onOpen: () => Promise<void>): HTMLElement {
  const state = document.createElement('main');
  state.className = 'empty-state';

  const mark = document.createElement('div');
  mark.className = 'empty-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '¶';

  const title = document.createElement('h1');
  title.textContent = 'Read the file, not the syntax.';
  const description = document.createElement('p');
  description.textContent = 'Open or drop a Markdown or JSON document.';

  state.append(mark, title, description, createOpenButton('Open document', onOpen));
  return state;
}

export async function createApp(
  root: HTMLElement,
  bridge: DesktopBridge,
): Promise<void> {
  let currentPath: string | undefined;
  let loadSequence = 0;

  const chooseDocument = async () => {
    const path = await bridge.chooseDocument();
    if (path) await loadDocument(path);
  };

  if (activeKeydownListener) {
    window.removeEventListener('keydown', activeKeydownListener);
  }
  activeKeydownListener = (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLocaleLowerCase() === 'o') {
      event.preventDefault();
      void chooseDocument();
    }
  };
  window.addEventListener('keydown', activeKeydownListener);

  const renderError = (message: string, payload?: DocumentPayload) => {
    root.replaceChildren();
    if (payload) root.append(createHeader(payload, chooseDocument));
    const state = document.createElement('main');
    state.className = 'error-state';
    state.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = 'This document could not be shown.';
    const detail = document.createElement('p');
    detail.textContent = message;
    state.append(title, detail, createOpenButton('Open another document', chooseDocument));
    root.append(state);
  };

  const renderDocument = (payload: DocumentPayload) => {
    const previousScroll = window.scrollY;
    const shell = document.createElement('div');
    shell.className = `app-shell is-${payload.kind}`;
    shell.append(createHeader(payload, chooseDocument));

    const main = document.createElement('main');
    main.className = 'document-viewport';
    if (payload.kind === 'markdown') {
      const article = document.createElement('article');
      article.className = 'markdown-document';
      article.innerHTML = renderMarkdown(payload.content);
      void hydrateLocalImages(article, payload, bridge);
      article.addEventListener('click', (event) => {
        const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        event.preventDefault();
        if (/^(?:https?:|mailto:)/i.test(href)) {
          void bridge.openExternal(href);
        }
      });
      main.append(article);
    } else {
      try {
        main.append(createJsonTree(parseJsonDocument(payload.content)));
      } catch (error) {
        renderError(error instanceof Error ? error.message : 'Invalid JSON.', payload);
        return;
      }
    }

    shell.append(main);
    root.replaceChildren(shell);
    document.title = `${payload.name} — Dev Preview`;
    if (previousScroll > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: previousScroll }));
    }
  };

  async function loadDocument(path: string): Promise<void> {
    const sequence = ++loadSequence;
    try {
      const payload = await bridge.readDocument(path);
      if (sequence !== loadSequence) return;
      currentPath = payload.path;
      renderDocument(payload);
      await bridge.watchDocument(payload.path, (changedPath) => {
        if (changedPath === currentPath) void loadDocument(changedPath);
      });
    } catch (error) {
      if (sequence !== loadSequence) return;
      renderError(error instanceof Error ? error.message : 'File could not be opened.');
    }
  }

  root.replaceChildren(createEmptyState(chooseDocument));
  await bridge.onOpenRequested((path) => void loadDocument(path));
  await bridge.onFileDropped((path) => void loadDocument(path));
  const pendingPath = await bridge.takePendingOpen();
  if (pendingPath) await loadDocument(pendingPath);
}
