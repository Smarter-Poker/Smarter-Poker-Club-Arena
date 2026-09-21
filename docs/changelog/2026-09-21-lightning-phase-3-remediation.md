# Lightning 2.0 Phase 3 remediation: the front table is the main game everywhere, and the epoch follows its game

2026-09-21. Migration `20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga`.
Branch `agent/claude-lightning-p3/lightning/phase3-feeder-first`.

An adversarial audit of `20260921025504` and `20260921025523`, run against the
live catalogue after both had been applied, found one blocker and two majors.
Both files stay exactly as they were applied; this one repairs what they got
wrong, and its own harness then found three more before it reached production.

## Blocker: nothing kept the epoch invariant true

`20260921025504` created `cash_cluster_epoch`, backfilled 166 genesis rows, and
declared in its own `@live-proof` that **every** `cash_games` row has an open
epoch row. Then it left that a one-shot. Nothing in the estate wrote to the
table.

The first Cluster created after it applied would have had no epoch row, and
because the same migration made `lightning_pool_session` and
`lightning_instance` reference `(cluster_id, cluster_epoch)`, its first Phase 4
or Phase 5 write would have raised 23503. Every Lightning-capable game created
from that moment would have been un-Lightningable until somebody backfilled by
hand - which is to say, precisely the games Phase 3 exists to create.

An invariant that nothing maintains is not an invariant. `cash_cluster_epoch`
now **follows** `cash_games`: an AFTER trigger writes the genesis row on
insert, ends the open epoch and opens its successor when `cluster_epoch` moves
forward, refuses a move backwards (`CLUSTER_EPOCH_GOES_FORWARD`), and keeps the
open epoch's `mode` in step while leaving every finished epoch's alone. Phase 5
will bump one integer and the history will be correct by construction rather
than by remembering.

The successor's reason comes from `ca.epoch_reason`, a `SET LOCAL` a conversion
sets in its own transaction, the same shape as
`ca.break_window_migration_override`. It is never required: an unexplained bump
files as `unstated` rather than being refused, because refusing it would make
the history less complete, not more.

## Major: the R3 reopen named a Cluster's one table after one of its own parts

`20260921025523` gave `fn_cash_cluster_open_table` an arm reading `WHEN v_n = 0
THEN g.name`, where `v_n` counted **every** row of the cluster - closed and
deleted included. On the creation path that is 0 and the arm fires. On the R3
reopen path the closed row is still there, so `v_n >= 1`, the name falls
through to `left(g.name, 50) || ' Feeder'`, and the lone-feeder guard added by
the same migration then stops the ROLES step ever renaming it. The lobby would
have printed "NLH 1/2 Action Feeder" as the name of the game - verbatim the
defect that migration says it fixed. The count now asks how many tables are
**live**, which is 0 on both paths.

## Major: "three readers" was six

That migration said three readers ask which table stands for a game and
migrated all three. The catalogue said six. The three it missed all govern the
seat change, and on a feeder-first Cluster each was wrong in a different
direction:

- `fn_cash_game_lobby` emitted `on_main_one` and `seat_change.available` from
  `me.role = 'main' AND me.main_index = 1`, so the only player in the only game
  there is read **no status line at all** - neither "You Are In The Main Game."
  nor a must-move position - and was offered a Seat Change button that could
  not work.
- `fn_cash_seat_change_request` refuses a request FROM Main 1 and TO Main 1.
  Neither fired. Pressing the button raised `SEAT_CHANGE_NO_OTHER_TABLE`
  instead, and once a second table existed a player could spend their
  once-per-stay seat change to **leave the table that is the game**.
- `fn_cash_seat_change_plan` cancels a request from a table that became the
  main game, and refuses to route anyone onto it. Neither fired, so the planner
  would have seated a player onto the front table out of must-move order, which
  is the one thing "the main game fills in must-move order only" forbids.

All three now ask `fn_cash_cluster_front_table`. So does the tick's BREAK
candidate, which admitted the front table and was saved only by a later
`IF v_remaining_tables >= 1` - being saved by a different clause than the one
written for the job is not a rule.

Two readers are deliberately **not** converted, and the migration says why: the
tick's must-move draw widens a *Main 1* seat to draw from the whole board, and
a Cluster with no Main 1 simply does not reach it; `fn_cash_cluster_balance`
carries no `main_index` predicate in its live body at all.

## The front table itself, re-cut for three reasons at once

1. `ORDER BY (t.role = 'main' AND t.main_index = 1) DESC` is NULLS FIRST by
   default, and that expression is NULL - not false - for a row with role
   `main` and a NULL `main_index`. Such a row outranked the real Main 1. None
   live today; 3,085 closed ones exist.
2. The single `ORDER BY` lost the index condition the old subselect had.
   Measured on production: the tick worklist went from 6.13 ms / 1,265 buffers
   to 13.97 ms / 2,644, because `Index Cond: (cluster_id = g.id AND role =
   'main' AND main_index = 1)` became `Index Cond: (cluster_id = g.id)` plus a
   Sort. It runs every five seconds.
3. It admitted a **breaking** table as a Cluster's front, and the tick's own
   2026-09-09 repair works by renumbering a breaking main out of the live range
   precisely so the old reader would stop returning it.

Three coalesced index lookups fix all three, and the two hot scans - the break
candidate and the planner's two destination filters - read the answer into a
local once rather than once per census row.

## What the harness found that review did not

Three defects, each reproduced against a throwaway PostgreSQL 17 backend before
this reached production:

- **The catch-up backfill aborted on exactly the damage it existed to repair.**
  `ON CONFLICT (cluster_id, epoch)` does not cover `cash_cluster_epoch_current`,
  the partial unique index on `(cluster_id) WHERE ended_at IS NULL`. A Cluster
  whose epoch moved during the unmaintained window still had an open row at the
  epoch it had left, and inserting the new one beside it raised 23505 and rolled
  the whole migration back. It is now three statements.
- **The migration could not apply anywhere but production.** A non-vacuity guard
  read `IF v_bad < 100`, which would have refused a fresh `db reset`, a preview
  branch and every CI database. It asks for one, as its sibling does, and
  announces the count as a NOTICE.
- **The recovered epoch was filed as a second genesis, starting before its
  predecessor ended.** A single INSERT supplied `'genesis', g.created_at` for
  both the born-in-the-window case and the moved-in-the-window case, so a
  successor started twenty days before the epoch it succeeds finished and the
  two overlapped for the whole life of the first. Nothing constrains that -
  `cash_cluster_epoch_ends_after_it_starts` compares a row against itself, not
  against its siblings - so the migration now asserts non-overlap explicitly,
  and a recovered successor files as `'recovered'`, dated from when its
  predecessor ended.

## Qualification

`scripts/dev/test-lightning-phase3-remediation.sh` builds a throwaway
PostgreSQL 17 cluster, applies the real `20260920235343`, `20260921025504` and
`20260921025523` on top of a fixture carrying the pre-25523 bodies, then
reproduces the unmaintained window for real - one Cluster whose epoch moved
with its open row left stale, one Cluster created with no epoch row at all -
and applies the migration to that. 17 sections.

**Twenty-six mutations of a copy, zero survivors.** Twenty of them are caught
by the migration's own post-apply read-back before the harness's assertions
run, so each was re-run with that guard neutralised to prove the harness catches
it independently. Two are invisible to every text assertion: reverting the
catch-up to one `ON CONFLICT DO NOTHING` (caught by the 23505 it raises on the
window board) and moving the tick's hoist to before the ROLES step (caught only
by a board where the front table genuinely changes mid-tick).

`tests/lightning-phase-3-remediation.test.ts` pins the source shape and the
client behaviour, and is itself proven non-vacuous against six mutated copies.
The full suite is 24,437 green; the twelve failures in
`tests/legacyEngineCheckpointTransport.test.ts` are a pre-existing
environment-dependent SIGUSR1/inspector test, reproduced identically on an
untouched checkout of `main`.

## Rollback

One new trigger function, one trigger, two indexes on empty relations, and six
function bodies. Restoring the six from `pg_get_functiondef` output taken
before the apply, dropping the trigger, the function and the two indexes
returns the prior behaviour exactly. `cash_cluster_epoch` keeps its rows;
nothing reads them yet. No money moved, and the only pre-existing relation
written is `cash_cluster_epoch` itself.
