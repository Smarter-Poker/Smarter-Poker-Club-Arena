# The window overtook the limit, and my own alarm over-claimed about it

2026-09-01. Two corrections, ten minutes apart, both to work I shipped earlier
today.

## 1. The narrow payout pass stopped covering its own window

`RakebackSettlerService` runs the payout sweep two ways: a **narrow** pass every
cycle (2 days, 6,000 rows) and a **deep** pass every 24th cycle (30 days,
40,000). The comment above the narrow limit explains the rule it was chosen by —
_"the limit has to EXCEED the window's population or the window is
decorative"_ — and sizes it against a measurement from 2026-08-27: ~1,174
events/day, so a 2-day window holds ~2,350, and 6,000 is a comfortable 2.5x.

Daily volume has roughly tripled since. The 2-day window now holds **6,959**
events, so the narrow pass was examining 6,000 and stopping — decorative again,
by its own definition.

**This was never a silent miss.** The deep pass reaches the remainder within
about twelve hours, which is exactly why nobody noticed. It is still twelve
hours of an underpaid player waiting on a pass that had the budget to reach them
and did not.

Measured against production: the full 2-day window, all 6,959 events,
reconciles in **5.7 seconds**. The headroom costs about a second. The old
comment's worry about PostgREST's single-digit statement timeout no longer
applies either — the RPC sets its own `statement_timeout = 600s`, which
overrides it for the call.

Raised to **20,000**, ~3x the current population, the same multiple 6,000 was
originally chosen at.

## 2. My truncation alarm asserted something false

The guard I shipped an hour earlier made a truncated _applying_ pass raise a
`critical` alert, reasoning that the sweep orders newest-first so anything it
misses only gets older and **"no later pass will reach them either."**

That is true of the hourly `pg_cron` job, which has nothing behind it. It is
not true of `RakebackSettlerService`, which I did not know about when I wrote
it — the narrow pass truncates _by design_ and the deep pass is what catches the
tail.

So the first thing my new guard did was fire `critical` on a caller that is
working as intended, with a message stating something untrue. That is the same
failure I had spent the morning fixing in the engine watchdog: an alarm that is
right about the reading and wrong about whether anything is broken. It earns the
same correction rather than an exception for being mine.

The alert now reports what the function can actually see — how much of the
window this pass left unexamined — and says the remainder is reached only by a
wider pass _if one is configured_, instead of asserting that none exists. It is
a `warning`, not a `critical`. A function cannot diagnose its own caller, so it
reports and stops there.

Both open alerts were resolved in the same migration: the truncation one because
it asserted something untrue, and the duplicate-payout one because it describes
the closed 2026-08-31 incident and was ageing out of its 24-hour window anyway.
Leaving either open would dedupe the next real occurrence into silence, which is
the failure both guards exist to prevent.
