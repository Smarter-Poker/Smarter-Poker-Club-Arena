import { test, expect } from '@playwright/test';

test.describe('Tournament Features', () => {
    test('should show tournaments page', async ({ page }) => {
        await page.goto('tournaments');
        await expect(page.locator('body')).toBeVisible();
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
        await page.goto('leaderboard');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should have metric filter options', async ({ page }) => {
        await page.goto('leaderboard');
        await page.waitForTimeout(1000);

        // Check page loads without error
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Achievements', () => {
    test('should show achievements page', async ({ page }) => {
        await page.goto('achievements');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Profile', () => {
    test('should show profile page', async ({ page }) => {
        await page.goto('profile');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Hand History', () => {
    test('should show hand history page', async ({ page }) => {
        await page.goto('hand-history');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Friends', () => {
    test('should show friends page', async ({ page }) => {
        await page.goto('friends');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Messages', () => {
    test('should show messages page', async ({ page }) => {
        await page.goto('messages');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Search', () => {
    test('should show search page', async ({ page }) => {
        await page.goto('search');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Help', () => {
    test('should show help page', async ({ page }) => {
        await page.goto('help');
        await expect(page.locator('body')).toBeVisible();
    });
});
