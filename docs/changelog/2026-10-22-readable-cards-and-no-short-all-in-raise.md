# Readable Cards And No Raise After A Short All-In (2026-10-22)

Three reports from Dan on one PLO6 Madness hand.

## Hero cards: every rank and suit shows

The private PLO row stepped 0.42 / 0.34 / 0.30 of a card for PLO4/5/6, and the
deck's corner index reaches 38% of a card, so on PLO6 every suit was cut in
half. Every hand size now steps 0.45 of its own card and the card size comes
down so the row keeps the lane beside the hero (PLO4 1.00, PLO5 0.80, PLO6 0.69
of the shared card).

## Villain showdown cards: board-sized, overlapped, readable

A shown hand was squeezed into the width of the name plate (six 10px cards on
PLO6). It is now drawn at the board's own card size, published from the felt as
`--sp-board-card-w`, overlapped at 0.45 of a card with each card painted over
the one to its left so every corner index stays whole. The existing protected
layout moves the row off the board, pot and plates.

## Fold or Call only when the betting is not reopened

The hero bet 53.50, a short stack shoved 63.49 (a 9.99 raise, under the 53.50
a full raise needs), and the bar offered Raise. The engine refuses that raise
(TDA 44/47). `src/lib/raiseReopen.ts` applies the same rule on the client; both
wager gates read it, All In past the call goes with it, the bar draws Fold and
Call only, and an open sizing slider closes.

Laws: `tests/every-hole-card-index-is-readable.law.test.ts`,
`tests/a-short-all-in-never-offers-a-raise.law.test.tsx`.
