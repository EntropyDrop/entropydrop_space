import { defineConfig } from '@playwright/test';

const port = 4174;
const appPath = '/space/app/';
const appUrl = `http://127.0.0.1:${port}${appPath}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: '../.local/playwright-results',
  timeout: 90_000,
  use: {
    baseURL: appUrl,
    channel: process.env.SPACE_E2E_USE_SYSTEM_CHROME === '1' ? 'chrome' : 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort --base ${appPath}`,
    url: appUrl,
  },
});
