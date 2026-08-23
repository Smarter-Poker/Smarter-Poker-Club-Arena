/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE THE TOP OF THE PAGE ACTUALLY ENDS (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `<TournamentStartingTicker>` is a fixed strip mounted at the app root, so it
 * cannot flow after the page's own chrome — it has to be told where to start.
 *
 * Dan 2026-08-21: "it should play UNDER the global header, not through it."
 * That was implemented as "find #global-header, start at its bottom", which
 * holds everywhere the global header exists and fails silently everywhere it
 * does not. Inside /table/* it does not: TablePage is fixed to the whole
 * viewport and the top chrome is the multi-table tab bar. The lookup returned
 * null, the offset fell to 0, and a 34px strip at z-index 9400 came down on a
 * tab bar that stacks at 200 — burying the "+" that opens a second table.
 *
 * The rule is therefore "below whatever top chrome this route actually has",
 * and it lives here, apart from the component, because it is the part worth
 * asserting: pure geometry in, one number out, no DOM mounting required to
 * prove it. See tests/unit/mttTickerAnchor.test.ts.
 */

/**
 * Every element that can occupy the top of a route, in no particular order —
 * all of them are measured and the lowest edge wins, because more than one can
 * be on screen at once (global header above, tab bar below it).
 */
export const TOP_CHROME_SELECTORS = ['#global-header', 'header', '.table-tab-bar'] as const;

/**
 * The y-coordinate the ticker should start at.
 *
 * @param find how to resolve a selector — `document.querySelector` in the app,
 *             a stub in tests.
 * @returns the lowest bottom edge among visible top chrome, never negative.
 */
export function measureTopChromeBottom(find: (selector: string) => Element | null): number {
  let bottom = 0;

  for (const selector of TOP_CHROME_SELECTORS) {
    const el = find(selector);
    if (!el) continue;

    // getClientRects() is empty for display:none. The persistent multi-table
    // layer collapses that way off /table/*, and a collapsed bar must not
    // push the ticker down on pages where it is not rendered at all.
    if (el.getClientRects().length === 0) continue;

    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom > bottom) bottom = rect.bottom;
  }

  // A bar scrolled above the fold reports a negative bottom; clamping keeps
  // the ticker on screen instead of hiding it off the top edge.
  return Math.max(0, Math.round(bottom));
}
