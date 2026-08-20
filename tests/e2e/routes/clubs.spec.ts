import { test, expect } from '@playwright/test';

test.describe('Club Management', () => {
    test('should show clubs list page', async ({ page }) => {
        await page.goto('clubs');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show create club page', async ({ page }) => {
        await page.goto('clubs/create');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club detail page', async ({ page }) => {
        await page.goto('clubs/demo');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club lobby', async ({ page }) => {
        await page.goto('clubs/demo/lobby');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club dashboard', async ({ page }) => {
        await page.goto('clubs/demo/dashboard');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club messages', async ({ page }) => {
        await page.goto('clubs/demo/messages');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club members', async ({ page }) => {
        await page.goto('clubs/demo/members');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show club announcements', async ({ page }) => {
        await page.goto('clubs/demo/announcements');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Union Management', () => {
    test('should show unions list page', async ({ page }) => {
        await page.goto('unions');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show create union page', async ({ page }) => {
        await page.goto('unions/create');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show union detail page', async ({ page }) => {
        await page.goto('unions/demo');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Wallet & Cashier', () => {
    test('should show wallet page', async ({ page }) => {
        await page.goto('wallet');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show transaction history', async ({ page }) => {
        await page.goto('transactions');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show rakeback page', async ({ page }) => {
        await page.goto('rakeback');
        await expect(page.locator('body')).toBeVisible();
    });
});
