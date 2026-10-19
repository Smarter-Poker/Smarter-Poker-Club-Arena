# 2026-10-19 - Quick Join prints the full table name on desktop, and never runs off the screen

Finishing Dan's five 2026-10-16 screenshot fixes (#7263, #7287). Fix 4 asked
for Quick Join at twice the size because "YOU CAN'T SEE ANYTHING". The sheet
doubled, and #7287 gave the table name its own line on phones, but the desktop
row still sat the name beside its reason, stakes, seats and Join.

## What was wrong (measured, not assumed)

Rendered with the real stylesheet and fonts, using the longest live Midway Union
table names (`Short Deck 0.50/1 Madness Feeder`, 32 characters):

| Width   | Before                                                                           | After                             |
| ------- | -------------------------------------------------------------------------------- | --------------------------------- |
| 1280px  | 5 of 5 names cut, to "Short Deck ..." / "PLO 0.25/0...."; no row said which game | 0 of 5 cut                        |
| 393x852 | 5 of 5 names cut ("Madne...", "Classi...")                                       | 0 of 5 cut, balanced 2 lines      |
| 375x667 | sheet ended 104px below the screen; last rows and Browse Full Lobby unreachable  | sheet stays on screen and scrolls |

The desktop rows also carried an empty band under each Join: the console
body's 3cqw child spacing sat above every engraved rule (37px below a row,
18px above the next name).

## What changed (`src/pages/MultiTablePage.css` only)

- The row wraps at every width: the name takes the full row, the reason under
  it, then stakes and seats with Join at the right. Phones keep their doubled
  type unchanged.
- The name wraps onto a second line (`text-wrap: balance`) instead of an
  ellipsis.
- The sheet has `max-height: calc(100dvh - 56px - safe area - 12px)` and
  scrolls, frame and all.
- Rows after the first take the body spacing back (`margin-top: -3cqw`), so
  each rule sits halfway between two rows.

No markup, handler, animation or painted art changed. Pinned in
`tests/unit/quickJoinIsTwiceAsLarge.test.ts`.

## The other four fixes, re-verified 2026-10-19

The 20/10-minute bomb pots are real in play, not only in the copy: over the
3 hours before this change, Action tables dealt a bomb pot every 20.1 minutes
(median, 278 bomb pots on 36 tables) and Madness every 10.4 minutes (620 on 42
tables). All 43 open Action tables are configured at 1200 seconds and all 47
Madness tables at 600 seconds.
