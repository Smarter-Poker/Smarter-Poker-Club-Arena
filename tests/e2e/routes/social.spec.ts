import { test, expect } from '@playwright/test';
import { expectMessengerHandoff, expectRoute } from './utils';

test.describe('Social Features', () => {
  test('should show friends page', async ({ page }) => {
    await expectRoute(page, 'friends');
  });

  test('should show messages page', async ({ page }) => {
    await expectMessengerHandoff(page);
  });

  test('should show notifications page', async ({ page }) => {
    await expectRoute(page, 'notifications');
  });
});

test.describe('VIP Features', () => {
  test('should show VIP page', async ({ page }) => {
    await expectRoute(page, 'vip', { expectText: 'VIP Rewards' });
  });

  test('should show rakeback page', async ({ page }) => {
    await expectRoute(page, 'rakeback');
  });

  test('should show bonus page', async ({ page }) => {
    await expectRoute(page, 'bonuses');
  });
});

test.describe('User Profile', () => {
  test('should show profile page', async ({ page }) => {
    await expectRoute(page, 'profile');
  });

  test('should show settings page', async ({ page }) => {
    await expectRoute(page, 'settings', { expectText: 'Audio' });
  });

  test('should show achievements page', async ({ page }) => {
    await expectRoute(page, 'achievements', { expectText: 'Daily Login Streak' });
  });

  test('should show player stats page', async ({ page }) => {
    await expectRoute(page, 'stats');
  });
});

test.describe('Search & Discovery', () => {
  test('should show search page', async ({ page }) => {
    await expectRoute(page, 'search', { expectText: 'Recent Searches' });
  });

  test('should show invite page', async ({ page }) => {
    await expectRoute(page, 'invite');
  });
});

test.describe('Help & Support', () => {
  test('should show help page', async ({ page }) => {
    /* 2026-08-23: 'Still need help?' never existed in HelpPage.tsx (see the
           identical fix in routes/features.spec.ts). Verified in production. */
    await expectRoute(page, 'help', { expectText: 'Help Center' });
  });
});

test.describe('404 Handling', () => {
  test('should handle non-existent routes gracefully', async ({ page }) => {
    /* The one test in this directory that WANTS the catch-all, so it
           asserts the opposite of expectRoute. It used to say only
           `expect(body).toBeVisible()` with the comment "Should show some kind
           of error or redirect" — which passed whether the 404 rendered, the
           app crashed, or nothing rendered at all. */
    await page.goto('non-existent-page-12345');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    test.skip(page.url().includes('/auth'), 'signed out — nothing to assert');

    await expect(page.locator('#root')).toBeAttached({ timeout: 15000 });
    await expect(
      page.getByText('This Arena Door Is Closed').first(),
      'an unknown route must render the catch-all, not a blank page'
    ).toBeVisible({ timeout: 15000 });
  });
});
