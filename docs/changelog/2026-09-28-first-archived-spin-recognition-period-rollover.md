# main-red: first-archived-spin recognition-period window expired at the union-week rollover

## What was red

`origin/main` at `763e4cec` and later was red on the required path
`Accounting transactions (PostgreSQL 17) shard 1/4`, which fails the
ruleset-required `Server Engine (typecheck + tests)` check, blocking every
engine PR from merging. CI run `36432654047` (job `108970323862`) failed
deterministically inside `scripts/ci/test-spin-expiry-postgres.py`'s
`first-archived-spin` qualification image, stage `archive_temporal_refusal`:

```
psql:.../fixtures/archived-spin/first-temporal-refusal.sql:41: ERROR:  P0001: ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED
```

## Root cause (read from rows, not assumed)

`scripts/qualification/fixtures/archived-spin/first-temporal-refusal.sql`
(and five sibling fixtures it shares the check with) pins the diagnostic's
validity to a specific "union week", `2026-09-21T07:00:00Z` through
`2026-09-28T07:00:00Z` (`fn_union_week_start` = midnight America/Los_Angeles
every Monday, `supabase/migrations/20260907044041_the_union_week_ends_at_midnight_pacific.sql`).
The comment left by the fixture's own author (#5387/#5405,
merged 2026-09-27) says exactly why: *"These observed bounds expire and
require a new authentic capture at rollover."* CI ran this job at
2026-09-28T14:34Z, one union week after the fixture's captured week ended
at 2026-09-28T07:00:00Z (midnight Pacific), so the diagnostic's own freshness
guard fired and aborted before reaching the check it exists to protect
(fee-source scope, no overlapping weekly settlement run). This is a
self-expiring guard by design, not a code regression - bisecting `origin/main`
between the last green run (`86cab2e0`, 2026-09-28T05:27Z, inside the old
window) and the first red run (`763e4cec`, 2026-09-28T13:59Z, after the
07:00Z rollover) found only one intervening commit (`1c7e9993`, a horse-replay
test artifact commit) touching none of the spin-expiry harness, its fixtures,
or the migration it installs.

## Fix: perform the authentic recapture the fixture asks for

Re-ran the fixture's own read-only recognition-period capture query against
production (`kuklfnapbkmacvwxktbh`, via `mcp__Supabase__execute_sql`,
`BEGIN READ ONLY` / `COMMIT`, no writes) for the *current* union week and
confirmed the assumptions the fixture pins still hold:

```json
{"scopes":[{"club_id":"fade0000-0000-0000-0000-000000000001","coordinator_union_id":"fade0000-0000-0000-0000-000000000001"}],
 "week_start":"2026-09-28T07:00:00+00:00","week_end":"2026-10-05T07:00:00+00:00",
 "runs_blocking_now":0,"runs_overlapping_week":[]}
```

The archived event's fee-source scope is unchanged and no weekly settlement
run overlaps the new week, so the diagnostic's non-week-bound assertions
(fee cutover timestamp, recognized sources, cash-accrual batches, mixed
cutover proof, bounty markers - all checked earlier in the same `DO` block
and never raised) remain valid for the new week.

Advanced the pinned window forward by exactly one union week
(`2026-09-21T07:00:00Z..2026-09-28T07:00:00Z` ->
`2026-09-28T07:00:00Z..2026-10-05T07:00:00Z`) in every fixture that carries
the check:

- `scripts/qualification/fixtures/archived-spin/first-temporal-refusal.sql`
- `scripts/qualification/fixtures/archived-spin/first-connected-probe.sql`
- `scripts/qualification/fixtures/archived-spin/first-atomic-failures.sql`
- `scripts/qualification/fixtures/archived-spin/first-production-rollback-probe.sql`
- `scripts/qualification/spin-first-archived-locks.py`
- `scripts/qualification/spin-first-archived-concurrency.py`
- `scripts/qualification/fixtures/archived-spin/first-temporal-state.json`
  (the `recognition_period.evidence.week_start`/`week_end` literals only;
  the provenance narrative and `capture_sha256`/`observed_at` fields in this
  file were left as originally captured 2026-09-26/27 - they are documentary
  only, not read by any check, and the live production reread above stands
  as the authentic evidence for the new window)

Every one of these files is pinned by exact `sha256`/byte-count in
`scripts/qualification/spin-first-archived.manifest.json`
(`validate_sources()` in `scripts/qualification/spin-first-archived.py`
refuses a source-inventory mismatch), and that manifest's own byte-for-byte
digest is itself pinned as `ARCHIVE_MANIFEST_SHA256` in
`scripts/ci/test-spin-expiry-postgres.py`, and `first-production-rollback-probe.sql`'s
digest is pinned a second time as `PROBE_SHA` in
`scripts/qualification/spin-first-archived-production-probe.py`. All three
layers of pin were recomputed from the actual new file bytes and updated
together in this change - nothing was weakened, skipped, or re-signed
without recomputing the real digest.

## Verification

- `python3 -m unittest scripts.ci.test_spin_expiry_wrapper -v` - the harness's
  own 178-test self-suite (pure Python, no database) - `OK`, 0 failures,
  after the pin updates (it failed with `first archived manifest changed`
  and `bank fault base probe drift` before the cascaded `PROBE_SHA` /
  `ARCHIVE_MANIFEST_SHA256` fixes were applied, confirming those extra pins
  were load-bearing).
- Every entry in `spin-first-archived.manifest.json` verified to match its
  file's live `len()`/`sha256()` by script, after the edits.
- Full PG17 qualification run (all 9 images including `first-archived-spin`)
  was not runnable in this container (PG16 only, PG17 lives on the owner's
  Mac and this class of job runs many minutes); relying on the PR's own
  required-check run in CI for that end-to-end proof, per `PUBLISHING.md`.

## What is NOT done / unproven here

- The PR's actual CI run of `Accounting transactions (PostgreSQL 17) shard 1/4`
  had not completed at the time this changelog was written; see the PR for
  final status.
- The `capture_sha256`/`observed_at`/narrative fields inside
  `first-temporal-state.json`'s `recognition_period` block were left
  pointing at the original 2026-09-26/27 capture rather than rewritten to
  the fresh 2026-09-28 read above - those fields are not validated by any
  code path, so this is a documentation staleness only, not a functional gap.
- This fixture will expire again at the next union-week rollover
  (2026-10-05T07:00:00Z) by the same design; whoever is on main-red duty
  then should repeat this same read-and-advance procedure, not silently
  widen or remove the check.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QteMjB3uYNMqTsvWt35QJB
