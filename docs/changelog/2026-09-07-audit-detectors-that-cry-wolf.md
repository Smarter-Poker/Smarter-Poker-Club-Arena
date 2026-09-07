# The audit tells a retired lane from a silent one, and stops racing the tuner

2026-09-07, from the daily horse audit analysis of 2026-09-06.

Two of the twenty-one findings the audit filed for 2026-09-06 were false, and
neither could ever have been anything else. They are CLAUDE.md 10.86 in its
plainest form - a detector answering confidently when it cannot tell - and
10.84's corollary: an alarm that is always on is an alarm that gets muted.
Twenty real findings sat in the same list.

## 1. `layer_silent: v18_straddle` blamed the brain for a stage nobody built

`fn_audit_layer_silence` carries a hard-coded watch list and warns when a
deployed layer draws zero fires. `v18_straddle` has drawn zero since
2026-09-06, so it warned.

The layer is fine. **Ruling R2 retired the straddle lane on cash games.**
`HorseFleetManager` no longer inserts a straddle table, Gate 5's
`fn_cash_apply_ruleset` forces `straddle_enabled`, `auto_utg_straddle` and
`voluntary_straddle` false on every cash table on every tick, and two law
tests pin that (`TheTablesOpenAndCloseThemselves.law.test.ts`,
`LeaguePmAndStraddle.test.ts`).

Measured 2026-09-07 against production:

| what                                        | value                    |
| ------------------------------------------- | ------------------------ |
| live cash tables with `straddle_enabled`    | **0** (of 140 live cash) |
| tables that still carry the flag            | 99, all `closed`         |
| newest straddle table created               | 2026-09-01               |
| all 99 last touched                         | 2026-09-04 22:02Z        |
| `v18_straddle` fires, 09-04 / 09-05 / 09-06 | 28,864 / 1,928 / **0**   |

The telemetry collapse and the moment the last straddle table closed are the
same event. The layer did not regress; its stage was removed on purpose.

**The fix counts the stage before it accuses the brain.** No live cash table
with `straddle_enabled` gives `layer_retired` at `note` severity, naming R2 so
the next reader does not "wire the flag up" to silence it. A straddle table
that IS live and still draws zero fires keeps the original `warn` - so if R2
is ever reversed the watch comes back on its own, which deleting the row could
not do. Every other layer in the list is untouched.

## 2. `tuner_no_rows` reported a race as a defect

`fn_audit_tuner_health` reads `horse_self_tune_log` for `p_day + 1`. That date
is right - the tuner studies day D on day D+1 - and the race is the bug:

- the audit for day D runs at **~06:05Z on D+1**
- the tuner writes its rows at **~08:00-09:40Z on D+1**

Measured 2026-09-07: the audit generated at 06:05:39Z and filed "No self-tune
rows for 2026-09-07 - the leak profiles did not move". The tuner then wrote
**490 rows** starting 09:00:43Z. The finding was false when it was written, and
is false every day the audit wins the race. Row counts for the four preceding
days (429 / 386 / 383 / 259) show the tuner has never actually been idle.

**Zero rows now means one of two things and the finding says which.** No
`('self_tuner', run_date)` claim in `horse_job_runs` means the job has not run
yet: `tuner_not_yet_run`, `note`, explicitly "not a defect and not a clean bill
of health", with the ~12:00Z threshold past which it becomes real. A day the
tuner claimed and still wrote nothing keeps `tuner_no_rows` at `warn` - that is
the defect the original was written for, and it is unchanged.

## What is deliberately not in here

The audit's other nineteen findings for 2026-09-06 were checked and stand. In
particular `tag_ev_negative` was suspected of loss-side selection bias - every
base leak tag has zero winning rows - and it is **not** biased: it pairs each
tag with its `_won` mirror (`coldcall_stackoff`: 6,410 hands, 1,178 won, win
rate 0.184). The five unmirrored tags are exactly the five the audit already
files as `tag_measurement_only`. That machinery is correct and was left alone.

## Files

- `supabase/migrations/20260907101200_the_audit_tells_a_retired_lane_from_a_silent_one_and_does_no.sql`
- `tests/audit-detectors-say-when-they-cannot-tell.test.ts` (12 tests)
