# 2026-08-30 — The rest of the black, and the route-art machinery that outlived its pseudo-element

Follow-up to `2026-08-30-ticker-above-the-action-tab-and-one-black.md`. That
change made the route shell, the app shell, the body and the action bar one
black. Three surfaces were left over, and one piece of machinery was left
computing an answer nobody reads. Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE
... IF THERE ARE ANY THAT YOU CONSIDER 'HIGH RISK' FOR DAMAGING CODE OR OTHER
PAGES, DO NOT BUILD THEM."

## 1. `.multi-table-page` and its three full-bleed states — `#0a0c12` to `#000`

This is the shell BEHIND the felt, and the strip either side of the table on a
wide screen. It is a page ground, not a raised surface, and `#0a0c12` was a
visibly different black now that everything around it is true black. The three
states that replace it full-bleed take the same value for the same reason —
each one fills the screen on its own:

- `.multi-table-page` (the shell)
- `.multi-table-page__loading`
- `.multi-table-loading`
- `.multi-table-page__crashed`

## 2. `.lobby-top` — `#02060b` plus a white seam

The strip carrying the club card and the wallet, immediately under the ticker,
so it is the first thing the eye compares against everything around it. It was
doing two things wrong at once: `#02060b` is a different black from
`.club-home` (`#000`) directly beneath it, and a `rgba(255,255,255,0.06)` bottom
border drew a visible line across the page between the two.

Both fixed. The border stays **declared**, in black: that 1px is part of the
rule's height, and the "1 pixel under the ticker" geometry Dan asked for on
2026-08-24 was measured with it in place. Removing it would have moved the club
card up by a pixel and quietly undone that.

The rest of `ClubHomePage.css`'s near-blacks (`.lobby-club`, the share button,
the bordered tiles) are deliberately untouched. Those are raised component
surfaces, which is what a raised surface is for.

## 3. The route-art machinery is deleted

`AppLayout.tsx` still ran a six-entry `ROUTE_ART` map, a `getCasinoZone(pathname)`
classifier, a `--casino-route-art` custom property and a `data-casino-zone`
attribute on every navigation. The pseudo-element that consumed them,
`.casinoStage::before`, was deleted earlier the same day — so all of it was
computing an answer nothing read.

Deleted rather than left running into nothing: a classifier with no consumer is
a trap for the next reader, who has to prove it is dead before touching anything
near it. `AppLayout.module.css` keeps the note describing what a themed stage
would need if one ever comes back. **No asset was removed** — `bg-vault.jpg`
alone still has eight other consumers (the hamburger menu, profile, public
profile, the legal layout, HomePage, and the rewards and account headers).

## Deliberately NOT built

- **The other eight `bg-vault.jpg` surfaces.** Making the whole app black rather
  than the Club Arena lobby is a product decision, not a bug fix, and it would
  change the look of profile, legal, home and the hamburger menu in one commit.
  Flagged for Dan rather than done.
- **The `backdrop-filter` sweep.** 1,026 declarations across 319 stylesheets.
  Each is a compositor layer, and the two removed today were real wins, but a
  blind sweep across that surface area would change how hundreds of components
  render. It needs profiling to find the ones that actually cost, not a
  find-and-replace.

## Pins

`tests/unit/mttTickerAnchor.test.ts` gains two:

- **every page GROUND is the same black** — `#0a0c12` is gone from
  MultiTablePage.css, `.lobby-top` is `#000`, no `rgba(255, ...)` bottom border,
  and the 1px border is still declared so the height arithmetic holds.
- **the dead route-art machinery is deleted** — no `ROUTE_ART`,
  `getCasinoZone`, `--casino-route-art` or `data-casino-zone` in AppLayout.tsx,
  while `styles.casinoStage` stays (the class still carries the typography,
  focus and table rules the pages depend on).

Both strip comments before matching, so the files can explain what they removed
without failing for naming it.

`tsc --noEmit` clean. Full suite green: 655 files, 9593 tests.
