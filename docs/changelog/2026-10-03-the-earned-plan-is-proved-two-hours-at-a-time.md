# The earned plan is proved two hours at a time (2026-10-03)

## What happened

The lease agent found that any transaction running more than about 9 minutes during play bloats the
tournament lease rows and expires leases (about 800 at 09:34-09:38 during a 15-minute probe), and
the coordinator capped every close transaction at 5 minutes. The union earned plan took 193 s and
320 s for Midway's week of 2026-09-21 (548k sources); the week closing 2026-10-05 is projected at
about 3.2 times the sources (1.09M cash sources by Saturday 12:45 UTC, about 13k an hour since).

## Fix

Migration `20261003140241_the_earned_plan_is_proved_two_hours_at_a_time`, only inside a chunked
union close attempt:

- `fn_accounting_union_earned_plan_window` is the set path itself, derived from the live
  `fn_accounting_union_earned_plan_sets` by anchored edits, over one two-hour window. Every one of
  its six proofs tests one source, bank row or receipt against rows of the same instant, so the week
  passes exactly when every window does. A passing window returns its raw sums, its club/game basis
  sums and each source's own row md5.
- `fn_accounting_union_earned_plan_advance` proves the missing windows, at least one per attempt and
  none started more than 120 s after the attempt began, into the private, unlogged
  `accounting_close_partials` (a recomputable cache, kept out of the WAL). A window the set path does
  not certify is proved by v3 over that window, which refuses exactly as it refuses the week.
- `fn_accounting_union_earned_plan_combine` builds the identical plan from all windows: the same
  conservation refusal, exact numeric sums, the same basis rate and payout, and the md5 of every row
  md5 in (source_type, source_id) order. `fn_accounting_union_earned_plan` answers from it before the
  set path; the evidence report stops `warming` while any window is missing.

Outside a chunked close nothing changes.

## Proof (2026-10-03, Midway, week 2026-09-21..28)

The 84 windows (502,680 cash and 45,340 tournament sources) were proved in two committed cron probes
of 122 s and 20 s and combined in 2.4 s. The combined plan's md5 is
`dab1e5a65a3084c4c0dffb8ca18f7a45`, identical to the plan the set path and v3 returned for that week.
