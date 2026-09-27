import type { DocumentKind } from '../lib/desktop-bridge';

// FFM's soft corners and rising mint stroke, drawn on a 16px grid.
export function createFileIcon(name: string, kind?: DocumentKind | 'folder'): SVGSVGElement {
  const extension = name.split('.').pop()?.toLowerCase();
  const type = kind ?? ({ md: 'markdown', markdown: 'markdown', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', png: 'image', jpg: 'image',
    jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image',
  } as Record<string, string>)[extension ?? ''] ?? 'text';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  icon.classList.add('ffm-file-icon');
  if (type === 'folder') {
    icon.classList.add('ffm-folder-icon');
    icon.innerHTML = '<path d="M2 5V4a1.5 1.5 0 0 1 1.5-1.5h3L8 4h4.5A1.5 1.5 0 0 1 14 5.5V6"/>'
      + '<path class="ffm-folder-closed" d="M2 5h10.5A1.5 1.5 0 0 1 14 6.5V12a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12Z"/>'
      + '<path class="ffm-folder-open" d="M2 6.5h11.3a.9.9 0 0 1 .9 1.1l-1 4.7a1.5 1.5 0 0 1-1.5 1.2H3.5A1.5 1.5 0 0 1 2 12Z"/>'
      + '<path class="ffm-icon-accent" d="M4.5 10.5c1.4 0 2.1-.5 3-1.5"/>';
    return icon;
  }
  const marks: Record<string, string> = {
    markdown: 'M5.2 7h5.6M5.2 9.5h4M5.2 12h2.4',
    json: 'M6.4 7c-1 0-1 .6-1 1.2v.6L4.6 10l.8.7v.6c0 .6 0 1.2 1 1.2M9.6 7c1 0 1 .6 1 1.2v.6l.8 1.2-.8.7v.6c0 .6 0 1.2-1 1.2',
    image: 'M4.8 11.7 7 9l1.6 1.7 1.2-1 1.4 2M5.3 7h.1',
    yaml: 'M5.2 7h2M6.5 9.5h4M6.5 12h3',
    toml: 'M6.1 7H5v5h1.1M9.9 7H11v5H9.9',
    text: 'M5.2 8h5.6M5.2 10.5h4',
  };
  icon.innerHTML = '<rect x="2.8" y="1.5" width="10.4" height="13" rx="2.4"/>'
    + '<path class="ffm-icon-accent" d="M5.3 4.3c1.5 0 2.4-.2 3.5-1"/>'
    + `<path d="${marks[type] ?? marks.text}"/>`;
  return icon;
}
