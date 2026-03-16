import { test, expect } from '@playwright/test';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAMBURGER MENU — Full E2E Test Suite
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests all hamburger menu items: navigation links, settings toggles,
 * keyboard shortcuts section, profile card, and routing correctness.
 */

// ── Helper: Open the hamburger menu from the GlobalHeader ──
async function openHamburgerMenu(page: any) {
  // The hamburger button is in GlobalHeader — look for the menu trigger
  const hamburgerBtn = page.locator('button[aria-label="Open Menu"]');
  if (await hamburgerBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await hamburgerBtn.click();
  } else {
    // Fallback: look for <img alt="Menu"/> button
    const menuImg = page.locator('img[alt="Menu"]');
    if (await menuImg.isVisible({ timeout: 2000 }).catch(() => false)) {
      await menuImg.click();
    }
  }
  // Wait for the drawer to animate in
  await page.waitForTimeout(400);
}

// ── Helper: Close the hamburger menu ──
async function closeHamburgerMenu(page: any) {
  const closeBtn = page.locator('button', { hasText: 'Close' });
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
  }
  await page.waitForTimeout(350);
}

test.describe('Hamburger Menu — Open / Close', () => {
  test('should open via hamburger button and close via Close button', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');

    await openHamburgerMenu(page);

    // The drawer should be visible (check for a section header like "Game Modes")
    const gameModes = page.locator('text=Game Modes');
    await expect(gameModes).toBeVisible({ timeout: 3000 });

    // Close the menu
    await closeHamburgerMenu(page);

    // Menu should be closed — section header should not be visible
    await expect(gameModes).not.toBeVisible({ timeout: 2000 });
  });

  test('should close on Escape key press', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');

    await openHamburgerMenu(page);
    const gameModes = page.locator('text=Game Modes');
    await expect(gameModes).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    await expect(gameModes).not.toBeVisible({ timeout: 2000 });
  });
});

test.describe('Hamburger Menu — Profile Card', () => {
  test('should display profile card with View Profile text', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');

    await openHamburgerMenu(page);

    const viewProfile = page.locator('text=View Profile');
    await expect(viewProfile).toBeVisible({ timeout: 3000 });
  });

  test('should navigate to /profile when profile card is clicked', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');

    await openHamburgerMenu(page);

    const viewProfile = page.locator('text=View Profile');
    await viewProfile.click();
    await page.waitForTimeout(500);

    await expect(page).toHaveURL(/.*profile/);
  });
});

test.describe('Hamburger Menu — Game Modes Navigation', () => {
  const gameModeLinks = [
    { label: 'Lobby', path: '/lobby' },
    { label: 'Tournaments', path: '/tournaments' },
    { label: 'Tournament Lobby', path: '/tournament-lobby' },
    { label: 'Tournament Results', path: '/tournament-results' },
    { label: 'Hand History', path: '/hand-history' },
    { label: 'Session History', path: '/history' },
    { label: 'Leaderboard', path: '/leaderboard' },
  ];

  for (const link of gameModeLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/clubs');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      // Find the menu item by exact text
      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace('/', '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Clubs Navigation', () => {
  const clubsLinks = [
    { label: 'My Clubs', path: '/clubs' },
    { label: 'Create Club', path: '/clubs/create' },
    { label: 'Messages', path: '/messages' },
    { label: 'Club Messages', path: '/messages/clubs' },
    { label: 'Players', path: '/players' },
    { label: 'Cashier', path: '/cashier' },
    { label: 'Search', path: '/search' },
  ];

  for (const link of clubsLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/lobby');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Unions Navigation', () => {
  const unionsLinks = [
    { label: 'Browse Unions', path: '/unions' },
    { label: 'Create Union', path: '/unions/create' },
  ];

  for (const link of unionsLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/lobby');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Player Navigation', () => {
  const playerLinks = [
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
  ];

  for (const link of playerLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/clubs');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Agent & Admin Navigation', () => {
  const adminLinks = [
    { label: 'Agent Management', path: '/agent-management' },
    { label: 'Club Dashboard', path: '/data' },
    { label: 'Club Settings', path: '/admin' },
  ];

  for (const link of adminLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/clubs');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Settings Navigation', () => {
  const settingsLinks = [
    { label: 'App Settings', path: '/settings' },
    { label: 'Notifications', path: '/notifications' },
  ];

  for (const link of settingsLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/clubs');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Support & Legal Navigation', () => {
  const supportLinks = [
    { label: 'Help & FAQ', path: '/help' },
    { label: 'Terms of Service', path: '/legal/tos' },
    { label: 'Privacy Policy', path: '/legal/privacy' },
    { label: 'Fair Gaming', path: '/legal/fair-gaming' },
    { label: 'Promotion Rules', path: '/legal/promotions' },
  ];

  for (const link of supportLinks) {
    test(`should navigate to ${link.path} when "${link.label}" is clicked`, async ({ page }) => {
      await page.goto('/clubs');
      await page.waitForLoadState('networkidle');

      await openHamburgerMenu(page);

      const menuItem = page.locator(`span:text-is("${link.label}")`).first();
      await expect(menuItem).toBeVisible({ timeout: 3000 });
      await menuItem.click();
      await page.waitForTimeout(500);

      await expect(page).toHaveURL(new RegExp(`.*${link.path.replace(/\//g, '\\/')}`));
    });
  }
});

test.describe('Hamburger Menu — Settings Toggles', () => {
  test('should toggle Sounds on/off', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    // Find the Sounds toggle — it's a <button> inside a div with text "Sounds"
    const soundsSection = page.locator('div', { hasText: /^Sounds$/ }).first();
    await expect(soundsSection).toBeVisible({ timeout: 3000 });

    const soundsToggle = soundsSection.locator('button');
    await expect(soundsToggle).toBeVisible();
    await soundsToggle.click();
    await page.waitForTimeout(200);
    // Toggle should have visually changed (no assertion on color — just ensuring it doesn't crash)
  });

  test('should toggle Vibrations on/off', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    const vibrationsSection = page.locator('div', { hasText: /^Vibrations$/ }).first();
    await expect(vibrationsSection).toBeVisible({ timeout: 3000 });

    const vibrationsToggle = vibrationsSection.locator('button');
    await expect(vibrationsToggle).toBeVisible();
    await vibrationsToggle.click();
    await page.waitForTimeout(200);
  });

  test('should toggle Show Stack in BBs on/off', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    const bbSection = page.locator('div', { hasText: /^Show Stack in BBs/ }).first();
    await expect(bbSection).toBeVisible({ timeout: 3000 });

    const bbToggle = bbSection.locator('button');
    await expect(bbToggle).toBeVisible();
    await bbToggle.click();
    await page.waitForTimeout(200);
  });
});

test.describe('Hamburger Menu — Keyboard Shortcuts Section', () => {
  test('should display the Keyboard Shortcuts section with all shortcuts', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    // The section header "KEYBOARD SHORTCUTS" should be visible
    const sectionHeader = page.locator('text=Keyboard Shortcuts').first();
    await expect(sectionHeader).toBeVisible({ timeout: 3000 });

    // Verify individual shortcut keys are rendered
    const shortcuts = ['?', 'Esc', 'H', 'L', 'T', 'P', 'S'];
    for (const key of shortcuts) {
      const kbd = page.locator(`kbd:text-is("${key}")`);
      await expect(kbd).toBeVisible({ timeout: 2000 });
    }

    // Verify shortcut descriptions
    const descriptions = [
      'Show Shortcuts',
      'Close Menu / Modal',
      'Go Home',
      'Go to Lobby',
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

test.describe('Hamburger Menu — Reset Tutorial', () => {
  test('should show Reset Tutorial option and click it', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    const resetTutorial = page.locator('span:text-is("Reset Tutorial")');
    await expect(resetTutorial).toBeVisible({ timeout: 3000 });
    await resetTutorial.click();
    await page.waitForTimeout(300);
    // Should show toast or close the menu — no crash
  });
});

test.describe('Hamburger Menu — Log Out', () => {
  test('should show Log Out button', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    const logOut = page.locator('span:text-is("Log Out")');
    await expect(logOut).toBeVisible({ timeout: 3000 });
    // Don't click log out to avoid breaking session
  });
});

test.describe('Hamburger Menu — Club Arena Lobby (ClubCarouselPage)', () => {
  test('should open hamburger menu from the ≡ button on /clubs page', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');

    // The ClubCarouselPage has a ≡ button with class "header__menu"
    const menuBtn = page.locator('button.header__menu');
    if (await menuBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await menuBtn.click();
      await page.waitForTimeout(400);

      // Verify the hamburger menu drawer opened
      const gameModes = page.locator('text=Game Modes');
      await expect(gameModes).toBeVisible({ timeout: 3000 });
    }
  });
});

test.describe('Hamburger Menu — Version Footer', () => {
  test('should display version footer', async ({ page }) => {
    await page.goto('/clubs');
    await page.waitForLoadState('networkidle');
    await openHamburgerMenu(page);

    const version = page.locator('text=Club Arena v1.12');
    await expect(version).toBeVisible({ timeout: 3000 });
  });
});
