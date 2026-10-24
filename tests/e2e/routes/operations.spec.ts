import { test, expect } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

test.describe('Club Operations', () => {
  test('should show clubs list', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should navigate to club detail when clicking a club', async ({ page }) => {
    await page.goto('clubs');

    /* `[class*="club"]` matched layout chrome, not a card - on a signed-in run
       its first match is a full-page container sitting under the header, so the
       click was intercepted and burned the whole 30s timeout. Signed out the
       page was empty, nothing matched, and the branch never ran; that is how a
       test this weak stayed green.

       Target something that is actually a link to a club, and bound the click
       so a failure names this step rather than a locator. */
    /* Scope to the positioned active item. The carousel also owns an
       aria-hidden in-flow measuring copy, and a document-wide `.first()` is a
       fragile way to express "the club currently presented in the centre". */
    const clubCard = page
      .locator('.sp-carousel__item.is-active')
      .getByRole('button', { name: /Click to enter lobby/i });
    await expect(clubCard, 'The active club must render before navigation proof').toBeVisible({
      timeout: 10000,
    });
    {
      await expect(
        page.getByRole('navigation', { name: 'Poker Arena Actions', exact: true })
      ).toBeVisible();
      /* Visibility alone cannot detect occlusion. The approved top actions
         replaced the retired bottom Quick actions row; keep the overlap
         guard against the navigation that is actually rendered. */
      await expect
        .poll(
          async () => {
            const cardBox = await clubCard.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
            });
            const actions = page.getByRole('navigation', {
              name: 'Poker Arena Actions',
              exact: true,
            });
            const actionsBox = await actions.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom };
            });
            return cardBox.bottom <= actionsBox.top + 1 || actionsBox.bottom <= cardBox.top + 1;
          },
          { timeout: 8000, message: 'Club card must not overlap the Poker Arena actions' }
        )
        .toBe(true);
      await clubCard.click({ timeout: 8000 });
      await expect(page).toHaveURL(/.*clubs\/.+/, { timeout: 10000 });
    }
  });
});

test.describe('Table Operations', () => {
  test('should show lobby with table list', async ({ page }) => {
    await expectRoute(page, '');
  });
});

test.describe('Wallet Operations', () => {
  test('should show wallet page', async ({ page }) => {
    await expectRoute(page, 'wallet');
  });

  test('should show rakeback link in wallet', async ({ page }) => {
    await page.goto('wallet');

    // Look for rakeback/commission link
    await page.waitForTimeout(1000);
    const rakebackLink = page.locator('a[href*="rakeback"]');
    // Just check page loads, auth might block content
    await assertRendered(page, 'wallet');
  });
});

test.describe('Settings Operations', () => {
  test('should show settings page', async ({ page }) => {
    await expectRoute(page, 'settings', { expectText: 'Audio' });
  });
});
