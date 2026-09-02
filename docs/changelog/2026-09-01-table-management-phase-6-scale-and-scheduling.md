# Table Management Phase 6: Scale, Scheduling, And Rollout

## Status

Source complete on `codex/club-table-management-20260901`. The migration is intentionally not applied or deployed by this branch.

## What Changed

- Added a durable scheduled-close workflow for cash tables and tournaments.
- Reused `fn_execute_managed_game_command` at execution time, preserving exactly-once receipts, current authorization, contract-version checks, seated-player protection, and tournament-registration protection.
- Added operator scheduling, rescheduling, and cancellation controls to the Game Board.
- Added safe cash-table pause and resume through the authoritative engine admin endpoints. Pause finishes the current hand; no database-status shortcut is used.
- Preserved future tournament activation through the existing full Create Tournament and guarded start-time editor, including published-contract versioning and the first-registration lock.
- Replaced the direct 500-table and 500-tournament browser reads with an authorized keyset-paginated read model capped at 100 combined games per page.
- Added stable continuation cursors and a Load More control. Header totals now come from the full authorized scope rather than the currently loaded page.
- Added supporting partial indexes for standalone-club and union list paths.
- Added bounded, non-overlapping 30-day retention for compact realtime invalidation events. Published contracts, command receipts, and audit evidence remain append-only and are not pruned.
- Added scoped scheduler backlog, scheduler rejection, event-volume, and retention health to the operator console.
- Added one-minute scheduler and daily retention jobs with named-job replacement, advisory locks, `FOR UPDATE SKIP LOCKED`, and hard batch caps.

## Safety Laws

1. Scheduling never bypasses lifecycle authority. A due command is rejected if the actor lost permission, the contract changed, a player sat down, or a tournament registration appeared.
2. A game has at most one pending or executing scheduled close.
3. An executing schedule cannot be rescheduled or cancelled.
4. Browsers cannot run the scheduler, prune events, or mutate schedule rows directly.
5. Realtime retention can delete only events older than seven days, is configured for 30 days, and is capped at 5,000 rows per run.
6. Command receipts, published contracts, and audit records have no Phase 6 deletion path.
7. Every game page is capped at 100 rows and uses `(sort_at, kind, id)` keyset continuation.

## Hostile-State Coverage

- Double schedule or reschedule resolves to one pending schedule.
- Schedule versus scheduler execution serializes on the schedule row.
- Multiple scheduler workers collapse through an advisory transaction lock and skip locked rows.
- Permission revocation before execution is rejected by the existing command gateway.
- Contract drift before execution produces a durable stale-version rejection receipt.
- A newly occupied table produces `players_seated`; a newly registered tournament produces `players_registered`.
- A cancelled, completed, or executing schedule cannot be cancelled a second time.
- An unauthenticated or wrong-scope list request fails closed.
- Retention overlap returns without deleting, and browser retention calls are revoked.

## Migration Readiness

Migration: `supabase/migrations/20260902210000_table_management_scale_and_scheduling.sql`

Pre-deploy:

1. Confirm Phases 1 through 5 migrations are already applied.
2. Confirm `pg_cron` and `pgcrypto` are installed.
3. Confirm no jobs already use `managed-game-schedules-minute` or `game-management-events-retention` for unrelated work.
4. Capture counts for `game_management_events`, `managed_game_command_receipts`, and pending management schedules.
5. Run the migration in staging and verify both named cron jobs are active.

Post-deploy:

1. Call `fn_list_managed_games` as a standalone-club operator and a union operator; verify cross-scope requests fail.
2. Schedule an empty test table to close, verify the schedule becomes `succeeded`, and reconcile its command receipt.
3. Schedule an occupied test table and a registered test tournament; verify both remain open and schedules become `rejected` with the correct reason.
4. Revoke an actor before a due test command; verify `not_authorized` and no game mutation.
5. Verify `fn_get_game_management_scale_health` reports scoped counts only.
6. Run retention with a cutoff that matches no rows, then with staged events older than 30 days; verify only eligible invalidation events are deleted.
7. Verify contract history, receipts, and audit rows are unchanged.

## Recovery

- Pause the two named cron jobs first if scheduler or retention health is abnormal.
- Pending schedules are safe to leave stored while the scheduler is paused.
- Do not delete receipts or contract history during recovery.
- The UI can be rolled back independently; existing schedules remain durable and can be inspected from the database.
- If the read RPC must be rolled back, restore the prior UI only after confirming the old 500-row ceiling is acceptable for the affected scope.

## Verification

- SQL parsed with `pglast`.
- Focused architecture, service, command-integrity, and realtime suites pass.
- TypeScript `tsc --noEmit` passes.
- Full client, server, and production-build gates are recorded at the final Phase 6 commit boundary.
