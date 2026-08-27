import {
  getJsonChildren,
  type JsonNode,
  type JsonPrimitive,
} from '../lib/json-document';

const PAGE_SIZE = 100;

function isContainer(node: JsonNode): boolean {
  return node.kind === 'array' || node.kind === 'object';
}

function createButton(action: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  return button;
}

function renderPrimitive(value: JsonPrimitive): HTMLSpanElement {
  const element = document.createElement('span');
  const kind = value === null ? 'null' : typeof value;
  element.className = `json-value json-${kind}`;
  element.textContent = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return element;
}

function renderKey(key: string | number | undefined): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = 'json-key';
  if (typeof key === 'number') {
    element.textContent = String(key);
    element.dataset.index = 'true';
  } else if (typeof key === 'string') {
    element.textContent = JSON.stringify(key);
  } else {
    element.textContent = '$';
    element.classList.add('json-root-label');
  }
  return element;
}

function renderNode(node: JsonNode, expandedByDefault = false): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'json-node';
  wrapper.dataset.jsonNode = '';
  wrapper.dataset.path = node.path;

  const row = document.createElement('div');
  row.className = 'json-row';
  wrapper.append(row);

  let expanded = expandedByDefault;
  let nextOffset = 0;
  let childrenElement: HTMLDivElement | undefined;

  const toggle = createButton('toggle', expanded ? 'Collapse value' : 'Expand value');
  toggle.className = 'json-toggle';
  if (isContainer(node)) {
    toggle.textContent = '›';
    toggle.setAttribute('aria-expanded', String(expanded));
  } else {
    toggle.disabled = true;
    toggle.tabIndex = -1;
    toggle.setAttribute('aria-hidden', 'true');
  }
  row.append(toggle, renderKey(node.key));

  if (node.key !== undefined) {
    const colon = document.createElement('span');
    colon.className = 'json-punctuation';
    colon.textContent = ':';
    row.append(colon);
  }

  if (isContainer(node)) {
    const summary = document.createElement('span');
    summary.className = 'json-summary';
    summary.textContent = node.kind === 'array'
      ? `Array(${node.childCount})`
      : `${node.childCount} ${node.childCount === 1 ? 'key' : 'keys'}`;
    row.append(summary);
  } else {
    row.append(renderPrimitive(node.value as JsonPrimitive));
  }

  const copyPath = createButton('copy-path', `Copy path ${node.path}`);
  copyPath.className = 'json-copy-path';
  copyPath.textContent = node.path;
  copyPath.addEventListener('click', () => {
    void navigator.clipboard.writeText(node.path);
  });
  row.append(copyPath);

  const appendPage = () => {
    if (!childrenElement) return;
    childrenElement.querySelector('[data-action="more"]')?.remove();
    const page = getJsonChildren(node, nextOffset, PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    page.items.forEach((child) => fragment.append(renderNode(child)));
    nextOffset = page.nextOffset;
    childrenElement.append(fragment);

    if (page.hasMore) {
      const more = createButton(
        'more',
        `Show ${node.childCount - nextOffset} more values`,
      );
      more.className = 'json-more';
      more.textContent = `Show ${node.childCount - nextOffset} more`;
      more.addEventListener('click', appendPage);
      childrenElement.append(more);
    }
  };

  const expand = () => {
    if (!isContainer(node)) return;
    if (!childrenElement) {
      childrenElement = document.createElement('div');
      childrenElement.className = 'json-children';
      wrapper.append(childrenElement);
      appendPage();
    }
    childrenElement.hidden = false;
    expanded = true;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Collapse value');
    wrapper.classList.add('is-expanded');
  };

  const collapse = () => {
    if (!childrenElement) return;
    childrenElement.hidden = true;
    expanded = false;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Expand value');
    wrapper.classList.remove('is-expanded');
  };

  toggle.addEventListener('click', () => {
    if (expanded) collapse();
    else expand();
  });

  if (expanded) expand();
  return wrapper;
}

export function createJsonTree(root: JsonNode): HTMLElement {
  const tree = document.createElement('section');
  tree.className = 'json-tree';
  tree.setAttribute('aria-label', 'JSON document');
  tree.append(renderNode(root, true));
  return tree;
}

