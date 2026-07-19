/**
 * generate.spec — the browser-only "503" regression, end to end.
 *
 * Root cause (Phase 0): the failure is NOT an HTTP 503. The Eden treaty client
 * cannot consume a relative base (`/api`); pre-fix it builds `https://api/...`,
 * which the browser fails to DNS-resolve (`net::ERR_NAME_NOT_RESOLVED`) and the
 * UI shows a generic "HTTP 503". The fix (apps/web/src/api.ts) qualifies the
 * base with `window.location.origin`. So:
 *
 *   RED  (pre-fix web image): the `POST .../generate-images` treaty request goes
 *        to host `api` and fails — Playwright fires `requestfailed`
 *        (ERR_NAME_NOT_RESOLVED), no response. The UI shows "HTTP 503". 401 is
 *        neither red nor green.
 *   GREEN (post-fix, current code): the SAME click sends
 *        `POST <origin>/api/projects/:id/generate-images` -> 200/202 via
 *        `server: nginx`, and the pipeline reaches 4 frames (Noop deterministic).
 *
 * The suite asserts GREEN by default. Set E2E_EXPECT_RED=1 when running against a
 * pre-fix web build to assert the RED signature instead (proves red→green).
 */
import { expect, test } from '@playwright/test';
import { signUpNewUser, startGeneration } from './helpers.ts';

const EXPECT_RED = process.env.E2E_EXPECT_RED === '1';

// Matches the generate-images call regardless of host (post-fix it's the real
// origin; pre-fix the treaty mis-builds host `api`).
const GENERATE_RE = /\/projects\/[0-9a-f-]+\/generate-images$/i;

test('Generate: sign-up → prompt → generate-images → 4 frames → preview gate', async ({ page }) => {
  // Capture a treaty request that fails by DNS to host `api` (the RED signature).
  const failedToApiHost: string[] = [];
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (GENERATE_RE.test(url)) {
      const err = req.failure()?.errorText ?? '';
      // host `api` (https://api/...) or any resolution failure on this request
      if (/:\/\/api\//.test(url) || /ERR_NAME_NOT_RESOLVED/.test(err)) {
        failedToApiHost.push(`${url} :: ${err}`);
      }
    }
  });

  await signUpNewUser(page, 'generate');

  if (EXPECT_RED) {
    // --- RED phase (pre-fix build) ---
    await startGeneration(page, 'A calm seascape at golden hour, cinematic');
    // The Eden treaty request to host `api` must fail (DNS), and the UI must
    // surface the bogus "HTTP 503". We must NOT silently pass on a 401/other.
    await expect
      .poll(() => failedToApiHost.length, {
        timeout: 20_000,
        message:
          'expected a generate-images request to fail against host `api` (ERR_NAME_NOT_RESOLVED)',
      })
      .toBeGreaterThan(0);
    await expect(page.getByText(/HTTP 503/i)).toBeVisible();
    return;
  }

  // --- GREEN phase (post-fix, current code) ---
  // Assert the SAME request that used to fail now returns 200/202.
  const generateResp = page.waitForResponse(
    (r) => GENERATE_RE.test(r.url()) && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await startGeneration(page, 'A calm seascape at golden hour, cinematic');

  const resp = await generateResp;
  // 401 is explicitly NOT a valid green (would mean auth broke, not the fix).
  expect(resp.status(), 'generate-images must be accepted, not 401/5xx').toBeGreaterThanOrEqual(
    200,
  );
  expect([200, 202]).toContain(resp.status());
  // Reached a real server (not the phantom host `api`).
  expect(
    resp.headers().server ?? '',
    'served by nginx, proving the request reached the stack',
  ).toMatch(/nginx/i);
  // The phantom-host failure must NOT have happened.
  expect(failedToApiHost, 'no generate-images request should fail to host `api`').toEqual([]);

  // App navigates to /p/:id and polls until 4 frames are ready (Noop is fast +
  // deterministic). GeneratingScreen renders one frame-thumb per ready frame.
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+/i, { timeout: 20_000 });
  await expect(page.getByTestId('frame-thumb')).toHaveCount(4, { timeout: 90_000 });

  // Preview gate: once images_ready, ProjectScreen shows PreviewScreen with the
  // three gate actions.
  await expect(page.getByRole('heading', { name: /your frames are ready/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /continue/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /cancel project/i })).toBeVisible();
});
