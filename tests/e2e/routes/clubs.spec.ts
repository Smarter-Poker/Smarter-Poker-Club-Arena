import { test, expect, type Page } from '@playwright/test';
import { expectRoute } from './utils';

async function expectUnionAccessDecision(page: Page, path: string): Promise<boolean> {
  const rendered = await expectRoute(page, path);
  if (!rendered) return false;

  const escapedPath = path.replace(/\//g, '\\/');
  const requestedRoute = new RegExp(`${escapedPath}(?:[/?#]|$)`);
  const allowedContent =
    path === 'unions/create'
      ? page.getByText(/^(?:Forge A Union|Create A Club First)$/).first()
      : page.getByText(path === 'unions' ? 'Union Command' : 'Union Not Found').first();
  const decision: { value: 'pending' | 'allowed' | 'denied' } = { value: 'pending' };
  // A requested URL is not an access decision: the asynchronous allowlist
  // check can still redirect after the generic route shell has rendered.
  await expect
    .poll(
      async () => {
        if (
          /\/community(?:[/?#]|$)/.test(page.url()) &&
          (await page.getByRole('heading', { name: 'Community Center' }).isVisible())
        ) {
          decision.value = 'denied';
        } else if (requestedRoute.test(page.url()) && (await allowedContent.isVisible())) {
          decision.value = 'allowed';
        }
        return decision.value;
      },
      {
        timeout: 15_000,
        message: 'union access must finish with its allowed page or refusal destination',
      }
    )
    .not.toBe('pending');
  if (decision.value === 'denied') return false;
  await expect(page).toHaveURL(requestedRoute);
  await expect(allowedContent).toBeVisible();
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
    const allowed = await expectUnionAccessDecision(page, 'unions/create');
    if (!allowed) return;

    await expect(
      page.getByText(/^(?:Forge A Union|Create A Club First)$/).first(),
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
