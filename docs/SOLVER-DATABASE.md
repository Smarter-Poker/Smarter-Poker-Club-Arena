# The PioSolver Database — What Actually Exists

The schema boundary and small-table row counts were re-verified against
production on 2026-09-08. The `solved_spots_gold` row and size figures below are
the 2026-08-29 snapshot; deliberately do not refresh them with a live full-table
count because that exact operation has already starved the production database.

A description of this system has circulated naming tables `gto_solutions`,
`gto_solve_queue` and `preflop_ranges`, with columns `gto_action`,
`gto_frequencies` and `ev_by_action`. **None of those tables exist.** Any agent
querying them fails immediately. This document replaces that description and
was verified table by table against the live database
(`kuklfnapbkmacvwxktbh`). Update it if the schema changes; do not re-document
from memory.

## The real tables

| table                                                                    | rows           | size      | what it is                                  |
| ------------------------------------------------------------------------ | -------------- | --------- | ------------------------------------------- |
| `solved_spots_gold`                                                      | **8,843,737**  | **79 GB** | The warehouse. Pio CFR output per scenario. |
| `memory_charts_gold`                                                     | 240            | 328 kB    | Preflop push/fold charts, 2–25bb.           |
| `gto_scenarios`                                                          | 1              | —         | vestigial                                   |
| `solver_queue` / `solver_manifest` / `solver_pipeline` / `solver_status` | 0 / 5 / 13 / 2 | —         | legacy queue schema; not the V31 producer   |

## `solved_spots_gold`

```
scenario_hash       text     e.g. 'turn_cash_BB_10bb_5h4d3hQc'
                             = street _ game_type _ position _ <depth>bb _ board
game_type           text     24 values: cash, hu_cash, 9max_cash, spin,
                             mtt_icm, mtt_chipev, mtt_6max_*, mtt_9max_*,
                             sng_6max_*, sng_9max_* ...
stack_depth         int      8..200 (varies by game_type)
street              text     flop 72,340 | turn 3,184,083 | river 5,587,127
strategy_matrix     jsonb    node, board, actions, per-hand-class frequencies
                             per action, hand_evs, ev_ip/ev_oop, exploitability
strategy_matrix_v2  jsonb    a re-solve pass, ~1.4M rows populated so far
```

The per-hand keys are 169-class labels (`A5s`, `KTo`, `22`). **A hand absent
from a frequencies map is a pure fold** — the solver output only lists hands
with a non-fold branch.

**The solved boards are a canonical subset**: only ~186 distinct flops per
cash position, with turn/river branching from them. An exact-board lookup on a
live random board will essentially never hit; live use requires
suit-normalising and texture-mapping onto the solved subset.

## `memory_charts_gold`

```
game_type       'Cash' | 'Tournament'
stack_depth     2..20, 25 (big blinds)
hero_position   UTG / MP / CO / BTN / SB   with villain_action 'fold_to_hero'
                (folded to hero: push/fold), and
                BB with villain_action 'sb_push' (SB jammed: call/fold)
hand_matrix     { "A5s": {"push": 0.964, "fold": 0.036}, ... }  ~70 hands;
                absent hand = fold
```

## DANGER: do not query the warehouse casually

The 2026-08-15 incident
(`.agent/audits/2026-08-15-gto-refresh-was-dosing-the-platform.md`): a pg_cron
job that merely **counted rows** in `solved_spots_gold` ran 53s average, failed
48% of the time, and starved the database until the engine's `/health` read
`liveness: dead` — every 10 minutes. Reads of this table must be planned,
indexed, and never on a hot path.

## How the brain uses it

`HorseLogic.decide()` is synchronous with zero I/O (live latency 0.007–17ms —
see `horse_decision_latency`). Solver data therefore reaches it **preloaded,
never queried per decision**:

- **Stage 1 (live):** `memory_charts_gold` → `GtoChartLoader` (boot + hourly)
  → in-memory store in `engine/GtoCharts.ts` → consulted synchronously in the
  preflop path. Open jam-or-fold authoritative at ≤15bb; BB call-off vs an SB
  jam at ≤25bb. Telemetry: `v27_gto_open_jam`, `v27_gto_bb_defend`. Empty
  store → null → heuristics decide (a loader failure cannot lobotomize the
  brain — pinned by an ablation-equality test).
- **Stage 2 (V31 control plane installed, corpus not yet active):** the Phase 4
  pipeline accepts only independently solved, suit-aware Pio artifacts from M1
  and M2 through a signed gateway. PostgreSQL validates source provenance,
  disjoint holdout boards, complete policy/action EV matrices, coverage,
  evaluation receipts, and promotion before creating an active dataset. The
  engine preloads only promoted `gto_v31_runtime_cells`; it never reads the
  warehouse or calls a solver on the action clock. On 2026-09-08 production had
  zero approved input bundles, datasets, source artifacts, runtime cells, or
  release evaluations, so V31 correctly remained fail-closed.

## The certified distributed solve pipeline

The canonical producer lives in the World Hub repository under
`scripts/horse-solver-v31/`. A human-approved immutable input bundle binds the
range files, exact 1,326-combo order emitted by the licensed Pio binary, ICM
models, scenario manifest, solver version, binary checksum, and pipeline commit.
M1 and M2 own disjoint declared targets and separate HMAC keys; a third HMAC key
belongs to the compactor. All writes cross the signed gateway and database
certification functions. No solver host receives a Supabase credential.

The former Club scripts `scripts/piosolver_batch.py`,
`scripts/seed_gto_scenarios.py`, and
`scripts/windows_piosolver/piosolver_batch_runner.py` were retired. They queried
`gto_solutions` and `gto_solve_queue`, which do not exist in production, and
instructed operators to install a production `service_role` key on every solver
host. `scripts/windows_piosolver/README.md` is a permanent tombstone, and a law
test prevents those direct-database workers from returning.
