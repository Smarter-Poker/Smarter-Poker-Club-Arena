# 2026-09-05 - The replayer's felt holds a four-card hand at 375px

Found verifying Phase 4 on the live page (`/replay?h=`, a PLO8 hand, iPhone
width). Not a Phase 4 regression - the felt has been drawing it this way since
Phase 3 - but Phase 4 is what put that felt on a PUBLIC page, where the first
thing a recipient sees is a hand they were sent.

## Measured

At 375px the replayer's seat is 82px wide. Its card row is not:

| holding              | row width | spill per side |
| -------------------- | --------- | -------------- |
| 2 cards (hold'em)    | 51px      | fits           |
| 4 cards (PLO / PLO8) | 106px     | 12px           |

Four 25px cards with 2px gaps is 106px, so a PLO row hung 12px past the seat
on each side. The bottom seat is the hero's, the one the reader cares about,
and there it put their own cards over the "Yours" badge that says the hand is
theirs, and under the name plate of the seat above. Hold'em never showed it,
which is why it survived Phase 3's 375px pass.

## Fixed

A real four-card hand is held FANNED, so that is what the felt does now, at
480px and below only. The cards overlap from the left, so the rank and suit -
which live in the top-left corner of a card - stay visible on every one of
them; nothing is shrunk to illegibility. The overlap is sized per holding so
each variant lands inside the seat: pineapple 61px, PLO 79px, PLO5 81px, PLO6
80px, and hold'em is left alone at 51px.

Verified on the live page by measuring the row against the seat before and
after: 106px spilling 12px each side, to 79px sitting 1.5px inside on both.
The page has never scrolled horizontally and still does not.
