import { test, expect } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

test.describe('Table Gameplay', () => {
  test('should show table page', async ({ page }) => {
    await expectRoute(page, 'table/demo');
  });

  test('should handle invalid table ID gracefully', async ({ page }) => {
    await page.goto('table/nonexistent-table-id');
    await page.waitForTimeout(2000);
    // Should show error or redirect
    await assertRendered(page, 'table/nonexistent-table-id');
  });
});

test.describe('Table Creation', () => {
  test('should show table creation page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/create-table');
  });
});

test.describe('Agent Management', () => {
  test('should show agent management page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/agents');
  });

  test('should show super agent dashboard', async ({ page }) => {
    await expectRoute(page, 'agent-management');
  });
});

test.describe('Settlement', () => {
  test('should show settlement page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/settlement');
  });
});

test.describe('Club Financials', () => {
  test('should show club financials page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/financials');
  });
});

test.describe('Club Settings', () => {
  test('should show club settings page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/settings');
  });
});

test.describe('Cashier', () => {
  test('should show cashier page', async ({ page }) => {
    /* 2026-08-23: 'Table Buy-In' is the CashierPage heading only while
           `action === 'buyin'`. Bare /cashier does not stay put at all — it
           redirects to clubs/<id>/cashier, the club chip desk (Trade / Record /
           Chip Request), which never shows that string. Assert what the route
           actually lands on instead. */
    await expectRoute(page, 'cashier', { expectText: /Cashier/i });
  });
});

test.describe('Bonus', () => {
  test('should show bonus page', async ({ page }) => {
    await expectRoute(page, 'bonuses');
  });
});

test.describe('Report Player Flow', () => {
  test('should show report player page', async ({ page }) => {
    await expectRoute(page, 'report/demo-user');
  });

  test('should show report review page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/reports');
  });
});
