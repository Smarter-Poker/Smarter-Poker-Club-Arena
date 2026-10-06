# The first close of a long week waits for a quiet hour (2026-10-03)

## What happened

Any transaction running more than ~9 minutes during play bloats the tournament lease rows and
expires leases, so every close transaction is capped at 5 minutes. The week 2026-09-28 07:00 ->
2026-10-05 07:00 UTC carries ~3.2x the volume of the week of 2026-09-21, and not every close step
is split yet: round 3 and its payout loop, the inventory seal (534 s for 478k rows last week), Deep
Stack's preparation and the P&L flows still run longer than 5 minutes in one transaction. Left
alone, the close would start at the first 40-minute tick after its 09:00 UTC due time, Monday
2026-10-05 09:40 UTC, and the seal at 07:40 UTC.

Decision (coordinator, 2026-10-03, "bounded A with a B fallback"): that week's first close attempt
waits, at the latest, until Tuesday 2026-10-06 13:00 UTC, the start of the quietest hour band
measured (13:00-17:00 UTC), and then runs as deployed, whatever is split by then. Money safety is
unchanged either way and nothing pays twice.

## Fix

Migration `20261003155132_the_first_close_of_a_long_week_waits_for_a_quiet_hour`:

- `public.accounting_close_gates`: one row per (scope, week) whose FIRST close attempt waits, with
  `gate_until`; a CHECK keeps `gate_until` within 30 hours of the week's end. Seeded with Midway
  Union and Deep Stack Society for the week 2026-09-28 -> 2026-10-05, until 2026-10-06 13:00 UTC.
- `fn_process_weekly_accounting_scope` asks `fn_accounting_close_gate_holds` right after the week
  is due, before its barrier, locks, run row, preparation or money. While the gate holds and the
  scope has no run row for that week, the visit ends with nothing checked and nothing failed. The
  first held visit files one `financial_alerts` row with severity `warning` (never `critical`, so
  no incident); the gate row counts the held visits (`held_visits`, `first_held_at`,
  `last_held_at`).
- The original inventory seal of the gated boundary (2026-10-05 07:00) waits with the week
  (`fn_accounting_close_seal_held`): it seals rows of the closed week only, so the same checkpoint is
  sealed after the lift.
- Job 272: a tick does not take the large budget for a held seal, and from `gate_until` the job
  calls the close on every tick until the gated scope has started its week
  (`fn_accounting_close_gate_lifted_unstarted`), so it runs at 13:00 UTC, not at 13:40.

Not gated: retries (any run row for the week ends the gate), other scopes, other weeks.

## Lifting it earlier

Only by a later migration that moves `gate_until` earlier, and only once every split step is
proved equal on the week of 2026-09-21, applied and merged.

## Proof

Dry run of the migration against production at 2026-10-03 16:04 UTC, rolled back: the four live
proofs true; Midway held twice (`held_visits` 2) and Deep Stack once, exactly one warning each and
no critical; Midway's previous week, its next week and another scope not held; the 2026-10-05 seal
held and the 2026-09-28 one not; a gate whose `gate_until` has passed does not hold and is seen by
`fn_accounting_close_gate_lifted_unstarted`; a gate 30 hours and 1 second after its week refused by
the CHECK; `plpgsql_check` finds nothing new in the scheduler and nothing in the gate. Scheduler
postimage md5 `e4c537a653cb577dc4c12d909a01c206`, job 272 command md5
`44f3e5a5345938b92158e569d8f0fd70`, both equal to the substituted texts.
