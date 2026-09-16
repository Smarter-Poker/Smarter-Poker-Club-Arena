import { test, expect, type Page } from '@playwright/test';
import { expectRoute } from './utils';

async function expectUnionAccessDecision(page: Page, path: string): Promise<boolean> {
  const rendered = await expectRoute(page, path);
  if (!rendered) return false;

  if (/\/community(?:[/?#]|$)/.test(page.url())) {
    await expect(page.getByRole('heading', { name: 'Community Center' })).toBeVisible({
      timeout: 15_000,
    });
    return false;
  }

  const escapedPath = path.replace(/\//g, '\\/');
  await expect(page).toHaveURL(new RegExp(`${escapedPath}(?:[/?#]|$)`));
  return true;
}

test.describe('Club Management', () => {
  test('should show clubs list page', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should show create club page', async ({ page }) => {
    await page.goto('clubs/create');
    await page.waitForLoadState('domcontentloaded');
    const createClubDialog = page.getByRole('dialog', { name: 'Create A Club' });
    await expect
      .poll(async () => page.url().includes('/auth') || (await createClubDialog.isVisible()), {
        timeout: 15000,
      })
      .toBe(true);
    if (page.url().includes('/auth')) test.skip();
    await expect(createClubDialog).toBeVisible({ timeout: 15000 });
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
    const allowed = await expectUnionAccessDecision(page, 'unions');
    if (allowed) await expect(page.getByText('Union Command').first()).toBeVisible();
  });

  test('should show create union page', async ({ page }) => {
    const rendered = await expectRoute(page, 'unions/create');
    if (!rendered) return;

    const deniedHeading = page.getByRole('heading', { name: 'Community Center' });
    const creationHeading = page.getByText(/^(?:Forge A Union|Create A Club First)$/).first();
    // The guard resolves asynchronously. An initial create URL does not prove
    // that authorization has settled, and a heading alone does not prove routing.
    await expect
      .poll(
        async () => {
          if (/\/community(?:[/?#]|$)/.test(page.url()) && (await deniedHeading.isVisible())) {
            return true;
          }
          return (
            /\/unions\/create(?:[/?#]|$)/.test(page.url()) && (await creationHeading.isVisible())
          );
        },
        { timeout: 15000 }
      )
      .toBe(true);

    if (/\/community(?:[/?#]|$)/.test(page.url())) {
      await expect(page).toHaveURL(/\/community(?:[/?#]|$)/);
      await expect(deniedHeading).toBeVisible();
      return;
    }
    await expect(page).toHaveURL(/\/unions\/create(?:[/?#]|$)/);

    await expect(
      creationHeading,
      'union creation should render either the forge or its club-ownership prerequisite'
    ).toBeVisible({ timeout: 15000 });
  });

  test('should show union detail page', async ({ page }) => {
    await expectUnionAccessDecision(page, 'unions/demo');
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
