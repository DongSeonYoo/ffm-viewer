import type { DesktopBridge, FolderListing } from '../lib/desktop-bridge';
import { createFileIcon } from './file-icon';

const PAGE_SIZE = 100;

export function createFolderTree(
  bridge: DesktopBridge,
  openFile: (path: string) => void,
) {
  const element = document.createElement('div');
  element.className = 'folder-tree';
  const roots = new Map<string, HTMLDetailsElement>();
  let activePath = '';

  const select = (path: string) => {
    activePath = path;
    for (const button of element.querySelectorAll<HTMLButtonElement>('[data-folder-file]')) {
      if (button.dataset.folderFile === path) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };

  function renderEntries(listing: FolderListing, container: HTMLElement) {
    container.replaceChildren();
    if (!listing.entries.length) { container.textContent = 'Empty folder'; return; }
    let offset = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'folder-file folder-more';
    const appendPage = () => {
      more.remove();
      const end = Math.min(offset + PAGE_SIZE, listing.entries.length);
      for (const entry of listing.entries.slice(offset, end)) {
        if (entry.directory) {
          container.append(folder(entry.path, entry.name));
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'folder-file';
          button.dataset.folderFile = entry.path;
          const label = document.createElement('span');
          label.className = 'folder-entry-name';
          label.textContent = entry.name;
          button.append(createFileIcon(entry.name), label);
          button.title = entry.supported ? entry.path : `${entry.name} — unsupported file`;
          button.disabled = !entry.supported;
          button.addEventListener('click', () => openFile(entry.path));
          container.append(button);
        }
      }
      offset = end;
      if (offset < listing.entries.length) {
        more.textContent = `Show more (${listing.entries.length - offset} remaining)`;
        container.append(more);
      }
      select(activePath);
    };
    more.addEventListener('click', appendPage);
    appendPage();
  }

  function folder(path: string, name: string, initial?: FolderListing) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const chevron = document.createElement('span');
    chevron.className = 'folder-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'folder-entry-name';
    label.textContent = name;
    summary.append(chevron, createFileIcon(name, 'folder'), label);
    summary.title = path;
    const children = document.createElement('div');
    children.className = 'folder-children';
    details.append(summary, children);
    let loading = false;
    let loaded = Boolean(initial);
    if (initial) {
      details.open = true;
      renderEntries(initial, children);
    }
    details.addEventListener('toggle', async () => {
      if (!details.open) {
        children.replaceChildren();
        loaded = false;
        return;
      }
      if (loaded || loading) return;
      loading = true;
      children.textContent = 'Loading…';
      children.setAttribute('aria-busy', 'true');
      try {
        const listing = await bridge.readDirectory(path);
        if (!details.open || !details.isConnected) return;
        if (!listing) throw new Error('This folder no longer exists.');
        renderEntries(listing, children);
        loaded = true;
      } catch (error) {
        if (details.open) children.textContent = `${error instanceof Error ? error.message : String(error)} Close and reopen to retry.`;
      } finally {
        loading = false;
        children.removeAttribute('aria-busy');
      }
    });
    return details;
  }

  return {
    element,
    select,
    add(listing: FolderListing) {
      const existing = roots.get(listing.path);
      if (existing) {
        existing.open = true;
        return;
      }
      const details = folder(listing.path, listing.name, listing);
      roots.set(listing.path, details);
      element.append(details);
      select(activePath);
    },
    get size() { return roots.size; },
    get paths() { return [...roots.keys()]; },
  };
}
