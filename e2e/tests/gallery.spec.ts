/**
 * gallery.spec — the owner's project list and card navigation.
 *
 * Creates several projects for one signed-up user, then asserts the gallery
 * route (`/`) renders a card per project and that clicking a card deep-links to
 * `/p/:id`. Exercises the new GET /projects list end-to-end through nginx.
 */
import { expect, test } from '@playwright/test';
import { signUpNewUser, startGeneration } from './helpers.ts';

test('Gallery: multiple projects render as cards; clicking a card opens /p/:id', async ({
  page,
}) => {
  await signUpNewUser(page, 'gallery');

  const prompts = [
    'A neon city street at night, rain reflections',
    'A cozy cabin in a snowy forest, warm light',
    'A spaceship cockpit over a ringed planet',
  ];

  const projectIds: string[] = [];
  for (const prompt of prompts) {
    await startGeneration(page, prompt);
    // Each create navigates to /p/:id once generate-images is accepted.
    await expect(page).toHaveURL(/\/p\/[0-9a-f-]+/i, { timeout: 20_000 });
    const id = page.url().match(/\/p\/([0-9a-f-]+)/i)?.[1];
    expect(id, 'project id in URL').toBeTruthy();
    if (id) projectIds.push(id);
    // Back to the gallery to create the next one.
    await page.getByTestId('back-to-gallery').click();
    await expect(page).toHaveURL(/\/$/);
  }

  // Gallery shows one card per created project.
  await expect(page.getByTestId('gallery-card')).toHaveCount(prompts.length, { timeout: 15_000 });

  // Each created project id is present as a card.
  for (const id of projectIds) {
    await expect(
      page.locator(`[data-testid="gallery-card"][data-project-id="${id}"]`),
    ).toBeVisible();
  }

  // Clicking a card deep-links to that project.
  const firstId = projectIds[0];
  await page.locator(`[data-testid="gallery-card"][data-project-id="${firstId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/p/${firstId}`, 'i'));
});
