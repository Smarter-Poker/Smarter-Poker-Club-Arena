# The pot's pile is restored, and it finally adds up

The horizontal mixed spread Dan asked for on 2026-09-14 merged as #4675 on
2026-09-16 at 17:53 UTC. The very next commit on main, `ea498c1fab` ("Restore
September 13 GitHub/Hetzner delivery and application baseline", #4711), whose
parent IS that squash, returned 1,568 files to the September 13 baseline and
took `PotDisplay.css`, `PotDisplay.tsx`, `tests/chips-on-the-felt.test.tsx` and
that changelog with it. Nothing has touched those files since, so the bomb-pot
report has been live in production for four days.

This restores them, and fixes two defects the original package did not reach.

## 1. The pile did not add up — on one pot in three

`visualChipStacks` takes `maxStacks`, and it is a SLICE:
`chips.slice(0, maxStacks)`. A group it slices off takes its VALUE with it. The
pot asked for six. Dan's ladder has eleven denominations, and any pot mixing big
and small chips breaks into seven or eight.

Swept across every integer pot from 1 to 200,000, six stacks drew a pile that
did not add up on **64,000 of them**. The pill said 18,888 and the chips under
it were 18,885. That is the reported defect - "CHIPS DON'T UPDATE TO DISPLAY THE
ACTUAL AMOUNT IN THE POTS" - surviving the fix that was supposed to close it,
because the collapsed CSS was only ever half of it.

`maxTotal` is the cap that belongs here: it clamps the DISCS and prints the true
count for whatever it trimmed, which is the module's documented contract.
`maxStacks` now gets the whole ladder, so no denomination is ever dropped. The
disc budget is unchanged at ten, so the spread is exactly as wide as before -
measured at 104.5px on a 393px phone, before and after.

## 2. Several clamped denominations buried each other's counts

Drawing every denomination means more of them get clamped for width: a 131,313
pot clamps four, a 987,654 pot five. Each one used to hang its own badge under
its own disc, `position: absolute; left: 50%`. Groups trimmed to a single disc
sit half a chip apart, so the badges landed on top of one another - measured at
-3.7px, two badges overlapping, in Chromium at 393px.

The pile's whole honesty contract is that you can read those counts. So they are
one row under the spread now, in ladder order, each with a rimmed dot in its
denomination's colour. Colour is the better pointer anyway: the disc a badge
pointed at was half-covered by the next chip lying over it. The number stays
gold because the 100 chip is `#1c1c2e` and tinted text in that colour is
invisible on the felt.

## 3. The memo comparator swallowed two fixes that live in this file

`PotDisplay` is `memo`'d with a hand-written comparator, and it already carries a
comment about `collectTo` having been left out of it. Two more were missing:

- `handNumber` is what expires the carried-over pot (`carriedHandRef`). A hand
  can begin on a snapshot whose `mainPot`/`streetBets`/`sidePots` match the
  previous hand's last one; the comparator then reported "equal", the reset
  never ran that commit, and the PREVIOUS hand's amount was still what the pill
  and the pile were holding.
- `awardedPot` is the last-resort push amount for a fold-around. It goes from 0
  to the won amount the instant the winner band opens, which is frequently the
  only prop changing in that commit - so the push it exists to fix was skipped
  and the pill slid a zero anyway.

`showChipAnimation` is in now too; it gates the pile itself.

The pile is drawn from `displayPot`, so a comparator that swallows these is a
pot showing the wrong CHIPS, not just the wrong digits.

## Also

React keys are `(denomination, ordinal)` - the same tuple `chipJitter` is keyed
on. The comment there promises a growing pot does not re-deal the chips already
lying in it; index keys shifted every later chip's identity the moment one
slotted into the middle, so the promise was nominal. Now it is structural.

## Proof

- `tests/chips-on-the-felt.test.tsx`: 51 tests. The pile-adds-up sweep and the
  three comparator guards were run against the unfixed code first - 3 failed on
  each, 48 passed - and pass after.
- Full client suite: 1,685 of 1,686 files pass. `legacyEngineCheckpointTransport`
  fails identically on pristine `origin/main` with this work stashed (it drives
  the Node inspector and SIGUSR1; the host is Node 26, CI is Node 22).
- Chromium at 393px against the shipped stylesheets: 10 discs, 10 distinct x
  positions, 8-9 distinct y, 104.5px spread, 19px chips - identical before and
  after, so the 2026-09-14 layout is untouched. Badge overlaps: 1 before, 0
  after.
