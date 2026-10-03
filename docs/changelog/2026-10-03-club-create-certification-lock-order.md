# Club Creation Certification Uses The Platform Lock Order

2026-10-03

## What Failed

Production certification run `37097136525` held the engine maintenance/entry
boundary `(530090,1)` and then entered the welcome reset, which requested the
global tournament settlement lane. A concurrent engine worker already held the
global lane and was waiting for `(530090,1)` shared, so PostgreSQL correctly
reported a `40P01` deadlock. The production reset function already used the
reviewed global-lane-first order; the inversion existed only in the certificate.

The preceding certificate also reached the published browser flow and showed a
second deterministic test gap: a legitimate first-run Diamond Spins dialog was
open over the checklist when the test tried to click `Start Setup`.

## What Changed

- The rollback-only reset probe now acquires
  `fn_ca_lock_settlement_lane_global()` before its ordered graph row locks and
  no longer takes the unrelated maintenance/entry boundary.
- A transient database conflict replays the entire never-committed probe on a
  fresh connection after rollback; no write is retried inside an aborted
  transaction and there is still no commit path.
- The published mobile browser certificate dismisses the visible Diamond Spins
  first-run dialog, waits for it to close, and then opens the setup wizard.
- Contract and law tests pin the lock order, forbid `(530090,1)` in the probe,
  require rollback with no commit, and pin the modal ordering.

This changes certification behavior only. It does not alter clubs, players,
wallets, chips, games, engine authorities, or production database functions.
