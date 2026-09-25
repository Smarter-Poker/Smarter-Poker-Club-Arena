# The sweep lands in the pot

Dan 2026-09-23, first list, item 6: "THE CHIPS ARE NOT BEING MOVED OR
'SHIPPED' TO THE CORRECT POSITION OR PLAYER AFTER A HAND IS COMPLETED." Held
open in #5170 as unreproduced. Found by reading the two halves of the pot
against each other.

## The cause

At the end of every street the seats' bet chips sweep "into the pot"
(`.seat__bet-chips` collect keyframe, offsets from `chipCollectOffsetPx`).
That function converged every seat on `feltCenter()`: the middle of the felt,
y 49% of the scaler, on the board and the wordmark. The pot pill has stood at
y 23% of the scaler since 2026-08-28 (`.table-page .pot-area { top: 23% }`,
Dan: moved so the top seat's bets never touch it). So every hand, every bet
flew to a point a quarter of the table BELOW the pill, vanished there, and
the pill then shipped to the winner from where it actually was. The comment
on `CHIP_COLLECT_FRACTION` still read "the pot is in the middle".

The pot-to-winner flights were right the whole time: they aimed at
`POT_ANCHOR_PCT` in TablePage.tsx, a constant the collect never saw.

## The fix

`POT_ANCHOR_PCT` lives in `tableGeometry.ts` now, one anchor for chips going
in and chips coming out; `chipCollectOffsetPx` converges on it and TablePage
imports it. `tests/unit/theSweepLandsInThePot.test.ts` pins the anchor to the
two CSS declarations that place the pill, proves it is not the felt's centre,
and checks every seat on every ring lands 0.9 of the way to the pill at three
table sizes (26 of its 27 cases fail on the previous code).

Also in this change: the console's corner X steps down on the shark family,
whose clear glass beside the pill is only 32 columns wide.
