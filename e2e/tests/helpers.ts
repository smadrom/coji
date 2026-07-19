/**
 * Shared e2e helpers (Phase 4b).
 *
 * All flows authenticate through the REAL Better Auth sign-up form (the e2e
 * stack runs AUTH_TEST_HEADER=false, so the x-user-id hatch is off and the dev
 * token is not baked into the web image — sign-up must hit the live endpoint).
 * The migrate-step SQL trigger funds every new user with 100000 credits, so a
 * freshly signed-up user can drive the full paid pipeline on Noop.
 */
import { type Page, expect } from '@playwright/test';

/** A unique email per call so runs never collide on the user-email unique index. */
export function uniqueEmail(tag = 'gen'): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export const PASSWORD = 'Test12345!';

/**
 * Sign up a brand-new user through the UI and land on the gallery (`/`).
 * Returns the email used. Asserts the real auth call succeeded (200) — never
 * relies on a dev-token fallback.
 */
export async function signUpNewUser(page: Page, tag = 'gen'): Promise<string> {
  const email = uniqueEmail(tag);
  await page.goto('/');

  // No session → App renders SignInScreen for any route. Switch to sign-up.
  await page.getByRole('button', { name: /sign up/i }).click();

  await page.getByPlaceholder('Email address').fill(email);
  await page.getByPlaceholder('Password').fill(PASSWORD);

  // The real Better Auth sign-up is the double-prefixed path through nginx
  // (BASE_URL ends in /api, callAuth adds /api/auth/... -> /api/api/auth/...).
  const signUp = page.waitForResponse(
    (r) => /\/api\/api\/auth\/sign-up\/email$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /create account/i }).click();
  const resp = await signUp;
  expect(resp.status(), 'real Better Auth sign-up must succeed').toBe(200);

  // Authenticated → gallery is the landing route.
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible();
  return email;
}

/**
 * From the gallery, create a project for `prompt` and start image generation.
 * Returns the new project id (parsed from the /p/:id URL the app navigates to).
 * Does NOT assert pipeline outcome — callers assert red/green as needed.
 */
export async function startGeneration(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('create-new').first().click();
  await expect(page).toHaveURL(/\/new$/);
  await page.getByTestId('prompt-input').fill(prompt);
  await page.getByTestId('generate-button').click();
}

/** Extract the project id from a `/p/:id` URL. */
export function projectIdFromUrl(url: string): string | null {
  const m = url.match(/\/p\/([0-9a-f-]+)/i);
  return m?.[1] ?? null;
}
