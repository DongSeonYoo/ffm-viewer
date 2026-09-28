import { expect, it, vi } from 'vitest';
import { createFolderTree } from './folder-tree';
import type { DesktopBridge, FolderListing } from '../lib/desktop-bridge';

it('pages wide folders and releases their rows when collapsed', async () => {
  const listing: FolderListing = { path: '/folder', name: 'folder', entries: Array.from(
    { length: 250 }, (_, i) => ({ path: `/folder/${i}.md`, name: `${i}.md`, directory: false, supported: true }),
  ) };
  const readDirectory = vi.fn().mockResolvedValue(listing);
  const tree = createFolderTree({ readDirectory } as unknown as DesktopBridge, vi.fn());
  document.body.replaceChildren(tree.element);
  tree.add(listing);
  expect(tree.element.querySelectorAll('[data-folder-file]')).toHaveLength(100);
  tree.element.querySelector<HTMLButtonElement>('.folder-more')!.click();
  expect(tree.element.querySelectorAll('[data-folder-file]')).toHaveLength(200);
  tree.element.querySelector<HTMLButtonElement>('.folder-more')!.click();
  expect(tree.element.querySelectorAll('[data-folder-file]')).toHaveLength(250);
  const details = tree.element.querySelector('details')!;
  details.open = false;
  await vi.waitFor(() => expect(tree.element.querySelectorAll('[data-folder-file]')).toHaveLength(0));
  details.open = true;
  await vi.waitFor(() => expect(tree.element.querySelectorAll('[data-folder-file]')).toHaveLength(100));
  expect(readDirectory).toHaveBeenCalledOnce();
});

it('does not populate a folder closed while its read is pending', async () => {
  let finish!: (listing: FolderListing) => void;
  const readDirectory = vi.fn(() => new Promise<FolderListing>((resolve) => { finish = resolve; }));
  const tree = createFolderTree({ readDirectory } as unknown as DesktopBridge, vi.fn());
  document.body.replaceChildren(tree.element);
  tree.add({ path:'/root', name:'root', entries:[{ path:'/root/sub', name:'sub', directory:true, supported:false }] });
  const sub = tree.element.querySelectorAll('details')[1]!;
  sub.open = true;
  await vi.waitFor(() => expect(readDirectory).toHaveBeenCalledOnce());
  sub.open = false;
  finish({ path:'/root/sub', name:'sub', entries:[{ path:'/root/sub/a.md', name:'a.md', directory:false, supported:true }] });
  await vi.waitFor(() => expect(sub.querySelector('[aria-busy]')).toBeNull());
  expect(sub.querySelector('[data-folder-file]')).toBeNull();
});
