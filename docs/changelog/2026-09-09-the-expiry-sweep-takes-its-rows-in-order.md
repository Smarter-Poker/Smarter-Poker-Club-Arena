# The expiry sweep takes its rows in order

2026-09-09

## Found by following a red workflow

`Cron Health` was failing on `main` at "Fail the run when a job never
succeeded". Its summary named exactly one job:

```
RAN AND NEVER SUCCEEDED - these are broken, not flaky:
CRITICAL daily-missions-reward-expiry   1 failed / 1 runs   7 0 * * *
         ERROR:  deadlock detected
```

**One run, one failure, never a success.** So the job had never expired
anything since the day it was created.

## The cause

`fn_expire_daily_challenge_rewards()` was a single bare `UPDATE` across the
whole of `user_daily_challenges`:

```sql
UPDATE public.user_daily_challenges
   SET expired_at = now()
 WHERE completed AND NOT claimed AND expired_at IS NULL
   AND completed_at < now() - interval '7 days';
```

A bulk `UPDATE` takes its row locks in whatever order the plan happens to
produce them. A player claiming or completing a challenge at the same moment
takes exactly one row. So the two can each end up holding what the other is
waiting for, and Postgres breaks the cycle by killing one of them - which,
against a busy player-facing table, is reliably the nightly sweep.

Nothing about it was flaky. An unordered bulk write against a row a user can
touch is a deadlock waiting for enough traffic, and this table has that traffic
every night at 00:07.

## The fix

```sql
WITH due AS (
  SELECT id
    FROM public.user_daily_challenges
   WHERE completed AND NOT claimed AND expired_at IS NULL
     AND completed_at < now() - interval '7 days'
   ORDER BY id
     FOR UPDATE SKIP LOCKED
)
UPDATE public.user_daily_challenges u
   SET expired_at = now()
  FROM due
 WHERE u.id = due.id;
```

`ORDER BY id` gives every caller the same acquisition order, which is what makes
a cycle impossible.

`SKIP LOCKED` does the rest, and it is a correctness improvement rather than a
compromise: **a row a player is holding right now is a row being claimed**, and
a claimed reward must not be expired out from under them. Skipping it is the
right outcome. If it is still unclaimed tomorrow the next run takes it, and the
window is a seven-day one either way.

## Not a repair job

CLAUDE.md 10.12 bans jobs that back-fill or repair what a live path should have
done. This is the other kind, explicitly carved out: **its schedule IS the
product.** A reward expires seven days after it is earned, and something has to
notice the day arriving.

## Verification

- Applied as `20260909072230`, with three post-checks in the migration: the
  ordering, the skip, and the `service_role` guard it must not lose.
- Run once afterwards: **954 rows expired** - the entire backlog the job had
  never been able to clear.
- `Cron Health` should go green on its next run; that job is the reader.
