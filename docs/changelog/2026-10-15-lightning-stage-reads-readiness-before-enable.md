# Lightning Stage Tool Reads Readiness Right Before Enable

The first Stage 1 dispatch (run 38769578701, 16:30 UTC) was refused before any
action: readiness answered `no_go` with `WORKER_OFF` blocking. Switching the
worker to shadow is one of Stage 1's own steps, so a tool that gates before its
configuration can never start Stage 1. ROLLOUT.md says readiness is read and
recorded before a Cluster's `enable_lightning`, not before the stage's
configuration.

`scripts/ops/lightning-pilot-stage.mjs` now runs each stage as a plan:
`prepare` (configuration that never enables or forms; for Stage 1 the shadow
matcher flag, m1-port shadow version and shadow worker) on every target, then
readiness read, recorded and gated on every target, then the `gated` actions
(`enable_lightning` for Stage 1; `set_worker_mode form` for Stage 2, which has no
preparation and so still gates first). `WORKER_OFF` is no longer an accepted
Stage 1 reason, because after preparation it would mean the worker did not move.
Drain stays ungated. 10 node tests, including the exact action/readiness order,
no enable after a `no_go`, and form refusing without calibration.
