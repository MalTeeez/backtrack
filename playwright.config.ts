import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  workers: 1,
  use: { baseURL: 'http://localhost:5175', viewport: { width: 1600, height: 1000 } },
  // Firefox too: the app is used in Gecko browsers (Waterfox)
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1600, height: 1000 } } },
  ],
  webServer: { command: 'bunx vite --port 5175 --strictPort', url: 'http://localhost:5175', reuseExistingServer: true },
});
