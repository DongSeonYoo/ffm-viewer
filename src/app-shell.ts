import {
  createJsonCodeView,
  createTextCodeView,
  type CodeViewElement,
} from './components/json-tree';
import type {
  DesktopBridge,
  DocumentKind,
  DocumentPayload,
  ScratchRecovery,
} from './lib/desktop-bridge';
import { formatJsonDocument } from './lib/json-document';
import { renderMarkdown } from './lib/markdown';
import {
  isPastedDocumentTooLarge,
  preparePastedDocument,
} from './lib/pasted-document';

let activeKeydownListener: ((event: KeyboardEvent) => void) | undefined;
let activePasteListener: ((event: ClipboardEvent) => void) | undefined;
const IMAGE_CONCURRENCY = 3;
const MAX_IMAGE_DATA_CHARS = 24 * 1024 * 1024;
const MAX_HISTORY = 100;
const MAX_DOCUMENT_MATCHES = 500;
const WATCH_WARNING = 'Live refresh paused. Reopen the document to retry.';
const RECOVERY_WARNING = 'Recovery unavailable. Keep this tab open or save it to a file.';
const SHORTCUT_DIAGNOSTICS_ENABLED = import.meta.env.VITE_FFM_DIAGNOSTICS === '1';
const THEME_STORAGE_KEY = 'ffm.theme';
const THEME_OPTIONS = [
  { value: 'green', label: 'FFM Green' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const;
type ThemePreference = typeof THEME_OPTIONS[number]['value'];
type ScratchViewKind = Exclude<DocumentKind, 'json' | 'image'>;
const SCRATCH_VIEW_ACTIONS: ReadonlyArray<{
  readonly kind: ScratchViewKind;
  readonly label: string;
}> = [
  { kind: 'markdown', label: 'View as Markdown' },
  { kind: 'text', label: 'View as Plain Text' },
  { kind: 'yaml', label: 'View as YAML' },
  { kind: 'toml', label: 'View as TOML' },
];

interface OpenTab {
  readonly id: string;
  readonly source: 'file' | 'scratch';
  payload: DocumentPayload;
  scrollTop: number;
  dirty: boolean;
  hint?: 'yaml' | 'toml';
  warning?: string;
}

function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'green' || stored === 'light' || stored === 'system') return stored;
  } catch {
    // Storage can be unavailable; the product default remains usable.
  }
  return 'green';
}

function persistThemePreference(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Applying the theme matters more than persisting it.
  }
}

function markImageUnavailable(image: HTMLImageElement): void {
  image.removeAttribute('src');
  image.classList.add('is-unavailable');
}

async function hydrateLocalImages(
  article: HTMLElement,
  payload: DocumentPayload,
  bridge: DesktopBridge,
  isCurrent: () => boolean,
): Promise<void> {
  const images = Array.from(article.querySelectorAll<HTMLImageElement>('img[src]'));
  const groups = new Map<string, HTMLImageElement[]>();

  for (const image of images) {
    const source = image.getAttribute('src');
    if (!source) continue;
    if (/^https?:/i.test(source)) {
      markImageUnavailable(image);
      continue;
    }
    if (/^data:/i.test(source)) continue;
    const group = groups.get(source) ?? [];
    group.push(image);
    groups.set(source, group);
  }

  const pending = Array.from(groups.entries());
  let cursor = 0;
  let aggregateChars = 0;
  let budgetExhausted = false;

  const worker = async () => {
    while (isCurrent() && !budgetExhausted) {
      const task = pending[cursor++];
      if (!task) return;
      const [source, matchingImages] = task;
      try {
        const resolved = await bridge.resolveLocalImage(payload.path, source);
        if (!isCurrent()) return;
        if (!resolved || aggregateChars + resolved.length > MAX_IMAGE_DATA_CHARS) {
          budgetExhausted = aggregateChars + (resolved?.length ?? 0) > MAX_IMAGE_DATA_CHARS;
          matchingImages.forEach(markImageUnavailable);
          continue;
        }
        aggregateChars += resolved.length;
        matchingImages.forEach((image) => {
          image.src = resolved;
        });
      } catch {
        matchingImages.forEach(markImageUnavailable);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, worker),
  );

  if (budgetExhausted) {
    pending.slice(cursor).flatMap(([, group]) => group).forEach(markImageUnavailable);
  }
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

function createEmptyState(onOpen: () => Promise<void>): HTMLElement {
  const state = document.createElement('section');
  state.className = 'empty-state';
  const mark = document.createElement('div');
  mark.className = 'empty-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '¶';
  const title = document.createElement('h1');
  title.textContent = 'Read the file, not the syntax.';
  const description = document.createElement('p');
  description.textContent = 'Open or drop a supported local file.';
  state.append(mark, title, description, createOpenButton('Open document', onOpen));
  return state;
}

function kindLabel(payload: DocumentPayload): string {
  switch (payload.kind) {
    case 'markdown': return 'MD';
    case 'json': return 'JSON';
    case 'text': return 'TXT';
    case 'yaml': return 'YAML';
    case 'toml': return 'TOML';
    case 'image': return 'IMG';
  }
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function fileType(path: string): string {
  const extension = fileName(path).split('.').pop();
  return extension?.toLocaleUpperCase() ?? 'FILE';
}

function isKey(event: KeyboardEvent, code: string, fallback: string): boolean {
  return event.code === code || event.key.toLocaleLowerCase() === fallback;
}

function findTextRanges(container: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const needle = query.toLocaleLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < MAX_DOCUMENT_MATCHES; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const haystack = text.toLocaleLowerCase();
    let offset = 0;
    while (ranges.length < MAX_DOCUMENT_MATCHES) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      offset = index + Math.max(query.length, 1);
    }
  }
  return ranges;
}

function createSidebarSection(name: string, countName: string) {
  const section = document.createElement('section');
  section.className = 'sidebar-section';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sidebar-section-toggle';
  toggle.setAttribute('aria-expanded', 'true');
  const chevron = document.createElement('span');
  chevron.className = 'sidebar-section-chevron';
  chevron.textContent = '⌄';
  const label = document.createElement('span');
  label.className = 'sidebar-section-name';
  label.textContent = name;
  const count = document.createElement('span');
  count.className = 'sidebar-section-count';
  count.dataset.sectionCount = countName;
  count.textContent = '0';
  const content = document.createElement('div');
  content.className = `sidebar-section-content sidebar-${countName}`;
  toggle.append(chevron, label, count);
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    chevron.textContent = expanded ? '›' : '⌄';
    content.hidden = expanded;
  });
  section.append(toggle, content);
  return { section, content, count };
}

export async function createApp(
  root: HTMLElement,
  bridge: DesktopBridge,
): Promise<void> {
  document.documentElement.dataset.theme = readThemePreference();
  const tabs: OpenTab[] = [];
  const history: string[] = [];
  let historyIndex = -1;
  let activeId: string | undefined;
  let activeCodeView: CodeViewElement | undefined;
  let outlineObserver: MutationObserver | undefined;
  let renderSequence = 0;
  let readSequence = 0;
  let openQueue = Promise.resolve();
  const pendingPastes: string[] = [];
  let pasteBusy = false;
  let untitledCounter = 0;
  let activationRevision = 0;
  let startupWarning: string | undefined;

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  const topbar = document.createElement('header');
  topbar.className = 'app-topbar';
  const historyNav = document.createElement('nav');
  historyNav.className = 'history-navigation';
  historyNav.setAttribute('aria-label', 'Document history');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'history-button';
  back.dataset.history = 'back';
  back.setAttribute('aria-label', 'Go back');
  back.textContent = '←';
  const forward = document.createElement('button');
  forward.type = 'button';
  forward.className = 'history-button';
  forward.dataset.history = 'forward';
  forward.setAttribute('aria-label', 'Go forward');
  forward.textContent = '→';
  historyNav.append(back, forward);
  const commandCenter = document.createElement('button');
  commandCenter.type = 'button';
  commandCenter.className = 'command-center';
  commandCenter.innerHTML = '<span aria-hidden="true">⌕</span><span>Search open files…</span><kbd>⌘K</kbd>';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'toolbar-button';
  openButton.setAttribute('aria-label', 'Open document');
  openButton.title = 'Open document (⌘O)';
  openButton.textContent = '+';
  topbar.append(historyNav, commandCenter, openButton);

  const layout = document.createElement('div');
  layout.className = 'app-layout';
  const sidebar = document.createElement('aside');
  sidebar.className = 'app-sidebar';
  const filesSection = createSidebarSection('Open files', 'files');
  const outlineSection = createSidebarSection('Outline', 'outline');
  sidebar.append(filesSection.section, outlineSection.section);

  const workArea = document.createElement('section');
  workArea.className = 'work-area';
  const tablist = document.createElement('nav');
  tablist.className = 'document-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Open documents');
  const warning = document.createElement('div');
  warning.className = 'watch-warning';
  warning.hidden = true;
  const viewport = document.createElement('main');
  viewport.className = 'document-viewport';
  const formatHint = document.createElement('div');
  formatHint.className = 'format-hint';
  formatHint.dataset.formatHint = '';
  formatHint.hidden = true;
  workArea.append(tablist, warning, viewport, formatHint);
  layout.append(sidebar, workArea);
  shell.append(topbar, layout);
  root.replaceChildren(shell);
  const shortcutDiagnostics = document.createElement('output');
  if (SHORTCUT_DIAGNOSTICS_ENABLED) {
    shortcutDiagnostics.className = 'shortcut-diagnostics';
    shortcutDiagnostics.setAttribute('aria-label', 'FFM shortcut diagnostics');
    shortcutDiagnostics.textContent = 'key=— meta=0 ctrl=0 alt=0';
    root.append(shortcutDiagnostics);
  }

  const activeTab = () => tabs.find((tab) => tab.id === activeId);

  const setActiveId = (id: string | undefined) => {
    if (activeId === id) return;
    activeId = id;
    activationRevision += 1;
  };

  const snapshotScroll = () => {
    const tab = activeTab();
    if (!tab) return;
    const scroller = activeCodeView?.querySelector<HTMLElement>('.cm-scroller');
    tab.scrollTop = scroller?.scrollTop ?? viewport.scrollTop;
  };

  const destroyActiveView = () => {
    outlineObserver?.disconnect();
    outlineObserver = undefined;
    activeCodeView?.destroy();
    activeCodeView = undefined;
  };

  const closeDocumentSearch = () => {
    root.querySelector('[data-document-search]')?.remove();
    window.getSelection()?.removeAllRanges();
  };

  const updateHistoryButtons = () => {
    back.disabled = historyIndex <= 0;
    forward.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
  };

  const renderWarning = () => {
    const message = activeTab()?.warning ?? startupWarning;
    warning.hidden = !message;
    warning.textContent = message ?? '';
  };

  const recoverySnapshot = (excludedId?: string): ScratchRecovery[] => tabs
    .filter((tab) => tab.id !== excludedId && tab.source === 'scratch' && tab.dirty)
    .map((tab) => ({
      name: tab.payload.name,
      kind: tab.payload.kind as ScratchRecovery['kind'],
      content: tab.payload.content,
    }));

  async function persistDirtyScratches(
    changedTab?: OpenTab,
    excludedId?: string,
  ): Promise<boolean> {
    try {
      await bridge.persistRecovery(recoverySnapshot(excludedId));
      if (changedTab?.warning === RECOVERY_WARNING) changedTab.warning = undefined;
      return true;
    } catch {
      if (changedTab) changedTab.warning = RECOVERY_WARNING;
      else startupWarning = RECOVERY_WARNING;
      renderWarning();
      return false;
    }
  }

  const renderFormatHint = () => {
    formatHint.replaceChildren();
    const tab = activeTab();
    const hint = tab?.hint;
    if (!tab || tab.source !== 'scratch' || !hint) {
      formatHint.hidden = true;
      return;
    }
    const label = hint.toUpperCase();
    const message = document.createElement('span');
    message.textContent = `${label} 형식으로 보입니다`;
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.dataset.viewAs = hint;
    apply.textContent = `${label}로 보기`;
    apply.addEventListener('click', () => void applyScratchKind(hint));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'format-hint-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss format suggestion');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      tab.hint = undefined;
      renderFormatHint();
    });
    formatHint.append(message, apply, dismiss);
    formatHint.hidden = false;
  };

  const renderChrome = () => {
    tablist.replaceChildren();
    filesSection.content.replaceChildren();
    for (const tab of tabs) {
      const selected = tab.id === activeId;
      const type = document.createElement('span');
      type.className = 'document-type';
      type.textContent = kindLabel(tab.payload);

      const fileButton = document.createElement('button');
      fileButton.type = 'button';
      fileButton.className = `open-file${selected ? ' is-active' : ''}`;
      fileButton.dataset.openFile = tab.id;
      const fileName = document.createElement('span');
      fileName.className = 'open-file-name';
      fileName.textContent = tab.payload.name;
      fileButton.append(type.cloneNode(true), fileName);
      if (tab.dirty) {
        const dirty = document.createElement('span');
        dirty.className = 'open-file-dirty';
        dirty.title = 'Unsaved';
        fileButton.append(dirty);
      }
      fileButton.addEventListener('click', () => activateTab(tab.id));
      filesSection.content.append(fileButton);

      const tabElement = document.createElement('div');
      tabElement.className = `document-tab${selected ? ' is-active' : ''}`;
      tabElement.setAttribute('role', 'tab');
      tabElement.setAttribute('aria-selected', String(selected));
      tabElement.tabIndex = selected ? 0 : -1;
      const tabName = document.createElement('span');
      tabName.className = 'document-tab-name';
      tabName.textContent = tab.payload.name;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'document-tab-close';
      close.setAttribute('aria-label', `Close ${tab.payload.name}`);
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      tabElement.append(type, tabName, close);
      tabElement.addEventListener('click', () => activateTab(tab.id));
      tabElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activateTab(tab.id);
      });
      tablist.append(tabElement);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'new-tab-button';
    add.setAttribute('aria-label', 'Open another document');
    add.textContent = '+';
    add.addEventListener('click', () => void chooseDocuments());
    tablist.append(add);
    filesSection.count.textContent = String(tabs.length);
    updateHistoryButtons();
    const selectedTab = tablist.querySelector<HTMLElement>('[aria-selected="true"]');
    requestAnimationFrame(() => {
      selectedTab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
  };

  const renderMarkdownOutline = (article: HTMLElement) => {
    const headings = Array.from(
      article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    for (const heading of headings) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'outline-item';
      item.style.setProperty('--outline-depth', String(Number(heading.tagName.slice(1)) - 1));
      item.textContent = heading.textContent ?? '';
      item.addEventListener('click', () => {
        outlineSection.content
          .querySelector('[aria-current="location"]')
          ?.removeAttribute('aria-current');
        item.setAttribute('aria-current', 'location');
        heading.scrollIntoView?.({ block: 'start' });
      });
      outlineSection.content.append(item);
    }
    outlineSection.count.textContent = String(headings.length);
  };

  const renderError = (message: string) => {
    destroyActiveView();
    viewport.replaceChildren();
    outlineSection.content.replaceChildren();
    outlineSection.count.textContent = '0';
    const state = document.createElement('section');
    state.className = 'error-state';
    state.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.textContent = 'This document could not be shown.';
    const detail = document.createElement('p');
    detail.textContent = message;
    state.append(title, detail, createOpenButton('Open another document', chooseDocuments));
    viewport.append(state);
    renderWarning();
    renderFormatHint();
  };

  const renderActive = () => {
    closeDocumentSearch();
    destroyActiveView();
    outlineSection.content.replaceChildren();
    outlineSection.count.textContent = '0';
    viewport.replaceChildren();
    viewport.scrollTop = 0;
    const tab = activeTab();
    if (!tab) {
      shell.className = 'app-shell';
      viewport.append(createEmptyState(chooseDocuments));
      renderWarning();
      renderFormatHint();
      document.title = 'FFM Viewer';
      return;
    }

    const renderId = ++renderSequence;
    shell.className = `app-shell is-${tab.payload.kind}`;
    if (tab.source === 'scratch' && !tab.payload.content) {
      const state = document.createElement('section');
      state.className = 'scratch-empty';
      const title = document.createElement('h1');
      title.textContent = 'Paste content to preview';
      const detail = document.createElement('p');
      detail.textContent = 'Markdown and JSON are detected automatically.';
      state.append(title, detail);
      viewport.append(state);
      renderWarning();
      renderFormatHint();
      document.title = `${tab.payload.name} — FFM Viewer`;
      return;
    }
    if (tab.payload.kind === 'markdown') {
      const article = document.createElement('article');
      article.className = 'markdown-document';
      article.innerHTML = renderMarkdown(tab.payload.content);
      renderMarkdownOutline(article);
      if (tab.source === 'file') {
        void hydrateLocalImages(
          article,
          tab.payload,
          bridge,
          () => renderId === renderSequence && activeId === tab.id,
        );
      }
      article.addEventListener('click', (event) => {
        const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        event.preventDefault();
        if (/^(?:https?:|mailto:)/i.test(href)) void bridge.openExternal(href);
      });
      viewport.append(article);
      requestAnimationFrame(() => {
        if (activeId === tab.id) viewport.scrollTop = tab.scrollTop;
      });
    } else if (tab.payload.kind === 'json') {
      try {
        activeCodeView = createJsonCodeView(
          tab.source === 'scratch'
            ? tab.payload.content
            : formatJsonDocument(tab.payload.content),
        );
        const jsonOutline = activeCodeView.querySelector<HTMLElement>('.json-outline');
        if (jsonOutline) {
          outlineSection.content.append(jsonOutline);
          const updateCount = () => {
            outlineSection.count.textContent = String(
              jsonOutline.querySelectorAll('[data-action="jump"]').length,
            );
          };
          updateCount();
          outlineObserver = new MutationObserver(updateCount);
          outlineObserver.observe(jsonOutline, { childList: true, subtree: true });
        }
        viewport.append(activeCodeView);
        requestAnimationFrame(() => {
          if (activeId !== tab.id) return;
          const scroller = activeCodeView?.querySelector<HTMLElement>('.cm-scroller');
          if (scroller) scroller.scrollTop = tab.scrollTop;
        });
      } catch (error) {
        renderError(error instanceof Error ? error.message : 'Invalid JSON.');
        return;
      }
    } else if (tab.payload.kind === 'image') {
      const imageDocument = document.createElement('section');
      imageDocument.className = 'image-document';
      const image = document.createElement('img');
      image.src = tab.payload.content;
      image.alt = tab.payload.name;
      image.decoding = 'async';
      image.draggable = false;
      image.addEventListener('error', () => {
        if (activeId === tab.id) renderError('Image could not be decoded.');
      });
      imageDocument.append(image);
      viewport.append(imageDocument);
    } else {
      activeCodeView = createTextCodeView(tab.payload.content);
      viewport.append(activeCodeView);
      requestAnimationFrame(() => {
        if (activeId !== tab.id) return;
        const scroller = activeCodeView?.querySelector<HTMLElement>('.cm-scroller');
        if (scroller) scroller.scrollTop = tab.scrollTop;
      });
    }
    renderWarning();
    renderFormatHint();
    document.title = `${tab.payload.name} — FFM Viewer`;
  };

  const recordHistory = (id: string) => {
    if (history[historyIndex] === id) return;
    history.splice(historyIndex + 1);
    history.push(id);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
  };

  function addScratchTab(recovery?: ScratchRecovery): OpenTab {
    snapshotScroll();
    const recoveredNumber = recovery?.name.match(/^Untitled (\d+)$/)?.[1];
    untitledCounter = Math.max(
      untitledCounter + 1,
      recoveredNumber ? Number(recoveredNumber) : 0,
    );
    const id = `scratch:${untitledCounter}`;
    const tab: OpenTab = {
      id,
      source: 'scratch',
      payload: {
        path: id,
        name: recovery?.name ?? `Untitled ${untitledCounter}`,
        kind: recovery?.kind ?? 'markdown',
        content: recovery?.content ?? '',
      },
      scrollTop: 0,
      dirty: Boolean(recovery),
    };
    tabs.push(tab);
    setActiveId(id);
    recordHistory(id);
    return tab;
  }

  function openScratch(): void {
    addScratchTab();
    renderChrome();
    renderActive();
  }

  async function applyScratchKind(kind: ScratchViewKind): Promise<void> {
    const tab = activeTab();
    if (!tab || tab.source !== 'scratch') return;
    tab.payload = { ...tab.payload, kind };
    tab.hint = undefined;
    await persistDirtyScratches(tab);
    renderChrome();
    renderActive();
  }

  async function pasteIntoScratch(source: string): Promise<void> {
    let tab = activeTab();
    if (!tab || tab.source !== 'scratch' || tab.dirty || tab.payload.content) {
      tab = addScratchTab();
    }
    if (isPastedDocumentTooLarge(source)) {
      tab.warning = 'Pasted content is larger than the 50 MB safety limit.';
      renderChrome();
      renderActive();
      return;
    }
    const prepared = preparePastedDocument(source);
    tab.payload = {
      ...tab.payload,
      kind: prepared.kind,
      content: prepared.content,
    };
    tab.dirty = true;
    tab.hint = prepared.hint;
    tab.warning = undefined;
    await persistDirtyScratches(tab);
    renderChrome();
    renderActive();
  }

  function enqueuePaste(source: string): void {
    if (pasteBusy) {
      pendingPastes.push(source);
      return;
    }
    pasteBusy = true;
    void pasteIntoScratch(source).finally(() => {
      pasteBusy = false;
      const next = pendingPastes.shift();
      if (next) enqueuePaste(next);
    });
  }

  async function installActiveWatcher(path: string): Promise<string | undefined> {
    try {
      await bridge.watchDocument(
        path,
        (changedPath) => {
          const changed = tabs.find((candidate) => candidate.payload.path === changedPath);
          if (changed && changed.id === activeId) void refreshFileTab(changed.id, false);
        },
        (failedPath) => {
          const failed = tabs.find((candidate) => candidate.payload.path === failedPath);
          if (!failed || failed.id !== activeId) return;
          failed.warning = WATCH_WARNING;
          renderWarning();
        },
      );
      return undefined;
    } catch {
      return WATCH_WARNING;
    }
  }

  async function refreshFileTab(id: string, installWatch = true): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || activeId !== id) return;
    const path = tab.payload.path;
    const sequence = ++readSequence;
    if (installWatch) {
      tab.warning = await installActiveWatcher(path);
    }
    try {
      const payload = await bridge.readDocument(path);
      if (sequence !== readSequence || activeId !== id) return;
      const changed = payload.name !== tab.payload.name
        || payload.kind !== tab.payload.kind
        || payload.content !== tab.payload.content;
      tab.payload = payload;
      if (!changed) {
        renderWarning();
        return;
      }
      const started = performance.now();
      renderChrome();
      renderActive();
      root.dataset.renderMs = (performance.now() - started).toFixed(2);
    } catch (error) {
      if (sequence !== readSequence || activeId !== id) return;
      renderError(error instanceof Error ? error.message : 'File could not be opened.');
    }
  }

  function activateTab(id: string, addToHistory = true): void {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (activeId === id) {
      if (addToHistory) recordHistory(id);
      updateHistoryButtons();
      return;
    }
    snapshotScroll();
    setActiveId(id);
    if (addToHistory) recordHistory(id);
    const started = performance.now();
    renderChrome();
    renderActive();
    root.dataset.renderMs = (performance.now() - started).toFixed(2);
    if (tab.source === 'file') void refreshFileTab(id);
  }

  function removeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = id === activeId;
    snapshotScroll();
    tabs.splice(index, 1);
    for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
      if (history[cursor] !== id) continue;
      history.splice(cursor, 1);
      if (cursor <= historyIndex) historyIndex -= 1;
    }
    historyIndex = Math.max(-1, Math.min(historyIndex, history.length - 1));
    if (wasActive) {
      const replacement = tabs[Math.min(index, tabs.length - 1)];
      setActiveId(undefined);
      if (replacement) {
        activateTab(replacement.id);
        return;
      }
    }
    renderChrome();
    if (wasActive) renderActive();
  }

  async function saveScratch(tab: OpenTab): Promise<boolean> {
    if (tab.payload.kind === 'image') return false;
    const kind: Exclude<DocumentKind, 'image'> = tab.payload.kind;
    try {
      const saved = await bridge.saveDocument(
        tab.payload.name,
        kind,
        tab.payload.content,
      );
      if (!saved) return false;
      tab.dirty = false;
      return persistDirtyScratches(tab);
    } catch (error) {
      tab.warning = error instanceof Error
        ? error.message
        : 'The document could not be saved.';
      if (tab.id === activeId) renderWarning();
      return false;
    }
  }

  async function canCloseTab(tab: OpenTab): Promise<boolean> {
    if (!tab.dirty) return true;
    const decision = await bridge.confirmClose(tab.payload.name);
    if (decision === 'cancel') return false;
    if (decision === 'save') return saveScratch(tab);
    return persistDirtyScratches(tab, tab.id);
  }

  const requestCloseWindow = () => {
    void bridge.closeWindow().catch(() => {
      startupWarning = 'The window could not be closed.';
      renderWarning();
    });
  };

  function closeTab(id: string): void {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    const finish = () => {
      removeTab(id);
      if (tabs.length === 0) requestCloseWindow();
    };
    if (!tab.dirty) {
      finish();
      return;
    }
    void canCloseTab(tab).then((canClose) => {
      if (canClose) finish();
    });
  }

  const closeActiveTabOrWindow = () => {
    if (activeId) closeTab(activeId);
    else requestCloseWindow();
  };

  async function canCloseWindow(): Promise<boolean> {
    for (const tab of tabs) {
      if (!tab.dirty) continue;
      if (!(await canCloseTab(tab))) {
        activateTab(tab.id);
        return false;
      }
    }
    return true;
  }

  async function openDocument(path: string): Promise<void> {
    const direct = tabs.find((tab) => tab.payload.path === path);
    if (direct) {
      if (direct.id === activeId) void refreshFileTab(direct.id);
      else activateTab(direct.id);
      return;
    }
    const revisionBeforeOpen = activationRevision;
    const fileWarning = await installActiveWatcher(path);
    try {
      const payload = await bridge.readDocument(path);
      const watcherOwnershipChanged = activationRevision !== revisionBeforeOpen;
      const existing = tabs.find((tab) => tab.payload.path === payload.path);
      if (existing) {
        existing.warning = fileWarning;
        activateTab(existing.id);
        return;
      }
      const tab: OpenTab = {
        id: payload.path,
        source: 'file',
        payload,
        scrollTop: 0,
        dirty: false,
        warning: fileWarning,
      };
      tabs.push(tab);
      snapshotScroll();
      setActiveId(tab.id);
      recordHistory(tab.id);
      const started = performance.now();
      renderChrome();
      renderActive();
      root.dataset.renderMs = (performance.now() - started).toFixed(2);
      if (watcherOwnershipChanged) {
        void installActiveWatcher(tab.payload.path).then((warningMessage) => {
          if (activeId !== tab.id) return;
          tab.warning = warningMessage;
          renderWarning();
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'File could not be opened.';
      const current = activeTab();
      if (!current) {
        renderError(message);
        return;
      }
      current.warning = message;
      renderWarning();
      if (current.source === 'file') void installActiveWatcher(current.payload.path);
    }
  }

  function queueDocument(path: string): Promise<void> {
    openQueue = openQueue.then(() => openDocument(path));
    return openQueue;
  }

  async function chooseDocuments(): Promise<void> {
    const paths = await bridge.chooseDocuments();
    for (const path of paths) await queueDocument(path);
  }

  const closeQuickSwitcher = () => {
    root.querySelector('[data-quick-switcher]')?.remove();
  };

  let settingsReturnFocus: HTMLElement | undefined;
  const closeSettings = () => {
    const dialog = root.querySelector<HTMLDialogElement>('[data-settings]');
    if (!dialog) return;
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    (dialog.closest('.settings-overlay') ?? dialog).remove();
    settingsReturnFocus?.focus();
    settingsReturnFocus = undefined;
  };

  const openSettings = () => {
    closeQuickSwitcher();
    closeFileSearch();
    closeSettings();
    settingsReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-panel';
    dialog.dataset.settings = '';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'settings-title');
    const header = document.createElement('header');
    header.className = 'settings-header';
    const title = document.createElement('h2');
    title.id = 'settings-title';
    title.textContent = 'Settings';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toolbar-button settings-close';
    close.setAttribute('aria-label', 'Close Settings');
    close.textContent = '×';
    close.addEventListener('click', closeSettings);
    header.append(title, close);

    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.htmlFor = 'theme-select';
    label.textContent = 'Appearance';
    const select = document.createElement('select');
    select.id = 'theme-select';
    select.name = 'theme';

    for (const option of THEME_OPTIONS) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    select.value = document.documentElement.dataset.theme ?? 'green';
    select.addEventListener('change', () => {
      const option = THEME_OPTIONS.find(({ value }) => value === select.value);
      if (!option) return;
      persistThemePreference(option.value);
    });

    row.append(label, select);
    dialog.append(header, row);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeSettings();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === close) {
        event.preventDefault();
        select.focus();
      } else if (!event.shiftKey && document.activeElement === select) {
        event.preventDefault();
        close.focus();
      }
    });
    overlay.append(dialog);
    root.append(overlay);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => select.focus());
  };

  let fileSearchCleanup: (() => void) | undefined;
  const closeFileSearch = () => {
    fileSearchCleanup?.();
    fileSearchCleanup = undefined;
    root.querySelector('[data-file-search]')?.remove();
  };

  const openFileSearch = () => {
    closeSettings();
    closeQuickSwitcher();
    closeFileSearch();

    const overlay = document.createElement('div');
    overlay.className = 'quick-switcher';
    overlay.dataset.fileSearch = '';
    const box = document.createElement('section');
    box.className = 'quick-switcher-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Search files on this Mac');
    const input = document.createElement('input');
    input.className = 'quick-switcher-input';
    input.dataset.fileSearchInput = '';
    input.placeholder = 'Search supported files…';
    const list = document.createElement('div');
    list.className = 'quick-switcher-list';
    let timer: number | undefined;
    let revision = 0;
    let activeIndex = 0;

    const updateActiveResult = (nextIndex: number) => {
      const items = Array.from(list.querySelectorAll<HTMLElement>('[data-file-search-result]'));
      if (items.length === 0) return;
      activeIndex = (nextIndex + items.length) % items.length;
      items.forEach((item, index) => item.classList.toggle('is-active', index === activeIndex));
      items[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    };

    const renderMessage = (message: string) => {
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'quick-switcher-empty';
      empty.textContent = message;
      list.append(empty);
    };

    const openResult = (path: string) => {
      closeFileSearch();
      void queueDocument(path);
    };

    const renderResults = (paths: readonly string[]) => {
      list.replaceChildren();
      activeIndex = 0;
      if (paths.length === 0) {
        renderMessage('No supported files found.');
        return;
      }
      for (const [index, path] of paths.entries()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `quick-switcher-item file-search-result${index === 0 ? ' is-active' : ''}`;
        item.dataset.fileSearchResult = path;
        const type = document.createElement('span');
        type.className = 'document-type';
        type.textContent = fileType(path);
        const copy = document.createElement('span');
        copy.className = 'file-search-copy';
        const name = document.createElement('strong');
        name.textContent = fileName(path);
        const location = document.createElement('small');
        location.textContent = path;
        copy.append(name, location);
        item.append(type, copy);
        item.addEventListener('click', () => openResult(path));
        list.append(item);
      }
    };

    const search = async () => {
      const query = input.value.trim();
      const request = ++revision;
      if (!query) {
        renderMessage('Type a file name.');
        return;
      }
      renderMessage('Searching…');
      try {
        const paths = await bridge.searchDocuments(query);
        if (request === revision) renderResults(paths);
      } catch {
        if (request === revision) renderMessage('File search is unavailable.');
      }
    };

    input.addEventListener('input', () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void search(), 60);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeFileSearch();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        updateActiveResult(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      }
      if (event.key === 'Enter') {
        const items = list.querySelectorAll<HTMLElement>('[data-file-search-result]');
        const path = items[activeIndex]?.dataset.fileSearchResult;
        if (path) openResult(path);
      }
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeFileSearch();
    });
    box.append(input, list);
    overlay.append(box);
    root.append(overlay);
    renderMessage('Type a file name.');
    fileSearchCleanup = () => {
      revision += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    requestAnimationFrame(() => input.focus());
  };

  const openCurrentDocumentSearch = () => {
    closeSettings();
    closeQuickSwitcher();
    closeFileSearch();
    closeDocumentSearch();
    if (activeCodeView) {
      activeCodeView.openSearch();
      return;
    }
    const tab = activeTab();
    const article = viewport.querySelector<HTMLElement>('.markdown-document');
    if (!tab || tab.payload.kind !== 'markdown' || !article) return;

    const searchBar = document.createElement('div');
    searchBar.className = 'document-search';
    searchBar.dataset.documentSearch = '';
    const input = document.createElement('input');
    input.dataset.documentSearchInput = '';
    input.placeholder = 'Find in document';
    input.setAttribute('aria-label', 'Find in document');
    const count = document.createElement('span');
    count.className = 'document-search-count';
    count.textContent = '0/0';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.setAttribute('aria-label', 'Previous match');
    previous.textContent = '↑';
    const next = document.createElement('button');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next match');
    next.textContent = '↓';
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close document search');
    close.textContent = '×';
    let ranges: Range[] = [];
    let rangeIndex = -1;
    let lastQuery = '';

    const showMatch = (direction: number) => {
      const query = input.value;
      if (query !== lastQuery) {
        lastQuery = query;
        ranges = query ? findTextRanges(article, query) : [];
        rangeIndex = -1;
      }
      if (ranges.length === 0) {
        window.getSelection()?.removeAllRanges();
        count.textContent = '0/0';
        return;
      }
      rangeIndex = (rangeIndex + direction + ranges.length) % ranges.length;
      const range = ranges[rangeIndex];
      if (!range) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      input.focus();
      range.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
      count.textContent = `${rangeIndex + 1}/${ranges.length}`;
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDocumentSearch();
      if (event.key === 'Enter') {
        event.preventDefault();
        showMatch(event.shiftKey ? -1 : 1);
      }
    });
    previous.addEventListener('click', () => showMatch(-1));
    next.addEventListener('click', () => showMatch(1));
    close.addEventListener('click', closeDocumentSearch);
    searchBar.append(input, count, previous, next, close);
    workArea.append(searchBar);
    requestAnimationFrame(() => input.focus());
  };

  const openQuickSwitcher = () => {
    closeSettings();
    closeFileSearch();
    closeQuickSwitcher();
    if (tabs.length === 0) return;
    const overlay = document.createElement('div');
    overlay.className = 'quick-switcher';
    overlay.dataset.quickSwitcher = '';
    const box = document.createElement('section');
    box.className = 'quick-switcher-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Search open files');
    const input = document.createElement('input');
    input.className = 'quick-switcher-input';
    input.dataset.quickSwitchInput = '';
    input.placeholder = 'Go to file or action…';
    const list = document.createElement('div');
    list.className = 'quick-switcher-list';
    const renderResults = () => {
      list.replaceChildren();
      const query = input.value.trim().toLocaleLowerCase();
      const matches = tabs.filter((tab) => tab.payload.name.toLocaleLowerCase().includes(query));
      for (const [index, tab] of matches.entries()) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `quick-switcher-item${index === 0 ? ' is-active' : ''}`;
        item.dataset.quickSwitchId = tab.id;
        const type = document.createElement('span');
        type.className = 'document-type';
        type.textContent = kindLabel(tab.payload);
        const name = document.createElement('span');
        name.textContent = tab.payload.name;
        item.append(type, name);
        item.addEventListener('click', () => {
          activateTab(tab.id);
          closeQuickSwitcher();
        });
        list.append(item);
      }
      const scratch = activeTab();
      if (query && scratch?.source === 'scratch') {
        for (const action of SCRATCH_VIEW_ACTIONS.filter(
          ({ label }) => label.toLocaleLowerCase().includes(query),
        )) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `quick-switcher-item${list.children.length === 0 ? ' is-active' : ''}`;
          item.dataset.quickActionKind = action.kind;
          const type = document.createElement('span');
          type.className = 'document-type';
          type.textContent = '→';
          const name = document.createElement('span');
          name.textContent = action.label;
          item.append(type, name);
          item.addEventListener('click', () => {
            void applyScratchKind(action.kind);
            closeQuickSwitcher();
          });
          list.append(item);
        }
      }
    };
    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeQuickSwitcher();
      if (event.key === 'Enter') {
        const first = list.querySelector<HTMLElement>(
          '[data-quick-switch-id], [data-quick-action-kind]',
        );
        const id = first?.dataset.quickSwitchId;
        const action = SCRATCH_VIEW_ACTIONS.find(
          ({ kind }) => kind === first?.dataset.quickActionKind,
        );
        if (id) activateTab(id);
        else if (action) void applyScratchKind(action.kind);
        closeQuickSwitcher();
      }
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeQuickSwitcher();
    });
    box.append(input, list);
    overlay.append(box);
    root.append(overlay);
    renderResults();
    requestAnimationFrame(() => input.focus());
  };

  back.addEventListener('click', () => {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    const id = history[historyIndex];
    if (id) activateTab(id, false);
  });
  forward.addEventListener('click', () => {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    const id = history[historyIndex];
    if (id) activateTab(id, false);
  });
  commandCenter.addEventListener('click', openQuickSwitcher);
  openButton.addEventListener('click', () => void chooseDocuments());

  if (activeKeydownListener) window.removeEventListener('keydown', activeKeydownListener);
  activeKeydownListener = (event) => {
    if (SHORTCUT_DIAGNOSTICS_ENABLED) {
      shortcutDiagnostics.textContent = `key=${event.key} code=${event.code || '—'} meta=${Number(event.metaKey)} ctrl=${Number(event.ctrlKey)} alt=${Number(event.altKey)}`;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (
      modifier
      && !event.altKey
      && (isKey(event, 'KeyN', 'n') || isKey(event, 'KeyT', 't'))
    ) {
      event.preventDefault();
      openScratch();
      return;
    }
    if (modifier && !event.altKey && isKey(event, 'KeyO', 'o')) {
      event.preventDefault();
      void chooseDocuments();
      return;
    }
    if (modifier && !event.altKey && isKey(event, 'KeyK', 'k')) {
      event.preventDefault();
      openQuickSwitcher();
      return;
    }
    if (modifier && !event.altKey && isKey(event, 'KeyP', 'p')) {
      event.preventDefault();
      openFileSearch();
      return;
    }
    if (modifier && !event.altKey && isKey(event, 'KeyF', 'f')) {
      event.preventDefault();
      openCurrentDocumentSearch();
      return;
    }
    if (
      event.ctrlKey
      && !event.metaKey
      && isKey(event, 'KeyW', 'w')
    ) {
      event.preventDefault();
      closeActiveTabOrWindow();
      return;
    }
    if (
      modifier
      && !event.altKey
      && (event.code === 'Comma' || event.key === ',')
    ) {
      event.preventDefault();
      openSettings();
      return;
    }
    if (modifier && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      if (tabs.length === 0) return;
      const current = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const next = tabs[(current + direction + tabs.length) % tabs.length];
      if (next) activateTab(next.id);
      return;
    }
    if (modifier && !event.altKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const index = event.key === '9' ? tabs.length - 1 : Number(event.key) - 1;
      const tab = tabs[index];
      if (tab) activateTab(tab.id);
      return;
    }
    if (event.key === 'Escape') {
      if (root.querySelector('[data-settings]')) {
        closeSettings();
        return;
      }
      if (root.querySelector('[data-quick-switcher]')) {
        closeQuickSwitcher();
        return;
      }
      if (root.querySelector('[data-file-search]')) {
        closeFileSearch();
        return;
      }
      if (root.querySelector('[data-document-search]')) {
        closeDocumentSearch();
        return;
      }
      const tab = activeTab();
      if (tab?.hint) {
        tab.hint = undefined;
        renderFormatHint();
      }
    }
  };
  window.addEventListener('keydown', activeKeydownListener);

  if (activePasteListener) window.removeEventListener('paste', activePasteListener);
  activePasteListener = (event) => {
    const target = event.target;
    if (
      target instanceof Element
      && target.closest('input, textarea, [contenteditable="true"]')
    ) return;
    const source = event.clipboardData?.getData('text/plain');
    if (!source) return;
    event.preventDefault();
    enqueuePaste(source);
  };
  window.addEventListener('paste', activePasteListener);

  try {
    const recovered = await bridge.loadRecovery();
    for (const scratch of recovered) addScratchTab(scratch);
  } catch {
    startupWarning = 'Scratch recovery could not be loaded.';
  }
  renderChrome();
  renderActive();
  await Promise.all([
    bridge.onOpenRequested((path) => void queueDocument(path)),
    bridge.onFileDropped((path) => void queueDocument(path)),
    bridge.onCloseActiveTab(() => {
      closeActiveTabOrWindow();
    }),
    bridge.onCloseRequested(canCloseWindow),
  ]);
  const pendingPaths = await bridge.takePendingOpen();
  for (const path of pendingPaths) await queueDocument(path);
}
