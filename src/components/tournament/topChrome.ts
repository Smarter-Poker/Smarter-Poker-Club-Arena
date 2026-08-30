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
 * The rule was therefore "below whatever top chrome this route actually has",
 * and it lives here, apart from the component, because it is the part worth
 * asserting: pure geometry in, one number out, no DOM mounting required to
 * prove it. See tests/unit/mttTickerAnchor.test.ts.
 *
 * ── 2026-08-30: THE TAB BAR MOVES, NOT THE TICKER ──────────────────────────
 *
 * Dan, with a screenshot of the club lobby: "THE TICKER MUST ALWAYS BE AT THE
 * VERY TOP OF THE PAGE, DIRECTLY UNDER THE GLOBAL HEADER, THE 'ACTION TAB'
 * SHOULD NEVER BE ABOVE IT."
 *
 * Measuring the tab bar solved the collision by pushing the TICKER down, which
 * is what put the action tab above it — the arrangement in his screenshot and
 * the one he is rejecting. The collision still has to be solved, so it is
 * solved the other way round: the ticker owns the band directly under the
 * global header, and the tab bar starts below the ticker. The bar does that by
 * reading `--mtt-ticker-h`, which TournamentStartingTicker publishes on the
 * document element and which is 0px whenever no ticker is up, so nothing moves
 * on a quiet schedule. See MultiTablePage.css and TableTabBar.css.
 *
 * The "+" this file was written to protect is protected by the same mechanism,
 * and better: with the bar starting below the ticker the two never occupy the
 * same pixels on any route, rather than depending on a measurement finding the
 * bar in time.
 */

/**
 * The elements the ticker starts below: the global header, and nothing else.
 * The tab bar is deliberately NOT here — it is the thing that moves now.
 * Two selectors because the header is `#global-header` where it carries the
 * id and a bare `header` on the routes that predate it.
 */
export const TOP_CHROME_SELECTORS = ['#global-header', 'header'] as const;

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
