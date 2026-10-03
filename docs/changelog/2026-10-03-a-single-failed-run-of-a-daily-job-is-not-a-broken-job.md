# A single failed run of a daily job is not a broken job

2026-10-03. `Cron Health` was one of the last red workflows on `main`, and its
finding was the only one nobody had opened.

## What the run said

Run [37105150898](https://github.com/Smarter-Poker/club-arena/actions/runs/37105150898)
(07:05 UTC, head `940c273ea1`):

```
124 active job(s) over 24 hours: 65 ok - 54 warn - 2 critical - 3 idle
  CRITICAL ca-ledger-replay-nightly                1 failed / 1 runs   40 6 * * *
           ERROR:  canceling statement due to statement timeout
  CRITICAL tourney_money_conservation_deep_daily   1 failed / 1 runs   25 3 * * *
           ERROR:  canceling statement due to statement timeout
```

The run before it (37076603235, 23:14 UTC on 10-02) had **four** criticals.
`ca-op-claims-prune-daily` and `union-law-selftest` were already fixed by
#5925, _"retired schedules, frozen ticks and deleted owner clubs are not
failures"_, which merged at 05:55. They are not re-diagnosed here.

Two remained, and they turned out to be two different faults sharing one word.

## 1. The check answered "broken, not flaky" from a sample of one

`fn_ca_cron_health` decides the verdict with

```sql
when a.successes = 0 then 'critical'
```

and `scripts/ci/check-cron-health.mjs` prints that as **"RAN AND NEVER
SUCCEEDED - these are broken, not flaky"** and exits 1.

That sentence is true for the outage the function was written for in
`20260831193608`: `sp_upcoming_tournament_pushes` ran every minute and had
4,017 finished runs with no successes.

It is not true for a job whose period is the window. A `25 3 * * *` job puts
**exactly one run** inside 24 hours, so `successes = 0` carries no information
about whether the job is broken or simply failed last night. The function was
asserting the strongest of its four verdicts from a single sample - CLAUDE.md
10.86 rule 1, where "I could not tell" gets folded into the confident answer
instead of being resolved.

The asymmetry it produced, on that same run: `ca-payout-guarantee-check-hourly`
failed **13 of its 24** runs and is only `warn`, because one success clears it,
while a daily job that failed **once** is `critical`. The standard is not
stricter for the daily job. The window simply cannot sample it.

**The fix resolves the unknown by measuring.** When the window holds exactly
one finished run and it failed, the verdict is decided by that job's last
**three** finished runs - evidence the window could not hold:

- a success among them -> `warn` (it works; it failed this time)
- none among them -> `critical` (three consecutive failures)

Three, not five. Five was rejected deliberately, because it would have cleared
_both_ jobs and made the migration a way of turning the board green. Three is
the smallest sample in which "always fails" is distinguishable from "failed",
and it still declares a genuinely dead daily job broken within three days.
Measured against production before it was applied, it changes exactly one of
the two verdicts and nothing else on the 124-job roster:

| job                                     | last 3 finished runs      | verdict    |
| --------------------------------------- | ------------------------- | ---------- |
| `ca-ledger-replay-nightly`              | failed, failed, succeeded | `warn`     |
| `tourney_money_conservation_deep_daily` | failed, failed, failed    | `critical` |

A minutely job is untouched: it has 1,431 finished runs, so the single-sample
branch never applies to it, and a real silent failure is still critical on its
first window.

The verdict is now also computed **once**, in a `decided` CTE, rather than
written twice (select list and `ORDER BY`) as two copies free to drift.
`distinct on (w.jobid)` and the single-row evidence columns are unchanged, so
`20260919172421`'s law still holds.

## 1a. The first version of this did not apply, and it was my mistake

Worth keeping, because it is CLAUDE.md 10.86 rule 4 happening to the person
writing about 10.86: a fix that leaves the same trap one level up has not
landed.

The first draft asked for the last three runs with a **correlated** subquery,
`order by r2.start_time desc limit 3`, once per single-sample job.
`cron.job_run_details` has **no index at all** - every read of it is a
sequential scan of 280,684 rows - so that form re-scanned the whole log per
job. The function went from **546 ms to 27,665 ms**: a 50x regression in the
health check, shipped to repair a health check.

It never reached production. Apply run
[37108462464](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37108462464)
was cancelled at 62,105 ms and the transaction rolled back whole; nothing
committed and no `schema_migrations` row was written. Two separate things were
wrong:

1. **The look-back was O(jobs x log).** It is now one ranked pass -
   `row_number() over (partition by jobid order by start_time desc)` with
   `rn <= 3` - which Postgres pushes into the window as a `Run Condition` so it
   stops early. **698 ms**, +152 ms on the old function, and the verdicts are
   identical: 65 ok, 55 warn, 1 critical, 3 idle both ways.
2. **The read-back only asked whether the function answered.** It did answer -
   correctly, in 27.7 s - and the assertion passed. The read-back now **times**
   it and refuses anything over 10 s, naming the correlated form in the error.

And one thing about the applier that is easy to get wrong:
`scripts/ci/apply-recorded-migration.mjs` sends the whole file in a single
`client.query()`, so `statement_timeout` governs the **entire migration**, not
each statement in it. `SET LOCAL statement_timeout = '60s'` was therefore a 60 s
budget for the whole file. It is now 180 s against ~2.4 s of measured work.

The honest version of the mistake: the **verdicts** were verified against
production before applying, and the **cost** was not. `tests/unit/cronHealthSampleOfOne.test.ts`
now forbids a correlated read of the run log, and pins the timing assertion.

## 2. The deep conservation audit really is broken

It is **not** excused by the above, and stays critical until it completes.
From `cron.job_run_details`, jobid 274, eight days to 07:10 UTC:

```
09-27  217.1 s  ok          10-01  601.0 s  CANCELLED
09-28  540.5 s  ok          10-02  600.8 s  CANCELLED
09-29  601.6 s  CANCELLED   10-03  600.2 s  CANCELLED
09-30  414.1 s  ok
```

Every cancel is at its own 600 s budget, inside
`fn_tournament_conservation_delta`. The job calls that delta once per event
over a 45-day window. Measured read-only against production, sampling _across_
the window rather than the freshest (the newest 300 cost 0.78 ms each and are
not representative):

| sample       | total     | per event | projected full scan |
| ------------ | --------- | --------- | ------------------- |
| 400 events   | 2,197 ms  | 5.49 ms   | ~779 s              |
| 2,500 events | 15,498 ms | 6.20 ms   | **~880 s**          |

141,924 events are in the window. Pass 1 adds nothing right now: 0 open alerts
from this source. So one run needs ~880 s against a 600 s ceiling - the budget
is 68% of what the job costs.

Because a statement timeout is `QUERY_CANCELED`, a cancelled run **rolls back
entirely**: the 1-45 day tail has not been audited since 09-30. Recent events
are still covered hourly by `tourney_money_conservation_hourly` (1-day window).

The budget moves 600 s -> 1500 s. That is 1.7x the measured 880 s and 7x the
09-27 cost, and the run cannot reach the maintenance break: it starts at 03:25
and now ends by 03:50 at worst, before the :53 announcement and the :55 freeze.
The job writes only `financial_alerts`, which carries no `zz_freeze_guard`, so
it was never at risk of being refused by the freeze; the ceiling is set to keep
a 25-minute read snapshot off the engine restart.

**A budget is not a cure**, and is not described as one - the same wording and
reasoning as `20260927164653`, which gave `ca-conservation-sweep-hourly` the
600 s its 30 checks measured. 1.7x is thinner headroom than that migration's
5x, and it is stated rather than dressed up: the ceiling cannot go higher
without reaching the break, and the cost it is 1.7x of was measured during the
worst degradation this estate has recorded.

**If it fails again, the answer is not a third budget.** It is making the pass
set-based - one grouped read per source table instead of 141,924 separate delta
calls each doing ~14 index probes - because the scan also grows by ~3,150
events a day on its own and will cross any fixed ceiling eventually. That
rewrite has to prove identical verdicts over the whole window before it lands,
which is why it is not bundled into a migration repairing a timeout.

Every subquery in the delta is already indexed, checked one by one:
`idx_wallet_tx_tournament_receipts_cover`, `idx_chip_ledger_tournament_category`,
`idx_chip_ledger_overlay_by_tournament`, `idx_chip_ledger_reviewed_overlay_returns`,
`idx_tournament_payouts_satellite_target`, `idx_rake_records_tournament`. There
is no missing index to add. The cost is the 141,924 events themselves.

## 3. Not fixed here, and not ours: the multixact SLRU is thrashing

The per-event cost roughly **quadrupled in six days** (1.5 ms on 09-27, 6.20 ms
now) without the window growing anything like that much. That is platform-wide,
not a defect in either job. From `pg_stat_slru`, stats reset
2026-09-28 16:36:37 UTC - the day before the first cancel:

| slru               | blks_hit       | blks_read     | miss       |
| ------------------ | -------------- | ------------- | ---------- |
| `multixact_member` | 5,712,570,159  | 3,250,294,240 | **36.26%** |
| `multixact_offset` | 6,433,676,628  | 2,522,828,003 | **28.17%** |
| `transaction`      | 15,874,255,128 | 2,495,422     | 0.02%      |
| `subtransaction`   | 7,979,514,144  | 0             | 0.00%      |

3.25 **billion** member reads in 4.6 days is ~8,200 a second, every one a miss
against a 32-buffer cache taking an SLRU lock, while the ordinary `transaction`
SLRU beside it misses 0.02%. `multixact_member_buffers` is 32 and
`multixact_offset_buffers` is 16, both defaults.

Raising them requires a **Postgres restart**, so it is a configuration change
no migration can make. It is already a tracked platform condition: MultiXact
SLRU was 9% of all sampled waits in
[`2026-10-01-three-slow-paths-do-only-the-work-they-act-on.md`](./2026-10-01-three-slow-paths-do-only-the-work-they-act-on.md).

It is recorded with its numbers because it is the reason two audits that fit
their budgets a week ago no longer do, and because the next agent to find a
`57014` in this estate should read that table before rewriting a query. This
work does not claim to have fixed it.

## The 54 warns

Unchanged and not touched. They are the ordinary shape of this board under the
condition in section 3: 13 of 24 for `ca-payout-guarantee-check-hourly`, 12 of
24 for `ca-ratchet-watch-hourly`, and a long tail of minutely jobs losing a
handful of runs out of 1,431. Several were re-budgeted or narrowed earlier the
same day by `20261003025058` and `20261003025434`. The warn count moves 54 -> 55
purely because `ca-ledger-replay-nightly` is now correctly counted as one.

`ca-ledger-replay-nightly` is itself at the edge - 322 s to 627 s on a 600 s
per-statement budget over the last week - and will keep tipping over until
section 3 is resolved. It is left at its current budget deliberately: it is
`warn` because it genuinely does succeed, and re-budgeting a second audit
against a transient platform fault is the trap CLAUDE.md 10.86 rule 4 names.

## Files

- `supabase/migrations/20261003072524_a_single_failed_run_of_a_daily_job_is_not_a_broken_job.sql`
- `tests/unit/cronHealthSampleOfOne.test.ts`
