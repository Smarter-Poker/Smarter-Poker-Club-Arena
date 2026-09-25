# 2026-09-24 - multi-day tournaments: the stage foundation (database)

## Merge order

**This candidate merges only after the capability registry**
(`supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql`,
its own pull request). That migration is deliberately not copied here. Until it is
on main:

- the CI step "Multi-day stage foundation keeps every stack through a bag and a
  resume (needs capability registry 20260924025555)" fails. The harness exits 2 with
  a message naming the missing migration, not a traceback;
- `20260924043217` refuses to install (`MULTI_DAY_REQUIRES_THE_CAPABILITY_REGISTRY`).

## What changed

Design: `docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md`.

- `20260924043217_multi_day_stage_foundation_tables.sql` (R1): eight private stage
  tables (plans, stages, transitions, clock snapshots, bag watermarks, bags,
  qualification entitlements, resume receipts). Only the stage RPCs can write them.
  No column is added to `tournaments` or `tournament_players`.
- `20260924043224_a_bagged_tournament_is_a_controlled_status.sql` (R3, R4): adds
  `BAGGED` to `tournaments_status_check` (NOT VALID) and adds guard triggers. A
  tournament enters `BAGGED` only through the bag RPC and leaves it only to `RUNNING`
  through the resume RPC. While an event is bagged, nothing else can change a stack,
  a roster status or a bounty.
- `20260924043232_the_bagged_status_check_is_validated.sql` (R3b): validates that
  check in its own transaction.
- `20260924043239_multi_day_stage_transitions_are_lease_fenced.sql` (R5, database
  half): seven service-role RPCs. Each is lease-fenced and idempotent on its receipt,
  checks chip conservation, and refuses unless
  `fn_capability_available('tournament.multi_day.single_flight')` is true.

## Why

Multi-day events need the same tournament row to stop between days and resume with
every stack intact. This is the database half, and it cannot be reached until the
capability is enabled (R6).

## Evidence

- `scripts/ci/test-multi-day-stage-foundation.py` (new CI step): 25 cases passed on a
  local PostgreSQL 16 cluster, with `--capability-migration` pointing at the registry
  candidate's file. CI runs it on 17. Without the registry it exits 2 and names the
  missing migration.

## Pending

- Merge after the capability registry, then install these four migrations in order.
- The engine half (R5 callers) and enabling the capability (R6) are separate changes.
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`multiDayStageFoundationIntegration`).
