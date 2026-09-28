# owner-accounting-unaddressed

Production Alerts incident key `owner-accounting-unaddressed`: the owner
account's hourly accounting event was going to reach `operational_alert_events`
without `payload.target_task_id`, so the fleet lane that triages by that key
would never see it.

## Root cause

PR #5428 added migration
`20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql`
(recorded on production as version `20260927214610`). It taught
`public.fn_mirror_notification_to_push_outbox()` to skip the device push for the
owner account's issuer-side accounting copies and record one coalesced `info`
event per UTC hour instead, through
`fn_record_operational_alert('owner-accounting-notifications', ...)`. That
call's payload, `jsonb_build_object('first_notification_id', ..., 'hour', ...)`,
has no `target_task_id`.

The writer sets `payload` only when it inserts. On conflict
`(source, event_key)` it bumps `last_received_at` and `delivery_count` and
leaves `payload` alone, so an hour whose first receipt is unaddressed stays
unaddressed whatever follows it. The call sits in a `BEGIN`/`EXCEPTION` block
that only raised a `WARNING`, so a failed recording reached nobody either.

## Live readback (read-only, production)

| Read                                                                      | 2026-09-28T03:21Z     | 15:31Z and 16:33Z                  |
| ------------------------------------------------------------------------- | --------------------- | ---------------------------------- |
| `server_version`                                                          | 17.6                  | 17.6                               |
| md5 of `pg_get_functiondef` of `fn_mirror_notification_to_push_outbox()`  | `37d72427...`         | `37d72427...` (the guard holds)    |
| position of `target_task_id` in it                                        | 0                     | 0                                  |
| rows under `owner-accounting-notifications`                               | 0                     | 0                                  |
| md5 of `fn_record_operational_alert`, of `fn_record_operational_alerts`   | `36601e20...`, -      | `36601e20...`, `1ed60e92...`       |
| `schema_migrations` of this function's migrations                         | `20260927214610` only | `20260927214610` only              |
| `operational_alert_events` rows, heap, TOAST                              | -                     | 140,254; 231 MiB; 121 MiB          |
| rows inserted in the last hour, last 24 hours                             | -                     | 891; 11,388                        |
| rows without `payload.target_task_id` (all sources), inserted in 24 hours | -                     | 43,354; 0                          |
| constraints and user triggers on the table                                | -                     | 9 (`CHECK`, primary, unique); none |

No row under the source exists, so no row is closed: the fix stops the first
one landing unaddressed.
`public.operational_notification_destinations.target_task_id` is `NOT NULL`
with `CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid))`:
the in-repo precedent for a store that refuses the bad state.

## The fix

`supabase/migrations/20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql`,
one `BEGIN`/`COMMIT`, `lock_timeout` 3s, `statement_timeout` 45s:

1. **Guards.** The pre-image md5 `37d724277900f53d00db14fb3c5cd04d`, and no
   unaddressed row under the source (0 today; if the pre-image writes one
   before the apply, the migration refuses whole and must be rebuilt with a
   held cleanup).
2. **The sender.** The `20260927143752` body copied verbatim, except that the
   recorder's payload opens with
   `'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca'` and its handler
   records a refused recording (item 4).
3. **The store refuses the bad state.**
   `operational_alert_events_owner_accounting_addressed`:
   `CHECK (source<>'owner-accounting-notifications' OR (payload->>'target_task_id') IS NOT DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca')`,
   validated in the same transaction.
   - `IS NOT DISTINCT FROM`, not `=`: a `CHECK` passes when its expression is
     `NULL`, so the `=` form suggested in review would accept a payload without
     the key. Measured on PostgreSQL 16: that form accepts `'{}'`; this one
     refuses it with SQLSTATE `23514`.
   - Narrow: 43,354 older rows under other sources carry no key, so a
     store-wide rule would not validate. For every other source the first
     disjunct is true, so no insert, no `ON CONFLICT` update from the writer and
     no fleet investigation update of their rows can be refused (the regression
     asserts it).
   - A `CHECK`, not a trigger: `supabase/components/cash-pot-check-evidence.sql`
     and its rollback refuse to install over any user trigger on this table.
   - Lock: validation holds `ACCESS EXCLUSIVE` for one sequential scan. On a
     PostgreSQL 16 copy with 140,254 rows and a 219 MiB heap it took 65 to 89 ms
     warm and 852 ms with the OS cache dropped. The rule reads `payload` only
     for rows under this source, so the scan does not detoast. `NOT VALID` plus
     `VALIDATE` would not shorten the lock here: the `ADD`'s lock is held to
     `COMMIT`, and one change is one transaction. The `ALTER` runs after the
     function, so the lock covers only the scan and the post-checks.
4. **A refused recording reaches the fleet.** The handler now writes, through
   the same writer, one addressed `firing`/`warning` row per UTC hour under the
   same source (`event_key` `owner-accounting-unstored:<hour>`, alertname
   `Owner Accounting Alert Not Stored`) with the SQLSTATE, message and
   constraint name, from a nested block that can fail on its own. It reads and
   writes nothing in `push_outbox`.
5. **Post-checks** for every object it creates: both recorder payloads carry
   the key, the owner routing and cashier post-check are unchanged, the
   post-image md5 is `c0d5fe55644a793450a6ea08828181ce`, and the constraint
   exists, is validated, is not deferrable and deparses to the exact expected
   text (production 17.6 deparses `IS NOT DISTINCT FROM` the same way as
   PostgreSQL 16; read-only, 2026-09-28).

Both md5s were measured on a throwaway PostgreSQL 16.13 cluster that reproduces
the production pre-image md5 byte for byte. The writer is not changed: its md5
is pinned by the authority snapshots of `20260917054616` and `20260917062322`,
and a writer that defaulted the address would hide the next unaddressed sender.

**Push decisions are unchanged.** The harness ran the same twelve transfers
(owner and non-owner payees; commission, rake and rakeback; the store refusing
every row; the store refusing only the info event) once under the
`20260927143752` body and once under this migration. `push_outbox` holds 41
rows each time, identical row for row once the random notification and
conversation ids are numbered by first appearance (md5 of both normalised
dumps: `605f9ffd3042df9737a0da3997cb8627`). Only `operational_alert_events`
differs: the hourly row is addressed, and the new failure row appears.

Ownership: union accounting owns `fn_mirror_notification_to_push_outbox()`.
This is a bounded change to the Production Alerts call that `20260927143752`
added; no receipt, push decision or accounting path moves.

## Hardening

1. **Regression test, failing before and passing after.**
   `scripts/dev/fixtures/owner-accounting-alerts/owner-routing-regression.sql`
   (moved from `tests/fixtures/accounting-push/`, see item 5) runs against
   production's own store: `operational-alert-store.sql` installs
   `operational_alert_events`, `fn_record_operational_alert` and
   `fn_record_operational_alerts` verbatim from the World Hub migration that
   owns them, and asserts both production md5s. On PostgreSQL 16.13 (CI runs
   17), with a non-fatal copy of the fixture so that all 31 assertions report:
   - main's body (`20260927143752` only): 14 fail;
   - round 2 (the key only): 12 fail, among them every store and failure-row
     assertion and "no row is ever unaddressed", since an unaddressed later body
     stores its row;
   - this change: 0 fail. The checked-in harness exits 0 with 87 passing
     assertions (67 before this round); without the migration line it exits 3
     at `owner accounting Production Alerts event carries payload.target_task_id for the fleet lane`.
2. **Invariant in the owning layer.** The store rule above. It also covers what
   no text check can see: the batch writer, a direct `INSERT`, dynamic SQL, an
   `UPDATE` that strips the key, and an out-of-band apply. The law test refuses
   any other migration that drops, renames or re-adds it, or drops the table.
3. **Detection.** The failure row (fix item 4), addressed, for this sender; and
   for every source, `scripts/ci/check-operational-alert-addressing.mjs` after
   each hourly Production Integrity Audit, which records any unaddressed row as
   one fleet-addressed incident.
4. **The sender rule**, `tests/helpers/operational-sender-addressing.mjs`, with
   the generic reader `tests/helpers/sql-reader.mjs`. It reads each sender body
   as PL/pgSQL (blocks, `IF`, `CASE`, loops, `EXIT`/`CONTINUE`, exception
   handlers) and judges every writer call against the state of its variables on
   every path to it. An assignment proves, preserves or breaks the address; a
   parameter, a declaration without a value and a name declared twice prove
   nothing; a pinned row counts only when read `SELECT * INTO STRICT`; a
   `::uuid` literal may be in any letter case; the batch writer, a string
   naming the writer (`format('%I')`) and a multi-statement `EXECUTE` are
   refused; only the writer's own `(text,text,text,text,text,jsonb)` definition
   is not judged. A removal of a key computed at run time passes only as a
   printed `ASSUMED` line, and the law test pins the one it accepts
   (`operational_source_intake.record_strict`, whose key comes from
   `operational_source_intake.mapping()`: `original_event` or
   `original_incident`).
   - Corpus: exit 0 on this branch (6 senders by latest body, 7 on their own,
     1 superseded history, 1 assumption); exit 1 on `origin/main`'s migrations,
     naming the `20260927143752` body at line 70; exit 1 with #5489's two files
     added, naming `20260927221309` at line 78.
   - Decisions: `tests/an-operational-alert-sender-addresses-the-fleet.decisions.test.ts`,
     30 cases, all pass. Against the round-2 checker 16 fail: every round-2
     bypass, plus one reason whose wording changed. Each of 20 mutations of the
     rule turns at least one case red.
   - Linear: 4,000 calls in one body take 656 ms (the round-2 reading took
     59,207 ms); 16,000 take 3.6 s.
5. **CI gate.** A pull request that changes only the rule, its cases, the
   harness or the moved fixtures now reaches a required check, as
   `scripts/ci/classify-ci-changes.mjs` itself answers (the law test asserts
   it): a path under `tests/` gives `tests=true`; one under `scripts/dev/`
   gives `server=true` and `tests=true`, so the accounting job runs the
   harness. The law test also pins the two fixtures' sha256, so an edit to
   either must edit the law in the same pull request, and the harness order.
   The harness now also applies, after the fix, every migration that defines
   `fn_mirror_notification_to_push_outbox()`, is not in its list and sorts
   after `20260914141405` (version order is not application order). Measured:
   with #5489's migration present it exits 3 (`push outbox mirror changed since
review`); with a later body built on this post-image that drops the key it
   exits 3 at the regression, and the rule refuses that file; the round-2
   harness exits 0 with the same body present. `classify-ci-changes.mjs` itself
   is unchanged: its sha256 is pinned in
   `tests/fixtures/full-weekly-accounting/source-binding.json` (255,582 bytes)
   and three more bindings.

What the rule cannot see, and what does: a writer name assembled from pieces
at run time (a case pins that it is not seen), a `DO` block or top-level
`SELECT`, a direct `INSERT`, a body produced at apply time, and anything applied
outside `supabase/migrations`. For this source the store refuses such a row;
for every source the live detector records it. `DROP FUNCTION` is not tracked,
so a dropped sender is still judged.

## Snapshots that pin this table

Searched in both repositories. None is broken by a `CHECK`:

- `supabase/components/cash-pot-check-evidence.sql` and its rollback require
  each of the nine constraints to exist and no user trigger; an added `CHECK`
  keeps both true.
- `supabase/components/direct-operational-source-intake.authority.sql` (capture
  of 2026-09-17) lists the table's constraints exactly. Read-only at 15:31Z it
  already differs from production in `ca_drift_incidents` (columns, triggers,
  constraints) and `financial_alerts` (triggers), so that component's install
  and rollback are refused today whatever this change does.
- The probe inputs `scripts/ci/probes/production-alert-core/` and
  `scripts/ci/probes/spin-expiry/` (Club Arena) and
  `scripts/ci/probes/owner-operational-notification/` (World Hub) pin the
  constraint list of their own frozen capture, which they install themselves;
  none reads production or applies later migrations.
- `scripts/ci/supabase-*-manifest.json` list tables, columns and functions, not
  constraints.

## Same pre-image as PR #5489

`20260927221309_push_delivery_is_for_reachable_recipients.sql` (PR #5489, in
flight) also replaces this function from `37d724277900f53d00db14fb3c5cd04d`,
keeps the unaddressed recorder call, and asserts its own post-image
`4c36223326ba037a1e61f813f509a491`. Whichever is applied second is refused by
its pre-image guard and rolls back whole.

Sequencing cost, stated plainly: #5489 cannot merge green after this change
unless it is rebuilt. With this change on main, its migration is refused by the
law test (`UNADDRESSED ... 20260927221309 ... body line 78`), by the harness
(its pre-image guard, once the harness applies it), and, were it applied, by
the store. If #5489 lands on main first instead, this pull request fails the
same law test for the same reason, because every migration is judged on its
own; it would then have to be rebuilt on #5489's post-image, with the address
added to that body and `20260927221309` added to `SUPERSEDED_HISTORY`. The
cheaper order is this change first, then #5489 rebuilt on the post-image
`c0d5fe55644a793450a6ea08828181ce`, keeping the address and the failure row.
Both also edit `scripts/dev/test-accounting-push-bridge.sh`, so the second to
merge rebases the harness.

## Review history

- Round 1, review A: FAIL. The checker ran only in a workflow that is not a
  required check; it accepted any value for the key; the CI classifier omits
  `tests/fixtures/accounting-push/`.
- Round 1, review B: PASS with should-fixes: advisory job; `--added-since`
  flagged a pure rename (R100) and ignored verified recordings; a second call
  with `'{}'::jsonb`, `obj || obj`, `jsonb_strip_nulls(obj)` or
  `EXECUTE ... USING` passed behind one addressed call; a read of the key
  passed; overloads were keyed by name.
- Round 2: a blocking law test, the per-call value rule, signatures, renames,
  recordings, and every migration judged on its own.
- Round 2, review A: PASS with should-fixes. Review B: FAIL, with a blocker:
  the invariant was the CI checker itself, and the database still accepted the
  bad state. Should-fixes from both: a variable proven by one assignment passed
  after a later reassignment; parameters, nested `DECLARE`, non-`STRICT`
  `SELECT INTO`, the batch writer, split names, `format('%I')` and
  multi-statement `EXECUTE` went unjudged; every writer overload was excluded;
  the argument reader was quadratic; an upper-case `::uuid` was refused; the
  rule's cases and the fixture ran in no required check; the harness never ran
  a later body; the pull request text claimed the other merge order stays
  green.
- Round 3 (this change): the store rule and the failure row (the blocker); the
  flow-aware rule, with every bypass as a case; the rule moved under `tests/`;
  the fixtures moved under `scripts/dev/` and pinned; the harness applies later
  bodies; the sequencing text corrected above.

## Verification after the migration is applied

- `md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))`
  is `c0d5fe55644a793450a6ea08828181ce`.
- `operational_alert_events_owner_accounting_addressed` exists and is
  validated. That and the address in the body are the migration's two live
  proofs, read by `scripts/ci/check-migrations-are-live.mjs`: both `false` on
  production at 16:33Z, both `true` on the harness cluster after the migration.
- The first owner accounting hour writes a row under
  `owner-accounting-notifications` with
  `payload->>'target_task_id' = '01a09b86-5ba8-7290-8657-1041f13dd3ca'`, and no
  `owner-accounting-unstored:` row appears.
- No row is closed: none existed.
