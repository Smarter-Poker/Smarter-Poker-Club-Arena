import { test, expect } from '@playwright/test';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Full E2E Test Suite
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests all hamburger menu items: navigation links, settings toggles,
 * keyboard shortcuts section, profile card, and routing correctness.
 *
 * NOTE: The app uses Vite base path /hub/club-arena/ — all goto() calls must
 * include this prefix. Auth-protected routes redirect to /auth; tests that
 * reach the auth page still validate the redirect is correct.
 */

/**
 * Paths are RELATIVE to the configured baseURL, like every other spec here.
 * This used to be a hardcoded '/hub/club-arena', which happens to work against
 * production but silently points at the wrong place for any other BASE_URL —
 * a local dev server serves the app at the root, so every navigation would
 * have 404'd while the body-visible assertions kept passing.
 */
const BASE = '';

// ── Helper: Open the hamburger menu from the GlobalHeader ──
async function openHamburgerMenu(page: any) {
  /* GlobalHeader renders `aria-label="Open Menu"` on every route, /clubs
     included. The old `.header__menu` fallback was dead: that class survives
     only in ClubCarouselPage.css and no component has emitted it for some
     time, so the fallback could never fire and its 2s budget was pure delay.

     15s, not 5s. Signed OUT the header was never reached at all - the app
     bounced to /auth and these tests skipped - so the old budget was never
     under load. Signed in, the header renders only after session restore, the
     profile read and the clubs fetch, and four Playwright workers hit
     production at once. 5s produced 11 silent skips on a healthy site. */
  const btn = page.locator('button[aria-label="Open Menu"]').first();
  try {
    await btn.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    return false;
  }
  const drawer = page.getByRole('dialog', { name: 'Club Arena' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Resolve the opener again on retry. Session/profile hydration can replace
    // the header immediately after the first click; a successful click on that
    // retiring node does not prove the newly mounted drawer is open.
    await page.locator('button[aria-label="Open Menu"]').first().click({ timeout: 8000 });
    if (
      await drawer
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false)
    ) {
      return true;
    }
  }
  throw new Error('The hamburger opener was clickable, but its Club Arena drawer never opened.');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Open the menu, or account honestly for why we could not.
 *
 * A signed-out run genuinely cannot test the menu: the route redirects to /auth
 * and there is no header. That is the ONLY legitimate skip here.
 *
 * Anything else - we are on a real page, signed in, and the hamburger is not
 * there - is a failure, and used to be `test.skip()` at eleven call sites. A
 * skip is indistinguishable from a pass in the summary line, which is how a
 * third of this file spent a year reporting success while asserting nothing.
 * If the menu is genuinely unreachable on a signed-in run, that is the single
 * most important thing this spec could tell anyone. */
async function openMenuOrSkip(page: any): Promise<boolean> {
  if (await isOnAuthPage(page)) {
    test.skip();
    return false;
  }
  const opened = await openHamburgerMenu(page);
  if (!opened) {
    throw new Error(
      `Hamburger menu button never appeared on ${page.url()} after 15s, and this ` +
        'is not the /auth page - the menu is unreachable for a signed-in user.'
    );
  }
  return true;
}

// ── Helper: Navigate and wait for either page load or auth redirect ──
async function navigateAndWait(page: any, path: string) {
  // '' is not a valid URL for goto() — the root case has to resolve to the
  // baseURL directory explicitly, or every test silently skips on about:blank.
  await page.goto(`${BASE}${path.replace(/^\//, '')}` || './');
  // Wait for either the actual page or auth redirect
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
}

// ── Helper: Check if we're on the auth page (redirected) ──
async function isOnAuthPage(page: any): Promise<boolean> {
  const url = page.url();
  return url.includes('/auth');
}

test.describe('Hamburger Menu — Open / Close', () => {
  test('should open via hamburger button and close via backdrop/escape', async ({ page }) => {
    await navigateAndWait(page, '/');

    // If redirected to auth, skip this test
    if (!(await openMenuOrSkip(page))) return;

    // The drawer should be visible (check for the canonical first section)
    const gameModes = page.getByRole('heading', { name: 'Play' });
    await expect(gameModes).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('dialog', { name: 'Club Arena' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();

    // Escape removes the focusable dialog tree and restores the opener.
    await page.keyboard.press('Escape');
    await expect(gameModes).not.toBeAttached({ timeout: 2000 });
    await expect(page.locator('button[aria-label="Open Menu"]').first()).toBeFocused();
  });
});

test.describe('Hamburger Menu — Profile Card', () => {
  test('should display profile card with View Profile text', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    const viewProfile = page.locator('text=View Profile');
    await expect(viewProfile).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Hamburger Menu — Navigation Links', () => {
  // Canonical global navigation links in the cleaned information architecture.
  const allNavLinks = [
    // Play
    { label: 'Play & Review', path: '/play' },
    { label: 'Club Arena', path: '/' },
    { label: 'Tournaments', path: '/tournaments' },
    { label: 'Tournament Results', path: '/tournament-results' },
    { label: 'Hand History', path: '/hand-history' },
    { label: 'Session History', path: '/session-history' },
    { label: 'Leaderboards', path: '/leaderboard' },
    // Community
    { label: 'Community Center', path: '/community' },
    { label: 'Find Players & Clubs', path: '/search' },
    { label: 'Friends', path: '/friends' },
    { label: 'Unions', path: '/unions' },
    // Wallet & Rewards
    { label: 'Rewards Center', path: '/rewards' },
    { label: 'Wallet', path: '/wallet' },
    { label: 'Cashier', path: '/cashier' },
    { label: 'Marketplace', path: '/marketplace' },
    { label: 'VIP & Rakeback', path: '/vip' },
    { label: 'Promotions', path: '/promotions' },
    { label: 'Achievements', path: '/achievements' },
    // Settings
    { label: 'App Settings', path: '/settings' },
    { label: 'Notifications', path: '/notifications' },
    // Support & Legal
    { label: 'Help Center', path: '/help' },
    { label: 'Terms Of Service', path: '/legal/tos' },
    { label: 'Privacy Policy', path: '/legal/privacy' },
    { label: 'Fair Gaming', path: '/legal/fair-gaming' },
    { label: 'Promotion Rules', path: '/legal/promotions' },
  ];

  for (const link of allNavLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await navigateAndWait(page, '/');

      if (!(await openMenuOrSkip(page))) return;

      // Use the interactive control's accessible name. The button also owns a
      // short description, so its name begins with the destination label.
      const menuItem = page
        .getByRole('dialog', { name: 'Club Arena' })
        .getByRole('button', {
          name: new RegExp(`^${escapeRegExp(link.label)}(?:\\s|$)`),
        })
        .first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();

      // No fixed sleep before the assertion: client-side navigation is not
      // done on a timer, and a 500 ms guess is exactly what made this spec
      // flaky once the suite went to 4 workers. toHaveURL already polls —
      // give it a real budget and let it do that.
      const escapedPath = link.path.replace(/\//g, '\\/');
      await expect(page).toHaveURL(new RegExp(`.*${escapedPath}`), { timeout: 10000 });
    });
  }
});

test.describe('Hamburger Menu — Settings Toggles', () => {
  test('should toggle Sounds on/off', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    // Scroll down to find Sounds toggle
    const soundsLabel = page.locator('span:text-is("Sounds")').first();
    await expect(soundsLabel).toBeVisible({ timeout: 5000 });

    // The toggle is a sibling button in the same container div
    const soundsToggle = soundsLabel.locator('..').locator('button');
    await expect(soundsToggle).toBeVisible();
    await expect(soundsToggle).toHaveAttribute('role', 'switch');
    await expect(soundsToggle).toHaveAttribute('aria-label', 'Sounds');
    expect((await soundsToggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await soundsToggle.click();
    await page.waitForTimeout(200);
    // No crash = success
  });

  test('should toggle Vibrations on/off', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    const vibrationsLabel = page.locator('span:text-is("Vibrations")').first();
    await expect(vibrationsLabel).toBeVisible({ timeout: 5000 });

    const vibrationsToggle = vibrationsLabel.locator('..').locator('button');
    await expect(vibrationsToggle).toBeVisible();
    await vibrationsToggle.click();
    await page.waitForTimeout(200);
  });

  test('should toggle Show Stack in BBs on/off', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    /* This setting is rendered as "Show Stack in Big Blinds"
       (useUserTableSettings.ts:132), which is the metadata TableSettingsPanel
       actually reads. TableSettings.tsx and VIPCardsModal.tsx still call the
       same setting "Show Stack in BBs" - worth reconciling, but the panel's
       label is what a test of the panel has to match.

       It is one of the 12 toggles inside TableSettingsPanel,
       which the menu renders only while its "Table Settings" row is expanded
       (HamburgerMenu.tsx:989 - `showTableSettings && <TableSettingsPanel/>`).
       This test never expanded it, so the label was legitimately absent and the
       spec would have failed the first time it ever ran. */
    const tableSettingsRow = page.locator('span:text-is("Table Settings")').first();
    await expect(tableSettingsRow).toBeVisible({ timeout: 5000 });
    await tableSettingsRow.click();

    const bbToggle = page.getByRole('switch', { name: 'Show Stack In Big Blinds' }).first();
    await expect(bbToggle).toBeVisible();
    await bbToggle.click();
    await page.waitForTimeout(200);
  });
});

test.describe('Hamburger Menu — Information Architecture', () => {
  test('should display the cleaned navigation groups', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    const sections = ['Play', 'Community', 'Wallet & Rewards', 'Support & Legal'];
    for (const section of sections) {
      await expect(page.getByRole('heading', { name: section })).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Hamburger Menu — Log Out', () => {
  test('should show Log Out button', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    const logOut = page.getByRole('button', { name: 'Log Out' });
    await expect(logOut).toBeVisible({ timeout: 3000 });
  });
});

/* REMOVED 2026-08-23: "Hamburger Menu - Club Arena Lobby (ClubCarouselPage)".
   /clubs was a second, older lobby that Dan asked to be made unreachable - it
   is now a redirect to the real lobby on `/`, and the component is deleted. A
   spec that navigates to /clubs to prove the shared header works there would
   now just be testing the redirect twice over: the '/' cases above already
   cover that header, because it is the same GlobalHeader. See
   tests/unit/deadLobbyIsGone.test.ts for the guard that keeps the old lobby
   from coming back. */

test.describe('Hamburger Menu — Version Footer', () => {
  test('should display version information', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    // Look for version text. Case-insensitive on purpose: the footer renders
    // "Club Arena V1.12" (capital V — house Title Case), and the original
    // lower-case regex could never match it. It never had to: signed out this
    // spec skipped, so the assertion was first evaluated on 2026-08-23.
    const version = page.getByText(/Club Arena .* Command Deck V\d/i).first();
    await version.scrollIntoViewIfNeeded();
    await expect(version).toBeVisible({ timeout: 3000 });
  });
});
