import { json, jsonLanguage } from '@codemirror/lang-json';
import {
  foldGutter,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

const PAGE_SIZE = 100;
const MAX_OUTLINE_CHARACTERS = 3_000_000;
const DIAGNOSTICS_ENABLED = import.meta.env.VITE_FFM_DIAGNOSTICS === '1';
let activeDiagnosticsDestroy: (() => void) | undefined;
const VALUE_NODES = new Set([
  'Object',
  'Array',
  'String',
  'Number',
  'True',
  'False',
  'Null',
]);

type JsonSyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

interface OutlineItem {
  readonly label: string;
  readonly from: number;
  readonly value: JsonSyntaxNode;
}

interface OutlinePage {
  readonly items: OutlineItem[];
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

export interface CodeViewElement extends HTMLElement {
  openSearch(): void;
  destroy(): void;
}

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--json-key)' },
  { tag: tags.string, color: 'var(--json-string)' },
  { tag: tags.number, color: 'var(--json-number)' },
  { tag: tags.bool, color: 'var(--json-boolean)' },
  { tag: tags.null, color: 'var(--json-null)' },
]);

function elementMetrics(element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    connected: element.isConnected,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    client: { width: element.clientWidth, height: element.clientHeight },
    scroll: {
      left: Math.round(element.scrollLeft),
      top: Math.round(element.scrollTop),
      width: element.scrollWidth,
      height: element.scrollHeight,
    },
    style: {
      display: style.display,
      position: style.position,
      width: style.width,
      height: style.height,
      minHeight: style.minHeight,
      overflow: style.overflow,
      flex: style.flex,
      gridRows: style.gridTemplateRows,
    },
  };
}

function attachDiagnostics(
  wrapper: HTMLElement,
  code: HTMLElement,
  view: EditorView,
  source: string,
): { record(reason: string): void; destroy(): void } {
  activeDiagnosticsDestroy?.();
  const panel = document.createElement('details');
  panel.open = true;
  panel.dataset.ffmDiagnostics = '';
  panel.className = 'ffm-diagnostics';
  panel.setAttribute('aria-label', 'FFM diagnostics');

  const summary = document.createElement('summary');
  summary.textContent = 'FFM diagnostics';
  summary.className = 'ffm-diagnostics-summary';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.className = 'ffm-diagnostics-copy';
  const output = document.createElement('pre');
  output.className = 'ffm-diagnostics-output';
  panel.append(summary, copy, output);
  document.body.append(panel);

  const startedAt = performance.now();
  const sourceBytes = new TextEncoder().encode(source).length;
  const history: Array<Record<string, unknown>> = [];
  let frameId: number | undefined;
  let destroyed = false;
  const pendingReasons = new Set<string>();
  const writeSnapshot = (reason: string) => {
    const viewportHost = wrapper.parentElement;
    const shell = viewportHost?.parentElement;
    const content = elementMetrics(view.contentDOM);
    const latest = {
      atMs: Math.round((performance.now() - startedAt) * 100) / 100,
      reason,
      document: {
        bytes: sourceBytes,
        lines: view.state.doc.lines,
        visibility: document.visibilityState,
        devicePixelRatio: window.devicePixelRatio,
        windowScrollY: Math.round(window.scrollY),
        bodyHeight: document.body.scrollHeight,
        nonceElements: Array.from(document.querySelectorAll<HTMLElement>('[nonce]')).map((element) => ({
          tag: element.tagName,
          rel: element.getAttribute('rel'),
          nonce: element.nonce,
        })),
        styleTags: Array.from(document.head.querySelectorAll('style')).map((style) => ({
          nonce: style.nonce,
          textLength: style.textContent?.length ?? 0,
          rules: style.sheet?.cssRules.length ?? null,
        })),
      },
      codeMirror: {
        contentHeight: Math.round(view.contentHeight),
        viewport: { from: view.viewport.from, to: view.viewport.to },
        visibleRanges: view.visibleRanges.map(({ from, to }) => ({ from, to })),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
        contentTop: content?.rect.y ?? 0,
      },
      elements: {
        shell: elementMetrics(shell ?? null),
        viewportHost: elementMetrics(viewportHost),
        wrapper: elementMetrics(wrapper),
        code: elementMetrics(code),
        editor: elementMetrics(view.dom),
        scroller: elementMetrics(view.scrollDOM),
        content,
      },
    };
    history.push({
      atMs: latest.atMs,
      reason,
      editorHeight: view.dom.clientHeight,
      clientHeight: view.scrollDOM.clientHeight,
      scrollHeight: view.scrollDOM.scrollHeight,
      scrollTop: Math.round(view.scrollDOM.scrollTop),
      contentTop: latest.codeMirror.contentTop,
      viewportFrom: view.viewport.from,
      selection: view.state.selection.main.anchor,
    });
    if (history.length > 30) history.shift();
    output.textContent = JSON.stringify({ latest, history }, null, 2);
  };

  const record = (reason: string) => {
    if (destroyed) return;
    pendingReasons.add(reason);
    if (frameId !== undefined) return;
    frameId = requestAnimationFrame(() => {
      frameId = undefined;
      const reasons = Array.from(pendingReasons).join(',');
      pendingReasons.clear();
      writeSnapshot(reasons);
    });
  };

  const onScroll = () => record('scroll');
  const onWindowResize = () => record('window-resize');
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onWindowResize);
  const resizeObserver = new ResizeObserver(() => record('resize-observer'));
  [wrapper, code, view.dom, view.scrollDOM, view.contentDOM].forEach((element) => {
    resizeObserver.observe(element);
  });
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(output.textContent ?? '').catch(() => undefined);
  });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (frameId !== undefined) cancelAnimationFrame(frameId);
    resizeObserver.disconnect();
    view.scrollDOM.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onWindowResize);
    panel.remove();
    if (activeDiagnosticsDestroy === destroy) activeDiagnosticsDestroy = undefined;
  };
  activeDiagnosticsDestroy = destroy;

  return {
    record,
    destroy,
  };
}

function propertyValue(node: JsonSyntaxNode): JsonSyntaxNode | null {
  return node.lastChild?.name === 'PropertyName' ? null : node.lastChild;
}

function pageChildren(
  container: JsonSyntaxNode,
  source: string,
  offset: number,
): OutlinePage {
  const items: OutlineItem[] = [];
  let index = 0;
  let hasMore = false;

  for (let child = container.firstChild; child; child = child.nextSibling) {
    let item: OutlineItem | undefined;
    if (container.name === 'Object' && child.name === 'Property') {
      const name = child.getChild('PropertyName');
      const value = propertyValue(child);
      if (name && value) {
        item = {
          label: JSON.parse(source.slice(name.from, name.to)) as string,
          from: name.from,
          value,
        };
      }
    } else if (container.name === 'Array' && VALUE_NODES.has(child.name)) {
      item = { label: `[${index}]`, from: child.from, value: child };
    }

    if (!item) continue;
    if (index >= offset + PAGE_SIZE) {
      hasMore = true;
      break;
    }
    if (index >= offset) items.push(item);
    index += 1;
  }

  return {
    items,
    hasMore,
    nextOffset: offset + items.length,
  };
}

function isExpandable(node: JsonSyntaxNode): boolean {
  return node.name === 'Object' || node.name === 'Array';
}

function populateOutline(
  outline: HTMLElement,
  view: EditorView,
  source: string,
  syntaxRoot: JsonSyntaxNode,
): void {
  const root = syntaxRoot.firstChild;
  if (!root || !isExpandable(root)) return;
  let activeNode: HTMLElement | undefined;
  let activeJump: HTMLButtonElement | undefined;

  const renderPage = (
    container: JsonSyntaxNode,
    parent: HTMLElement,
    offset = 0,
  ) => {
    parent.querySelector(':scope > [data-action="more"]')?.remove();
    const page = pageChildren(container, source, offset);

    for (const item of page.items) {
      const node = document.createElement('div');
      node.className = 'json-outline-node';
      node.dataset.outlineLabel = item.label;
      node.setAttribute('role', 'treeitem');

      const row = document.createElement('div');
      row.className = 'json-outline-row';

      if (isExpandable(item.value)) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'json-outline-toggle';
        toggle.dataset.action = 'toggle';
        toggle.textContent = '›';
        toggle.setAttribute('aria-label', `Expand ${item.label}`);
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          let group = node.querySelector<HTMLElement>(':scope > [role="group"]');
          if (!group) {
            group = document.createElement('div');
            group.className = 'json-outline-children';
            group.setAttribute('role', 'group');
            node.append(group);
            renderPage(item.value, group);
          }
          const expanded = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', String(expanded));
          toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${item.label}`);
          toggle.textContent = expanded ? '⌄' : '›';
          group.hidden = !expanded;
        });
        row.append(toggle);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'json-outline-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        row.append(spacer);
      }

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'json-outline-key';
      jump.dataset.action = 'jump';
      jump.dataset.outlineLabel = item.label;
      jump.textContent = item.label;
      jump.addEventListener('click', () => {
        activeNode?.classList.remove('is-active');
        activeJump?.removeAttribute('aria-current');
        node.classList.add('is-active');
        jump.setAttribute('aria-current', 'location');
        activeNode = node;
        activeJump = jump;
        view.dispatch({
          selection: { anchor: item.from },
          effects: EditorView.scrollIntoView(item.from, { y: 'start', yMargin: 48 }),
        });
        view.focus();
      });
      row.append(jump);
      node.append(row);
      parent.append(node);
    }

    if (page.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'json-outline-more';
      more.dataset.action = 'more';
      more.textContent = 'Show more';
      more.addEventListener('click', () => renderPage(container, parent, page.nextOffset));
      parent.append(more);
    }
  };

  renderPage(root, outline);
}

function commonEditorExtensions(
  cspNonce: string | undefined,
  recordDiagnostics: (reason: string) => void,
): Extension[] {
  return [
    EditorState.readOnly.of(true),
    ...(cspNonce ? [EditorView.cspNonce.of(cspNonce)] : []),
    EditorView.contentAttributes.of({ 'aria-readonly': 'true' }),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    search({ top: true }),
    keymap.of(searchKeymap),
    ...(DIAGNOSTICS_ENABLED
      ? [EditorView.updateListener.of((update) => {
          const reasons = [
            update.geometryChanged ? 'geometry' : '',
            update.viewportChanged ? 'viewport' : '',
            update.selectionSet ? 'selection' : '',
          ].filter(Boolean);
          if (reasons.length > 0) recordDiagnostics(`view-update:${reasons.join(',')}`);
        })]
      : []),
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-scroller': { overflow: 'auto' },
      '.cm-content': { caretColor: 'transparent' },
    }),
  ];
}

export function createJsonCodeView(source: string): CodeViewElement {
  const wrapper = document.createElement('section') as CodeViewElement;
  wrapper.className = 'json-code-view';

  const code = document.createElement('div');
  code.className = 'json-code-editor';
  const cspNonce = document.querySelector<HTMLStyleElement>('#ffm-csp-nonce-source')?.nonce;

  let recordDiagnostics: (reason: string) => void = () => undefined;
  const state = EditorState.create({
    doc: source,
    extensions: [
      json(),
      ...commonEditorExtensions(cspNonce, (reason) => recordDiagnostics(reason)),
      foldGutter(),
      keymap.of(foldKeymap),
      syntaxHighlighting(jsonHighlightStyle),
    ],
  });
  const view = new EditorView({ state, parent: code });
  let destroyDiagnostics: () => void = () => undefined;

  const outline = document.createElement('nav');
  outline.className = 'json-outline';
  outline.setAttribute('role', 'tree');
  outline.setAttribute('aria-label', 'JSON keys');
  outline.setAttribute('aria-busy', 'true');
  const outlineStatus = document.createElement('p');
  outlineStatus.className = 'json-outline-status';
  outlineStatus.setAttribute('role', 'status');
  outlineStatus.textContent = 'Building outline…';
  outline.append(outlineStatus);
  wrapper.append(outline, code);

  let outlineTimer: number | undefined;
  let outlineFrame: number | undefined;
  if (source.length > MAX_OUTLINE_CHARACTERS) {
    outline.removeAttribute('aria-busy');
    outlineStatus.textContent = 'Outline is off for very large JSON.';
  } else {
    // ponytail: a worker can replace this ceiling if large-file outlines become necessary.
    outlineFrame = window.requestAnimationFrame(() => {
      outlineFrame = undefined;
      outlineTimer = window.setTimeout(() => {
        outlineTimer = undefined;
        const outlineTree = jsonLanguage.parser.parse(source);
        outline.replaceChildren();
        outline.removeAttribute('aria-busy');
        populateOutline(outline, view, source, outlineTree.topNode);
      });
    });
  }
  if (DIAGNOSTICS_ENABLED) {
    const diagnostics = attachDiagnostics(wrapper, code, view, source);
    recordDiagnostics = diagnostics.record;
    destroyDiagnostics = diagnostics.destroy;
    recordDiagnostics('attached-panel');
  }
  wrapper.destroy = () => {
    if (outlineFrame !== undefined) window.cancelAnimationFrame(outlineFrame);
    if (outlineTimer !== undefined) window.clearTimeout(outlineTimer);
    destroyDiagnostics();
    view.destroy();
  };
  wrapper.openSearch = () => openSearchPanel(view);
  return wrapper;
}

export function createTextCodeView(source: string): CodeViewElement {
  const wrapper = document.createElement('section') as CodeViewElement;
  wrapper.className = 'text-code-view';
  const code = document.createElement('div');
  code.className = 'json-code-editor text-code-editor';
  const cspNonce = document.querySelector<HTMLStyleElement>('#ffm-csp-nonce-source')?.nonce;
  let recordDiagnostics: (reason: string) => void = () => undefined;
  const state = EditorState.create({
    doc: source,
    extensions: commonEditorExtensions(cspNonce, (reason) => recordDiagnostics(reason)),
  });
  const view = new EditorView({ state, parent: code });
  let destroyDiagnostics: () => void = () => undefined;
  wrapper.append(code);
  if (DIAGNOSTICS_ENABLED) {
    const diagnostics = attachDiagnostics(wrapper, code, view, source);
    recordDiagnostics = diagnostics.record;
    destroyDiagnostics = diagnostics.destroy;
    recordDiagnostics('attached-panel');
  }
  wrapper.destroy = () => {
    destroyDiagnostics();
    view.destroy();
  };
  wrapper.openSearch = () => openSearchPanel(view);
  return wrapper;
}
