# A Migration That Needs The Live Tables Waits For The Daily Break

Date: 2026-10-22

## Why

Sampling showed `public.clubs`, `public.tables` and `public.hand_history` held
by some transaction older than 200 ms in 150 of 150 samples during live play.
A migration that needs ACCESS EXCLUSIVE on them therefore cannot be installed
while tables deal. The Midway rake-cap migration (20261021174448) tried twice,
at 02:34 and 02:48 UTC, looping up to 300 s on `LOCK TABLE clubs, tables,
hand_history IN ACCESS EXCLUSIVE MODE`; the queued request froze the hand
commit path and caused the Engine Restart Storm (32 kills, 30 tables).
PR #7662 (20261022030326) made the database cancel such a session within
seconds and forbade lock retry loops. It left no route by which a migration
that genuinely needs those locks can ever install. This adds that route.

## The route

1. The migration declares, on a line of its own:
   `-- @install-window: daily-maintenance`.
2. Apply Merged Migration (`scripts/ci/apply-recorded-migration.mjs`) refuses
   it as QUEUED and sends nothing. "Queued" needs no table: the file is on
   protected main and its version is not in `schema_migrations`.
3. The admitted daily 03:30 America/Chicago run of `stage-engine-release.yml`
   (the owner-requested daily engine preparation, CLAUDE.md section 13) runs a
   new job, `window-migrations`, which runs
   `scripts/ci/install-window-migrations.mjs`. With nothing queued it exits at
   once. Otherwise it checks every queued file against the window rules,
   sleeps once until the 04:00 window, reads the database's window predicate
   every 2 s until the break is counting down inside a confirmed freeze, and
   then sends each queued file through the same applier with
   `--maintenance-window`: one transaction and one attempt per file, oldest
   first. The first refusal stops the run, leaves that file and the rest
   queued for the next day, and turns the run red.
4. Each install transaction (`windowTransactionSQL`) carries, after `BEGIN;`,
   the documented `SET LOCAL ca.break_window_migration_override = '<reason>'`
   (recorded by the existing DDL guard in
   `public.ca_break_window_migration_overrides`), `lock_timeout` 1 s,
   `statement_timeout` 5 s and an opening assertion that the daily break is in
   `counting_down`, `fn_platform_frozen()` is true, and at least 150 s remain
   before `break_ends_at`. Before `COMMIT;`, after the exact-bytes history row,
   a closing assertion rolls the whole transaction back if it took more than
   8 s or if fewer than 100 s remain (the engine starts its thaw 90 s before
   `break_ends_at`). On PostgreSQL 17 a session `transaction_timeout` of 12 s
   backs it up.

## Decisions

- **Where it runs.** Not inside the certified host release transaction: that
  runs only on days with an engine release and is the riskiest code to change.
  The 04:00 break and its freeze happen every day; the 03:30 scheduled run of
  `stage-engine-release.yml` also happens every day. The job adds no schedule
  (`tests/no-workflow-gains-a-new-timer.law.test.ts` is unchanged), sends no
  event, and has no SSH or engine authority.
- **The sentinel needs no exemption.** `fn_ca_writer_lock_sentinel` cancels
  direct sessions whose transaction is older than 15 s; every window install is
  bounded at 8 s (12 s server-side on PostgreSQL 17).
- **It cannot extend the window or delay the thaw.** Installs start only with
  150 s left and commit only with 100 s left, so the latest commit lands well
  before the thaw's 90 s preparation lead; a lock that is not free costs 1 s
  and a rollback.
- **The freeze still applies.** A window migration may not set
  `app.freeze_bypass`; writes to money and seat rows stay refused during the
  break, so window migrations are DDL.
- **Readers.** The job summary names every file and its outcome; a red run on
  main is read by the red-main detector (CLAUDE.md 10.83).
  `check-migrations-are-live.mjs` reports a declared, not-yet-installed file as
  "queued for the daily window" for seven days, after which it is MERGED BUT
  NOT LIVE like any other file.

## Qualification

`scripts/ci/test-maintenance-window-migrations.sh` builds a native PostgreSQL
with production's break-window guard and freeze predicates (copied with
`pg_get_functiondef` on 2026-10-22), serves it over TLS verified against a
throwaway CA, and runs the real applier and installer. Run locally on
PostgreSQL 16.15 and in CI on PostgreSQL 17
(`.github/workflows/maintenance-window-migrations.yml`):

- the ordinary applier refuses a declared migration as QUEUED, nothing sent;
- the window route refuses while no break is open, nothing sent;
- a lock it cannot take at once (`ACCESS SHARE` held on `hand_history`) rolls
  the install back with 55P03 in about 1.2 s: no history, no override row, no
  column;
- inside the open window it installs once, the guard records the override
  reason as `postgres` / `apply-recorded-migration`, and the history row holds
  the exact file bytes;
- a second run is ALREADY-APPLIED and changes nothing;
- 120 s before the break's end the opening assertion refuses;
- a 9.2 s transaction is rolled back by the closing budget assertion;
- the installer exits at once with nothing queued, refuses a file with a 5 s
  `lock_timeout` before waiting, reports a break that never opens without
  sending anything, and installs a queued file once inside an open break.

No migration was added and nothing was applied to production: there is
currently no queued window migration. The next 04:00 America/Chicago run finds
none declared and exits at once.
