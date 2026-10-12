# The open-week rake basis is refreshed two hours at a time (2026-10-03)

## What happened

Job 123 (`union-integrity-sweep`) ends with `fn_union_rake_basis_refresh`, a reporting snapshot of
the open week's certified earned plan (`union_rake_basis_snapshot`). Every hour it proved the whole
week so far in one read. By Saturday evening Midway's open week held 1.2M cash sources, and one peak
two-hour window alone took 35.6 s, so every run since 2026-09-28 21:35 hit the job's 300 s statement
timeout. The refresh rolled back each time and the snapshot stayed stale. Its own input stamp read
the earning-sources view over the whole week, which took over 60 s on its own.

## Fix

Migration `20261003224956_the_open_week_rake_basis_is_refreshed_two_hours_at_a_time`:

- `union_rake_basis_windows` keeps each closed two-hour window of a union's open week:
  `fn_accounting_union_earned_plan_window`'s value (the chunked close's proved window) and the input
  stamp it was proved under. The stamp covers the window's bank rows (count, sum), cash bank
  receipts, fee recognitions, recognized fee sources and cash accrual batches, plus the agreement
  history observed before the window's end (count, max id) and the clubs scope digest. All of those
  tables are append-only. A window counts as closed once the settler's accrual cursor has passed its
  end.
- `fn_union_rake_basis_windowed(union, start, through)`:
  - reuses each closed window whose stamp is unchanged;
  - proves new or changed windows and the open tail window, starting no closed window 120 s into the
    statement and no tail window 180 s in;
  - combines them exactly as `fn_accounting_union_earned_plan_combine` does;
  - answers `in_progress` while windows remain, and the next hour continues from the saved ones;
  - answers NULL when a window doesn't prove, the windows don't conserve the bank, or the period has
    a final settlement witness. The refresh then reads `fn_union_club_rake_basis` exactly as before.
- `fn_union_rake_basis_refresh` uses it. Its whole-week input stamp now counts accrual batches and
  recognized fee sources instead of reading the view, since sources are written with their batch or
  their recognition.

The first runs after the deploy fill the open week's windows in a few hourly steps of about two
minutes each. After that, a run proves one new window and the tail.

## Proof

Each proof was a dry run against production, rolled back. Each compared md5 of the snapshot detail
built from the old one-read path (`fn_union_club_rake_basis`) with the detail built from the windowed
path, on Midway:

| Range (closed) | Rows | One-read md5 | Windowed md5 | Second call (closed window reused, tail recomputed) |
|---|---|---|---|---|
| 2026-09-28 07:00 to 09:20 | 8 | `051d7df05abb1d6c14c060cf7f62e50f` | equal (5.5 s) | equal (0.5 s) |
| 2026-09-26 01:00 to 03:30 | 10 | `2d727a960602932b8cb92e6381a41d90` | equal (1.0 s) | equal (0.16 s) |

The second dry run included the refresh rewrite. Its postimage md5 is
`c88e99cda4f091c9e48b0f6b173651a4`, equal to the substituted text. `plpgsql_check` finds no errors in
either function.
