# owner-accounting-unaddressed

Production Alerts incident key `owner-accounting-unaddressed`: the owner
account's hourly accounting event reaches `operational_alert_events` without
`payload.target_task_id`, so the fleet lane that triages by that key never sees
it. The first such row landed on 2026-09-29 (id 176726).

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

| Read                                                                      | 2026-09-28T03:21Z     | 15:31Z and 16:33Z                  | 2026-09-29T10:51Z and 10:55Z       |
| ------------------------------------------------------------------------- | --------------------- | ---------------------------------- | ---------------------------------- |
| `server_version`                                                          | 17.6                  | 17.6                               | 17.6                               |
| md5 of `pg_get_functiondef` of `fn_mirror_notification_to_push_outbox()`  | `37d72427...`         | `37d72427...` (the guard holds)    | `37d72427...` (the guard holds)    |
| position of `target_task_id` in it                                        | 0                     | 0                                  | 0                                  |
| rows under `owner-accounting-notifications`                               | 0                     | 0                                  | 1 (id 176726, unaddressed)         |
| md5 of `fn_record_operational_alert`, of `fn_record_operational_alerts`   | `36601e20...`, -      | `36601e20...`, `1ed60e92...`       | `36601e20...`, `1ed60e92...`       |
| `schema_migrations` of this function's migrations                         | `20260927214610` only | `20260927214610` only              | `20260927214610` only              |
| `operational_alert_events` rows, heap, TOAST                              | -                     | 140,254; 231 MiB; 121 MiB          | 155,922; 251 MiB; 122 MiB          |
| rows inserted in the last hour, last 24 hours                             | -                     | 891; 11,388                        | 469; 19,491                        |
| rows without `payload.target_task_id` (all sources), inserted in 24 hours | -                     | 43,354; 0                          | 43,355; 1 (id 176726)              |
| constraints and user triggers on the table                                | -                     | 9 (`CHECK`, primary, unique); none | 9 (`CHECK`, primary, unique); none |

`public.operational_notification_destinations.target_task_id` is `NOT NULL`
with `CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid))`:
the in-repo precedent for a store that refuses the bad state.

## Rows

- **176726** (`owner-accounting:2026-09-29T02`, `info`, received
  2026-09-29T02:30:50Z, `delivery_count` 1): the first hour whose owner
  accounting copies (weekly club statements) were recorded by the unfixed body,
  without the address. The fleet has set it to `investigating`. It stays
  unaddressed: the fix keeps it exactly as recorded and never rewrites or
  deletes it, and the fleet closes it once the fix is installed and a later
  owner-accounting row is seen addressed.
- One more such row can land for every UTC hour in which owner-account copies
  are issued until the fix is applied. They keep no schedule: in the 35 days
  to 2026-09-29 the owner account received 113 accounting copies in 13 distinct
  UTC hours, on Monday, Tuesday, Thursday, Saturday and Sunday, in hours from
  00 to 21 UTC (read-only). The migration keeps each such row the same way; its
  `NOTICE` names their ids, and so does the rule's definition.

## The fix

`supabase/migrations/20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql`,
one `BEGIN`/`COMMIT`, `lock_timeout` 3s, `statement_timeout` 45s:

1. **Guard.** The pre-image md5 `37d724277900f53d00db14fb3c5cd04d` (still
   production's). The first published build also refused to install over any
   unaddressed row under the source; production now holds one, so that guard
   is replaced by item 3's kept rows.
2. **The sender.** The `20260927143752` body copied verbatim, except that the
   recorder's payload opens with
   `'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca'` and its handler
   records a refused recording (item 4).
3. **The store refuses the bad state.**
   `operational_alert_events_owner_accounting_addressed`:
   `CHECK (source<>'owner-accounting-notifications' OR (payload->>'target_task_id') IS NOT DISTINCT FROM '01a09b86-5ba8-7290-8657-1041f13dd3ca' OR (id::text||':'||md5(payload::text))=ANY(<kept>))`,
   validated in the same transaction.
   - **Kept rows.** The table is locked first (`ACCESS EXCLUSIVE`, the mode
     the `ADD` takes anyway, so there is no lock upgrade to deadlock on), then
     every row under the source without the address is listed as
     `id:md5(payload::text)`, and the list is written into the rule as a
     literal (`EXECUTE format(... %L ...)`). Those rows are never rewritten or
     deleted, and stay updatable: the fleet's `investigation_status` and
     `investigation` update and the writer's `ON CONFLICT` bump of
     `last_received_at` and `delivery_count` leave `payload` alone, so the new
     row version passes. PostgreSQL judges the row an `INSERT` proposes before
     it looks for a conflict, so the bump runs for a call that proposes an
     addressed payload (as the fixed sender always does); a call proposing an
     unaddressed payload is refused, kept key or not.
   - **Nothing else is exempt.** A new unaddressed row from any writer,
     another source's row moved under this one, a row inserted with a chosen
     id (`OVERRIDING SYSTEM VALUE`), a copy of a kept payload under a new id,
     and a kept row whose payload is rewritten are all refused with `23514`.
     Not `id <= <highest such id>`: that would also exempt every older row of
     any other source moved under this one, and any free id below the bound.
     Not `NOT VALID`: PostgreSQL checks a `NOT VALID` rule on every new row
     version, so the fleet's update and the writer's bump of a kept row would
     be refused (measured below), and the live proof asks for `convalidated`.
   - **Race-free.** The pre-image records from the document's deferred
     trigger, at its `COMMIT`. A row it committed before the lock is granted
     is listed (the list is read after the lock with a new snapshot, READ
     COMMITTED); a write still open holds `ROW EXCLUSIVE`, so the lock waits
     for it (up to `lock_timeout` 3s, then the migration refuses whole). A
     write that waited behind the lock meets the rule after `COMMIT` and is
     refused; the pre-image's handler catches that with a `WARNING` and the
     document commits. Under a stricter isolation level the list could miss a
     row, but the validation scan reads the latest snapshot, so the `ALTER`
     would refuse whole. No path lets a later unaddressed row through.
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
     PostgreSQL 16 copy of production's state of 2026-09-29 (155,285 rows, a
     249 MiB heap) the lock was held 115 to 215 ms warm and 550 to 880 ms with
     the OS and buffer caches dropped (one further run took 7.1 s while the
     test host's disk was full). Listing the kept rows is an index scan of
     `(source, event_key)`: 1.5 ms cold. The rule reads `payload` only for rows
     under this source, so the scan does not detoast. `NOT VALID` plus
     `VALIDATE` would not shorten the lock here: the `ADD`'s lock is held to
     `COMMIT`, and one change is one transaction. The lock is taken after the
     function is replaced, so it covers only the list, the scan and the
     post-checks. A document transaction that waits behind it past its own
     `statement_timeout` rolls back whole (a `WHEN OTHERS` handler does not
     catch a cancel). There is no statement run to schedule around (read-only,
     the 35 days to 2026-09-29): document batches were stamped Monday
     2026-09-14 11:34Z, Saturday 2026-09-26 09:21Z and 13:21Z, and Tuesday
     2026-09-29 02:09:44Z (415 documents, among them the only weekly club
     statement, whose owner copy was recorded at 02:30:50Z); other owner copies
     arrived a few at a time at other hours; `union-weekly-rakeback-close`
     (every 30 minutes) last ran Tuesday 09:00Z and is inactive. So the
     migration is applied outside the :50-:03 break window, at a moment
     `pg_stat_activity` shows no long-running transaction (no accounting batch
     in flight).
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
   text with the kept list read again. Production 17.6 deparses this
   expression exactly as PostgreSQL 16 does: its read-only `EXPLAIN` of the
   same filter is byte-identical to 16's, and on 16 the constraint's text is
   `CHECK (` + that filter + `)` (2026-09-29).

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

## Installs on production's state today

A PostgreSQL 16.13 copy of the state read above (the harness fixtures up to the
pre-image, then production's grants, the two foreign keys that reference the
table, 155,285 rows up to id 184,866, the sequence at 185,281, and row 176726 in
its recorded shape with synthetic values): the mirror, writer and batch-writer
md5s, the nine constraints' text and the function and table owners, settings
and grants match production's. The migration was sent as one query, as
`scripts/ci/apply-recorded-migration.mjs` sends it:

- exit 0; `NOTICE`: 1 row kept as recorded (id 176726);
- after: mirror md5 `c0d5fe55644a793450a6ea08828181ce`; the rule validated,
  keeping only 176726; row 176726 the same tuple (`xmin`, `ctid`, payload
  bytes); owners, grants and settings unchanged; both `@live-proof` lines
  `false` before and `true` after;
- then: the fleet's update of 176726 and the fixed sender's bump of its hour
  succeed with its payload as recorded; a call proposing an unaddressed payload
  for its key, a later unaddressed row, a rewrite of its payload and another
  source's unaddressed row moved under the source are refused with `23514`; an
  addressed row is stored; an owner accounting copy now stores its hour
  addressed, with no failure row;
- the migration as first published, on the same state: exit 1, `an unaddressed
owner-accounting-notifications row already exists; rebuild this with a held
cleanup`, rolled back whole.

Race, on further copies: a pre-image write holding `ROW EXCLUSIVE` when the
install started made it wait 1,326 ms for its lock, and its row was then listed
and kept (2 kept). A pre-image write that reached its `COMMIT` while the install
held the lock waited 2,488 ms, then was refused by the rule (`WARNING` from the
pre-image's handler; the document and its skipped receipt committed; no row);
the next owner accounting copy ran the fixed body and stored the hour addressed.

## Hardening

1. **Regression test, failing before and passing after.**
   `scripts/dev/fixtures/owner-accounting-alerts/owner-routing-regression.sql`
   (copied from `tests/fixtures/accounting-push/`, see item 5; the old copy
   stays on main with no reader, and a separate change deletes it) runs against
   production's own store: `operational-alert-store.sql` installs
   `operational_alert_events`, `fn_record_operational_alert` and
   `fn_record_operational_alerts` verbatim from the World Hub migration that
   owns them, and asserts both production md5s. On PostgreSQL 16.13 (CI runs
   17), with a non-fatal copy of the fixture so that all 31 assertions report:
   - main's body (`20260927143752` only): 14 fail;
   - round 2 (the key only): 12 fail, among them every store and failure-row
     assertion and "no row is ever unaddressed", since an unaddressed later body
     stores its row;
   - this change: 0 fail. Without the migration line the harness exits 3 at
     `owner accounting Production Alerts event carries payload.target_task_id for the fleet lane`.

   **Production's shape (round 4).** The harness now runs twice, each run one
   `psql` session in a fresh cluster: the clean shape above, then the same
   inputs with `unaddressed-rows-before-the-fix.sql` between the pre-image and
   the fix (the pre-image stores the hour's row through a real owner transfer,
   an earlier hour's row is stored in the shape of 176726, and the fleet
   triages it), followed by `unaddressed-rows-kept-after-the-fix.sql`: the
   rule keeps exactly those rows; they are the same tuples, byte for byte; the
   fleet's update and the writer's bump succeed with their payloads as
   recorded; the fixed sender's recording beside them is stored; a later
   unaddressed row is refused from the writer, the batch writer, a direct
   `INSERT`, a chosen low id, another source's row moved over, a copy of a kept
   payload and a rewrite of one; an addressed row is stored.
   - The checked-in harness exits 0 with 163 passing assertions (87 clean, 76
     in production's shape).
   - With the migration as first published it exits 3 in production's shape,
     at `an unaddressed owner-accounting-notifications row already exists;
rebuild this with a held cleanup`, after 145 passing.
   - A non-fatal copy of the 18 kept-row assertions against other designs:
     this one 0 fail; `id <= <highest such id>` 6 fail; an exact id list
     without the payload digest 3 fail; a list of `event_key`s 5 fail; the
     published rule `NOT VALID` 6 fail, and the fleet's update and the bump of a
     kept row are refused with `23514`.

2. **Invariant in the owning layer.** The store rule above. It also covers what
   no text check can see: the batch writer, a direct `INSERT`, dynamic SQL, an
   `UPDATE` that strips the key, and an out-of-band apply. The law test refuses
   any other migration that drops, renames or re-adds it, or drops the table,
   and pins how the fix builds it: the lock, then the list, then the rule, no
   `NOT VALID` and no range of ids.
3. **Detection.** For this source, the failure row (fix item 4): a refused
   recording by the fixed body reaches the fleet addressed, and any other
   writer the store refuses gets SQLSTATE `23514`. For every source,
   `scripts/ci/check-operational-alert-addressing.mjs` after each hourly
   Production Integrity Audit records any unaddressed row that is stored (for
   this source only a kept row can be) as one fleet-addressed incident.
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
   harness or the fixtures reaches a required check, as
   `scripts/ci/classify-ci-changes.mjs` itself answers (the law test asserts
   it): a path under `tests/` gives `tests=true`; one under `scripts/dev/`
   gives `server=true` and `tests=true`, so the accounting job runs the
   harness. The law test also pins the four fixtures' sha256, so an edit to any
   of them must edit the law in the same pull request, and the order of both
   harness runs. The harness also applies, after the fix, every migration that
   defines `fn_mirror_notification_to_push_outbox()`, is not in its list and
   sorts after `20260914141405` (version order is not application order).
   Measured in round 3: with #5489's migration present it exits 3 (`push
outbox mirror changed since review`); with a later body built on this
   post-image that drops the key it exits 3 at the regression, and the rule
   refuses that file; the round-2 harness exits 0 with the same body present.
   `classify-ci-changes.mjs` itself is unchanged: its sha256 is pinned in
   `tests/fixtures/full-weekly-accounting/source-binding.json` (255,582 bytes)
   and three more bindings.

What the rule cannot see, and what does: a writer name assembled from pieces
at run time (a case pins that it is not seen), a `DO` block or top-level
`SELECT`, a direct `INSERT`, a body produced at apply time, and anything applied
outside `supabase/migrations`. For this source the store refuses such a row,
so it is never stored and the live detector, which reads stored rows, never
sees it: a refused recording by the fixed body reaches the fleet as the
addressed failure row, and any other writer gets SQLSTATE `23514`. For every
other source the live detector records such a row once it is stored.
`DROP FUNCTION` is not tracked, so a dropped sender is still judged.

What the kept rows do not cover, by design: the exemption is keyed on (id,
payload digest) only, so a privileged `INSERT ... OVERRIDING SYSTEM VALUE` that
re-creates a deleted kept row's id with identical payload bytes is accepted;
the list is taken as found at install time, so any stray unaddressed row under
the source is kept too; production's rule text carries production's own kept
ids. If the unfixed body stored a row for the hour in which the fix is
installed, the fixed sender's owner copies later in that hour bump that kept
row (it stays unaddressed), so the live detector, which reads the last two
hours by `last_received_at`, flags it once; the fleet closes it with the
others.

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
- Round 3: the store rule and the failure row (the blocker); the flow-aware
  rule, with every bypass as a case; the rule moved under `tests/`; the
  fixtures copied under `scripts/dev/` and pinned; the harness applies later
  bodies; the sequencing text corrected above.
- Round 4 (rebuild): production now holds unaddressed row 176726 (2026-09-29),
  so the published guard refused; rebuilt to keep rows written before the
  install as they are and refuse every later unaddressed row.
- Round 4 reviews: r28a PASS, r28b PASS (two independent reviewers; each ran
  the harness 163/163 green on the candidate and red at the published guard,
  and its own attacks on the kept-row exemption, races and REPEATABLE READ);
  should-fixes 1-3 fixed as text, notes documented.
- Round 4 text fixes: the apply advice (owner-account copies keep no schedule),
  "copied" for the regression fixture, the detection claims for this source,
  and what the kept rows do not cover; the function body and the store rule
  are byte-identical.

## Verification after the migration is applied

- `md5(pg_get_functiondef('public.fn_mirror_notification_to_push_outbox()'::regprocedure))`
  is `c0d5fe55644a793450a6ea08828181ce`.
- `operational_alert_events_owner_accounting_addressed` exists and is
  validated, and its definition keeps exactly the unaddressed rows the apply's
  `NOTICE` named (176726, and any later one stored before the apply). That and
  the address in the body are the migration's two live proofs, read by
  `scripts/ci/check-migrations-are-live.mjs`: both `false` on production at
  2026-09-29T10:51Z, both `true` on the reproduction and the harness clusters
  after the migration.
- The first owner accounting hour after the apply writes a row under
  `owner-accounting-notifications` with
  `payload->>'target_task_id' = '01a09b86-5ba8-7290-8657-1041f13dd3ca'`, and no
  `owner-accounting-unstored:` row appears.
- Row 176726 (and any other kept row) is unchanged; the fleet closes it then.
