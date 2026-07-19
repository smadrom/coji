import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the coji e2e suite (Phase 4a).
 *
 * baseURL = the published origin of the `web` service in docker-compose.e2e.yml
 * (http://localhost:8080). That same origin is the api's BETTER_AUTH_URL, so the
 * browser Origin is accepted by Better Auth and the nginx `/api`-strip is in the
 * real request path (the thing this suite exists to exercise).
 *
 * The stack is brought up out-of-band (docker compose up + health-wait), not by
 * Playwright's webServer — building the prod-like image is too heavy for the
 * per-run lifecycle and CI manages teardown explicitly.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests',
  // e2e flows share a backend; keep them serial for determinism over speed.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
