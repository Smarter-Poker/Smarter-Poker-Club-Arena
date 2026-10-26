# A merged migration is one the applier will take

2026-10-26. CI and installer only; one unapplied migration's comment lines
moved. No client, engine, money or schema behaviour changes.

## What happened

The merger dispatches every migration a PR adds
(`dispatch-merged-migrations.sh`, since #8012), and `apply-merged-migration.yml`
installs it. Two merged files were dispatched on 2026-10-25 and refused, and
nothing owned them afterwards:

- `20261025143717_digest_counts_original_alerts_rather_than_source_updates`
  (applier run 40215906092): its three `-- @live-proof:` lines followed
  `COMMIT;`. The applier refuses anything after the transaction, the ruling
  recorded in `2026-10-19-lightning-fold-custody-and-receipts.md` for the same
  packaging mistake. Nothing at merge time asked the applier's question, so
  the file merged anyway.
- `20261025233013_registered_add_on_breaks_are_sixty_seconds` (applier run
  40252376234): dispatched while an announced engine maintenance window was
  active, refused at once, though that refusal releases in minutes.

Correction to an earlier note in this session: the flash-pool migration
`20261024232449` merged at 03:07 UTC on 2026-10-25, before the automatic
dispatcher existed (07:56 UTC), so it was never dispatched; it is installed
now.

## The fix

- `scripts/ci/migration-transaction-shape.mjs` holds the applier's shape rule
  (open with `BEGIN;`, end with `COMMIT;`, only the sanctioned CONCURRENTLY
  preamble before it). The applier calls it, unchanged in behaviour.
- `tests/unit/aMergedMigrationIsInstallable.test.ts` runs that same rule over
  every migration from 20261019 onward, so a file the applier would refuse
  cannot pass Client Unit Tests. The 24 unwrapped files from that period
  that were installed by another route before the check existed are named,
  and the test refuses any name on that list that is actually installable.
- The applier waits out a database DDL refusal (an announced maintenance
  window or its thaw) for up to 12 minutes, re-reading
  `fn_ca_break_window_refuses_migrations` every 15 s and sending nothing
  until it admits the file. A check-only run never waits. The queue budget
  grows from 600 s to 900 s and the job timeout from 15 to 35 minutes, so a
  file queued behind a waiting one is not refused by the queue.
- `20261025143717` (never installed) has its three proof lines moved to the
  top of the file, inside the envelope; every statement is unchanged and its
  version is preserved.

## Tests

`aMergedMigrationIsInstallable.test.ts`: 265 cases (every recent file, the
closed grandfather list, the strict comment rule, the CONCURRENTLY preamble,
the applier's use of the shared rule, the bounded wait, the queue and job
budgets). All 28 test files that read the applier, its workflow or the
preamble rule pass (1,236 tests), plus `contract-index-recovery.test.mjs`.
