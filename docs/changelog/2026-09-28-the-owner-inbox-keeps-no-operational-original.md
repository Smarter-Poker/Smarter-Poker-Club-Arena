# 2026-09-28: The owner's personal inbox keeps no operational original

## What was left behind

Store-only delivery (`20260927235053`) stops new operational notifications from
being written to the owner account's personal inbox. The rows written before it
stay, and until it is installed their number still grows. Measured on
production (read-only): 899 operational rows in the owner's
`public.notifications` on 2026-09-27, 901 at 2026-09-28 14:10 UTC and still 901
at 15:56 UTC; 903 at 22:28 UTC, every one still proven. At 14:10 all 901 were
captured in `operational_notification_destinations` and receipted in
`operational_alert_events` (source `owner-operational-notifications`, addressed
to the Production Alerts task), and the migration's own proof holds for every
one. Two copies are compared with each personal row, and they differ in
different rows:

- the captured originals: 884 equal the row exactly, 17 differ only in `read`,
  `is_read` and `read_at`;
- the receipts' copies: 881 equal the row exactly, 20 differ only in `read`,
  `is_read` and `read_at` (the same 17, plus 3 whose captured original equals
  the row).

None differs in `updated_at` or in anything else; none is referenced by
`push_outbox` or `accounting_invoice_deliveries`; every captured timestamp, in
both copies, is rendered in UTC.

## The settlement (migration 20260928000622, HELD)

A one-time migration. It creates no function, trigger or schedule.

1. Proves in UTC: `SET LOCAL TimeZone='UTC'`, because `to_jsonb` renders a
   timestamp in the session's time zone and every original was captured in
   UTC. Run from America/Chicago without it, every row fails its proof
   (review finding 1).
2. Takes `ROW EXCLUSIVE` on `notifications` first, the lock its DELETE takes
   anyway. It neither waits for nor blocks ordinary inserts, updates and
   deletes, but no trigger, rule or foreign key can be added to or enabled on
   `notifications` until it commits, so what 3 and 4 check is what the DELETE
   meets (review round 2, finding 1).
3. Refuses unless store-only delivery is installed completely: every
   `@live-proof` expression of `20260927235053` (the capture and its three
   readers at their post-image md5, the capture trigger, and the authority and
   detector triggers enabled with their functions) is re-checked verbatim, and
   the refusal names each piece missing (finding 4).
4. Refuses unless the DELETE can reach nothing but the rows it removes
   (`OWNER_INBOX_CLEANUP_DELETE_NOT_CONFINED`, naming each one found): the
   foreign keys into `notifications` are exactly
   `push_outbox(accounting_notification_id)` and
   `accounting_invoice_deliveries(notification_id)`, both NO ACTION, compared by
   table, columns and ON DELETE action; `notifications` has no DELETE or
   TRUNCATE trigger of its own (only those two keys' internal ones), no rule and
   no child table (round 2, finding 1). Before this, a CASCADE or SET NULL key,
   a DELETE trigger or a rule added before the install would have deleted or
   rewritten rows elsewhere without a word: against the round-1 migration a
   CASCADE key's referencing row was deleted, a SET NULL key's was nulled, and a
   trigger and a rule each wrote a row per removed notification into another
   table, while it removed the owner's rows as usual. Read-only on production on
   2026-09-28 the check passes. A child table attached after the check
   (attaching needs only a lock the cleanup's does not block) is never reached:
   the candidates, the proof, the kept copy and the DELETE all read
   `notifications` ONLY, so no row of a child is locked, proven, kept or
   deleted, and no trigger of a child runs inside the cleanup's transaction,
   where the cleanup's own locks (5) do not stop it (round 4, finding 1). Before
   this, a child attached while the cleanup was held at its keep, holding a
   copy of a candidate and a BEFORE DELETE trigger, was reached by the DELETE:
   the trigger removed that candidate's destination and receipt and re-typed
   its copy, and the cleanup committed with "7 removed" and a false
   `@live-proof` (reproduced here against `48587c094` with the real migration
   and a real commit).
5. Locks what it proves, until it commits: the owner's operational rows
   `FOR UPDATE`, taking their ids (the proof, the kept copy and the delete all
   work on exactly that id set, finding 6); then each one's destination, and
   every receipt those destinations name, `FOR SHARE` and in key order, each in
   a statement of its own, since a lock cannot sit on the nullable side of the
   proof's outer joins (round 3, finding 2). Before this the proof read
   destinations and receipts without a lock: held between its proof and its
   DELETE, the cleanup let a second session remove one row's destination and
   receipt and commit, then removed that row, committed and reported it kept.
   The reviewer's reproduction (the real migration, a real commit), re-run here
   against `3d2166742`, still leaves destination 0, receipt 0 and the
   `@live-proof` false. Now removing or changing a held destination or receipt
   waits for the cleanup; one removed or changed before it is held is proven as
   it now stands, and refused; and the proof counts only the rows held, so a
   destination or receipt written after the locks is no proof. A writer that
   locks one of these rows per transaction, or a destination before its
   receipt, cannot deadlock with this order (read from production:
   `fn_try_record_owner_notification` locks the destination before it records
   the receipt, the capture and the historical intake write new rows, and no
   database function updates or deletes a receipt). A transaction that locks two
   or more held rows in another order can (round 4, note 2): the reviewer's
   Production Alerts task updating two receipts in descending id order
   deadlocked with the cleanup's ascending locks. PostgreSQL then aborts one of
   the two - the cleanup with nothing changed, or that transaction, which must
   be retried (the task's update was the one aborted). Neither removes an
   unpreserved row.
6. Proves every row: a destination for the owner and the task; its receipt is
   the row's own (`owner-operational-notifications`, event key = the row's id,
   addressed to the task); the captured original and the receipt's copy equal
   the row apart from `read`, `is_read`, `read_at` and `updated_at`. Every
   comparison is `IS DISTINCT FROM`, so a missing copy or key counts as a
   difference instead of an unknown that would pass as proven (round 2, finding
   2). One unproven row aborts the whole migration, and the refusal counts rows
   per cause: no destination, pending receipt, receipt not the row's own task
   receipt, content differs (finding 12).
7. Refuses if either of those two foreign keys references one of them, naming
   the reason instead of failing on the delete.
8. Keeps each row exactly as it stands, read state included, in
   `public.owner_inbox_operational_removals` (row level security on; readable
   by `service_role` only, although Supabase's default privileges grant every
   new table to `anon`, `authenticated` and `service_role`; no foreign key, so
   pruning elsewhere never erases it).
9. Deletes exactly the kept rows, each only while it still equals its kept
   copy, and requires that as many were removed as were kept and proven and
   that no owner-operational row remains. That last read, alone, goes through
   child tables: an operational row a child holds is in the owner's inbox as
   its readers see it, so it makes the cleanup refuse.

Its `@live-proof` answers false while the migration is held and true only once
it ran: the removal record exists and every removed row still has its
destination and its task receipt (finding 7). The row check is a string handed
to `query_to_xml` behind `to_regclass`, so while the removal record does not
exist nothing names it, and the proof answers false instead of failing with
42P01 (round 2, finding 3). The probe evaluates it exactly as
`scripts/ci/check-migrations-are-live.mjs` does
(`select coalesce((select (<expr>))::text,'null')`): false before store-only
delivery, false after it, true after the cleanup. Read-only on production on
2026-09-28 it answers false.

The owner's ordinary notices stay: welcome, settings, invoices and the
financial digests (`financial_digest`, 4 rows on 2026-09-28, none of them
operational). The estate digests are operational (`estate_digest`, 24 of those
901 rows) and are removed. Every other account's notifications, the
destinations, the receipts and their investigation state are not touched; 705
sent or skipped `push_outbox` rows keep a soft `related_entity_id` to a removed
id.

## Order and window

1. The World Hub gateway PR, deployed: its push-health cooldown reads
   destinations, so removing the owner's personal "Notifications May Not Be
   Reaching This Device" row does not restart that cooldown (finding 5).
2. `20260927235053`, which this refuses to run without.
3. This migration, outside :50-:03 UTC and off-peak (findings 8 and 9).

A classifier change held on its own branch
(`claude/alerts-owner-classifier-covers-settlement-problems`, migration
`20260928171444`) newly classifies more of the owner's notices as operational
and, at install, preserves the ones already in his inbox (destination and
receipt). Install order: `20260927235053`, then that classifier change, then
this cleanup, which then removes those rows with the rest. A newly classified
row without a destination makes this cleanup refuse (no destination), so it
never removes one (round 4, note 4).

## Install notes: what the install touches besides the removal

Measured in a throwaway cluster carrying five of the six production
`ddl_command_end` event triggers that fire on this migration, under their
production names and order - `ca_break_window_refuses_ddl`,
`ca_ddl_watchdog_log` (`ca_log_ddl_event`), `pgrst_ddl_watch`,
`trg_rls_on_new_public_table` and `xp_ban_guard` (the sixth,
`trg_autorevoke_privileged_anon`, fires on the migration's `GRANT`; replayed
byte-identical by review round 5, it saw the grant to `service_role`, wrote
no row and raised nothing) - with every function source
byte-identical to production's (`md5(prosrc)` compared, read-only, 2026-09-28)
and the break-window guard's engine state stubbed to "no maintenance
announced", and a publication shaped like production's `supabase_realtime`
(round 3, note 4; round 4, note 3):

- The DDL audit: `ca_log_ddl_event` writes 7 rows to `public.ca_ddl_events`:
  CREATE TABLE, its primary-key index, the
  `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` that `fn_rls_on_new_public_table`
  issues on the new table, the migration's own ALTER TABLE, REVOKE, GRANT and
  COMMENT.
- `xp_ban_guard` (CREATE TABLE and ALTER TABLE here) refuses XP-shaped table,
  column and function names; none of these is, and it writes nothing.
- `ca_break_window_refuses_ddl` fires on every DDL command. It refuses inside
  :50-:03 UTC, or while an announced engine maintenance window or its thaw is
  active, or when the announcement owns the DDL boundary; otherwise it writes
  nothing and takes a shared transaction advisory lock (530090, 1), which the
  install then holds until it commits.
- One PostgREST schema reload (about 28 s): the transaction sends
  `NOTIFY pgrst, 'reload schema'` four times and PostgreSQL delivers it once.
- Realtime carries one DELETE event per removed row (903 at 2026-09-28 22:28
  UTC), each with the whole row, since `notifications` is in
  `supabase_realtime` with REPLICA IDENTITY FULL. Nothing else is published:
  the publication is not FOR ALL TABLES, and neither the removal record, the
  audit table, the destinations nor the receipts are in it. The measured
  install published 7 DELETE messages for 7 removed rows, no INSERT or UPDATE,
  in one transaction.
- Until it commits, the cleanup holds 903 destinations and 903 receipts
  `FOR SHARE` (production, read-only, 2026-09-28 22:28 UTC). An update of one
  of those receipts meanwhile, such as the Production Alerts task recording its
  investigation, waits for the commit; one transaction updating several of
  them in another order can deadlock with the install, and PostgreSQL then
  aborts one side - the install with nothing changed, or that update, which
  must be retried (5). A lock the install cannot take within three seconds
  refuses it with nothing changed.

## Publishing: stacked on #5512

The probe builds on store-only delivery's migration and fixture
(`scripts/dev/fixtures/owner-inbox-store-only/roles.sql` and `schema.sql`, and
`20260927235053`), which ship with #5512 and are not on main. This pull request
is therefore stacked: its branch starts at #5512's head (`6732a6919`) and adds
the six files of this change, with base main. Those three files, and every
other file #5512 adds, are byte-identical at `6732a6919` and at the commit this
change was built on (`299eb68fd`). The workflow has no branches filter, and its
paths name both migrations, both fixtures, the probe and the fragment, so it
runs on that pull request. Without them (a tree from main plus the six files)
the probe exits 2 naming #5512 and each missing file: the job fails, and is
never skipped (round 3, finding 1). On #5512's head plus the six files it
passes all 114 checks.

## Regression protection

`scripts/dev/probe-owner-inbox-cleanup.sh` builds production as it stands
before store-only delivery from `scripts/dev/fixtures/owner-inbox-store-only/`
(production's roles, default privileges, grants and policies; every function
pinned to its production md5) plus a cleanup-only fixture for `push_outbox`
and `accounting_invoice_deliveries`, writes the owner's history the way
production wrote it (`fn_raise_notification` under the pre-image capture, two
rows then marked read), installs the real store-only migration, and shows the
defect (red) and the held `@live-proof` answering false. It then shows each
refusal leaves every row of every table unchanged:

- store-only delivery not installed, and each of its seven pieces missing in
  turn;
- a captured original, or the receipt's copy of it, differing in any of eleven
  fields: `message`, `data`, `link`, `action_url`, `metadata`, `title`,
  `created_at`, `type`, `actor_id`, `user_id`, `id`;
- a receipt without its copy of the original, and a destination whose original
  is NULL (its NOT NULL dropped for the case): NULLs that `<>` would let
  through;
- a destination addressed to another recipient or task (the table's CHECK
  dropped for the case), a pending receipt, a receipt not addressed to the task,
  belonging to another row or from another source, a row with no destination;
- a row referenced by `push_outbox` or by `accounting_invoice_deliveries`;
- a third foreign key into `notifications` (CASCADE, SET NULL and NO ACTION,
  each referencing a candidate), `push_outbox`'s own key changed to CASCADE or
  moved to `related_entity_id`, a DELETE trigger and a TRUNCATE trigger, a DO
  ALSO rule, a child table, and all of them at once, each named;
- a kept copy that is not the row as it stood: that row is not removed, and the
  cleanup refuses;
- a candidate re-typed inside the cleanup's own transaction before its DELETE:
  no longer operational, it is not removed either, and only the counts see it.

Four two-session races hold the cleanup between its proof and its DELETE. A
mark-read finds every candidate locked, and a DELETE trigger added meanwhile
waits for the cleanup's lock (the cleanup then completes, rolled back).
Removing a proven row's destination, changing its receipt's copy of the
original, removing both in one transaction (the reviewer's race) or clearing
the destination's receipt each waits for the cleanup, which then completes
with every copy in place (round 3, finding 2). An operational row written past
the capture (replication mode) makes it refuse. So does the round-4
reviewer's child table, attached meanwhile with a copy of a candidate and a
BEFORE DELETE trigger that removes that candidate's destination and receipt
and re-types its copy: never reached, the trigger never runs (the probe
checks for its notice), and the completeness check refuses the copy (total 7
kept 7 removed 7). The hold is a BEFORE INSERT trigger on the cleanup's own
removal record, attached by an event trigger of the throwaway cluster's
superuser as the migration creates the table: the round-1 probe held it with
a DELETE trigger on `notifications`, which the cleanup now refuses. The same
event trigger can hold the cleanup earlier, as it creates its removal record
(after its guard, before it takes its candidates): a child attached then,
holding an edited copy of a candidate, is never read - not locked, proven or
kept - and the completeness check refuses the copy.

Four more cases meet the new locks from the other side. A session that has
removed a proven row's destination, or edited its receipt's copy, and not yet
committed when the cleanup reaches it: the cleanup waits for that session,
proves what it committed and refuses (no destination 1; content differs 1).
And a session holding one receipt `FOR UPDATE` keeps the cleanup waiting at its
receipt locks, twice. First the historical intake (`fn_capture_owner_notification_history`)
captures and receipts an operational row that had no destination, and the
receipt a held destination names arrives under that id (the destinations'
foreign key dropped for the case): neither was held, so the cleanup refuses
both (2 of 8: no destination 1, receipt not the row's own task receipt 1). Then
an operational row is written past the capture: held there, after it took its
ids and before its keep takes a snapshot, the cleanup keeps and removes exactly
the 7 rows it locked and proved, not whatever its predicate matches by then,
and refuses the row left over (total 7 kept 7 removed 7; by predicate it would
keep and remove 8).

Finally the migration runs from a session in America/Chicago and the result is
asserted (green), with the `@live-proof` true and a refused second run.
`.github/workflows/owner-inbox-cleanup.yml` runs it on every pull request
touching the cleanup, the store-only migration, either fixture or the
schema-manifest fragment.

Every refusal and race runs the migration's own text with its final COMMIT
replaced by ROLLBACK (a refusal raises before either line); only the final
install runs it as it is. A cleanup that wrongly applies is then reported
without destroying the history the later cases need, and the late child table
is dropped `if exists` (round 3, note 3), so every pre-fix run prints every
result. The same probe fails, each run to the end, against the round-3
migration (`48587c094`: 2 checks, the two child-table races: the child's
trigger runs inside it and it completes, and a child's edited copy is read and
refused as unproven), the round-2 migration (`3d2166742`: 10), the round-1
migration (`51f376528`: 23, among them the held `@live-proof` raising 42P01 and
the install through the CASCADE key) and no cleanup at all (94 with the
migration's header kept over an empty `BEGIN; COMMIT;`, 96 without it).

A mutation pass dropped each safety clause in turn and ran the probe:

| Clause dropped                                                                 | Probe | Caught by                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none (baseline)                                                                | 0     | -                                                                                                                                                      |
| pre-fix: the round-1 migration (`51f376528`)                                   | 1     | 23 checks, the held `@live-proof` raising 42P01 and the third CASCADE key accepted among them                                                          |
| pre-fix: the round-2 migration (`3d2166742`)                                   | 1     | 10 checks: every store copy removed or changed while it holds its proof goes through, it never waits at the new locks, and both child-table races fail |
| pre-fix: the round-3 migration (`48587c094`)                                   | 1     | 2 checks: the child's DELETE trigger runs inside it and it completes; the child's edited copy is read and refused as unproven                          |
| pre-fix: no cleanup at all (header kept, empty `BEGIN; COMMIT;`)               | 1     | 94 checks                                                                                                                                              |
| any one of the seven store-only guard pieces (7 runs)                          | 1     | the verbatim link check                                                                                                                                |
| `SET LOCAL TimeZone='UTC'`                                                     | 1     | the America/Chicago install: every row unproven                                                                                                        |
| `LOCK TABLE ... IN ROW EXCLUSIVE MODE`                                         | 1     | race: the DELETE trigger is added while the cleanup runs                                                                                               |
| the foreign-key check                                                          | 1     | the third CASCADE key is accepted                                                                                                                      |
| the keys' columns                                                              | 1     | the key moved to `related_entity_id` fails on the key itself                                                                                           |
| the keys' ON DELETE action                                                     | 1     | `push_outbox`'s own key changed to CASCADE is accepted                                                                                                 |
| the exact key set (only "every key NO ACTION")                                 | 1     | the third NO ACTION key and the moved key fail on the key itself                                                                                       |
| the trigger check                                                              | 1     | the DELETE trigger is accepted                                                                                                                         |
| TRUNCATE in the trigger check                                                  | 1     | the TRUNCATE trigger is accepted                                                                                                                       |
| `NOT tgisinternal` (internal triggers refused too)                             | 1     | the two keys' own triggers refuse every run                                                                                                            |
| the rule check                                                                 | 1     | the rule is accepted                                                                                                                                   |
| the child-table check                                                          | 1     | the child table is accepted                                                                                                                            |
| `FOR UPDATE`                                                                   | 1     | race: 5 rows marked read mid-cleanup, which then refuses                                                                                               |
| the destinations' `FOR SHARE` (the held set still taken)                       | 1     | race: the destination removed, and its receipt cleared, while held; in flight: the removal is not waited for                                           |
| the receipts' `FOR SHARE` (the held set still taken)                           | 1     | race: the receipt's copy changed while held; in flight: not waited for; held only and the id-set race: it never waits                                  |
| both of those locks                                                            | 1     | eight race checks: every store copy removed or changed while held goes through, and it never waits at the new locks                                    |
| the destinations locked `FOR KEY SHARE` instead                                | 1     | race: the destination's receipt cleared while held (a non-key update)                                                                                  |
| the receipts locked `FOR KEY SHARE` instead                                    | 1     | race and in flight: the receipt's copy changed (a non-key update)                                                                                      |
| the proof counting only held destinations                                      | 1     | held only: the intake's destination counted (2 of 8, no destination 0)                                                                                 |
| the proof counting only held receipts                                          | 1     | held only: the late receipt counted as proof (1 of 8)                                                                                                  |
| both of those                                                                  | 1     | held only: all 8 removed                                                                                                                               |
| receipt `source`                                                               | 1     | the receipt copy from another source is accepted                                                                                                       |
| receipt `event_key`                                                            | 1     | another row's receipt is refused for the wrong cause                                                                                                   |
| receipt `target_task_id`                                                       | 1     | the receipt not addressed to the task is accepted                                                                                                      |
| receipt `target_task_id` compared with `<>`                                    | 1     | the same receipt (its key missing: NULL) is accepted                                                                                                   |
| the receipt copy's comparison, entirely                                        | 1     | the first edited receipt copy is accepted                                                                                                              |
| the captured original's comparison with `<>`                                   | 1     | the NULL original is accepted                                                                                                                          |
| the receipt copy's comparison with `<>`                                        | 1     | the receipt without its copy is accepted                                                                                                               |
| the captured original's comparison, for any one of the eleven fields (11 runs) | 1     | that field's edited original is accepted                                                                                                               |
| the receipt copy's comparison, for any one of the eleven fields (11 runs)      | 1     | that field's edited receipt copy is accepted                                                                                                           |
| the destination's recipient in the join                                        | 1     | the destination for another recipient is accepted                                                                                                      |
| the destination's task in the join                                             | 1     | the destination for another task is accepted                                                                                                           |
| `push_outbox` reference check                                                  | 1     | the reference fails on the foreign key instead                                                                                                         |
| `accounting_invoice_deliveries` reference check                                | 1     | the invoice reference fails on the foreign key instead                                                                                                 |
| DELETE only while the row equals its kept copy                                 | 1     | the altered kept copy: all 7 removed                                                                                                                   |
| `FOR UPDATE` and that DELETE condition together                                | 1     | the altered kept copy: all 7 removed                                                                                                                   |
| completeness check, entirely                                                   | 1     | the altered kept copy: 6 removed, accepted                                                                                                             |
| completeness: the counts only (no "none remains")                              | 1     | race: the row written past the capture is left behind                                                                                                  |
| completeness: "none remains" only (no counts)                                  | 1     | the candidate re-typed inside its own transaction: not removed, and accepted                                                                           |
| `REVOKE` on the removal record                                                 | 1     | `anon` and `authenticated` can read and write it                                                                                                       |
| `GRANT SELECT` to `authenticated` as well                                      | 1     | `authenticated` can read it                                                                                                                            |
| `@live-proof` back to its round-1 form                                         | 1     | it raises 42P01 while held                                                                                                                             |
| `@live-proof` always true                                                      | 1     | it answers true while held                                                                                                                             |
| keeping and deleting by predicate instead of the locked id set                 | 1     | held at its receipt locks: the row written past the capture is kept and removed too (kept 8, removed 8)                                                |
| `ONLY` on the candidates                                                       | 1     | the child attached before the candidates: its copy is taken too (total 8 kept 7 removed 7)                                                             |
| `ONLY` on the proof                                                            | 1     | the same child: its edited copy is proven, and refused as unproven                                                                                     |
| `ONLY` on the kept copy                                                        | 1     | the same child: its copy is kept too, and the removal record's primary key refuses it                                                                  |
| `ONLY` on the DELETE                                                           | 1     | the round-4 attack: the child's trigger runs inside the cleanup, which completes                                                                       |
| all four `ONLY`s (the round-3 migration)                                       | 1     | both child-table races                                                                                                                                 |
| the completeness check through children (`ONLY` added)                         | 1     | both child-table races: the child's copy is left behind and the cleanup completes                                                                      |

Every clause is pinned. The one round 2 left unpinned - keeping and deleting by
the locked id set instead of re-selecting by predicate - matters only for a row
that appears after the ids are taken and before the keep, written by a writer
that bypasses the capture. Round 2 could hold the cleanup no earlier than its
first kept row, where the keep's snapshot is already taken; the receipt locks
are an earlier hold, and there the two forms differ.

`scripts/ci/schema-manifest.d/owner-inbox-cleanup.json` declares the removal
record so `check-migrations-applied` reports it as PROMISED instead of failing
the pull request (finding 10).

A recurrence is recorded by
`zz_owner_operational_original_reached_personal_inbox` (`20260927235053`).
