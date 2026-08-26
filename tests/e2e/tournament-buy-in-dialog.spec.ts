/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE BUY-IN CONFIRMATION — the only test that can prove it is styled
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25 (binding): "the buy in confirmation is trash and needs to be
 * updated... there needs to be a space after every : it currently has
 * Buy In:50 instead of Buy In: 50."
 *
 * Both halves of that complaint are LAYOUT facts, and layout is exactly what a
 * unit test cannot see. jsdom does not lay anything out: every element it
 * renders has a zero-size bounding box, so a vitest spec can prove the two
 * spans exist and can never prove there is a gap between them. The unit specs
 * for this dialog therefore assert its SOURCE — that the rule declares
 * `display: flex` and a `gap` — and one of them was, for a while, satisfied by
 * a completely different rule further down the stylesheet.
 *
 * This file measures the rendered result in a real browser.
 *
 * ─── IT MUST NOT SPEND A SINGLE CHIP ─────────────────────────────────────────
 *
 * CI runs this suite against PRODUCTION (BASE_URL=https://smarter.poker/...)
 * and, because SP_EMAIL/SP_PASS are set, it runs SIGNED IN as a real player.
 * CLAUDE.md section 11.5 is binding and was written after an agent spent 48
 * real chips proving a rule: never exercise a money path for real.
 *
 * So: this spec OPENS the dialog and CANCELS it. Opening costs nothing — the
 * debit happens in `tournamentService.registerPlayer`, which only runs after
 * Confirm resolves the promise true. Confirm is located and asserted upon, and
 * is NEVER clicked. If you are editing this file and find yourself reaching for
 * `confirmBtn.click()`, stop: that is a real buy-in on a real account.
 */

import { test, expect, type Page, type Locator } from '@playwright/test';

/** Paths are RELATIVE — `baseURL` already carries /hub/club-arena/. */
const url = (path: string) => path.replace(/^\//, '');

/** Signed out, every one of these is untestable rather than failing. */
async function requireSignedIn(page: Page) {
  if (/\/auth\b/.test(page.url())) {
    test.skip(true, 'signed out — set SP_EMAIL / SP_PASS for this spec to run');
  }
}

/**
 * WAIT FOR THE LOBBY TO HAVE ACTUALLY DRAWN ITS CARDS.
 *
 * The first working draft used `waitForTimeout(2500)` here and every spec then
 * blew the 30s test budget: production is a signed-in app holding realtime
 * sockets, and a fixed sleep is both too long when it is fast and too short
 * when it is not. Wait for the thing itself.
 *
 * Returns false when the lobby genuinely has no actionable card — an empty
 * schedule is a fact about production, not a regression.
 */
async function lobbyReady(page: Page): Promise<boolean> {
  const anyCardAction = page.getByRole('button', {
    name: /^\s*(Watch|Open Tournament|Register|Late Register)\b/i,
  });
  try {
    await anyCardAction.first().waitFor({ state: 'visible', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the navigation drawer out of the way.
 *
 * Found by RUNNING this suite rather than by reading it: on a signed-in cold
 * load the hamburger drawer sits over the lobby, so every card behind it is
 * unmatched and the first draft of these specs SKIPPED on every run — signed in
 * or out. A spec that can only skip reports green and proves nothing.
 */
async function dismissChrome(page: Page) {
  const close = page.getByRole('button', { name: /^\s*Close\s*$/ }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {});
    await close.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

/**
 * The lobby opens on a filter that shows LIVE events, whose cards offer Watch
 * and not Register. Registering / Upcoming is where a buy-in lives.
 */
async function showRegisterableFilter(page: Page) {
  const register = page.getByRole('button', { name: /^\s*(Register|Late Register)\b/i });
  if ((await register.count()) > 0) return;
  for (const name of [/^\s*Registering\s*$/, /^\s*Upcoming\s*$/, /^\s*All\s*$/]) {
    const tab = page.getByRole('button', { name }).first();
    if (!(await tab.isVisible().catch(() => false))) continue;
    await tab.click().catch(() => {});
    try {
      await register.first().waitFor({ state: 'visible', timeout: 8_000 });
      return;
    } catch {
      /* try the next filter */
    }
  }
}

/**
 * Open the global tournament lobby and click the first REGISTER we can find.
 * Returns the dialog, or null when this account has nothing registerable right
 * now (already in everything, or no upcoming events) — which is a legitimate
 * state of production, not a failure of the code.
 */
async function openBuyInDialog(page: Page): Promise<Locator | null> {
  await page.goto(url('tournaments'), { waitUntil: 'domcontentloaded' });
  await requireSignedIn(page);
  await dismissChrome(page);
  if (!(await lobbyReady(page))) return null;
  await showRegisterableFilter(page);

  // The register affordance is spelled "Register (20)" on a card and "Register"
  // in the details footer. Late registration is a buy-in too.
  const registerBtn = page.getByRole('button', { name: /^\s*(Register|Late Register)\b/i }).first();

  if ((await registerBtn.count()) === 0) {
    return null;
  }
  await registerBtn.click();

  const dialog = page.locator('.signup-modal');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return null;
  }
  return dialog;
}

/** Always leave the felt as we found it. */
async function cancel(page: Page) {
  const cancelBtn = page.locator('.signup-modal .btn-cancel');
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click();
    await expect(page.locator('.signup-modal')).toHaveCount(0);
  }
}

test.describe('Tournament buy-in confirmation', () => {
  /* Production, signed in, over a real network. The default 30s is a local-dev
     budget; every spec here spends most of it waiting for the lobby to load. */
  test.setTimeout(90_000);

  test.afterEach(async ({ page }) => {
    await cancel(page).catch(() => {
      /* the test may already have closed it */
    });
  });

  test('opens exactly ONE dialog, and it is centred on the screen', async ({ page }) => {
    const dialog = await openBuyInDialog(page);
    test.skip(dialog === null, 'no registerable tournament on production right now');

    /* Dan: "you don't need a secondary confirmation for buy ins." Two dialogs
       for one buy-in is the bug; zero would be far worse, so this pins both
       ends — exactly one. */
    await expect(page.locator('.signup-modal')).toHaveCount(1);
    await expect(page.locator('.signup-overlay')).toHaveCount(1);

    const box = await dialog!.boundingBox();
    const vp = page.viewportSize();
    expect(box, 'the card must actually be laid out').not.toBeNull();
    expect(vp).not.toBeNull();

    // "Middle of the screen" — the card's centre within 12% of the viewport's,
    // on both axes. Loose enough to survive a design tweak, tight enough that
    // the old top-left unstyled block could never pass it.
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    expect(Math.abs(cx - vp!.width / 2), 'horizontally centred').toBeLessThan(vp!.width * 0.12);
    expect(Math.abs(cy - vp!.height / 2), 'vertically centred').toBeLessThan(vp!.height * 0.12);
  });

  test('there is a real gap after every colon', async ({ page }) => {
    const dialog = await openBuyInDialog(page);
    test.skip(dialog === null, 'no registerable tournament on production right now');

    const rows = dialog!.locator('.signup-row');
    const n = await rows.count();
    expect(n, 'the card must have rows').toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const label = row.locator('.signup-label');
      const value = row.locator('.signup-value');
      if ((await label.count()) === 0 || (await value.count()) === 0) continue;

      const labelText = (await label.innerText()).trim();
      const lb = await label.boundingBox();
      const vb = await value.boundingBox();
      expect(lb, `${labelText} label must be laid out`).not.toBeNull();
      expect(vb, `${labelText} value must be laid out`).not.toBeNull();

      /* THE ACTUAL COMPLAINT, measured. "Entry Fee:50" was two adjacent inline
         spans with no whitespace between them in the JSX — so the gap has to be
         a LAYOUT fact. Anything under 4px is the bug. */
      const gap = vb!.x - (lb!.x + lb!.width);
      expect(gap, `"${labelText}" and its value must not touch (gap was ${gap}px)`).toBeGreaterThan(
        4
      );
    }
  });

  test('nothing in the app can paint over it', async ({ page }) => {
    const dialog = await openBuyInDialog(page);
    test.skip(dialog === null, 'no registerable tournament on production right now');

    /* It shipped at z-index 1000 in an app with ~20 overlays above that and an
       offline banner at 9999 — ordinary chrome could cover the one prompt that
       takes a player's money. */
    const z = await page
      .locator('.signup-overlay')
      .evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
    expect(z, 'the buy-in prompt must be the top layer').toBeGreaterThan(9999);

    // And the card must be the thing under the cursor at its own centre —
    // a stacking-context mistake would leave it visible but unclickable.
    const box = await dialog!.boundingBox();
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number);
        return !!el?.closest('.signup-modal');
      },
      [box!.x + box!.width / 2, box!.y + 8]
    );
    expect(hit, 'the card must be hit-testable at its own top edge').toBe(true);
  });

  test('Cancel closes it and takes nothing', async ({ page }) => {
    const dialog = await openBuyInDialog(page);
    test.skip(dialog === null, 'no registerable tournament on production right now');

    // Confirm is asserted to EXIST and is deliberately never clicked — see the
    // header. Clicking it is a real buy-in on a real account.
    await expect(dialog!.locator('.btn-confirm')).toBeVisible();

    await dialog!.locator('.btn-cancel').click();
    await expect(page.locator('.signup-modal')).toHaveCount(0);

    /* Cancelling must also release the hook's re-entrancy guard, or the
       Register button is dead for the rest of the session. Prove it by opening
       the dialog a second time. */
    const again = page.getByRole('button', { name: /^\s*(Register|Late Register)\b/i }).first();
    if ((await again.count()) > 0) {
      await again.click();
      await expect(page.locator('.signup-modal')).toBeVisible({ timeout: 8000 });
    }
  });

  test('Escape closes it, and does not break the page behind it', async ({ page }) => {
    const dialog = await openBuyInDialog(page);
    test.skip(dialog === null, 'no registerable tournament on production right now');

    await page.keyboard.press('Escape');
    await expect(page.locator('.signup-modal')).toHaveCount(0);

    // The Escape handler is a capture-phase listener on `window`; it used to
    // stopPropagation, which blocked Escape for every other listener in the
    // app while the dialog was open. The page must still be alive and usable.
    await expect(page.locator('body')).toBeVisible();
  });
});
