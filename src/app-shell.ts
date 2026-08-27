import { createJsonCodeView, type JsonCodeViewElement } from './components/json-tree';
import type { DesktopBridge, DocumentPayload } from './lib/desktop-bridge';
import { formatJsonDocument } from './lib/json-document';
import { renderMarkdown } from './lib/markdown';

let activeKeydownListener: ((event: KeyboardEvent) => void) | undefined;
const IMAGE_CONCURRENCY = 3;
const MAX_IMAGE_DATA_CHARS = 24 * 1024 * 1024;
const MAX_HISTORY = 100;
const WATCH_WARNING = 'Live refresh paused. Reopen the document to retry.';

interface OpenTab {
  readonly id: string;
  payload: DocumentPayload;
  scrollTop: number;
  watchWarning?: string;
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
  description.textContent = 'Open or drop a Markdown or JSON document.';
  state.append(mark, title, description, createOpenButton('Open document', onOpen));
  return state;
}

function kindLabel(payload: DocumentPayload): string {
  return payload.kind === 'markdown' ? 'MD' : 'JSON';
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
  const tabs: OpenTab[] = [];
  const history: string[] = [];
  let historyIndex = -1;
  let activeId: string | undefined;
  let activeJsonView: JsonCodeViewElement | undefined;
  let outlineObserver: MutationObserver | undefined;
  let renderSequence = 0;
  let readSequence = 0;
  let openQueue = Promise.resolve();

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
  workArea.append(tablist, warning, viewport);
  layout.append(sidebar, workArea);
  shell.append(topbar, layout);
  root.replaceChildren(shell);

  const activeTab = () => tabs.find((tab) => tab.id === activeId);

  const snapshotScroll = () => {
    const tab = activeTab();
    if (!tab) return;
    const scroller = activeJsonView?.querySelector<HTMLElement>('.cm-scroller');
    tab.scrollTop = scroller?.scrollTop ?? viewport.scrollTop;
  };

  const destroyActiveView = () => {
    outlineObserver?.disconnect();
    outlineObserver = undefined;
    activeJsonView?.destroy();
    activeJsonView = undefined;
  };

  const updateHistoryButtons = () => {
    back.disabled = historyIndex <= 0;
    forward.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
  };

  const renderWatchWarning = () => {
    const message = activeTab()?.watchWarning;
    warning.hidden = !message;
    warning.textContent = message ?? '';
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
      fileButton.addEventListener('click', () => activateTab(tab.id));
      filesSection.content.append(fileButton);

      const tabElement = document.createElement('div');
      tabElement.className = `document-tab${selected ? ' is-active' : ''}`;
      tabElement.dataset.tabId = tab.id;
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
    add.addEventListener('click', () => void chooseDocument());
    tablist.append(add);
    filesSection.count.textContent = String(tabs.length);
    updateHistoryButtons();
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
    state.append(title, detail, createOpenButton('Open another document', chooseDocument));
    viewport.append(state);
    renderWatchWarning();
  };

  const renderActive = () => {
    destroyActiveView();
    outlineSection.content.replaceChildren();
    outlineSection.count.textContent = '0';
    viewport.replaceChildren();
    viewport.scrollTop = 0;
    const tab = activeTab();
    if (!tab) {
      shell.className = 'app-shell';
      viewport.append(createEmptyState(chooseDocument));
      renderWatchWarning();
      document.title = 'FFM Viewer';
      return;
    }

    const renderId = ++renderSequence;
    shell.className = `app-shell is-${tab.payload.kind}`;
    if (tab.payload.kind === 'markdown') {
      const article = document.createElement('article');
      article.className = 'markdown-document';
      article.innerHTML = renderMarkdown(tab.payload.content);
      renderMarkdownOutline(article);
      void hydrateLocalImages(
        article,
        tab.payload,
        bridge,
        () => renderId === renderSequence && activeId === tab.id,
      );
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
    } else {
      try {
        activeJsonView = createJsonCodeView(formatJsonDocument(tab.payload.content));
        const jsonOutline = activeJsonView.querySelector<HTMLElement>('.json-outline');
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
        viewport.append(activeJsonView);
        requestAnimationFrame(() => {
          if (activeId !== tab.id) return;
          const scroller = activeJsonView?.querySelector<HTMLElement>('.cm-scroller');
          if (scroller) scroller.scrollTop = tab.scrollTop;
        });
      } catch (error) {
        renderError(error instanceof Error ? error.message : 'Invalid JSON.');
        return;
      }
    }
    renderWatchWarning();
    document.title = `${tab.payload.name} — FFM Viewer`;
  };

  const recordHistory = (id: string) => {
    if (history[historyIndex] === id) return;
    history.splice(historyIndex + 1);
    history.push(id);
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
  };

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
          failed.watchWarning = WATCH_WARNING;
          renderWatchWarning();
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
      tab.watchWarning = await installActiveWatcher(path);
    }
    try {
      const payload = await bridge.readDocument(path);
      if (sequence !== readSequence || activeId !== id) return;
      const changed = payload.name !== tab.payload.name
        || payload.kind !== tab.payload.kind
        || payload.content !== tab.payload.content;
      tab.payload = payload;
      if (!changed) {
        renderWatchWarning();
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
    if (!tabs.some((tab) => tab.id === id)) return;
    if (activeId === id) {
      if (addToHistory) recordHistory(id);
      updateHistoryButtons();
      return;
    }
    snapshotScroll();
    activeId = id;
    if (addToHistory) recordHistory(id);
    const started = performance.now();
    renderChrome();
    renderActive();
    root.dataset.renderMs = (performance.now() - started).toFixed(2);
    void refreshFileTab(id);
  }

  function closeTab(id: string): void {
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
      activeId = replacement?.id;
      if (activeId) recordHistory(activeId);
    }
    renderChrome();
    if (wasActive) renderActive();
  }

  async function openDocument(path: string): Promise<void> {
    const direct = tabs.find((tab) => tab.payload.path === path);
    if (direct) {
      if (direct.id === activeId) void refreshFileTab(direct.id);
      else activateTab(direct.id);
      return;
    }
    const watchWarning = await installActiveWatcher(path);
    try {
      const payload = await bridge.readDocument(path);
      const existing = tabs.find((tab) => tab.payload.path === payload.path);
      if (existing) {
        existing.watchWarning = watchWarning;
        activateTab(existing.id);
        return;
      }
      const tab: OpenTab = {
        id: payload.path,
        payload,
        scrollTop: 0,
        watchWarning,
      };
      tabs.push(tab);
      snapshotScroll();
      activeId = tab.id;
      recordHistory(tab.id);
      const started = performance.now();
      renderChrome();
      renderActive();
      root.dataset.renderMs = (performance.now() - started).toFixed(2);
    } catch (error) {
      renderError(error instanceof Error ? error.message : 'File could not be opened.');
    }
  }

  function queueDocument(path: string): Promise<void> {
    openQueue = openQueue.then(() => openDocument(path));
    return openQueue;
  }

  async function chooseDocument(): Promise<void> {
    const path = await bridge.chooseDocument();
    if (path) await queueDocument(path);
  }

  const closeQuickSwitcher = () => {
    root.querySelector('[data-quick-switcher]')?.remove();
  };

  const openQuickSwitcher = () => {
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
    input.placeholder = 'Go to file…';
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
    };
    input.addEventListener('input', renderResults);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeQuickSwitcher();
      if (event.key === 'Enter') {
        const first = list.querySelector<HTMLElement>('[data-quick-switch-id]');
        const id = first?.dataset.quickSwitchId;
        if (id) activateTab(id);
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
  openButton.addEventListener('click', () => void chooseDocument());

  if (activeKeydownListener) window.removeEventListener('keydown', activeKeydownListener);
  activeKeydownListener = (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && event.key.toLocaleLowerCase() === 'o') {
      event.preventDefault();
      void chooseDocument();
      return;
    }
    if (modifier && !event.altKey && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault();
      openQuickSwitcher();
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
    if (modifier && !event.altKey && event.key.toLocaleLowerCase() === 'w' && activeId) {
      event.preventDefault();
      closeTab(activeId);
      return;
    }
    if (event.key === 'Escape') closeQuickSwitcher();
  };
  window.addEventListener('keydown', activeKeydownListener);

  renderChrome();
  renderActive();
  await bridge.onOpenRequested((path) => void queueDocument(path));
  await bridge.onFileDropped((path) => void queueDocument(path));
  const pendingPath = await bridge.takePendingOpen();
  if (pendingPath) await queueDocument(pendingPath);
}
