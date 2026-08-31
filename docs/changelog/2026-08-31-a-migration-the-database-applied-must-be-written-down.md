# 2026-08-31 - Nothing ever asked what production had applied that we never wrote down

## The gap

`check-migrations-applied.mjs` runs on every PR and asks one direction: does
every migration a branch **adds** exist in the live schema. It exists because a
committed file that never ran is a feature the code believes in and the database
has never heard of.

Nothing has ever asked the other direction, and the other direction is worse.
Measured today:

```
90 migrations applied since 14:00 UTC
41 of them had no file on origin/main
```

Among those 41 were **all thirteen zero-drift ledger-hardening migrations** -
the append-only `chip_ledger`, the auto-journal triggers on every balance store,
the incident system. They sat unrecorded for hours because that session's GitHub
token was refused, and no gate anywhere noticed the repo had stopped matching
the database.

A **Midway Union master reset** rebuilds from these files. An applied migration
with no file is a hardening production has and the rebuild does not - the one
difference nobody would find until the money moved.

## What was built

**`fn_ca_applied_migrations(p_since text)`** - PostgREST does not expose the
`supabase_migrations` schema, so CI could not read it at all. This is the narrow
door: `version` and `name` only, **never `statements`** (the full DDL of every
migration ever applied), bounded by a caller-supplied floor. Closed to `anon`
and `authenticated`, granted to `service_role`. Its post-apply block asserts all
three: that it answers, that the bound narrows, and that the browser cannot call
it while CI can.

**`scripts/ci/check-applied-migrations-are-recorded.mjs`** - lists what is
applied, lists what the repo carries, prints the difference.

**`.github/workflows/applied-migrations-recorded.yml`** - twice daily, and on
demand with a `since` floor.

## The matcher was wrong the first time, and the fix is the interesting part

The first version keyed on the **version stamp**, treating a shorter stamp as a
prefix match so that `20260831_ca_leak_fixes.sql` could record
`20260831144826`. That is generous, and it was catastrophically so: **28 files
share the bare `20260831` stamp**, so any one of them "recorded" every migration
applied that day. Measured, it reported **2 gaps where there were 41** - the
check would have shipped nearly blind, and blind in the reassuring direction.

It now keys on the **name**. `20260831144826_ca_leak_fixes.sql` records the
applied migration named `ca_leak_fixes` whatever stamp the file carries, and an
exact version match still counts. Naming stays the business of
`check-new-migration-version-collisions.mjs`.

## Scheduled, not a PR gate

There are ~30 outstanding gaps from other agents' in-flight work today. Failing
every PR until somebody else's branch lands would be an outage of its own, so
this runs on a schedule and goes red in the Actions tab. `--fail` is there for
the day the backlog is clear and somebody wants it blocking.

## Tested

```
default 7-day window        41 of 90 unrecorded, listed by version and name
--since 20260831140000      same 41
run from the zero-drift branch (PR #2300)   41 -> 30, the eleven it lands
--fail with gaps            exit 1
empty window                exit 0, "OK - all 0 migration(s) ... have a file"
node --check                clean
```

The one honest gap: the workflow reports through the run status and the job
summary rather than opening a tracking issue. The `gh`-based issue upsert the
estate uses elsewhere could not be exercised locally, and shipping an untested
path into a money-adjacent guard is how a guard becomes decoration.
