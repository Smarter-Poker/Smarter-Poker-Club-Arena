# Diamond Phase 10: lines 3, 4 and 5 audited line by line, and the staff desk guard asserts again

2026-10-04. Branch `agent/cw-diamond-p10/phase-10-lines-verified`, on
`origin/main` at `455ec7ee4e`.

## What this is

Phase 10's three operator and player-facing lines - staff game configuration
with audited adjustments, real member and seated counts with honest zero and
error states, and scoped financial push alerts - were scoped by
[the line-by-line audit of September 21](../DIAMOND-PHASE-10-AUDIT-2026-09-21.md)
into a nine-item build list, built on September 29 and 30, and ticked in the
programme. Nothing had then gone back and checked the built thing against the
installed thing. The September 20 remaining-work audit had said in those words
that no audit had gone line by line against these deliverables, and the
September 29 audit covered lines 1, 2 and 6 instead.

This change closes that loop and fixes the one defect the loop found.

The audit is
[docs/evidence/diamond-phase-10/lines-3-4-5-verification-2026-10-04.md](../evidence/diamond-phase-10/lines-3-4-5-verification-2026-10-04.md).
Every database read in it was taken through
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` against
`kuklfnapbkmacvwxktbh` on 2026-10-04 between 12:36 and 12:42 UTC. No
production write was made, no DDL was run, no migration was applied and
neither arena switch was touched.

## The verdicts, in one line each

- **The counts are real and the unknown is not a zero.**
  `fn_diamond_arena_counts()` answered, in one read,
  `members` 1,149, `tables` 17, `seated` 0 and `online` NULL with the reason
  `no_caller_to_witness`. A real number, a real zero and a named unknown in
  the same answer, which is what CLAUDE.md 10.86 rule 1 asks for.
- **Every staff door records who used it.** Ten `fn_poker_diamond_*` doors
  call `fn_poker_diamond_staff_audit` and read `auth.uid()`, including the
  five that pre-dated the build list. Settling a Diamond correction is still
  refused by name because `ca_diamond_correction_source` holds 0 rows, and
  what pays for one is Dan's under CLAUDE.md 10.9.
- **The alarm pages once per episode, in Diamonds, to a named reader.** Two
  `diamond-rule:DR0:health_critical` findings exist. The first folded 29
  hourly critical rows into one send on 2026-09-29; the second opened after
  the first was closed and sent once on 2026-10-03. Both recorded
  `currency` `diamonds`, both went to the one `active` platform recipient,
  which is a real account holding 60 push subscriptions, and no Diamond
  warning has ever paged.
- **Not proven: nobody has used the incident review door.**
  `ca_diamond_incident_events` holds 0 rows. All 123 criticals were resolved
  by the health watch resolving what it filed, not by a reviewer, and 7,230
  warnings are still open. The door is built, granted and pinned; it has not
  been exercised in production.

## The defect, and why the budget was not the fix

`tests/unit/diamondStaffDeskService.test.ts` keeps the staff desk from calling
an RPC by the wrong parameter name, which PostgREST answers as a 404 the moment
staff press a button. It read each door's latest definition by scanning the
whole migration corpus **once per door**.

At 5,093 migration files and 62 MB, measured in this worktree: the corpus read
costs 1,960 ms and the regex passes another 213 ms. The test finished in
**4,652 ms of vitest's 5,000 ms default** - 93% of its budget against a
directory that only grows. Alone it passed; in a batch of sixteen files it
timed out. A timed-out test is not a failing assertion. The assertion never
ran, so the guard was not guarding anything, and raising the budget to the
ceiling just measured is the trap CLAUDE.md 10.86 rule 4 names.

So the work was removed. `tests/helpers/migrationCorpus.ts` gained
`latestFunctionParams(names)`: it walks the directory newest-first, reads a
file only while some name is still unanswered, and skips the regex on any file
whose text does not mention the function. The newest file that defines a name
holds its latest definition, which is the same answer an ascending
whole-corpus pass gives. Through the helper: **103 ms, 242 of 5,093 files
read**, and all nine doors resolve to byte-identical parameter lists. The
helper is where this belongs rather than inside the one test, because its own
header exists to stop exactly this, and the next person asking "what does the
latest definition of X look like" will reach for that file.

## Verification

- `npx vitest run` over the sixteen Diamond Phase 10 files:
  **before** 1 failed / 155 passed, the failure being
  `Test timed out in 5000ms`; **after** 16 files, 159 tests, all passing in
  2.86 s. The test body went from 4,652 ms to 4 ms.
- `npx tsc --noEmit`: clean.
- `node scripts/ci/check-title-case.mjs`, `check-ui-text.mjs`,
  `check-painted-text-case.mjs`, `check-nav-title-case.mjs`: all pass.
- `python3 scripts/ci/verify-source-bindings.py`: 796 pins across 16 binding
  files, every pinned file still hashing to its recorded bytes. Neither file
  changed here is pinned, so no pin was restamped.
- No new `*.law.test.*` file, so no new `docs/laws.d/` entry is owed.

## Recorded, not built

Two things are written down rather than fixed, both in the audit:

1. `fn_request_manual_bomb_pot` and `fn_update_table_bomb_settings` still have
   no Diamond branch. The September 21 audit flagged them as a way to change a
   Diamond table's bomb settings around the audited door. They are now
   unreachable: `fn_poker_guard_arena_structure` refuses a Diamond club whose
   owner is not the system sentinel (production's is), refuses any Diamond
   membership row that is not `player`/`automatic` (production holds exactly
   one such row), and refuses a structural Diamond table update from anyone
   who is not `service_role` or a platform admin. What is left is that a
   platform admin using a chip screen would write no Diamond audit row.
   Closing it needs a migration, and `apply_migration` is not available to
   this lane.
2. `tests/only-a-person-moves-the-arena-switches.law.test.ts` spends 2,036 ms
   of its 5,000 ms in one whole-corpus test - 41% of budget, 2.9 s of
   headroom. It is a different question ("does any migration do X") for which
   the memoised corpus read is already the cheapest answer, so
   `latestFunctionParams` does not apply and nothing was changed. The
   measurement is recorded so that whoever sees it go red knows it was already
   at 41% today rather than treating it as a new flake.

## Phase 11 scoping: the premise has changed, and here is what is actually left

This lane was briefed to scope a Phase 11 suite on the finding, from
[the audit of September 20](../DIAMOND-LAUNCH-REMAINING-WORK-2026-09-20.md),
that "no Diamond load, fan-out, latency or cross-asset-forgery suite exists".
**That finding is two weeks stale and is no longer true**, and saying so is
more use to whoever picks this up than a plan for work already done. Read
2026-10-04:

- All seven Phase 11 lines are built, verified and ticked in the programme,
  with evidence in `docs/evidence/diamond-phase-11/` - eight write-ups and
  nine re-runnable rehearsal fixtures, including
  `request-forgery-rehearsal.sql` (43 KB), `operating-envelope.md` (62 KB) and
  `engine-ownership-and-scaling.md` (39 KB).
- The concurrency, duplicate-delivery and crash-recovery suite is real and is
  **in CI**: `tests/sql/run-diamond-concurrency.py` is one of 24 Diamond
  runners that `scripts/ci/run-diamond-sql-acceptance.py` drives in the
  Accounting transactions (PostgreSQL 17) job, and
  `scripts/ci/check-diamond-runners-listed.mjs` fails if a runner is not run.
  It initdbs a private PostgreSQL 17 cluster with no TCP listener, loads
  production's own schema and md5-pinned door captures, and drives real
  concurrent sessions in three groups (RACE, REPLAY, RECOVERY), asserting
  after every case that no wallet is below zero, every balance equals its
  journal, no custody, movement, journal, receipt or ledger row is orphaned,
  and the supply identity holds.
- Cross-asset request forgery is pinned on both sides and runs in CI:
  `tests/a-forged-request-is-refused.law.test.ts` and
  `server/src/handlers/aForgedRequestActsOnlyForItsToken.test.ts`.

**What a next lane would genuinely have to cover**, being what the evidence
folder holds as a one-off rather than as a check that runs again:

1. **The operating envelope is a measurement, not a guard.** Lobby fan-out,
   action latency, event-loop load, database locks and reconnect storms were
   measured once, on 2026-09-30, against locally built engines and a passive
   81-minute production read. Nothing re-measures them. The 2,000-player
   reconnect that took 16 seconds and dropped 653 connections before the fix
   would regress silently. A next lane's first job is a budget per figure
   (fan-out bytes per join, p99 action latency, loop lag, locks held) and a
   job that fails when one is crossed - with a third outcome for "could not
   measure", since a load run that did not start must not read as green.
2. **The two-engine ownership proof is a one-off.** Release, crash, partition
   and dual-leadership contests over an isolated database were proved by hand;
   no script in `scripts/` re-runs them. The law that fails if a second engine
   worker is wired in before the listed steps is what guards the gap today,
   and it guards the configuration rather than the behaviour.
3. **It would build on what exists, not from nothing.** The isolated-cluster
   harness in `run-diamond-concurrency.py` (private socket, production schema
   pair, pinned door captures, forced interleavings proved by
   `pg_blocking_pids`) is the right foundation, and the arena switches it
   opens inside its own cluster are what let a race be entered at all.
   `docs/evidence/diamond-phase-11/arena-owner-readers.py` and
   `post-deploy-census.py` are the passive production readers to reuse.
4. **The constraint that shaped all of it still holds.** No load, storm or
   concurrent write was ever aimed at production. A next lane inherits that:
   isolation for load, passive reads for production, and single forged
   requests only in rolled-back rehearsals.

This is a scoping note, not a programme, and no Phase 11 work was built here.
