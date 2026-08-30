# 2026-08-30 — What is left after V30, and where the next real gain is

Dan asked what remains and how this can still be improved. This is the
evidence-backed answer, written down so the next agent starts from findings
rather than from guesses.

## First: proof the shipped work is live and the bug is gone

`horse_brain_telemetry`, read 06:40 UTC:

| day        | feature                 | fires                                      |
| ---------- | ----------------------- | ------------------------------------------ |
| 2026-08-30 | `v27_gto_open_jam`      | 12,809                                     |
| 2026-08-30 | `v29_gto_flop_open`     | 3,358                                      |
| 2026-08-30 | `v27_gto_bb_defend`     | 2,582                                      |
| 2026-08-30 | **`v30_gto_turn_open`** | **1,032**                                  |
| 2026-08-29 | `v29_gto_flop_defend`   | 1,366 — **last fire 21:37:22, zero since** |

Three things this proves that nothing else could:

1. **V30 is deciding real hands.** `v30_gto_turn_open` went 60 → 1,032 as
   turn cells built. The turn layer is not theoretical.
2. **The contaminated layer is dead in production.** `v29_gto_flop_defend`
   stopped at 21:37:22 — the exact deploy — and has fired zero times since.
3. **The blast radius is now quantified: ~1,366 flop decisions on
   2026-08-29** were made by the fold-heavy contaminated cells before they
   were removed. That is the cost of the original defect, measured.

## The finding that changes the next phase: `strategy_matrix_v2`

`solved_spots_gold` has a second, newer solve column that **nothing in the
brain reads**: `strategy_matrix_v2`, populated on **1,891,817 rows**
between 2026-07-24 and 2026-08-15. V29/V30 were both built from the older
`strategy_matrix`. The v2 payload is strictly better on five axes:

|               | v1 (what V29/V30 use)                                     | v2 (unused)                                                                       |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| granularity   | 169 hand **classes**                                      | **1,326 exact combos** (`combo_order`: `card=rank*4+suit; combo=b*(b-1)/2+a`)     |
| frequencies   | contaminated at depth (fold values averaging 299)         | clean `[0,1]` throughout                                                          |
| bet sizing    | inferred from absolute codes (`b16`, `b45`, ≥100 ⇒ "big") | explicit `size_pct` per action (`{key: "bet_262", code: "b1442", size_pct: 262}`) |
| stack         | `stack_depth` only                                        | **`eff_stack_bb`** plus `pot_bb`                                                  |
| quality       | none                                                      | `exploitability_pct` (~0.32–0.42 observed)                                        |
| node identity | inferred from `tree_lines`                                | explicit `node` path, e.g. `r:0:c:b412:c:Kh:c`                                    |

Coverage (unbiased `TABLESAMPLE`): overwhelmingly **turn**, some flop,
across `hu_cash`, `cash`, `6max_cash`, `9max_cash`, `mtt_*_chipev`,
`sng_*`, `spin_*` — effective stacks 8bb to 91bb.

### Why this is the highest-value next build (V31)

- **Suit awareness.** 1,326 combos instead of 169 classes means AhKh and
  AsKd stop being the same hand on a heart board. Blockers, flush-draw
  equity and suit-specific bluff selection all become expressible. This is
  the single largest fidelity gain available.
- **Exact sizing.** `size_pct` removes the absolute-size heuristic V30 had
  to invent ("a solo bet ≥100 is big"), which is the weakest joint in the
  current mapper.
- **It fixes the known follow-up for free.** `eff_stack_bb` is exactly the
  street-start effective stack the consult should be bucketing on, instead
  of the remaining stack it uses today (see the V30 changelog).
- **Quality filtering.** `exploitability_pct` lets a poor solve be excluded
  rather than averaged into a class mean.

### What it does NOT fix, and this is now settled

**There are no facing-a-bet solves in this warehouse — in either format.**
Sampled across every game type, `actions` never contains a `fold`
(`can_fold = 0` in every bucket). The facing consult that V30 removed
cannot be rebuilt from v1 _or_ v2 data. Solver-driven defense would require
**generating new solves at facing nodes** — a data-production task, not an
engine task. Until then, facing a bet is correctly played by the heuristic
layers, and any future attempt to resurrect a "facing" cell from this table
is repeating the 2026-08-29 defect.

## The remaining work, honestly ranked

1. **(running, unattended) Finish the V30 aggregation.** Turn ~260k/3.18M
   at ~42 rows/s, then river (5.59M). `v30-aggregation-tail-watch` runs
   every 8 hours, diagnoses stalls through the engine's own RPC path,
   re-checks the batch clamp, verifies data soundness, and deletes itself
   when both streets report done. River telemetry starts when the turn
   finishes; zero `v30_gto_river_open` fires before then is expected.
2. **(next real build) V31 — aggregate from `strategy_matrix_v2`.** Combo-
   level cells, exact `size_pct` sizing, `eff_stack_bb` bucketing,
   `exploitability_pct` filtering. Ship it beside V30 rather than over it,
   and prove equivalence-or-better before switching the consult, exactly as
   V30's aggregator rewrite was proven with `EXCEPT` in both directions.
   Note the storage question up front: 1,326 combos × cells is far larger
   than 169 × cells, so the compact table needs a size budget before the
   first batch runs, not after.
3. **(blocked on data, not code) Facing-a-bet play from a solver.** Needs
   new solves. Nothing to build until those exist.
4. **(known, bounded) Multiway.** The consult requires `oppCount === 1`.
   The warehouse is heads-up nodes, so multiway postflop has no solver
   coverage at all and is heuristic by necessity.
5. **(deliberately not done) The `(street, id)` composite index.** It would
   reclaim the ~530ms per call the batch fetch wastes discarding 341 of 541
   rows read, but building it on a 79 GB / 8.8M-row table is the operation
   class behind the 2026-08-15 liveness incident. Revisit when the fleet is
   idle, not while it deals.
6. **(measured waste, low priority)** Only ~88 of every 200 v1 turn rows
   carry both `frequencies` and `tree_lines`; the other 56% are older
   exports with nothing to aggregate. They still advance the cursor, so
   correctness is unaffected — it is throughput left on the table, and V31
   sidesteps it entirely by reading the v2 column.
