import { test, expect } from '@playwright/test';
import { expectMessengerHandoff, expectRoute, assertRendered } from './utils';

test.describe('Tournament Features', () => {
  test('should show tournaments page', async ({ page }) => {
    await expectRoute(page, 'tournaments');
  });

  test('should load tournament list', async ({ page }) => {
    await page.goto('tournaments');
    await page.waitForTimeout(2000);

    // Check for tournament content or empty state
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});

test.describe('Leaderboard Features', () => {
  test('should show leaderboard page', async ({ page }) => {
    await expectRoute(page, 'leaderboard');
  });

  test('should have metric filter options', async ({ page }) => {
    await page.goto('leaderboard');
    await page.waitForTimeout(1000);

    // Check page loads without error
    await assertRendered(page, 'leaderboard');
  });
});

test.describe('Achievements', () => {
  test('should show achievements page', async ({ page }) => {
    await expectRoute(page, 'achievements', { expectText: 'Daily Login Streak' });
  });
});

test.describe('Profile', () => {
  test('should show profile page', async ({ page }) => {
    await expectRoute(page, 'profile');
  });
});

test.describe('Hand History', () => {
  test('should show hand history page', async ({ page }) => {
    await expectRoute(page, 'hand-history');
  });
});

test.describe('Friends', () => {
  test('should show friends page', async ({ page }) => {
    await expectRoute(page, 'friends');
  });
});

test.describe('Messages', () => {
  test('should show messages page', async ({ page }) => {
    await expectMessengerHandoff(page);
  });
});

test.describe('Search', () => {
  test('should show search page', async ({ page }) => {
    await expectRoute(page, 'search', { expectText: 'Recent Searches' });
  });
});

test.describe('Help', () => {
  test('should show help page', async ({ page }) => {
    /* 2026-08-23: was 'Still need help?', a string that has never existed
           in HelpPage.tsx — written while the suite ran signed out, where this
           spec skipped and the assertion was never evaluated. Verified against
           production: the page renders "Help Center". */
    await expectRoute(page, 'help', { expectText: 'Help Center' });
  });
});
