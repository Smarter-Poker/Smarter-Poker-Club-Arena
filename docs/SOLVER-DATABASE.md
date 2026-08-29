# The PioSolver Database — What Actually Exists (verified against production 2026-08-29)

A description of this system has circulated naming tables `gto_solutions`,
`gto_solve_queue` and `preflop_ranges`, with columns `gto_action`,
`gto_frequencies` and `ev_by_action`. **None of those tables exist.** Any agent
querying them fails immediately. This document replaces that description and
was verified table by table against the live database
(`kuklfnapbkmacvwxktbh`). Update it if the schema changes; do not re-document
from memory.

## The real tables

| table                                                                    | rows           | size      | what it is                                          |
| ------------------------------------------------------------------------ | -------------- | --------- | --------------------------------------------------- |
| `solved_spots_gold`                                                      | **8,843,737**  | **79 GB** | The warehouse. Pio CFR output per scenario.         |
| `memory_charts_gold`                                                     | 240            | 328 kB    | Preflop push/fold charts, 2–25bb.                   |
| `gto_scenarios`                                                          | 1              | —         | vestigial                                           |
| `solver_queue` / `solver_manifest` / `solver_pipeline` / `solver_status` | 0 / 5 / 13 / 2 | —         | dispatch plumbing for the Windows PioSolver workers |

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

## How the brain uses it (V27, 2026-08-29)

`HorseLogic.decide()` is synchronous with zero I/O (live latency 0.007–17ms —
see `horse_decision_latency`). Solver data therefore reaches it **preloaded,
never queried per decision**:

- **Stage 1 (live):** `memory_charts_gold` → `GtoChartLoader` (boot + hourly)
  → in-memory store in `engine/GtoCharts.ts` → consulted synchronously in the
  preflop path. Open jam-or-fold authoritative at ≤15bb; BB call-off vs an SB
  jam at ≤25bb. Telemetry: `v27_gto_open_jam`, `v27_gto_bb_defend`. Empty
  store → null → heuristics decide (a loader failure cannot lobotomize the
  brain — pinned by an ablation-equality test).
- **Stage 2 (planned):** one offline aggregation pass over `solved_spots_gold`
  into a compact `(game_type, street, position, depth bucket, board texture
class, hand class) → frequencies` table, small enough to preload the same
  way. Never a live read of the 79 GB table.

## The distributed solve pipeline (unchanged)

Producer on the Mac (`scripts/seed_gto_scenarios.py`) seeds pending scenarios;
Windows workers (`scripts/windows_piosolver/`, `piosolver_batch_runner.py`)
lock a task, run `PioSOLVER3-pro.exe`, parse, upsert with the service key, mark
complete. Coordination through the queue tables above.
