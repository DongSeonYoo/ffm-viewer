import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import tauriConfig from '../../src-tauri/tauri.conf.json';

describe('desktop CSP', () => {
  it('keeps inline scripts and styles blocked behind a generated nonce', () => {
    const csp = tauriConfig.app.security.csp;
    const document = new DOMParser().parseFromString(html, 'text/html');
    const nonceSource = document.querySelector('style#ffm-csp-nonce-source');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(nonceSource?.textContent).toContain(':root');
    expect(tauriConfig.app.security).not.toHaveProperty(
      'dangerousDisableAssetCspModification',
      true,
    );
  });

  it('registers every supported document and image extension as a viewer', () => {
    const extensions = tauriConfig.bundle.fileAssociations
      .flatMap((association) => association.ext);

    expect(new Set(extensions)).toEqual(new Set([
      'md', 'markdown', 'json', 'txt', 'yaml', 'yml', 'toml',
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg',
    ]));
  });
});
