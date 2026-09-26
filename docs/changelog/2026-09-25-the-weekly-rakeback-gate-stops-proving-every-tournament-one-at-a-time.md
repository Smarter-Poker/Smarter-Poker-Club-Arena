# The weekly rakeback gate stops proving every tournament one at a time

2026-09-25/26. Club Arena database. The first weekly settlement runs at
2026-09-28T09:00Z.

## What was wrong, read from production

`daemon_state.rakeback_settler.high_water_mark` stood at
2026-09-22T10:37:05.499207Z and had not moved since. Every settler cycle
called `fn_rakeback_recompute_periods` for Deep Stack Society
(`2a1132b9-...`), week 2026-09-21, and the call came back `supabase_timeout`:
the server spent about 71 s warm (about 127 s cold) on a call whose client gives
up at 15 s (`DB_TIMEOUT_MS`). The durable request row showed the server
committing its work every time (`attempts` over 500), so the work was done and
thrown away on every cycle, on a database whose CPU is being actively managed.

The engine side (reading the durable receipt instead of treating a transport
abort as a failure) is a separate delivery owned by another task. This change is
the database half: make the call cheap, prove it answers exactly as before.

## Where the time went

68% of the call was `fn_accounting_tournament_week_quality`. It enumerated all
12,423 tournaments the platform recognised or settled in the week through three
unindexed sequential scans, then proved 6,953 of them one at a time, each doing
two full index scans of `accounting_tournament_recognized_sources` because
`tournament_id` is the second column of its only usable index.

In `fn_calculate_cash_rakeback_periods` the week's `rake_records` slice was read
three separate times, a correlated `NOT EXISTS` probed the five-row `clubs`
table 417,827 times, and the certificate query carried the wide `contract` jsonb
through two sorts that spilled to disk.

## What migration 20260925205938 does

STEP 1: eight `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, outside any
transaction (the `20260920185803` pattern: a plain `CREATE INDEX` takes SHARE on
a ledger that is written every hand).

STEP 2, one transaction:

- 2.1 asserts every STEP 1 index exists and is VALID, then comments them.
- 2.2 refuses unless the installed `md5(prosrc)` of the two replaced functions,
  and of `fn_accounting_tournament_fee_net_plan` (whose answer the fast path
  reproduces), is exactly the body the rewrite was derived from. Many agents
  change accounting functions in a day; `CREATE OR REPLACE` must not silently
  overwrite a newer change.
- 2.3 the weekly tournament gate keeps its loop, order and exact reasons, but a
  set pass computes the facts net_plan would re-derive per event. For an event
  with no refund reversal and clean structural facts those facts are
  algebraically net_plan's, so net_plan is not called. An event with a refund
  reversal, or whose cheap facts disagree, takes the original per-event path,
  net_plan included, with the original reason and detail.
- 2.4 the period calculator reads the week once, splits
  `NOT EXISTS(P OR Q)` into its two exact halves, and stops carrying `contract`
  through the certificate sorts. `accounting_cash_rake_sources` is unique on
  `(rake_record_id, player_id)`, which is what makes narrowing the source slice
  to the club-week exact rather than approximate.

Measured warm on production, read-only, before this change was integrated: gate
50,679 ms to 3,992 ms; evidence counts about 15,400 ms to 6,813 ms; about 71 s to
about 17 s in total; identical verdict (`ready`, 6,953 checked), 378 payees,
unrounded 15,814.12.

## Installing it through the maintained door

`apply-recorded-migration.mjs` (Apply Merged Migration) sends a file as one
simple query, which is an implicit transaction block, so it could never apply a
file with `CREATE INDEX CONCURRENTLY` in it; the only way left was to retype the
file into a tool call, which is what the door exists to prevent.
`scripts/ci/migration-concurrent-preamble.mjs` now lets the door accept exactly
that shape and nothing wider: before the first `BEGIN;` line only
`CREATE INDEX CONCURRENTLY IF NOT EXISTS <name> ON public.<table> (...)` and
comments. Each build is sent on its own, only when there is room to finish
before the :50 break window (a build still running when the window opens is
refused at its end and leaves an INVALID index), only when
`fn_ca_break_window_refuses_migrations` says the database would accept DDL now
(including an announced engine maintenance window), and each is read back VALID
before the next. The transaction is sent only after all of them. Every
one-transaction migration from the last ten days is accepted exactly as before
(`tests/unit/applyMigrationConcurrentPreamble.test.ts`).

## Regression

On the union weekly basis native cluster (`scripts/dev/test-union-weekly-basis.py`,
run by the full weekly accounting qualification):

- `rakeback-cost-predecessors.sql` installs production's exact pre-rewrite
  bodies, pinned by `md5(prosrc)`, beside the rewrite as `fixture.predecessor_*`.
- `period-coverage-regression.sql` asks both versions both questions for every
  club and every week the cluster carries (40 club-weeks): identical gate
  verdicts, identical calculator receipts and identical certificates, payee for
  payee, including the zero-entitlement payee round 3 depends on.
- It writes, inside a rolled-back transaction, a fully refunded tournament entry
  and an ordinary recognised fee, and proves from the transaction's own
  `pg_stat_xact_user_functions` which path ran: net_plan is called once, for the
  refund reversal only, where the predecessor calls it for every event. A batch
  that disagrees with its record and a refunded source recorded as earned are
  refused identically by both versions.
- The page-drained book and the `p_user_ids = NULL` completeness proof for
  `routed_rakeback_player_period_missing` still pass on the rewritten bodies.
- `raked-regression.sql`'s retained-house negative control binds the rewritten
  clause: take the union-house acceptance away and the original whole-hand guard
  alone must still refuse that hand.

`tests/unit/weekGateFastPathFollowsNetPlan.test.ts` refuses any later migration
that changes net_plan without re-deriving the gate's set pass.

Nothing here adds a cron, a watcher, a reconciler or a repair path, relaxes an
assertion, widens a timeout, or moves the watermark.
