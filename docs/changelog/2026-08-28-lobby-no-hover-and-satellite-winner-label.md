# The lobby has no hover at all, and the satellite mark says what it means

Dan, 2026-08-28:

1. "REMOVE ANY AND ALL HOVER EFFECT FROM THE ALL, MTT, NLH, PLO, LIMIT,
   SPINS, AND HEADS UP LOBBY PAGES."
2. "ADD 'SATELLITE WINNER' BEFORE EACH SATELITTE ICON."

## 1. No hover in the lobby — all of it, not just the popouts

The earlier sweep removed hover MOTION estate-wide (500 transforms, 266
shadows). This removes what was left on the lobby specifically: colour,
background, border, glow — every hover rule on that screen.

All seven names are one surface. `ALL`, `MTT`, `NLH`, `PLO`, `LIMIT`, `SPINS`
and `HEADS UP` are categories of `LobbyCategory` rendered by the same
`.club-home` page through `LobbyTable`, so this is one fix, not seven.

**34 hover rules deleted** across the eight stylesheets that dress that
screen: `ClubHomePage.css`, `LobbyTable.css`, `GameLobbyPanel.css`,
`AdvancedFilters.css`, `CasinoPlaque.css`, `LobbyAdStrip.css`,
`TournamentLobbyCard.module.css`, `TournamentLobbyPage.module.css`.
Comment-safe: the parser blanks `/* … */` before matching, because a previous
attempt at this matched a `:hover` mentioned inside a comment and cut a
stylesheet in half.

Two of the 34 were selector lists pairing `:hover` with `:focus-visible`.
Only the `:hover` half was dropped. Keyboard focus is not a hover effect —
it is how someone tabbing through the lobby knows where they are, and taking
it away would be a different and worse bug.

Deletion cannot reach hover rules that live in the three global stylesheets
and key on generic names. All 25 were audited; after the popout sweep exactly
two can still change anything a lobby element matches
(`.btn-primary:hover:not(:disabled)` and `::-webkit-scrollbar-thumb:hover`),
and both are pinned back to their resting values in a scoped block at the
bottom of `ClubHomePage.css`. `.card:hover`, `.tab:hover`, `a:hover`,
`.hover-lift` and friends are deliberately NOT reset: no lobby component
renders those classes — checked by grep — so resetting them would be dead CSS
that reads like protection. The block says what to do if that changes.

Residual `:hover` in lobby stylesheets: **0**.

### One test pinned the behaviour, and is updated in this same commit

`lobbySweepFixes.test.ts` asserted `.lt-row.is-mine:hover` existed, so a row
you are seated at still lit up like its neighbours. That assertion is now
false by instruction. It was never really about hover, though — it was that a
seated row must not look different from its neighbours by accident — so it now
pins the rule that survives the removal: no lobby row has a hover state,
seated or not. Same worry, correct shape.

## 2. "Satellite Winner" now appears before the dish

The icon alone was a rebus: you either knew what a small blue dish meant or
you hovered to find out — and hover is precisely what was just removed from
these surfaces, so on a phone the meaning was unreachable.

`SatelliteSeatBadge` now renders the words then the dish. Because the visible
text carries the meaning, the image is `alt=""` and `aria-hidden`: giving both
the same string makes a screen reader say "Satellite Winner Satellite Winner".

`white-space: nowrap` is load-bearing — the badge sits in `.et-marks` beside
the RE / RB / ADD-ON pills, and a break would stack "Satellite" over "Winner"
and double the height of one row in a list of 52px rows.

At 420px the label stays and tightens (9px, 26px icon) and `.et-marks` widens
from 84px to 148px. The name column ellipses into the difference, which is the
cheaper loss: a truncated name is still recognisable, a missing mark is not
there at all. The widening lives in `EntriesTab.css`, which owns `.et-marks` —
setting it from the badge's own stylesheet too would leave two files writing
one selector at equal specificity, with the winner decided by import order.

**Measured in production before shipping**, with the real markup injected into
the live page: badge 127.5px wide inside the 148px allowance, badge height
30px, and every affected row still exactly 52px. No wrap, no row growth.

## Checks

`npx tsc --noEmit` exit 0. `npx vitest run tests/` — **551 files, 8,461 tests,
all passing**, including the rewritten lobby assertion and both binding law
suites.
