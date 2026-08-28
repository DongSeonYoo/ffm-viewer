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
const MAX_OPEN_TAB_MATCHES = 100;
const WATCH_WARNING = 'Live refresh paused. Reopen the document to retry.';
const RECOVERY_WARNING = 'Recovery unavailable. Keep this tab open or save it to a file.';
const SHORTCUT_DIAGNOSTICS_ENABLED = import.meta.env.VITE_FFM_DIAGNOSTICS === '1';
const THEME_STORAGE_KEY = 'ffm.theme';
const SEARCH_FORMAT_STORAGE_KEY = 'ffm.searchFormats';
const THEME_OPTIONS = [
  { value: 'green', label: 'FFM Green' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const;
const SEARCH_FORMATS = [
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'markdown'] },
  { id: 'json', label: 'JSON', extensions: ['json'] },
  { id: 'text', label: 'Text', extensions: ['txt'] },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'] },
  { id: 'toml', label: 'TOML', extensions: ['toml'] },
  { id: 'png', label: 'PNG', extensions: ['png'] },
  { id: 'jpeg', label: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { id: 'gif', label: 'GIF', extensions: ['gif'] },
  { id: 'webp', label: 'WebP', extensions: ['webp'] },
  { id: 'avif', label: 'AVIF', extensions: ['avif'] },
  { id: 'svg', label: 'SVG', extensions: ['svg'] },
] as const;
type ThemePreference = typeof THEME_OPTIONS[number]['value'];
type SearchFormatId = typeof SEARCH_FORMATS[number]['id'];
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

type NavigationPane = 'sidebar' | 'content';

interface NavigationEntry {
  readonly tabId: string;
  readonly scrollTop: number;
  readonly pane: NavigationPane;
}

type OpenTabSearchMatch = {
  readonly tab: OpenTab;
  readonly content: string;
  readonly preview: string;
  readonly kind: 'markdown';
  readonly occurrence: number;
  readonly query: string;
  readonly resultIndex: number;
} | {
  readonly tab: OpenTab;
  readonly content: string;
  readonly preview: string;
  readonly kind: 'code';
  readonly from: number;
  readonly query: string;
  readonly resultIndex: number;
  readonly to: number;
};

type OpenTabSearchDocument = {
  readonly content: string;
  readonly kind: 'markdown';
  readonly blocks: readonly string[];
} | {
  readonly content: string;
  readonly kind: 'code';
  readonly source: string;
};

function disableWritingAssistance(input: HTMLInputElement): void {
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
}

function selectSearchResult(
  input: HTMLInputElement,
  items: readonly HTMLElement[],
  nextIndex: number,
): number {
  if (items.length === 0) return 0;
  const activeIndex = (nextIndex + items.length) % items.length;
  items.forEach((item, index) => {
    const active = index === activeIndex;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-selected', String(active));
  });
  input.setAttribute('aria-activedescendant', items[activeIndex]?.id ?? '');
  items[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  return activeIndex;
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

function allSearchFormats(): Set<SearchFormatId> {
  return new Set(SEARCH_FORMATS.map(({ id }) => id));
}

function isSearchFormatId(value: string): value is SearchFormatId {
  return SEARCH_FORMATS.some(({ id }) => id === value);
}

function readSearchFormats(): Set<SearchFormatId> {
  try {
    const stored = window.localStorage.getItem(SEARCH_FORMAT_STORAGE_KEY);
    if (stored === null) return allSearchFormats();
    const enabled = new Set<SearchFormatId>();
    for (const value of stored === '' ? [] : stored.split(',')) {
      if (!isSearchFormatId(value)) return allSearchFormats();
      enabled.add(value);
    }
    return enabled;
  } catch {
    return allSearchFormats();
  }
}

function persistSearchFormats(enabled: ReadonlySet<SearchFormatId>): void {
  try {
    window.localStorage.setItem(
      SEARCH_FORMAT_STORAGE_KEY,
      SEARCH_FORMATS.filter(({ id }) => enabled.has(id)).map(({ id }) => id).join(','),
    );
  } catch {
    // The current selection still works for this launch.
  }
}

function selectedSearchExtensions(enabled: ReadonlySet<SearchFormatId>): string[] {
  return SEARCH_FORMATS
    .filter(({ id }) => enabled.has(id))
    .flatMap(({ extensions }) => [...extensions]);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textBlockNodes(container: HTMLElement): Text[][] {
  const blocks = new Map<HTMLElement, Text[]>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest<HTMLElement>(
      'h1, h2, h3, h4, h5, h6, p, pre, li, td, th',
    );
    if (!block || !container.contains(block)) continue;
    const nodes = blocks.get(block) ?? [];
    nodes.push(node as Text);
    blocks.set(block, nodes);
  }
  return Array.from(blocks.values());
}

function findTextRanges(
  container: HTMLElement,
  query: string,
  limit = MAX_DOCUMENT_MATCHES,
  offset = 0,
): Range[] {
  const ranges: Range[] = [];
  const matcher = new RegExp(escapeRegExp(query), 'giu');
  let seen = 0;

  for (const nodes of textBlockNodes(container)) {
    const parts: Array<{ node: Text; start: number; end: number }> = [];
    let text = '';
    for (const node of nodes) {
      if (!node.data) continue;
      const start = text.length;
      text += node.data;
      parts.push({ node, start, end: text.length });
    }
    for (const match of text.matchAll(matcher)) {
      const value = match[0];
      if (match.index === undefined || !value) continue;
      if (seen++ < offset) continue;
      const start = match.index;
      const end = start + value.length;
      const startPart = parts.find((part) => start < part.end);
      const endPart = parts.find((part) => end <= part.end);
      if (!startPart || !endPart) continue;
      const range = document.createRange();
      range.setStart(startPart.node, start - startPart.start);
      range.setEnd(endPart.node, end - endPart.start);
      ranges.push(range);
      if (ranges.length === limit) break;
    }
    if (ranges.length === limit) break;
  }
  return ranges;
}

function codeSource(tab: OpenTab): string {
  return tab.payload.kind === 'json' && tab.source === 'file'
    ? formatJsonDocument(tab.payload.content)
    : tab.payload.content;
}

function previewText(text: string, matchStart: number, matchLength: number): string {
  const start = Math.max(0, matchStart - 60);
  const end = Math.min(text.length, matchStart + matchLength + 100);
  const preview = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${preview}${end < text.length ? '…' : ''}`;
}

function createOpenTabSearchDocument(tab: OpenTab): OpenTabSearchDocument {
  if (tab.payload.kind !== 'markdown') {
    return { content: tab.payload.content, kind: 'code', source: codeSource(tab) };
  }
  const article = document.createElement('article');
  article.innerHTML = renderMarkdown(tab.payload.content);
  const blocks = textBlockNodes(article).map((nodes) => nodes.map((node) => node.data).join(''));
  return { content: tab.payload.content, kind: 'markdown', blocks };
}

function findOpenTabMatches(
  tabs: readonly OpenTab[],
  query: string,
  documents: Map<string, OpenTabSearchDocument>,
): OpenTabSearchMatch[] {
  const resultsByTab: OpenTabSearchMatch[][] = [];
  const matcher = new RegExp(escapeRegExp(query), 'giu');

  for (const tab of tabs) {
    if (tab.payload.kind === 'image') continue;
    let document = documents.get(tab.id);
    if (!document || document.content !== tab.payload.content) {
      try {
        document = createOpenTabSearchDocument(tab);
      } catch {
        continue;
      }
      documents.set(tab.id, document);
    }
    const results: OpenTabSearchMatch[] = [];
    if (document.kind === 'markdown') {
      let occurrence = 0;
      for (const text of document.blocks) {
        let firstMatch: RegExpMatchArray | undefined;
        let blockMatches = 0;
        for (const match of text.matchAll(matcher)) {
          firstMatch ??= match;
          blockMatches += 1;
        }
        if (firstMatch?.index !== undefined) {
          results.push({
            tab,
            content: document.content,
            preview: previewText(text, firstMatch.index, firstMatch[0].length),
            kind: 'markdown',
            occurrence,
            query,
            resultIndex: results.length,
          });
          if (results.length === MAX_OPEN_TAB_MATCHES) break;
        }
        occurrence += blockMatches;
      }
      if (results.length > 0) resultsByTab.push(results);
      continue;
    }

    const source = document.source;
    let lineStart = 0;
    let previousLineStart = -1;
    for (const match of source.matchAll(matcher)) {
      if (match.index === undefined || !match[0]) continue;
      while (true) {
        const newline = source.indexOf('\n', lineStart);
        if (newline < 0 || newline >= match.index) break;
        lineStart = newline + 1;
      }
      if (lineStart !== previousLineStart) {
        previousLineStart = lineStart;
        const lineEnd = source.indexOf('\n', match.index);
        const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
        results.push({
          tab,
          content: document.content,
          preview: previewText(line, match.index - lineStart, match[0].length),
          kind: 'code',
          from: match.index,
          query,
          resultIndex: results.length,
          to: match.index + match[0].length,
        });
        if (results.length === MAX_OPEN_TAB_MATCHES) break;
      }
    }
    if (results.length > 0) resultsByTab.push(results);
  }

  const results: OpenTabSearchMatch[] = [];
  for (let index = 0; results.length < MAX_OPEN_TAB_MATCHES; index += 1) {
    let added = false;
    for (const tabResults of resultsByTab) {
      const result = tabResults[index];
      if (!result) continue;
      results.push(result);
      added = true;
      if (results.length === MAX_OPEN_TAB_MATCHES) return results;
    }
    if (!added) break;
  }
  return results;
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
  const enabledSearchFormats = readSearchFormats();
  const tabs: OpenTab[] = [];
  const history: NavigationEntry[] = [];
  let historyIndex = -1;
  let focusedPane: NavigationPane = 'content';
  let suppressPaneHistory = false;
  let pendingPaneHistory: {
    readonly frame: number;
    readonly pane: NavigationPane;
    readonly tabId: string | undefined;
  } | undefined;
  let navigationRevision = 0;
  let activeHistoryDestination: {
    readonly entry: NavigationEntry;
    readonly pane: NavigationPane;
  } | undefined;
  let historyRestoreFrame: number | undefined;
  let jsonOutlineActionRevision = 0;
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
  let refreshQuickSwitcherResults: (() => void) | undefined;
  let quickSwitcherReturnFocus: HTMLElement | undefined;
  const closingTabIds = new Set<string>();

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  const topbar = document.createElement('header');
  topbar.className = 'app-topbar';
  topbar.dataset.tauriDragRegion = '';
  const historyNav = document.createElement('nav');
  historyNav.className = 'history-navigation';
  historyNav.setAttribute('aria-label', 'Navigation history');
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'history-button';
  back.dataset.history = 'back';
  back.setAttribute('aria-label', 'Go back');
  back.title = 'Go back (⌘Z)';
  back.textContent = '←';
  const forward = document.createElement('button');
  forward.type = 'button';
  forward.className = 'history-button';
  forward.dataset.history = 'forward';
  forward.setAttribute('aria-label', 'Go forward');
  forward.title = 'Go forward (⇧⌘Z)';
  forward.textContent = '→';
  historyNav.append(back, forward);
  const commandCenterSlot = document.createElement('div');
  commandCenterSlot.className = 'command-center-slot';
  const commandCenter = document.createElement('button');
  commandCenter.type = 'button';
  commandCenter.className = 'command-center';
  commandCenter.innerHTML = '<span aria-hidden="true">⌕</span><span>Search files on this Mac…</span><kbd>⌘P</kbd>';
  commandCenterSlot.append(commandCenter);
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'toolbar-button';
  openButton.setAttribute('aria-label', 'Open document');
  openButton.title = 'Open document (⌘O)';
  openButton.textContent = '+';
  topbar.append(historyNav, commandCenterSlot, openButton);

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
  viewport.tabIndex = -1;
  viewport.setAttribute('aria-label', 'Document content');
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

  const currentNavigationPane = (): NavigationPane => (
    sidebar.contains(document.activeElement) ? 'sidebar' : 'content'
  );

  const clearActiveHistoryDestination = () => {
    activeHistoryDestination = undefined;
    if (historyRestoreFrame !== undefined) {
      window.cancelAnimationFrame(historyRestoreFrame);
      historyRestoreFrame = undefined;
      suppressPaneHistory = false;
    }
  };

  const setSidebarCollapsed = (collapsed: boolean) => {
    navigationRevision += 1;
    const moveFocus = collapsed && sidebar.contains(document.activeElement);
    if (pendingPaneHistory) window.cancelAnimationFrame(pendingPaneHistory.frame);
    pendingPaneHistory = undefined;
    clearActiveHistoryDestination();
    sidebar.hidden = collapsed;
    layout.classList.toggle('is-sidebar-collapsed', collapsed);
    if (!moveFocus) return;
    suppressPaneHistory = true;
    focusedPane = 'content';
    viewport.focus();
    suppressPaneHistory = false;
  };

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
        navigationRevision += 1;
        if (!pendingPaneHistory) updateCurrentHistoryEntry();
        outlineSection.content
          .querySelector('[aria-current="location"]')
          ?.removeAttribute('aria-current');
        item.setAttribute('aria-current', 'location');
        heading.scrollIntoView?.({ block: 'start' });
        recordCurrentLocation('sidebar');
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
        activeCodeView = createJsonCodeView(codeSource(tab));
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

  const recordHistory = (
    id: string,
    pane: NavigationPane = currentNavigationPane(),
    force = false,
  ) => {
    clearActiveHistoryDestination();
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    const entry: NavigationEntry = {
      tabId: id,
      scrollTop: Math.round(tab.scrollTop),
      pane,
    };
    focusedPane = pane;
    const current = history[historyIndex];
    if (
      !force
      && current?.tabId === entry.tabId
      && current.scrollTop === entry.scrollTop
      && current.pane === entry.pane
    ) return;
    history.splice(historyIndex + 1);
    history.push(entry);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  };

  const applyNavigationEntry = (entry: NavigationEntry, pane: NavigationPane) => {
    const tab = tabs.find((candidate) => candidate.id === entry.tabId);
    if (!tab || activeId !== tab.id) return;
    const scroller = activeCodeView?.querySelector<HTMLElement>('.cm-scroller');
    if (scroller) scroller.scrollTop = entry.scrollTop;
    else viewport.scrollTop = entry.scrollTop;
    if (pane === 'sidebar') {
      const file = Array.from(
        sidebar.querySelectorAll<HTMLElement>('[data-open-file]'),
      ).find((candidate) => candidate.dataset.openFile === tab.id);
      (file ?? sidebar.querySelector<HTMLElement>('button'))?.focus();
    } else {
      viewport.focus();
    }
  };

  const finishHistoryRestore = (destination: NonNullable<typeof activeHistoryDestination>) => {
    if (activeHistoryDestination === destination) {
      applyNavigationEntry(destination.entry, destination.pane);
    }
    suppressPaneHistory = false;
    updateHistoryButtons();
  };

  const scheduleHistoryRestore = (destination: NonNullable<typeof activeHistoryDestination>) => {
    if (historyRestoreFrame !== undefined) window.cancelAnimationFrame(historyRestoreFrame);
    suppressPaneHistory = true;
    historyRestoreFrame = requestAnimationFrame(() => {
      historyRestoreFrame = undefined;
      finishHistoryRestore(destination);
    });
  };

  const flushHistoryRestore = () => {
    const destination = activeHistoryDestination;
    if (!destination || historyRestoreFrame === undefined) return;
    window.cancelAnimationFrame(historyRestoreFrame);
    historyRestoreFrame = undefined;
    finishHistoryRestore(destination);
  };

  const updateCurrentHistoryEntry = () => {
    flushHistoryRestore();
    clearActiveHistoryDestination();
    const current = history[historyIndex];
    const tab = activeTab();
    if (!current || !tab || current.tabId !== tab.id) return;
    snapshotScroll();
    history[historyIndex] = {
      tabId: tab.id,
      scrollTop: Math.round(tab.scrollTop),
      pane: focusedPane,
    };
  };

  const recordCurrentLocation = (pane: NavigationPane = focusedPane) => {
    const tab = activeTab();
    if (!tab) return;
    snapshotScroll();
    recordHistory(tab.id, pane);
  };

  const flushPaneHistory = () => {
    const pending = pendingPaneHistory;
    if (!pending) return;
    window.cancelAnimationFrame(pending.frame);
    pendingPaneHistory = undefined;
    if (!suppressPaneHistory && activeId === pending.tabId) {
      recordCurrentLocation(pending.pane);
    }
  };

  const restoreHistory = (entry: NavigationEntry) => {
    flushHistoryRestore();
    const tab = tabs.find((candidate) => candidate.id === entry.tabId);
    if (!tab) return;
    const pane: NavigationPane = entry.pane === 'sidebar' && !sidebar.hidden
      ? 'sidebar'
      : 'content';
    focusedPane = pane;
    tab.scrollTop = entry.scrollTop;
    if (activeId !== tab.id) activateTab(tab.id, false, false);
    const destination = { entry, pane };
    activeHistoryDestination = destination;
    scheduleHistoryRestore(destination);
  };

  layout.addEventListener('focusin', (event) => {
    if (suppressPaneHistory || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-document-search], .cm-search')) return;
    const pane = sidebar.contains(event.target)
      ? 'sidebar'
      : workArea.contains(event.target) ? 'content' : undefined;
    if (!pane || pane === focusedPane) return;
    navigationRevision += 1;
    updateCurrentHistoryEntry();
    focusedPane = pane;
    if (pendingPaneHistory) window.cancelAnimationFrame(pendingPaneHistory.frame);
    const tabId = activeId;
    const frame = requestAnimationFrame(() => {
      if (pendingPaneHistory?.frame !== frame) return;
      pendingPaneHistory = undefined;
      if (!suppressPaneHistory && activeId === tabId) recordCurrentLocation(pane);
    });
    pendingPaneHistory = { frame, pane, tabId };
  });

  layout.addEventListener('pointerdown', clearActiveHistoryDestination, true);
  layout.addEventListener('wheel', clearActiveHistoryDestination, {
    capture: true,
    passive: true,
  });
  layout.addEventListener('keydown', (event) => {
    if (!event.defaultPrevented) clearActiveHistoryDestination();
  }, true);

  outlineSection.content.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-action="jump"]')) {
      return;
    }
    jsonOutlineActionRevision = ++navigationRevision;
    if (pendingPaneHistory) window.cancelAnimationFrame(pendingPaneHistory.frame);
    else updateCurrentHistoryEntry();
    pendingPaneHistory = undefined;
    if (activeId) recordHistory(activeId, 'content', true);
  }, true);

  outlineSection.content.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-action="jump"]')) {
      return;
    }
    const revision = jsonOutlineActionRevision;
    requestAnimationFrame(() => {
      if (navigationRevision !== revision) return;
      focusedPane = 'content';
      updateCurrentHistoryEntry();
    });
  });

  function addScratchTab(recovery?: ScratchRecovery): OpenTab {
    updateCurrentHistoryEntry();
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
    recordHistory(id, 'content');
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
      refreshQuickSwitcherResults?.();
      const destination = activeHistoryDestination;
      if (destination?.entry.tabId === id) scheduleHistoryRestore(destination);
      root.dataset.renderMs = (performance.now() - started).toFixed(2);
    } catch (error) {
      if (sequence !== readSequence || activeId !== id) return;
      renderError(error instanceof Error ? error.message : 'File could not be opened.');
    }
  }

  function activateTab(id: string, addToHistory = true, refresh = true): void {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (addToHistory) navigationRevision += 1;
    const pane = currentNavigationPane();
    if (activeId === id) {
      if (addToHistory) {
        updateCurrentHistoryEntry();
        recordHistory(id, pane);
      }
      updateHistoryButtons();
      return;
    }
    if (addToHistory) updateCurrentHistoryEntry();
    setActiveId(id);
    if (addToHistory) recordHistory(id, pane);
    const started = performance.now();
    renderChrome();
    renderActive();
    root.dataset.renderMs = (performance.now() - started).toFixed(2);
    if (tab.source === 'file' && refresh) void refreshFileTab(id);
  }

  function removeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = id === activeId;
    updateCurrentHistoryEntry();
    tabs.splice(index, 1);
    for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
      if (history[cursor]?.tabId !== id) continue;
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

  async function guardedTabClose(
    tab: OpenTab,
    finish?: () => void,
  ): Promise<boolean> {
    if (closingTabIds.has(tab.id)) return false;
    if (!tab.dirty) {
      finish?.();
      return true;
    }
    closingTabIds.add(tab.id);
    try {
      const canClose = await canCloseTab(tab);
      if (canClose) finish?.();
      return canClose;
    } finally {
      closingTabIds.delete(tab.id);
    }
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
    void guardedTabClose(tab, finish);
  }

  const closeActiveTabOrWindow = () => {
    if (activeId) closeTab(activeId);
    else requestCloseWindow();
  };

  async function canCloseWindow(): Promise<boolean> {
    if (closingTabIds.size > 0) return false;
    for (const tab of tabs) {
      if (!tab.dirty) continue;
      if (!(await guardedTabClose(tab))) {
        activateTab(tab.id);
        return false;
      }
    }
    return closingTabIds.size === 0;
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
      updateCurrentHistoryEntry();
      setActiveId(tab.id);
      recordHistory(tab.id, 'content');
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
    closeSettings();
    closeQuickSwitcher();
    closeFileSearch();
    closeDocumentSearch();
    openQueue = openQueue.then(() => openDocument(path));
    return openQueue;
  }

  async function chooseDocuments(): Promise<void> {
    clearActiveHistoryDestination();
    const paths = await bridge.chooseDocuments();
    for (const path of paths) await queueDocument(path);
  }

  const closeQuickSwitcher = (restoreFocus = false) => {
    refreshQuickSwitcherResults = undefined;
    root.querySelector('[data-quick-switcher]')?.remove();
    const returnFocus = quickSwitcherReturnFocus;
    quickSwitcherReturnFocus = undefined;
    if (restoreFocus) returnFocus?.focus();
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
    clearActiveHistoryDestination();
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

    const searchSection = document.createElement('section');
    searchSection.className = 'settings-section';
    searchSection.setAttribute('aria-labelledby', 'search-file-types-title');
    const searchHeader = document.createElement('div');
    searchHeader.className = 'settings-section-header';
    const searchCopy = document.createElement('div');
    const searchTitle = document.createElement('h3');
    searchTitle.id = 'search-file-types-title';
    searchTitle.textContent = 'File search';
    const searchDescription = document.createElement('p');
    searchDescription.textContent = 'File types shown in ⌘P';
    searchCopy.append(searchTitle, searchDescription);
    const allLabel = document.createElement('label');
    allLabel.className = 'settings-file-type settings-file-type-all';
    const allToggle = document.createElement('input');
    allToggle.type = 'checkbox';
    allToggle.dataset.searchFormatAll = '';
    const allText = document.createElement('strong');
    allText.textContent = 'All supported';
    allLabel.append(allToggle, allText);
    searchHeader.append(searchCopy, allLabel);

    const formatList = document.createElement('div');
    formatList.className = 'settings-file-types';
    const formatInputs = new Map<SearchFormatId, HTMLInputElement>();
    for (const format of SEARCH_FORMATS) {
      const formatLabel = document.createElement('label');
      formatLabel.className = 'settings-file-type';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'search-format';
      input.value = format.id;
      input.dataset.searchFormat = format.id;
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = format.label;
      const extensions = document.createElement('small');
      extensions.textContent = format.extensions.map((extension) => `.${extension}`).join(' ');
      copy.append(name, extensions);
      formatLabel.append(input, copy);
      formatList.append(formatLabel);
      formatInputs.set(format.id, input);
    }

    const syncSearchFormatControls = () => {
      allToggle.checked = enabledSearchFormats.size === SEARCH_FORMATS.length;
      allToggle.indeterminate = enabledSearchFormats.size > 0
        && enabledSearchFormats.size < SEARCH_FORMATS.length;
      for (const [id, input] of formatInputs) input.checked = enabledSearchFormats.has(id);
    };
    const saveSearchFormats = () => {
      persistSearchFormats(enabledSearchFormats);
      syncSearchFormatControls();
    };
    allToggle.addEventListener('change', () => {
      enabledSearchFormats.clear();
      if (allToggle.checked) SEARCH_FORMATS.forEach(({ id }) => enabledSearchFormats.add(id));
      saveSearchFormats();
    });
    for (const [id, input] of formatInputs) {
      input.addEventListener('change', () => {
        if (input.checked) enabledSearchFormats.add(id);
        else enabledSearchFormats.delete(id);
        saveSearchFormats();
      });
    }
    syncSearchFormatControls();
    searchSection.append(searchHeader, formatList);

    dialog.append(header, row, searchSection);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeSettings();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled])',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        closeSettings();
        return;
      }
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) closeSettings();
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
    commandCenter.hidden = false;
  };

  const openFileSearch = () => {
    clearActiveHistoryDestination();
    closeSettings();
    closeQuickSwitcher();
    closeFileSearch();
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const extensions = selectedSearchExtensions(enabledSearchFormats);
    commandCenter.hidden = true;

    const surface = document.createElement('section');
    surface.className = 'file-quick-open';
    surface.dataset.fileSearch = '';
    surface.setAttribute('role', 'search');
    surface.setAttribute('aria-label', 'Search files on this Mac');
    const input = document.createElement('input');
    disableWritingAssistance(input);
    input.className = 'quick-switcher-input';
    input.dataset.fileSearchInput = '';
    input.placeholder = 'Search files by name';
    input.setAttribute('aria-label', 'Search files by name');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'file-quick-open-results');
    const list = document.createElement('div');
    list.id = 'file-quick-open-results';
    list.className = 'quick-switcher-list';
    list.setAttribute('role', 'listbox');
    let timer: number | undefined;
    let revision = 0;
    let activeIndex = 0;
    let refreshPending = true;
    let searchQueue = Promise.resolve();

    const updateActiveResult = (nextIndex: number) => {
      const items = Array.from(list.querySelectorAll<HTMLElement>('[data-file-search-result]'));
      activeIndex = selectSearchResult(input, items, nextIndex);
    };

    const renderMessage = (message: string) => {
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'quick-switcher-empty';
      empty.textContent = message;
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
    };

    const openResult = (path: string) => {
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
        item.id = `file-quick-open-result-${index}`;
        item.dataset.fileSearchResult = path;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === 0));
        item.tabIndex = -1;
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
      input.setAttribute('aria-activedescendant', 'file-quick-open-result-0');
    };

    const search = () => {
      const query = input.value.trim();
      const request = ++revision;
      if (!query) {
        renderMessage('Type a file name.');
        return;
      }
      if (extensions.length === 0) {
        renderMessage('Enable file types in Settings.');
        return;
      }
      renderMessage('Searching…');
      searchQueue = searchQueue.then(async () => {
        if (request !== revision) return;
        const refresh = refreshPending;
        try {
          const paths = await bridge.searchDocuments(query, refresh, extensions);
          if (refresh) refreshPending = false;
          if (request === revision) renderResults(paths);
        } catch {
          if (request === revision) renderMessage('File search is unavailable.');
        }
      });
    };

    input.addEventListener('input', () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        search();
      }, 60);
    });
    const flushSearch = () => {
      if (timer === undefined) return false;
      window.clearTimeout(timer);
      timer = undefined;
      search();
      return true;
    };
    const openActiveResult = () => {
      if (!surface.isConnected) return;
      const items = list.querySelectorAll<HTMLElement>('[data-file-search-result]');
      const path = items[activeIndex]?.dataset.fileSearchResult;
      if (path) openResult(path);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeFileSearch();
        returnFocus?.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const move = () => updateActiveResult(
          activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
        );
        if (flushSearch()) void searchQueue.then(move);
        else move();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        flushSearch();
        void searchQueue.then(openActiveResult);
      }
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !surface.contains(event.target)) closeFileSearch();
    };
    surface.append(input, list);
    commandCenterSlot.append(surface);
    renderMessage(extensions.length === 0
      ? 'Enable file types in Settings.'
      : 'Type a file name.');
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    fileSearchCleanup = () => {
      revision += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
    requestAnimationFrame(() => input.focus());
  };

  const openCurrentDocumentSearch = () => {
    clearActiveHistoryDestination();
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
    disableWritingAssistance(input);
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
      rangeIndex = rangeIndex === -1
        ? (direction < 0 ? ranges.length - 1 : 0)
        : (rangeIndex + direction + ranges.length) % ranges.length;
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
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeDocumentSearch();
        return;
      }
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
    clearActiveHistoryDestination();
    closeSettings();
    closeFileSearch();
    closeQuickSwitcher();
    closeDocumentSearch();
    if (tabs.length === 0) return;
    quickSwitcherReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const overlay = document.createElement('div');
    overlay.className = 'quick-switcher content-search';
    overlay.dataset.quickSwitcher = '';
    const box = document.createElement('section');
    box.className = 'quick-switcher-box content-search-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Search open tab contents');
    const input = document.createElement('input');
    disableWritingAssistance(input);
    input.className = 'quick-switcher-input';
    input.dataset.openTabSearchInput = '';
    input.placeholder = 'Search all open documents…';
    input.setAttribute('aria-label', 'Search all open documents');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'content-search-results');
    const summary = document.createElement('div');
    summary.className = 'content-search-summary';
    summary.dataset.contentSearchSummary = '';
    summary.setAttribute('aria-live', 'polite');
    const list = document.createElement('div');
    list.id = 'content-search-results';
    list.className = 'quick-switcher-list content-search-list';
    list.setAttribute('role', 'listbox');
    const documents = new Map<string, OpenTabSearchDocument>();
    let activeIndex = 0;
    let matches: OpenTabSearchMatch[] = [];

    const items = () => Array.from(
      list.querySelectorAll<HTMLElement>('.quick-switcher-item'),
    );

    const updateActiveResult = (nextIndex: number) => {
      const results = items();
      activeIndex = selectSearchResult(input, results, nextIndex);
    };

    const renderMessage = (message: string) => {
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'quick-switcher-empty';
      empty.textContent = message;
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
    };

    const revealMatch = (match: OpenTabSearchMatch) => {
      const actionRevision = ++navigationRevision;
      closeQuickSwitcher();
      const needsRefresh = activeId !== match.tab.id && match.tab.source === 'file';
      updateCurrentHistoryEntry();
      activateTab(match.tab.id, false, !needsRefresh);
      recordHistory(match.tab.id, 'content', true);
      const reveal = () => {
        if (navigationRevision !== actionRevision) return;
        let current: OpenTabSearchMatch | undefined = match;
        if (match.content !== match.tab.payload.content) {
          const refreshed = findOpenTabMatches([match.tab], match.query, new Map());
          current = refreshed[match.resultIndex] ?? refreshed[0];
        }
        if (!current) return;
        requestAnimationFrame(() => {
          if (
            navigationRevision !== actionRevision
            || activeId !== current.tab.id
            || current.content !== current.tab.payload.content
          ) return;
          if (current.kind === 'markdown') {
            const article = viewport.querySelector<HTMLElement>('.markdown-document');
            const range = article
              && findTextRanges(article, current.query, 1, current.occurrence)[0];
            if (!range) return;
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            range.startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
            requestAnimationFrame(() => {
              if (navigationRevision !== actionRevision) return;
              focusedPane = 'content';
              updateCurrentHistoryEntry();
            });
            return;
          }
          activeCodeView?.revealRange(current.from, current.to);
          requestAnimationFrame(() => {
            if (navigationRevision !== actionRevision) return;
            focusedPane = 'content';
            updateCurrentHistoryEntry();
          });
        });
      };
      if (needsRefresh) void refreshFileTab(match.tab.id).then(reveal);
      else reveal();
    };

    const renderResults = () => {
      list.replaceChildren();
      activeIndex = 0;
      const query = input.value.trim();
      if (!query) {
        matches = [];
        summary.textContent = `${tabs.length} open ${tabs.length === 1 ? 'document' : 'documents'}`;
        renderMessage('Type to search open tabs.');
        return;
      }
      matches = findOpenTabMatches(tabs, query, documents);
      const groups = new Map<OpenTab, Array<{ index: number; match: OpenTabSearchMatch }>>();
      for (const [index, match] of matches.entries()) {
        const group = groups.get(match.tab) ?? [];
        group.push({ index, match });
        groups.set(match.tab, group);
      }
      summary.textContent = `${matches.length} ${matches.length === 1 ? 'result' : 'results'} in ${groups.size} ${groups.size === 1 ? 'document' : 'documents'}`;

      for (const [tab, groupMatches] of groups) {
        const group = document.createElement('section');
        group.className = 'content-search-group';
        group.dataset.contentSearchGroup = tab.id;
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `${tab.payload.name}, ${groupMatches.length} results`);
        const header = document.createElement('header');
        header.className = 'content-search-group-header';
        const type = document.createElement('span');
        type.className = 'document-type';
        type.textContent = kindLabel(tab.payload);
        const title = document.createElement('span');
        title.className = 'content-search-group-title';
        const name = document.createElement('strong');
        name.textContent = tab.payload.name;
        const location = document.createElement('small');
        location.textContent = tab.source === 'file' ? tab.payload.path : 'Scratch';
        const count = document.createElement('span');
        count.className = 'content-search-group-count';
        count.textContent = String(groupMatches.length);
        title.append(name, location);
        header.append(type, title, count);
        group.append(header);

        for (const { index, match } of groupMatches) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `quick-switcher-item content-search-result${index === 0 ? ' is-active' : ''}`;
          item.id = `content-search-result-${index}`;
          item.dataset.openTabSearchResult = String(index);
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(index === 0));
          item.setAttribute('aria-label', `${tab.payload.name}: ${match.preview}`);
          item.tabIndex = -1;
          const preview = document.createElement('span');
          preview.className = 'content-search-preview';
          preview.textContent = match.preview;
          item.append(preview);
          item.addEventListener('click', () => revealMatch(match));
          group.append(item);
        }
        list.append(group);
      }
      const scratch = activeTab();
      if (query && scratch?.source === 'scratch') {
        const actions = SCRATCH_VIEW_ACTIONS.filter(
          ({ label }) => label.toLocaleLowerCase().includes(query),
        );
        const actionGroup = document.createElement('section');
        actionGroup.className = 'content-search-group content-search-actions';
        actionGroup.setAttribute('role', 'group');
        actionGroup.setAttribute('aria-label', 'Actions');
        if (actions.length > 0) {
          const header = document.createElement('header');
          header.className = 'content-search-group-header';
          header.textContent = 'Actions';
          actionGroup.append(header);
        }
        const activateFirstAction = items().length === 0;
        for (const [index, action] of actions.entries()) {
          const active = activateFirstAction && index === 0;
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `quick-switcher-item${active ? ' is-active' : ''}`;
          item.id = `content-search-action-${action.kind}`;
          item.dataset.quickActionKind = action.kind;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(active));
          item.tabIndex = -1;
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
          actionGroup.append(item);
        }
        if (actions.length > 0) list.append(actionGroup);
      }
      const first = items()[0];
      if (first) input.setAttribute('aria-activedescendant', first.id);
      else renderMessage('No matches in open tabs.');
    };
    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeQuickSwitcher(true);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        input.focus();
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        updateActiveResult(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const selected = items()[activeIndex];
        const matchIndex = Number(selected?.dataset.openTabSearchResult);
        const action = SCRATCH_VIEW_ACTIONS.find(
          ({ kind }) => kind === selected?.dataset.quickActionKind,
        );
        if (Number.isInteger(matchIndex) && matches[matchIndex]) revealMatch(matches[matchIndex]);
        else if (action) void applyScratchKind(action.kind);
        if (action) closeQuickSwitcher();
      }
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeQuickSwitcher(true);
    });
    box.append(input, summary, list);
    overlay.append(box);
    root.append(overlay);
    renderResults();
    refreshQuickSwitcherResults = renderResults;
    requestAnimationFrame(() => input.focus());
  };

  const navigateHistory = (direction: -1 | 1) => {
    flushPaneHistory();
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    navigationRevision += 1;
    updateCurrentHistoryEntry();
    historyIndex = nextIndex;
    closeSettings();
    closeQuickSwitcher();
    closeFileSearch();
    closeDocumentSearch();
    const entry = history[historyIndex];
    if (entry) restoreHistory(entry);
  };

  back.addEventListener('click', () => navigateHistory(-1));
  forward.addEventListener('click', () => navigateHistory(1));
  commandCenter.addEventListener('click', openFileSearch);
  openButton.addEventListener('click', () => void chooseDocuments());

  if (activeKeydownListener) window.removeEventListener('keydown', activeKeydownListener, true);
  activeKeydownListener = (event) => {
    if (SHORTCUT_DIAGNOSTICS_ENABLED) {
      shortcutDiagnostics.textContent = `key=${event.key} code=${event.code || '—'} meta=${Number(event.metaKey)} ctrl=${Number(event.ctrlKey)} alt=${Number(event.altKey)}`;
    }
    const command = event.metaKey;
    if (
      command
      && !event.altKey
      && !event.ctrlKey
      && isKey(event, 'KeyZ', 'z')
    ) {
      event.preventDefault();
      navigateHistory(event.shiftKey ? 1 : -1);
      return;
    }
    if (
      event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && isKey(event, 'KeyB', 'b')
    ) {
      event.preventDefault();
      setSidebarCollapsed(!sidebar.hidden);
      return;
    }
    if (
      command
      && !event.altKey
      && (isKey(event, 'KeyN', 'n') || isKey(event, 'KeyT', 't'))
    ) {
      event.preventDefault();
      openScratch();
      return;
    }
    if (command && !event.altKey && isKey(event, 'KeyO', 'o')) {
      event.preventDefault();
      void chooseDocuments();
      return;
    }
    if (command && !event.altKey && !event.shiftKey && isKey(event, 'KeyK', 'k')) {
      event.preventDefault();
      openQuickSwitcher();
      return;
    }
    if (command && !event.altKey && event.shiftKey && isKey(event, 'KeyF', 'f')) {
      event.preventDefault();
      openQuickSwitcher();
      return;
    }
    if (command && !event.altKey && !event.shiftKey && isKey(event, 'KeyP', 'p')) {
      event.preventDefault();
      openFileSearch();
      return;
    }
    if (command && !event.altKey && !event.shiftKey && isKey(event, 'KeyF', 'f')) {
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
      command
      && !event.altKey
      && (event.code === 'Comma' || event.key === ',')
    ) {
      event.preventDefault();
      openSettings();
      return;
    }
    if (command && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      if (tabs.length === 0) return;
      const current = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const next = tabs[(current + direction + tabs.length) % tabs.length];
      if (next) activateTab(next.id);
      return;
    }
    if (command && !event.altKey && /^[1-9]$/.test(event.key)) {
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
        closeQuickSwitcher(true);
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
  window.addEventListener('keydown', activeKeydownListener, true);

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
  await bridge.onSearchFiles(openFileSearch);
}
