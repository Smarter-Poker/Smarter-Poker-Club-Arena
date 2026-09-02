# 2026-09-02 — horse brain audit, phase 1 (V34)

Dan: "do a deep dive into the horse brain ... audit literally everything line
by line and insure this actually exists, works, and improve, enhance and
optimize it in every possible way."

Phase 1 covers the whole decision path: how a horse learns the game, its
cards, its stack, cash vs tournament, its live and historic reads, the preflop
decision, every postflop street, sizing, legalization, and the solver layers
(V27 push/fold charts, V29/V30/V31 open nodes, V32 facing-a-bet). Phase 2 —
per-variant (NLH, PLO4/5/6, PLO8, short deck, pineapple) and cash-versus-
tournament differentiation — is a separate pass.

## What was read

`ServerTableEngineTurns.scheduleHorseAction` (the only live call site),
`HorseLogic.ts` (4,361 lines), `HorsePreflop.ts`, `HorseMind.ts`,
`HorseEval.simulateEquity` and the preflop scorers, `GtoCharts.ts`,
`GtoPostflop.ts`, `GtoPostflopV31.ts`, `GtoFacingDefenseV32.ts`, the three
loaders and two aggregation drivers, `HorseMindPersistence.ts`,
`TournamentBrainContext.ts`, plus the production tables behind them
(`memory_charts_gold` 240 rows, `gto_postflop_compact` 7,694 open cells,
`gto_postflop_v31` 7 cells — V31 is waiting on the V30 river aggregation,
3.3M of 5.6M rows done — and `horse_brain_telemetry` for the last two days).

Verified as existing and wired: variant via `activeHandVariant()`, hole cards
from the engine's player object, stack + `totalInvested`, explicit
`gameMode`/`format`/ante/straddle/AoF, tournament context (ICM stacks,
payouts, bubble, bounties, blind clock), HorseMind live stats + pair
targeting + full-hand reads at settlement, DB hydration at boot, no opponent
hole-card reads anywhere in the brain.

## What was wrong, and the fix

### The postflop Aggression Factor was flushed and never saved (DB)

`20260831` added `post_aggr`/`post_passive` and the engine has sent them every
five minutes since, but `upsert_horse_mind_stats` was never taught the columns:
0 of 996 rows carried a non-zero value while the newest row was seconds old.
Every server deploy therefore reset the read the 08-31 migration was written to
fix (the maniac whose pot bets got MORE respect). Migration
`20260902232420_horse_mind_persist_postflop_af_and_river_reads` re-creates the
merge with both counters, and persists two more reads that were memory-only by
design and reset on every deploy for exactly the players they exist for:
the V23 fold-to-river-bet frequency and the V28 check counters behind the
self-image. Applied to production; `HorseMindPersistence` flushes and hydrates
all six.

### Preflop ranges were read against a scale that is not a percentile

`holdemPreflopScore` is a hand-tuned ladder (every variant is mapped onto it by
quantile), and the "percentile-intent" bars in `HorsePreflop` were never
checked against what the ladder actually yields. Measured over all 1,326
combos: bar 0.42 is the top 23%, not 42%. So, live:

| spot (6-max, 100bb cash)    | before    | after       | solver  |
| --------------------------- | --------- | ----------- | ------- |
| button first in             | 22% raise | 42%         | ~45%    |
| cutoff first in             | 23%       | 25%         | ~27%    |
| hijack first in             | 17%       | 20%         | ~21%    |
| UTG first in                | 12%       | 14%         | ~15%    |
| BB vs button 2.5x           | 62% fold  | ~47% fold   | ~40%    |
| BB vs button 2.2x, ante MTT | 61% fold  | 43% fold    | ~30-35% |
| SB folded to, full ring     | 76% raise | 40% + limps | ~45%    |

The button is now its own seat (`PreflopCtx.isButton`, from the dealer seat)
instead of a second cutoff; full-ring under the gun tightens by table size; the
big blind's price catch widens against a late steal and with an ante; a
full-ring small blind no longer opens the heads-up 0.24 range (that was
`headsUp` being true in every unopened pot because `raiserPosition` is null
first-in).

### A PLO tournament blind could not CALL a raise

V25's pot-limit "commitment zone" used one 0.25 gate for opening AND facing a
raise. A pot re-raise over a 2.2x open costs ~34% of a 24bb stack, so every
PLO4/5/6/8 blind at 20-30bb was routed into pot-it-or-fold: measured 82-86%
fold, 14-18% re-raise, 0% call, at 3.4:1. Facing a raise the zone now applies
only when the re-raise really is the stack (>= 45%) or the call alone is a
quarter of it; opening keeps 0.25. The V24 price defence and the V25 reshove
below it are reachable again.

### The solver facing-a-bet layer called 84% of what it judged

V32 compared raw equity against the betting range with pot odds and nothing
else. Live: `v32_defend_call` 13,660 vs `v32_defend_fold` 2,518. Against a
third-pot bet almost any two cards hold 20% raw equity, but a seven-high does
not get to realize it across two more streets — a solver folds the bottom of
its range by minimum defence frequency. Required equity is now
`potOdds / realization` (flop OOP 0.75, IP 0.85; turn 0.85/0.92; river 1;
draws +0.08), priced against the raked pot in cash and with the ICM premium
scaled by the share of stack at risk in tournaments (V24's rule).

The layer also only ever answered fold-or-call, so while a cell existed no
semi-bluff raise line in the brain could fire. A solver CALL with a drawing
hand now falls through with the call guaranteed: the raise gates roll first.

### The sb_push chart answered a reshove as an open-jam

`raises >= 1` let the BB consult the SB-open-jam chart when the SB had 3-bet
jammed over an open (a far tighter range). Now `raises === 1`.

### Small

`computeThinkTime`'s heads-up read now ignores sitting-out seats like every
other heads-up read in the file.

## Tests

`server/src/engine/HorseV34Audit.test.ts` (18 pins) plus three boundary
hands moved in `HorseLogic.test.ts` to the new bars. The horse/GTO suites:
72 files, 928 tests green. `npx tsc --noEmit` clean.

## Still open (Phase 2 candidates, measured this session)

- PLO facing a 33% flop bet folds 11% (heads-up, caller) — probably right for
  Omaha but the raise share (13%) and PLO6 multiway sizing need the variant pass.
- `gto_postflop_v31` holds 7 cells until the V30 river aggregation finishes;
  V31's turn overbet cannot fire before then. Nothing to fix in code.
- The heuristic river call line folds 66-68% to a 75% bet heads-up (a solver
  ~50-55%); the V32 layer now sits on the other side of it. Worth an A/B in
  the league before moving either.
