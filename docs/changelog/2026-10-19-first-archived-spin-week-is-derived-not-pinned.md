# The first archived Spin rehearsal binds to the database's own week, not a pinned one

## What broke

From 2026-10-19T07:00:00Z (midnight Pacific, the union-week rollover) every pull
request failed the required step "Spin expiry lock order and committed refund
contracts" in `Accounting transactions (PostgreSQL 17) shard 1/4`. The
`first-archived-spin` image stopped at stage `archive_temporal_refusal`:

```
first-temporal-refusal.sql:43: ERROR:  P0001: ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED
```

(run 39230847785, job 118011579791; reproduced locally on PostgreSQL 17 with
`--image first-archived-spin`, same stage, same error.)

## Root cause

Seven carriers of the archived rehearsal (`first-temporal-refusal.sql`,
`first-connected-probe.sql`, `first-atomic-failures.sql`,
`first-production-rollback-probe.sql`, `first-canonical-completion.sql`,
`spin-first-archived-locks.py`, `spin-first-archived-concurrency.py`) refused
to run unless the CI runner's wall clock fell inside one literal union week
(`2026-10-12T07:00Z..2026-10-19T07:00Z`), copied from a production capture.
`validate_recognition_capture` required those literals in every carrier. So
the required check was a time bomb that went off every Monday at 07:00 UTC.
It was "fixed" by a fresh production capture and a one-week bump four weeks
running (2026-09-28, 10-05, 10-12, and again today in #7420, which pinned
`2026-10-19T07:00Z..2026-10-26T07:00Z` and would have expired the same way on
2026-10-26). That is the band-aid that CLAUDE.md 10.12 forbids. This change is
built on #7420's capture, which stays as the active historical record.

The literal week no longer protects anything in production. The event
(`2aa4cba1-506f-426b-a1ba-d8e22e018533`) settled in production on
2026-10-02T02:17:17Z (read-only readback of `tournament_terminal_settlements`
on 2026-10-19). Against production, both the completion SQL and the rollback
probe now refuse earlier with `PROBE_PRIOR_AUTHORITY_REQUIRES_READBACK`.
Every carrier runs only against the isolated, seeded rehearsal database. Its
state is fixed: it seeds no routed settlement run, and the scope is pinned
in-database. So the week the run happens to land in cannot change any outcome.
The four earlier rollovers changed only the bounds and the hashes, never an
expected output.

## Fix

- Each carrier now binds its transaction to the recognition week that the
  database derives for it: `fn_union_week_start(transaction_timestamp())`,
  ending seven Pacific days later, the same definition the capture query uses.
  It refuses with `*_RECOGNITION_PERIOD_UNBOUND` if that week is null or does
  not contain the transaction.
- `first-temporal-refusal.sql` still checks the scope, and still checks that
  no routed settlement run overlaps the week. It now checks against that
  derived week instead of the literal one.
- `validate_recognition_capture` still validates the production capture in
  full: hash, query, evidence equality, observation inside its own bounds,
  zero blocking or overlapping runs, and both scopes. It now treats the
  capture as historical evidence. It requires the one canonical derived guard
  in each of the seven carriers, and it refuses any carrier that compares
  `transaction_timestamp()` with a date literal or carries the captured week.
  The unit control keeps the guard-mutation case, now pointed at a reverted
  literal guard, and adds a `pinned` case that injects a literal.
- Pins are refreshed from the exact bytes: the manifest,
  `ARCHIVE_MANIFEST_SHA256`, `PROBE_SHA` and `SQL_SHA`. No other file pinned
  the old hashes.

No production write, migration, function, amount or engine behavior changed.

## Proof

- Before: local `first-archived-spin`, `archive_temporal_refusal`,
  `ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED`, `passed: false`.
- After: the result of every local image and of the pull request's CI run is
  recorded in the pull request.
