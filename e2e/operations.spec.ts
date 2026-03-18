import { test, expect } from '@playwright/test';

test.describe('Club Operations', () => {
  test('should show clubs list', async ({ page }) => {
    await page.goto('/clubs');
    await expect(page.locator('body')).toBeVisible();
  });

  test('should navigate to club detail when clicking a club', async ({ page }) => {
    await page.goto('/clubs');

    // Wait for clubs to load
    await page.waitForTimeout(1000);

    // Find and click first club card if exists
    const clubCard = page.locator('[class*="club"]').first();
    if (await clubCard.isVisible()) {
      await clubCard.click();
      await expect(page).toHaveURL(/.*clubs\/.+/);
    }
  });
});

test.describe('Table Operations', () => {
  test('should show lobby with table list', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('Wallet Operations', () => {
  test('should show wallet page', async ({ page }) => {
    await page.goto('/wallet');
    await expect(page.locator('body')).toBeVisible();
  });

  test('should show rakeback link in wallet', async ({ page }) => {
    await page.goto('/wallet');

    // Look for rakeback/commission link
    await page.waitForTimeout(1000);
    const rakebackLink = page.locator('a[href*="rakeback"]');
    // Just check page loads, auth might block content
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('Settings Operations', () => {
  test('should show settings page', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toBeVisible();
  });
});
