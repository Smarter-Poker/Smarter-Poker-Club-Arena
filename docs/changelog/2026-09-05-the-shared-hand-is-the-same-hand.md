# 2026-09-05 - Phase 4 deep dive: four things the share link changed on the way

Phase 4 (`30702e1af`, live) made a share link carry the sharer's own
reconstruction and rebuild it at the far end. The tests written with it assert
that each field ARRIVES. That is a weaker claim than the one the feature makes,
which is that **nothing changes on the way**, and the gap between those two
sentences held four defects - three of them money.

## How they were found

A DIFFER, not more assertions: build the model, encode it, decode it, rebuild
it, and compare every figure a player can read - every street, every row, every
pot line, every stack, every payment. Then run it over **38 real hands pulled
from `hand_history`** (anonymised) covering NLH, PLO4/5/6, PLO8, FLO8, short
deck, pineapple and limit hold'em, with run-it-twice, bomb pots, per-board and
per-half awards, antes, straddles, discards, side pots, returned bets, rake and
jackpot drops.

Thirty-three of the first thirty-eight diverged. `tests/unit/shareLinkCarriesTheWholeHand.test.ts`
is that differ, kept.

## 1. A shared fold-around grew a Showdown section

`ReplayModel.players[].mucked` does not mean "mucked". It defaults to "this
player has no hole cards on record", which on a fold-around is EVERYONE - the
hand never reached a showdown and nobody mucked anything. The producer sent
that flag as a muck, and the recipient's reconstruction treats a declared muck
as a seat AT the showdown.

So the most common hand shape on the platform - everyone folds - arrived with a
Showdown section listing the seats that folded, and the winner shown as having
shown down. That is the exact defect `atShowdown` in `handReplay.ts` was
written to fix on 2026-09-04 ("a six-way fold-around listed six seats of card
backs"), re-entering through the link.

The model's own showdown rows are the evidence of who was there. Only a player
with a row and no cards is a muck.

## 2. The winner of a raked run-it-twice hand was credited with the rake

`winners[].amount` is what a player was **paid**, after rake.
`winners_by_board[].amount` is the **pre-rake** share of each board. Two
different numbers, and the wire had one field for both.

Production hand #6421788: the record pays 49.74; the per-board shares are
26.12 + 26.12 = 52.24; the rake is 2.50. The recipient was told the winner
collected 52.24. On every raked run-it-twice hand the shared copy overstated
the payment by exactly the rake.

The payment now travels on the player (`ShareablePlayer.won`) and `winners`
keeps the record's per-board breakdown - the same shape the database row uses,
because that shape exists for this reason. A v1-v3 payload has no `won`, and
there its `winners` list still IS the payment, so old links pay correctly.

## 3. The returned uncalled bet moved street, and the pot line moved with it

This engine writes the returned bet with stage `showdown`. The wire had slots
for preflop, the discard, the flop, the turn and the river - and none for the
showdown - so the return never travelled. The recipient's reconstruction then
INFERRED one of its own (correctly, from the uncalled bet) and hung it on the
river.

The amount was right and the street was wrong, which moved the pot: on
production #5087420 the river's pot line read **15.52 on the shared copy where
the hand had 23.22 in the middle**, because the uncalled 7.70 had already come
back on a street where it had not yet. The wire has a showdown slot now.

## 4. Every tournament table shared under the same name

Labels were cut with `slice`, at 24 characters for a player and 40 for a table.
Measured against production:

| label       | longest real | old cap | over the cap  |
| ----------- | ------------ | ------- | ------------- |
| player name | 23           | 24      | 0 (one to go) |
| table name  | 59           | 40      | 1,484 tables  |

Tournament tables are named `DSS Wednesday $16.50 NLH Bounty Hunter - 5 PM CT -
Table 10`, so 40 characters removed **the table number**: every table of one
tournament shared under an identical truncated name, and the header of a shared
hand no longer said which table it came from.

`slice` also counts UTF-16 code units, so it splits an emoji in half. Trimming
is by code point now, and the caps are 40 / 80 / 48 with real headroom.

## What the wire still narrows, said out loud

One thing, in one place: the engine's `bomb_ante` is a verb the reconstruction
does not canonicalise, so it reaches the model as `unknown` carrying the
engine's own word. The wire has no free-text verb - deliberately - so a dead
post it cannot name travels as an ANTE, which is what a bomb ante is. Every
figure attached to it is exact; only the row's word narrows from "Bomb Ante" to
"Ante". The differ normalises that ONE case explicitly, so that if anything else
ever starts narrowing, the test says so.

## Also

- `HandReplay`'s `source` prop must be memoised, and now says so: a new source
  means a new hand, so it rewinds to the first frame - right when the hand
  really changed, fatal if a caller builds the object inline. The one caller
  holds it in a `useMemo` keyed on the payload.
- A production check that did NOT find a defect, recorded so nobody re-runs it:
  the board is never shorter than the streets played (0 of 20,000 sampled rows
  have post-flop actions with no board, a 3-card board with turn or river
  action, or a 4-card board with river action).

## Verified

38 real hands round-trip with every figure identical; the full suite green;
`tsc` and `eslint` clean; and on the live page a v4 link opens the felt for a
reader who never played the hand, `/share/hand/:id` renders the one replayer and
refuses an unreadable hand honestly, and a corrupt payload reports rather than
throws.
