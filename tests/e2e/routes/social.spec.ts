import { test, expect } from '@playwright/test';

test.describe('Social Features', () => {
    test('should show friends page', async ({ page }) => {
        await page.goto('friends');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show messages page', async ({ page }) => {
        await page.goto('messages');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show notifications page', async ({ page }) => {
        await page.goto('notifications');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('VIP Features', () => {
    test('should show VIP page', async ({ page }) => {
        await page.goto('vip');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show rakeback page', async ({ page }) => {
        await page.goto('rakeback');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show bonus page', async ({ page }) => {
        await page.goto('bonus');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('User Profile', () => {
    test('should show profile page', async ({ page }) => {
        await page.goto('profile');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show settings page', async ({ page }) => {
        await page.goto('settings');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show achievements page', async ({ page }) => {
        await page.goto('achievements');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show player stats page', async ({ page }) => {
        await page.goto('stats');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Search & Discovery', () => {
    test('should show search page', async ({ page }) => {
        await page.goto('search');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show invite page', async ({ page }) => {
        await page.goto('invite');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Help & Support', () => {
    test('should show help page', async ({ page }) => {
        await page.goto('help');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('404 Handling', () => {
    test('should handle non-existent routes gracefully', async ({ page }) => {
        await page.goto('non-existent-page-12345');
        await expect(page.locator('body')).toBeVisible();
        // Should show some kind of error or redirect
    });
});
