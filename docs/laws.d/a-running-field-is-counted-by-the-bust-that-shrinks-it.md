# tests/a-running-field-is-counted-by-the-bust-that-shrinks-it.law.test.ts

## The law

`public.tournaments.current_players` of a RUNNING, non-seat-first event is
recounted from its roster in the transaction that moves a player into or out
of the field. No job rewrites it afterwards, and `fn_reconcile_tournament_denormals`
never again writes `public.tournaments` or `public.tables`.

## What went wrong

The roster trigger `trg_sync_tournament_current_players` was pre-start only
(20260823120000). Nothing counted a RUNNING field: a bust left the count one
too high until the pg_cron job `reconcile-tournament-denormals` rewrote it,
up to a minute later. The registration door refuses a late entrant while the
count and the roster disagree, so every bust opened a window in which late
registration failed.

The job chose "seat-first" with its own heuristic,
`lower(variant) IN ('spin','sng') OR COALESCE(max_players, 0) <= 2`. Every
mtt-v2 event has `max_players` NULL by contract, so the job treated every
unlimited MTT as seat-first. Measured 2026-09-22: 38 of 56 RUNNING mtt-v2
events carried the live seats of one table as their field (595 players
undercounted), and its duplicate-table branch closed the launch tables of
events that are still stranded in REGISTERING.

## The fix (20260922141704)

- The owner recounts a RUNNING field on every membership change (an UPDATE of
  status into or out of 'registered'/'playing'): every bust and every re-entry.
- It skips seat-first formats with `fn_ca_tournament_recorded_seat_first`, the
  predicate their own owner (`fn_sync_seat_first_player_count`) uses, so the
  two writers partition the column.
- A RUNNING admission (INSERT) stays with the door that performs it. The
  registration and horse doors publish `v_players_before + 1` themselves and
  require the trigger to leave a RUNNING count alone; counting it here would
  make every late registration fail its own guard.
- The count branch and the duplicate-table branch of the minutely job are
  removed by `pg_temp.ca_patch`, each marker asserted to match exactly once.

## Forward guard

Every migration after 20260922141704: a redefinition of
`fn_sync_tournament_current_players` keeps the RUNNING membership branch, the
seat-first skip and the pre-start-only first statement; `trg_sync_tournament_current_players`
is never dropped without being recreated on every roster event, and never
disabled; `fn_reconcile_tournament_denormals` never writes `tournaments` or
`tables` again, by definition or by patch.
