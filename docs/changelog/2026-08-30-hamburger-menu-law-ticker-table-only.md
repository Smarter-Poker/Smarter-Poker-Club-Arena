# 2026-08-30 — Hamburger Menu Law: Ticker Table-Only, Title Case, Route Connectivity

Dan, verbatim (three rules, all shipped in one change):

1. "WHEN YOU OPEN THE HAMBURGER MENU INSIDE THE CLUB ARENA, THE TICKER SHOULD
   NEVER APPEAR OVER THIS, THIS SHOULD EVER ONLY APPEAR WHILE LIVE AT A TABLE,
   NOT ANYWHERE ELSE."
2. "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU MUST BE
   CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE."
3. "MAKE SURE EVERY PAGE AND SUBPAGE IS FULLY BUILD OUT AND ACTUALLY CONNECTED
   AND FUNCTIONAL."

## What changed

### 1. Ticker: /table/* only, and never over the drawer

- `TournamentStartingTicker.tsx`: the route gate `insideClub` (`/clubs/*` OR
  `/table*`, Dan 2026-08-21) is superseded by `atLiveTable` — `/table*` alone.
  Club lobbies, the home page and every other surface render no ticker at all.
- `HamburgerMenu.module.css`: `.backdrop` 1100 → 9450, `.drawer` 1200 → 9500.
  The ticker is z-index 9400, so even at a live table an open hamburger menu
  now covers it; dialogs (9600+) still sit above the drawer.

### 2. Title Case enforced in the drawer's render path

- `HamburgerMenu.tsx` imports `formatPopupText` (the house popup transform,
  Dan 2026-08-20) as `tc` and applies it to every group label, nav label, nav
  description, pinned/recent chip, and the club-role chip. Inline lowercase
  literals (context status lines, search placeholder) rewritten to Title Case.
- Render-path enforcement, not a convention — same reasoning as the Toast
  layer: strings written by many agents drift; a transform in the render path
  cannot.

### 3. Every menu destination verified connected

- Audited every path in `clubArenaNavigation.ts` (all groups, staff and
  platform-staff variants, plus `CLUB_ARENA_SUPPORT_NAV`) against the routes
  declared in `App.tsx`. All 26 non-external destinations resolve to declared
  routes. `Messages` is external (World Hub Messenger) by design.

## Enforcement

`tests/unit/hamburgerMenuLaw.test.ts` pins all three: the `/table`-only gate
(and the absence of the old `/clubs/` term), the drawer-above-ticker z-index
ordering, the `tc()` wrapping at every label render site, and one test per
menu destination asserting it matches a declared App.tsx route — so an agent
adding a menu item without a route turns the suite red.

## Verification

- `npx tsc --noEmit` exit 0.
- Targeted suites green (128 tests: hamburgerMenuLaw, mttTickerAnchor,
  tickerRegistrationPredicate, action-bar-never-leaves, unionSurfacesAreSealed,
  tableSettingsAreOneStore, SettingsPageBridge, discardedErrorReadRatchet).
- Full `vitest run tests/` run before push via the pre-push hook.
