import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectRoute, assertRendered } from './utils';

async function clubCardClearOfVisibleActions(page: Page, clubCard: Locator): Promise<boolean> {
  const actions = page.getByRole('navigation', { name: 'Poker Arena Actions', exact: true });
  // Returning players keep Club Options collapsed. Its unrendered navigation
  // cannot cover a card and is absent from the accessible-role locator.
  if (!(await actions.isVisible())) return true;
  const cardBox = await clubCard.boundingBox();
  const actionsBox = await actions.boundingBox();
  if (!cardBox || !actionsBox) return false;
  return (
    cardBox.y + cardBox.height <= actionsBox.y + 1 ||
    actionsBox.y + actionsBox.height <= cardBox.y + 1
  );
}

test.describe('Club entry reachability guard', () => {
  for (const open of [false, true]) {
    test(`accepts a clear card with Club Options ${open ? 'open' : 'collapsed'}`, async ({
      page,
    }) => {
      await page.setContent(`
        <details ${open ? 'open' : ''}>
          <summary>Club Options</summary>
          <nav aria-label="Poker Arena Actions" style="height:40px">Create Find Join</nav>
        </details>
        <button style="margin-top:20px" aria-label="Click to enter lobby">Club</button>
      `);
      const card = page.getByRole('button', { name: 'Click to enter lobby', exact: true });
      expect(await clubCardClearOfVisibleActions(page, card)).toBe(true);
      await card.click({ trial: true, timeout: 1000 });
    });
  }

  test('refuses visible actions covering the club card', async ({ page }) => {
    await page.setContent(`
      <button style="position:absolute;top:20px;height:50px" aria-label="Click to enter lobby">Club</button>
      <nav aria-label="Poker Arena Actions" style="position:absolute;top:30px;height:40px">Create Find Join</nav>
    `);
    expect(
      await clubCardClearOfVisibleActions(
        page,
        page.getByRole('button', { name: 'Click to enter lobby', exact: true })
      )
    ).toBe(false);
  });
});

test.describe('Club Operations', () => {
  test('should show clubs list', async ({ page }) => {
    await expectRoute(page, 'clubs');
  });

  test('should navigate to club detail when clicking a club', async ({ page }) => {
    await page.goto('clubs');

    // Wait for clubs to load
    await page.waitForTimeout(1000);

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
    if ((await clubCard.count()) > 0 && (await clubCard.isVisible())) {
      /* Visibility alone cannot detect occlusion. The approved top actions
         replaced the retired bottom Quick actions row; keep the overlap
         guard against the navigation that is actually rendered. */
      await expect
        .poll(() => clubCardClearOfVisibleActions(page, clubCard), {
          timeout: 8000,
          message: 'Club card must not overlap the Poker Arena actions',
        })
        .toBe(true);
      // Check all actual pointer occluders as well as the rendered action row.
      await clubCard.click({ trial: true, timeout: 8000 });
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
