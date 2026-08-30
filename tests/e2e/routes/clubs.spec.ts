import { test, expect } from '@playwright/test';
import { expectRoute } from './utils';

test.describe('Club Management', () => {
  test('should show clubs list page', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should show create club page', async ({ page }) => {
    await page.goto('clubs/create');
    await page.waitForLoadState('domcontentloaded');
    if (page.url().includes('/auth')) test.skip();
    await expect(page.getByRole('dialog', { name: 'Create Club' })).toBeVisible({
      timeout: 15000,
    });
  });

  test('should show club detail page', async ({ page }) => {
    await expectRoute(page, 'clubs/demo');
  });

  test('should show club lobby', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/lobby');
  });

  test('should show club dashboard', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/dashboard');
  });

  test('should show club messages', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/messages');
  });

  test('should show club members', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/members');
  });

  test('should show club announcements', async ({ page }) => {
    await expectRoute(page, 'clubs/demo/announcements');
  });
});

test.describe('Union Management', () => {
  test('should show unions list page', async ({ page }) => {
    await expectRoute(page, 'unions', { expectText: 'Union Command' });
  });

  test('should show create union page', async ({ page }) => {
    await expectRoute(page, 'unions/create', { expectText: 'Forge A Union' });
  });

  test('should show union detail page', async ({ page }) => {
    await expectRoute(page, 'unions/demo');
  });
});

test.describe('Wallet & Cashier', () => {
  test('should show wallet page', async ({ page }) => {
    await expectRoute(page, 'wallet');
  });

  test('should show transaction history', async ({ page }) => {
    await expectRoute(page, 'transactions');
  });

  test('should show rakeback page', async ({ page }) => {
    await expectRoute(page, 'rakeback');
  });
});
