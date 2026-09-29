# 2026-09-27 - Owner accounting alerts carry the fleet address

`20260927143752` (PR #5428, recorded on production as `20260927214610`) routes
the owner account's issuer-side accounting copies to Production Alerts as one
`info` event per UTC hour, through `fn_record_operational_alert`. Its payload
had no `target_task_id`, and the Production Alerts fleet triages
`operational_alert_events` by exactly that key, so every one of those rows
reaches the store and never reaches the lane. A failed recording only raised a
`WARNING`. Read-only on production (2026-09-28, last at 16:33Z): the installed
body's md5 is `37d724277900f53d00db14fb3c5cd04d` with no `target_task_id` in
it, and no row under `owner-accounting-notifications` existed. On 2026-09-29
the first one landed unaddressed (id 176726, 02:30Z), and the migration as
first published refused to install over it.

## Shipped

- `20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql`, one
  transaction (`lock_timeout` 3s, `statement_timeout` 45s):
  - the `20260927143752` body with the recorder's payload opening with
    `'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca'`, and a handler
    that records a refused recording as one addressed `firing` row per UTC hour
    (`owner-accounting-unstored:<hour>`, SQLSTATE, message, constraint) instead
    of only a `WARNING`;
  - `operational_alert_events_owner_accounting_addressed`, a validated `CHECK`
    that refuses any row under the source unless
    `payload->>'target_task_id' IS NOT DISTINCT FROM` the fleet id (an `=`
    would let a payload without the key through, since a `CHECK` passes on
    `NULL`), or it is one of the unaddressed rows already stored when the
    rule is added, by id and payload digest. The table is locked first; the
    rows are listed under the lock and written into the rule as a literal, so
    a row the unfixed body stores while it installs is either kept or refused.
    Kept rows are never rewritten or deleted, and the fleet's investigation
    update and the writer's `ON CONFLICT` bump still succeed on them; a new
    unaddressed row, another source's row moved under this one, a chosen low
    id and a rewritten kept payload are refused;
  - a guard (pre-image md5) and post-checks (both payloads addressed, routing
    unchanged, post-image md5 `c0d5fe55644a793450a6ea08828181ce`, the
    constraint validated with its exact definition, kept list included). Push,
    skip and receipt decisions are identical under both bodies (41
    `push_outbox` rows, same row for row).
- `scripts/dev/fixtures/owner-accounting-alerts/`: `operational-alert-store.sql`
  installs production's store and both writers verbatim (their production md5s
  asserted); `owner-routing-regression.sql`, copied from
  `tests/fixtures/accounting-push/` (the old copy stays on main with no reader;
  a separate change deletes it), asserts the store's refusals (the writer,
  the batch writer, a direct `INSERT`, a stripping `UPDATE`), that other
  sources are untouched, the failure row, and a later body that loses the key;
  `unaddressed-rows-before-the-fix.sql` and
  `unaddressed-rows-kept-after-the-fix.sql` apply the fix over production's
  shape (rows the unfixed body stored first, one of them triaged) and assert
  that those rows are kept byte for byte and stay updatable, and that every
  later unaddressed row is refused.
- `scripts/dev/test-accounting-push-bridge.sh` installs the store first, runs
  the clean shape and production's shape each in a fresh cluster, and applies
  any later migration that redefines the mirror after the fix, so the
  regression judges the body production would run. 163 assertions pass; with
  the migration as first published it stops at its guard in production's
  shape.
- `tests/helpers/operational-sender-addressing.mjs` (and
  `tests/helpers/sql-reader.mjs`): the sender rule, now flow-aware. It judges
  every writer call against its variables' state on every path; refuses
  parameters, shadowed names, non-`STRICT` row reads, the batch writer, a
  string naming the writer and a multi-statement `EXECUTE`; excludes only the
  writer's own six-argument definition; accepts a `::uuid` literal in any case;
  prints each assumption; reads a body in linear time.
  `scripts/ci/check-operational-sender-addressing.mjs` is now only its command
  line.
- `tests/an-operational-alert-sender-addresses-the-fleet.decisions.test.ts`
  (30 cases, replacing the node test that ran only in an advisory job) and the
  law test, which now also pins the store rule and how it keeps rows, the four
  fixtures' sha256, the order of both harness runs and the CI routing.

Evidence: `docs/production-alerts/evidence/owner-accounting-unaddressed/README.md`.

## Deliberately not changed

- `fn_record_operational_alert` itself. Its md5
  (`36601e205494e8768f5a1dce09f4a186`) is pinned by authority snapshots, and a
  writer that defaulted the address would hide the next unaddressed sender.
- The store rule covers this source only: 43,354 older rows under other sources
  carry no key, so a store-wide rule would not validate.
- No detector was added. For this source the store refuses an unaddressed row,
  and a refused recording by the fixed body reaches the fleet as the failure
  row; for every source, `scripts/ci/check-operational-alert-addressing.mjs`
  already records any unaddressed row that is stored as one fleet-addressed
  incident.
- No row is edited, deleted or closed. Row 176726, and any other row stored
  unaddressed before the apply, is kept exactly as recorded; the fleet closes
  it once the fix is installed and a later owner accounting row is seen
  addressed.
- PR #5489 (`20260927221309`) replaces the same function from the same
  pre-image and keeps the unaddressed call. It is not changed here. Whichever
  merges second must be rebuilt: after this change, on the post-image
  `c0d5fe55644a793450a6ea08828181ce`, keeping the address; before it, this
  change on #5489's post-image, with `20260927221309` in `SUPERSEDED_HISTORY`.
- `scripts/ci/classify-ci-changes.mjs`, whose bytes are pinned by sha256 in a
  255,582-byte source binding. The copied fixtures and the rule sit on paths it
  already sends to required checks.
