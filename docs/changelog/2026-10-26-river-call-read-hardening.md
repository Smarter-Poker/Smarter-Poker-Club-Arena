# River call read: journal, hi-lo, and calibration fixes (2026-10-26)

A line-by-line review of #8160 (horses learn what a river caller showed down)
found three defects before it reached the live engine. All three are fixed
here.

## 1. The decision journal refused every v6 read frame

`horseRetainedPlanContext` (horseDecisionJournal/effects.ts) listed the read
frame versions it admits, v2 through v5. #8160 added v6 (river-call counters)
without adding it there, so every decision whose read frame carried a river
call counter - nearly every decision, once any actor has one shown call - was
ruled `invalid`: `decision_effects_invalid` in review, "invalid retained plan
identity" in replay, and a refused phase-7 proof. Live play was unaffected
(the journal is the audit path), but the audit would have gone dark. v6 is now
admitted under the same allocation rules, with a test that fails without it.

## 2. Hi-lo and multi-board hands polluted the read

The showdown hand name is the HIGH half only (PLO8, FLO8) and board one only
(double-board bomb pots, run it twice). A nut-low river call read as "one pair",
and both games share the Omaha bucket. The settlement path now marks such a
hand `riverCallSample: false` (hi-lo variant, or any second board), the worker,
the observer path and the league carry it through, and HorseMind takes no
river-call sample from it. HorseLogic does not apply the read on a hi-lo or
multi-board river either.

## 3. The 0.5-over-5 bar fired on ordinary callers

Measured on production (heads-up showdowns whose loser called the river; shown
calls by recorded name, mucked calls by evaluating the caller's own cards,
because the engine tables all of them from 2026-10-27): one pair or worse is
0.40 of hold'em river calls, 0.11 in short deck and 0.04 in Omaha. A fixed 0.5
over five samples fired against about a third of ordinary hold'em callers by
chance. The read now fires only when a player's rate in THIS game's own bucket
clears their family's base by 0.25 over at least 12 shown calls (about one
ordinary hold'em caller in eighteen), and scales to full strength over the
next 0.20. Constants and the measurement live beside `RIVER_CALL_WEAK_BASE` in
HorseMind.ts.

The read also has its own switch, `riverCallRead`, with its own league
ablation (`river_call_read`), instead of riding `v23Reads`.

No horse is treated differently from a human anywhere in this change.
