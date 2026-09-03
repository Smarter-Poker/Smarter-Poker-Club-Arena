# 2026-08-29 — V30: turn/river solver layer + the facing-cell purge

Dan: "PROCEED TO THE NEXT PHASE OF AUDITS, ENHANCEMENTS AND OPTIMIZATIONS
AND IMPROVEMENTS FOR THE HORSE BRAIN" — continuing "MOVE ONTO FLOP, TURN
AND MOST IMPORTANTLY RIVER."

## The finding that reshaped this phase

Probing the first V30 turn batches surfaced a data-quality fact that also
invalidates part of shipped V29, verified against 1,200 sampled warehouse
rows across all three streets:

1. **Every solved tree is an OPEN node.** Root actions (`tree_lines`
   matching `r:0:X`) are uniformly `{c, b16}` — no tree starts with hero
   facing a bet. The `actions` array lists deep-tree labels, so V29's
   "contains `f` ⇒ facing node" classification was wrong for every row it
   matched.
2. **Exported numbers are trustworthy only at the root.** `c`/`b16` values
   all lie in [0,1]; `f` averages 299 (max 544) and `b45` averages 10.8 —
   EV-magnitude contamination, not frequencies. `rollMix` normalizes by
   total, so fold≈400 vs call≈0.9 read as "fold 99%".

**Consequence:** V29's flop `facing` cells had exactly this shape and had
been steering the facing-a-bet consult toward folds since they went live
(bounded by the equity>=0.72 valve and the 0.15 price guard, but still an
over-folding bias against first bets, heads-up hold'em flops). The flop
`open` cells are unaffected — flop rows export root-only frequencies
(all in [0,1], per-hand sums mean 0.999).

## What shipped

**Production data (applied via MCP):**

- `v30_root_only_open_cells` — deleted every `facing` cell (all streets),
  deleted the pre-spec turn cells, reset the turn/river cursors, and
  replaced `fn_aggregate_gto_street_next` with the root-only spec: root
  actions from `tree_lines`, per-hand validation (all values in [0,1.001],
  sum in [0.95,1.05] — measured 56% of hand-rows pass; the rest contribute
  NOTHING rather than noise), renormalized to exactly 1, labeled
  check / bet_small / bet_big (solo bets by absolute size, <100 = small).
  Verified: every stored turn-cell hand mix sums to exactly 1.000.
- `v30_marked_uuid_pick` / `v30_aggregator_own_timeout` +
  `v30_revert_useless_fn_timeout` — the uuid-cursor fix (no `max(uuid)`
  aggregate exists; ordered pick instead), and a reverted dead end:
  `statement_timeout` is armed at outer-statement start, so a
  function-level SET never takes effect. Batch size is the only real
  control (500 rows fits an 8s budget; 1000 does not).

**Engine (this PR):**

- `GtoPostflop.ts` — street-keyed store; `setGtoPostflop` REFUSES `facing`
  rows outright (a stale snapshot cannot resurrect the bug through the
  loader); `textureClass` extended to 4/5 cards as the exact mirror of
  `fn_gto_texture_class_any` (12 production-classified pins); the 3-card
  path is byte-identical to V29; `gtoFlopAdvice` → `gtoStreetAdvice`
  (open-only, absent hand = silence).
- `HorseLogic.ts` — the open consult now covers flop/turn/river (hero must
  hold the lead, heads-up, hold'em); turn/river `bet_small` sizes as a
  genuine block bet (0.24–0.32 pot — the solved root bet is 16% pot);
  telemetry `v30_gto_turn_open` / `v30_gto_river_open`; opt flag
  `v30GtoTurnRiver`. **The V29 facing-defense consult is REMOVED** with a
  tombstone comment explaining why it must not be rebuilt from this
  warehouse.
- `GtoPostflopLoader.ts` — collect-then-swap (DB purges reach memory on
  refresh; a partial load changes nothing) and stable full-key paging
  (the driver inserts rows into the table while the loader pages it).
- `GtoAggregationDriver.ts` (new) — paces the one-time aggregation: one
  batch per 20s tick, turn then river, adaptive batch (600 start, halve on
  statement timeout, floor 200, cap 1200), restart-safe via
  `gto_agg_progress`, permanently silent when both streets are done.
  Wired at boot in `index.ts`.

**Tests:** `GtoPostflop.test.ts` rebuilt — 40 tests: 3-card pins unchanged,
12 new 4/5-card production pins, facing-row refusal pin, street separation,
turn wiring (pure-bet stabs as a block bet, pure-check checks), ablation
equality extended to the turn, boot wiring for loader + driver. Full server
suite green: 222 files, 2495 tests.

## Follow-up: the driver could not call its own RPC (found by verifying)

The deploy landed at 22:18 UTC and `gto_agg_progress` did not move for six
hours. The driver was ticking and failing every 20 seconds on:

    21000  DELETE requires a WHERE clause

`fn_aggregate_gto_street_next` clears its temp table with an unqualified
`delete from tmp_agg30`. PostgREST's API roles run with the safe-update
guard on and refuse a DELETE without a qual. **I had probed the function
through the Supabase MCP as the `postgres` role, which has no such guard —
so it passed a test the engine's path could never have passed.**

THE LESSON, now written into the migration: an RPC the engine calls must be
probed THE WAY THE ENGINE CALLS IT (`POST /rest/v1/rpc/... ` as
`service_role`). "It runs in psql" is not evidence that it runs in
production. `GtoAggregationDriver.test.ts` pins that a real error is
reported rather than swallowed, which is what would have surfaced this in
minutes instead of hours.

Fixed in `v30_driver_postgrest_safeupdate_fix` (TRUNCATE instead of DELETE;
not a DELETE, so no qual required, and cheaper on a temp table). Verified
through the engine's own path, then observed live: the cursor moved 500,
1500, 2000 rows on successive minutes with `updated_at` seconds old.

The same verification exposed a second defect. Measured through the API
path, a 200-row batch takes ~3.5s and 300+ exceeds the ~8s statement budget
(57014) — and the SQL clamps `p_batch` to a floor of 200. So the adaptive
sizing had nothing to adapt to: live, it settled at 200 and then oscillated
200 -> 400 -> timeout -> 200 forever, wasting a tick in four and delivering
~500 rows/min (12 days for both streets). Replaced with a FIXED 200-row
batch and up to 4 calls per tick under a 12s wall budget: ~40 rows/s.

## Expected timeline

Turn (3.18M rows) at ~600 rows/20s ≈ 30h of engine uptime, then river
(5.59M) ≈ 52h. The loader folds new cells into the fleet every 6h as they
build. Verification: `gto_agg_progress.rows_done` climbing, then
`done=true`, then turn/river cells serving `v30_gto_*_open` telemetry.
