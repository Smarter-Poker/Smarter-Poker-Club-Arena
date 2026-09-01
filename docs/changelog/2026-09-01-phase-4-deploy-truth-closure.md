# 2026-09-01 - Phase 4 Deploy Truth Closure

## What The Audit Found

The shipped watchdog treated stale lease rows as a dead engine, but treated no
lease rows as healthy. A graceful shutdown deletes the leader and table lease
rows. If the replacement container then failed to start, the heartbeat alarm
resolved itself and the behind-target alarm skipped because no running version
existed.

A manual deploy naming `ref_sha` also checked out and deployed that SHA while
the recorder wrote `github.sha`, allowing the database to compare production
against a commit the run never attempted to ship.

## What Changed

- Deploy truth now reads the process-level `engine_leader` heartbeat together
  with table lease heartbeats.
- A private singleton records the first missing-engine observation. Zero rows
  raise after a three-minute rolling-restart grace and resolve only when a live
  heartbeat returns.
- The cron runs each minute, uses a transaction-scoped advisory lock, and keeps
  the existing once-per-episode alert lifecycle.
- Manual `ref_sha` deploys record the exact SHA actually checked out.
- Regression coverage pins the zero-row case, the debounce, the private state,
  the one-minute schedule, and exact manual-target wiring.

## Protected Data

This phase does not read or write Club Bank balances, Deep Stack Society chip
balances, horse funding, player rows, or memberships. The only new persistent
row is operational watchdog state.

## Verification

- The complete migration compiled inside a rolled-back production transaction.
  The healthy call reported one leader, 124 table leases, no missing-engine
  timestamp, and no finding.
- An isolated production-Postgres drill started with zero leader and lease
  rows, crossed the three-minute grace, raised exactly one
  `deploy_truth.engine_heartbeat_stopped` alert across repeated checks, then
  resolved it when a fresh leader heartbeat appeared. The drill rolled back.
- Migration `20260902103000` is applied and its stored statement is byte-exact
  with this repository file (MD5 `b7542b248d5e8abb52b147c6b4a9d4df`).
- The live cron is `ca-engine-deploy-truth-1m`; its first observed tick
  succeeded. Live state showed one leader, 125 table leases, a current
  heartbeat, no missing-engine timestamp, and no open deploy-truth alert.
- Anonymous and authenticated roles cannot read the private state table, and
  anonymous callers cannot execute the watcher.
- Focused deploy, publication, stale-code, manifest, and watchdog coverage:
  50 tests passed. TypeScript passed with zero errors.
