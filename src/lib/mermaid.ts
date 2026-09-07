import mermaid from 'mermaid';

let diagramSequence = 0;
const MAX_DIAGRAMS = 24;
const MAX_DIAGRAM_CHARS = 20_000;
const MAX_TOTAL_DIAGRAM_CHARS = 100_000;
const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 25;

function markFallback(fallback: HTMLElement, message: string): void {
  fallback.classList.add('mermaid-diagram-error');
  fallback.setAttribute('aria-busy', 'false');
  fallback.setAttribute('aria-label', `${message} Mermaid source follows.`);
}

function themeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token('--page'),
    primaryColor: token('--accent-soft'),
    primaryTextColor: token('--ink'),
    primaryBorderColor: token('--accent'),
    secondaryColor: token('--surface'),
    tertiaryColor: token('--surface-strong'),
    lineColor: token('--ink-soft'),
    noteBkgColor: token('--surface'),
    noteTextColor: token('--ink'),
    noteBorderColor: token('--line-strong'),
  };
}

function openDiagramViewer(sourceImage: HTMLImageElement): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'mermaid-lightbox';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', `${sourceImage.alt} zoom viewer`);

  const panel = document.createElement('div');
  panel.className = 'mermaid-lightbox-panel';
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-lightbox-toolbar';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.setAttribute('aria-label', 'Zoom out');
  zoomOut.textContent = '−';
  const resetZoom = document.createElement('button');
  resetZoom.type = 'button';
  resetZoom.setAttribute('aria-live', 'polite');
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomIn.textContent = '+';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close diagram viewer');
  closeButton.textContent = '×';
  toolbar.append(zoomOut, resetZoom, zoomIn, closeButton);

  const viewport = document.createElement('div');
  viewport.className = 'mermaid-lightbox-viewport';
  const image = document.createElement('img');
  image.className = 'mermaid-lightbox-image';
  image.alt = sourceImage.alt;
  image.decoding = 'async';
  image.src = sourceImage.src;
  viewport.append(image);
  panel.append(toolbar, viewport);
  dialog.append(panel);

  let zoom = 100;
  const renderZoom = () => {
    image.style.width = `${zoom}%`;
    resetZoom.textContent = `${zoom}%`;
    resetZoom.setAttribute('aria-label', `Reset zoom to 100%, current zoom ${zoom}%`);
    zoomOut.disabled = zoom === MIN_ZOOM;
    zoomIn.disabled = zoom === MAX_ZOOM;
  };
  const cleanup = () => {
    dialog.remove();
    sourceImage.focus();
  };
  const close = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else cleanup();
  };

  zoomOut.addEventListener('click', () => {
    zoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
    renderZoom();
  });
  resetZoom.addEventListener('click', () => {
    zoom = 100;
    renderZoom();
  });
  zoomIn.addEventListener('click', () => {
    zoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
    renderZoom();
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', cleanup, { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  renderZoom();
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  closeButton.focus();
}

export async function hydrateMermaidDiagrams(
  article: HTMLElement,
  isCurrent: () => boolean,
): Promise<void> {
  const blocks = Array.from(
    article.querySelectorAll<HTMLElement>('pre > code.language-mermaid'),
  );
  if (blocks.length === 0 || !isCurrent()) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_DIAGRAM_CHARS,
    maxEdges: 500,
    logLevel: 'fatal',
    theme: 'base',
    themeVariables: themeVariables(),
    fontFamily: getComputedStyle(document.body).fontFamily,
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'maxEdges',
      'suppressErrorRendering',
      'dompurifyConfig',
      'htmlLabels',
      'fontFamily',
      'altFontFamily',
      'themeCSS',
      'themeVariables',
    ],
  });

  let totalChars = 0;
  for (const [index, code] of blocks.entries()) {
    if (!isCurrent()) return;
    const source = code.textContent ?? '';
    const fallback = code.parentElement;
    if (!fallback) continue;
    if (index >= MAX_DIAGRAMS) {
      markFallback(fallback, 'Document diagram limit reached.');
      break;
    }
    if (
      source.length > MAX_DIAGRAM_CHARS
      || totalChars + source.length > MAX_TOTAL_DIAGRAM_CHARS
    ) {
      markFallback(fallback, 'Diagram is over the local rendering limit.');
      continue;
    }
    totalChars += source.length;
    fallback.setAttribute('aria-busy', 'true');
    try {
      const { svg, diagramType } = await mermaid.render(
        `ffm-mermaid-${++diagramSequence}`,
        source,
      );
      if (!isCurrent()) return;
      const figure = document.createElement('figure');
      figure.className = 'mermaid-diagram';
      const image = document.createElement('img');
      image.className = 'mermaid-diagram-image';
      image.alt = `${diagramType} diagram`;
      image.decoding = 'async';
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-haspopup', 'dialog');
      image.setAttribute('aria-label', `Open ${image.alt} in zoom viewer`);
      image.addEventListener('click', () => openDiagramViewer(image));
      image.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDiagramViewer(image);
      });
      figure.append(image);
      fallback.replaceWith(figure);
    } catch {
      markFallback(fallback, 'Diagram could not be rendered.');
    }
  }
}
