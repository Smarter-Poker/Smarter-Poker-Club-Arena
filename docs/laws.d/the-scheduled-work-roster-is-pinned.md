# tests/the-scheduled-work-roster-is-pinned.law.test.ts

## The law

The number of active pg_cron jobs on production is pinned in a file git owns.
It cannot change without a reviewed edit in two places.

Measured 2026-09-19: **135 active**, **137 rows** in `cron.job`. The two that are
not active are the bust sweeps that
`20260910073355_the_retired_sweeps_keep_their_disabled_schedule_rows` restored
and disabled, so the staged retirement chain `20260910000850` — whose CHECK
constraints demand exactly two rows — can still be applied.

## What it catches, in both directions

**A job that appears** is periodic work nobody reviewed. That is how
`diamond-spin-daily-settlement` arrived on 2026-09-19 without any gate noticing.

**A job that vanishes** is the harder case, and the reason this exists.
`20260906114257_the_cron_roster_goes_too` records the finding in prose: migration
`20260831112020` is recorded APPLIED and the cron job it created was simply not
in `cron.job` any more. No other check in this estate can see that, because
every one of them measures jobs that **run and fail**, and a job that no longer
exists never fails.

## Why a file, not a query, and not a table

Law tests run in CI with no database credentials, so this cannot ask production
anything — and it does not need to.

It also must not recreate what was deliberately removed.
`20260906114257` deleted `ca_expected_cron_jobs` and unscheduled the hourly job
that watched it, on the owner's direct instruction that a cron which monitors or
fixes is itself a band-aid. This law brings back neither. The reader is a
generator that rides **Cron Health's existing timer**, adds no schedule of its
own, and writes a file rather than a row. The law asserts both: that
`cron-health.yml` invokes it, and that `cron-health.yml` still has exactly one
`- cron:` line.

## The generator refuses rather than erases

An HTTP error or an empty array would, naively handled, rewrite the roster to
zero rows and then report "unchanged" forever after. Both are explicit refusals
with exit code 2, and the law pins those refusals by their message text.

## Forward guard

The pin binds from the file's own `observed_at`. Any job added after it moves
the body, the `# active:` header and `ACTIVE_JOBS` in the law — all three
together, in one diff that has to say which job moved and why. The number is not
defended; it is made impossible to change quietly.
