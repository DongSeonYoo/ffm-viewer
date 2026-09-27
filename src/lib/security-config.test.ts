import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import capabilities from '../../src-tauri/capabilities/default.json';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import devConfig from '../../src-tauri/tauri.dev.conf.json';

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

  it('grants only the window and dialog permissions the shell needs', () => {
    expect(capabilities.permissions).toEqual([
      'core:default',
      'core:window:allow-close',
      'core:window:allow-hide',
      'core:window:allow-start-dragging',
      'dialog:allow-open',
      'dialog:allow-save',
      'dialog:allow-message',
      'opener:allow-open-url',
    ]);
  });

  it('keeps the public app and diagnostics-enabled dev app separate', () => {
    expect([
      [tauriConfig.productName, tauriConfig.identifier],
      [devConfig.productName, devConfig.identifier],
    ]).toEqual([
      ['FFM Viewer', 'io.github.dongseonyoo.ffm-viewer'],
      ['FFM_dev', 'io.github.dongseonyoo.ffm-viewer.dev'],
    ]);
    expect(tauriConfig.app.windows[0]?.devtools).toBe(false);
    for (const config of [tauriConfig, devConfig]) {
      expect(config.app.windows[0]?.titleBarStyle).toBe('Overlay');
      expect(config.app.windows[0]?.hiddenTitle).toBe(true);
    }
  });
});
