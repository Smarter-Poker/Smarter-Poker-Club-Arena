# The felt answers Dan's two lists

Dan sent two lists on the evening of 2026-09-23, nine items and then eight,
each with a screenshot from a live table. Sixteen are fixed here, at the
source, with a regression check each. One (chips shipping to the winner after
a hand) is not reproduced yet and is not changed; see the end.

## The first list

1. **"Shark Club" on one line.** The identity row may wrap so a name is never
   abbreviated, but the union span was nowrap and carried the separator, so the
   only break opportunity was the space inside the club's own name. Both names
   are unbreakable units now and the one breakable space is between them
   (`.table-brand__club-name`).
2. **The side-menu note printed under the felt.** A bare `/* ... */` between
   two JSX elements is a text node, and React rendered the paragraph to every
   player. It is a `{/* */}` now, and `tests/unit/noBareCommentsInJsx.test.ts`
   parses every `.tsx` under `src` with the TypeScript compiler and fails on
   the next one.
3. **VPIP badge without frames.** The plaque (bezel, face, inner frame,
   readout window, blue lights, CURRENT caption) is gone. Three rows: VPIP, the
   live figure, MIN N%. Same single size input, same tabular figures, same
   no-pass/fail-colour rule.
4. **The dealer button on will.marino's chips.** `MARKER_MIN_GAP_WIDTH_PCT` was
   written as 6 when the button was 4.0% wide; the button doubled on 09-04 and
   the number stayed, leaving two pixels between the puck's rim and the chip.
   It is derived now: both radii plus a chip of daylight (9%).
5. **Pot 4.97 at 1/2.** The pill's count-up interpolated a raw float and
   printed every frame. Every intermediate frame now lands on the coarsest
   grid both ends sit on (whole chips between whole numbers, cents otherwise);
   `thePotCountsInChipsThatExist` drives the tween frame by frame.
6. **Chips shipping to the winner: not changed.** See the end.
7. **6-max sits lower.** The 960-canvas rings were pinned to the container's
   top with all their saved length under the felt. They drop 18px, paid for on
   both bindings so the hero's plate never meets the action bar.
8. **BBJ frame thinner.** 2px outer + 1px inner bezel + highlight read as one
   4px band. Hairline outer bezel, inner bezel retired.
9. **Raise 4, not Raise 4.00.** The action badge and the stack-change float
   printed through the STACK formatter (penny precision under 100). A wager is
   `formatTableChips`: integers clean, real fractions kept.

## The second list

1. **Seat Held is an internal clock.** The waitlist card no longer prints the
   countdown; the hold still expires on the server's instant and the card
   still turns urgent inside ten seconds.
2. **The board is always above the wordmark.** `--sp-brand-top` was the
   masthead's CENTRE, so every extra row (a wrapped club, a hand number, a
   bomb-pot clock) pushed the wordmark half a row up into the board. It is the
   block's TOP edge now (56%, translate on X only) and the block only grows
   downward. The multi-board anchors (59% / 64%) and the connection banners
   are re-derived from it; the dealer button's masthead keep-out mirrors it.
3. **The profit chip needs two cash games.** The gate counted every game table
   and only then dropped tournaments from the sum, so an MTT beside one cash
   table printed a "0". Both counts are cash counts.
4. **Post Or Wait has a solid back.** The spade master's `mid.png` is
   transparent between its rails and the plates foot is transparent above its
   closing rail; over a felt the board printed through the copy. The console
   lays the master's own glass tone under the art, inset to the rail interior.
5. **Waiting For BB, not Sitting Out.** The engine flags every held entrant as
   sitting out. The seat now takes `entryWait` from the two engine lists the
   hero's footer already reads: held and unanswered says "Waiting For BB";
   agreed to post draws no badge.
6. **An X in every popup's corner.** `SpadeConsole` takes `onClose` and prints
   a lit x in a measured clear-glass zone per family; every table, wallet,
   club and hand popup passes its close handler. Foot plates and words stay.
7. **Previous Hand was cut off.** The console was taller than the 75dvh sheet
   and the sheet was the scroller, so the browser settled on the bottom. The
   sheet no longer scrolls; the console fills it, head and foot keep their
   ratio, and the page (`.hdm-body`) is the one scroller.
8. **Maintenance pill at the bottom.** It was `top: 12px`, in the status bar.
   It hangs from the bottom edge inside the home-indicator inset.

## Not changed: chips shipping to the winner (first list, item 6)

Read end to end - `pot_win` -> `seatPositions` (physical-seat indexed, hero
rotation applied once) -> `seatPctToViewportPx` -> the fixed chip layer as a
sibling of the scaler - and nothing in the code names the seat wrongly. The
one thing that could displace every flight is a transformed ancestor of the
chip layer, and at rest there is none. Without watching a hand end in
production this is not a fix, so nothing here claims one. It stays open and
is taken up the moment a live showdown can be observed.

## Verification

`tsc --noEmit` clean; eslint 0 errors on every changed file; title-case and
painted-text gates OK; prettier clean; vitest in shards with every failure
accounted for: seven existing tests updated to Dan's new rulings (the VPIP
plaque lock, the BBJ bezel measurement, the masthead anchor, the "no corner
dismiss" pin on the player locator, the puck-on-plate count, and three that
now find two buttons named Close).
