# 2026-08-30 — The PLO scale bug was not confined to PLO

Dan: _"CHECK FOR THIS BUG EVERYWHERE ELSE AS WELL, FOR ALL GAME VARIATIONS
AND STAKES."_

Swept all seven live variants. **Two more were broken, in the opposite
direction from PLO, and nothing was watching for either.**

## The bug class, stated once

`decidePreflopV7`'s thresholds are PERCENTILE-INTENT: a bar at `t(0.62)`
means "roughly the top slice of the range", not "an absolute score of 0.62".
Every variant has its own scoring function with its own distribution. Feed a
bar calibrated on one distribution a score drawn from another and the bar
silently means something else — no error, no warning, no failing test.

## What the sweep found

Measured through the real `decide()`, identical spot, 300 deals per cell:

| variant            | median    | opens    | facing a pot raise     |
| ------------------ | --------- | -------- | ---------------------- |
| nlh (reference)    | 0.232     | 22%      | fold 48%               |
| plo4               | 0.240     | **4%**   | fold 64%, **raise 0%** |
| plo5 / plo6 / plo8 | ~0.23     | **7–9%** | **raise 2–3%**         |
| short_deck         | **0.420** | **40%**  | **fold 23%**           |
| pineapple          | **0.493** | **51%**  | **fold 15%**           |

PLO could not reach a raise bar at all — Dan's live report. Short deck and
pineapple cleared every bar far too easily: a 36-card deck and a three-card
hand make every hand better in ABSOLUTE terms, which both score functions
correctly say, and which a percentile-intent bar must never be asked to
interpret. A pineapple horse folding 15% to a pot-sized raise is as wrong as
a PLO horse folding 64% — it just fails in the direction nobody complains
about.

## The fix, applied uniformly

Every variant's preflop strength is now mapped onto the hold'em scale **by
quantile** before it reaches a threshold:

- Omaha (plo4/5/6/8, hi and hi-lo) — through the existing 16,384-combo
  reservoir, shipped earlier today.
- Short deck — **exact** CDF, all 630 two-card combos of the 36-card deck.
- Pineapple — **exact** CDF, all 22,100 three-card combos.

Both new CDFs are enumerated once and cached, not sampled. Cost per decision
is one binary search; there is no I/O and nothing added to the hot path.

Variant intent stays where it is already explicit and reviewable: the V8
style overlay in `HorseLogic` (Omaha tightens 1.03 and trims slowplay, short
deck trims bluffs). It must never live in an uncorrected scoring range,
because there it is invisible and unbounded.

### After

| variant    | median | opens | facing a pot raise |
| ---------- | ------ | ----- | ------------------ |
| nlh        | 0.232  | 22%   | fold 48%           |
| plo4       | 0.225  | 19%   | fold 60%           |
| plo5       | 0.237  | 18%   | fold 56%           |
| plo6       | 0.234  | 21%   | fold 56%           |
| plo8       | 0.225  | 20%   | fold 61%           |
| short_deck | 0.225  | 21%   | fold 51%           |
| pineapple  | 0.246  | 20%   | fold 51%           |

Seven variants, one yardstick. PLO sits a touch tighter, which is the V8
overlay doing exactly what it says.

## Left alone, deliberately

`decideDiscard` still calls `holdemPreflopScore` raw. It compares the three
possible two-card keeps and takes the max — a purely RELATIVE comparison, so
the scale cancels. Normalising it would cost work and change nothing.

## Stakes

The scoring functions never read the blind level, but the sizing path does:
`chipStep()` snaps to whole chips in cash games, so a micro blind puts every
legal raise on a coarse grid. If that grid ever swallowed a raise the fleet
would look stuck at one stake and healthy at another — the hardest kind of
report to act on. Replayed the same spots at **bb = 0.10, 0.50, 2, 100 and
10,000** for all seven variants: opening frequency varies by less than 15
points across that whole range, and no decision mass goes missing (which is
how an illegal action would show up). No stake-dependent defect found.

## The guard

`HorseVariantScaleParity.test.ts` — 35 tests. For every live variant it
asserts the strength distribution matches hold'em's shape (median within
±0.10, and a top of range that actually REACHES the high bars — the precise
thing PLO could not do), that opening frequency is in hold'em's league, that
the 3-bet valve is not stuck shut and the fold valve is not stuck open, and
that all of it holds across five stakes.

**Proven to fail for the right reason.** Reverting the mappings makes it
report, in its own words: `plo4 opens 4%`, `plo4 3-bets 0%`, `plo5 3-bets
2%`, `plo6 opens 9%`, `short_deck median 0.415`, `short_deck opens 43%`,
`short_deck folds 20%`, `pineapple median 0.493`. That is the whole class of
bug caught by one file, for every variant, including any variant added later.

Assertions are PARITY against hold'em rather than frozen frequencies, so a
future retune of the bars moves them all together and this file keeps
meaning the same thing.

## Verification

- `tsc --noEmit` exit 0.
- Full server suite: **234 files, 2,624 tests, all passing**, including
  `HorseLeague` (zero illegal actions across a full matchup) and the chip
  conservation property tests.
