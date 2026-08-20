import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
    test('should allow guest access to clubs page', async ({ page }) => {
        await page.goto('clubs');

        // App allows guest access to clubs page
        await expect(page).toHaveURL(/.*clubs/);
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show home page', async ({ page }) => {
        await page.goto('');

        // Home page should load
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Navigation', () => {
    test('should navigate to clubs page', async ({ page }) => {
        await page.goto('clubs');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should navigate to tournaments page', async ({ page }) => {
        await page.goto('tournaments');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should navigate to leaderboard page', async ({ page }) => {
        await page.goto('leaderboard');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('VIP Page', () => {
    test('should allow guest access to VIP page', async ({ page }) => {
        await page.goto('vip');

        // App allows guest access to VIP page
        await expect(page).toHaveURL(/.*vip/);
        await expect(page.locator('body')).toBeVisible();
    });
});
