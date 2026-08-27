import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  webServer: {
    command: 'pnpm dev',
    port: 1420,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://127.0.0.1:1420',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
});
