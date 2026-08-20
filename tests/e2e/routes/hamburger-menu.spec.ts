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
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(400);
  return true;
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

    // The drawer should be visible (check for a section header like "Game Modes")
    const gameModes = page.locator('text=Game Modes');
    await expect(gameModes).toBeVisible({ timeout: 3000 });

    /* Press Escape to close.
       NOT `not.toBeVisible()`. The drawer closes by sliding out - it keeps its
       full 320px box and `visibility: visible`, it just sits at x = -320. That
       is closed to a user and OPEN to Playwright, whose definition of visible
       is "non-empty bounding box and not visibility:hidden" - nothing about
       being on screen. Measured live after Escape: {w:320, h:43, x:-320,
       visibility:'visible'}. So this assertion failed on a working Escape
       handler (HamburgerMenu.tsx:136) the moment the suite ran signed in.
       `toBeInViewport` is the check that means what this test meant. */
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    await expect(gameModes).not.toBeInViewport({ timeout: 2000 });
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
  // All navigation links in the hamburger menu
  const allNavLinks = [
    // Game Modes
    { label: 'Home', path: '/' },
    { label: 'Tournaments', path: '/tournaments' },
    { label: 'Tournament Lobby', path: '/tournament-lobby' },
    { label: 'Tournament Results', path: '/tournament-results' },
    { label: 'Hand History', path: '/hand-history' },
    { label: 'Session History', path: '/history' },
    { label: 'Leaderboard', path: '/leaderboard' },
    // Clubs
    { label: 'My Clubs', path: '/clubs' },
    { label: 'Create Club', path: '/clubs/create' },
    { label: 'Messages', path: '/messages' },
    { label: 'Club Messages', path: '/messages/clubs' },
    { label: 'Players', path: '/players' },
    { label: 'Cashier', path: '/cashier' },
    // The menu has never had an item called "Search" - the row that routes to
    // /search is labelled "Find Player" (HamburgerMenu.tsx:695). Signed out this
    // test skipped before it could notice.
    { label: 'Find Player', path: '/search' },
    // Unions
    { label: 'Browse Unions', path: '/unions' },
    { label: 'Create Union', path: '/unions/create' },
    // Player
    { label: 'My Profile', path: '/profile' },
    { label: 'My Wallet', path: '/wallet' },
    { label: 'Achievements', path: '/achievements' },
    { label: 'Player Stats', path: '/stats' },
    { label: 'VIP Status', path: '/vip' },
    { label: 'Rakeback', path: '/rakeback' },
    { label: 'Promotions', path: '/promotions' },
    { label: 'Bonuses', path: '/bonuses' },
    { label: 'Transactions', path: '/transactions' },
    { label: 'Friends', path: '/friends' },
    { label: 'Waitlist', path: '/waitlist' },
    { label: 'Invite Players', path: '/invite' },
    // Agent & Admin
    { label: 'Agent Management', path: '/agent-management' },
    { label: 'Club Dashboard', path: '/data' },
    { label: 'Club Settings', path: '/admin' },
    // Settings
    { label: 'App Settings', path: '/settings' },
    { label: 'Notifications', path: '/notifications' },
    // Support & Legal
    { label: 'Help & FAQ', path: '/help' },
    { label: 'Terms of Service', path: '/legal/tos' },
    { label: 'Privacy Policy', path: '/legal/privacy' },
    { label: 'Fair Gaming', path: '/legal/fair-gaming' },
    { label: 'Promotion Rules', path: '/legal/promotions' },
  ];

  for (const link of allNavLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await navigateAndWait(page, '/');

      if (!(await openMenuOrSkip(page))) return;

      // Find the menu item by text
      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
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

    const bbLabel = page.locator('.tsp-item__label:text-is("Show Stack in Big Blinds")').first();
    await expect(bbLabel).toBeVisible({ timeout: 15000 });

    // The toggle is a sibling of the label's wrapper, not of the label itself.
    const bbToggle = bbLabel.locator('../..').locator('button').first();
    await expect(bbToggle).toBeVisible();
    await bbToggle.click();
    await page.waitForTimeout(200);
  });
});

test.describe('Hamburger Menu — Keyboard Shortcuts Section', () => {
  test('should display all keyboard shortcuts', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    // The section header should be visible
    const sectionHeader = page.locator('text=Keyboard Shortcuts').first();
    await expect(sectionHeader).toBeVisible({ timeout: 5000 });

    // Verify shortcut keys are rendered in <kbd> elements
    const shortcuts = ['?', 'Esc', 'H', 'L', 'T', 'P', 'S'];
    for (const key of shortcuts) {
      const kbd = page.locator(`kbd:text-is("${key}")`);
      await expect(kbd).toBeVisible({ timeout: 2000 });
    }

    // Verify descriptions
    const descriptions = [
      'Show Shortcuts',
      'Close Menu / Modal',
      'Go Home',
      'Go to Home',
      'Go to Tournaments',
      'Go to Profile',
      'Go to Settings',
    ];
    for (const desc of descriptions) {
      const descEl = page.locator(`text=${desc}`).first();
      await expect(descEl).toBeVisible({ timeout: 2000 });
    }
  });
});

test.describe('Hamburger Menu — Log Out', () => {
  test('should show Log Out button', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    const logOut = page.locator('span:text-is("Log Out")');
    await expect(logOut).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Hamburger Menu — Club Arena Lobby (ClubCarouselPage)', () => {
  test('should open hamburger menu from the ≡ button on /clubs', async ({ page }) => {
    await navigateAndWait(page, '/clubs');

    /* This asserted `button.header__menu`, on the premise that the lobby has
       its OWN ≡ button. It does not, and has not for some time: /clubs renders
       the shared GlobalHeader, whose hamburger is
       `aria-label="Open Menu"` + a CSS-module class. `.header__menu` now lives
       only in ClubCarouselPage.css, matching nothing.

       The old code ended in `else { test.skip() }`, so the button vanishing —
       the exact regression this test exists to catch — retired the test
       instead of failing it. */
    if (!(await openMenuOrSkip(page))) return;

    const gameModes = page.locator('text=Game Modes');
    await expect(gameModes).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Hamburger Menu — Version Footer', () => {
  test('should display version information', async ({ page }) => {
    await navigateAndWait(page, '/');

    if (!(await openMenuOrSkip(page))) return;

    // Look for version text (e.g., "Club Arena v1.12")
    const version = page.locator('text=/Club Arena v/');
    await expect(version).toBeVisible({ timeout: 3000 });
  });
});
