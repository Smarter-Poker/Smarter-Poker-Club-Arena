# 2026-09-28 - V33's depth ceiling defaults off: measured as costing money

## Measurement

`v33_depth_ceiling_400bb` plays heads-up at 400bb with the ceiling on (a)
against it off (b). It is the ablation. Pooled by inverse variance:

| window                      | runs | hands   | bb/100 | stderr | z     |
| --------------------------- | ---- | ------- | ------ | ------ | ----- |
| all (2026-09-01 to 09-28)   | 23   | 276,000 | -2.97  | 1.09   | -2.71 |
| last 8 (the audit's figure) | 8    | 96,000  | -4.10  | 1.87   | -2.19 |
| since 2026-09-15            | 14   | 168,000 | -1.73  | 1.36   | -1.27 |

Every single run was unresolved on its own (per-run stderr 3.9 to 7.4); only
the pooled view resolves it. There was no sign flip to trace: it was negative
from its first run on 2026-09-01, with three positive nights from 09-15 to
09-17.

## What V33 does, and why off wins

Above `GTO_MAX_DEPTH_BB` (300) V33 declines the solver consult and lets the
depth-scaling heuristics play, because the warehouse's deepest bucket is 150bb.
Measured, the 150bb answer served at 400bb beats the heuristics by about
3 bb/100.

## Change

- `opts.v33DepthCeiling` is opt-in (`=== true`) at all three consults
  (certified V31, V32 facing, V29/V30 open-node).
- The reason V33 existed stays fixed: a 400bb hero served 150bb strategy used
  to leave no trace. Every consult beyond the ceiling now fires
  `gto_served_beyond_depth_ceiling` when it is served, as it fired
  `gto_skip_too_deep` when it was declined.
- The matchup flips to `a: { v33DepthCeiling: true }, b: {}` so it keeps
  measuring. A negative pooled result now confirms the default.
  `league_layer_negative_pooled` will keep naming this matchup while that holds.

Pinned by `server/src/engine/GtoDepthCeiling.test.ts`.
