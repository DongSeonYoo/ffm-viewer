import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import capabilities from '../../src-tauri/capabilities/default.json';
import betaConfig from '../../src-tauri/tauri.beta.conf.json';
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
      'dialog:allow-open',
      'dialog:allow-save',
      'dialog:allow-message',
      'opener:allow-open-url',
    ]);
  });

  it('keeps production, beta, and dev as separate app channels', () => {
    expect([
      [tauriConfig.productName, tauriConfig.identifier],
      [betaConfig.productName, betaConfig.identifier],
      [devConfig.productName, devConfig.identifier],
    ]).toEqual([
      ['FFM Viewer', 'io.github.dongseonyoo.ffm-viewer'],
      ['FFM_beta', 'io.github.dongseonyoo.ffm-viewer.beta'],
      ['FFM_dev', 'io.github.dongseonyoo.ffm-viewer.dev'],
    ]);
    expect(tauriConfig.app.windows[0]?.devtools).toBe(false);
    expect(betaConfig.app.windows[0]?.devtools).toBe(false);
  });
});
