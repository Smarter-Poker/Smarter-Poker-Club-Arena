# Lightning 2.0 Phase 3: a Lightning-capable game opens as a feeder, and stays one

2026-09-21. Migration `20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder`.
Branch `agent/claude-lightning-p3/lightning/phase3-feeder-first`.

The specification calls this its single most important product rule and marks
it a HARD REQUIREMENT: when a host creates a Lightning-capable cash game, the
system creates exactly one Cluster and exactly one physical table, and **that
table has role = FEEDER**. Because there is not yet enough population for
Lightning, the Cluster operates in ordinary MUST-MOVE mode, and the initial
feeder obeys the normal table engine and normal cash seating rules.

The estate did the opposite in two places, and the second is the one that
mattered. `fn_cash_game_create_impl_20260905` opened every Cluster's first
table as `('main', 1)`. And `fn_cash_cluster_tick`'s ROLES step promotes a lone
live feeder back to `main`, `main_index` 1 through its `no_live_main` arm -
within one tick, five seconds. Changing only the creation path would have been
undone automatically, and the game would have looked correct for under five
seconds.

## The specification contradicts itself once, and this is the reading taken

Line 150 says the initial table has role = FEEDER. Line 427, describing the
same MUST-MOVE period, says *"1 table is Main/Feeder according to the existing
table model"* and then *"The newest physical table is Feeder. Older physical
tables are Mains."* Both cannot be literally true of a Cluster with three
tables: the oldest must be Main 1 or must-move has nothing to move players
**onto**, and the specification's own MODE A rules require exactly that
("must-move FIFO applies", "shortest eligible Main receives movers").

The reading taken is the narrowest that satisfies both, and it is the
starting-condition reading the phase heading asks for:

> While a Lightning-capable Cluster has exactly one live table, that table is a
> feeder. From the second table onward, ordinary must-move roles apply
> unchanged - oldest is Main 1, newest is the feeder.

The promotion is **deferred, not disabled**: it waits until there is a second
table for it to be the Main of. Every other must-move rule is untouched - FIFO,
shortest eligible Main, reserved seats, no mid-hand teleport, seat changes, the
feeder-opening hold, the break rules - which is what "normal table operation,
normal must-move" in the phase's Verify list requires.

## Why the flag travels in `p_overrides`

`fn_cash_game_create_impl_20260905` is pinned by `regprocedure` at three sites
(`20260909035303:87`, `20260909181309:131` and `:189`). Its argument list
cannot move without breaking a replay from scratch at all three. `p_overrides`
is already a jsonb the caller controls, and - verified against the live body,
not assumed - it has no unknown-key rejection of any kind: no key whitelist, no
`jsonb_object_keys` scan, no set difference. An unrecognised key is silently
dropped today, so adding a read site is additive.

Two refusals come with it. A non-boolean value raises `OVERRIDE_INVALID:
lightning_enabled must be true or false`, checked with `jsonb_typeof` rather
than a cast so the caller sees a named refusal instead of a 22P02. And
`LIGHTNING_NEEDS_MUST_MOVE` refuses a Lightning-capable manual table: a
Lightning game **is** a Cluster - it grows tables, moves players between them
and converts a population into a pool - and a manual (R9) table has no
controller and lives and dies with its host.

## One definition of a Cluster's front table

Three readers ask "which table stands for this game", and all three asked it as
`role = 'main' AND main_index = 1`, which answers NULL for a feeder-first
Cluster:

- `fn_cash_clusters_to_tick.main1_table_id`. `ClusterController` reads this to
  count eligible horses and to decide whether an engine must exist. **A NULL
  here means the Cluster is created and then never ticks** - never opens a
  second table, never reaches a threshold, never becomes Lightning at all.
- `fn_cash_game_must_move_list`, whose whole job is to list everyone who is NOT
  in the main game. Spelled as "not on Main 1", it listed every seated player
  of a feeder-first Cluster, including the ones sitting in the only game there
  is.
- The board itself. R10 says a game is one row, identified by that same
  predicate, so a feeder-first Cluster simply did not appear.

`public.fn_cash_cluster_front_table` is that one definition: Main 1 when the
Cluster has a live one, otherwise its oldest live table. On the client,
`lobbyEntries.clusterFronts` answers it the same way over the rows on the
board, and `withClusterFigures` stamps the answer onto each row, because it is
a property of the whole Cluster and no single row can hold it. R10 is
unchanged - still exactly one row per game - and for every Cluster with a live
Main 1 both answers are what they always were.

**The definition is unconditional, and that is a choice.** It does not ask
whether a Cluster is Lightning-capable, so an ordinary must-move Cluster that
transiently has a live feeder and no live Main 1 - exactly what the tick's own
`no_live_main` arm exists to repair - now reports that feeder where it reported
NULL, and its players leave the must-move list for at most one tick. A
conditional front table would have to read `cash_games` on every call and would
leave the ordinary Cluster answering NULL in precisely the window where the
ClusterController most needs a table. One definition that is always right beats
two that disagree. Measured against production before it was written: 166
clusters, 108 with a live Main 1 (answer identical), 58 with no live table
(both NULL), **0 whose answer moves on apply**. The count is re-measured at
apply time and reported as a NOTICE.

## The name

`fn_cash_cluster_open_table` names a feeder `left(g.name, 50) || ' Feeder'`.
Right for a Cluster's second table, wrong for its first, which **is** the game
on the board - the lobby would have printed "NLH 1/2 Action Feeder" as the name
of the game. The name CASE gains one arm for the Cluster's first table, using
the `v_n` table count the function already computes on the line above and had
never read. When the ROLES step later promotes that row it sets `name = g.name`
itself, so the name does not change under the players.

## How the three bodies were edited

By asserted substitution against the live catalogue, not against the files on
disk - which are not what is running. `fn_cash_game_create_impl_20260905` is a
base definition from `20260905010500` plus patches from `20260909035303` and
`20260909181309`; `fn_cash_cluster_tick` carries eleven. Every anchor was read
out of `pg_get_functiondef`, is asserted to occur exactly once before anything
is replaced, and each block returns early with a NOTICE if the edit is already
present. After the replaces, every sibling guard is asserted to have survived -
six refusals in the create path, ten steps in the tick - and then the file ends
by asking the **catalogue** what it kept, not the variables what was sent.

## Qualification

`scripts/dev/test-lightning-phase3-feeder-first.sh` builds a throwaway
PostgreSQL 17 cluster with `initdb`, installs bodies carrying the migration's
anchors byte for byte, applies the real migration, and exercises eleven
sections against a real backend - including ticking a real board.

Acceptance test **F01** is section 1: one Cluster, one live table, role feeder,
no `main_index`, `lightning_enabled` true, `cluster_mode` still `must_move`, no
Lightning instances, and the table named after the game.

**Nine mutations of a copy of the migration, zero survivors.** Seven are caught
by the migration's own post-apply read-back before the harness's assertions run,
so each was re-run with that read-back neutralised to prove the harness catches
it independently. Two are invisible to every text assertion and are caught only
by ticking a real board: dropping the `(t.role = 'main' AND t.main_index = 1)
DESC` term from the front-table ordering, and changing the lone-feeder
conjunct's `= 1` to `= 0` so the suppression never suppresses.

`tests/lightning-phase-3-feeder-first.test.ts` pins the source shape and the
client behaviour;
`tests/a-game-counts-its-players-like-a-tournament.law.test.ts` gains four
cases for R10 under a front that is no longer always Main 1, including that two
rows both claiming Main 1 still yield exactly one board row.

## What this does not do

Nothing here counts population, compares a threshold, or converts anything.
`lightning_enabled` is a capability flag and `cluster_mode` stays `must_move`.
The population predicate is spec Phase 4 and the conversion is spec Phase 5. A
Cluster created with `lightning_enabled = true` is, after this migration, an
ordinary must-move Cluster that happens to have started as a feeder.

Nothing in `src/` sets the flag yet: no create-game screen offers it. The door
is open and deliberately unmarked until Phase 4 can say what happens next.

## Rollback

No new table and no new column. One new function
(`fn_cash_cluster_front_table`), two functions re-created in full
(`fn_cash_clusters_to_tick`, `fn_cash_game_must_move_list`) and three patched
by substitution. Restoring the three prior bodies from
`pg_get_functiondef` output taken before the apply, re-creating the two readers
from `20260909181653` and `20260905060000`, and dropping the new function
returns the prior behaviour exactly. Every existing Cluster has
`lightning_enabled = false`, so no live game changes shape.
