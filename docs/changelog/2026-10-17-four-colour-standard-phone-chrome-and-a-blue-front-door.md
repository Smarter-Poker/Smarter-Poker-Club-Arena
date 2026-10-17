# 2026-10-17: four-colour standard, bigger phone chrome, and a blue front door

Three of Dan's four Club Arena changes from 2026-10-17. The fourth (a 25 second
bomb pot clock) is an engine change and ships on its own branch.

## 1. "USE THE 4 COLOR DECK AS THE STANDARD"

- `DEFAULT_TABLE_USER_SETTINGS.fourColorDeck`, the Settings panel default and
  the settings bridge default are `true`. Traditional is the switch turned off,
  and both switches now say so ("Standard Deck. Turn Off For The Traditional
  Two-Color Deck").
- The store persists its whole object on every write, so a stored `false`
  proves nothing about what a player wants. The same hostile-state rule as
  auto-muck: `fourColorDeckExplicit` is set only when the player sets the deck,
  and the loader lifts any other stored `false` to four colours. A deck the
  account chose on another device (`settings_touched`) is explicit here too.
- `useDeckStyle` and `getCardImagePath` resolve the same way, so a page that
  draws cards before the store loads cannot disagree with it.
- Migration `20261017111532_four_colour_deck_is_the_standard.sql` moves the
  column default to `true` and lifts every row holding the old default that the
  account never touched. Rows that chose a deck are left alone (the
  `card_slide` precedent, 20260905001550).

Pinned by `tests/unit/fourColorDeckIsTheStandard.test.ts` and
`tests/user-table-settings-defaults.test.ts`.

## 2. "ON MOBILE THE HEADERS AND FOOTERS ARE TOO SMALL"

Both bars are single painted rows that scale with the viewport width, so on a
393px phone the header was 40px and the footer 48px. Neither can grow without
growing wider, so below 601px each now has a phone plane cut from its own
master by art surgery - no redrawn controls, every icon at native scale:

- **Footer** `club-arena-footer-mobile-v1.webp` (1531 x 256): the v3 master with
  the Diamond Spins cell composited where the overlay paints it, and one whole
  77px quilt period removed from each of the five gaps between cells, so the
  quilting stays continuous. Frame 1481 x 230: **61px at 393px, +27%**. The page
  reserve `--bottom-nav-height` moves to `15.53vw` at the same breakpoint.
- **Header** `global-header-mobile-v1.png` (1435 x 168): the wordmark plate
  rebuilt narrower around a 0.62-scale Smarter.Poker, plus seven straight-run
  gap trims. **46px at 393px, +15%**. Every hit region is its desktop region
  carried through the same column map; the profile mask law is resolved on the
  new plane (ornament centre x 976.75).

## 4. "YELLOW IS NOT A APPROVED COLOR ... WHEN JOINING A CLUB"

The invitation page (`InvitePage`, `InviteCodePage`) traded its gold accent for
the schema's lit blue ramp (`#9ecbff` / `#45adff` / `#1877f2`): logo ring,
tagline, member chip, the club's name in the invitation, the pending notice and
the plaque. The Join Club console prints pending and status lines in blue. The
no-yellow law now covers both join surfaces.
