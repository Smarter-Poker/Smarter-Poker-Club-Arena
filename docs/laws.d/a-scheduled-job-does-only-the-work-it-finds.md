# tests/a-scheduled-job-does-only-the-work-it-finds.law.test.ts

## The law

A scheduled job writes only the rows it actually corrects, and asks only a
question it can finish answering inside its own budget.

## Two jobs, failing in opposite directions

### The reconciler that rewrote every row

`fn_reconcile_club_member_daily_profit` matched its `UPDATE` on identity alone
and never asked whether the value was changing. Postgres counts an unchanged
row as updated, so every call rewrote every row in scope.

Measured 2026-09-19: **42,094** rows genuinely in scope for one `stat_date`,
**2,820,298** `rows_updated` recorded for that same `stat_date` in one day.
Exactly 67x, because an off-box scheduler
(`Smarter-Poker-World-Hub/scripts/openclaw-cron-dispatcher.py:553`) calls the
RPC every 15 minutes although pg_cron schedules it once a day. The first run
closed a real 19,392.15 chip drift; the other 66 corrected nothing. Over 30
days, 10,469,974 `rows_updated`.

The second cost is that `rows_updated` is the estate's only record of how much
this reconciler corrects, and it was reporting the size of the table instead.

### The detector that timed out

`fn_pay_backed_payout_shortfalls` ran `fn_tournament_conservation_delta` per row
over every `COMPLETED` tournament with no time bound, under a 120s
`statement_timeout`, and failed 21 of its last 24 runs at exactly 120.0s.
Measured with `EXPLAIN ANALYZE`: unbounded over 120,000 ms and cancelled;
bounded to 30 days, **21,817 ms**.

A detector that times out is worse than an absent one, because the estate counts
it as coverage.

## Why the law pins shape, not outcome

Each fix is one predicate, and in each case a plausible edit silently undoes it:

- `s.profit <> (...)` instead of `IS DISTINCT FROM` reads as equivalent and is
  not. It evaluates to NULL for a NULL profit, so it would skip exactly the rows
  that most need the correction.
- Moving the time bound _after_ the delta predicate reads the same and restores
  the timeout, because the delta is then computed for every row before anything
  can be filtered.

So the law asserts operator and order, not merely presence.

## The band-aids that were refused

**Changing the caller's schedule.** The `*/15` dispatcher cadence is worth
questioning, but a function that rewrites 42,094 unchanged rows is wrong when
called once a day too. Fixing the schedule would hide the defect and the next
caller would rediscover it.

**Raising `statement_timeout`.** One word, and it turns the red job green while
leaving the real question unasked: how far back should this reach. A timeout is
a symptom of an unasked question.

**Adding a `p_since_days` parameter.** `CREATE OR REPLACE` cannot change an
argument list, so a third parameter creates an _overload_; the cron's
zero-argument call would then match both candidates and fail as ambiguous. This
estate already paid for that in
`20260831232524_spin_chip_conservation_check_rename_off_the_overload`.

## What the bound gives up

A tournament that begins owing money more than 30 days after it ended will not
be seen by that job. Never observed; the alternative was seeing nothing at all
87.5% of the time.

## Forward guard

Binds from 20260920. No later migration may rewrite the reconciler without the
change guard, use `<>` where a NULL profit would be skipped, or leave the
detector's delta unbounded.
