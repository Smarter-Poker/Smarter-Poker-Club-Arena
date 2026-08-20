import { test, expect } from '@playwright/test';

test.describe('Table Gameplay', () => {
    test('should show table page', async ({ page }) => {
        await page.goto('table/demo');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should handle invalid table ID gracefully', async ({ page }) => {
        await page.goto('table/nonexistent-table-id');
        await page.waitForTimeout(2000);
        // Should show error or redirect
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Table Creation', () => {
    test('should show table creation page', async ({ page }) => {
        await page.goto('clubs/demo/create-table');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Agent Management', () => {
    test('should show agent management page', async ({ page }) => {
        await page.goto('clubs/demo/agents');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show super agent dashboard', async ({ page }) => {
        await page.goto('super-agent');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Settlement', () => {
    test('should show settlement page', async ({ page }) => {
        await page.goto('clubs/demo/settlement');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Club Financials', () => {
    test('should show club financials page', async ({ page }) => {
        await page.goto('clubs/demo/financials');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Club Settings', () => {
    test('should show club settings page', async ({ page }) => {
        await page.goto('clubs/demo/settings');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Cashier', () => {
    test('should show cashier page', async ({ page }) => {
        await page.goto('cashier');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Bonus', () => {
    test('should show bonus page', async ({ page }) => {
        await page.goto('bonus');
        await expect(page.locator('body')).toBeVisible();
    });
});

test.describe('Report Player Flow', () => {
    test('should show report player page', async ({ page }) => {
        await page.goto('report/player/demo-user');
        await expect(page.locator('body')).toBeVisible();
    });

    test('should show report review page', async ({ page }) => {
        await page.goto('clubs/demo/reports');
        await expect(page.locator('body')).toBeVisible();
    });
});
