#!/usr/bin/env bash
# Lightning Phase 3 REMEDIATION: the front table is the main game, and the
# epoch follows its game.
#
# Applies 20260920235343, 20260921025504 and 20260921025523 to a throwaway
# PostgreSQL 17 cluster carrying the PRE-migration schema AND the PRE-migration
# FUNCTION BODIES, then applies 20260921044045 and exercises the one blocker
# and the three majors an adversarial audit found in the two Phase 3 files -
# against a real backend rather than against a reading of the file.
#
#   BLOCKER  nothing kept the epoch invariant true. 20260921025504 created
#            public.cash_cluster_epoch, backfilled it once, declared in its own
#            proof that every cash_games row has an open epoch row, and left
#            that a one-shot. The first Cluster created after it had no epoch
#            row at all and could never have written a Lightning row.
#   MAJOR    the cluster writer counted CLOSED tables, so R3 reopening a
#            Cluster's one table named it "<game> Feeder" and the lone-feeder
#            guard then stopped the ROLES step ever renaming it.
#   MAJOR    "three readers" was six. The lobby, the seat-change door and the
#            seat-change planner all still asked role = main AND main_index = 1.
#   AND      the break step was safe by accident, saved by a different clause
#            than the one written for the job.
#
# THIS MIGRATION DOES NOT CARRY THE CODE IT CHANGES, and that is what shapes
# both this file and its fixture. Five of its nine sections read an installed
# body out of the catalogue with pg_get_functiondef, assert an anchor occurs
# exactly once, replace() it and EXECUTE the result. So
# scripts/dev/fixtures/lightning-phase3-remediation-schema.sql installs those
# bodies carrying the anchors byte for byte, and they really run: the writer
# really inserts a tables row, the lobby really answers a named caller, the
# door really raises its seven refusals, the planner really cancels and really
# plans, and the tick really names a break candidate. A fixture of stubs would
# have proved that a text substitution succeeded and nothing about whether a
# player on the only table there is can read a status line.
#
# THE FIXTURE CARRIES THE PRE-25523 BODIES, NOT THE POST ONES. Two of the six
# functions under test - fn_cash_cluster_open_table and fn_cash_cluster_tick -
# are anchored by the remediation on text that 20260921025523 produced. Rather
# than transcribe that text into the fixture, where it would be free to drift,
# the harness applies the real 20260921025523 and lets it produce the bodies
# the remediation then reads. Same reason the phase-2 remediation harness
# applies the real 20260920235343 instead of copying its 647 lines.
#
# Six rules are built into the shape of this file, inherited from
# scripts/dev/test-lightning-phase3-feeder-first.sh, and every one of them was
# learned from mutation testing - copying the migration to a scratch directory,
# deleting one edit from the copy and watching what this harness does - rather
# than from review:
#
#   1. Every comparison is IS DISTINCT FROM, never = or <>. A NULL where a
#      value was expected makes `IF NOT (x = y)` evaluate to NULL, which
#      plpgsql takes as false, so an absent row PASSED a check written that
#      way. main_index is NULL for every feeder in this file and the front
#      table is NULL for a cluster whose every table has closed, so this is
#      not a hypothetical.
#   2. Every negative assertion is preceded by its non-vacuity proof. "The
#      break step named no candidate" is satisfied by a tick that never names
#      one, so the same section builds an ordinary board and watches the same
#      tick name one there. That pair is one test, not two.
#   3. Every refusal pairs with the thing that must still be accepted.
#      SEAT_CHANGE_NO_OTHER_TABLE is paired with the SAME request succeeding
#      once a second non-front table exists, and CLUSTER_EPOCH_GOES_FORWARD is
#      paired with the forward bump that must still be taken.
#   4. A rule is asserted against the other answer, not against itself. "The
#      reopened lone feeder is named after its game" is only a statement
#      because the check also asserts that the name the unfixed count would
#      have produced is a DIFFERENT string.
#   5. Every reader is asked about BOTH kinds of cluster. A front-table
#      definition that always returned the oldest live table would satisfy
#      every feeder-first assertion here and would silently re-order the lobby
#      for all 166 existing clusters, so every one of them is also asked of an
#      ordinary Main 1 / feeder board.
#   6. The re-apply is compared body by body, not by "it exited 0". Five of
#      these six functions are patched by SUBSTITUTION against whatever is
#      installed, so a second application that did not take its early-return
#      NOTICE would patch an already-patched body - doubling a branch, or
#      failing an anchor count - and a harness that only asked "did it exit 0"
#      would not see the difference. Both the six bodies and the trigger
#      definition are compared byte for byte, and the five NOTICES themselves
#      are asserted.
#
# LIGHTNING_PHASE3R_MIGRATION overrides the file under test. It exists so that
# mutation testing never has to touch the migration in the repository.
set -euo pipefail
export LC_ALL=C
# The repository root from this script's own location rather than from git:
# the harness is read-only with respect to the working tree and has no reason
# to shell out to it.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
migration=${LIGHTNING_PHASE3R_MIGRATION:-$root/supabase/migrations/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase3r-test.XXXXXX")
started=0
cleanup() {
  # || true: the trap runs under set -e, so a non-zero stop would abort the
  # function before rm -rf and leak the fixture directory -- and make a fully
  # passing run exit 1.
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55546 -h ''" start >/dev/null
started=1

# THE WINDOW IN WHICH NOTHING MAINTAINED THE EPOCH, reproduced. This file is
# applied AFTER 20260921025504 has backfilled the epoch table and BEFORE
# 20260921044045 installs the trigger - which is exactly the period the
# migration's catch-up is written for. Two different things can have gone wrong
# in it, and only one of them is a missing row.
cat > "$fixture/window.sql" <<'WINDOW'
-- (1) A CLUSTER WHOSE EPOCH MOVED WITH NOBODY WATCHING. The backfill in
--     20260921025504 gave it an open row at epoch 0; this bump leaves that row
--     open at an epoch the Cluster has left. A single
--     `INSERT ... ON CONFLICT (cluster_id, epoch) DO NOTHING` cannot repair it:
--     the index it violates is cash_cluster_epoch_current, UNIQUE on
--     (cluster_id) WHERE ended_at IS NULL, which is not the arbiter, so the
--     insert raises 23505 and rolls the whole migration back.
UPDATE public.cash_games SET cluster_epoch = 1
 WHERE id = 'ca000000-0000-0000-0000-000000000002';

-- (2) A CLUSTER BORN IN THE WINDOW. No epoch row at all, which is the hole the
--     migration's own prose is about. Its mode and epoch are deliberately not
--     the column defaults, so a catch-up writing constants would be visible.
INSERT INTO public.cash_games
  (id, club_id, union_id, name, template_name, variant, sb, bb, handedness,
   ruleset_snapshot, created_by, must_move, cluster_mode, cluster_epoch, created_at)
VALUES
  ('ca000000-0000-0000-0000-00000000000c', 'cb000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-0000000000f1', 'Born In The Window', 'classic', 'nlh',
   9.00, 18.00, 9, '{"seats": 9}'::jsonb, '00000000-0000-0000-0000-0000000000aa',
   true, 'pending_on', 2, timestamptz '2026-09-10 10:10:10+00');

INSERT INTO public.tables
  (id, club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
   status, created_by, cluster_id, role, main_index, lifecycle, opened_at, live_at, created_at)
VALUES
  ('ab000000-0000-0000-0000-00000000000c', 'cb000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-0000000000f1', 'Born In The Window', 'nlh', 9.00, 18.00, 9,
   'waiting', '00000000-0000-0000-0000-0000000000aa',
   'ca000000-0000-0000-0000-00000000000c', 'main', 1, 'live',
   timestamptz '2026-09-10 10:10:10+00', timestamptz '2026-09-10 10:10:10+00',
   timestamptz '2026-09-10 10:10:10+00');

-- The estate exactly as the migration is about to find it. Captured here and
-- not in the assertions, because the assertions run after the migration and
-- the whole point is what it found.
CREATE TEMP TABLE pre_catchup_epochs AS SELECT * FROM public.cash_cluster_epoch;
CREATE TEMP TABLE pre_catchup AS
  SELECT g.id AS cluster_id, g.cluster_epoch AS game_epoch, g.cluster_mode AS game_mode,
         g.created_at,
         (SELECT count(*) FROM public.cash_cluster_epoch e WHERE e.cluster_id = g.id) AS rows_,
         (SELECT count(*) FROM public.cash_cluster_epoch e
           WHERE e.cluster_id = g.id AND e.ended_at IS NULL) AS open_
    FROM public.cash_games g;
CREATE TEMP TABLE pre_apply_estate AS
  SELECT (SELECT count(*) FROM public.cash_games) AS clusters,
         (SELECT count(*) FROM public.cash_games g
           WHERE EXISTS (SELECT 1 FROM public.tables t
                          WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
                            AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false))
           AS with_main1;

-- AND THE WINDOW IS REAL: nothing maintains the table yet, so neither shape can
-- have healed itself between here and the migration.
DO $$
DECLARE v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.cash_games'::regclass
                AND tgname = 'trg_cash_games_epoch_follows_its_game' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL window: the epoch trigger already exists, so this file is not the window it claims to be';
  END IF;
  SELECT open_ INTO v_n FROM pre_catchup WHERE cluster_id = 'ca000000-0000-0000-0000-000000000002';
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL window: the stale cluster has % open epoch row(s), not the one it left behind', v_n;
  END IF;
  SELECT rows_ INTO v_n FROM pre_catchup WHERE cluster_id = 'ca000000-0000-0000-0000-00000000000c';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL window: the cluster born in the window already has % epoch row(s)', v_n;
  END IF;
END $$;
WINDOW

# The three assertion groups live in the throwaway directory with the cluster
# they are written for: ONE psql session, so the boards built by one section
# are still there for the next, the window capture and the pre-re-apply capture
# can both be TEMP tables, and the migration is applied a second time to the
# same backend that holds it.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- Every board this file builds, so that a later section can find what an
-- earlier one made without repeating a uuid literal in nine places.
CREATE TEMP TABLE board (k text PRIMARY KEY, game_id uuid, table_id uuid, payload jsonb);

-- THREE WRITERS THE HARNESS OWNS. Boards are built through these rather than
-- through fn_cash_cluster_open_table wherever a board needs a shape the one
-- cluster writer refuses to make: a table whose role is 'main' and whose
-- main_index is NULL (the NULLS FIRST row the re-cut exists to stop outranking
-- the real Main 1), a table that is already breaking, a table that is already
-- deleted. Where the shape is ordinary the writer is used instead, because
-- what the writer NAMES a table is itself under test.
CREATE FUNCTION public.fx_cluster(p_name text, p_lightning boolean DEFAULT false,
                                  p_mode text DEFAULT 'must_move', p_epoch integer DEFAULT 0,
                                  p_created_at timestamptz DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, cluster_mode, cluster_epoch, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     p_name, 'classic', 'nlh', 1.00, 2.00, 9, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, p_lightning, p_mode, p_epoch,
     coalesce(p_created_at, clock_timestamp()))
  RETURNING id INTO v_id;
  RETURN v_id;
END $fx$;

CREATE FUNCTION public.fx_table(p_game uuid, p_role text, p_main_index integer,
                                p_lifecycle text DEFAULT 'live', p_max integer DEFAULT 9,
                                p_deleted boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid; g record;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game;
  INSERT INTO public.tables
    (club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
     status, created_by, cluster_id, role, main_index, lifecycle, is_deleted,
     opened_at, live_at, created_at)
  VALUES
    (g.club_id, g.union_id,
     CASE WHEN p_role = 'main' AND coalesce(p_main_index, -1) = 1 THEN g.name
          WHEN p_role = 'main' THEN left(g.name, 50) || ' Main ' || coalesce(p_main_index::text, 'X')
          ELSE left(g.name, 50) || ' Feeder' END,
     g.variant, g.sb, g.bb, p_max,
     CASE WHEN p_lifecycle = 'closed' THEN 'closed' ELSE 'waiting' END,
     g.created_by, p_game, p_role, p_main_index, p_lifecycle, p_deleted,
     clock_timestamp(), clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END $fx$;

-- A chair AND the roster row that goes with it: the lobby, the door and the
-- planner all read cash_game_roster, and a player with a chair and no roster
-- row would make seat_change.available and the must-move position answer
-- something this harness never meant to ask about.
CREATE FUNCTION public.fx_seat(p_table uuid, p_user uuid, p_seat integer)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid; v_game uuid;
BEGIN
  SELECT cluster_id INTO v_game FROM public.tables WHERE id = p_table;
  INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, joined_at)
  VALUES (p_table, p_user, p_seat, 200.00, clock_timestamp()) RETURNING id INTO v_id;
  INSERT INTO public.cash_game_roster (game_id, user_id, joined_at)
  VALUES (v_game, p_user, clock_timestamp());
  RETURN v_id;
END $fx$;
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- A SINGLE-DIGIT ESTATE (S01) ------------------------------------------------
-- The regression test for a guard that used to be a headcount. An earlier cut
-- of this migration ended its read-back with `IF v_bad < 100 THEN RAISE`,
-- which made it refuse to apply to a fresh db reset, a preview branch, a CI
-- database or any scratch restore - a guard that stops the file running
-- exactly where it most needs to run first. It asks for ONE now, which is what
-- a non-vacuity guard is, and this fixture is deliberately small enough that
-- only the one-cluster form can pass.
DO $$
DECLARE c pre_apply_estate%ROWTYPE;
BEGIN
  SELECT * INTO c FROM pre_apply_estate;
  IF c.clusters IS NULL THEN
    RAISE EXCEPTION 'FAIL S01: the pre-apply estate was never captured';
  END IF;
  IF c.clusters > 9::bigint THEN
    RAISE EXCEPTION 'FAIL S01: the migration applied to % clusters, which is not a single-digit estate, so this fixture no longer measures the guard it is written for',
      c.clusters;
  END IF;
  IF c.clusters < 1::bigint THEN
    RAISE EXCEPTION 'FAIL S01: the migration applied to an empty estate, so every read-back in it was vacuous';
  END IF;
  -- The migration's own non-vacuity guard had something to pass on, and it was
  -- a single-digit something. Both halves: at 0 the guard must refuse, and at a
  -- hundred this fixture would be proving nothing about the guard at all.
  IF c.with_main1 < 1::bigint THEN
    RAISE EXCEPTION 'FAIL S01: no cluster had a live Main 1, so the migration''s own guard had nothing to pass on';
  END IF;
  IF c.with_main1 > 9::bigint THEN
    RAISE EXCEPTION 'FAIL S01: % clusters had a live Main 1, which is the production headcount this test exists to rule out',
      c.with_main1;
  END IF;
END $$;
\echo '  ok  SMALL FIXTURE     the migration applied to a single-digit estate with a single-digit number of live Main 1 clusters, which is the regression test for the hundred-cluster guard it used to carry'

-- THE CATCH-UP REPAIRS THE WINDOW (C02) --------------------------------------
-- Two shapes, and only one of them is a missing row. A Cluster CREATED in the
-- window has no epoch row; a Cluster whose epoch MOVED in it has an OPEN row at
-- an epoch it has left, and that one is what a single INSERT cannot repair -
-- ON CONFLICT takes one arbiter and the primary key is not the index that gets
-- violated. Both are asserted here, and the second is the one that turns a
-- 23505 rollback into a repair.
DO $$
DECLARE
  v_stale constant uuid := 'ca000000-0000-0000-0000-000000000002';
  v_born  constant uuid := 'ca000000-0000-0000-0000-00000000000c';
  pre record; e0 record; e1 record; v_e record; g record; v_n bigint;
BEGIN
  -- NON-VACUITY, read from the capture the window file took BEFORE the
  -- migration ran: the stale cluster really did carry one open row at an epoch
  -- it had left, and the window-born one really did carry none.
  SELECT * INTO pre FROM pre_catchup WHERE cluster_id = v_stale;
  IF pre.game_epoch IS DISTINCT FROM 1 OR pre.rows_ IS DISTINCT FROM 1::bigint
     OR pre.open_ IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL C02: before the migration the stale cluster read (epoch %, % row(s), % open) and should have read (1, 1, 1)',
      coalesce(pre.game_epoch::text, '<null>'), pre.rows_, pre.open_;
  END IF;
  IF (SELECT e.epoch FROM pre_catchup_epochs e WHERE e.cluster_id = v_stale) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL C02: the stale open row was not at epoch 0, so it was not stale';
  END IF;

  -- THE STALE ROW IS CLOSED AND THE CURRENT EPOCH IS OPENED.
  SELECT * INTO g FROM public.cash_games WHERE id = v_stale;
  SELECT * INTO e0 FROM public.cash_cluster_epoch WHERE cluster_id = v_stale AND epoch = 0;
  SELECT * INTO e1 FROM public.cash_cluster_epoch WHERE cluster_id = v_stale AND epoch = 1;
  IF e0.cluster_id IS DISTINCT FROM v_stale THEN
    RAISE EXCEPTION 'FAIL C02: the stale epoch 0 row was deleted rather than closed; the history is append-only';
  END IF;
  IF e0.ended_at IS NULL THEN
    RAISE EXCEPTION 'FAIL C02: the epoch 0 row is still open on a cluster that is at epoch 1';
  END IF;
  IF e1.cluster_id IS DISTINCT FROM v_stale THEN
    RAISE EXCEPTION 'FAIL C02: no epoch 1 row was opened for the cluster whose epoch moved in the window';
  END IF;
  IF e1.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL C02: the epoch 1 row the catch-up opened is already ended';
  END IF;
  IF e1.mode IS DISTINCT FROM g.cluster_mode THEN
    RAISE EXCEPTION 'FAIL C02: the repaired epoch runs under mode % and the cluster is in %',
      coalesce(e1.mode, '<null>'), coalesce(g.cluster_mode, '<null>');
  END IF;
  -- And the closed row still says what it always said: a repair is not a
  -- rewrite.
  IF e0.started_by IS DISTINCT FROM 'genesis' OR e0.started_at IS DISTINCT FROM pre.created_at THEN
    RAISE EXCEPTION 'FAIL C02: the closed epoch 0 row now reads (by %, at %) and was written (genesis, %)',
      coalesce(e0.started_by, '<null>'), e0.started_at, pre.created_at;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_stale;
  IF v_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL C02: the repaired cluster has % epoch rows, not 2', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_stale AND ended_at IS NULL;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL C02: the repaired cluster has % open epoch rows, and one is the whole invariant', v_n;
  END IF;
  -- WHAT THIS SECTION DELIBERATELY DOES NOT ASSERT, AND WHY. The recovered
  -- epoch 1 row's PROVENANCE is wrong, and pinning it here would make it
  -- harder to fix rather than easier. The catch-up INSERT supplies
  -- `'genesis', g.created_at` for every row it writes, which is right for a
  -- Cluster born in the window and wrong for a successor epoch recovered in
  -- it: the cluster ends up with two rows filed as its genesis, and the
  -- successor's started_at is the Cluster's creation time - earlier than its
  -- predecessor's ended_at, so the two epochs overlap for the whole life of
  -- the first. The trigger's own move branch gets this right (clock_timestamp
  -- and the reason, or 'unstated'). Reported 2026-09-21; assert started_by and
  -- started_at here once the repair files a recovered epoch as one.

  -- THE CLUSTER BORN IN THE WINDOW GETS ITS GENESIS ROW, carrying its own
  -- epoch, its own mode and its own created_at rather than three constants.
  IF (SELECT pc.rows_ FROM pre_catchup pc WHERE pc.cluster_id = v_born) IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL C02: the cluster born in the window already had an epoch row, so the catch-up had nothing to add';
  END IF;
  SELECT * INTO pre FROM pre_catchup WHERE cluster_id = v_born;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_born;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL C02: the cluster born in the window has % epoch rows, not exactly one', v_n;
  END IF;
  SELECT * INTO v_e FROM public.cash_cluster_epoch WHERE cluster_id = v_born;
  IF v_e.epoch IS DISTINCT FROM pre.game_epoch OR v_e.mode IS DISTINCT FROM pre.game_mode
     OR v_e.started_by IS DISTINCT FROM 'genesis' OR v_e.started_at IS DISTINCT FROM pre.created_at
     OR v_e.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL C02: the window-born cluster reads (epoch %, mode %, by %, at %, ended %) and its game says (%, %, genesis, %, null)',
      coalesce(v_e.epoch::text, '<null>'), coalesce(v_e.mode, '<null>'), coalesce(v_e.started_by, '<null>'),
      v_e.started_at, coalesce(v_e.ended_at::text, 'null'),
      coalesce(pre.game_epoch::text, '<null>'), coalesce(pre.game_mode, '<null>'), pre.created_at;
  END IF;
  IF pre.game_epoch IS NOT DISTINCT FROM 0 OR pre.game_mode IS NOT DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL C02: the window-born cluster carries the column defaults, so copying them proves nothing';
  END IF;

  -- AND THE REPAIR TOUCHED NOTHING ELSE. `ON CONFLICT DO UPDATE SET ended_at =
  -- NULL, mode = EXCLUDED.mode` fires for EVERY cluster, so a catch-up that
  -- also clobbered started_by or started_at would re-file every conversion
  -- reason in the estate as genesis.
  IF EXISTS (SELECT * FROM pre_catchup_epochs p
              WHERE p.cluster_id NOT IN (v_stale, v_born)
             EXCEPT
             SELECT * FROM public.cash_cluster_epoch) THEN
    RAISE EXCEPTION 'FAIL C02: the catch-up changed an epoch row on a cluster that needed no repair';
  END IF;
  SELECT count(*) INTO v_n FROM pre_catchup_epochs p WHERE p.cluster_id NOT IN (v_stale, v_born);
  IF v_n < 1::bigint THEN
    RAISE EXCEPTION 'FAIL C02: no untouched cluster existed, so "it touched nothing else" compares nothing';
  END IF;
END $$;
\echo '  ok  CATCH-UP          a cluster whose epoch moved while nothing maintained the table has its stale open row closed and its current epoch opened rather than the migration rolling back on 23505, a cluster born in that window gets a genesis row carrying its own epoch mode and created_at, the closed row still reads what it was written with, and no cluster that needed no repair moved'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE EPOCH FOLLOWS ITS GAME, ON CREATE (E01) --------------------------------
-- THE BLOCKER. Before this migration nothing wrote to public.cash_cluster_epoch
-- at all, so a Cluster created after 20260921025504 applied had NO epoch row -
-- and lightning_pool_session_runs_in_a_declared_epoch would have raised 23503
-- on its first Phase 4 write. There is no "wrong row" to look for here; there
-- is no row.
--
-- The seeded values are deliberately none of the column defaults: epoch 3
-- against a default of 0, mode 'lightning' against a default of 'must_move',
-- and a created_at eight weeks in the past against a default of
-- clock_timestamp(). A trigger that wrote three constants would satisfy an
-- assertion made against a cluster that carried the defaults, and would be
-- wrong for every Cluster Phase 5 ever converts.
DO $$
DECLARE
  v_gid uuid; v_res jsonb; v_created timestamptz; v_n bigint;
  v_e record; v_name text;
BEGIN
  v_gid := public.fx_cluster('Epoch Genesis Direct', false, 'lightning', 3,
                             timestamptz '2026-08-08 08:08:08+00');
  INSERT INTO board (k, game_id) VALUES ('epoch_direct', v_gid);
  SELECT g.created_at INTO v_created FROM public.cash_games g WHERE g.id = v_gid;

  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E01: a Cluster created after the migration has % epoch row(s), not exactly one; without the trigger there is none at all', v_n;
  END IF;

  SELECT * INTO v_e FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_e.epoch IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL E01: the genesis row is at epoch %, not the cluster''s own 3', coalesce(v_e.epoch::text, '<null>');
  END IF;
  IF v_e.mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL E01: the genesis row reads mode %, not the cluster''s own lightning', coalesce(v_e.mode, '<null>');
  END IF;
  IF v_e.started_by IS DISTINCT FROM 'genesis' THEN
    RAISE EXCEPTION 'FAIL E01: the genesis row reads started_by %, not genesis', coalesce(v_e.started_by, '<null>');
  END IF;
  IF v_e.started_at IS DISTINCT FROM v_created THEN
    RAISE EXCEPTION 'FAIL E01: the genesis row started at % and the game was created at %', v_e.started_at, v_created;
  END IF;
  IF v_e.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL E01: the genesis epoch is already ended at %, so the cluster has no open epoch', v_e.ended_at;
  END IF;

  -- NON-VACUITY: none of the three copied values is the column default, so a
  -- trigger writing constants could not have produced this row.
  IF v_e.epoch IS DISTINCT FROM 3 OR 3 IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL E01: the epoch under test is the column default, so copying it proves nothing';
  END IF;
  IF 'lightning' IS NOT DISTINCT FROM (SELECT column_default FROM information_schema.columns
                                        WHERE table_schema = 'public' AND table_name = 'cash_games'
                                          AND column_name = 'cluster_mode') THEN
    RAISE EXCEPTION 'FAIL E01: the mode under test is the column default, so copying it proves nothing';
  END IF;
  IF v_created IS NOT DISTINCT FROM clock_timestamp() THEN
    RAISE EXCEPTION 'FAIL E01: the created_at under test is now, so copying it proves nothing';
  END IF;

  -- AND AGAIN THROUGH THE ESTATE'S OWN CREATION PATH. The trigger is on the
  -- TABLE and not on the writer, which is the whole argument for putting it
  -- there; this is what makes that an observation rather than a claim.
  v_res := public.fn_cash_game_create_impl_20260905(
             'cb000000-0000-0000-0000-000000000001', 'classic', 'nlh', 3.00, 6.00, 9,
             '{}'::jsonb, 'Epoch Genesis Created', true);
  v_gid := (v_res->>'game_id')::uuid;
  INSERT INTO board (k, game_id, table_id, payload) VALUES ('epoch_created', v_gid, (v_res->>'table_id')::uuid, v_res);
  SELECT g.created_at, g.name INTO v_created, v_name FROM public.cash_games g WHERE g.id = v_gid;

  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E01: a Cluster created through fn_cash_game_create_impl_20260905 has % epoch row(s), not exactly one', v_n;
  END IF;
  SELECT * INTO v_e FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_e.epoch IS DISTINCT FROM 0 OR v_e.mode IS DISTINCT FROM 'must_move'
     OR v_e.started_by IS DISTINCT FROM 'genesis' OR v_e.started_at IS DISTINCT FROM v_created
     OR v_e.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL E01: the created Cluster''s genesis row is (epoch %, mode %, by %, at %, ended %) and the row says (0, must_move, genesis, %, null)',
      v_e.epoch, v_e.mode, v_e.started_by, v_e.started_at, v_e.ended_at, v_created;
  END IF;
  IF (SELECT count(*) FROM public.tables t WHERE t.cluster_id = v_gid) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E01: the created Cluster did not open exactly one table, so the create path is not the live one';
  END IF;

  -- AND THE INVARIANT 20260921025504 DECLARED AND DID NOT MAINTAIN IS TRUE OF
  -- THE WHOLE ESTATE, not only of the two rows above.
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e2
                      WHERE e2.cluster_id = g.id AND e2.epoch = g.cluster_epoch AND e2.ended_at IS NULL);
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL E01: % cluster(s) have no open epoch row at their own cluster_epoch', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games;
  IF v_n < 7::bigint THEN
    RAISE EXCEPTION 'FAIL E01: only % cluster(s) exist, so the invariant above was asserted of almost nothing', v_n;
  END IF;
END $$;
\echo '  ok  EPOCH ON CREATE   a Cluster created by a bare INSERT and a Cluster created through the live create path each get exactly one genesis epoch row carrying their own epoch their own mode and their own created_at with started_by genesis and no ended_at, and every cluster in the estate has an open epoch row at its own cluster_epoch'

-- THE EPOCH MOVES FORWARD (E02) ----------------------------------------------
-- Phase 5 bumps one integer; the history has to be correct by construction
-- rather than by the conversion remembering to write two rows. The reason is
-- read from ca.epoch_reason, a transaction-local setting exactly like
-- ca.break_window_migration_override, and an unexplained bump files as
-- 'unstated' rather than being refused - refusing it would make the history
-- LESS complete, not more.
DO $$
DECLARE v_gid uuid; e0 record; e1 record; v_open bigint; v_mode text; v_msg text;
BEGIN
  -- 'draining' rather than the ordinary 'must_move': every value the trigger
  -- copies has to be one a constant could not have produced.
  v_gid := public.fx_cluster('Epoch Moves Forward', true, 'draining', 0);
  INSERT INTO board (k, game_id) VALUES ('epoch_moves', v_gid);
  PERFORM set_config('ca.epoch_reason', 'phase5_population_reached', true);
  BEGIN
    UPDATE public.cash_games SET cluster_epoch = 1 WHERE id = v_gid;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE EXCEPTION 'FAIL E02: a forward bump from epoch 0 to 1 was refused: %', v_msg;
  END;

  SELECT * INTO e0 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 0;
  SELECT * INTO e1 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 1;
  IF e0.cluster_id IS DISTINCT FROM v_gid THEN
    RAISE EXCEPTION 'FAIL E02: the epoch 0 row vanished when the cluster moved forward; the history is append-only';
  END IF;
  IF e0.ended_at IS NULL THEN
    RAISE EXCEPTION 'FAIL E02: epoch 0 is still open after the cluster moved to epoch 1';
  END IF;
  IF e1.cluster_id IS DISTINCT FROM v_gid THEN
    RAISE EXCEPTION 'FAIL E02: no epoch 1 row opened when the cluster moved to epoch 1';
  END IF;
  IF e1.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL E02: the new epoch 1 row is already ended at %', e1.ended_at;
  END IF;
  IF e1.started_by IS DISTINCT FROM 'phase5_population_reached' THEN
    RAISE EXCEPTION 'FAIL E02: epoch 1 filed its reason as % and ca.epoch_reason said phase5_population_reached',
      coalesce(e1.started_by, '<null>');
  END IF;
  -- The new epoch carries the mode the Cluster is in at that moment, and the
  -- cluster is deliberately not in the column default, so a trigger writing a
  -- constant could not have produced this row.
  SELECT g.cluster_mode INTO v_mode FROM public.cash_games g WHERE g.id = v_gid;
  IF e1.mode IS DISTINCT FROM v_mode THEN
    RAISE EXCEPTION 'FAIL E02: epoch 1 runs under mode % and the cluster is in %', coalesce(e1.mode, '<null>'), coalesce(v_mode, '<null>');
  END IF;
  IF v_mode IS DISTINCT FROM 'draining' OR 'draining' IS NOT DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL E02: the mode under test is the ordinary one, so copying it proves nothing';
  END IF;
  -- cash_cluster_epoch_current STILL HOLDS: exactly one open row.
  SELECT count(*) INTO v_open FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND ended_at IS NULL;
  IF v_open IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E02: the cluster has % open epoch rows after one bump, and one is the whole invariant', v_open;
  END IF;
END $$;

-- AND A BUMP NOBODY EXPLAINED IS FILED, NOT REFUSED. Its own transaction, so
-- the transaction-local ca.epoch_reason set above is gone.
DO $$
DECLARE v_gid uuid; e1 record; e2 record; v_open bigint; v_n bigint; v_msg text;
BEGIN
  SELECT b.game_id INTO v_gid FROM board b WHERE b.k = 'epoch_moves';
  IF nullif(current_setting('ca.epoch_reason', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL E02: ca.epoch_reason survived into a second transaction, so "unstated" below would prove nothing';
  END IF;
  BEGIN
    UPDATE public.cash_games SET cluster_epoch = 2 WHERE id = v_gid;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE EXCEPTION 'FAIL E02: a forward bump from epoch 1 to 2 was refused: %', v_msg;
  END;
  SELECT * INTO e1 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 1;
  SELECT * INTO e2 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 2;
  IF e1.ended_at IS NULL THEN
    RAISE EXCEPTION 'FAIL E02: epoch 1 is still open after the cluster moved to epoch 2';
  END IF;
  IF e2.started_by IS DISTINCT FROM 'unstated' THEN
    RAISE EXCEPTION 'FAIL E02: an unexplained bump filed its reason as %, not unstated', coalesce(e2.started_by, '<absent>');
  END IF;
  IF e2.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL E02: the new epoch 2 row is already ended';
  END IF;
  SELECT count(*) INTO v_open FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND ended_at IS NULL;
  IF v_open IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E02: the cluster has % open epoch rows after two bumps', v_open;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL E02: the cluster has % epoch rows after two bumps, not 3', v_n;
  END IF;
END $$;
\echo '  ok  EPOCH MOVES       a forward bump ends the open epoch and opens the next one carrying the mode the Cluster is in at that moment, files the reason ca.epoch_reason names, files an unexplained bump as unstated rather than refusing it, and leaves cash_cluster_epoch_current holding with exactly one open row of three'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE EPOCH NEVER GOES BACK (E03) --------------------------------------------
-- An epoch that could be reused would make every historical Lightning row
-- ambiguous, which is the whole reason the epoch became a row. The refusal is
-- asserted three ways - by its name in the message, by its SQLSTATE, and by
-- the history being exactly what it was before - and paired with the forward
-- bump that must still be taken.
DO $$
DECLARE v_gid uuid;
BEGIN
  v_gid := public.fx_cluster('Epoch Goes Forward Only', false, 'must_move', 0);
  INSERT INTO board (k, game_id) VALUES ('epoch_back', v_gid);
  UPDATE public.cash_games SET cluster_epoch = 1 WHERE id = v_gid;
  UPDATE public.cash_games SET cluster_epoch = 2 WHERE id = v_gid;
END $$;

CREATE TEMP TABLE pre_backwards AS
  SELECT e.* FROM public.cash_cluster_epoch e
   WHERE e.cluster_id = (SELECT b.game_id FROM board b WHERE b.k = 'epoch_back');

DO $$
DECLARE
  v_gid uuid; v_state text; v_msg text; v_raised boolean := false;
  v_n bigint; v_epoch integer; v_open bigint;
BEGIN
  SELECT b.game_id INTO v_gid FROM board b WHERE b.k = 'epoch_back';

  -- NON-VACUITY: there is a history to leave alone, and the cluster really is
  -- at 2, so "back to 0" is a move backwards and not a no-op.
  SELECT count(*) INTO v_n FROM pre_backwards;
  IF v_n IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL E03: the pre-refusal capture holds % epoch row(s), not 3, so "unchanged" compares almost nothing', v_n;
  END IF;
  SELECT g.cluster_epoch INTO v_epoch FROM public.cash_games g WHERE g.id = v_gid;
  IF v_epoch IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL E03: the cluster is at epoch %, not 2, so 0 may not be backwards', coalesce(v_epoch::text, '<null>');
  END IF;

  BEGIN
    UPDATE public.cash_games SET cluster_epoch = 0 WHERE id = v_gid;
  EXCEPTION WHEN others THEN
    v_raised := true;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  IF v_raised IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL E03: a cluster at epoch 2 was moved back to 0 without a word';
  END IF;
  IF position('CLUSTER_EPOCH_GOES_FORWARD' in coalesce(v_msg, '')) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL E03: the backwards move was refused by something else: %', coalesce(v_msg, '<no message>');
  END IF;
  IF v_state IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'FAIL E03: the refusal came back as SQLSTATE %, not 23514 check_violation, so no caller can tell it from a deadlock',
      coalesce(v_state, '<none>');
  END IF;

  -- AND THE HISTORY DID NOT MOVE. A guard that raised after writing would be
  -- invisible to the two checks above.
  IF EXISTS (SELECT * FROM pre_backwards EXCEPT SELECT * FROM public.cash_cluster_epoch)
     OR EXISTS (SELECT * FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_gid
                 EXCEPT SELECT * FROM pre_backwards) THEN
    RAISE EXCEPTION 'FAIL E03: an epoch row changed under the refused backwards move';
  END IF;
  SELECT g.cluster_epoch INTO v_epoch FROM public.cash_games g WHERE g.id = v_gid;
  IF v_epoch IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL E03: the cluster is at epoch % after the refused move, not 2', coalesce(v_epoch::text, '<null>');
  END IF;

  -- PAIRED WITH WHAT MUST STILL BE ACCEPTED: forward is forward.
  UPDATE public.cash_games SET cluster_epoch = 5 WHERE id = v_gid;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 4::bigint THEN
    RAISE EXCEPTION 'FAIL E03: a forward bump past the refused one left % epoch rows, not 4', v_n;
  END IF;
  SELECT count(*) INTO v_open FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND ended_at IS NULL;
  IF v_open IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL E03: the cluster has % open epoch rows after the accepted bump', v_open;
  END IF;
  IF (SELECT e.epoch FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_gid AND e.ended_at IS NULL)
     IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL E03: the open epoch after the accepted bump is not 5';
  END IF;
END $$;
\echo '  ok  EPOCH FORWARD     a cluster at epoch 2 refuses a move back to 0 with CLUSTER_EPOCH_GOES_FORWARD in the message and SQLSTATE 23514, leaves all three of its epoch rows and its own cluster_epoch exactly as they were, and still takes the forward bump to 5'

-- THE MODE FOLLOWS, AND ONLY THE OPEN EPOCH (E04) ----------------------------
-- cash_cluster_epoch carries its own copy of the mode rather than joining
-- cash_games precisely so that a FINISHED epoch's mode cannot change when the
-- cluster's current mode does. A WHERE that forgot ended_at IS NULL would
-- rewrite history every time Phase 5 flipped a switch.
DO $$
DECLARE v_gid uuid; e0 record; e1 record; v_before text; v_ended timestamptz;
BEGIN
  v_gid := public.fx_cluster('Mode Follows The Open Epoch', true, 'must_move', 0);
  INSERT INTO board (k, game_id) VALUES ('mode_follows', v_gid);
  UPDATE public.cash_games SET cluster_epoch = 1 WHERE id = v_gid;

  SELECT * INTO e0 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 0;
  v_before := e0.mode;
  v_ended := e0.ended_at;
  -- NON-VACUITY: there IS an ended epoch to leave alone, and the mode it ran
  -- under is not the mode the cluster is about to move to.
  IF v_ended IS NULL THEN
    RAISE EXCEPTION 'FAIL E04: epoch 0 is not ended, so "an ended row does not move" has nothing to say';
  END IF;
  IF v_before IS DISTINCT FROM 'must_move' OR 'lightning' IS NOT DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL E04: the ended epoch already reads the mode under test, so the check below cannot fail';
  END IF;

  UPDATE public.cash_games SET cluster_mode = 'lightning' WHERE id = v_gid;

  SELECT * INTO e1 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 1;
  IF e1.mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL E04: the OPEN epoch reads mode % after the cluster moved to lightning', coalesce(e1.mode, '<null>');
  END IF;
  SELECT * INTO e0 FROM public.cash_cluster_epoch WHERE cluster_id = v_gid AND epoch = 0;
  IF e0.mode IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL E04: the ENDED epoch 0 ran under % and now reads %, so the history was rewritten',
      coalesce(v_before, '<null>'), coalesce(e0.mode, '<null>');
  END IF;
  IF e0.ended_at IS DISTINCT FROM v_ended THEN
    RAISE EXCEPTION 'FAIL E04: the ended epoch''s ended_at moved when the cluster changed mode';
  END IF;
  IF e1.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL E04: the open epoch was ended by a mode change';
  END IF;
END $$;

CREATE TEMP TABLE pre_noop_epochs AS SELECT * FROM public.cash_cluster_epoch;

DO $$
DECLARE v_gid uuid; v_n bigint; v_mode text;
BEGIN
  SELECT b.game_id INTO v_gid FROM board b WHERE b.k = 'mode_follows';
  -- NON-VACUITY: the cluster has two epoch rows in two different modes, so an
  -- UPDATE that wrote either one would be visible.
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL E04: the no-op cluster has % epoch rows, not 2', v_n;
  END IF;
  SELECT g.cluster_mode INTO v_mode FROM public.cash_games g WHERE g.id = v_gid;
  IF v_mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL E04: the no-op cluster is in mode %, not lightning', coalesce(v_mode, '<null>');
  END IF;
  SELECT count(*) INTO v_n FROM pre_noop_epochs;
  IF v_n < 12::bigint THEN
    RAISE EXCEPTION 'FAIL E04: the capture holds % epoch rows, so "nothing moved" compares almost nothing', v_n;
  END IF;

  -- AN UPDATE THAT TOUCHES NEITHER COLUMN. The trigger is declared
  -- AFTER UPDATE OF cluster_epoch, cluster_mode, so this must not even fire.
  UPDATE public.cash_games SET last_tick_at = now() WHERE id = v_gid;

  IF EXISTS (SELECT * FROM pre_noop_epochs EXCEPT SELECT * FROM public.cash_cluster_epoch)
     OR EXISTS (SELECT * FROM public.cash_cluster_epoch EXCEPT SELECT * FROM pre_noop_epochs) THEN
    RAISE EXCEPTION 'FAIL E04: an epoch row changed under an UPDATE that touched neither cluster_epoch nor cluster_mode';
  END IF;
  IF (SELECT count(*) FROM public.cash_cluster_epoch) IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'FAIL E04: cash_cluster_epoch went from % rows to %', v_n, (SELECT count(*) FROM public.cash_cluster_epoch);
  END IF;
END $$;
\echo '  ok  MODE FOLLOWS      a cluster_mode change rewrites the OPEN epoch row and leaves the ENDED one reading the mode it ran under and the ended_at it ended at, and an UPDATE that touches neither cluster_epoch nor cluster_mode moves no epoch row at all'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE FRONT TABLE, RE-CUT (F05) ----------------------------------------------
-- Three coalesced index lookups instead of one sorted boolean. Six boards,
-- because the re-cut is written for three reasons at once and a definition
-- that satisfied any two of them would still be wrong.
DO $$
DECLARE
  v_g uuid; v_m uuid; v_f uuid; v_x uuid; v_b0 uuid; v_b1 uuid; v_b2 uuid;
  v_f1 uuid; v_f2 uuid; v_c uuid; v_d uuid; v_l uuid; v_front uuid; v_n bigint;
  r record;
BEGIN
  -- (a) MAIN 1 BEATS AN OLDER LIVE FEEDER. This is the arm-order proof: a
  --     coalesce whose first arm were the oldest live table would answer the
  --     feeder here and would re-order the lobby for all 166 live clusters.
  v_g := public.fx_cluster('Front Main Over Older Feeder');
  v_f := public.fx_table(v_g, 'feeder', NULL, 'live');
  v_m := public.fx_table(v_g, 'main', 1, 'live');
  INSERT INTO board (k, game_id, table_id) VALUES ('front_main', v_g, v_m);
  IF (SELECT t.created_at FROM public.tables t WHERE t.id = v_f)
     >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_m) THEN
    RAISE EXCEPTION 'FAIL F05a: the feeder is not older than the Main 1, so "beats an older feeder" says nothing';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM v_m THEN
    RAISE EXCEPTION 'FAIL F05a: the front table is % and the cluster''s live Main 1 is %',
      coalesce(v_front::text, '<null>'), v_m;
  END IF;

  -- (b) NO MAIN 1: THE OLDEST LIVE NON-BREAKING TABLE. A breaking table
  --     refuses every player it is sent (SEAT_CHANGE_TABLE_CLOSING), so it
  --     must not be what the controller keys its eligible-horse map on.
  v_g := public.fx_cluster('Front Oldest Live Not Breaking');
  v_b0 := public.fx_table(v_g, 'feeder', NULL, 'breaking');
  v_f1 := public.fx_table(v_g, 'feeder', NULL, 'live');
  v_f2 := public.fx_table(v_g, 'feeder', NULL, 'live');
  INSERT INTO board (k, game_id, table_id) VALUES ('front_oldest_live', v_g, v_f1);
  IF (SELECT t.created_at FROM public.tables t WHERE t.id = v_b0)
     >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_f1) THEN
    RAISE EXCEPTION 'FAIL F05b: the breaking table is not the oldest, so skipping it says nothing';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM v_f1 THEN
    RAISE EXCEPTION 'FAIL F05b: the front table is % and the oldest live non-breaking table is %',
      coalesce(v_front::text, '<null>'), v_f1;
  END IF;
  IF v_front IS NOT DISTINCT FROM v_b0 THEN
    RAISE EXCEPTION 'FAIL F05b: a breaking table is standing for a cluster that has two live ones';
  END IF;

  -- (c) AND ONLY IF EVERY TABLE IS BREAKING, THE OLDEST OF THOSE: a game that
  --     still exists is better represented by a closing table than by nothing.
  v_g := public.fx_cluster('Front All Breaking');
  v_b1 := public.fx_table(v_g, 'feeder', NULL, 'breaking');
  v_b2 := public.fx_table(v_g, 'feeder', NULL, 'breaking');
  SELECT count(*) INTO v_n FROM public.tables t
   WHERE t.cluster_id = v_g AND t.lifecycle NOT IN ('closed', 'breaking') AND coalesce(t.is_deleted, false) = false;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL F05c: the all-breaking cluster has % non-breaking live table(s), so the third arm is not what answered', v_n;
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM v_b1 THEN
    RAISE EXCEPTION 'FAIL F05c: a cluster whose every table is breaking answered % and its oldest breaking table is %',
      coalesce(v_front::text, '<null>'), v_b1;
  END IF;

  -- (d) role = 'main' WITH A NULL main_index DOES NOT OUTRANK THE REAL MAIN 1.
  --     `ORDER BY (t.role = 'main' AND t.main_index = 1) DESC` is NULLS FIRST
  --     by default and that expression is NULL - not false - for such a row,
  --     so it sorted ahead of the Main 1 it is not. There are none live today;
  --     there were 3,085 closed ones, so this is built by hand on purpose.
  v_g := public.fx_cluster('Front Null Main Index');
  v_x := public.fx_table(v_g, 'main', NULL, 'live');
  v_m := public.fx_table(v_g, 'main', 1, 'live');
  INSERT INTO board (k, game_id, table_id) VALUES ('front_null_index', v_g, v_m);
  SELECT t.role, t.main_index, t.lifecycle, t.is_deleted, t.created_at INTO r
    FROM public.tables t WHERE t.id = v_x;
  IF r.role IS DISTINCT FROM 'main' OR r.main_index IS DISTINCT FROM NULL
     OR r.lifecycle IS DISTINCT FROM 'live' OR r.is_deleted IS DISTINCT FROM false
     OR r.created_at >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_m) THEN
    RAISE EXCEPTION 'FAIL F05d: the NULLS FIRST row is not a live undeleted older role=main main_index=NULL row, so it could not have outranked anything';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM v_m THEN
    RAISE EXCEPTION 'FAIL F05d: a role=main main_index=NULL row answered for the cluster (% rather than the real Main 1 %)',
      coalesce(v_front::text, '<null>'), v_m;
  END IF;

  -- (e) NO LIVE TABLE AT ALL: NULL, not an exception and not a closed row.
  v_g := public.fx_cluster('Front Nothing Live');
  v_c := public.fx_table(v_g, 'main', 1, 'closed');
  SELECT count(*) INTO v_n FROM public.tables t WHERE t.cluster_id = v_g;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL F05e: the closed-only cluster has % table rows, so "NULL" is about an empty cluster and not about skipping', v_n;
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL F05e: a cluster whose only table has closed answered %', v_front;
  END IF;

  -- (f) CLOSED AND DELETED ARE SKIPPED BY ALL THREE ARMS. The deleted row is
  --     a role=main main_index=1 row and the oldest thing there is: if any arm
  --     read it, it would win.
  v_g := public.fx_cluster('Front Skips Closed And Deleted');
  v_d := public.fx_table(v_g, 'main', 1, 'live', 9, true);
  v_c := public.fx_table(v_g, 'feeder', NULL, 'closed');
  v_l := public.fx_table(v_g, 'feeder', NULL, 'live');
  INSERT INTO board (k, game_id, table_id) VALUES ('front_skips', v_g, v_l);
  SELECT t.is_deleted, t.role, t.main_index, t.created_at INTO r FROM public.tables t WHERE t.id = v_d;
  IF r.is_deleted IS DISTINCT FROM true OR r.role IS DISTINCT FROM 'main' OR r.main_index IS DISTINCT FROM 1
     OR r.created_at >= (SELECT t.created_at FROM public.tables t WHERE t.id = v_l) THEN
    RAISE EXCEPTION 'FAIL F05f: the deleted row is not an older deleted Main 1, so skipping it says nothing';
  END IF;
  IF (SELECT t.lifecycle FROM public.tables t WHERE t.id = v_c) IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'FAIL F05f: the closed row is not closed';
  END IF;
  v_front := public.fn_cash_cluster_front_table(v_g);
  IF v_front IS DISTINCT FROM v_l THEN
    RAISE EXCEPTION 'FAIL F05f: the front table is % and the only live undeleted table is %',
      coalesce(v_front::text, '<null>'), v_l;
  END IF;
END $$;
\echo '  ok  FRONT TABLE       Main 1 beats an older live feeder, the oldest live non-breaking table stands for a cluster with no Main 1, a breaking table stands for one only when every table is breaking, a role=main main_index=NULL row does not outrank the real Main 1, a cluster whose only table has closed answers NULL, and a deleted Main 1 and a closed feeder are skipped by all three arms'

-- THE CLUSTER WRITER COUNTS LIVE TABLES (W06) --------------------------------
-- THE MAJOR. `WHEN v_n = 0 THEN g.name` is right on the creation path and
-- wrong on the R3 reopen path, where the CLOSED row is still there: an
-- all-time count made v_n >= 1, the reopened lone feeder was named
-- "<game> Feeder", and the lone-feeder guard then stopped the ROLES step ever
-- renaming it. The lobby printed "NLH 1/2 Action Feeder" as the name of the
-- game, which is verbatim the defect 20260921025523 says it fixed.
DO $$
DECLARE
  v_g uuid; v_name text; v_feeder_name text;
  t1 uuid; t2 uuid; t3 uuid; u1 uuid; u2 uuid;
  v_n bigint;
BEGIN
  v_g := public.fx_cluster('Writer Counts Live Tables');
  INSERT INTO board (k, game_id) VALUES ('writer_closed', v_g);
  SELECT g.name INTO v_name FROM public.cash_games g WHERE g.id = v_g;
  v_feeder_name := left(v_name, 50) || ' Feeder';
  -- RULE 4: the naming rule is asserted against the OTHER answer. Without
  -- this, "named after its game" and "named <game> Feeder" could be the same
  -- string and every check below would be satisfied by either.
  IF v_feeder_name IS NOT DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'FAIL W06: the two names this section tells apart are the same string';
  END IF;

  -- The creation path: no table at all, so the first one stands for the game.
  t1 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT t.name FROM public.tables t WHERE t.id = t1) IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'FAIL W06: a cluster''s first table was named % and its game is called %',
      coalesce((SELECT t.name FROM public.tables t WHERE t.id = t1), '<null>'), v_name;
  END IF;
  -- The writer really wrote: a tables row and a ledger row, and it returned
  -- the row it wrote.
  IF (SELECT count(*) FROM public.tables t WHERE t.id = t1) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL W06: the writer returned an id that is not a tables row';
  END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.table_id = t1)
     IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL W06: the writer wrote no cash_cluster_events row for the table it opened';
  END IF;

  -- THE R3 REOPEN PATH. The closed row is still there; the count must not see
  -- it.
  UPDATE public.tables SET lifecycle = 'closed', status = 'closed' WHERE id = t1;
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL W06: the cluster carries % table rows before the reopen, so an all-time count and a live count would agree', v_n;
  END IF;
  t2 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT t.name FROM public.tables t WHERE t.id = t2) IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'FAIL W06: the reopened lone feeder is called % and its game is called %; the closed row was counted',
      coalesce((SELECT t.name FROM public.tables t WHERE t.id = t2), '<null>'), v_name;
  END IF;

  -- AND PAIRED WITH WHAT MUST STILL HAPPEN: with a live table already there,
  -- the next one is a feeder and is named one.
  t3 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT t.name FROM public.tables t WHERE t.id = t3) IS DISTINCT FROM v_feeder_name THEN
    RAISE EXCEPTION 'FAIL W06: a cluster''s SECOND live table is called % and should be %',
      coalesce((SELECT t.name FROM public.tables t WHERE t.id = t3), '<null>'), v_feeder_name;
  END IF;

  -- THE OTHER HALF OF THE COUNT: a deleted row is not a live table either.
  v_g := public.fx_cluster('Writer Skips Deleted Tables');
  INSERT INTO board (k, game_id) VALUES ('writer_deleted', v_g);
  SELECT g.name INTO v_name FROM public.cash_games g WHERE g.id = v_g;
  u1 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  UPDATE public.tables SET is_deleted = true WHERE id = u1;
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL W06: the deleted-row cluster carries % table rows, so an all-time count would not differ', v_n;
  END IF;
  u2 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT t.name FROM public.tables t WHERE t.id = u2) IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'FAIL W06: the table opened beside a DELETED row is called % and its game is called %',
      coalesce((SELECT t.name FROM public.tables t WHERE t.id = u2), '<null>'), v_name;
  END IF;
END $$;
\echo '  ok  CLUSTER WRITER    a cluster''s first live table is named after its game, a table reopened beside a CLOSED row and a table opened beside a DELETED row are both still named after the game, and a table opened beside a LIVE one is named <game> Feeder'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE LOBBY (L07) ------------------------------------------------------------
-- MustMoveLobbyModal renders "You Are In The Main Game." from me.on_main_one
-- and offers the Seat Change button from me.seat_change.available. On a
-- Cluster whose one table is a feeder both were false: the only player in the
-- only game there is read no status line at all, beside a button that could
-- not work.
--
-- The lobby is asked as a NAMED caller, through auth.uid(), because the answer
-- is about who is asking; a lobby asked as nobody would make every assertion
-- here a statement about the default branch.
CREATE FUNCTION public.fx_lobby(p_game uuid, p_user uuid)
RETURNS jsonb LANGUAGE plpgsql AS $fx$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  RETURN public.fn_cash_game_lobby(p_game);
END $fx$;

DO $$
DECLARE
  v_g uuid; v_feeder uuid; v_main uuid; v_lob jsonb; v_me jsonb;
  c_p1 constant uuid := '11110000-0000-0000-0000-000000000001';
  c_p9 constant uuid := '11110000-0000-0000-0000-000000000009';
BEGIN
  -- (a) THE FEEDER-FIRST CLUSTER. One live feeder, one seated player.
  v_g := public.fx_cluster('Lobby Feeder First', true);
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 'live');
  PERFORM public.fx_seat(v_feeder, c_p1, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('lobby_feeder_first', v_g, v_feeder);

  v_lob := public.fx_lobby(v_g, c_p1);
  v_me := v_lob->'me';
  IF (v_lob->>'front_table_id')::uuid IS DISTINCT FROM v_feeder THEN
    RAISE EXCEPTION 'FAIL L07a: the lobby says the front table is % and the cluster''s one live table is %',
      coalesce(v_lob->>'front_table_id', '<absent>'), v_feeder;
  END IF;
  -- NON-VACUITY: the caller is on a FEEDER with no main_index, so the question
  -- the lobby used to ask would have answered false here.
  IF (v_me->>'table_id')::uuid IS DISTINCT FROM v_feeder THEN
    RAISE EXCEPTION 'FAIL L07a: the caller is not seated where this section seated them';
  END IF;
  IF v_me->>'role' IS DISTINCT FROM 'feeder' OR jsonb_typeof(v_me->'main_index') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'FAIL L07a: the caller is on role % main_index %, so "Main 1 answered false" is not what is being fixed',
      coalesce(v_me->>'role', '<null>'), coalesce(v_me->>'main_index', '<null>');
  END IF;
  IF v_me->'on_main_one' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07a: on_main_one is % for the only player in the only game there is',
      coalesce((v_me->'on_main_one')::text, '<absent>');
  END IF;
  -- The button must be dark, and the ONLY reason it may be dark is that they
  -- are already in the main game: every other conjunct of `available` is
  -- asserted true first.
  IF jsonb_typeof(v_me->'seat_change'->'used_at') IS DISTINCT FROM 'null'
     OR jsonb_typeof(v_me->'seat_change'->'request') IS DISTINCT FROM 'null'
     OR jsonb_typeof(v_me->'pending_move') IS DISTINCT FROM 'null'
     OR v_me->>'lifecycle' IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'FAIL L07a: the caller has a used allowance, an open request, a pending move or a closing table, so a dark button proves nothing';
  END IF;
  IF v_me->'seat_change'->'available' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07a: seat_change.available is % for a player already in the main game',
      coalesce((v_me->'seat_change'->'available')::text, '<absent>');
  END IF;

  -- (b) AN UNSEATED CALLER READS JSON NULL, NOT false. The migration replaces
  --     on_main_one with a plain `=` rather than IS DISTINCT FROM for exactly
  --     this: three-valued, and pinned by the fixtures that came before.
  v_lob := public.fx_lobby(v_g, c_p9);
  v_me := v_lob->'me';
  IF v_me->'seated' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07b: the unseated caller reads seated %, so they are not unseated',
      coalesce((v_me->'seated')::text, '<absent>');
  END IF;
  IF jsonb_typeof(v_me->'on_main_one') IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'FAIL L07b: an unseated caller reads on_main_one %, and it has always been null',
      coalesce(jsonb_typeof(v_me->'on_main_one'), '<absent>');
  END IF;
  IF v_me->'seat_change'->'available' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07b: an unseated caller is offered a seat change';
  END IF;

  -- (c) AN ORDINARY CLUSTER, BOTH WAYS ROUND. A front-table definition that
  --     always answered the oldest live table would satisfy (a) and would
  --     re-order this board for all 166 live clusters.
  v_g := public.fx_cluster('Lobby Ordinary Board');
  v_main := public.fx_table(v_g, 'main', 1, 'live');
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 'live');
  PERFORM public.fx_seat(v_main, '11110000-0000-0000-0000-000000000003'::uuid, 1);
  PERFORM public.fx_seat(v_feeder, '11110000-0000-0000-0000-000000000002'::uuid, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('lobby_ordinary', v_g, v_main);

  v_lob := public.fx_lobby(v_g, '11110000-0000-0000-0000-000000000002'::uuid);
  v_me := v_lob->'me';
  IF (v_lob->>'front_table_id')::uuid IS DISTINCT FROM v_main THEN
    RAISE EXCEPTION 'FAIL L07c: the ordinary cluster''s front table is % and its live Main 1 is %',
      coalesce(v_lob->>'front_table_id', '<absent>'), v_main;
  END IF;
  IF v_me->'on_main_one' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07c: the player on the feeder reads on_main_one %',
      coalesce((v_me->'on_main_one')::text, '<absent>');
  END IF;
  IF v_me->'seat_change'->'available' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07c: the player on the feeder is not offered a seat change (%)',
      coalesce((v_me->'seat_change'->'available')::text, '<absent>');
  END IF;

  v_lob := public.fx_lobby(v_g, '11110000-0000-0000-0000-000000000003'::uuid);
  v_me := v_lob->'me';
  IF v_me->'on_main_one' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07c: the player on Main 1 reads on_main_one %',
      coalesce((v_me->'on_main_one')::text, '<absent>');
  END IF;
  IF v_me->'seat_change'->'available' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL L07c: the player on Main 1 is offered a seat change off the main game';
  END IF;
END $$;
\echo '  ok  LOBBY             a feeder-first cluster reports its one live feeder as front_table_id and tells the player on it that they are in the main game and offers them no seat change, an unseated caller still reads on_main_one as JSON null rather than false, and on an ordinary Main 1 plus feeder board the feeder player reads false with the button lit and the Main 1 player reads true with it dark'

-- THE SEAT-CHANGE DOOR (D08) -------------------------------------------------
-- On a feeder-first Cluster neither refusal fired: pressing the button raised
-- SEAT_CHANGE_NO_OTHER_TABLE, and once a second table existed a player could
-- spend their once-per-stay seat change to LEAVE the table that is the game.
-- Every refusal below is read by NAME and by SQLSTATE, and the one that must
-- still fire is paired with the request that must still be taken.
CREATE FUNCTION public.fx_refusal(p_game uuid, p_user uuid, p_to uuid)
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v_msg text; v_state text;
BEGIN
  PERFORM public.fn_cash_seat_change_request(p_game, p_user, p_to);
  RETURN NULL;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || '|' || v_msg;
END $fx$;

DO $$
DECLARE
  v_g uuid; v_feeder uuid; v_main uuid; v_f0 uuid; v_f1 uuid; v_f2 uuid;
  v_r text; v_res jsonb; v_n bigint; q record; v_role text; v_idx integer;
  c_q1 constant uuid := '22220000-0000-0000-0000-000000000001';
  c_q2 constant uuid := '22220000-0000-0000-0000-000000000002';
  c_q3 constant uuid := '22220000-0000-0000-0000-000000000003';
  c_q4 constant uuid := '22220000-0000-0000-0000-000000000004';
  c_q5 constant uuid := '22220000-0000-0000-0000-000000000005';
  c_q6 constant uuid := '22220000-0000-0000-0000-000000000006';
BEGIN
  -- (a) FROM THE FRONT TABLE, ON A FEEDER-FIRST CLUSTER. This is the case
  --     that raised SEAT_CHANGE_NO_OTHER_TABLE before: the from-Main-1 guard
  --     never fired because the player is on a feeder.
  v_g := public.fx_cluster('Door Feeder First', true);
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 'live');
  PERFORM public.fx_seat(v_feeder, c_q1, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('door_feeder_first', v_g, v_feeder);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_feeder THEN
    RAISE EXCEPTION 'FAIL D08a: the feeder is not the front table, so this is not the case under test';
  END IF;
  v_r := public.fx_refusal(v_g, c_q1, NULL);
  IF v_r IS NULL THEN
    RAISE EXCEPTION 'FAIL D08a: a request FROM the table that IS the game was accepted';
  END IF;
  IF position('SEAT_CHANGE_NOT_FROM_MAIN' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08a: the request was refused by something else: %', v_r;
  END IF;
  IF split_part(v_r, '|', 1) IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'FAIL D08a: the refusal came back as SQLSTATE %, not 23514', split_part(v_r, '|', 1);
  END IF;

  -- (b) AND THE ORDINARY MAIN 1 CASE STILL REFUSES. Both, because a door that
  --     only knew about feeders would open the main game to every seat change
  --     on all 108 clusters that have a Main 1.
  v_g := public.fx_cluster('Door Ordinary Board');
  v_main := public.fx_table(v_g, 'main', 1, 'live');
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 'live');
  PERFORM public.fx_seat(v_main, c_q2, 1);
  PERFORM public.fx_seat(v_feeder, c_q3, 1);
  PERFORM public.fx_seat(v_feeder, c_q4, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('door_ordinary', v_g, v_main);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_main THEN
    RAISE EXCEPTION 'FAIL D08b: the ordinary cluster''s front table is not its Main 1';
  END IF;
  v_r := public.fx_refusal(v_g, c_q2, NULL);
  IF v_r IS NULL OR position('SEAT_CHANGE_NOT_FROM_MAIN' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08b: a request from Main 1 answered %', coalesce(v_r, '<accepted>');
  END IF;

  -- (c) TO THE FRONT TABLE. The main game fills in must-move order only.
  v_r := public.fx_refusal(v_g, c_q3, v_main);
  IF v_r IS NULL OR position('SEAT_CHANGE_NEVER_TO_MAIN' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08c: a request TO the main game answered %', coalesce(v_r, '<accepted>');
  END IF;
  IF split_part(v_r, '|', 1) IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'FAIL D08c: the refusal came back as SQLSTATE %, not 23514', split_part(v_r, '|', 1);
  END IF;

  -- (d) NOWHERE ELSE TO GO. The cluster has two live tables and one of them is
  --     the front, so a destination-less request has no candidate at all.
  SELECT count(*) INTO v_n FROM public.tables t
   WHERE t.cluster_id = v_g AND t.lifecycle IN ('live', 'opening') AND coalesce(t.is_deleted, false) = false;
  IF v_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL D08d: the cluster has % live tables, not 2', v_n;
  END IF;
  v_r := public.fx_refusal(v_g, c_q4, NULL);
  IF v_r IS NULL OR position('SEAT_CHANGE_NO_OTHER_TABLE' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08d: a request with nowhere to go answered %', coalesce(v_r, '<accepted>');
  END IF;
  IF (SELECT count(*) FROM public.cash_seat_change_requests q2 WHERE q2.game_id = v_g) IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL D08d: a refused request wrote a row anyway';
  END IF;

  -- (e) AND THE SAME REQUEST IS TAKEN THE MOMENT THERE IS SOMEWHERE TO GO.
  --     Without this half, a door that refused everything would be green.
  v_f2 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_main THEN
    RAISE EXCEPTION 'FAIL D08e: opening a second feeder moved the front table';
  END IF;
  v_res := public.fn_cash_seat_change_request(v_g, c_q4, NULL);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL D08e: the same request was still refused once a second non-front table existed';
  END IF;
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE game_id = v_g AND user_id = c_q4;
  IF q.id IS DISTINCT FROM (v_res->>'request_id')::uuid THEN
    RAISE EXCEPTION 'FAIL D08e: the accepted request did not write the row it returned';
  END IF;
  IF q.from_table_id IS DISTINCT FROM v_feeder OR q.to_table_id IS DISTINCT FROM NULL
     OR q.status IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'FAIL D08e: the accepted request reads (from %, to %, status %)',
      coalesce(q.from_table_id::text, '<null>'), coalesce(q.to_table_id::text, '<null>'), coalesce(q.status, '<null>');
  END IF;
  IF (SELECT ro.seat_change_used_at FROM public.cash_game_roster ro
       WHERE ro.game_id = v_g AND ro.user_id = c_q4 AND ro.left_at IS NULL) IS NULL THEN
    RAISE EXCEPTION 'FAIL D08e: the accepted request did not spend the once-per-stay allowance';
  END IF;

  -- (f) AND THE SAME TWO REFUSALS ON A FEEDER-FIRST CLUSTER, WHERE THE FRONT
  --     TABLE IS NOT A MAIN 1 AT ALL. (c) and (d) above ask an ordinary board,
  --     where `dst.role = 'main' AND dst.main_index = 1` and the front table
  --     are the same table and every answer is the same either way: they are
  --     the rule-5 half that pins the 108 clusters that have a Main 1, and on
  --     their own they cannot tell the migration's edit from its absence. Here
  --     the front table is a FEEDER, so the predicate that was there before
  --     would let a player walk off the only game there is, and both of these
  --     are the edit or nothing.
  v_g := public.fx_cluster('Door Feeder Pair', true);
  v_f0 := public.fx_table(v_g, 'feeder', NULL, 'live');
  v_f1 := public.fx_table(v_g, 'feeder', NULL, 'live');
  PERFORM public.fx_seat(v_f1, c_q5, 1);
  PERFORM public.fx_seat(v_f1, c_q6, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('door_feeder_pair', v_g, v_f0);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_f0 THEN
    RAISE EXCEPTION 'FAIL D08f: the oldest live feeder is not the front table';
  END IF;
  SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t WHERE t.id = v_f0;
  IF v_role IS DISTINCT FROM 'feeder' OR v_idx IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL D08f: the front table is (role %, main_index %), so the predicate the migration replaced would have caught it anyway',
      coalesce(v_role, '<null>'), coalesce(v_idx::text, '<null>');
  END IF;

  v_r := public.fx_refusal(v_g, c_q5, v_f0);
  IF v_r IS NULL OR position('SEAT_CHANGE_NEVER_TO_MAIN' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08f: a request TO the feeder that IS the game answered %', coalesce(v_r, '<accepted>');
  END IF;
  IF split_part(v_r, '|', 1) IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'FAIL D08f: the refusal came back as SQLSTATE %, not 23514', split_part(v_r, '|', 1);
  END IF;

  v_r := public.fx_refusal(v_g, c_q6, NULL);
  IF v_r IS NULL OR position('SEAT_CHANGE_NO_OTHER_TABLE' in v_r) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL D08f: a destination-less request whose only other live table is the game answered %',
      coalesce(v_r, '<accepted>');
  END IF;

  -- PAIRED WITH BOTH ACCEPTS: a third table is not the front, so the
  -- destination-less request and the request that names that table are each
  -- taken.
  v_f2 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_f0 THEN
    RAISE EXCEPTION 'FAIL D08f: opening a third feeder moved the front table';
  END IF;
  v_res := public.fn_cash_seat_change_request(v_g, c_q6, NULL);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL D08f: the destination-less request was still refused once a non-front table existed';
  END IF;
  v_res := public.fn_cash_seat_change_request(v_g, c_q5, v_f2);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb OR (v_res->>'to_table_id')::uuid IS DISTINCT FROM v_f2 THEN
    RAISE EXCEPTION 'FAIL D08f: a request naming a table that is not the front was refused';
  END IF;
END $$;
\echo '  ok  SEAT-CHANGE DOOR  a request FROM the front table is refused SEAT_CHANGE_NOT_FROM_MAIN on a feeder-first cluster and on an ordinary Main 1 alike, a request TO the front table is refused SEAT_CHANGE_NEVER_TO_MAIN and a destination-less request whose only other live table is the front is refused SEAT_CHANGE_NO_OTHER_TABLE and writes nothing - each asked of an ordinary board AND of a feeder-first one where the front table is a feeder and neither refusal could have come from the predicate that was there before - and every one of them is paired with the same request being accepted and spending the allowance the moment a non-front table exists'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE SEAT-CHANGE PLANNER (P09) ----------------------------------------------
-- The planner cancels a request from a table that became the main game, and
-- refuses to route anyone ONTO the main game. On a feeder-first Cluster
-- neither fired, so the planner would seat a player onto the front table out
-- of must-move order - the one thing "the main game fills in must-move order
-- only" forbids.
--
-- Every board here is FEEDER-FIRST on purpose. On a cluster that has a Main 1
-- the old predicate and the new one give the same answer, so an assertion made
-- there would stay green with either, and deleting the substitution would be
-- invisible.
DO $$
DECLARE
  v_g uuid; f0 uuid; f1 uuid; f2 uuid; v_req uuid; v_planned integer; q record; v_n bigint;
  c_r1 constant uuid := '33330000-0000-0000-0000-000000000001';
  c_r2 constant uuid := '33330000-0000-0000-0000-000000000002';
  c_r3 constant uuid := '33330000-0000-0000-0000-000000000003';
BEGIN
  -- (a) A REQUEST FROM THE TABLE THAT IS NOW THE GAME COMES BACK.
  v_g := public.fx_cluster('Planner Cancels On The Front Table', true);
  f0 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  f1 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  PERFORM public.fx_seat(f0, c_r1, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('plan_cancel', v_g, f0);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id, to_table_id)
  VALUES (v_g, c_r1, f0, NULL) RETURNING id INTO v_req;
  UPDATE public.cash_game_roster SET seat_change_used_at = clock_timestamp()
   WHERE game_id = v_g AND user_id = c_r1;

  -- NON-VACUITY: the request is open, the allowance is spent, the table they
  -- asked from IS the front table, and there is an empty table to route them
  -- to - so a planner that did not cancel would plan a move rather than do
  -- nothing, and "no move was planned" is a real statement.
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE id = v_req;
  IF q.status IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'FAIL P09a: the request is % before the plan runs', coalesce(q.status, '<null>');
  END IF;
  IF (SELECT ro.seat_change_used_at FROM public.cash_game_roster ro
       WHERE ro.game_id = v_g AND ro.user_id = c_r1) IS NULL THEN
    RAISE EXCEPTION 'FAIL P09a: the allowance is not spent before the plan runs, so "it came back" says nothing';
  END IF;
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM f0 THEN
    RAISE EXCEPTION 'FAIL P09a: the table the request was listed from is not the front table';
  END IF;
  IF (SELECT c.open_unreserved FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = f1) < 1 THEN
    RAISE EXCEPTION 'FAIL P09a: the other table has no open seat, so a planner that ignored the cancel would also plan nothing';
  END IF;

  v_planned := public.fn_cash_seat_change_plan(v_g, clock_timestamp());
  IF v_planned IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL P09a: the planner planned % move(s) for a request off the main game', v_planned;
  END IF;
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE id = v_req;
  IF q.status IS DISTINCT FROM 'cancelled' OR q.note IS DISTINCT FROM 'now_on_main_one' THEN
    RAISE EXCEPTION 'FAIL P09a: the request reads (status %, note %) and should be (cancelled, now_on_main_one)',
      coalesce(q.status, '<null>'), coalesce(q.note, '<null>');
  END IF;
  IF (SELECT ro.seat_change_used_at FROM public.cash_game_roster ro
       WHERE ro.game_id = v_g AND ro.user_id = c_r1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P09a: the once-per-stay allowance was spent on a change the game cancelled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_r1) THEN
    RAISE EXCEPTION 'FAIL P09a: the planner moved a player off the table that is the game';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                  WHERE e.game_id = v_g AND e.kind = 'seat_change_returned'
                    AND e.payload->>'reason' = 'now_on_main_one') THEN
    RAISE EXCEPTION 'FAIL P09a: no seat_change_returned event names now_on_main_one';
  END IF;

  -- (b) AND IT NEVER ROUTES ANYONE ONTO THE FRONT TABLE - while still routing
  --     them somewhere. The front table here is EMPTIER than the legal
  --     destination, so the planner's own ORDER BY c.seated would have chosen
  --     it if the filter let it through.
  v_g := public.fx_cluster('Planner Never Routes Onto The Front', true);
  f0 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  f1 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  f2 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  PERFORM public.fx_seat(f1, c_r2, 1);
  PERFORM public.fx_seat(f2, c_r3, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('plan_target', v_g, f2);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id, to_table_id)
  VALUES (v_g, c_r2, f1, NULL) RETURNING id INTO v_req;
  UPDATE public.cash_game_roster SET seat_change_used_at = clock_timestamp()
   WHERE game_id = v_g AND user_id = c_r2;

  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM f0 THEN
    RAISE EXCEPTION 'FAIL P09b: the oldest live feeder is not the front table';
  END IF;
  IF (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = f0)
     >= (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = f2) THEN
    RAISE EXCEPTION 'FAIL P09b: the front table is not the emptiest candidate, so the planner would not have chosen it anyway';
  END IF;

  v_planned := public.fn_cash_seat_change_plan(v_g, clock_timestamp());
  IF v_planned IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL P09b: the planner planned % move(s) where exactly one seat was open off the front table', v_planned;
  END IF;
  IF (SELECT m.to_table_id FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_r2)
     IS DISTINCT FROM f2 THEN
    RAISE EXCEPTION 'FAIL P09b: the planner routed the player to % and the only table that is not the front is %',
      coalesce((SELECT m.to_table_id::text FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_r2), '<none>'), f2;
  END IF;
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE id = v_req;
  IF q.status IS DISTINCT FROM 'moved' THEN
    RAISE EXCEPTION 'FAIL P09b: the accepted request reads status %', coalesce(q.status, '<null>');
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_events e
   WHERE e.game_id = v_g AND e.kind = 'move_planned';
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL P09b: the planner logged % move_planned events, not 1', v_n;
  END IF;
END $$;

-- (c) THE SWAP HALF. Every table is full, so the planner falls through to the
--     swap and looks for a partner whose chair it can take. The front table's
--     own request is OLDER than the legal partner's, so the planner's ORDER BY
--     would have chosen it - and would have swapped a player ONTO the main
--     game out of must-move order.
DO $$
DECLARE
  v_g uuid; g0 uuid; g1 uuid; g2 uuid; v_planned integer; v_n bigint;
  ma record; mb record; q record;
  c_s0 constant uuid := '44440000-0000-0000-0000-000000000000';
  c_s1 constant uuid := '44440000-0000-0000-0000-000000000001';
  c_s2 constant uuid := '44440000-0000-0000-0000-000000000002';
BEGIN
  v_g := public.fx_cluster('Planner Never Swaps With The Front', true);
  g0 := public.fx_table(v_g, 'feeder', NULL, 'live', 2);
  g1 := public.fx_table(v_g, 'feeder', NULL, 'live', 2);
  g2 := public.fx_table(v_g, 'feeder', NULL, 'live', 2);
  PERFORM public.fx_seat(g0, c_s0, 1);
  PERFORM public.fx_seat(g0, '44440000-0000-0000-0000-0000000000a0'::uuid, 2);
  PERFORM public.fx_seat(g1, c_s1, 1);
  PERFORM public.fx_seat(g1, '44440000-0000-0000-0000-0000000000a1'::uuid, 2);
  PERFORM public.fx_seat(g2, c_s2, 1);
  PERFORM public.fx_seat(g2, '44440000-0000-0000-0000-0000000000a2'::uuid, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('plan_swap', v_g, g0);

  -- The order the three requests are written in is the order the planner reads
  -- them: the requester first, then the FRONT table's request, then the legal
  -- partner's.
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id) VALUES (v_g, c_s1, g1);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id) VALUES (v_g, c_s0, g0);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id) VALUES (v_g, c_s2, g2);
  UPDATE public.cash_game_roster SET seat_change_used_at = clock_timestamp()
   WHERE game_id = v_g AND user_id IN (c_s0, c_s1, c_s2);

  -- NON-VACUITY: no table has an open seat, so the target branch above cannot
  -- be what answers; the front table is g0; and g0's request is older than
  -- g2's, so the planner's ORDER BY q.created_at prefers it.
  SELECT count(*) INTO v_n FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.open_unreserved > 0;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL P09c: % table(s) still have an open seat, so the swap branch is not what runs', v_n;
  END IF;
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM g0 THEN
    RAISE EXCEPTION 'FAIL P09c: the oldest live feeder is not the front table';
  END IF;
  IF (SELECT q2.created_at FROM public.cash_seat_change_requests q2 WHERE q2.game_id = v_g AND q2.user_id = c_s0)
     >= (SELECT q2.created_at FROM public.cash_seat_change_requests q2 WHERE q2.game_id = v_g AND q2.user_id = c_s2) THEN
    RAISE EXCEPTION 'FAIL P09c: the front table''s request is not the older candidate, so skipping it proves nothing';
  END IF;

  v_planned := public.fn_cash_seat_change_plan(v_g, clock_timestamp());
  IF v_planned IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL P09c: the planner planned % move(s) where a swap is two', v_planned;
  END IF;
  SELECT * INTO ma FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_s1;
  SELECT * INTO mb FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_s2;
  IF ma.to_table_id IS DISTINCT FROM g2 THEN
    RAISE EXCEPTION 'FAIL P09c: the requester was swapped onto % and the only table that is not the front is %',
      coalesce(ma.to_table_id::text, '<no move>'), g2;
  END IF;
  IF mb.to_table_id IS DISTINCT FROM g1 THEN
    RAISE EXCEPTION 'FAIL P09c: the partner was not swapped onto the requester''s table';
  END IF;
  IF ma.swap_move_id IS DISTINCT FROM mb.id OR mb.swap_move_id IS DISTINCT FROM ma.id THEN
    RAISE EXCEPTION 'FAIL P09c: the two halves of the swap do not name each other';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_s0) THEN
    RAISE EXCEPTION 'FAIL P09c: a player was swapped off the table that is the game';
  END IF;
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE game_id = v_g AND user_id = c_s0;
  IF q.status IS DISTINCT FROM 'cancelled' OR q.note IS DISTINCT FROM 'now_on_main_one' THEN
    RAISE EXCEPTION 'FAIL P09c: the front table''s own request reads (status %, note %)',
      coalesce(q.status, '<null>'), coalesce(q.note, '<null>');
  END IF;
END $$;
\echo '  ok  SEAT-CHANGE PLAN  a request listed from the table that is now the front is cancelled with note now_on_main_one and its once-per-stay allowance comes back with no move planned, the planner routes a player onto the only non-front table even though the front is emptier, and with every table full it swaps with the non-front partner rather than the older request from the front'

-- THE BREAK CANDIDATE (B10) --------------------------------------------------
-- The BREAK step picks a candidate `WHERE NOT (c.role = 'main' AND
-- c.main_index = 1)`, which on a feeder-first Cluster admits the one table the
-- game has. It is saved today only by the NEXT guard, `IF v_remaining_tables
-- >= 1`, which is false when there is nothing else left. Being saved by a
-- different clause than the one written for the job is not a rule.
DO $$
DECLARE
  v_g uuid; v_m uuid; v_f uuid; v_res jsonb; v_cand uuid; v_n bigint; v_role text; v_idx integer;
  c_u1 constant uuid := '55550000-0000-0000-0000-000000000001';
  c_u2 constant uuid := '55550000-0000-0000-0000-000000000002';
  c_u3 constant uuid := '55550000-0000-0000-0000-000000000003';
BEGIN
  -- (a) A FRONT TABLE AND ONE OTHER LIVE TABLE: the candidate is the other
  --     one. The front table is EMPTIER, so the step's own ORDER BY c.seated
  --     would have chosen it if the filter let it through.
  v_g := public.fx_cluster('Break Candidate Ordinary');
  v_m := public.fx_table(v_g, 'main', 1, 'live', 9);
  v_f := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  PERFORM public.fx_seat(v_f, c_u1, 1);
  PERFORM public.fx_seat(v_f, c_u2, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('break_ordinary', v_g, v_f);
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_m THEN
    RAISE EXCEPTION 'FAIL B10a: the ordinary cluster''s front table is not its Main 1';
  END IF;
  IF (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = v_m)
     >= (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = v_f) THEN
    RAISE EXCEPTION 'FAIL B10a: the front table is not the thinner one, so sparing it proves nothing';
  END IF;

  v_res := public.fn_cash_cluster_tick(v_g, 0);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL B10a: the tick answered %', coalesce(v_res::text, '<null>');
  END IF;
  SELECT (a->>'break_candidate')::uuid INTO v_cand
    FROM jsonb_array_elements(v_res->'actions') a WHERE a ? 'break_candidate';
  IF v_cand IS DISTINCT FROM v_f THEN
    RAISE EXCEPTION 'FAIL B10a: the break candidate is % and the one table that is not the game is %',
      coalesce(v_cand::text, '<none>'), v_f;
  END IF;

  -- (b) AND A CLUSTER WHOSE ONLY LIVE TABLE IS THE FRONT HAS NO CANDIDATE AT
  --     ALL. Without (a) this would be satisfied by a step that never names
  --     one.
  v_g := public.fx_cluster('Break Candidate Feeder First', true);
  v_f := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  PERFORM public.fx_seat(v_f, c_u3, 1);
  INSERT INTO board (k, game_id, table_id) VALUES ('break_feeder_first', v_g, v_f);

  v_res := public.fn_cash_cluster_tick(v_g, 0);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL B10b: the tick answered %', coalesce(v_res::text, '<null>');
  END IF;
  -- NON-VACUITY: exactly one live table, it IS the front, it is live, and the
  -- tick left it a feeder - so the predicate the migration replaced would have
  -- admitted it and named it the candidate.
  SELECT count(*) INTO v_n FROM public.tables t
   WHERE t.cluster_id = v_g AND t.lifecycle = 'live' AND coalesce(t.is_deleted, false) = false;
  IF v_n IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL B10b: the feeder-first cluster has % live tables, not 1', v_n;
  END IF;
  IF public.fn_cash_cluster_front_table(v_g) IS DISTINCT FROM v_f THEN
    RAISE EXCEPTION 'FAIL B10b: the one live table is not the front table';
  END IF;
  SELECT t.role, t.main_index INTO v_role, v_idx FROM public.tables t WHERE t.id = v_f;
  IF v_role IS DISTINCT FROM 'feeder' OR v_idx IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL B10b: the tick promoted the lone feeder to (role %, main_index %), so the old predicate would have spared it anyway',
      coalesce(v_role, '<null>'), coalesce(v_idx::text, '<null>');
  END IF;

  SELECT count(*) INTO v_n FROM jsonb_array_elements(v_res->'actions') a WHERE a ? 'break_candidate';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL B10b: the break step named % candidate(s) on a cluster whose only live table is the game itself', v_n;
  END IF;
END $$;
\echo '  ok  BREAK CANDIDATE   on a cluster with a front table and one other live table the candidate is the other one even though the front is thinner, and on a feeder-first cluster whose one live table is the front there is no candidate at all'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- ONE READ, NOT ONE PER ROW (O13) --------------------------------------------
-- Both hot scans walk unnest(v_census), and PostgreSQL does not cache a STABLE
-- call across the rows of a scan even when its argument is constant for the
-- whole scan - so a front-table call left inside either predicate is one index
-- lookup per census row, per request, on a tick that runs every five seconds
-- for every Cluster. Read out of the catalogue after the apply, because what
-- the migration sent and what the database kept are different questions.
DO $$
DECLARE
  v_pln text; v_tck text; v_lob text; v_n integer;
  c_call constant text := 'public.fn_cash_cluster_front_table(';
  c_used constant text := 'c.id IS DISTINCT FROM v_front';
BEGIN
  v_pln := pg_get_functiondef('public.fn_cash_seat_change_plan(uuid,timestamp with time zone)'::regprocedure);
  v_tck := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_lob := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);

  v_n := (length(v_pln) - length(replace(v_pln, c_call, ''))) / length(c_call);
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL O13: the live planner calls the front table % time(s) and it is written to read it once', v_n;
  END IF;
  IF position('  v_front := public.fn_cash_cluster_front_table(p_game_id);' in v_pln) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL O13: the live planner''s one call is not the hoisted assignment';
  END IF;
  IF position('c.id = v_front) THEN' in v_pln) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL O13: the live planner''s became-front test does not read the local it assigned';
  END IF;
  v_n := (length(v_pln) - length(replace(v_pln, c_used, ''))) / length(c_used);
  IF v_n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL O13: the live planner judges % destination filter(s) against the local it read, not 2', v_n;
  END IF;

  v_n := (length(v_tck) - length(replace(v_tck, c_call, ''))) / length(c_call);
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL O13: the live tick calls the front table % time(s) and it is written to read it once', v_n;
  END IF;
  IF position('  v_front := public.fn_cash_cluster_front_table(g.id);' in v_tck) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL O13: the live tick''s one call is not the hoisted assignment';
  END IF;
  IF position(c_used || ' AND c.lifecycle = ''live''' in v_tck) IS NOT DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL O13: the live break candidate does not read the local the tick assigned';
  END IF;

  -- NON-VACUITY: "exactly one" is not a statement about a string that barely
  -- occurs. The lobby calls the same function by the same spelling three
  -- times, on purpose, and it is read out of the same catalogue here.
  v_n := (length(v_lob) - length(replace(v_lob, c_call, ''))) / length(c_call);
  IF v_n < 2 THEN
    RAISE EXCEPTION 'FAIL O13: the lobby calls the front table % time(s), so counting calls measures almost nothing', v_n;
  END IF;
END $$;
\echo '  ok  ONE READ          the live planner and the live tick each call fn_cash_cluster_front_table exactly once, as a hoisted local that all three planner predicates and the break candidate then read, while the lobby still calls it three times so that counting calls is a real measurement'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE HOISTED ANSWER IS THE SAME ANSWER (H14) --------------------------------
-- A hoist is only safe where it is put. The tick's ROLES step WRITES to
-- public.tables, so a Cluster can have one front table before it runs and a
-- different one after; the assignment therefore has to land where the inline
-- call it replaced was evaluated - after ROLES and immediately above the
-- candidate scan - and not a few lines earlier, where it would read the board
-- the tick is about to change.
DO $$
DECLARE
  v_g uuid; v_f uuid; v_m uuid; v_res jsonb; v_cand uuid;
  v_front_before uuid; v_front_after uuid; v_idx integer;
  c_h1 constant uuid := '66660000-0000-0000-0000-000000000001';
  c_h2 constant uuid := '66660000-0000-0000-0000-000000000002';
BEGIN
  -- An older live FEEDER and a newer live MAIN 2, which is the board the ROLES
  -- step renumbers: no Main 1 before the tick, one after.
  v_g := public.fx_cluster('Hoist Reads The Board ROLES Left');
  v_f := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  v_m := public.fx_table(v_g, 'main', 2, 'live', 9);
  PERFORM public.fx_seat(v_f, c_h1, 1);
  PERFORM public.fx_seat(v_f, c_h2, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('hoist_tick', v_g, v_f);

  v_front_before := public.fn_cash_cluster_front_table(v_g);
  IF v_front_before IS DISTINCT FROM v_f THEN
    RAISE EXCEPTION 'FAIL H14: before the tick the front table is % and the oldest live table is %',
      coalesce(v_front_before::text, '<null>'), v_f;
  END IF;
  IF (SELECT t.main_index FROM public.tables t WHERE t.id = v_m) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL H14: the main is not at index 2, so the ROLES step has nothing to renumber';
  END IF;
  -- The main is the THINNER table, so a candidate scan reading the pre-ROLES
  -- board - or the stale census the step is handed - would choose it.
  IF (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = v_m)
     >= (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = v_f) THEN
    RAISE EXCEPTION 'FAIL H14: the main is not the thinner table, so a wrongly placed hoist would answer the same';
  END IF;

  v_res := public.fn_cash_cluster_tick(v_g, 0);
  IF v_res->'ok' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL H14: the tick answered %', coalesce(v_res::text, '<null>');
  END IF;

  -- THE FRONT TABLE MOVED DURING THE CALL. Without this the section is a
  -- statement about a board that never changes.
  SELECT t.main_index INTO v_idx FROM public.tables t WHERE t.id = v_m;
  IF v_idx IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL H14: the ROLES step left the main at index %, so the front table did not move',
      coalesce(v_idx::text, '<null>');
  END IF;
  v_front_after := public.fn_cash_cluster_front_table(v_g);
  IF v_front_after IS DISTINCT FROM v_m OR v_front_after IS NOT DISTINCT FROM v_front_before THEN
    RAISE EXCEPTION 'FAIL H14: after the tick the front table is % and it was % before',
      coalesce(v_front_after::text, '<null>'), coalesce(v_front_before::text, '<null>');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                  WHERE e.game_id = v_g AND e.kind = 'main_renumbered') THEN
    RAISE EXCEPTION 'FAIL H14: the tick logged no main_renumbered, so nothing wrote to public.tables mid-call';
  END IF;

  -- AND THE CANDIDATE IS THE ONE THE POST-ROLES BOARD IMPLIES. The pre-hoist
  -- body called the front table here, so this is the answer it gave.
  SELECT (a->>'break_candidate')::uuid INTO v_cand
    FROM jsonb_array_elements(v_res->'actions') a WHERE a ? 'break_candidate';
  IF v_cand IS DISTINCT FROM v_f THEN
    RAISE EXCEPTION 'FAIL H14: the break candidate is % and the table that is not the front table the ROLES step made is %',
      coalesce(v_cand::text, '<none>'), v_f;
  END IF;
END $$;

-- AND ONE READ SERVES EVERY REQUEST IN THE CALL. The planner writes no
-- public.tables row, so its front table cannot move under it - which is what
-- makes one read at the top equal to one read per request, and what this half
-- measures: a call that plans one move and cancels one request, both judged
-- against the same table.
DO $$
DECLARE
  v_g uuid; j0 uuid; j1 uuid; j2 uuid; v_planned integer;
  v_front_before uuid; v_front_after uuid; v_n bigint; q record;
  c_w0 constant uuid := '77770000-0000-0000-0000-000000000000';
  c_w1 constant uuid := '77770000-0000-0000-0000-000000000001';
  c_w2 constant uuid := '77770000-0000-0000-0000-000000000002';
  c_w3 constant uuid := '77770000-0000-0000-0000-000000000003';
BEGIN
  v_g := public.fx_cluster('Hoist Is One Read For Every Request', true);
  j0 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  j1 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  j2 := public.fx_table(v_g, 'feeder', NULL, 'live', 9);
  PERFORM public.fx_seat(j0, c_w0, 1);
  PERFORM public.fx_seat(j1, c_w1, 1);
  PERFORM public.fx_seat(j2, c_w2, 1);
  PERFORM public.fx_seat(j2, c_w3, 2);
  INSERT INTO board (k, game_id, table_id) VALUES ('hoist_plan', v_g, j0);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id) VALUES (v_g, c_w1, j1);
  INSERT INTO public.cash_seat_change_requests (game_id, user_id, from_table_id) VALUES (v_g, c_w0, j0);
  UPDATE public.cash_game_roster SET seat_change_used_at = clock_timestamp()
   WHERE game_id = v_g AND user_id IN (c_w0, c_w1);

  v_front_before := public.fn_cash_cluster_front_table(v_g);
  IF v_front_before IS DISTINCT FROM j0 THEN
    RAISE EXCEPTION 'FAIL H14b: the oldest live feeder is not the front table';
  END IF;
  -- NON-VACUITY: two requests, and the front table is the emptiest candidate,
  -- so a call that lost the local for either iteration would route onto it.
  SELECT count(*) INTO v_n FROM public.cash_seat_change_requests
   WHERE game_id = v_g AND status = 'requested';
  IF v_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL H14b: the board carries % open request(s), not the two this half is about', v_n;
  END IF;
  IF (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = j0)
     >= (SELECT c.seated FROM unnest(public.fn_cash_cluster_census(v_g)) c WHERE c.id = j2) THEN
    RAISE EXCEPTION 'FAIL H14b: the front table is not the emptiest candidate';
  END IF;

  v_planned := public.fn_cash_seat_change_plan(v_g, clock_timestamp());
  v_front_after := public.fn_cash_cluster_front_table(v_g);
  IF v_front_after IS DISTINCT FROM v_front_before THEN
    RAISE EXCEPTION 'FAIL H14b: the planner moved the front table under itself, so one read cannot equal one read per request';
  END IF;
  IF v_planned IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL H14b: the planner planned % move(s) where one request was routable and one was off the front', v_planned;
  END IF;

  -- UNIFORMLY, ACROSS BOTH ITERATIONS: every move it planned goes somewhere
  -- that is not the front table, and every request it cancelled came off it.
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m
              WHERE m.game_id = v_g AND m.to_table_id IS NOT DISTINCT FROM v_front_before) THEN
    RAISE EXCEPTION 'FAIL H14b: the planner routed somebody onto the front table';
  END IF;
  IF (SELECT m.to_table_id FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_w1)
     IS DISTINCT FROM j2 THEN
    RAISE EXCEPTION 'FAIL H14b: the routable request did not land on the one table that is neither its own nor the front';
  END IF;
  SELECT * INTO q FROM public.cash_seat_change_requests WHERE game_id = v_g AND user_id = c_w0;
  IF q.status IS DISTINCT FROM 'cancelled' OR q.note IS DISTINCT FROM 'now_on_main_one'
     OR q.from_table_id IS DISTINCT FROM v_front_before THEN
    RAISE EXCEPTION 'FAIL H14b: the request off the front table reads (status %, note %)',
      coalesce(q.status, '<null>'), coalesce(q.note, '<null>');
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.player_id = c_w0) THEN
    RAISE EXCEPTION 'FAIL H14b: the player on the front table was moved anyway';
  END IF;
END $$;
\echo '  ok  HOISTED ANSWER    the tick reads the front table after the ROLES step has moved it and names the candidate the post-ROLES board implies rather than the thinner table the pre-ROLES board would have offered, and one planner read serves a call that plans one move onto a non-front table and cancels one request that came off the front'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- The preimage of the re-apply: the exact text of every function the migration
-- creates or patches, the trigger it installs, and the shape of the estate it
-- must not touch.
CREATE TEMP TABLE pre_reapply_fn AS
  SELECT x.fn,
         pg_get_functiondef(x.fn::regprocedure) AS def
    FROM unnest(ARRAY[
      'public.fn_cash_cluster_front_table(uuid)',
      'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)',
      'public.fn_cash_game_lobby(uuid)',
      'public.fn_cash_seat_change_request(uuid,uuid,uuid)',
      'public.fn_cash_seat_change_plan(uuid,timestamp with time zone)',
      'public.fn_cash_cluster_tick(uuid,integer)']) AS x(fn);

CREATE TEMP TABLE pre_reapply_trg AS
  SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.cash_games'::regclass
     AND t.tgname = 'trg_cash_games_epoch_follows_its_game'
     AND NOT t.tgisinternal;

CREATE TEMP TABLE pre_reapply_epochs   AS SELECT * FROM public.cash_cluster_epoch;
CREATE TEMP TABLE pre_reapply_tables   AS SELECT * FROM public.tables;
CREATE TEMP TABLE pre_reapply_games    AS SELECT * FROM public.cash_games;
CREATE TEMP TABLE pre_reapply_requests AS SELECT * FROM public.cash_seat_change_requests;
CREATE TEMP TABLE pre_reapply_moves    AS SELECT * FROM public.cash_seat_moves;
CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM public.cash_games)                AS games,
         (SELECT count(*) FROM public.tables)                    AS tables_,
         (SELECT count(*) FROM public.cash_cluster_epoch)         AS epochs,
         (SELECT count(*) FROM public.cash_cluster_events)        AS events,
         (SELECT count(*) FROM public.cash_seat_change_requests)  AS requests,
         (SELECT count(*) FROM public.cash_seat_moves)            AS moves,
         (SELECT count(*) FROM pre_reapply_fn)                    AS fns,
         (SELECT count(*) FROM pre_reapply_trg)                   AS trgs;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- IDEMPOTENT RE-APPLY --------------------------------------------------------
-- Reaching this file at all means the second psql -f of the migration exited 0
-- under ON_ERROR_STOP; what is left is that it changed nothing. That is a
-- sharper question here than in a schema migration: FIVE of these six
-- functions are patched by SUBSTITUTION against whatever is installed, so a
-- second application that did not take its early-return NOTICE would patch an
-- already-patched body - doubling a branch, or failing an anchor count - and a
-- harness that only asked "did it exit 0" would not see the difference.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE; v_bad text;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.games IS NULL THEN RAISE EXCEPTION 'FAIL re-apply: the pre-re-apply capture is empty'; END IF;
  -- Non-vacuity: there is an estate to leave alone, six bodies and one trigger
  -- to compare, and rows in every relation the migration could have moved.
  IF c.games < 25::bigint OR c.tables_ < 30::bigint OR c.epochs < 25::bigint
     OR LEAST(c.events, c.requests, c.moves) < 1::bigint THEN
    RAISE EXCEPTION 'FAIL re-apply: the estate is too thin before the re-apply (games % / tables % / epochs % / events % / requests % / moves %), so "nothing moved" compares almost nothing',
      c.games, c.tables_, c.epochs, c.events, c.requests, c.moves;
  END IF;
  IF c.fns IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL re-apply: % function bodies were captured, not 6', c.fns;
  END IF;
  IF c.trgs IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL re-apply: % epoch trigger(s) were captured, not 1', c.trgs;
  END IF;

  -- THE FIVE PATCHED BODIES AND THE ONE RE-CREATED ONE, BYTE FOR BYTE.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE pg_get_functiondef(p.fn::regprocedure) IS DISTINCT FROM p.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL re-apply: the second application changed the body of %', v_bad;
  END IF;

  -- AND THE TRIGGER, which the migration DROPs and CREATEs unconditionally.
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.cash_games'::regclass
         AND t.tgname = 'trg_cash_games_epoch_follows_its_game' AND NOT t.tgisinternal)
     IS DISTINCT FROM (SELECT p.def FROM pre_reapply_trg p) THEN
    RAISE EXCEPTION 'FAIL re-apply: the epoch trigger was re-created differently on the second application';
  END IF;

  -- THE GENESIS BACKFILL RAN AGAIN AND ADDED NOTHING. ON CONFLICT DO NOTHING
  -- is what makes it re-runnable; with the WRONG conflict target it would
  -- insert a second genesis row for every cluster that has since moved epoch,
  -- and this harness has three of those.
  IF (SELECT count(*) FROM public.cash_cluster_epoch) IS DISTINCT FROM c.epochs THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_epoch went from % rows to %', c.epochs,
      (SELECT count(*) FROM public.cash_cluster_epoch);
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_epochs EXCEPT SELECT * FROM public.cash_cluster_epoch)
     OR EXISTS (SELECT * FROM public.cash_cluster_epoch EXCEPT SELECT * FROM pre_reapply_epochs) THEN
    RAISE EXCEPTION 'FAIL re-apply: an epoch row changed on the second application, so a finished epoch''s mode, reason or start is not durable';
  END IF;

  -- And nothing else moved either: not one column of one row.
  IF EXISTS (SELECT * FROM pre_reapply_games EXCEPT SELECT * FROM public.cash_games)
     OR EXISTS (SELECT * FROM public.cash_games EXCEPT SELECT * FROM pre_reapply_games) THEN
    RAISE EXCEPTION 'FAIL re-apply: a cash_games row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_tables EXCEPT SELECT * FROM public.tables)
     OR EXISTS (SELECT * FROM public.tables EXCEPT SELECT * FROM pre_reapply_tables) THEN
    RAISE EXCEPTION 'FAIL re-apply: a tables row changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_requests EXCEPT SELECT * FROM public.cash_seat_change_requests)
     OR EXISTS (SELECT * FROM public.cash_seat_change_requests EXCEPT SELECT * FROM pre_reapply_requests) THEN
    RAISE EXCEPTION 'FAIL re-apply: a seat change request changed on the second application'; END IF;
  IF EXISTS (SELECT * FROM pre_reapply_moves EXCEPT SELECT * FROM public.cash_seat_moves)
     OR EXISTS (SELECT * FROM public.cash_seat_moves EXCEPT SELECT * FROM pre_reapply_moves) THEN
    RAISE EXCEPTION 'FAIL re-apply: a planned move changed on the second application'; END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events) IS DISTINCT FROM c.events THEN
    RAISE EXCEPTION 'FAIL re-apply: cash_cluster_events went from % rows to %', c.events,
      (SELECT count(*) FROM public.cash_cluster_events); END IF;

  -- And the behaviour is still there after the second pass, asked of the one
  -- board that only the new definition can answer.
  IF (SELECT public.fn_cash_cluster_front_table(b.game_id) FROM board b WHERE b.k = 'lobby_feeder_first')
     IS DISTINCT FROM (SELECT b.table_id FROM board b WHERE b.k = 'lobby_feeder_first') THEN
    RAISE EXCEPTION 'FAIL re-apply: the feeder-first cluster lost its front table on the second application';
  END IF;
END $$;

-- AND THE TRIGGER STILL FIRES. A DROP/CREATE pair that left the trigger
-- disabled, or on the wrong events, would survive every text comparison above.
DO $$
DECLARE v_gid uuid; v_e record;
BEGIN
  v_gid := public.fx_cluster('Epoch Genesis After Re-apply', false, 'paused', 7,
                             timestamptz '2026-07-07 07:07:07+00');
  SELECT * INTO v_e FROM public.cash_cluster_epoch WHERE cluster_id = v_gid;
  IF v_e.epoch IS DISTINCT FROM 7 OR v_e.mode IS DISTINCT FROM 'paused'
     OR v_e.started_by IS DISTINCT FROM 'genesis' OR v_e.ended_at IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL re-apply: a Cluster created after the second application has no correct genesis epoch row';
  END IF;
END $$;
\echo '  ok  RE-APPLY          the migration applied a second time left all six function bodies and the epoch trigger definition byte-identical, added no epoch row, moved no cash_games tables cash_seat_change_requests or cash_seat_moves row, and the re-created trigger still writes the genesis epoch of a Cluster born after it'
REAPPLY

# ONE psql session, nine files: the pre-migration schema and bodies, the three
# real migrations this one sits on top of, the window in which nothing
# maintained the epoch, the migration, the assertions, the migration AGAIN, and
# the re-apply assertions. Output is teed rather than left
# on the terminal because the last assertion is about five NOTICES, and a
# NOTICE is the only evidence that the five substituting DO blocks took their
# early return instead of patching an already-patched body.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55546 -d postgres \
  -f "$root/scripts/dev/fixtures/lightning-phase3-remediation-schema.sql" \
  -f "$phase2" \
  -f "$phase2r" \
  -f "$phase3" \
  -f "$fixture/window.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql" 2>&1 | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# THE FIVE NOTICES. Each of the five substituting DO blocks opens with a
# sentinel - a string the patched body carries and the unpatched one does not -
# and returns early when it finds it. Exactly ONE occurrence of each proves
# both halves: the FIRST application did the work (or the notice would appear
# twice) and the SECOND application did not (or it would not appear at all).
notice_once() {
  local want="$1" label="$2" n
  n=$(grep -c -F -- "$want" "$fixture/psql.out" || true)
  if [ "$n" != 1 ]; then
    echo "FAIL re-apply notice: '$label' was announced $n time(s), not once; a first pass that skipped or a second pass that re-patched both land here"
    exit 1
  fi
}
notice_once 'fn_cash_cluster_open_table already counts live tables'       'cluster writer'
notice_once 'fn_cash_game_lobby already asks the front table'             'lobby'
notice_once 'fn_cash_seat_change_request already asks the front table'    'seat-change door'
notice_once 'fn_cash_seat_change_plan already asks the front table'       'seat-change planner'
notice_once 'fn_cash_cluster_tick already asks the front table'           'break step'
echo '  ok  RE-APPLY NOTICES  each of the five substituting blocks announced its early return exactly once, so the first pass patched and the second pass did not'

# THE NON-VACUITY GUARD RAN ON A SINGLE-DIGIT ESTATE AND SAID SO. The
# migration's read-back ends by naming how many clusters have a live Main 1 and
# refuses only when that is zero. An earlier cut refused below a HUNDRED, which
# made the file unapplicable to a fresh db reset, a preview branch or any CI
# database - so this reads the number the migration itself counted, out of its
# own NOTICE, rather than trusting the harness's count of the same thing.
front_notices=$(grep -c -E 'front table: [0-9]+ cluster\(s\) have a live Main 1' "$fixture/psql.out" || true)
if [ "$front_notices" != 2 ]; then
  echo "FAIL guard headcount: the migration announced its live-Main-1 count $front_notices time(s), not once per application"
  exit 1
fi
# The whole phrase, not 'front table: N cluster': 20260921025523 prints a
# notice of its own that opens with the same five words and would be matched
# first. 'Main 1' ends in a digit, so the count is the FIRST number in it.
front_count=$(grep -o -E 'front table: [0-9]+ cluster\(s\) have a live Main 1' "$fixture/psql.out" \
              | head -1 | grep -o -E '[0-9]+' | head -1)
if [ "${#front_count}" != 1 ] || [ "$front_count" -lt 1 ]; then
  echo "FAIL guard headcount: the migration counted $front_count cluster(s) with a live Main 1, which is not the single-digit estate this harness applies it to"
  exit 1
fi
echo "  ok  GUARD HEADCOUNT   the migration announced its own live-Main-1 count once per application and it was $front_count, so the read-back it ends with is a non-vacuity guard and not a production headcount"

echo 'PASS: Lightning Phase 3 remediation, the front table is the main game and the epoch follows its game, 17 checks: the migration applies to a single-digit estate and announces its own single-digit live-Main-1 count rather than demanding a production headcount, its two-statement catch-up closes the stale open epoch row of a cluster whose epoch moved while nothing maintained the table and opens the one it is at instead of rolling back on 23505 while giving a cluster born in that window a genesis row carrying its own epoch mode and created_at and moving no cluster that needed no repair, a Cluster created by a bare INSERT and one created through the live create path each get exactly one genesis epoch row under started_by genesis with no ended_at and every cluster in the estate has an open epoch row at its own cluster_epoch, a forward bump ends the open epoch and opens the next under the mode the Cluster is in filing the reason ca.epoch_reason names or unstated when nobody set one while cash_cluster_epoch_current still holds, a move back to 0 from epoch 2 is refused by name with SQLSTATE 23514 leaving every epoch row and the cluster_epoch itself untouched while the forward bump past it is still taken, a cluster_mode change rewrites the OPEN epoch row and leaves the ENDED one reading the mode it ran under while an UPDATE touching neither column moves nothing, the front table is Main 1 over an older live feeder and the oldest live non-breaking table without one and a breaking table only when every table is breaking and never a role=main main_index=NULL row over the real Main 1 and NULL for a cluster whose only table has closed and never a closed or deleted row, the cluster writer names a cluster first live table after its game and still does so when the row beside it is CLOSED or DELETED while naming a table opened beside a LIVE one <game> Feeder, the lobby reports a feeder-first cluster one live feeder as front_table_id and tells the player on it they are in the main game with no seat change offered while an unseated caller still reads JSON null and an ordinary board answers false-lit and true-dark, the door refuses a request FROM the front table and TO it and a destination-less request with nowhere else to go on an ordinary board AND on a feeder-first one where no Main 1 predicate could have refused them while taking every one of those requests the moment a non-front table exists, the planner cancels a request listed from the table that is now the front with note now_on_main_one and returns the allowance and routes onto the only non-front table though the front is emptier and swaps with the non-front partner rather than the older request from the front, the break step names the other live table as its candidate though the front is thinner and names no candidate at all on a cluster whose one live table is the front, the planner and the tick each call fn_cash_cluster_front_table exactly once as a hoisted local that all four predicates then read while the lobby still calls it three times, that hoist reads the board the ROLES step left rather than the one it was handed and one planner read serves every request in a call that plans one move and cancels another, and the migration is idempotent on re-apply with all six bodies and the trigger definition byte-identical its catch-up adding and moving no epoch row each of its five substituting blocks announcing its early return exactly once and the re-created trigger still writing the genesis epoch of a Cluster born after it'
