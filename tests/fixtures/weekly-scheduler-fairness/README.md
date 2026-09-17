# Scheduler fairness regression source — UNRUN

These files are authored inputs for the protected local pipeline owner. They
have not been executed. The replacement pipeline is not operational; do not run
a direct native PostgreSQL, Python, shell or cloud fallback. No production
credentials, notifications or money are needed for this fixture.

The forward component belongs after the legacy-door cutover and PNL component
`20260914153000_uncertified_union_pnl_blocks_close_and_squareup.sql`. It requires
the PNL predicate, reverses only that addition to compare the measured J
definition hash, and preserves PNL in the emitted coordinator definition. It
has one outer transaction for the accounting component builder.

The protected execution plan needs five fresh isolated databases from the
same pinned source tree:

1. Load `load.sql`, then execute `regression.sql`: nine blocked unions, a funded
   standalone book, next-invocation order, exact payouts/invoices, zero-work
   visits, unchanged accounting facts, changed-error alerts, Sunday-floor,
   no-floor calendar rollover, explicit floor preservation, pre-due historical
   week boundaries, total deadline, maintenance and ACLs.
2. Load `load.sql`, then `budget.sql`: seven failed unions and a real empty
   standalone book with three overdue weeks. One shared eight-attempt budget
   must allow only one additional week per invocation, retain discovery after
   the first success, and catch up in order without wallet transactions.
3. Load `load.sql` into a `fairness_*` database, then qualify `concurrency.py`
   with protected pinned executable, Unix socket, database and port inputs.
   A lock barrier proves competing work is refused while the first transaction
   stays open; the next invocation must settle the healthy book once.
4. Reapplication must refuse with `weekly scheduler fairness preimage changed`.
   Separately load only through `pnl-predecessor.sql`, alter a harmless comment
   in the coordinator definition, and require the same preimage refusal with
   no visit column created. The owner should also integrate the full actual
   PNL predecessor and fairness into the whole-catalog transaction replay.
5. Load `load.sql`, then `legacy-recompute.sql`: the second guarded component
   `20260914155500_legacy_recompute_uses_the_single_weekly_coordinator.sql`
   removes only the old recompute job, preserves service-only authority,
   refuses date-directed broadening, and returns actual coordinator failures,
   due gates and fair standalone settlement. The cron table/unschedule helper
   is a declared storage seam; actual installed schedule state needs separate
   protected readback. Mutation of the old job's command or function body must
   refuse application rather than remove an unexpected schedule.

Full activation requires the actual PostgreSQL 17 / pg_cron provider, not the
small cron storage seam in the fifth unit fixture. `captured-weekly-jobs.json`
contains the two exact public command/schedule payloads from the historical
read-only catalog. `pg-cron-prerequisites.sql` verifies PostgreSQL 17, disabled
actual job launching, the fixture database binding and extension-owned catalog
objects before seeding these two jobs through real `cron.schedule`. If that
qualified provider is unavailable, this is an explicit pending prerequisite;
do not create fake cron objects to pass the full activation replay. Neither
file contains database credentials or production connection information.

`load.sql` reuses established minimal native fixture schemas and the actual
guarded routing, statement, delivery, conservation, legacy-door and coordinator
bodies. The clock is controlled only after applying the fairness guard. The
existing Round 1 fixture refuses unions with no paid receipt. PNL quality is an
explicit dependency seam: `pnl-predecessor.sql` reproduces its one exact
coordinator-predicate change and returns ready from the quality reader. These
tests cannot qualify the PNL reader, its complete migration, source calculator,
production scheduler, provider delivery or financial release. Those require
their separate accepted receipts.

Expected failure of a new regression is evidence to investigate, not permission
to loosen a financial assertion or claim a pass. Capture actual source identity,
database/runtime identity, stdout/stderr, check count, exit status and verified
process cleanup through the protected owner before changing UNRUN status.
