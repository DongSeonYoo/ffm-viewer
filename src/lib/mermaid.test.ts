import mermaid from 'mermaid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateMermaidDiagrams } from './mermaid';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

function articleWith(source: string): HTMLElement {
  const article = document.createElement('article');
  article.innerHTML = `<pre><code class="language-mermaid">${source}</code></pre>`;
  document.body.append(article);
  return article;
}

async function renderDiagram(): Promise<HTMLImageElement> {
  const article = articleWith('flowchart LR\nA --&gt; B');
  vi.mocked(mermaid.render).mockResolvedValue({
    svg: '<svg viewBox="0 0 10 10"><text>safe</text></svg>',
    diagramType: 'flowchart-v2',
  });
  await hydrateMermaidDiagrams(article, () => true);
  return article.querySelector<HTMLImageElement>('.mermaid-diagram-image')!;
}

describe('hydrateMermaidDiagrams', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('renders Mermaid output as an inert local SVG image', async () => {
    const article = articleWith('flowchart LR\nA --&gt; B');
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg viewBox="0 0 10 10"><text>safe</text></svg>',
      diagramType: 'flowchart-v2',
    });

    await hydrateMermaidDiagrams(article, () => true);

    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
    }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^ffm-mermaid-/),
      'flowchart LR\nA --> B');
    const image = article.querySelector<HTMLImageElement>('.mermaid-diagram-image');
    expect(image?.alt).toBe('flowchart-v2 diagram');
    expect(decodeURIComponent(image?.getAttribute('src')?.split(',')[1] ?? ''))
      .toContain('<svg viewBox="0 0 10 10">');
  });

  it('opens the inert diagram image in a keyboard-accessible zoom dialog', async () => {
    const image = await renderDiagram();

    expect(image.tabIndex).toBe(0);
    expect(image.getAttribute('role')).toBe('button');
    expect(image.getAttribute('aria-haspopup')).toBe('dialog');
    image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const dialog = document.querySelector<HTMLDialogElement>('dialog.mermaid-lightbox')!;
    const dialogImage = dialog.querySelector<HTMLImageElement>('.mermaid-lightbox-image')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('flowchart-v2 diagram zoom viewer');
    expect(dialogImage.src).toBe(image.src);
    expect(document.activeElement).toBe(
      dialog.querySelector('[aria-label="Close diagram viewer"]'),
    );
  });

  it('zooms from 50% to 300% in 25% steps and resets to 100%', async () => {
    const image = await renderDiagram();
    image.click();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.mermaid-lightbox')!;
    const dialogImage = dialog.querySelector<HTMLImageElement>('.mermaid-lightbox-image')!;
    const zoomOut = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!;
    const reset = dialog.querySelector<HTMLButtonElement>('[aria-label^="Reset zoom"]')!;
    const zoomIn = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;

    expect(dialogImage.style.width).toBe('100%');
    zoomOut.click();
    expect(dialogImage.style.width).toBe('75%');
    expect(reset.getAttribute('aria-label')).toContain('current zoom 75%');
    for (let index = 0; index < 10; index += 1) zoomOut.click();
    expect(dialogImage.style.width).toBe('50%');
    expect(zoomOut.disabled).toBe(true);

    reset.click();
    expect(dialogImage.style.width).toBe('100%');
    expect(reset.textContent).toBe('100%');
    for (let index = 0; index < 10; index += 1) zoomIn.click();
    expect(dialogImage.style.width).toBe('300%');
    expect(zoomIn.disabled).toBe(true);
  });

  it('closes from its button or backdrop and removes itself after native close', async () => {
    const image = await renderDiagram();
    image.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Close diagram viewer"]')!.click();
    expect(document.querySelector('dialog.mermaid-lightbox')).toBeNull();
    expect(document.activeElement).toBe(image);

    image.click();
    document.querySelector<HTMLDialogElement>('dialog.mermaid-lightbox')!.click();
    expect(document.querySelector('dialog.mermaid-lightbox')).toBeNull();

    image.click();
    document.querySelector<HTMLDialogElement>('dialog.mermaid-lightbox')!
      .dispatchEvent(new Event('close'));
    expect(document.querySelector('dialog.mermaid-lightbox')).toBeNull();
  });

  it('keeps source visible when one diagram cannot be rendered', async () => {
    const article = articleWith('broken');
    vi.mocked(mermaid.render).mockRejectedValue(new Error('syntax error'));

    await hydrateMermaidDiagrams(article, () => true);

    expect(article.querySelector('pre')?.textContent).toBe('broken');
    expect(article.querySelector('pre')?.classList.contains('mermaid-diagram-error')).toBe(true);
  });

  it('does not commit a completed render into a stale article', async () => {
    const article = articleWith('flowchart LR\nA --&gt; B');
    let finish!: (result: Awaited<ReturnType<typeof mermaid.render>>) => void;
    vi.mocked(mermaid.render).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    let current = true;
    const hydration = hydrateMermaidDiagrams(article, () => current);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    current = false;
    finish({ svg: '<svg></svg>', diagramType: 'flowchart-v2' });

    await hydration;

    expect(article.querySelector('pre')).not.toBeNull();
    expect(article.querySelector('.mermaid-diagram')).toBeNull();
  });

  it('leaves excessive Mermaid work as source instead of blocking the UI', async () => {
    const article = document.createElement('article');
    const source = 'x'.repeat(18_000);
    article.innerHTML = Array.from(
      { length: 6 },
      () => `<pre><code class="language-mermaid">${source}</code></pre>`,
    ).join('');
    document.body.append(article);
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg></svg>',
      diagramType: 'flowchart-v2',
    });

    await hydrateMermaidDiagrams(article, () => true);

    expect(mermaid.render).toHaveBeenCalledTimes(5);
    expect(article.querySelector('pre.mermaid-diagram-error')?.getAttribute('aria-label'))
      .toContain('over the local rendering limit');
  });

  it('caps the number of diagrams rendered from one document', async () => {
    const article = document.createElement('article');
    article.innerHTML = Array.from(
      { length: 25 },
      (_, index) => `<pre><code class="language-mermaid">flowchart LR\nA${index} --&gt; B</code></pre>`,
    ).join('');
    document.body.append(article);
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg></svg>',
      diagramType: 'flowchart-v2',
    });

    await hydrateMermaidDiagrams(article, () => true);

    expect(mermaid.render).toHaveBeenCalledTimes(24);
    expect(article.querySelector('pre.mermaid-diagram-error')?.getAttribute('aria-label'))
      .toContain('Document diagram limit reached');
  });
});
