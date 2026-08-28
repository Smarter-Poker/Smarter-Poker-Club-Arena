# No hover popouts, anywhere. And the entries list fills its own panel.

Dan, 2026-08-28: "remove all 'hover effect' when you are on the mtt or any
other pages."

## 1. Hover motion is gone estate-wide, not just on the tournament card

An earlier pass deleted `transform: translateY(-6px) scale(1.01)` from
`TournamentLobbyCard`. That fixed one card. A sweep of every stylesheet in
`src/` found **501 more hover rules that moved an element**, across 266 files
— buttons, rows, tiles, seats, modals, the hamburger menu, the action panel.
Fixing them one file at a time was how the first one got missed, so this was
done mechanically over every `:hover` block in the repo.

WHAT WAS REMOVED, precisely:

- Inside a `:hover` block, any `transform` whose value contains `translate`,
  `scale`, `rotate` or `perspective` — 501 declarations.
- The `box-shadow` in those SAME blocks — 266 declarations. A lift and its
  drop-shadow are one effect; removing the lift and keeping the shadow leaves
  a glow with nothing under it.

WHAT WAS DELIBERATELY KEPT: hover changes to colour, background, border and
opacity, and `cursor: pointer`. Those tell you a thing is clickable without
moving it. Dan's complaint is the popout, and a row that cannot show it is
under the pointer is a different bug.

HOW, and why it is safe: the declaration is DELETED from the hover block
rather than overwritten with `transform: none`. Several of these elements
carry a base transform — `translate(-50%, -50%)` centring, most commonly —
and `none` would have yanked them out of position the moment the pointer
touched them. Deleting the hover declaration leaves the base transform
untouched and simply stops the element moving. Empty blocks left behind were
dropped.

Also removed: 10 JS-driven `e.currentTarget.style.transform = 'translateX(4px)'`
hover handlers in `HamburgerMenu.tsx`, which CSS could not have reached.

Residual count after the sweep: **0** hover blocks in `src/` with a motion
transform.

## 2. The entries panel had 340px of dead space

Visible in Dan's screenshots as a large empty area under the last row.

`.et-scroll` carried `max-height: min(58vh, 520px)` while the tab body
stretches `.et-panel` to whatever the modal gives it. Measured on production
before the change: panel **860px**, list **520px**, list content **1108px**.
So a third of the panel was empty while the list inside it was scrolling.

A cap is the wrong tool for "do not exceed the panel" — the panel already
knows its height, and the list only has to fill it. `.et-panel` becomes a flex
column and `.et-scroll` takes the remainder. `min-height: 0` on both is
load-bearing: a flex item defaults to `min-height: auto` and refuses to shrink
below its content, and an overflow container that cannot shrink does not
scroll, it pushes the footer off-screen.

The 420px `max-height` was DELETED rather than left alone. It sits earlier in
the file at the same specificity, so it could never have won against the new
rule — a cap that cannot fire only misleads whoever reads it next.

Verified against production BEFORE shipping: the same CSS injected into the
live page moved the list from 520px to 726px in the 860px panel, 9 visible
rows to 12, no dead space, footer still pinned.

## Checks

`npx tsc --noEmit` exit 0. `npx vitest run tests/` — 549 files, 8446 tests,
all passing, including `animations-always-play.law.test.ts` (20) and
`no-auto-table-switch.law.test.ts` (5). Section 10.6 is untouched by this:
the animation law governs animations that are OWED and must play, and a hover
popout is not owed to anyone.
