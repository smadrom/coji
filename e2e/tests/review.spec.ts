/**
 * review.spec — deep-link re-view and the auth gate.
 *
 *  1. A signed-up user creates a project, hard-reloads `/p/:id`, and the project
 *     re-loads from fresh state (deep-link safe; not a blank screen).
 *  2. A visitor with NO session hitting `/p/:id` directly sees SignIn (the App
 *     auth gate renders SignInScreen for any route without a session), never a
 *     blank screen.
 */
import { expect, test } from '@playwright/test';
import { signUpNewUser, startGeneration } from './helpers.ts';

test('Review: deep-link /p/:id re-loads a past project after a hard reload', async ({ page }) => {
  await signUpNewUser(page, 'review');

  await startGeneration(page, 'A lighthouse on a cliff during a storm');
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+/i, { timeout: 20_000 });
  const id = page.url().match(/\/p\/([0-9a-f-]+)/i)?.[1];
  expect(id).toBeTruthy();

  // Hard reload the deep link — session rehydrates from localStorage, the
  // project re-fetches, and the back link is present (not a blank screen).
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/p/${id}`, 'i'));
  await expect(page.getByTestId('back-to-gallery')).toBeVisible({ timeout: 20_000 });
  // It is the SAME project: either still generating or already at the preview
  // gate — both are valid re-view states, but it must NOT be the sign-in screen.
  await expect(page.getByRole('heading', { name: /sign in|create account/i })).toHaveCount(0);
});

test('Review: direct /p/:id with no session shows SignIn (deep-link auth gate)', async ({
  page,
  context,
}) => {
  // Ensure a clean, sessionless browser context.
  await context.clearCookies();
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());

  // Deep-link to a project route while unauthenticated.
  await page.goto('/p/00000000-0000-0000-0000-000000000000');

  // Auth gate renders SignInScreen for any route — sign-in form, not a blank
  // page and not a project view.
  await expect(page.getByRole('heading', { name: /^sign in$/i })).toBeVisible();
  await expect(page.getByPlaceholder('Email address')).toBeVisible();
  await expect(page.getByTestId('back-to-gallery')).toHaveCount(0);
});
