# Horse Brain Phase 13: closed, not promoted (2026-10-06)

Phase 13 is closed. All nine locked held-out strength matrices for the joint
multiway owner (`joint-multiway-round1-v4`, response pack
`joint-action-response-round2-v1`) are complete on source `886cc965`, assembled
by the real P13.2 assembler, and every one returned `qualified: false`. All nine
entries of `PHASE13_PROTECTED_RELEASE_SELECTIONS` stay `null`, so horses play
exactly as before. Record:
[horse-brain-phase13-closure-2026-10-06.md](../horse-brain-phase13-closure-2026-10-06.md).

- **Evidence added**: `strength.json`, the shard runs and the
  `horse-phase13-qualification-v1` file for NLH, PLO4, PLO5, PLO6, PLO8, FLO8,
  Short Deck and Crazy Pineapple under `docs/evidence/phase13/` (FLH landed in
  #6293).
- **Result**: every variant loses to the reference on the primary cash cell at
  99%, on all three seed blocks and on every gating cell, from FLO8 at
  -98.53 bb/100 to Crazy Pineapple at -973.83 bb/100. Every validity counter is
  0 on every shard, including zero `illegal_candidate` and zero
  `earlier_phase_applied`.
- **Cause** (already diagnosed in
  [horse-brain-phase13-loss-diagnosis-2026-10-06.md](../horse-brain-phase13-loss-diagnosis-2026-10-06.md)):
  the opponent response model is uncalibrated and predicts folds the horse
  population does not make, so the candidate turns checks and calls into
  wagers priced with fold equity that does not exist. No settlement, seat,
  board, rake or jackpot path is the cause.
- **Natural completion**: no variant clears the 0.95 floor in the predeclared
  window; FLH and FLO8 had no decisions in it.
- **Next round**: calibrate opponent responses to the population and pass a
  development-seed calibration gate before any held-out run. Never tune on the
  held-out seeds used here.
