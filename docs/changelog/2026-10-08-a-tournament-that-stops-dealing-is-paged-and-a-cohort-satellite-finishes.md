# A Tournament That Stops Dealing Is Paged, And A Cohort Satellite Finishes (2026-10-08)

## What Dan reported

About 500 engine log lines of `satellite ... has missing or extra obligation
evidence`, and MTTs and Spins that freeze and never finish.

## What was actually happening, read from production

Three different freeze mechanisms in the seven days to 2026-10-08, and one
common gap: none of them raised an alert.

1. **2026-10-07 17:38Z to 2026-10-08 11:05Z, satellite 32190e8c "Sunday Deep
   Stack Satellite $25".** Down to three players, all three qualifiers, so the
   finish is the cohort settlement. `fn_ca_satellite_cohort_receipt` still
   counted a settled pre-start unregistration refund as "extra obligation
   evidence" (migration 20261003023500 fixed the single-winner receipt and both
   settlement entries, not the cohort receipt). The settlement wrote correctly,
   refused its own replay, rolled back, and the manager retried every sweep:
   ~500 refusals, the table parked at the qualifier boundary, killed and
   rebuilt as a `tournament_table_zombie` every ten minutes, three qualifiers
   unpaid for 17 hours.
2. **2026-10-06 15:33Z, 55 events dark 8.5 to 22.8 hours.** A foreign psql
   session in replica mode force-drained horse identities out of live events
   with NULL `elimination_sequence`. Already fixed (20261007132903 ENABLE
   ALWAYS on the stamp trigger, 20261007151627 and 20261007132839 data
   repair). Recorded here because it is what "Spins freezing" looked like.
3. **2026-10-03 23:43Z, 16 events dark 14.4 hours.** Tournament leases lost
   under database latency; every re-admission refused with
   `f06_mixed_successor_custody_unproven` until the 2026-10-04 custody
   migrations. No recurrence in the live engine since.

The existing watch, `fn_ca_tournament_finished_but_not_completed`, only
judges an event once it is down to one player, and skips satellites. Every
event above had two or more live players. Nothing on the database could see
them.

## What changed

- `supabase/migrations/20261008113442_...cohort_sa.sql`: the cohort receipt
  ignores a settled pre-start unregistration refund, exactly as the
  single-winner receipt does. Proved before apply in a rolled-back transaction:
  `fn_ca_settle_satellite_cohort(32190e8c, ...)` returned ok, pool 600, 3 x 200
  tickets, fee bank 60 recognized, receipt v3, fully settled.
- `supabase/migrations/20261008113537_...twen.sql`:
  `fn_ca_tournament_dark_while_running(20)` on a five-minute cron. Every
  RUNNING event of every type (satellites included) with two or more live
  players and no sign of life for 20 live engine minutes (or 60 wall-clock)
  raises one CRITICAL financial alert, resolved when it finishes or deals
  again. Read against the live fleet: one hit (32190e8c), zero false positives.
- `server/src/tournament/TournamentManagerEliminations.ts`: a repeated
  satellite qualifier refusal raises a CRITICAL financial alert
  (`Tournament.satellite_qualifiers_refused_repeatedly`, deduped per
  tournament, refreshed every ten minutes) instead of one error-reporter line
  per sweep. Retry behaviour is unchanged.

## Not changed, noted

`start_failed:start_load_table` killed and rebuilt three cash tables (NLH 1/2,
NLH 2/5, NLH 10/25) 1,482 times between 2026-10-07 11:55Z and 2026-10-08
08:00Z. Cash lane, stopped on its own at 08:00Z, not a tournament freeze.

## Hardening pass (same day, second PR)

Dan: tournaments, Spins and Sit & Gos must self-heal, never freeze, always
pay out and finish.

### Found by replaying every receipt of the last seven days

- 328 of 562 completed satellites refused their own receipt on replay
  (`malformed or extra actual-seat evidence`): a redeemed entry ticket
  registers its holder in the target with `source_satellite_id` set, and the
  receipt read that as an extra seat from 22 seconds after settlement. The
  manager's completion read, recovery and the player's result screen all
  replay the receipt. Fixed in both receipts, both branches
  (20261008140724; 20261008140504 was a no-op whose guard matched existing
  text, recorded as such). 562/562 replay clean after.
- 603/603 MTTs and 3,000/3,000 Spins and Sit & Gos of the last hours replay
  clean.

### Self-heal and paging now in the engine

- `GameServer.rebuildManagersOfDarkTournaments` (every minute): the database's
  own definition of dark (`fn_ca_tournament_dark_candidates(15)`, 20261008140537) names RUNNING events with 2+ live players and no sign of
  life for 15 live minutes; the exact manager this process holds is retired
  so RUNNING resume re-admits it from durable state - a new manager, new table
  engines, every in-memory claim gone. Once per tournament per 30 min; never
  during a break, a fresh admission, a healthy park (under
  MAX_HEALTHY_PAUSE_MS) or a maintenance freeze. Dark again after a rebuild
  raises `GameServer.tournament_dark_after_rebuild` (critical).
- `GameServer.pageLongFailingResumes`: a tournament whose resume has been
  failing for 10 minutes raises `GameServer.tournament_resume_failing_repeatedly`
  (critical, per tournament, refreshed every 30 min). The 2026-10-03 outage
  held sixteen of these for 14.4 hours with only a /health counter to show.

### Standing audit

- `fn_ca_replay_terminal_receipts` on cron `ca-terminal-receipt-replay-daily`
  (04:37 UTC): replays every receipt of the last 26 hours and raises one
  critical alert per distinct refusal text, self-closing when it no longer
  reproduces. The next receipt divergence is found the day it appears.
