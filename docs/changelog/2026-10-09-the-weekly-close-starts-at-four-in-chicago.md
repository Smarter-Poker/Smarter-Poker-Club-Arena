# The weekly close starts at four in Chicago

Job 272 (`union-weekly-rakeback-close`) wakes every five minutes, but its
command admitted an ordinary ungated first attempt only at minute 40. The
existing due time is Monday 04:00 America/Chicago. A recently lifted explicit
gate or an already running chunk could admit an earlier tick; a normal new
week had neither.

Migration `20261009005558_the_weekly_close_starts_at_four_in_chicago.sql`
adds the interval from the current week's existing due time through its first
40 minutes to that command's condition. This admits 04:00 and subsequent
five-minute ticks, including 04:05 after a freeze or another scope's visit.
The existing minute-40 and work-in-progress conditions remain unchanged.

The migration pins the live command read on 2026-10-09, job ID, schedule and
active state, changes only the command through `cron.alter_job`, and verifies
the complete job row afterward. It refuses an unexpected preimage or replay.
The same coordinator continues to own due times, scope gates, platform freeze,
advisory locks, one-attempt budget, 9/50-minute scope budgets and money receipts.
It adds no cron job, writer, release path, or financial data repair.

The existing `union-own-period-settles.yml` regression now also runs the
stored command and exact migration in disposable PostgreSQL 17 with real
pg_cron and its launcher disabled. A controlled clock proves the before/after
04:00 and 04:05 behavior in DST and standard time, the next Monday, before-due
and off-day refusals, unchanged budgets and ongoing-work admission. Its safety
cases execute the captured production scope coordinator and existing gate
helper: freeze still refuses, and a held week records its warning without
creating a run. The fixture stops before payment execution and does not claim
to simulate the cron wall clock. The expanded suite passed 66 checks locally;
its disposable cluster was removed. Hosted checks, protected merge and exact
installation/readback are separate delivery evidence.
