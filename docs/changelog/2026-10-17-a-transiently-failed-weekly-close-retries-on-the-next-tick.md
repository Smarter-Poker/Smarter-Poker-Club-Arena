# A transiently failed weekly close retries on the next tick (2026-10-17)

## What happened

The 2026-10-05 Midway union close paid round 1 (2,180,462.68) and round 2
(1,851,429.22, 12:05 UTC). Round 3 then could not start:

- 17:16:58 UTC: round 3 deadlocked (40P01), the cause fixed by
  `20261017161610` at 17:17:47.
- Job 272 re-runs a failed close every 5 minutes only after a
  `weekly_scope_time_budget_exhausted` failure. A deadlock waits for the next
  :40 tick.
- 17:40: the attempt had to re-prove the union P&L evidence report (82 s),
  because its kept READY receipt (`20261017131056`) lasts 30 minutes and was
  from 17:08. It hit the 240 s statement timeout before round 3. A timeout
  rolls the run row back, so the row still read "deadlock detected" and the
  next attempt was 18:40, when the receipt has expired again.

An attempt once an hour can never reuse a 30 minute receipt, so the close
could not reach round 3. 777 rakeback payouts stayed pending.

A rolled-back diagnostic at 18:02 UTC, run with the same settings as job 272,
measured the work before the cascade: evidence report 82 s, week clubs 8 s
and 35 s, cash source refusals 21 s, recompute checks 28 s, cash commission
check 11 s. It reached the 3 minute scope deadline at 196 s, before the
cascade, and committed nothing.

## The fix

`20261017180833` changes only job 272's admission predicate. A close that
failed in the last 3 hours is also re-run on every tick when its failure was
transient (40P01 deadlock, 40001 serialization failure, 55P03 lock wait), or
when its scope's last scheduler visit hit the statement timeout in the last
3 hours (a timed-out visit cannot write the run row; the scheduler records it
in `weekly_accounting_scheduler_visits`).

The next attempts can then run 5 minutes apart. One that re-proves the report
keeps its receipt, and the next one reuses it and reaches round 3, as the
time-budget case already does.

Unchanged: the 240 s statement bound, the 3 minute scope budget, one attempt
per tick, the chunked mode, every other admission condition, and every
function, rate, payee, amount, routing, receipt, refusal and proof lifetime.

## Verified

- The live command is the recorded postimage of `20261012134146`
  (`b8be947f`). The anchor occurs exactly once, and the read-only substitution
  on production yields `e5c94190`, which the migration and its live proof pin.
- On production at 18:08 UTC the new predicate admits exactly one failed run:
  the 2026-10-05 Midway close (40P01, 17:16:58).
- The migration refuses a changed preimage, a missing or repeated anchor, a
  different postimage, and any change to the job beyond its command.

Law: `tests/a-transiently-failed-weekly-close-retries-on-the-next-tick.law.test.ts`.
