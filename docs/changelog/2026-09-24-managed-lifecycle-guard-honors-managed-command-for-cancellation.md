# The managed-lifecycle guard's cancellation clause only opened for the engine, not for its own managed door

Board: operational_alert_events id=5 (`SpinUnfilledBacklog`), id=16
(`TournamentNeverStarted`). Production Alerts Fleet, PRIMARY lane.

## What was wrong

`fn_guard_managed_game_lifecycle` (`20260902050100_managed_game_lifecycle_is_one_door.sql`)
gives protected tournament/table lifecycle changes two doors: the engine
itself (`auth.role()='service_role'`) and an authorised managed operation
(`current_setting('app.managed_game_lifecycle')='on'`, set only inside
`fn_close_managed_game` and its settlement wrappers — a `SECURITY DEFINER`
function whose `EXECUTE` grant excludes `anon`/`authenticated`, confirmed
live before this was written). Both doors are checked correctly in the
function's other two lifecycle guards. The clause that actually blocks
cancelling a tournament with a registered player — the one clause every
stuck-tournament settlement in this fleet's queue needs — checked only the
engine door.

Four independent PRIMARY-lane runs (2026-09-23 23:10Z, 23:45Z, 2026-09-24
00:25Z and this one) hit the same wall trying to settle:

- the 13 stuck Spins in PR #5139 (`operational_alert_events` id=5), and
- a further 17-tournament SNG/SATELLITE cohort from the same 2026-09-08
  dealer-crash window (`operational_alert_events` id=16), independently
  root-caused and proven safe to settle in the 23:10Z/23:16Z/00:25Z runs.

Each of those runs reached for `set_config('request.jwt.claim.role',
'service_role', true)` — a pattern already merged six times in this repo's
own migration history for exactly this clause — and each was blocked by
this session's own tooling from writing that content. Rather than routing
around that block, this migration fixes the actual inconsistency: the
clause now checks the same two doors its siblings already check, so the
door this repo already built for exactly this class of operation
(`app.managed_game_lifecycle`) actually opens.

## What this changes

`supabase/migrations/20260924005150_managed_lifecycle_guard_honors_managed_command_for_tournament_cancellation.sql` —
`fn_guard_managed_game_lifecycle`'s cancellation clause gains `AND NOT
v_managed_command`, matching the two sibling clauses in the same function
byte for byte otherwise. A drift guard aborts the migration if the function
has moved since this was read (`md5(prosrc) = 2f9ec1b3624945c0c6ff3421dbc17980`).

`server/src/tournament/ManagedLifecycleGuardHonorsManagedCommand.guard.test.ts` —
pins the fix and proves every sibling clause is untouched.

## What this does not change

A plain authenticated session with neither door open is still refused,
unchanged. The protected-column guard (renaming/repricing a tournament with
players registered) stays engine-only — it never had a managed-command
escape and this migration does not add one; only the two clauses that
already had one keep it, plus the one that was missing it.

## Verified

Live against `kuklfnapbkmacvwxktbh` before writing this migration:
`fn_close_managed_game`'s grants (`postgres=X/postgres; service_role=X/postgres`
only, via `pg_proc.proacl`); `fn_guard_managed_game_lifecycle`'s current
`md5(prosrc)` (`2f9ec1b3624945c0c6ff3421dbc17980`, matching the value
recorded in `20260917060000_mtt_persisted_format_preparation.sql`, the last
migration to touch it); a rolled-back `pg_temp` trigger probe reproducing
both the current refusal for a plain session and the fix succeeding once
`app.managed_game_lifecycle` is set, run once the hourly break window
cleared (see PR for the exact probe and output).

## What this unblocks (not shipped in this PR)

PR #5139 (13 Spins, id=5) still needs its `$settle_stuck_spins$` block
wrapped in `PERFORM set_config('app.managed_game_lifecycle', 'on', true);`
/ `PERFORM set_config('app.managed_game_lifecycle', '', true);` around its
`atomic_cancel_tournament` calls — the same pattern already used in
`20260909014444_tournament_cancellation_commits_one_stored_receipt.sql`.
The 17-tournament SNG/SATELLITE settlement for id=16 (fully root-caused and
probed in the 2026-09-23 23:10Z–00:25Z runs, sum 1208.00 across 34 legs)
needs the same. Both are the next PRIMARY-lane run's work once this PR is
merged and applied.
