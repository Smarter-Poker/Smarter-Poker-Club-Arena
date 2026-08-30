import { test, expect } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

test.describe('Authentication Flow', () => {
  test('should allow guest access to clubs page', async ({ page }) => {
    await page.goto('clubs');

    // App allows guest access to clubs page
    await expect(page).toHaveURL(/.*clubs/);
    await assertRendered(page, 'clubs');
  });

  test('should show home page', async ({ page }) => {
    await page.goto('');

    // Home page should load
    await assertRendered(page, '');
  });
});

test.describe('Navigation', () => {
  test('should navigate to play overview', async ({ page }) => {
    await expectRoute(page, 'play', { expectText: 'Play & Review' });
  });

  test('should navigate to clubs page', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should navigate to tournaments page', async ({ page }) => {
    await expectRoute(page, 'tournaments');
  });

  test('should navigate to leaderboard page', async ({ page }) => {
    await expectRoute(page, 'leaderboard');
  });

  test('should navigate to community overview', async ({ page }) => {
    await expectRoute(page, 'community', { expectText: 'Community Center' });
  });

  test('should navigate to rewards overview', async ({ page }) => {
    await expectRoute(page, 'rewards', { expectText: 'Rewards Center' });
  });
});

test.describe('VIP Page', () => {
  test('should allow guest access to VIP page', async ({ page }) => {
    await page.goto('vip');

    // App allows guest access to VIP page
    await expect(page).toHaveURL(/.*vip/);
    await assertRendered(page, 'vip');
  });
});
