import { json, jsonLanguage } from '@codemirror/lang-json';
import {
  foldGutter,
  foldKeymap,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

const PAGE_SIZE = 100;
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

export interface JsonCodeViewElement extends HTMLElement {
  destroy(): void;
}

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--json-key)' },
  { tag: tags.string, color: 'var(--json-string)' },
  { tag: tags.number, color: 'var(--json-number)' },
  { tag: tags.bool, color: 'var(--json-boolean)' },
  { tag: tags.null, color: 'var(--json-null)' },
]);

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

function createOutline(
  view: EditorView,
  source: string,
  syntaxRoot: JsonSyntaxNode,
): HTMLElement {
  const outline = document.createElement('nav');
  outline.className = 'json-outline';
  outline.setAttribute('role', 'tree');
  outline.setAttribute('aria-label', 'JSON keys');

  const root = syntaxRoot.firstChild;
  if (!root || !isExpandable(root)) return outline;

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
  return outline;
}

export function createJsonCodeView(source: string): JsonCodeViewElement {
  const wrapper = document.createElement('section') as JsonCodeViewElement;
  wrapper.className = 'json-code-view';

  const code = document.createElement('div');
  code.className = 'json-code-editor';

  const state = EditorState.create({
    doc: source,
    extensions: [
      json(),
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({ 'aria-readonly': 'true' }),
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      search({ top: true }),
      keymap.of([...searchKeymap, ...foldKeymap]),
      syntaxHighlighting(jsonHighlightStyle),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-content': { caretColor: 'transparent' },
      }),
    ],
  });
  const view = new EditorView({ state, parent: code });

  // ponytail: full parse gives the outline stable offsets; revisit only if profiling says it matters.
  const outlineTree = jsonLanguage.parser.parse(source);
  wrapper.append(createOutline(view, source, outlineTree.topNode), code);
  wrapper.destroy = () => view.destroy();
  return wrapper;
}
