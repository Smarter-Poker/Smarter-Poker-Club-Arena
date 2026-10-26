# PLO5/PLO6: no full house on a paired board folds to a committing bet

## What Dan saw

Madness PLO5 1/2 + BB ante, Kings Club / Midway Union, 2026-10-25 21:55 UTC.
The horse seated as DETLegend held Th Qd 6d Qc 7d. Flop 6h 7c Jd: it called a
pot-sized bet. Turn Js paired the board. A human shoved 190.52 into 375 and
the horse called with two pair (queens and jacks), losing 355.52. Dan: "IT'S A
FOLD 100% OF THE TIME". The review row for the hand carried no leak tag.

## Why it called

The hand is V40 class `board2p` (a pocket pair over the board's pair). Its
equity cap is 0.30, plus 0.04 before the river, minus 0.05 per extra heat
signal: about 0.29-0.34 here. The shove asked for 25.2%. A cap that sits above
the price is a call, so the brain called. Replaying the recorded spot on the
previous code returns `call`.

## The fix

`server/src/engine/HorsePloPairedBoardFold.ts`, applied in `HorseLogic.decide`
after every other layer. In PLO5 and PLO6, on a paired turn or river, a horse
whose best hand is below a full house turns a call, raise or all-in into a
fold when the bet is committing: the bettor is all in, the call is a quarter
or more of the horse's stack, or the call leaves it all in. The horse keeps its
own think time so the fold does not snap.

Left to the brain on purpose: the flop, PLO4 and hold'em (not part of the
ruling), hi-lo and multi-board pots (half a pot or one board is a different
question), and a token call needing under 15% equity, so a horse with a few
chips behind never folds a flush to a shove for two of them.

## Pinned

`server/src/engine/HorsePloPairedBoardFold.law.test.ts` replays the recorded
hand across five seeds and every horse style (fold), the river and PLO6, trips,
straights and the nut flush (fold), boats and quads (keep calling), and the
unpaired board, flop, PLO4 and token-call exemptions. Two historical tests
ablate the new rule so they still measure only what they were written for:
the V40 "with V40 off it called" control passes `ploPairedBoardFold: false`,
and the opponent-exploit neutrality corpus mocks the module, the same way it
isolates the other later Omaha policies.

Engine change: activates at the daily 04:00 America/Chicago engine update.
