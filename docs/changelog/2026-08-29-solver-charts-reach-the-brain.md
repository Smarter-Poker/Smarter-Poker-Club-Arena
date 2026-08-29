# 2026-08-29 — V27: the solver database reaches the horse brain

Dan: _"MAKE SURE THE HORSES HAVE ACCESS TO THE SOLVER DATABASE AND ANY AND ALL
OTHER DATA THEY NEED ACCESS TO WHILE MAKING A DECISION IN REAL TIME ...
THEY'RE NOT JUST GUESSING, THEY HAVE SPECIFIC GTO RENDERED PLAYS."_

The platform holds **8,843,737 PioSolver CFR solutions (79 GB)** and until
today the brain read none of them — every preflop threshold was a hand-tuned
literal. This is Stage 1 of closing that gap.

## Architecture first, as instructed

Two measured constraints decided the shape:

1. `HorseLogic.decide()` is synchronous with **zero I/O** — live latency
   0.007–17ms per `horse_decision_latency`. A per-decision query would make
   every turn async and add a network round trip to a path firing hundreds of
   times a minute.
2. The solver warehouse has already taken the platform down once: the
   2026-08-15 incident was a cron that merely _counted rows_ in
   `solved_spots_gold`, starving the database until `/health` read
   `liveness: dead` every 10 minutes.

So solver data reaches the brain the way `HorseMind` stats do: **preloaded at
boot, refreshed hourly, read as an in-memory Map at zero cost.** Stage 1 loads
`memory_charts_gold` — 240 push/fold charts, 328 kB, smaller than a minute of
telemetry.

Also corrected: the circulating description of this system names tables that
**do not exist** (`gto_solutions`, `gto_solve_queue`, `preflop_ranges`). The
real schema is now documented in `docs/SOLVER-DATABASE.md`, verified against
production table by table, so no future agent burns a session on phantom
tables.

## What the horse now plays from the solver

- **Folded to hero, ≤15bb, hold'em:** the open is the chart's jam-or-fold —
  UTG/MP/CO/BTN/SB, cash and tournament charts kept separate, depth snapped to
  the real ladder (2–20, 25). Mixed strategies are **rolled at the solver's
  frequency**: A5s at 96.4% jam is jammed 96.4% of the time, not rounded to
  always.
- **BB facing an SB all-in, ≤25bb effective:** the call-off comes from the
  `sb_push` chart. Facing a jam, call-or-fold _is_ the whole decision, so the
  chart's authority runs to its full depth here.
- **An absent hand is a fold.** The solver output only lists hands with a
  non-fold branch; 72o is missing from every chart because 72o folds.

Deliberately narrower than the data: the charts extend to 25bb for opens too,
but a 25bb "jam or fold" chart describes only the jam branch of a depth where
real players also open small — a fleet that _only_ open-jams at 25bb would be
the robotic tell. Above 15bb the existing heuristics keep the open.

Scope guards: hold'em only (169 classes assume a full deck — short deck and
Omaha never consult it), no straddle pots (the charts don't model one; V18
owns those). BTN vs CO is resolved exactly from the dealer seat, not guessed
from the position class.

## The fallback is the old brain, never a worse one

`gtoOpenJam` / `gtoBbVsSbJam` return `null` when no chart is hydrated — boot
race, loader failure, uncharted spot — and the heuristics that ran yesterday
decide. Pinned by an **ablation-equality test**: with an empty store, V27 on
and V27 off produce identical decisions, hand for hand. A loader outage cannot
change poker.

Telemetry: `v27_gto_open_jam` and `v27_gto_bb_defend` join the proof-of-receipt
counters, so the daily audit will say whether the layer actually fires at live
tables — the house failure mode being precisely the feature that looks deployed
and never executes.

## Stage 2, planned

The 8.8M postflop solutions cannot be read live (see the incident above) and
their boards are a canonical subset (~186 flops per position) that a live
random board will never exact-match. Stage 2 is one offline aggregation pass
into a compact texture-classed table — `(game_type, street, position, depth
bucket, board texture, hand class) → frequencies` — small enough to preload
exactly like the charts. Never a live read of the 79 GB table.

## Verification

`npx tsc --noEmit` exit 0. **2,371 server tests pass**, 16 new — the chart
semantics (absent hand = fold, mixed frequencies, depth snapping including the
20→25 gap, cash/tournament never substituted), the wiring (a 10bb BTN with
aces open-jams deterministically; with 72o folds; a 100bb stack never
consults the chart), the ablation equality, and the boot wiring.
