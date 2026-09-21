#!/usr/bin/env bash
# Lightning Phase 4: one live eligible population, and the thresholds it is
# judged by.
#
# Applies 20260921064717 to a throwaway PostgreSQL 17 cluster carrying the real
# pre-migration schema, and then exercises the three functions it creates and
# the one it replaces against a real backend rather than against a reading of
# the file.
#
# WHAT IS ACTUALLY AT RISK HERE, AND WHY THE SECTIONS ARE SHAPED THE WAY THEY
# ARE.
#
# This migration writes nothing. It counts. That makes it the easiest kind of
# file to test vacuously and the easiest kind to break silently, because every
# one of its answers is a number and almost every wrong number is still a
# number. Three failure modes are worth naming:
#
#   A COUNT THAT IS ALWAYS ZERO passes every test that only asserts an
#   exclusion drops the population. So every exclusion here is flipped ON, the
#   drop is asserted, and then it is flipped BACK OFF and the return is
#   asserted. Section 5 is eleven assertions for five exclusions for exactly
#   that reason.
#
#   A NARROWING THAT NARROWS NOTHING passes every test that only asserts
#   `population <= board`. Section 10 asserts BOTH halves: strictly less when
#   an exclusion is present, and EQUAL when none is, which is the half that a
#   function returning 0 cannot pass.
#
#   THE SAME HUMAN COUNTED TWICE is what the predicate's UNION exists to stop,
#   and it is invisible to every board in this file but one. The two halves of
#   the predicate - eligible chairs and active pool sessions - are disjoint
#   while a Cluster is cleanly in one regime, and they are NOT disjoint for the
#   length of a Phase 5 conversion, which is precisely when the threshold is
#   read. Section 20 is the only board here that puts one human in both, and
#   UNION ALL in place of UNION would leave every other section green.
#
#   A PROOF THAT HAS GONE STALE is the failure nothing catches, because
#   `-- @live-proof:` lines are comments and no psql run evaluates them. Three
#   of this migration's have been false so far and all three were the proof
#   drifting away from code that was right. Section 22 extracts every one of
#   them from the file under test and asks the database.
#
#   TWO READERS THAT DRIFT APART is the failure this migration was restructured
#   around, and it is invisible to any test that asks only one of them. There
#   are four readers of this number - fn_cash_cluster_live_eligible,
#   fn_cash_cluster_population, fn_cash_cluster_lightning_state and
#   fn_cash_cluster_pool_health - and exactly one of them computes it. Section
#   15 asks all four, on every board this file builds, at a disconnect count
#   and at none. Section 19 asks the other half of the same question: the
#   reader the lobby embeds must call the two-statement predicate and not the
#   nine-statement breakdown, because an earlier cut had every lobby open
#   paying for all nine.
#
#   A HORSE QUIETLY EXCLUDED passes every test in this file except section 6.
#   Law 10.5 is pinned twice in
#   server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts - once
#   against the tick's worklist and once against the balancer - and both of
#   those assert that the SQL does not mention is_horse. Neither of them can
#   see a SQL function written after them. Section 6 is where a future agent
#   "fixing" the population by adding `AND ts.horse_id IS NULL` goes red, and
#   it is the single most important section in this file.
#
# THE SIX RULES, inherited from scripts/dev/test-lightning-phase2-domain.sh and
# scripts/dev/test-lightning-phase3-remediation.sh, every one of them learned
# from mutation testing rather than from review:
#
#   1. Every comparison in an assertion is IS DISTINCT FROM, never = or <>. A
#      NULL where a value was expected makes `IF NOT (x = y)` evaluate to NULL,
#      which plpgsql takes as false, so an absent key PASSED a check written
#      that way. This whole file reads jsonb by ->> , which answers NULL for a
#      key that is not there, so this is not a hypothetical: it is the single
#      most likely way for a renamed counter to go unnoticed. Relational
#      assertions are spelled `IF (a <= b) IS DISTINCT FROM true`, for the same
#      reason and with the same NULL handling.
#   2. Every negative assertion is preceded by its non-vacuity proof. "A
#      waitlist row did not raise the population" is satisfied by a function
#      that counts nothing at all, so the same section first proves the
#      population counts a seated player, and proves the waitlist row was
#      really inserted by watching excluded.waitlist_only rise for it.
#   3. Every exclusion is paired with the ACCEPT that proves the predicate is
#      not simply always-false. Sitting-out excludes and sitting back in
#      includes; an expired hold is not reserved and a live hold is; a settled
#      hand is not in progress and an unsettled one is.
#   4. A rule is asserted against the other answer, not against itself. The
#      table predicate section asserts that fn_cash_cluster_census and
#      fn_cash_cluster_population AGREE - same table count, same seat total -
#      because "the population uses the census's predicate" is a statement
#      about two functions and can only be tested by asking both.
#   5. Grants are asserted in both directions. anon, authenticated and PUBLIC
#      must hold nothing on the four functions, and service_role must hold
#      EXECUTE on all four: a check of the negative half alone stays green when
#      the whole family is unreachable by the API role.
#   6. The re-apply is compared body by body, not by "it exited 0". All five
#      bodies, all five access control lists and all five comments are captured
#      into TEMP tables before the second application and compared byte for
#      byte after it - and the second application runs over the STANDING
#      boards, not over a torn-down estate, so its own read-back is exercised
#      against sitting-out, leaving, busted and empty chairs, a Lightning pool,
#      an overlapping conversion-window player, stale holds on closed tables and
#      a ladder at seventeen.
#
# THE FIXTURE IS A DELTA AND IT IS APPLIED SECOND. The migration under test
# creates four functions and replaces a fifth, and between them they read
# eighteen relations none of them creates. Four real migration files in this
# repository create thirteen of those and the harness applies those four,
# for the same reason the Phase 3 remediation harness applies ITS three: one
# copy of that text in the repository, free to be corrected in one place.
# scripts/dev/fixtures/lightning-phase3-remediation-schema.sql already builds
# the cluster, the table, the chair, the census and the five function bodies
# whose byte-exact anchors 20260921025523 and 20260921044045 read, so it is
# applied first and unchanged, and
# scripts/dev/fixtures/lightning-phase4-population-schema.sql adds only what
# nothing else makes: two columns on the chair, two relations, and a cluster on
# each side of the handedness band boundary.
#
# LIGHTNING_PHASE4_MIGRATION overrides the file under test. It exists so that
# mutation testing - copying the migration to a scratch directory, deleting one
# clause from the copy and watching this harness go red - never has to touch
# the migration in the repository.
set -euo pipefail
export LC_ALL=C  # else initdb's postmaster refuses to start on macOS ("became multithreaded during startup") and string_agg ordering stops being deterministic
# The repository root from this script's own location rather than from git: the
# harness is read-only with respect to the working tree and has no reason to
# shell out to it.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
base_fixture=$root/scripts/dev/fixtures/lightning-phase3-remediation-schema.sql
delta_fixture=$root/scripts/dev/fixtures/lightning-phase4-population-schema.sql
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
phase3r=$root/supabase/migrations/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
migration=${LIGHTNING_PHASE4_MIGRATION:-$root/supabase/migrations/20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase4-test.XXXXXX")
started=0
cleanup() {
  # || true: the trap runs under set -e, so a non-zero stop would abort the
  # function before rm -rf and leak the fixture directory - and make a fully
  # passing run exit 1.
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55547 -h ''" start >/dev/null
started=1

# The assertion groups live in the throwaway directory with the cluster they are
# written for: ONE psql session, so a board built by one section is still there
# for the next, the baseline capture and the pre-re-apply capture can both be
# TEMP tables, and the migration is applied a second time to the same backend
# that holds them.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- THE HARNESS'S OWN WRITERS. Boards are built through these rather than
-- through fn_cash_cluster_open_table because the shapes this contract needs -
-- a table that is already deleted, a table whose status has left the census's
-- list, a chair with no human in it, a chair whose occupant is a horse - are
-- shapes the one cluster writer correctly refuses to make.
CREATE TEMP TABLE board (k text PRIMARY KEY, game_id uuid, table_id uuid, payload jsonb);

-- WHAT EVERY CLUSTER WAS, recorded at the moment it was made. Section 15 says
-- "nothing converted", and that sentence needs something to be true against
-- for the clusters this file creates after the migration as well as for the
-- ones the fixture seeded before it.
CREATE TEMP TABLE cluster_baseline (game_id uuid PRIMARY KEY, mode text, epoch integer);
INSERT INTO cluster_baseline SELECT id, cluster_mode, cluster_epoch FROM public.cash_games;

-- A NOTE OF WHAT THE HARNESS ITSELF MOVED, so that "every cluster's mode is
-- what it was" at section 15 is a RESTORATION and not a sentence about a file
-- that never touched a mode at all.
CREATE TEMP TABLE harness_moved (k text PRIMARY KEY, note text);

CREATE FUNCTION public.fx_cluster(p_name text, p_handed integer,
                                  p_lightning boolean DEFAULT true,
                                  p_mode text DEFAULT 'must_move',
                                  p_enabled boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, enabled,
     cluster_mode, cluster_epoch, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     p_name, 'classic', 'nlh', 1.00, 2.00, p_handed, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, p_lightning, p_enabled,
     p_mode, 0, clock_timestamp())
  RETURNING id INTO v_id;
  -- trg_cash_games_epoch_follows_its_game has already written the genesis
  -- cash_cluster_epoch row by the time this returns, which is what lets a
  -- lightning_pool_session name this cluster and this epoch at all.
  INSERT INTO cluster_baseline (game_id, mode, epoch) VALUES (v_id, p_mode, 0);
  RETURN v_id;
END $fx$;

-- p_status and p_lifecycle are separate parameters ON PURPOSE. The census
-- predicate tests BOTH - `status IN ('waiting','running','active')` and
-- `lifecycle <> 'closed'` - and a writer that derived one from the other could
-- never build the board that tells the two tests apart.
CREATE FUNCTION public.fx_table(p_game uuid, p_role text, p_main_index integer,
                                p_max integer DEFAULT 9,
                                p_lifecycle text DEFAULT 'live',
                                p_status text DEFAULT 'waiting',
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
     g.variant, g.sb, g.bb, p_max, p_status, g.created_by, p_game, p_role,
     p_main_index, p_lifecycle, p_deleted,
     clock_timestamp(), clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END $fx$;

-- A HORSE'S CHAIR CARRIES BOTH COLUMNS. 20260913173936 stamps
-- table_seats.horse_id from the canonical occupant profile named by user_id,
-- so a horse in the live estate has user_id AND horse_id set to that profile.
-- Seating one with a NULL user_id would be a shape production never makes, and
-- it would make section 6 pass for the wrong reason.
CREATE FUNCTION public.fx_seat(p_table uuid, p_seat integer,
                               p_user uuid DEFAULT NULL,
                               p_stack numeric DEFAULT 200.00,
                               p_horse uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid; v_user uuid;
BEGIN
  v_user := coalesce(p_user, p_horse, gen_random_uuid());
  INSERT INTO public.table_seats
    (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, horse_id, joined_at)
  VALUES (p_table, v_user, p_seat, p_stack, false, false, p_horse, clock_timestamp())
  RETURNING id INTO v_id;
  RETURN v_id;
END $fx$;

-- Seat exactly N ordinary players across the cluster's VISIBLE tables, filling
-- each to its max_players in creation order. It RAISES rather than seating
-- fewer, because a ladder section that silently seated 17 where it meant 19
-- would assert the wrong rung of the ladder and pass.
CREATE FUNCTION public.fx_populate(p_game uuid, p_n integer)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE r record; v_left integer := p_n; v_seat integer; v_total integer := 0;
BEGIN
  DELETE FROM public.table_seats ts
   USING public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = p_game;
  FOR r IN SELECT tb.id, coalesce(tb.max_players, 9) AS cap
             FROM public.tables tb
            WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
              AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
            ORDER BY tb.created_at, tb.id
  LOOP
    v_seat := 0;
    WHILE v_left > 0 AND v_seat < r.cap LOOP
      v_seat := v_seat + 1;
      PERFORM public.fx_seat(r.id, v_seat);
      v_left := v_left - 1;
      v_total := v_total + 1;
    END LOOP;
  END LOOP;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'FIXTURE: cluster % has room for % of the % player(s) asked for', p_game, v_total, p_n;
  END IF;
  RETURN v_total;
END $fx$;

-- The four readers, wrapped so that a section reads one number per line rather
-- than five casts per line. p_disc defaults to NULL, which is exactly what
-- calling the two-argument form does.
CREATE FUNCTION public.fx_pop(p_game uuid, p_disc integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $fx$
  SELECT public.fn_cash_cluster_population(p_game, clock_timestamp(), p_disc);
$fx$;
CREATE FUNCTION public.fx_live(p_game uuid, p_disc integer DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT (public.fx_pop(p_game, p_disc) ->> 'live_eligible')::integer;
$fx$;
CREATE FUNCTION public.fx_cnt(p_game uuid, p_key text)
RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT (public.fx_pop(p_game) -> 'counted' ->> p_key)::integer;
$fx$;
CREATE FUNCTION public.fx_exc(p_game uuid, p_key text)
RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT (public.fx_pop(p_game) -> 'excluded' ->> p_key)::integer;
$fx$;
CREATE FUNCTION public.fx_verdict(p_game uuid, p_key text)
RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT public.fn_cash_cluster_lightning_state(p_game) -> 'verdict' ->> p_key;
$fx$;
-- The BOARD count, which is the other number and must never become this one.
CREATE FUNCTION public.fx_board(p_game uuid)
RETURNS bigint LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(sum(c.seated), 0)::bigint FROM unnest(public.fn_cash_cluster_census(p_game)) c;
$fx$;
CREATE FUNCTION public.fx_board_tables(p_game uuid)
RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(array_length(public.fn_cash_cluster_census(p_game), 1), 0);
$fx$;
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 01 THRESHOLD DEFAULTS ------------------------------------------------------
-- "6-max: lightning_on_threshold = 18, lightning_off_threshold = 12.
--  9-max/full-ring: 27 and 18." The band boundary is the migration's own
-- `handedness <= 6`, which the specification never spells: it says "9-max/full
-- ring" and leaves 7 and 8 unnamed. So 6 and 7 are both asked, from either
-- side of the boundary, and the four numbers are written here as LITERALS
-- rather than recomputed from the same `<= 6` rule the function uses - a check
-- that derived its expectation the way the function derives its answer would
-- agree with any boundary at all.
DO $$
DECLARE r record; v_id uuid; v_th jsonb; v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (2, 18, 12, 'six_max'),
      (5, 18, 12, 'six_max'),
      (6, 18, 12, 'six_max'),
      (7, 27, 18, 'full_ring'),
      (9, 27, 18, 'full_ring')) AS w(handed, want_on, want_off, want_band)
  LOOP
    SELECT id INTO v_id FROM public.cash_games
     WHERE handedness = r.handed AND ruleset_snapshot -> 'lightning' IS NULL
     ORDER BY created_at LIMIT 1;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'FAIL 01: no unconfigured cluster at handedness %, so its band was never asked about', r.handed;
    END IF;
    v_n := v_n + 1;
    v_th := public.fn_cash_cluster_lightning_thresholds(v_id);
    IF (v_th ->> 'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 01: handedness % answered ok = %', r.handed, v_th ->> 'ok';
    END IF;
    IF (v_th ->> 'on')::integer IS DISTINCT FROM r.want_on THEN
      RAISE EXCEPTION 'FAIL 01: handedness % reads ON %, not the mandated %', r.handed, v_th ->> 'on', r.want_on;
    END IF;
    IF (v_th ->> 'off')::integer IS DISTINCT FROM r.want_off THEN
      RAISE EXCEPTION 'FAIL 01: handedness % reads OFF %, not the mandated %', r.handed, v_th ->> 'off', r.want_off;
    END IF;
    IF (v_th ->> 'band') IS DISTINCT FROM r.want_band THEN
      RAISE EXCEPTION 'FAIL 01: handedness % is in band %, not %', r.handed, v_th ->> 'band', r.want_band;
    END IF;
    IF (v_th ->> 'source') IS DISTINCT FROM 'default' THEN
      RAISE EXCEPTION 'FAIL 01: handedness % with no lightning ruleset says source %, not default', r.handed, v_th ->> 'source';
    END IF;
    IF (v_th ->> 'handedness')::integer IS DISTINCT FROM r.handed THEN
      RAISE EXCEPTION 'FAIL 01: the answer for handedness % reports handedness %', r.handed, v_th ->> 'handedness';
    END IF;
    IF (v_th ->> 'game_id')::uuid IS DISTINCT FROM v_id THEN
      RAISE EXCEPTION 'FAIL 01: the answer for cluster % names cluster %', v_id, v_th ->> 'game_id';
    END IF;
  END LOOP;
  IF v_n IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 01: % of the five handedness values were asked about, not 5', v_n;
  END IF;
  -- AND THE READER REFUSES TO INVENT ONE. A cluster that does not exist gets
  -- ok = false rather than a pair of numbers a threshold would then act on.
  v_th := public.fn_cash_cluster_lightning_thresholds('00000000-0000-0000-0000-000000000000'::uuid);
  IF coalesce((v_th ->> 'ok')::boolean, true) IS DISTINCT FROM false
     OR (v_th ->> 'reason') IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'FAIL 01: the thresholds invented % for a cluster that does not exist', v_th;
  END IF;
END $$;
\echo '  ok  01 THRESHOLD DEFAULTS      handedness 2 5 and 6 read ON 18 / OFF 12 in band six_max and handedness 7 and 9 read 27 / 18 in band full_ring, every one of them under source default with its own game_id and handedness echoed back, the four numbers asserted as literals rather than rederived from the same <= 6 rule the function uses, and a cluster that does not exist gets ok false with reason not_found rather than a pair of numbers'

-- 02 THRESHOLD CONFIGURATION -------------------------------------------------
-- cash_games.ruleset_snapshot -> lightning is the one place a Cluster says it
-- wants different numbers, and `source` is how a reader tells a deliberate
-- setting from a default it inherited. HALF a configuration is the interesting
-- case: naming only the ON threshold must leave the OFF at its band default
-- and must still read `ruleset`, because something WAS configured.
DO $$
DECLARE v_g6 uuid; v_g9 uuid; v_th jsonb;
BEGIN
  v_g6 := public.fx_cluster('P4 Threshold Config Six', 6);
  v_g9 := public.fx_cluster('P4 Threshold Config Ring', 9);
  INSERT INTO board (k, game_id) VALUES ('cfg_six', v_g6), ('cfg_ring', v_g9);
  PERFORM public.fx_table(v_g6, 'main', 1, 6);
  PERFORM public.fx_table(v_g9, 'main', 1, 9);

  -- NON-VACUITY: before anything is configured they read the band defaults, so
  -- the four assertions below are about the configuration and not about the
  -- clusters happening to read those numbers anyway.
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 OR (v_th ->> 'off')::integer IS DISTINCT FROM 12
     OR (v_th ->> 'source') IS DISTINCT FROM 'default' THEN
    RAISE EXCEPTION 'FAIL 02: the unconfigured six-max cluster does not start at 18 / 12 / default: %', v_th;
  END IF;

  -- BOTH NAMED.
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}',
           '{"on_threshold": 20, "off_threshold": 14}'::jsonb)
   WHERE id = v_g6;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 20 OR (v_th ->> 'off')::integer IS DISTINCT FROM 14 THEN
    RAISE EXCEPTION 'FAIL 02: a cluster configured 20 / 14 reads % / %', v_th ->> 'on', v_th ->> 'off';
  END IF;
  IF (v_th ->> 'source') IS DISTINCT FROM 'ruleset' THEN
    RAISE EXCEPTION 'FAIL 02: a fully configured cluster says source %, not ruleset', v_th ->> 'source';
  END IF;
  IF (v_th ->> 'band') IS DISTINCT FROM 'six_max' THEN
    RAISE EXCEPTION 'FAIL 02: configuring the numbers moved the cluster to band %', v_th ->> 'band';
  END IF;

  -- ONLY THE ON THRESHOLD. The OFF keeps its band default and source still
  -- reads ruleset, because something was configured.
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}', '{"on_threshold": 20}'::jsonb)
   WHERE id = v_g6;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'FAIL 02: on_threshold alone reads ON %, not 20', v_th ->> 'on';
  END IF;
  IF (v_th ->> 'off')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 02: on_threshold alone left OFF at %, not the six-max default 12', v_th ->> 'off';
  END IF;
  IF (v_th ->> 'source') IS DISTINCT FROM 'ruleset' THEN
    RAISE EXCEPTION 'FAIL 02: half a configuration says source %, not ruleset', v_th ->> 'source';
  END IF;

  -- ONLY THE OFF THRESHOLD, the mirror of it.
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}', '{"off_threshold": 14}'::jsonb)
   WHERE id = v_g6;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 02: off_threshold alone left ON at %, not the six-max default 18', v_th ->> 'on';
  END IF;
  IF (v_th ->> 'off')::integer IS DISTINCT FROM 14 THEN
    RAISE EXCEPTION 'FAIL 02: off_threshold alone reads OFF %, not 14', v_th ->> 'off';
  END IF;
  IF (v_th ->> 'source') IS DISTINCT FROM 'ruleset' THEN
    RAISE EXCEPTION 'FAIL 02: half a configuration says source %, not ruleset', v_th ->> 'source';
  END IF;

  -- AND THE FULL-RING BAND KEEPS ITS OWN DEFAULT under half a configuration,
  -- which is what says the fallback is keyed off handedness rather than being
  -- the six-max pair with a different name.
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}', '{"on_threshold": 30}'::jsonb)
   WHERE id = v_g9;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g9);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 30 OR (v_th ->> 'off')::integer IS DISTINCT FROM 18
     OR (v_th ->> 'source') IS DISTINCT FROM 'ruleset' OR (v_th ->> 'band') IS DISTINCT FROM 'full_ring' THEN
    RAISE EXCEPTION 'FAIL 02: a full-ring cluster with on_threshold 30 reads %', v_th;
  END IF;

  -- THE ACCEPT THAT PAIRS WITH ALL FOUR: taking the key away puts both numbers
  -- and the source back. A reader that had cached, or that answered from
  -- anything other than the column, stays green on every assertion above and
  -- goes red here.
  UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot - 'lightning'
   WHERE id IN (v_g6, v_g9);
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 OR (v_th ->> 'off')::integer IS DISTINCT FROM 12
     OR (v_th ->> 'source') IS DISTINCT FROM 'default' THEN
    RAISE EXCEPTION 'FAIL 02: removing the configuration left the six-max cluster reading %', v_th;
  END IF;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g9);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 27 OR (v_th ->> 'off')::integer IS DISTINCT FROM 18
     OR (v_th ->> 'source') IS DISTINCT FROM 'default' THEN
    RAISE EXCEPTION 'FAIL 02: removing the configuration left the full-ring cluster reading %', v_th;
  END IF;
END $$;
\echo '  ok  02 THRESHOLD CONFIGURATION a cluster carrying ruleset_snapshot -> lightning with both numbers reads them under source ruleset and keeps its band, naming only on_threshold leaves the OFF at its band default and naming only off_threshold leaves the ON at its band default with source still reading ruleset in both halves, a full-ring cluster half-configured keeps 18 rather than the six-max 12 so the fallback is keyed off handedness, and taking the key away puts both numbers and the source back'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 03 THRESHOLD REFUSES NONSENSE, WITHOUT RAISING -----------------------------
-- "The OFF threshold provides hysteresis and prevents rapid ON/OFF
-- oscillation." An OFF at or above the ON converts a Cluster every tick,
-- forever, in both directions, so a configuration that says so is refused.
--
-- AND IT IS REFUSED WITHOUT RAISING, WHICH IS THE POINT OF THE SECTION. This
-- reader is on the path a tick takes. A reader that raises takes the tick down
-- with it, and a Cluster whose operator typed 12 and 12 would stop being
-- balanced at all. Every case below is called inside an exception handler and
-- the handler firing is itself a failure.
--
-- TWO DIFFERENT ANSWERS ARE EXPECTED AND BOTH ARE ASSERTED AS THE MIGRATION
-- WRITES THEM, not as one might wish them:
--
--   A NUMBER THAT IS NONSENSE is read, found to be nonsense, and replaced:
--   source reads default_after_invalid_config, which is a reader telling an
--   operator their setting was thrown away.
--
--   A NON-NUMBER IS NEVER READ AT ALL. jsonb_typeof gates both assignments, so
--   a string, a boolean, a JSON null or a non-object under 'lightning' leaves
--   v_source at its initial 'default' and the hysteresis guard then finds two
--   perfectly good defaults and says nothing. source reads plain 'default' -
--   indistinguishable, to a reader, from a cluster that configured nothing.
--   That is what the file does; it is recorded here rather than argued with.
DO $$
DECLARE
  r record; v_th jsonb; v_g6 uuid; v_g9 uuid; v_id uuid; v_n integer := 0;
  v_zero integer := 0; v_caught boolean; v_err text;
BEGIN
  SELECT game_id INTO v_g6 FROM board WHERE k = 'cfg_six';
  SELECT game_id INTO v_g9 FROM board WHERE k = 'cfg_ring';

  -- THE HANDLER IS REAL. Every "it did not raise" below is worth exactly as
  -- much as the proof that this shape catches something, so it catches
  -- something first.
  v_caught := false;
  BEGIN
    PERFORM 1 / v_zero;
  EXCEPTION WHEN OTHERS THEN v_caught := true;
  END;
  IF v_caught IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: the exception handler that every "did not raise" below is written inside did not catch a division by zero, so none of them is a statement';
  END IF;

  FOR r IN SELECT * FROM (VALUES
      -- The numbers that are nonsense: read, refused, replaced, and SAID SO.
      ('on below off',            6, '{"on_threshold": 10, "off_threshold": 12}'::jsonb, 18, 12, 'default_after_invalid_config'),
      ('on equal to off',         6, '{"on_threshold": 12, "off_threshold": 12}'::jsonb, 18, 12, 'default_after_invalid_config'),
      ('off below two',           6, '{"on_threshold": 18, "off_threshold": 1}'::jsonb,  18, 12, 'default_after_invalid_config'),
      ('off zero alone',          6, '{"off_threshold": 0}'::jsonb,                      18, 12, 'default_after_invalid_config'),
      ('off negative alone',      6, '{"off_threshold": -4}'::jsonb,                     18, 12, 'default_after_invalid_config'),
      -- The same refusal on the other band, which is what says the fallback is
      -- keyed off handedness rather than being 18 / 12 by another name.
      ('ring on below off',       9, '{"on_threshold": 5, "off_threshold": 9}'::jsonb,   27, 18, 'default_after_invalid_config'),
      -- The non-numbers, which jsonb_typeof never lets through, so nothing is
      -- ever found to be invalid and the source stays plain 'default'.
      ('strings not numbers',     6, '{"on_threshold": "20", "off_threshold": "14"}'::jsonb, 18, 12, 'default'),
      ('booleans not numbers',    6, '{"on_threshold": true, "off_threshold": false}'::jsonb, 18, 12, 'default'),
      ('json nulls',              6, '{"on_threshold": null, "off_threshold": null}'::jsonb, 18, 12, 'default'),
      ('nested objects',          6, '{"on_threshold": {"n": 20}}'::jsonb,               18, 12, 'default'),
      ('arrays',                  6, '{"on_threshold": [20]}'::jsonb,                    18, 12, 'default'),
      ('empty object',            6, '{}'::jsonb,                                        18, 12, 'default'),
      -- And 'lightning' itself not being an object at all.
      ('lightning is a string',   6, '"nope"'::jsonb,                                    18, 12, 'default'),
      ('lightning is an array',   6, '[18, 12]'::jsonb,                                  18, 12, 'default'),
      ('lightning is a number',   6, '5'::jsonb,                                         18, 12, 'default'),
      ('lightning is json null',  6, 'null'::jsonb,                                      18, 12, 'default'),
      ('lightning is a boolean',  6, 'true'::jsonb,                                      18, 12, 'default')
      ) AS w(label, handed, cfg, want_on, want_off, want_source)
  LOOP
    v_n := v_n + 1;
    v_id := CASE WHEN r.handed = 6 THEN v_g6 ELSE v_g9 END;
    UPDATE public.cash_games SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}', r.cfg)
     WHERE id = v_id;

    -- IT DOES NOT RAISE. Not the thresholds, and not the two readers on the
    -- tick's path that call them, because a configuration that took the
    -- population down would be the same outage one level up.
    v_err := NULL;
    BEGIN
      v_th := public.fn_cash_cluster_lightning_thresholds(v_id);
      PERFORM public.fn_cash_cluster_population(v_id);
      PERFORM public.fn_cash_cluster_lightning_state(v_id);
      PERFORM public.fn_cash_cluster_pool_health(v_id);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS DISTINCT FROM NULL THEN
      RAISE EXCEPTION 'FAIL 03 (%): the configuration raised "%" on a path the tick takes', r.label, v_err;
    END IF;

    IF (v_th ->> 'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 03 (%): answered ok = % rather than falling back', r.label, v_th ->> 'ok';
    END IF;
    IF (v_th ->> 'on')::integer IS DISTINCT FROM r.want_on THEN
      RAISE EXCEPTION 'FAIL 03 (%): fell back to ON %, not the mandated %', r.label, v_th ->> 'on', r.want_on;
    END IF;
    IF (v_th ->> 'off')::integer IS DISTINCT FROM r.want_off THEN
      RAISE EXCEPTION 'FAIL 03 (%): fell back to OFF %, not the mandated %', r.label, v_th ->> 'off', r.want_off;
    END IF;
    IF (v_th ->> 'source') IS DISTINCT FROM r.want_source THEN
      RAISE EXCEPTION 'FAIL 03 (%): says source %, not %', r.label, v_th ->> 'source', r.want_source;
    END IF;
    -- AND THE HYSTERESIS RULE ITSELF HOLDS on every answer: ON strictly above
    -- OFF, whatever was asked for.
    IF ((v_th ->> 'on')::integer > (v_th ->> 'off')::integer) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 03 (%): answered ON % OFF %, which oscillates', r.label, v_th ->> 'on', v_th ->> 'off';
    END IF;
  END LOOP;

  IF v_n IS DISTINCT FROM 17 THEN
    RAISE EXCEPTION 'FAIL 03: % nonsense configurations were tried, not 17', v_n;
  END IF;

  -- THE ACCEPT THAT PAIRS WITH SEVENTEEN REFUSALS. A guard that refused
  -- EVERYTHING would pass every assertion above, so the same cluster is handed
  -- a configuration that IS sensible and it is taken.
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}',
           '{"on_threshold": 22, "off_threshold": 2}'::jsonb)
   WHERE id = v_g6;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g6);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 22 OR (v_th ->> 'off')::integer IS DISTINCT FROM 2
     OR (v_th ->> 'source') IS DISTINCT FROM 'ruleset' THEN
    RAISE EXCEPTION 'FAIL 03: a sensible configuration at the very floor of off_threshold was refused: %', v_th;
  END IF;

  UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot - 'lightning'
   WHERE id IN (v_g6, v_g9);
END $$;
\echo '  ok  03 THRESHOLD NONSENSE      seventeen nonsense configurations - ON below OFF, ON equal to OFF, an OFF below two, an OFF of zero and of minus four, the same inversion on the full-ring band, strings booleans JSON nulls nested objects arrays and an empty object where numbers belong, and a lightning key that is a string an array a number a boolean or JSON null - each fall back to the mandated defaults of their OWN band, the six number cases saying source default_after_invalid_config and the eleven non-number cases saying plain default because jsonb_typeof never let them through, every one of them WITHOUT RAISING in the thresholds the population the state reader or pool health, proved against a handler that really does catch a division by zero, with ON strictly above OFF in all seventeen answers and a sensible 22 / 2 still taken'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 04 THE POPULATION COUNTS A PLAIN BOARD -------------------------------------
-- Before any exclusion means anything, the thing being narrowed has to exist.
-- Seven players with positive stacks across a Main and a feeder, nobody
-- sitting out, nobody leaving, nobody busted, no empty chairs: live_eligible
-- is seven, and the breakdown adds up to seven three different ways.
DO $$
DECLARE v_g uuid; v_main uuid; v_feeder uuid; v_pop jsonb; i integer;
BEGIN
  v_g := public.fx_cluster('P4 Plain Board', 6);
  v_main   := public.fx_table(v_g, 'main', 1, 6);
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 6);
  INSERT INTO board (k, game_id, table_id) VALUES ('plain', v_g, v_main), ('plain_feeder', v_g, v_feeder);

  -- NON-VACUITY, THE FIRST HALF: an empty board reads zero. A population that
  -- always answered seven would pass every assertion below.
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: an unseated cluster reports % live eligible', v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: an unseated cluster reports % seated', v_pop -> 'counted' ->> 'seated_total';
  END IF;

  FOR i IN 1..4 LOOP PERFORM public.fx_seat(v_main, i); END LOOP;
  FOR i IN 1..3 LOOP PERFORM public.fx_seat(v_feeder, i); END LOOP;

  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 04: the population answered ok = % for a live cluster', v_pop ->> 'ok';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'FAIL 04: seven ordinary players read % live eligible', v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_main')::integer IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 04: four on the Main read %', v_pop -> 'counted' ->> 'seated_main';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_feeder')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 04: three on the feeder read %', v_pop -> 'counted' ->> 'seated_feeder';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_main')::integer
     + (v_pop -> 'counted' ->> 'seated_feeder')::integer IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'FAIL 04: the Main and the feeder do not add up to the seven that were seated';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'FAIL 04: seated_total reads %, not 7', v_pop -> 'counted' ->> 'seated_total';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'FAIL 04: seated_eligible reads %, not 7', v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 2
     OR (v_pop ->> 'capacity')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 04: the board is % table(s) of % seats, not 2 of 12', v_pop ->> 'tables', v_pop ->> 'capacity';
  END IF;
  -- Nothing was excluded, and the six counters that could have said otherwise
  -- all read zero: the seven are seven because nothing was taken off them. The
  -- whole object is compared, so a counter RENAMED or DROPPED by a later cut
  -- lands here rather than passing as "it was zero anyway".
  IF (v_pop -> 'excluded') IS DISTINCT FROM
     '{"busted": 0, "leaving": 0, "sit_out": 0, "empty_chairs": 0, "reserved_seat": 0, "waitlist_only": 0}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 04: a plain board excluded something: %', v_pop -> 'excluded';
  END IF;
  -- Every seat is on a table that has a role, so the third seating bucket is
  -- empty and the two that are not add up to the whole.
  IF (v_pop -> 'counted' ->> 'seated_no_role')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: a board of a Main and a feeder reports % role-less seats', v_pop -> 'counted' ->> 'seated_no_role';
  END IF;
  -- Nobody is in both halves on a board with no pool, so the overlap the
  -- four-term identity subtracts is zero and the identity reduces to the sum.
  IF (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: a board with no Lightning pool reports % players in both halves',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  -- AND THE ANSWER SAYS WHAT KIND OF BREAKDOWN IT IS. The categories overlap
  -- and do not sum, and the file states that in a field rather than leaving a
  -- reader to find out by subtracting.
  IF (v_pop -> 'breakdown_is_not_arithmetic') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL 04: the answer does not carry breakdown_is_not_arithmetic (%)', v_pop -> 'breakdown_is_not_arithmetic';
  END IF;
  -- NON-VACUITY, THE SECOND HALF: the board count agrees at seven too, which
  -- is what makes every "strictly fewer" assertion later on a real narrowing.
  IF public.fx_board(v_g) IS DISTINCT FROM 7::bigint THEN
    RAISE EXCEPTION 'FAIL 04: the census counts % seats where the population counted 7', public.fx_board(v_g);
  END IF;
END $$;
\echo '  ok  04 A PLAIN BOARD           an unseated cluster reads zero and seven ordinary players across a Main and a feeder read live_eligible 7 with seated_main 4 plus seated_feeder 3 adding to it, seated_total and seated_eligible both 7, two tables of twelve seats, every excluded counter at zero, and the census counting the same seven'

-- 05 EVERY EXCLUSION, ONE AT A TIME, EACH PAIRED WITH ITS ACCEPT --------------
-- Five narrowings, and each one flipped ON, asserted, flipped BACK OFF and
-- asserted again. A test that only proved the drop would pass on a function
-- that always returned 0; the return is what says the predicate is reading the
-- column rather than answering a constant.
--
-- seated_total is asserted ALONGSIDE live_eligible every time, because the two
-- numbers behave DIFFERENTLY and that difference is the whole migration: a
-- sitting-out, leaving or busted player is still IN THE GAME and the board
-- still counts them, an empty chair is still a row and still counts, and only
-- a seat that has been LEFT stops being a seat at all.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_seat uuid; v_user uuid;
  v_live0 integer; v_tot0 integer; v_pop0 jsonb; v_pop jsonb;
BEGIN
  SELECT game_id, table_id INTO v_g, v_main FROM board WHERE k = 'plain';
  SELECT id, user_id INTO v_seat, v_user FROM public.table_seats
   WHERE table_id = v_main AND seat_number = 1;
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'FAIL 05: the plain board has no seat 1 to flip';
  END IF;
  v_pop0  := public.fx_pop(v_g);
  v_live0 := (v_pop0 ->> 'live_eligible')::integer;
  v_tot0  := (v_pop0 -> 'counted' ->> 'seated_total')::integer;
  IF (v_live0 > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the board reads % live eligible before anything is flipped, so a drop of one proves nothing', v_live0;
  END IF;

  -- (1) SITTING OUT. "A player who has sat out is not dealt in."
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: live eligible went from % to %, not to %', v_live0, v_pop ->> 'live_eligible', v_live0 - 1;
  END IF;
  IF (v_pop -> 'excluded' ->> 'sit_out')::integer
     IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'sit_out')::integer + 1 THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: excluded.sit_out reads %, not one more than %',
      v_pop -> 'excluded' ->> 'sit_out', v_pop0 -> 'excluded' ->> 'sit_out';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: a sitting-out player left the BOARD count too (% -> %), and the board counts them because they are in the game',
      v_tot0, v_pop -> 'counted' ->> 'seated_total';
  END IF;
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: sitting back in left the population at %, not %', public.fx_live(v_g), v_live0;
  END IF;
  IF public.fx_exc(v_g, 'sit_out') IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'sit_out')::integer THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: excluded.sit_out did not come back down';
  END IF;
  -- AND NULL IS NOT SITTING OUT. is_sitting_out is nullable in the live schema
  -- and the migration coalesces it; a seat that has never been written reads
  -- NULL and must be dealt in.
  UPDATE public.table_seats SET is_sitting_out = NULL WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 sit_out: a NULL is_sitting_out was treated as sitting out (% of %)', public.fx_live(v_g), v_live0;
  END IF;
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat;

  -- (2) LEAVING. "NOT WITH NOTHING, NOT WHILE LEAVING."
  UPDATE public.table_seats SET leave_pending = true WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 leaving: live eligible went from % to %, not to %', v_live0, v_pop ->> 'live_eligible', v_live0 - 1;
  END IF;
  IF (v_pop -> 'excluded' ->> 'leaving')::integer
     IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'leaving')::integer + 1 THEN
    RAISE EXCEPTION 'FAIL 05 leaving: excluded.leaving reads %', v_pop -> 'excluded' ->> 'leaving';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 THEN
    RAISE EXCEPTION 'FAIL 05 leaving: a leaving player left the BOARD count too (% -> %)', v_tot0, v_pop -> 'counted' ->> 'seated_total';
  END IF;
  UPDATE public.table_seats SET leave_pending = false WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 leaving: cancelling the leave left the population at %, not %', public.fx_live(v_g), v_live0;
  END IF;

  -- (3) BUSTED. A zero stack is a rebuy window, not a player who can be dealt.
  UPDATE public.table_seats SET stack = 0 WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 busted: live eligible went from % to %, not to %', v_live0, v_pop ->> 'live_eligible', v_live0 - 1;
  END IF;
  IF (v_pop -> 'excluded' ->> 'busted')::integer
     IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'busted')::integer + 1 THEN
    RAISE EXCEPTION 'FAIL 05 busted: excluded.busted reads %', v_pop -> 'excluded' ->> 'busted';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 THEN
    RAISE EXCEPTION 'FAIL 05 busted: a busted player left the BOARD count too (% -> %)', v_tot0, v_pop -> 'counted' ->> 'seated_total';
  END IF;
  -- A NULL STACK IS THE SAME THING, because the migration coalesces it, and
  -- the live column is nullable.
  UPDATE public.table_seats SET stack = NULL WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 busted: a NULL stack was dealt in (% of %)', public.fx_live(v_g), v_live0;
  END IF;
  -- AND A STACK OF ONE CENT IS NOT BUSTED. `> 0`, not `>= some minimum`.
  UPDATE public.table_seats SET stack = 0.01 WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 busted: a stack of one cent was treated as busted (% of %)', public.fx_live(v_g), v_live0;
  END IF;
  UPDATE public.table_seats SET stack = 200.00 WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 busted: rebuying left the population at %, not %', public.fx_live(v_g), v_live0;
  END IF;

  -- (4) NO HUMAN. An empty chair, and it now has a name: excluded.empty_chairs.
  -- seated_total counts OCCUPIED chairs, so it falls with it, while the CENSUS
  -- board count does not - the census counts seat ROWS and an empty chair is
  -- still a row. That divergence is the sharpest thing in this section: the two
  -- readers still agree about which TABLES are in the game and now deliberately
  -- disagree about what a "seat" is, and only asking both says so.
  UPDATE public.table_seats SET user_id = NULL WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 empty: live eligible went from % to %, not to %', v_live0, v_pop ->> 'live_eligible', v_live0 - 1;
  END IF;
  IF (v_pop -> 'excluded' ->> 'empty_chairs')::integer
     IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'empty_chairs')::integer + 1 THEN
    RAISE EXCEPTION 'FAIL 05 empty: excluded.empty_chairs reads %, not one more than %',
      v_pop -> 'excluded' ->> 'empty_chairs', v_pop0 -> 'excluded' ->> 'empty_chairs';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 empty: seated_total counts OCCUPIED chairs and went % -> %, not to %',
      v_tot0, v_pop -> 'counted' ->> 'seated_total', v_tot0 - 1;
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_main')::integer
     IS DISTINCT FROM (v_pop0 -> 'counted' ->> 'seated_main')::integer - 1 THEN
    RAISE EXCEPTION 'FAIL 05 empty: seated_main reads % where the chair it emptied was on the Main', v_pop -> 'counted' ->> 'seated_main';
  END IF;
  -- AND NOTHING ELSE MOVED. An empty chair is not sitting out, not leaving and
  -- not busted, which the three counters now say by requiring an occupant.
  IF (v_pop -> 'excluded' ->> 'sit_out')::integer IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'sit_out')::integer
     OR (v_pop -> 'excluded' ->> 'leaving')::integer IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'leaving')::integer
     OR (v_pop -> 'excluded' ->> 'busted')::integer IS DISTINCT FROM (v_pop0 -> 'excluded' ->> 'busted')::integer THEN
    RAISE EXCEPTION 'FAIL 05 empty: an empty chair was also filed as sitting out, leaving or busted: %', v_pop -> 'excluded';
  END IF;
  -- THE CENSUS STILL COUNTS THE ROW. An empty chair left the population and
  -- did NOT leave the board.
  IF public.fx_board(v_g) IS DISTINCT FROM v_tot0::bigint THEN
    RAISE EXCEPTION 'FAIL 05 empty: the census board count went % -> % for a chair that is still a row', v_tot0, public.fx_board(v_g);
  END IF;
  UPDATE public.table_seats SET user_id = v_user WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 05 empty: sitting somebody back down left the population at %, not %', public.fx_live(v_g), v_live0;
  END IF;

  -- (5) LEFT. The only one of the five that takes the seat out of the BOARD
  -- count as well, because a left seat is not a seat.
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 left: live eligible went from % to %, not to %', v_live0, v_pop ->> 'live_eligible', v_live0 - 1;
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 - 1 THEN
    RAISE EXCEPTION 'FAIL 05 left: seated_total reads %, not % - a left seat is not a seat', v_pop -> 'counted' ->> 'seated_total', v_tot0 - 1;
  END IF;
  IF (v_pop -> 'excluded') IS DISTINCT FROM (v_pop0 -> 'excluded') THEN
    RAISE EXCEPTION 'FAIL 05 left: the excluded breakdown moved for a seat that is not being read at all - not even empty_chairs, because a seat that has been LEFT is not an empty chair, it is not a chair';
  END IF;
  -- And the CENSUS agrees it is gone, which is the one place these two numbers
  -- are supposed to move together.
  IF public.fx_board(v_g) IS DISTINCT FROM (v_tot0 - 1)::bigint THEN
    RAISE EXCEPTION 'FAIL 05 left: the census still counts % seats where the population counts %', public.fx_board(v_g), v_tot0 - 1;
  END IF;
  UPDATE public.table_seats SET left_at = NULL WHERE id = v_seat;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0
     OR (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 THEN
    RAISE EXCEPTION 'FAIL 05 left: coming back left the board at % / %, not % / %',
      v_pop ->> 'live_eligible', v_pop -> 'counted' ->> 'seated_total', v_live0, v_tot0;
  END IF;
  IF (v_pop -> 'excluded') IS DISTINCT FROM (v_pop0 -> 'excluded') THEN
    RAISE EXCEPTION 'FAIL 05: the board did not return to the breakdown it started at';
  END IF;
END $$;
\echo '  ok  05 EVERY EXCLUSION         is_sitting_out leave_pending a zero or NULL stack a NULL user_id and a set left_at each drop live_eligible by exactly one and each comes BACK when it is flipped off again, excluded.sit_out excluded.leaving and excluded.busted each rise by exactly one and fall again while seated_total is UNMOVED by all three because a sitting-out leaving or busted player is still in a chair, an empty chair raises excluded.empty_chairs and lowers seated_total which counts OCCUPIED chairs while the census board count does not move because an empty chair is still a row and is filed as neither sitting out nor leaving nor busted, only left_at takes the seat off the board where the census agrees it has gone and moves no excluded counter at all because a seat that has been left is not a chair, and a NULL is_sitting_out is dealt in while a stack of one cent is not busted'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 06 A HORSE COUNTS EXACTLY LIKE A HUMAN (LAW 10.5) --------------------------
-- THE MOST IMPORTANT SECTION IN THIS FILE.
--
-- server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts pins this
-- twice - once against the tick's worklist ("a horse's seat counts exactly
-- like a human's here; the EXISTS reads every seat") and once against the
-- balancer ("LAW 10.5: a horse is balanced exactly like a human") - and both
-- of those assert that the SQL does not mention is_horse. Neither of them can
-- see a SQL function written after them, and neither of them would notice
-- `AND ts.horse_id IS NULL` appearing in a FILTER in a migration.
--
-- So this is where that appears as a failure. A future agent "fixing" the
-- population by excluding horses - and it will read like a fix, because a
-- horse is not a paying customer - goes red here and nowhere else. The chips
-- are real, the seat is real and the hand is real.
--
-- A horse's chair carries user_id AND horse_id, both naming the canonical
-- occupant profile, because 20260913173936 stamps the one from the other.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_horse uuid; v_seat uuid;
  v_live0 integer; v_h0 integer; v_tot0 integer; v_pop jsonb;
  v_gh uuid; v_mh uuid; i integer;
BEGIN
  SELECT game_id, table_id INTO v_g, v_main FROM board WHERE k = 'plain';
  v_live0 := public.fx_live(v_g);
  v_h0    := public.fx_cnt(v_g, 'horses');
  v_tot0  := public.fx_cnt(v_g, 'seated_total');
  -- NON-VACUITY: there are humans on this board already and no horses yet, so
  -- "the horse counter rose" is about the horse.
  IF (v_live0 > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: the board has no humans on it, so a horse counting like one says nothing';
  END IF;
  IF v_h0 IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 06: the board already reports % horse(s) before one is seated', v_h0;
  END IF;

  v_horse := gen_random_uuid();
  v_seat  := public.fx_seat(v_main, 5, NULL, 200.00, v_horse);

  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 + 1 THEN
    RAISE EXCEPTION 'FAIL 06: LAW 10.5 - seating a horse took live_eligible from % to %, not to %. A horse counts exactly like a human.',
      v_live0, v_pop ->> 'live_eligible', v_live0 + 1;
  END IF;
  IF (v_pop -> 'counted' ->> 'horses')::integer IS DISTINCT FROM v_h0 + 1 THEN
    RAISE EXCEPTION 'FAIL 06: counted.horses reads %, not %. The breakdown REPORTS the composition; it is the threshold that must not care.',
      v_pop -> 'counted' ->> 'horses', v_h0 + 1;
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 + 1
     OR (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM v_live0 + 1 THEN
    RAISE EXCEPTION 'FAIL 06: a horse is on the board but not in seated_total / seated_eligible (% / %)',
      v_pop -> 'counted' ->> 'seated_total', v_pop -> 'counted' ->> 'seated_eligible';
  END IF;

  -- AND IT IS EXCLUDED FOR THE SAME REASONS AND ONLY THOSE. A horse that sits
  -- out stops being dealt in exactly like a human who sits out, which is the
  -- other half of "exactly like": not privileged either.
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 06: a horse that sat out was still dealt in (% of %)', public.fx_live(v_g), v_live0;
  END IF;
  IF public.fx_exc(v_g, 'sit_out') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 06: a horse that sat out was not filed under excluded.sit_out';
  END IF;
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat;
  IF public.fx_live(v_g) IS DISTINCT FROM v_live0 + 1 THEN
    RAISE EXCEPTION 'FAIL 06: a horse that sat back in was not dealt in again';
  END IF;

  -- A BOARD OF NOTHING BUT HORSES REPORTS THE FULL POPULATION. This is the
  -- shape the estate really runs - a Cluster opened and filled by the fleet
  -- before the humans arrive - and it is the shape in which an exclusion of
  -- horses reads zero rather than reading one fewer.
  v_gh := public.fx_cluster('P4 All Horses', 6);
  v_mh := public.fx_table(v_gh, 'main', 1, 6);
  INSERT INTO board (k, game_id, table_id) VALUES ('horses', v_gh, v_mh);
  FOR i IN 1..5 LOOP PERFORM public.fx_seat(v_mh, i, NULL, 200.00, gen_random_uuid()); END LOOP;

  v_pop := public.fx_pop(v_gh);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 06: LAW 10.5 - a board of five horses reports % live eligible, not 5', v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'horses')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 06: a board of five horses reports % of them', v_pop -> 'counted' ->> 'horses';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 5
     OR (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 5
     OR (v_pop -> 'counted' ->> 'seated_main')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 06: a board of five horses reads % seated / % eligible / % on the Main',
      v_pop -> 'counted' ->> 'seated_total', v_pop -> 'counted' ->> 'seated_eligible',
      v_pop -> 'counted' ->> 'seated_main';
  END IF;
  IF public.fx_board(v_gh) IS DISTINCT FROM 5::bigint THEN
    RAISE EXCEPTION 'FAIL 06: the census counts % seats on the all-horse board', public.fx_board(v_gh);
  END IF;
  -- And the verdict reads the same five, so the threshold this number feeds is
  -- fed the horses too.
  IF public.fx_verdict(v_gh, 'live_eligible')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 06: the verdict was handed % live eligible from an all-horse board', public.fx_verdict(v_gh, 'live_eligible');
  END IF;
END $$;
\echo '  ok  06 LAW 10.5 A HORSE COUNTS seating a horse raises live_eligible by exactly one and counted.horses by exactly one and puts it in seated_total and seated_eligible, a horse that sits out is excluded and filed under excluded.sit_out exactly like a human and is dealt back in when it sits back in, and a board of nothing but five horses reports live_eligible 5 with the census counting the same five and the verdict handed the same five - the composition is REPORTED and the threshold does not treat a horse differently from anyone else'

-- 07 WAITLIST AND RESERVED SEATS ARE NOT PLAYERS -----------------------------
-- "Waitlist-only does NOT count." A reserved seat is a HOLD, and the
-- specification lists it as its own category for exactly that reason. Both are
-- REPORTED, so that the headroom to a threshold can be read honestly - a game
-- three short of eighteen with nine waiting is a different situation from one
-- with none - and neither is ever added.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_live0 integer; v_tot0 integer; v_pop jsonb; i integer;
BEGIN
  SELECT game_id, table_id INTO v_g, v_main FROM board WHERE k = 'plain';
  v_live0 := public.fx_live(v_g);
  v_tot0  := public.fx_cnt(v_g, 'seated_total');
  -- NON-VACUITY: a populated board, and both counters at zero before anything
  -- is queued, so a counter that rose is about the row that was inserted.
  IF (v_live0 > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 07: nobody is seated, so "the waitlist changed nothing" is a sentence about nothing';
  END IF;
  IF public.fx_exc(v_g, 'waitlist_only') IS DISTINCT FROM 0
     OR public.fx_exc(v_g, 'reserved_seat') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 07: the board already reports a queue before one exists';
  END IF;

  -- THE GAME WAITLIST. waiting and notified are queued; seated, cancelled and
  -- expired are history and must not be counted even as excluded.
  FOR i IN 1..3 LOOP
    INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
    VALUES (v_g, gen_random_uuid(), 'waiting');
  END LOOP;
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (v_g, gen_random_uuid(), 'notified');
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (v_g, gen_random_uuid(), 'cancelled');
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (v_g, gen_random_uuid(), 'seated');

  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'excluded' ->> 'waitlist_only')::integer IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 07: three waiting and one notified read % under excluded.waitlist_only, not 4 - a cancelled or seated row is history',
      v_pop -> 'excluded' ->> 'waitlist_only';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 07: six waitlist rows moved live_eligible from % to %', v_live0, v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0
     OR (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 07: a waitlist row was counted as a seat';
  END IF;

  -- THE TABLE HOLD. status notified AND the hold still alive.
  INSERT INTO public.table_waitlist (table_id, user_id, status, hold_expires_at)
  VALUES (v_main, gen_random_uuid(), 'notified', clock_timestamp() + interval '1 hour');
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'excluded' ->> 'reserved_seat')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 07: a live hold reads % under excluded.reserved_seat, not 1', v_pop -> 'excluded' ->> 'reserved_seat';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 07: a reserved seat moved live_eligible from % to %', v_live0, v_pop ->> 'live_eligible';
  END IF;

  -- AN EXPIRED HOLD IS NOT RESERVED EITHER. It is not a player and it is not a
  -- hold; it is a row nobody cleaned up. Paired with the live hold above,
  -- which is what stops this being satisfied by a counter that is always zero.
  INSERT INTO public.table_waitlist (table_id, user_id, status, hold_expires_at)
  VALUES (v_main, gen_random_uuid(), 'notified', clock_timestamp() - interval '1 hour');
  -- And a row that is queued but was never notified is not a hold either.
  INSERT INTO public.table_waitlist (table_id, user_id, status, hold_expires_at)
  VALUES (v_main, gen_random_uuid(), 'waiting', clock_timestamp() + interval '1 hour');
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'excluded' ->> 'reserved_seat')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 07: an expired hold or an un-notified queue row was counted as reserved (% of 1)',
      v_pop -> 'excluded' ->> 'reserved_seat';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 07: three table_waitlist rows moved live_eligible from % to %', v_live0, v_pop ->> 'live_eligible';
  END IF;
  -- AND THE CENSUS STILL AGREES ABOUT THE SEATS, because a hold is not a seat
  -- to it either: the board count is untouched by all nine rows.
  IF public.fx_board(v_g) IS DISTINCT FROM v_tot0::bigint THEN
    RAISE EXCEPTION 'FAIL 07: the census board count moved from % to % for a queue', v_tot0, public.fx_board(v_g);
  END IF;
END $$;
\echo '  ok  07 A QUEUE IS NOT A PLAYER four cash_game_waitlist rows in waiting and notified raise excluded.waitlist_only to exactly 4 while a cancelled and a seated row are history and raise nothing, a notified table_waitlist hold whose hold_expires_at is still ahead raises excluded.reserved_seat to 1, an EXPIRED hold and an un-notified queue row raise it no further, and none of the nine rows moves live_eligible seated_total seated_eligible or the census board count by one'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 08 A PENDING MOVER STILL COUNTS --------------------------------------------
-- A move inside a Cluster is not a leave. The player is being carried from one
-- table of this game to another table of the same game, their stack travels
-- with them, and they are dealt in at the far end. The count is REPORTED -
-- pending_movers - because an operator watching a threshold crossing wants to
-- know how much of it is mid-flight, and it is reported under `counted` rather
-- than under `excluded` for the same reason.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_feeder uuid; v_other uuid; v_p uuid; v_q uuid;
  v_live0 integer; v_tot0 integer; v_pop jsonb;
BEGIN
  SELECT game_id, table_id INTO v_g, v_main FROM board WHERE k = 'plain';
  SELECT table_id INTO v_feeder FROM board WHERE k = 'plain_feeder';
  SELECT game_id INTO v_other FROM board WHERE k = 'horses';
  SELECT user_id INTO v_p FROM public.table_seats WHERE table_id = v_main AND seat_number = 2;
  SELECT user_id INTO v_q FROM public.table_seats WHERE table_id = v_main AND seat_number = 3;
  v_live0 := public.fx_live(v_g);
  v_tot0  := public.fx_cnt(v_g, 'seated_total');
  -- NON-VACUITY: two real seated players to move, and nothing mid-flight yet.
  IF v_p IS NULL OR v_q IS NULL THEN
    RAISE EXCEPTION 'FAIL 08: the plain board has nobody to move';
  END IF;
  IF public.fx_cnt(v_g, 'pending_movers') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: % mover(s) are already pending before one is planned', public.fx_cnt(v_g, 'pending_movers');
  END IF;

  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, state)
  VALUES (v_g, v_p, v_main, v_feeder, 'must_move', 'pending');

  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'pending_movers')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 08: one planned move reads % under counted.pending_movers', v_pop -> 'counted' ->> 'pending_movers';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 08: a move inside the Cluster took live_eligible from % to %, and a move inside a Cluster is not a leave',
      v_live0, v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM v_tot0 THEN
    RAISE EXCEPTION 'FAIL 08: a planned move moved seated_total from % to %', v_tot0, v_pop -> 'counted' ->> 'seated_total';
  END IF;
  -- And it is not filed as an exclusion either, which is the other way a
  -- mid-flight player could have been quietly removed.
  IF (v_pop -> 'excluded' ->> 'leaving')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: a planned move was filed under excluded.leaving';
  END IF;

  -- A FINISHED MOVE IS NOT PENDING. The pair that stops counted.pending_movers
  -- being a count of every row in the table.
  INSERT INTO public.cash_seat_moves
    (game_id, player_id, from_table_id, to_table_id, reason, state, executed_at)
  VALUES (v_g, v_q, v_main, v_feeder, 'must_move', 'done', clock_timestamp());
  IF public.fx_cnt(v_g, 'pending_movers') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 08: a move already done was counted as pending (% of 1)', public.fx_cnt(v_g, 'pending_movers');
  END IF;

  -- AND A MOVE IN ANOTHER CLUSTER IS ANOTHER CLUSTER'S. The count is keyed on
  -- game_id and a reader that dropped that predicate would pass everything
  -- above.
  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, state)
  SELECT v_other, gen_random_uuid(), b.table_id, b.table_id, 'seat_change', 'pending'
    FROM board b WHERE b.k = 'horses';
  IF public.fx_cnt(v_g, 'pending_movers') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 08: another Cluster''s pending move was counted here (% of 1)', public.fx_cnt(v_g, 'pending_movers');
  END IF;
  IF public.fx_cnt(v_other, 'pending_movers') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 08: the other Cluster does not report its own pending move';
  END IF;

  -- THE RETURN. Completing the move puts the counter back and leaves the
  -- population exactly where it has been the whole time.
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = clock_timestamp()
   WHERE game_id = v_g AND player_id = v_p AND state = 'pending';
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'pending_movers')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: completing the move left % pending', v_pop -> 'counted' ->> 'pending_movers';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live0 THEN
    RAISE EXCEPTION 'FAIL 08: the population moved while a move was planned and completed (% then %)', v_live0, v_pop ->> 'live_eligible';
  END IF;
END $$;
\echo '  ok  08 A MOVER STILL COUNTS    a cash_seat_moves row in state pending raises counted.pending_movers to 1 and leaves live_eligible seated_total and excluded.leaving exactly where they were because a move inside a Cluster is not a leave, a move already done is not pending, another Cluster pending move is counted there and not here, and completing the move puts the counter back with the population never having moved'

-- 09 THE TABLE PREDICATE IS THE CENSUS'S -------------------------------------
-- "fn_cash_cluster_population uses the census's own TABLE predicate byte for
-- byte - same tables, same exclusions - and narrows only the SEAT predicate."
-- That is a statement about TWO functions, so it is tested by asking both and
-- asserting they agree, rather than by reading one of them. Three ways a table
-- leaves the board, each undone one at a time so that each of the three tests
-- in the predicate is exercised on its own rather than as part of a heap.
DO $$
DECLARE
  v_g uuid; t_ok uuid; t_del uuid; t_closed uuid; t_status uuid;
  v_pop jsonb; i integer;
BEGIN
  v_g      := public.fx_cluster('P4 Table Predicate', 9);
  t_ok     := public.fx_table(v_g, 'main',   1,    9);
  t_del    := public.fx_table(v_g, 'feeder', NULL, 9);
  t_closed := public.fx_table(v_g, 'main',   2,    9);
  t_status := public.fx_table(v_g, 'main',   3,    9);
  INSERT INTO board (k, game_id, table_id) VALUES ('predicate', v_g, t_ok);
  FOR i IN 1..3 LOOP
    PERFORM public.fx_seat(t_ok, i);
    PERFORM public.fx_seat(t_del, i);
    PERFORM public.fx_seat(t_closed, i);
    PERFORM public.fx_seat(t_status, i);
  END LOOP;

  -- NON-VACUITY: all four tables are visible to BOTH readers and all twelve
  -- seats are counted by both, so every disappearance below is a disappearance.
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 4
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 09: four live tables read % to the population and % to the census',
      v_pop ->> 'tables', public.fx_board_tables(v_g);
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 12
     OR public.fx_board(v_g) IS DISTINCT FROM 12::bigint THEN
    RAISE EXCEPTION 'FAIL 09: twelve seats read % to the population and % to the census',
      v_pop -> 'counted' ->> 'seated_total', public.fx_board(v_g);
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 09: twelve ordinary players read % live eligible', v_pop ->> 'live_eligible';
  END IF;

  -- ALL THREE AT ONCE. is_deleted, a closed lifecycle and a status outside the
  -- census's list. The closed table keeps status 'waiting' and the finished
  -- table keeps lifecycle 'live', so neither can be excluded by the other's
  -- test and each of the two really is under test.
  UPDATE public.tables SET is_deleted = true WHERE id = t_del;
  UPDATE public.tables SET lifecycle  = 'closed' WHERE id = t_closed;
  UPDATE public.tables SET status     = 'finished' WHERE id = t_status;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 1
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 09: with three tables off the board the population sees % and the census sees %',
      v_pop ->> 'tables', public.fx_board_tables(v_g);
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 3
     OR public.fx_board(v_g) IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL 09: nine invisible seats: the population counts % and the census counts %',
      v_pop -> 'counted' ->> 'seated_total', public.fx_board(v_g);
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 09: seats on a deleted, closed or finished table were dealt in (% of 3)', v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop ->> 'capacity')::integer IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'FAIL 09: the capacity of one nine-handed table reads %', v_pop ->> 'capacity';
  END IF;

  -- AND EACH ONE BACK, ONE AT A TIME. Each undo is the ACCEPT that pairs with
  -- one of the three tests: a predicate missing any one of them stays green on
  -- the combined assertion above and goes red on exactly one line here.
  UPDATE public.tables SET is_deleted = false WHERE id = t_del;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 2
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 6
     OR public.fx_board(v_g) IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL 09 is_deleted: undeleting the table gave the population % table(s) / % seat(s) and the census % / %',
      v_pop ->> 'tables', v_pop -> 'counted' ->> 'seated_total',
      public.fx_board_tables(v_g), public.fx_board(v_g);
  END IF;
  UPDATE public.tables SET lifecycle = 'live' WHERE id = t_closed;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 3
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 3
     OR (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 9
     OR public.fx_board(v_g) IS DISTINCT FROM 9::bigint THEN
    RAISE EXCEPTION 'FAIL 09 lifecycle: reopening the table gave the population % table(s) / % seat(s) and the census % / %',
      v_pop ->> 'tables', v_pop -> 'counted' ->> 'seated_total',
      public.fx_board_tables(v_g), public.fx_board(v_g);
  END IF;
  UPDATE public.tables SET status = 'running' WHERE id = t_status;
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'tables')::integer IS DISTINCT FROM 4
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 4
     OR (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 12
     OR public.fx_board(v_g) IS DISTINCT FROM 12::bigint THEN
    RAISE EXCEPTION 'FAIL 09 status: a running table gave the population % table(s) / % seat(s) and the census % / %',
      v_pop ->> 'tables', v_pop -> 'counted' ->> 'seated_total',
      public.fx_board_tables(v_g), public.fx_board(v_g);
  END IF;
  -- 'active' is the third status the census admits and is asked about too, so
  -- that a predicate narrowed to two of the three is caught.
  UPDATE public.tables SET status = 'active' WHERE id = t_status;
  IF (public.fx_pop(v_g) ->> 'tables')::integer IS DISTINCT FROM 4
     OR public.fx_board_tables(v_g) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 09 status: an active table is not on the board';
  END IF;

  -- THE AGREEMENT, SAID ONCE MORE ACROSS EVERY BOARD THIS FILE HAS BUILT. Not
  -- just this cluster: any cluster where the two predicates had diverged would
  -- show up as a disagreement here.
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE (public.fx_pop(g.id) ->> 'tables')::integer
                    IS DISTINCT FROM public.fx_board_tables(g.id)) THEN
    RAISE EXCEPTION 'FAIL 09: some cluster''s population and census disagree about how many tables the game has';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE (public.fx_pop(g.id) -> 'counted' ->> 'seated_total')::integer::bigint
                    IS DISTINCT FROM public.fx_board(g.id)) THEN
    RAISE EXCEPTION 'FAIL 09: some cluster''s population and census disagree about how many seats are occupied';
  END IF;
END $$;
\echo '  ok  09 THE CENSUS PREDICATE    three seated tables taken off the board one by is_deleted one by lifecycle closed and one by a status outside waiting running active become invisible to the population AND to fn_cash_cluster_census together - four tables and twelve seats to both before, one and three to both after - each of the three is undone on its own and both readers come back together, an active table is on the board, and across EVERY cluster this file has built the two agree on the table count and on the seat total'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 10 THE POPULATION IS NEVER LARGER THAN THE BOARD COUNT ---------------------
-- The board count answers "how many players are in this game" and the
-- population answers "how many players could Lightning deal to right now". The
-- second is the first with a narrower SEAT predicate over the same tables, so
-- it can never exceed it.
--
-- BOTH HALVES OR THE STATEMENT IS EMPTY. `seated_eligible <= board` is
-- satisfied by a function that always answers zero, so the section also
-- asserts that with NO exclusion present the two are EQUAL, and that with one
-- present the inequality is STRICT. Together those say the narrowing narrows
-- exactly what it claims to and nothing else.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_feeder uuid; v_pop jsonb; v_board bigint;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid;
BEGIN
  v_g      := public.fx_cluster('P4 Narrowing', 9);
  v_main   := public.fx_table(v_g, 'main', 1, 9);
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 9);
  INSERT INTO board (k, game_id, table_id) VALUES ('narrow', v_g, v_main);
  PERFORM public.fx_populate(v_g, 10);

  -- HALF ONE: nothing is excluded, so the two numbers are the SAME number. A
  -- population that always answered zero fails here and only here.
  v_pop   := public.fx_pop(v_g);
  v_board := public.fx_board(v_g);
  IF v_board IS DISTINCT FROM 10::bigint THEN
    RAISE EXCEPTION 'FAIL 10: the census counts % of the ten seats that were made', v_board;
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer::bigint IS DISTINCT FROM v_board THEN
    RAISE EXCEPTION 'FAIL 10: with nothing excluded the population counts % where the board counts %, and with nothing excluded they are the same number',
      v_pop -> 'counted' ->> 'seated_eligible', v_board;
  END IF;

  -- HALF TWO: one of each exclusion, and the inequality becomes STRICT while
  -- the board does not move at all.
  SELECT id INTO s1 FROM public.table_seats WHERE table_id = v_main AND seat_number = 1;
  SELECT id INTO s2 FROM public.table_seats WHERE table_id = v_main AND seat_number = 2;
  SELECT id INTO s3 FROM public.table_seats WHERE table_id = v_main AND seat_number = 3;
  SELECT id INTO s4 FROM public.table_seats WHERE table_id = v_main AND seat_number = 4;
  SELECT id INTO s5 FROM public.table_seats WHERE table_id = v_main AND seat_number = 5;
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = s1;
  UPDATE public.table_seats SET leave_pending  = true WHERE id = s2;
  UPDATE public.table_seats SET stack          = 0    WHERE id = s3;
  UPDATE public.table_seats SET user_id        = NULL WHERE id = s4;
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status) VALUES (v_g, gen_random_uuid(), 'waiting');
  INSERT INTO public.table_waitlist (table_id, user_id, status, hold_expires_at)
  VALUES (v_main, gen_random_uuid(), 'notified', clock_timestamp() + interval '1 hour');

  v_pop   := public.fx_pop(v_g);
  v_board := public.fx_board(v_g);
  IF v_board IS DISTINCT FROM 10::bigint THEN
    RAISE EXCEPTION 'FAIL 10: four exclusions and a queue took the BOARD count to %, and the board counts them all', v_board;
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 10: ten seats with four exclusions read % eligible, not 6', v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF ((v_pop -> 'counted' ->> 'seated_eligible')::integer::bigint <= v_board) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: the population (%) is larger than the board (%)', v_pop -> 'counted' ->> 'seated_eligible', v_board;
  END IF;
  IF ((v_pop -> 'counted' ->> 'seated_eligible')::integer::bigint < v_board) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: with four exclusions present the population (%) is not STRICTLY below the board (%), so the narrowing narrowed nothing',
      v_pop -> 'counted' ->> 'seated_eligible', v_board;
  END IF;

  -- HALF THREE: taking every exclusion away brings them back to equal. The
  -- strict inequality above was about the exclusions and not about the shape
  -- of the board.
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = s1;
  UPDATE public.table_seats SET leave_pending  = false WHERE id = s2;
  UPDATE public.table_seats SET stack          = 200.00 WHERE id = s3;
  UPDATE public.table_seats SET user_id        = gen_random_uuid() WHERE id = s4;
  v_pop   := public.fx_pop(v_g);
  v_board := public.fx_board(v_g);
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer::bigint IS DISTINCT FROM v_board THEN
    RAISE EXCEPTION 'FAIL 10: with the exclusions undone the population (%) and the board (%) are not the same number again',
      v_pop -> 'counted' ->> 'seated_eligible', v_board;
  END IF;
  -- The queue and the hold are still there and still change nothing, which is
  -- what says they were never in the narrowing at all.
  IF public.fx_exc(v_g, 'waitlist_only') IS DISTINCT FROM 1
     OR public.fx_exc(v_g, 'reserved_seat') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 10: the queue and the hold stopped being reported once the seats came back';
  END IF;

  -- AND THE FOUR-TERM IDENTITY HOLDS. The scalar takes ONE count(DISTINCT)
  -- over the UNION of the two halves, so a human who is in both is one player;
  -- the breakdown reports the halves separately, reports the overlap, and
  -- reports the disconnect count it was handed:
  --
  --   GREATEST(0, seated_eligible + lightning_eligible - seated_and_pooled
  --                 - counted.disconnected)  =  live_eligible
  --
  -- FOUR TERMS AND NOT THREE. live_eligible subtracts the disconnect count and
  -- the three counted figures do not, so the three-term form is true only on
  -- the p_disconnected IS NULL path - which is every path today and none of
  -- them from spec Phase 14 onward. That is the ONE place arithmetic is
  -- promised in this answer: the file's own breakdown_is_not_arithmetic is
  -- about the CATEGORIES under `excluded`, not about these four. Section 20 is
  -- where the overlap term AND the disconnect term are both made non-zero, on
  -- the same board, which is the combination nothing else exercises.
  v_pop := public.fx_pop(v_g);
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 10: seated_eligible % plus lightning_eligible % less seated_and_pooled % less disconnected % is not live_eligible %',
      v_pop -> 'counted' ->> 'seated_eligible', v_pop -> 'counted' ->> 'lightning_eligible',
      v_pop -> 'counted' ->> 'seated_and_pooled', v_pop -> 'counted' ->> 'disconnected',
      v_pop ->> 'live_eligible';
  END IF;
  -- On EVERY board this file has built, not only this one, and at a disconnect
  -- count as well as at none. Three of the four terms are still zero everywhere
  -- at this point - no pool until section 11, no overlap until section 20 - and
  -- both of those sections ask the same identity again once their term is real.
  IF EXISTS (SELECT 1 FROM public.cash_games g
              CROSS JOIN LATERAL (SELECT public.fx_pop(g.id) AS p) x
              WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer
                                + (x.p -> 'counted' ->> 'lightning_eligible')::integer
                                - (x.p -> 'counted' ->> 'seated_and_pooled')::integer
                                - (x.p -> 'counted' ->> 'disconnected')::integer)
                    IS DISTINCT FROM (x.p ->> 'live_eligible')::integer) THEN
    RAISE EXCEPTION 'FAIL 10: some cluster''s four reported terms do not give its live_eligible on the p_disconnected IS NULL path';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games g
              CROSS JOIN LATERAL (SELECT public.fx_pop(g.id, 2) AS p) x
              WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer
                                + (x.p -> 'counted' ->> 'lightning_eligible')::integer
                                - (x.p -> 'counted' ->> 'seated_and_pooled')::integer
                                - (x.p -> 'counted' ->> 'disconnected')::integer)
                    IS DISTINCT FROM (x.p ->> 'live_eligible')::integer) THEN
    RAISE EXCEPTION 'FAIL 10: some cluster''s four reported terms do not give its live_eligible at p_disconnected := 2';
  END IF;

  -- HALF FOUR: one exclusion is put back and LEFT there, so that the estate
  -- sweep below runs over an estate in which at least one board really does
  -- narrow. Without it the sweep would be asserting <= across boards where =
  -- was never in doubt, which is the vacuity this whole section is about.
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = s5;
  v_pop   := public.fx_pop(v_g);
  v_board := public.fx_board(v_g);
  IF ((v_pop -> 'counted' ->> 'seated_eligible')::integer::bigint < v_board) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: one sitting-out player among ten left the population (%) at the board count (%)',
      v_pop -> 'counted' ->> 'seated_eligible', v_board;
  END IF;

  -- AND ACROSS EVERY BOARD THIS FILE HAS BUILT. The migration's own post-apply
  -- block asserts this over a fresh estate where every cluster is empty; here
  -- it is asserted over boards that really have sitting-out, leaving, busted
  -- and empty chairs on them.
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE ((public.fx_pop(g.id) -> 'counted' ->> 'seated_eligible')::integer::bigint
                     <= public.fx_board(g.id)) IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'FAIL 10: some cluster reports more eligible seats than the board counts seats at all';
  END IF;
  -- And at least one of those clusters is one where the two DIFFER, so the
  -- sweep above is not a sweep over boards that are all equal anyway.
  IF NOT EXISTS (SELECT 1 FROM public.cash_games g
                  WHERE (public.fx_pop(g.id) -> 'counted' ->> 'seated_eligible')::integer::bigint
                        < public.fx_board(g.id)) THEN
    RAISE EXCEPTION 'FAIL 10: no cluster in the estate has an excluded seat, so the sweep proved <= over boards where = was never in doubt';
  END IF;
END $$;
\echo '  ok  10 NEVER LARGER            with nothing excluded the population and the census board count are the SAME number, with a sitting-out a leaving a busted and an empty chair among ten they are 6 and 10 - strictly less, with the board itself unmoved because the board counts all four seat rows - undoing the four makes them equal again while the queue and the hold are still reported and still outside, the four-term identity GREATEST of zero and seated_eligible plus lightning_eligible less seated_and_pooled less counted.disconnected is EXACTLY live_eligible on this board and on every cluster this file has built at p_disconnected NULL and at 2, and seated_eligible <= the board count everywhere with at least one cluster where it is strictly below'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 11 THE LIGHTNING HALF ------------------------------------------------------
-- Empty during MUST_MOVE and authoritative during LIGHTNING, where the
-- physical seats are the ones that are empty. A Lightning player is not in a
-- table_seats row at all, so the population adds a second term: the pool
-- sessions that are ACTIVE, at THIS cluster, at THIS epoch, and not exited.
--
-- Per-hand state is DERIVED rather than stored - 20260920235343 settled that,
-- because one column cannot say that a multi-tabling player is in a hand at
-- one table and idle at another - so in_instance comes from a committed
-- reservation naming a LIVE instance and in_hand from a participation in an
-- UNSETTLED hand. Both of those are two-sided, and both sides are asserted:
-- the live instance raises it and the completed one does not, the unsettled
-- hand raises it and the settled one does not.
CREATE TEMP TABLE pool (k text PRIMARY KEY, game_id uuid, player_id uuid, session_id uuid, slot_id uuid);

CREATE FUNCTION public.fx_pool_session(p_game uuid, p_k text,
                                       p_state text DEFAULT 'active',
                                       p_exited boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE g record; v_table uuid; v_player uuid; v_cs uuid; v_id uuid; v_slot uuid;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game;
  SELECT tb.id INTO v_table FROM public.tables tb
   WHERE tb.cluster_id = p_game ORDER BY tb.created_at, tb.id LIMIT 1;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: cluster % has no table for a cash session to name', p_game;
  END IF;
  v_player := gen_random_uuid();
  -- The continuous economic identity the pool session is subordinate to.
  -- lightning_pool_session.cash_player_session_id is deliberately NOT a
  -- foreign key, so this row is written out of honesty rather than necessity:
  -- a pool session pointing at nothing is a shape the estate never makes.
  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, cluster_id, variant, sb, bb)
  VALUES (v_player, g.club_id, 'cluster', p_game, v_table, p_game, g.variant, g.sb, g.bb)
  RETURNING id INTO v_cs;
  INSERT INTO public.lightning_pool_session
    (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, exited_at, exit_reason)
  VALUES (p_game, g.cluster_epoch, v_player, v_cs, p_state,
          CASE WHEN p_exited THEN clock_timestamp() + interval '1 second' END,
          CASE WHEN p_exited THEN 'fixture' END)
  RETURNING id INTO v_id;
  INSERT INTO public.lightning_pool_slot (pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES (v_id, p_game, g.cluster_epoch, v_player, 1)
  RETURNING id INTO v_slot;
  INSERT INTO pool (k, game_id, player_id, session_id, slot_id)
  VALUES (p_k, p_game, v_player, v_id, v_slot);
  RETURN v_id;
END $fx$;

CREATE FUNCTION public.fx_instance(p_game uuid, p_state text)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid; v_epoch integer;
BEGIN
  SELECT cluster_epoch INTO v_epoch FROM public.cash_games WHERE id = p_game;
  INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, state, target_size, max_size)
  VALUES (p_game, v_epoch, p_state, 2, 9) RETURNING id INTO v_id;
  RETURN v_id;
END $fx$;

DO $$
DECLARE
  v_g uuid; v_main uuid; v_pop jsonb;
  v_live integer; i integer;
  v_inst_live uuid; v_inst_done uuid; v_inst_2 uuid; v_inst_3 uuid;
  v_hand uuid; v_hand2 uuid;
  a record; f record; gg record;
BEGIN
  v_g    := public.fx_cluster('P4 Lightning Half', 9);
  v_main := public.fx_table(v_g, 'main', 1, 9);
  INSERT INTO board (k, game_id, table_id) VALUES ('pool', v_g, v_main);
  -- TWO PHYSICAL PLAYERS, so that live_eligible is visibly the SUM of the two
  -- halves rather than whichever half happens to be non-zero.
  FOR i IN 1..2 LOOP PERFORM public.fx_seat(v_main, i); END LOOP;

  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'lightning_total')::integer IS DISTINCT FROM 0
     OR (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 0
     OR (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 0
     OR (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 0
     OR (v_pop -> 'counted' ->> 'lightning_in_hand')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: a MUST_MOVE cluster with two seated players and no pool reads %', v_pop -> 'counted';
  END IF;

  -- ONE ACTIVE POOL SESSION. It is a player Lightning could deal to, so it is
  -- in the population, and it is idle because nothing holds it yet.
  PERFORM public.fx_pool_session(v_g, 'A', 'active');
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: one active pool session reads % lightning_eligible', v_pop -> 'counted' ->> 'lightning_eligible';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 11: two seated plus one active pool session reads % live eligible, not 3', v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: an active session holding nothing reads % idle', v_pop -> 'counted' ->> 'lightning_idle';
  END IF;

  -- THE STATES THAT ARE NOT ACTIVE. Each is a participation - it is in
  -- lightning_total, because the player is in the pool - and none of them is a
  -- player Lightning can deal to.
  PERFORM public.fx_pool_session(v_g, 'sit_out',  'sit_out');
  PERFORM public.fx_pool_session(v_g, 'leaving',  'leaving');
  PERFORM public.fx_pool_session(v_g, 'closed',   'closed');
  PERFORM public.fx_pool_session(v_g, 'joining',  'joining');
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_total')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 11: five open pool sessions read % lightning_total', v_pop -> 'counted' ->> 'lightning_total';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: sit_out leaving closed or joining was counted as eligible (% of 1)',
      v_pop -> 'counted' ->> 'lightning_eligible';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 11: four non-active pool sessions moved live_eligible to %', v_pop ->> 'live_eligible';
  END IF;

  -- AN EXITED SESSION IS NOT IN THE POOL AT ALL, even in state active: the
  -- filter is `exited_at IS NULL` and a participation that has ended is a
  -- record, not a player.
  PERFORM public.fx_pool_session(v_g, 'exited', 'active', true);
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_total')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 11: an exited session was counted in lightning_total (% of 5)', v_pop -> 'counted' ->> 'lightning_total';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1
     OR (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 11: an exited session in state active was dealt in';
  END IF;

  -- A SECOND ACTIVE SESSION, so that the two counters below can differ: with
  -- one of them everything is either all-idle or all-held.
  PERFORM public.fx_pool_session(v_g, 'F', 'active');
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 4
     OR (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 11: a second active session reads % / % / %',
      v_pop -> 'counted' ->> 'lightning_eligible', v_pop ->> 'live_eligible',
      v_pop -> 'counted' ->> 'lightning_idle';
  END IF;

  SELECT * INTO a FROM pool WHERE k = 'A';
  SELECT * INTO f FROM pool WHERE k = 'F';

  -- A COMMITTED HOLD ON A LIVE INSTANCE. in_instance rises and idle falls, and
  -- the population itself does not move - being in an instance is a thing an
  -- eligible player is doing, not a reason to stop counting them.
  v_inst_live := public.fx_instance(v_g, 'dealing');
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
     seat_number, state, expires_at, resolved_at)
  VALUES (v_g, 0, a.player_id, a.slot_id, v_inst_live, 1, 'committed',
          clock_timestamp() + interval '5 minutes', clock_timestamp());
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a committed hold on a dealing instance reads % in_instance', v_pop -> 'counted' ->> 'lightning_in_instance';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: two eligible with one held reads % idle, not 1', v_pop -> 'counted' ->> 'lightning_idle';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 11: being in an instance took a player out of the population (% of 4)', v_pop ->> 'live_eligible';
  END IF;

  -- AND A COMMITTED HOLD ON AN INSTANCE THAT IS OVER IS NOT IN AN INSTANCE.
  -- The pair that stops in_instance being a count of every committed row.
  v_inst_done := public.fx_instance(v_g, 'complete');
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
     seat_number, state, expires_at, resolved_at)
  VALUES (v_g, 0, f.player_id, f.slot_id, v_inst_done, 1, 'committed',
          clock_timestamp() + interval '5 minutes', clock_timestamp());
  IF public.fx_cnt(v_g, 'lightning_in_instance') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a hold on a COMPLETE instance was counted in_instance (% of 1)',
      public.fx_cnt(v_g, 'lightning_in_instance');
  END IF;

  IF public.fx_cnt(v_g, 'lightning_idle') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a hold on a COMPLETE instance took its holder out of idle (% of 1)',
      public.fx_cnt(v_g, 'lightning_idle');
  END IF;

  -- AND A HOLD THAT IS ONLY PENDING IS NOT COMMITTED. A matcher hold that has
  -- not resolved is not a seat at a table. Asked of a THIRD ACTIVE player, not
  -- of one of the four non-active sessions: in_instance now requires the holder
  -- to have an active un-exited pool session, so a pending hold belonging to a
  -- sit_out or joining player would be refused by that predicate instead and
  -- the `state = ''committed''` test would never be reached.
  PERFORM public.fx_pool_session(v_g, 'G', 'active');
  SELECT * INTO gg FROM pool WHERE k = 'G';
  IF public.fx_cnt(v_g, 'lightning_eligible') IS DISTINCT FROM 3
     OR public.fx_live(v_g) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 11: a third active session reads % eligible and % live',
      public.fx_cnt(v_g, 'lightning_eligible'), public.fx_live(v_g);
  END IF;
  v_inst_2 := public.fx_instance(v_g, 'forming');
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
     seat_number, state, expires_at)
  VALUES (v_g, 0, gg.player_id, gg.slot_id, v_inst_2, 2, 'pending',
          clock_timestamp() + interval '5 minutes');
  IF public.fx_cnt(v_g, 'lightning_in_instance') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a PENDING hold by an ACTIVE player was counted in_instance (% of 1)',
      public.fx_cnt(v_g, 'lightning_in_instance');
  END IF;
  IF public.fx_cnt(v_g, 'lightning_idle') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 11: a player holding only a PENDING reservation stopped being idle (% of 2)',
      public.fx_cnt(v_g, 'lightning_idle');
  END IF;

  -- A PARTICIPATION IN AN UNSETTLED HAND.
  v_hand := gen_random_uuid();
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
  VALUES (v_hand, v_g, 0, v_inst_live);
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch)
  VALUES (v_hand, a.player_id, a.slot_id, 1, v_g, 0);
  IF public.fx_cnt(v_g, 'lightning_in_hand') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a player in an unsettled hand reads % in_hand', public.fx_cnt(v_g, 'lightning_in_hand');
  END IF;
  IF public.fx_live(v_g) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 11: being in a hand took a player out of the population (% of 5)', public.fx_live(v_g);
  END IF;

  -- AND A SETTLED HAND IS OVER. The pair.
  v_inst_3 := public.fx_instance(v_g, 'settling');
  v_hand2  := gen_random_uuid();
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id, settled_at)
  VALUES (v_hand2, v_g, 0, v_inst_3, clock_timestamp() + interval '1 second');
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch)
  VALUES (v_hand2, f.player_id, f.slot_id, 2, v_g, 0);
  IF public.fx_cnt(v_g, 'lightning_in_hand') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 11: a participation in a SETTLED hand was counted in_hand (% of 1)',
      public.fx_cnt(v_g, 'lightning_in_hand');
  END IF;

  -- THE IDENTITY, WITH BOTH HALVES NON-ZERO AND NO OVERLAP. Section 10
  -- asserted it across the estate while the Lightning term was zero; here both
  -- halves are real and the two populations are DISJOINT - different humans in
  -- each - so the third term is zero and the identity reduces to the sum.
  -- Section 20 is where the third term is made non-zero, which is the case the
  -- UNION in the scalar exists for.
  v_pop := public.fx_pop(v_g);
  IF ((v_pop -> 'counted' ->> 'seated_eligible')::integer > 0
      AND (v_pop -> 'counted' ->> 'lightning_eligible')::integer > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: one of the two halves is zero (seated % / lightning %), so their sum proves nothing',
      v_pop -> 'counted' ->> 'seated_eligible', v_pop -> 'counted' ->> 'lightning_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the seated and pooled players on this board were meant to be different humans, and % of them are the same',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer
     IS DISTINCT FROM GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                                  + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                                  - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                                  - (v_pop -> 'counted' ->> 'disconnected')::integer) THEN
    RAISE EXCEPTION 'FAIL 11: live_eligible % is not seated_eligible % plus lightning_eligible % less seated_and_pooled % less disconnected %',
      v_pop ->> 'live_eligible', v_pop -> 'counted' ->> 'seated_eligible',
      v_pop -> 'counted' ->> 'lightning_eligible', v_pop -> 'counted' ->> 'seated_and_pooled',
      v_pop -> 'counted' ->> 'disconnected';
  END IF;
  -- And the seated half really is the seats: the same board read with the
  -- Lightning sessions ignored is exactly seated_eligible.
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 11: the two chairs on this board read % as the seated half', v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF ((v_pop ->> 'live_eligible')::integer
      <= (v_pop -> 'counted' ->> 'seated_total')::integer
         + (v_pop -> 'counted' ->> 'lightning_total')::integer) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: the population is larger than the rows it was computed from';
  END IF;

  -- ANOTHER CLUSTER'S POOL IS ANOTHER CLUSTER'S. Every one of the five reads
  -- above is keyed on cluster_id AND cluster_epoch, and a reader that dropped
  -- either would pass everything up to here.
  IF public.fx_cnt((SELECT game_id FROM board WHERE k = 'plain'), 'lightning_total') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the plain board reports a Lightning pool it does not have';
  END IF;
END $$;
\echo '  ok  11 THE LIGHTNING HALF      an active lightning_pool_session raises lightning_eligible and live_eligible together while sit_out leaving closed and joining raise lightning_total and nothing else and an exited session in state active raises neither, a committed lightning_reservation naming a forming reserved dealing or settling instance raises lightning_in_instance and takes its holder out of lightning_idle without moving the population, a hold on a COMPLETE instance and a merely PENDING hold by a THIRD ACTIVE player raise in_instance not at all and leave their holders idle, a lightning_hand_player on an UNSETTLED hand raises lightning_in_hand while one on a settled hand does not, live_eligible is exactly seated_eligible plus lightning_eligible and never exceeds seated_total plus lightning_total, and another cluster pool is counted there and not here'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 12 WHAT IS NOT KNOWN IS NAMED ----------------------------------------------
-- The specification names thirteen categories and four of them have no
-- representation in PostgreSQL at all: the disconnect FSM lives in
-- DisconnectEngine's memory, expired disconnects are the same one state
-- further on, ghost BB is stored nowhere by design, and live_viewers holds
-- zero rows and is referenced by no source file. So every answer carries the
-- list and says `partial` for as long as it is not empty.
--
-- p_disconnected is the seam spec Phase 14 fills. Passing it moves
-- 'disconnected' out of the list, flips confidence to 'engine', and subtracts.
-- The list is asserted as a WHOLE ARRAY and not by length, because a rename or
-- a reorder is exactly the kind of drift a length check sleeps through.
DO $$
DECLARE v_g uuid; v_live integer; v_pop jsonb;
BEGIN
  SELECT game_id INTO v_g FROM board WHERE k = 'pool';
  v_live := public.fx_live(v_g);
  -- NON-VACUITY: there is a population to subtract from, and it is at least
  -- three, or "three lower" would be indistinguishable from the clamp at zero.
  IF (v_live >= 3) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: the cluster reads % live eligible, so subtracting three cannot be told apart from the clamp at zero', v_live;
  END IF;

  -- NOBODY SAID. Four unknowns, in order, and partial.
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'unknown') IS DISTINCT FROM
     '["disconnected", "expired_disconnect", "ghost_bb", "watching"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 12: with no p_disconnected the unknown list is %', v_pop -> 'unknown';
  END IF;
  IF (v_pop ->> 'confidence') IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'FAIL 12: with four unknowns the confidence is %, not partial', v_pop ->> 'confidence';
  END IF;
  IF (v_pop -> 'counted' ->> 'disconnected')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 12: with nobody saying, counted.disconnected reads %', v_pop -> 'counted' ->> 'disconnected';
  END IF;
  -- And the one reader carries the same word through to the verdict, which is
  -- what a Phase 5 conversion would act on.
  IF public.fx_verdict(v_g, 'confidence') IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'FAIL 12: the verdict reports confidence %, not partial', public.fx_verdict(v_g, 'confidence');
  END IF;

  -- THE ENGINE SAID THREE.
  v_pop := public.fx_pop(v_g, 3);
  IF (v_pop -> 'unknown') IS DISTINCT FROM '["ghost_bb", "watching"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 12: with p_disconnected the unknown list is %, not exactly ghost_bb and watching', v_pop -> 'unknown';
  END IF;
  IF (v_pop ->> 'confidence') IS DISTINCT FROM 'engine' THEN
    RAISE EXCEPTION 'FAIL 12: with the engine answering, confidence reads %', v_pop ->> 'confidence';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live - 3 THEN
    RAISE EXCEPTION 'FAIL 12: three disconnects took % to %, not to %', v_live, v_pop ->> 'live_eligible', v_live - 3;
  END IF;
  IF (v_pop -> 'counted' ->> 'disconnected')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 12: counted.disconnected reads %, not the 3 it was handed', v_pop -> 'counted' ->> 'disconnected';
  END IF;
  -- The two halves the subtraction came out of are UNMOVED: the disconnect is
  -- taken off the total, not out of the seat count.
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer
     IS DISTINCT FROM (public.fx_pop(v_g) -> 'counted' ->> 'seated_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected changed how many seats were counted';
  END IF;

  -- ZERO IS AN ANSWER. "Nobody is disconnected" is knowledge, and it is not
  -- the same as nobody having said.
  v_pop := public.fx_pop(v_g, 0);
  IF (v_pop ->> 'confidence') IS DISTINCT FROM 'engine' THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected := 0 reads confidence %, and zero is an answer', v_pop ->> 'confidence';
  END IF;
  IF (v_pop -> 'unknown') IS DISTINCT FROM '["ghost_bb", "watching"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected := 0 left the unknown list at %', v_pop -> 'unknown';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected := 0 took the population to %, not %', v_pop ->> 'live_eligible', v_live;
  END IF;

  -- A NEGATIVE IS CLAMPED TO ZERO rather than ADDING to the population, which
  -- is what an unguarded subtraction of a negative would do.
  v_pop := public.fx_pop(v_g, -4);
  IF (v_pop -> 'counted' ->> 'disconnected')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected := -4 reports % disconnected', v_pop -> 'counted' ->> 'disconnected';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM v_live THEN
    RAISE EXCEPTION 'FAIL 12: p_disconnected := -4 took the population to %, not %', v_pop ->> 'live_eligible', v_live;
  END IF;
  IF (v_pop ->> 'confidence') IS DISTINCT FROM 'engine' THEN
    RAISE EXCEPTION 'FAIL 12: a negative p_disconnected is still an answer and reads confidence %', v_pop ->> 'confidence';
  END IF;

  -- AND MORE DISCONNECTS THAN PLAYERS IS ZERO, not a negative population that
  -- a threshold comparison would then read as "far below OFF".
  v_pop := public.fx_pop(v_g, v_live + 95);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 12: more disconnects than players reads % live eligible', v_pop ->> 'live_eligible';
  END IF;
END $$;
\echo '  ok  12 WHAT IS NOT KNOWN       with no p_disconnected the unknown list is exactly the four names disconnected expired_disconnect ghost_bb and watching in that order and confidence reads partial through to the verdict, p_disconnected := 3 makes it exactly ghost_bb and watching under confidence engine with live_eligible three lower counted.disconnected at 3 and the seat counts unmoved, p_disconnected := 0 is still engine and subtracts nothing, a negative is clamped to zero rather than ADDED, and more disconnects than players reads zero rather than a negative population'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 13 THE VERDICT -------------------------------------------------------------
-- SPEC ACCEPTANCE TESTS F02, F03, F09 AND F10, AND THE PHASE 10 LADDER.
--
--   F02 / F03   6-max 18 => pending Lightning conversion.
--               6-max 17 => remain MUST-MOVE.
--   F09 / F10   9-max 27 => pending Lightning conversion.
--               9-max 26 => remain MUST-MOVE.
--
-- The asymmetry is the specification's: ON is ">= the ON threshold" and OFF is
-- "<= the OFF threshold", which is what makes 12 pending-off on a 6-max game
-- and 13 not. Both comparisons are asked at their boundary and at one either
-- side of it, because a `>` where a `>=` belongs is right on every rung of the
-- ladder except the one that matters.
--
-- Nothing here converts anything: the verdict is descriptive and spec Phase 5
-- is what acts on it. Section 15 proves that by reading every mode back.
DO $$
DECLARE
  v_a uuid; v_b uuid; v_c uuid; r record; v_n integer := 0; v_state jsonb;
BEGIN
  -- THE SIX-MAX LADDER. Four tables of six, because a six-max Cluster's tables
  -- seat six and eighteen players do not fit on two of them.
  v_a := public.fx_cluster('P4 Ladder Six', 6, true, 'must_move', true);
  PERFORM public.fx_table(v_a, 'main',   1,    6);
  PERFORM public.fx_table(v_a, 'feeder', NULL, 6);
  PERFORM public.fx_table(v_a, 'main',   2,    6);
  PERFORM public.fx_table(v_a, 'main',   3,    6);
  INSERT INTO board (k, game_id) VALUES ('ladder_six', v_a);

  -- THE FULL-RING LADDER.
  v_b := public.fx_cluster('P4 Ladder Ring', 9, true, 'must_move', true);
  PERFORM public.fx_table(v_b, 'main',   1,    9);
  PERFORM public.fx_table(v_b, 'feeder', NULL, 9);
  PERFORM public.fx_table(v_b, 'main',   2,    9);
  INSERT INTO board (k, game_id) VALUES ('ladder_ring', v_b);

  -- AND THE ONE THAT IS ALREADY ON, which is the only Cluster that can turn
  -- OFF. Created in cluster_mode lightning, so that is what section 15 will
  -- expect it to still be.
  v_c := public.fx_cluster('P4 Ladder Off', 6, true, 'lightning', true);
  PERFORM public.fx_table(v_c, 'main',   1,    6);
  PERFORM public.fx_table(v_c, 'feeder', NULL, 6);
  PERFORM public.fx_table(v_c, 'main',   2,    6);
  INSERT INTO board (k, game_id) VALUES ('ladder_off', v_c);

  FOR r IN SELECT * FROM (VALUES
      -- cluster, players, would_turn_on, to_on, would_turn_off, to_off, label
      ('six',  17, false, 1, false, 5, 'F02/F03 six-max 17 remains MUST-MOVE'),
      ('six',  18, true,  0, false, 6, 'F02/F03 six-max 18 is pending Lightning'),
      ('six',  19, true,  0, false, 7, 'the ladder does not stop at the rung'),
      ('ring', 26, false, 1, false, 8, 'F09/F10 full-ring 26 remains MUST-MOVE'),
      ('ring', 27, true,  0, false, 9, 'F09/F10 full-ring 27 is pending Lightning'),
      ('off',  13, false, 5, false, 1, 'Phase 10 ladder: 13 on a six-max is not pending-off'),
      ('off',  12, false, 6, true,  0, 'Phase 10 ladder: 12 on a six-max IS pending-off'),
      ('off',  11, false, 7, true,  0, 'Phase 10 ladder: below the OFF threshold stays pending-off')
      ) AS w(which, players, want_on, to_on, want_off, to_off, label)
  LOOP
    v_n := v_n + 1;
    PERFORM public.fx_populate(
      CASE r.which WHEN 'six' THEN v_a WHEN 'ring' THEN v_b ELSE v_c END, r.players);
    v_state := public.fn_cash_cluster_lightning_state(
      CASE r.which WHEN 'six' THEN v_a WHEN 'ring' THEN v_b ELSE v_c END);
    -- NON-VACUITY PER RUNG: the board really is at the number the rung names,
    -- so a verdict that is right for the wrong population is not counted as
    -- right.
    IF (v_state -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM r.players THEN
      RAISE EXCEPTION 'FAIL 13 (%): the board was built for % players and the verdict was handed %',
        r.label, r.players, v_state -> 'verdict' ->> 'live_eligible';
    END IF;
    IF (v_state -> 'verdict' ->> 'would_turn_on')::boolean IS DISTINCT FROM r.want_on THEN
      RAISE EXCEPTION 'FAIL 13 (%): would_turn_on is % at % players, not %',
        r.label, v_state -> 'verdict' ->> 'would_turn_on', r.players, r.want_on;
    END IF;
    IF (v_state -> 'verdict' ->> 'would_turn_off')::boolean IS DISTINCT FROM r.want_off THEN
      RAISE EXCEPTION 'FAIL 13 (%): would_turn_off is % at % players, not %',
        r.label, v_state -> 'verdict' ->> 'would_turn_off', r.players, r.want_off;
    END IF;
    IF (v_state -> 'verdict' ->> 'to_on')::integer IS DISTINCT FROM r.to_on THEN
      RAISE EXCEPTION 'FAIL 13 (%): to_on is % at % players, not %',
        r.label, v_state -> 'verdict' ->> 'to_on', r.players, r.to_on;
    END IF;
    IF (v_state -> 'verdict' ->> 'to_off')::integer IS DISTINCT FROM r.to_off THEN
      RAISE EXCEPTION 'FAIL 13 (%): to_off is % at % players, not %',
        r.label, v_state -> 'verdict' ->> 'to_off', r.players, r.to_off;
    END IF;
    -- The one reader carries the thresholds the verdict was judged against,
    -- which is how a Phase 5 caller checks the comparison itself. It does NOT
    -- carry the breakdown; section 19 is where that is asserted, because it is
    -- what keeps a lobby open at two extra statements instead of nine.
    IF (v_state ->> 'thresholds') IS NULL THEN
      RAISE EXCEPTION 'FAIL 13 (%): the one reader does not carry the thresholds', r.label;
    END IF;
    IF (v_state -> 'thresholds' ->> 'on')::integer
       IS DISTINCT FROM (public.fn_cash_cluster_lightning_thresholds(
            CASE r.which WHEN 'six' THEN v_a WHEN 'ring' THEN v_b ELSE v_c END) ->> 'on')::integer THEN
      RAISE EXCEPTION 'FAIL 13 (%): the reader was judged against an ON threshold that is not the one place''s', r.label;
    END IF;
  END LOOP;
  IF v_n IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'FAIL 13: % rungs of the ladder were climbed, not 8', v_n;
  END IF;
END $$;

-- THE THREE GATES. A Cluster at or above its ON threshold still does not turn
-- on if it may not, if it is not enabled, or if it is already on. Each is
-- flipped from the SAME board that says true with all three in place, so none
-- of them can be satisfied by a verdict that is false for another reason.
DO $$
DECLARE v_a uuid; v_c uuid; v_mode text;
BEGIN
  SELECT game_id INTO v_a FROM board WHERE k = 'ladder_six';
  SELECT game_id INTO v_c FROM board WHERE k = 'ladder_off';
  PERFORM public.fx_populate(v_a, 18);

  -- NON-VACUITY: with all three in place it IS true, so each false below is
  -- about the gate that was shut and nothing else.
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 13 gates: the board does not say true with every gate open, so shutting one proves nothing';
  END IF;

  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 13 gates: a Cluster that may NEVER convert says it would turn Lightning on';
  END IF;
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 13 gates: re-enabling the capability did not bring the verdict back';
  END IF;

  UPDATE public.cash_games SET enabled = false WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 13 gates: a disabled Cluster says it would turn Lightning on';
  END IF;
  UPDATE public.cash_games SET enabled = true WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 13 gates: re-enabling the Cluster did not bring the verdict back';
  END IF;

  -- ALREADY ON. The trigger is MUST_MOVE -> LIGHTNING and a Cluster that is
  -- already there has nowhere to go; at eighteen it is also nowhere near its
  -- OFF threshold, so BOTH halves of the verdict are false at once.
  SELECT cluster_mode INTO v_mode FROM public.cash_games WHERE id = v_a;
  INSERT INTO harness_moved (k, note)
  VALUES ('ladder_six', 'set to lightning to prove would_turn_on is false when it is already on, then set back to ' || v_mode);
  UPDATE public.cash_games SET cluster_mode = 'lightning' WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 13 gates: a Cluster that is already Lightning says it would turn Lightning on';
  END IF;
  IF public.fx_verdict(v_a, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 13 gates: a Lightning Cluster at eighteen says it would turn OFF';
  END IF;
  UPDATE public.cash_games SET cluster_mode = v_mode WHERE id = v_a;
  IF public.fx_verdict(v_a, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 13 gates: putting the Cluster back into % did not bring the verdict back', v_mode;
  END IF;

  -- AND THE OFF TRIGGER IS GATED ON THE MODE TOO: a MUST_MOVE Cluster far
  -- below the OFF threshold does not say it would turn off, because it is not
  -- on. The pair for cluster C's three rungs above.
  PERFORM public.fx_populate(v_a, 1);
  IF public.fx_verdict(v_a, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 13 gates: a MUST_MOVE Cluster with one player says it would turn Lightning off';
  END IF;
  IF public.fx_verdict(v_c, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 13 gates: the Lightning Cluster below its OFF threshold stopped saying so';
  END IF;
END $$;
\echo '  ok  13 THE VERDICT F02/F03/F09/F10 a six-max Cluster at 17 18 and 19 live eligible answers would_turn_on false true true with to_on 1 0 0 and a full-ring Cluster at 26 and 27 answers false then true - the specification acceptance tests F02 F03 F09 and F10 at their exact boundary - a Cluster already in cluster_mode lightning at 13 12 and 11 answers would_turn_off false true true on the Phase 10 ladder with to_off 1 0 0 so >= and <= are each right at the rung that tells them from > and <, and at eighteen the same board says false when lightning_enabled is false when enabled is false and when the Cluster is already lightning, each gate shut and reopened from a board that says true with all three open, while a MUST_MOVE Cluster with one player still does not say it would turn off'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 14 POOL HEALTH -------------------------------------------------------------
-- "Implement pool health metrics." What a pool's health IS depends on whether
-- it has one: during MUST_MOVE it is seats and headroom, during LIGHTNING it
-- is also the wait distribution the slots carry. One function answers both and
-- says which regime it answered for.
--
-- It must agree with the population rather than recompute it, so every number
-- it shares with the population is asserted EQUAL to the population's own,
-- and the numbers that are its alone - the headroom both ways, the occupancy
-- percentage, the slot distribution - are asserted against literals.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_feeder uuid; v_h jsonb; v_pop jsonb; v_th jsonb;
  v_empty uuid; v_gone uuid; i integer; s1 uuid; s2 uuid; v_err text;
BEGIN
  v_g      := public.fx_cluster('P4 Pool Health', 6);
  v_main   := public.fx_table(v_g, 'main', 1, 6);
  v_feeder := public.fx_table(v_g, 'feeder', NULL, 6);
  INSERT INTO board (k, game_id, table_id) VALUES ('health', v_g, v_main);
  FOR i IN 1..5 LOOP PERFORM public.fx_seat(v_main, i); END LOOP;

  -- NON-VACUITY: no pool yet, so every pool counter is zero and each rise
  -- below is about the slot that was opened.
  v_h := public.fn_cash_cluster_pool_health(v_g);
  IF (v_h -> 'pool') IS DISTINCT FROM
     '{"hands": 0, "players": 0, "open_slots": 0, "fast_folds": 0, "p95_wait_ms": 0, "p99_wait_ms": 0}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 14: a cluster with no pool reports %', v_h -> 'pool';
  END IF;

  IF (v_h ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 14: pool health answered ok = % for a live cluster', v_h ->> 'ok';
  END IF;
  IF (v_h ->> 'regime') IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 14: the regime reads %, not the cluster_mode it is in', v_h ->> 'regime';
  END IF;
  IF (v_h ->> 'live_eligible')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 14: five seated read % live eligible to pool health', v_h ->> 'live_eligible';
  END IF;
  -- THE SAME NUMBER AS THE POPULATION'S, not a second computation of it.
  IF (v_h ->> 'live_eligible')::integer IS DISTINCT FROM public.fx_live(v_g) THEN
    RAISE EXCEPTION 'FAIL 14: pool health says % live eligible and the population says %',
      v_h ->> 'live_eligible', public.fx_live(v_g);
  END IF;
  IF (v_h -> 'population' -> 'counted') IS DISTINCT FROM (public.fx_pop(v_g) -> 'counted') THEN
    RAISE EXCEPTION 'FAIL 14: the breakdown pool health carries is not the population''s';
  END IF;
  -- AND THE SAME THRESHOLDS.
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g);
  IF (v_h -> 'thresholds') IS DISTINCT FROM v_th THEN
    RAISE EXCEPTION 'FAIL 14: pool health carries thresholds % where the one place says %', v_h -> 'thresholds', v_th;
  END IF;
  -- HEADROOM BOTH WAYS. Thirteen short of eighteen, and already seven clear of
  -- twelve, which is zero rather than a negative.
  IF (v_h -> 'headroom' ->> 'to_on')::integer IS DISTINCT FROM 13 THEN
    RAISE EXCEPTION 'FAIL 14: five of eighteen reads % to the ON threshold, not 13', v_h -> 'headroom' ->> 'to_on';
  END IF;
  IF (v_h -> 'headroom' ->> 'to_off')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 14: five is below the OFF threshold of twelve and reads % clear of it, not 0',
      v_h -> 'headroom' ->> 'to_off';
  END IF;
  -- SEAT OCCUPANCY AS A PERCENTAGE, to one decimal place, of the capacity the
  -- population counted rather than of the handedness.
  IF (v_h -> 'seats' ->> 'tables')::integer IS DISTINCT FROM 2
     OR (v_h -> 'seats' ->> 'capacity')::integer IS DISTINCT FROM 12
     OR (v_h -> 'seats' ->> 'occupied')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 14: the seats read %', v_h -> 'seats';
  END IF;
  IF (v_h -> 'seats' ->> 'occupancy')::numeric IS DISTINCT FROM 41.7::numeric THEN
    RAISE EXCEPTION 'FAIL 14: five of twelve seats reads %% occupancy of %, not 41.7', v_h -> 'seats' ->> 'occupancy';
  END IF;

  -- ONCE THERE IS A POOL. Two slots, with wait percentiles that cannot be
  -- summed and counters that can, which is the distinction lightning_pool_slot
  -- exists to keep: p95 and p99 are the MAX across slots and hands and
  -- fast_folds are the SUM.
  PERFORM public.fx_pool_session(v_g, 'H1', 'active');
  PERFORM public.fx_pool_session(v_g, 'H2', 'active');
  SELECT slot_id INTO s1 FROM pool WHERE k = 'H1';
  SELECT slot_id INTO s2 FROM pool WHERE k = 'H2';
  UPDATE public.lightning_pool_slot
     SET p95_wait_ms = 1200, p99_wait_ms = 2500, hands = 10, fast_folds = 4 WHERE id = s1;
  UPDATE public.lightning_pool_slot
     SET p95_wait_ms = 800,  p99_wait_ms = 900,  hands = 5,  fast_folds = 1 WHERE id = s2;

  v_h := public.fn_cash_cluster_pool_health(v_g);
  IF (v_h -> 'pool') IS DISTINCT FROM
     '{"hands": 15, "players": 2, "open_slots": 2, "fast_folds": 5, "p95_wait_ms": 1200, "p99_wait_ms": 2500}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 14: two open slots read %, not 2 slots 2 players p95 1200 p99 2500 hands 15 fast_folds 5', v_h -> 'pool';
  END IF;
  -- The two pool players are in the population too, so the headroom moved.
  IF (v_h ->> 'live_eligible')::integer IS DISTINCT FROM 7
     OR (v_h -> 'headroom' ->> 'to_on')::integer IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'FAIL 14: with two pool players it reads % live eligible and % to the ON threshold',
      v_h ->> 'live_eligible', v_h -> 'headroom' ->> 'to_on';
  END IF;
  -- And the seats did NOT move: a Lightning player is not in a chair.
  IF (v_h -> 'seats' ->> 'occupied')::integer IS DISTINCT FROM 5
     OR (v_h -> 'seats' ->> 'occupancy')::numeric IS DISTINCT FROM 41.7::numeric THEN
    RAISE EXCEPTION 'FAIL 14: two pool players were counted into seat occupancy: %', v_h -> 'seats';
  END IF;

  -- A CLOSED SLOT IS NOT AN OPEN ONE. The pair that stops every pool counter
  -- being a count of the whole table.
  UPDATE public.lightning_pool_slot
     SET closed_at = clock_timestamp() + interval '1 second', close_reason = 'fixture' WHERE id = s2;
  v_h := public.fn_cash_cluster_pool_health(v_g);
  IF (v_h -> 'pool') IS DISTINCT FROM
     '{"hands": 10, "players": 1, "open_slots": 1, "fast_folds": 4, "p95_wait_ms": 1200, "p99_wait_ms": 2500}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 14: closing one of two slots reads %', v_h -> 'pool';
  END IF;

  -- A CLUSTER WITH NO SEATS AT ALL divides nothing by zero and says so: the
  -- occupancy is NULL rather than an error or a zero that reads as "empty".
  v_empty := public.fx_cluster('P4 Pool Health No Tables', 9);
  v_gone  := public.fx_table(v_empty, 'main', 1, 9, 'live', 'waiting', true);
  INSERT INTO board (k, game_id, table_id) VALUES ('health_empty', v_empty, v_gone);
  v_h := public.fn_cash_cluster_pool_health(v_empty);
  IF (v_h ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 14: a cluster whose only table is deleted answered ok = %', v_h ->> 'ok';
  END IF;
  IF (v_h -> 'seats' ->> 'capacity')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 14: a cluster with no live table reports capacity %', v_h -> 'seats' ->> 'capacity';
  END IF;
  IF (v_h -> 'seats' ->> 'occupancy') IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL 14: zero capacity reported an occupancy of %', v_h -> 'seats' ->> 'occupancy';
  END IF;

  -- AND A CLUSTER THAT DOES NOT EXIST GETS AN ANSWER, NOT AN EXCEPTION. This
  -- is read on the path a tick takes, the same argument as section 03.
  v_err := NULL;
  BEGIN
    v_h := public.fn_cash_cluster_pool_health('00000000-0000-0000-0000-000000000000'::uuid);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL 14: pool health raised "%" for a cluster that does not exist', v_err;
  END IF;
  IF coalesce((v_h ->> 'ok')::boolean, true) IS DISTINCT FROM false
     OR (v_h ->> 'reason') IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'FAIL 14: pool health answered % for a cluster that does not exist', v_h;
  END IF;
END $$;
\echo '  ok  14 POOL HEALTH             pool health reports the SAME live_eligible and the SAME counted breakdown as the population and the SAME thresholds as the one place they are written, headroom 13 to the ON threshold and 0 rather than a negative to the OFF, two tables of twelve seats five occupied and occupancy 41.7 per cent, and once two lightning_pool_slot rows are open it reports 2 slots 2 players p95 1200 and p99 2500 as the MAX across slots with hands 15 and fast_folds 5 as the SUM while the two pool players raise live_eligible without touching seat occupancy, a closed slot leaves 1 slot 1 player and 10 hands, a cluster with no live table reports capacity 0 and occupancy NULL rather than dividing by it, and a cluster that does not exist gets ok false reason not_found without raising'

ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 15 ONE PREDICATE -----------------------------------------------------------
-- "Create one authoritative function ... The exact population predicate must be
-- centralized and unit tested. Do not copy slightly different player-count
-- logic into multiple services."
--
-- There are now FOUR readers of that number in this one file -
-- fn_cash_cluster_live_eligible, fn_cash_cluster_population,
-- fn_cash_cluster_lightning_state and fn_cash_cluster_pool_health - and the
-- whole restructure is the claim that only the first of them computes it. The
-- claim is worth exactly what it can be checked against, so it is checked
-- against every board this file has built, including the ones carrying
-- exclusions and the ones carrying a Lightning pool, and at a disconnect count
-- as well as at none.
DO $$
DECLARE v_bad text; v_n bigint; v_g uuid;
BEGIN
  -- NON-VACUITY, FOUR WAYS, before the sweep means anything.
  SELECT count(*) INTO v_n FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) > 0;
  IF (v_n >= 5::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 15: only % cluster(s) have a population at all, so "the four readers agree" is mostly an agreement about zero', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games g
                  CROSS JOIN LATERAL (SELECT public.fx_pop(g.id) AS p) x
                  WHERE (x.p -> 'excluded' ->> 'sit_out')::integer
                        + (x.p -> 'excluded' ->> 'leaving')::integer
                        + (x.p -> 'excluded' ->> 'busted')::integer
                        + (x.p -> 'excluded' ->> 'empty_chairs')::integer > 0) THEN
    RAISE EXCEPTION 'FAIL 15: no board in the estate carries an exclusion, so the agreement was never tested on a narrowed one';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games g
                  WHERE (public.fx_pop(g.id) -> 'counted' ->> 'lightning_eligible')::integer > 0) THEN
    RAISE EXCEPTION 'FAIL 15: no board in the estate carries a Lightning pool, so the agreement was never tested on the second half';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games g
                  WHERE public.fn_cash_cluster_live_eligible(g.id, clock_timestamp(), 2)
                        IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)) THEN
    RAISE EXCEPTION 'FAIL 15: p_disconnected changes nothing anywhere, so the disconnect sweep below is a sweep over one answer';
  END IF;

  -- THE BREAKDOWN DOES NOT RECOMPUTE THE NUMBER.
  SELECT string_agg(g.name || ' (breakdown ' || (public.fx_pop(g.id) ->> 'live_eligible')
                    || ' / predicate ' || public.fn_cash_cluster_live_eligible(g.id) || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g
   WHERE (public.fx_pop(g.id) ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the breakdown and the predicate disagree on %', v_bad;
  END IF;

  -- NOR AT A DISCONNECT COUNT, which is the argument that would drift first:
  -- the population subtracts nothing of its own, it hands p_disconnected down.
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM public.cash_games g
   WHERE (public.fn_cash_cluster_population(g.id, clock_timestamp(), 2) ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id, clock_timestamp(), 2)
      OR (public.fn_cash_cluster_population(g.id, clock_timestamp(), 0) ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id, clock_timestamp(), 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the breakdown and the predicate disagree under a disconnect count on %', v_bad;
  END IF;

  -- NOR DOES THE VERDICT.
  SELECT string_agg(g.name || ' (verdict ' || (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'live_eligible')
                    || ' / predicate ' || public.fn_cash_cluster_live_eligible(g.id) || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the verdict and the predicate disagree on %', v_bad;
  END IF;

  -- NOR DOES POOL HEALTH.
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM public.cash_games g
   WHERE (public.fn_cash_cluster_pool_health(g.id) ->> 'live_eligible')::integer
         IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: pool health and the predicate disagree on %', v_bad;
  END IF;

  -- AND THE FOUR TERMS RECONCILE TO IT, on every cluster, on the NULL path and
  -- at a disconnect count. "One predicate" has two halves: every reader reports
  -- the same number, and the breakdown's own terms give that number back. The
  -- overlap term is zero everywhere at this point - nothing has yet put one
  -- human in both halves - and section 20 is where the overlap and the
  -- disconnect are made non-zero TOGETHER and the identity asked again.
  SELECT string_agg(g.name || ' (' || (x.p -> 'counted' ->> 'seated_eligible')
                    || ' + ' || (x.p -> 'counted' ->> 'lightning_eligible')
                    || ' - ' || (x.p -> 'counted' ->> 'seated_and_pooled')
                    || ' - ' || (x.p -> 'counted' ->> 'disconnected')
                    || ' <> ' || (x.p ->> 'live_eligible') || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fx_pop(g.id) AS p) x
   WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer
                     + (x.p -> 'counted' ->> 'lightning_eligible')::integer
                     - (x.p -> 'counted' ->> 'seated_and_pooled')::integer
                     - (x.p -> 'counted' ->> 'disconnected')::integer)
         IS DISTINCT FROM (x.p ->> 'live_eligible')::integer;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the breakdown''s four terms do not give its own number on %', v_bad;
  END IF;
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM public.cash_games g
    CROSS JOIN LATERAL (SELECT public.fx_pop(g.id, 2) AS p) x
   WHERE GREATEST(0, (x.p -> 'counted' ->> 'seated_eligible')::integer
                     + (x.p -> 'counted' ->> 'lightning_eligible')::integer
                     - (x.p -> 'counted' ->> 'seated_and_pooled')::integer
                     - (x.p -> 'counted' ->> 'disconnected')::integer)
         IS DISTINCT FROM (x.p ->> 'live_eligible')::integer;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the breakdown''s four terms do not give its own number at p_disconnected := 2 on %', v_bad;
  END IF;

  -- AND THE PREDICATE COUNTS PLAYERS, NOT CHAIRS. count(DISTINCT u.player_id)
  -- over the UNION is what the file spells; the same human seated at two of the
  -- Cluster's tables is one player Lightning could deal to, not two. The
  -- estate's own one_committed_seat_per_game_player makes this unreachable in
  -- production, which is exactly why nothing else in this contract would notice
  -- the difference if the DISTINCT were dropped.
  SELECT game_id INTO v_g FROM board WHERE k = 'horses';
  v_n := public.fn_cash_cluster_live_eligible(v_g);
  DECLARE
    v_t2 uuid; v_dup uuid;
  BEGIN
    SELECT user_id INTO v_dup FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = v_g AND ts.left_at IS NULL ORDER BY ts.seat_number LIMIT 1;
    v_t2 := public.fx_table(v_g, 'feeder', NULL, 6);
    PERFORM public.fx_seat(v_t2, 1, v_dup);
    IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM v_n::integer THEN
      RAISE EXCEPTION 'FAIL 15: the same player seated at a second table of the SAME Cluster took the population from % to %, and the predicate counts PLAYERS',
        v_n, public.fn_cash_cluster_live_eligible(v_g);
    END IF;
    -- The pair: a DIFFERENT player at that second table does raise it, so the
    -- assertion above is about the DISTINCT and not about the second table
    -- being invisible.
    PERFORM public.fx_seat(v_t2, 2);
    IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM (v_n + 1)::integer THEN
      RAISE EXCEPTION 'FAIL 15: a new player at the second table read % rather than %',
        public.fn_cash_cluster_live_eligible(v_g), v_n + 1;
    END IF;
    -- And the breakdown still agrees after both.
    IF (public.fx_pop(v_g) ->> 'live_eligible')::integer
       IS DISTINCT FROM public.fn_cash_cluster_live_eligible(v_g) THEN
      RAISE EXCEPTION 'FAIL 15: the breakdown lost the predicate on the duplicated-seat board';
    END IF;
  END;
END $$;
\echo '  ok  15 ONE PREDICATE           fn_cash_cluster_population fn_cash_cluster_lightning_state and fn_cash_cluster_pool_health all report exactly what fn_cash_cluster_live_eligible reports, on every cluster this file has built - with at least five carrying a population, at least one carrying an exclusion, at least one carrying a Lightning pool and at least one whose number a disconnect count really moves - the breakdown still agrees when a disconnect count of 2 and of 0 is handed down rather than subtracted locally, its four terms - the two halves less the overlap less counted.disconnected, floored at zero - give its own number back on every cluster at p_disconnected NULL and at 2, and the predicate counts PLAYERS not chairs: the same human at a second table of the same Cluster does not raise it and a different human does'

-- 16 THE RESERVED HOLD OBEYS THE CENSUS ---------------------------------------
-- This was a defect and is now a test. The reserved-hold query joins
-- public.tables and used to filter on cluster_id alone, so a notified hold
-- still inside its window on a table that had been DELETED, CLOSED or taken out
-- of the census's status list was counted as a seat held on this game's tables.
-- It never reached live_eligible - a hold is never added - so the arithmetic
-- was safe and the number an operator reads was not: after a Cluster breaks a
-- table, every stale hold on it inflated the figure forever.
--
-- The predicate is now the census's here too, which is the third copy of it in
-- the file, and the test for "it is the census's" is to ask the census.
DO $$
DECLARE
  v_g uuid; t_ok uuid; t_del uuid; t_closed uuid; t_status uuid;
  v_pop jsonb; v_census bigint; v_bad text;
BEGIN
  v_g      := public.fx_cluster('P4 Reserved Obeys The Census', 9);
  t_ok     := public.fx_table(v_g, 'main',   1,    9);
  t_del    := public.fx_table(v_g, 'feeder', NULL, 9);
  t_closed := public.fx_table(v_g, 'main',   2,    9);
  t_status := public.fx_table(v_g, 'main',   3,    9);
  INSERT INTO board (k, game_id, table_id) VALUES ('reserved', v_g, t_ok);
  INSERT INTO public.table_waitlist (table_id, user_id, status, hold_expires_at)
  SELECT x.t, gen_random_uuid(), 'notified', clock_timestamp() + interval '1 hour'
    FROM (VALUES (t_ok), (t_del), (t_closed), (t_status)) AS x(t);

  -- NON-VACUITY: while all four tables are on the board both readers see all
  -- four holds, so every disappearance below is a disappearance.
  v_pop := public.fx_pop(v_g);
  SELECT coalesce(sum(c.reserved), 0) INTO v_census FROM unnest(public.fn_cash_cluster_census(v_g)) c;
  IF (v_pop -> 'excluded' ->> 'reserved_seat')::integer IS DISTINCT FROM 4
     OR v_census IS DISTINCT FROM 4::bigint THEN
    RAISE EXCEPTION 'FAIL 16: four live holds read % to the population and % to the census',
      v_pop -> 'excluded' ->> 'reserved_seat', v_census;
  END IF;

  -- AND NOW THE THREE TABLES LEAVE THE BOARD, one by each of the three tests.
  UPDATE public.tables SET is_deleted = true     WHERE id = t_del;
  UPDATE public.tables SET lifecycle  = 'closed' WHERE id = t_closed;
  UPDATE public.tables SET status     = 'finished' WHERE id = t_status;
  v_pop := public.fx_pop(v_g);
  SELECT coalesce(sum(c.reserved), 0) INTO v_census FROM unnest(public.fn_cash_cluster_census(v_g)) c;
  IF (v_pop -> 'excluded' ->> 'reserved_seat')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 16: a notified hold on a DELETED, CLOSED or not-running table is still counted as a reserved seat (% of 1)',
      v_pop -> 'excluded' ->> 'reserved_seat';
  END IF;
  IF v_census IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 16: the census counts % reserved seats where it should count 1', v_census;
  END IF;
  IF (v_pop -> 'excluded' ->> 'reserved_seat')::integer::bigint IS DISTINCT FROM v_census THEN
    RAISE EXCEPTION 'FAIL 16: the population reports % reserved seats and the census %',
      v_pop -> 'excluded' ->> 'reserved_seat', v_census;
  END IF;

  -- EACH ONE BACK, ONE AT A TIME, so that a predicate missing any single one of
  -- the three tests goes red on exactly one line here.
  UPDATE public.tables SET is_deleted = false WHERE id = t_del;
  IF public.fx_exc(v_g, 'reserved_seat') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 16 is_deleted: undeleting the table left reserved_seat at %', public.fx_exc(v_g, 'reserved_seat');
  END IF;
  UPDATE public.tables SET lifecycle = 'live' WHERE id = t_closed;
  IF public.fx_exc(v_g, 'reserved_seat') IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 16 lifecycle: reopening the table left reserved_seat at %', public.fx_exc(v_g, 'reserved_seat');
  END IF;
  UPDATE public.tables SET status = 'running' WHERE id = t_status;
  IF public.fx_exc(v_g, 'reserved_seat') IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 16 status: a running table left reserved_seat at %', public.fx_exc(v_g, 'reserved_seat');
  END IF;

  -- AND THE TWO AGREE ACROSS EVERY BOARD THIS FILE HAS BUILT, which is the
  -- statement the third copy of the predicate exists to make.
  SELECT string_agg(g.name || ' (' || (public.fx_pop(g.id) -> 'excluded' ->> 'reserved_seat')
                    || ' / ' || (SELECT coalesce(sum(c.reserved), 0)
                                   FROM unnest(public.fn_cash_cluster_census(g.id)) c) || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g
   WHERE (public.fx_pop(g.id) -> 'excluded' ->> 'reserved_seat')::integer::bigint
         IS DISTINCT FROM (SELECT coalesce(sum(c.reserved), 0)
                             FROM unnest(public.fn_cash_cluster_census(g.id)) c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the population and the census disagree about reserved seats on %', v_bad;
  END IF;
  -- Non-vacuous: at least one cluster in that sweep really has a hold.
  IF NOT EXISTS (SELECT 1 FROM public.cash_games g
                  WHERE (public.fx_pop(g.id) -> 'excluded' ->> 'reserved_seat')::integer > 0) THEN
    RAISE EXCEPTION 'FAIL 16: no cluster in the estate holds a seat, so the sweep compared zero against zero';
  END IF;
END $$;
\echo '  ok  16 RESERVED OBEYS CENSUS   four notified holds still inside their window read 4 to excluded.reserved_seat and 4 to the census while all four tables are on the board, and read 1 and 1 once one table is deleted one is closed and one leaves the status list - the census table predicate is in the hold query too - each of the three undone on its own brings its hold back, and across every cluster this file has built excluded.reserved_seat equals the census summed reserved with at least one cluster really holding a seat'

-- 17 THE BREAKDOWN IS CATEGORIES, NOT TERMS -----------------------------------
-- The answer carries `breakdown_is_not_arithmetic: true`, and that field is
-- only honest if it is TRUE of the answer. A reader who trusted the categories
-- as terms would compute seated_total minus the four exclusions and get a
-- number that is not seated_eligible, so this section builds the board on which
-- that is so and asserts each overlap by name.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_noRole uuid; v_pop jsonb;
  s_both uuid; s_empty uuid; s_plain uuid;
BEGIN
  v_g      := public.fx_cluster('P4 Categories Not Terms', 9);
  v_main   := public.fx_table(v_g, 'main', 1, 9);
  -- A cluster table with NO role. public.tables.role is nullable and its CHECK
  -- constrains only non-NULL values, so this is a shape the schema permits and
  -- the one that makes seated_main plus seated_feeder fall short.
  v_noRole := public.fx_table(v_g, NULL, NULL, 9);
  INSERT INTO board (k, game_id, table_id) VALUES ('categories', v_g, v_main);

  s_both  := public.fx_seat(v_main, 1);
  s_empty := public.fx_seat(v_main, 2);
  s_plain := public.fx_seat(v_main, 3);
  PERFORM public.fx_seat(v_noRole, 1);

  -- NON-VACUITY: four occupied chairs, four eligible, nothing overlapping yet.
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 4
     OR (v_pop -> 'counted' ->> 'seated_total')::integer IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 17: the board starts at % live / % seated, not 4 / 4',
      v_pop ->> 'live_eligible', v_pop -> 'counted' ->> 'seated_total';
  END IF;

  -- ONE SEAT IS BOTH SITTING OUT AND BUSTED. It is in BOTH counters, once each,
  -- and it is one player.
  UPDATE public.table_seats SET is_sitting_out = true, stack = 0 WHERE id = s_both;
  -- ONE CHAIR IS EMPTY, and is in none of the other three.
  UPDATE public.table_seats SET user_id = NULL WHERE id = s_empty;
  v_pop := public.fx_pop(v_g);

  IF (v_pop -> 'excluded' ->> 'sit_out')::integer IS DISTINCT FROM 1
     OR (v_pop -> 'excluded' ->> 'busted')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 17: a seat that is BOTH sitting out and busted reads sit_out % / busted %, and it belongs to both',
      v_pop -> 'excluded' ->> 'sit_out', v_pop -> 'excluded' ->> 'busted';
  END IF;
  IF (v_pop -> 'excluded' ->> 'empty_chairs')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 17: the empty chair reads % under empty_chairs', v_pop -> 'excluded' ->> 'empty_chairs';
  END IF;
  IF (v_pop -> 'excluded' ->> 'leaving')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: an empty chair or an overlapping seat was filed as leaving (%)', v_pop -> 'excluded' ->> 'leaving';
  END IF;

  -- THE ROLE-LESS TABLE'S SEAT IS IN seated_no_role AND IN seated_total, AND IN
  -- NEITHER OF THE OTHER TWO BUCKETS.
  IF (v_pop -> 'counted' ->> 'seated_no_role')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 17: the seat on the role-less table reads % under seated_no_role', v_pop -> 'counted' ->> 'seated_no_role';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_main')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'seated_feeder')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: the Main holds % and the feeder % of the occupied chairs, not 2 and 0',
      v_pop -> 'counted' ->> 'seated_main', v_pop -> 'counted' ->> 'seated_feeder';
  END IF;
  -- THE ONE IDENTITY THAT DOES HOLD: every occupied chair is on a table whose
  -- role is main, feeder or nothing, and the three buckets partition them.
  IF (v_pop -> 'counted' ->> 'seated_main')::integer
     + (v_pop -> 'counted' ->> 'seated_feeder')::integer
     + (v_pop -> 'counted' ->> 'seated_no_role')::integer
     IS DISTINCT FROM (v_pop -> 'counted' ->> 'seated_total')::integer THEN
    RAISE EXCEPTION 'FAIL 17: main % plus feeder % plus no_role % is not seated_total %',
      v_pop -> 'counted' ->> 'seated_main', v_pop -> 'counted' ->> 'seated_feeder',
      v_pop -> 'counted' ->> 'seated_no_role', v_pop -> 'counted' ->> 'seated_total';
  END IF;
  -- AND seated_main PLUS seated_feeder FALLS SHORT, which is the half the file
  -- warns about by name.
  IF ((v_pop -> 'counted' ->> 'seated_main')::integer
      + (v_pop -> 'counted' ->> 'seated_feeder')::integer
      < (v_pop -> 'counted' ->> 'seated_total')::integer) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 17: on a board with a role-less table seated_main plus seated_feeder did NOT fall short of seated_total, so the warning is about nothing';
  END IF;

  -- THE CATEGORIES DO NOT SUM, DEMONSTRATED. Three occupied chairs, one of them
  -- excluded twice, so the naive subtraction undercounts and the answer says so
  -- in a field of its own.
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: the board reads % eligible seated, not 2', v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF ((v_pop -> 'counted' ->> 'seated_total')::integer
      - (v_pop -> 'excluded' ->> 'sit_out')::integer
      - (v_pop -> 'excluded' ->> 'leaving')::integer
      - (v_pop -> 'excluded' ->> 'busted')::integer
      - (v_pop -> 'excluded' ->> 'empty_chairs')::integer)
     IS NOT DISTINCT FROM (v_pop -> 'counted' ->> 'seated_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 17: on this board the categories DID sum to seated_eligible, so breakdown_is_not_arithmetic is claiming something that is not true of the answer it is in';
  END IF;
  IF (v_pop -> 'breakdown_is_not_arithmetic') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL 17: the answer does not say its breakdown is not arithmetic (%)', v_pop -> 'breakdown_is_not_arithmetic';
  END IF;
  -- And the NUMBER is still exactly the predicate's, overlaps and all.
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM public.fn_cash_cluster_live_eligible(v_g) THEN
    RAISE EXCEPTION 'FAIL 17: the overlapping board lost the one predicate';
  END IF;
END $$;
\echo '  ok  17 CATEGORIES NOT TERMS    a seat that is BOTH sitting out and busted is counted under both, an empty chair is counted under empty_chairs and under none of sit_out leaving or busted, a seat on a cluster table whose role IS NULL lands in seated_no_role and in seated_total and in neither of the other two buckets while main plus feeder plus no_role does partition seated_total and main plus feeder falls short of it, subtracting the four exclusions from seated_total really does NOT give seated_eligible on that board, the answer carries breakdown_is_not_arithmetic true, and live_eligible is still exactly the predicate'

-- 18 IDLE IS COUNTED, NOT SUBTRACTED -----------------------------------------
-- This was a defect and is now a test. An earlier cut read
-- GREATEST(0, lightning_eligible - lightning_in_instance), which subtracts a
-- count of players holding a committed seat ANYWHERE in the epoch from a count
-- of ACTIVE pool sessions. Those are two different populations, so the
-- difference is not a count of anything, and the GREATEST floor hid the
-- crossing rather than reporting it: one active player holding nothing plus one
-- sat-out player holding a seat read ZERO idle.
--
-- Both halves are fixed and both are asserted: idle is asked directly, and
-- in_instance now joins the pool session and requires it to be active and
-- un-exited, so the two counters are over the same population.
--
-- WHICH OF THE TWO HALVES IS LOAD-BEARING, SAID PLAINLY, because it is not the
-- one the comment in the migration points at. Once in_instance is joined to the
-- active pool session it counts a SUBSET of the eligible players, and
-- lightning_pool_session_one_open makes lightning_eligible a count of active
-- sessions, so `eligible - in_instance` and a direct count of the un-held are
-- then the SAME NUMBER and no board can tell them apart. Restoring the
-- subtraction alone is an equivalent mutant. The join is what changed the
-- answer, and the partition identity asserted at the end of this section -
-- idle plus in_instance is the eligible pool - is exactly the property that
-- makes the two spellings agree. Counting directly is worth doing because it
-- says what it means and cannot go wrong again if either counter is widened;
-- it is not, on today's schema, a different answer.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_inst uuid; v_pop jsonb; a record; b record;
BEGIN
  v_g    := public.fx_cluster('P4 Idle Is Counted', 9);
  v_main := public.fx_table(v_g, 'main', 1, 9);
  INSERT INTO board (k, game_id, table_id) VALUES ('idle', v_g, v_main);

  PERFORM public.fx_pool_session(v_g, 'IDLE_A', 'active');
  PERFORM public.fx_pool_session(v_g, 'IDLE_B', 'sit_out');
  SELECT * INTO a FROM pool WHERE k = 'IDLE_A';
  SELECT * INTO b FROM pool WHERE k = 'IDLE_B';

  -- NON-VACUITY: before the hold exists, A is the one eligible player and A is
  -- idle, so the zero that the old arithmetic produced is a change from this.
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1
     OR (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 1
     OR (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: before any hold the board reads eligible % idle % in_instance %',
      v_pop -> 'counted' ->> 'lightning_eligible', v_pop -> 'counted' ->> 'lightning_idle',
      v_pop -> 'counted' ->> 'lightning_in_instance';
  END IF;

  -- THE SAT-OUT PLAYER HOLDS A COMMITTED SEAT AT A DEALING INSTANCE.
  v_inst := public.fx_instance(v_g, 'dealing');
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
     seat_number, state, expires_at, resolved_at)
  VALUES (v_g, 0, b.player_id, b.slot_id, v_inst, 1, 'committed',
          clock_timestamp() + interval '5 minutes', clock_timestamp());

  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 18: a sat-out player holding a seat became eligible (% of 1)',
      v_pop -> 'counted' ->> 'lightning_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: a hold belonging to a SIT_OUT session was counted in_instance (% of 0) - in_instance and lightning_eligible must be over the same population',
      v_pop -> 'counted' ->> 'lightning_in_instance';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 18: one active player holding nothing reads % idle, not 1 - subtracting in_instance from eligible is what produced a zero here',
      v_pop -> 'counted' ->> 'lightning_idle';
  END IF;

  -- THE PAIR, so that "idle is 1" is not a counter that is always 1. The same
  -- hold, moved onto the player who really is active, takes that player out of
  -- idle and into in_instance.
  UPDATE public.lightning_pool_session SET state = 'active' WHERE id = b.session_id;
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 1
     OR (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 18: with B active and holding, the board reads eligible % in_instance % idle %',
      v_pop -> 'counted' ->> 'lightning_eligible', v_pop -> 'counted' ->> 'lightning_in_instance',
      v_pop -> 'counted' ->> 'lightning_idle';
  END IF;

  -- AND WITH BOTH HOLDING, IDLE IS ZERO - reached by counting nobody, not by a
  -- subtraction bottoming out.
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
     seat_number, state, expires_at, resolved_at)
  VALUES (v_g, 0, a.player_id, a.slot_id, v_inst, 2, 'committed',
          clock_timestamp() + interval '5 minutes', clock_timestamp());
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'lightning_in_instance')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'lightning_idle')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: with both active players holding, the board reads in_instance % idle %',
      v_pop -> 'counted' ->> 'lightning_in_instance', v_pop -> 'counted' ->> 'lightning_idle';
  END IF;
  -- IDLE PLUS IN_INSTANCE IS THE ELIGIBLE POPULATION, at every step above and
  -- here: they partition it, which is the whole reason they must be over it.
  IF (v_pop -> 'counted' ->> 'lightning_idle')::integer
     + (v_pop -> 'counted' ->> 'lightning_in_instance')::integer
     IS DISTINCT FROM (v_pop -> 'counted' ->> 'lightning_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 18: idle plus in_instance is not the eligible pool';
  END IF;
END $$;
\echo '  ok  18 IDLE IS COUNTED         one ACTIVE pool session holding nothing plus one SIT_OUT session holding a committed reservation at a dealing instance reads lightning_eligible 1 lightning_in_instance 0 and lightning_idle 1 - the sat-out holder is not in_instance because that counter now joins the pool session and requires it active, and the idle one is counted directly rather than produced by subtracting two different populations and flooring the result - moving the sat-out session to active reads 2 / 1 / 1 and a second hold reads 2 / 0, with idle plus in_instance equal to the eligible pool throughout'

-- 19 THE READER IS CHEAP ------------------------------------------------------
-- fn_cash_game_lobby embeds fn_cash_cluster_lightning_state, so anything that
-- reader calls runs on every lobby open. The breakdown is nine statements and
-- the predicate is two, and the whole reason the predicate is a function of its
-- own is that the reader must call THAT one. An earlier cut had the lobby
-- paying all nine, which is the same class of regression the Phase 3
-- remediation went back for.
--
-- This is asserted against the installed body rather than against the source
-- text, because what runs is what is in the catalogue.
--
-- AND IT IS ASSERTED AGAINST THE BODY WITH ITS LINE COMMENTS STRIPPED, which
-- is not fussiness. pg_get_functiondef returns the body verbatim, comments and
-- all, and this reader's body carries a comment that NAMES the breakdown
-- ("fn_cash_cluster_population says the same in its own answer"). A bare
-- position() over the raw text therefore answers "yes, it is in there" for a
-- reader that does not call it at all - which is a check that can only ever go
-- red for the wrong reason. What is under test is whether the lobby PAYS for
-- nine statements, so what is searched is the code.
DO $$
DECLARE
  v_def text; v_health text; v_state jsonb; v_g uuid; v_before bigint; v_p uuid; v_t uuid; v_cs uuid;
BEGIN
  -- '--[^\n]*' rather than a full SQL comment grammar: these bodies carry line
  -- comments only, and a block-comment stripper that got it wrong would be a
  -- second thing to be wrong about.
  v_def    := regexp_replace(
                pg_get_functiondef('public.fn_cash_cluster_lightning_state(uuid)'::regprocedure),
                '--[^' || chr(10) || ']*', '', 'g');
  v_health := regexp_replace(
                pg_get_functiondef('public.fn_cash_cluster_pool_health(uuid,timestamp with time zone)'::regprocedure),
                '--[^' || chr(10) || ']*', '', 'g');

  -- IT CALLS THE PREDICATE.
  IF (position('fn_cash_cluster_live_eligible' in v_def) > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 19: the one reader does not call fn_cash_cluster_live_eligible at all';
  END IF;
  -- AND IT DOES NOT CALL THE BREAKDOWN.
  IF position('fn_cash_cluster_population' in v_def) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 19: the one reader calls fn_cash_cluster_population, so every lobby open pays for a breakdown nobody asked for';
  END IF;
  -- NON-VACUITY FOR THAT NEGATIVE, TWICE OVER. The string is findable in this
  -- catalogue - pool health really does call the breakdown, and after the same
  -- stripping - so "it is not there" is about the reader and not about
  -- position() never matching anything or the stripper having eaten the body.
  IF (position('fn_cash_cluster_population' in v_health) > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 19: pool health does not call fn_cash_cluster_population either, so the absence above proves nothing about where the breakdown is read';
  END IF;
  IF (position('fn_cash_cluster_lightning_thresholds' in v_def) > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 19: stripping the comments left a body with no calls in it at all, so the absence above is an artefact of the stripper';
  END IF;

  -- AND THE ANSWER HAS NO BREAKDOWN IN IT. The body could have inlined the nine
  -- statements under another name; the shape of the answer is the other half.
  SELECT game_id INTO v_g FROM board WHERE k = 'ladder_six';
  v_state := public.fn_cash_cluster_lightning_state(v_g);
  IF (v_state -> 'population') IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'FAIL 19: the one reader still carries a population key: %', v_state -> 'population';
  END IF;
  IF (v_state -> 'thresholds') IS NULL OR (v_state -> 'verdict' ->> 'live_eligible') IS NULL THEN
    RAISE EXCEPTION 'FAIL 19: the one reader dropped the thresholds or the number';
  END IF;
  IF (v_state -> 'verdict' ->> 'confidence') IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'FAIL 19: no disconnect count reaches this path and the verdict reports confidence %',
      v_state -> 'verdict' ->> 'confidence';
  END IF;

  -- EVERY FIELD THE LOBBY ALREADY READS SURVIVED THE REPLACEMENT. A reader that
  -- gained a verdict and lost must_move would break the lobby and pass every
  -- assertion about the verdict.
  IF (v_state ->> 'game_id') IS NULL OR (v_state ->> 'cluster_mode') IS NULL
     OR (v_state ->> 'cluster_epoch') IS NULL OR (v_state ->> 'lightning_enabled') IS NULL
     OR (v_state ->> 'must_move') IS NULL OR (v_state ->> 'enabled') IS NULL
     OR (v_state ->> 'handedness') IS NULL OR (v_state ->> 'open_cluster_sessions') IS NULL THEN
    RAISE EXCEPTION 'FAIL 19: the re-created reader dropped a field the lobby already reads: %', v_state;
  END IF;

  -- AND open_cluster_sessions IS STILL A COUNT OF SOMETHING, not a literal. The
  -- Phase 3 fixture's reduced body answered 0; this one reads the relation, and
  -- the way to tell the two apart is to open a session.
  v_before := (v_state ->> 'open_cluster_sessions')::bigint;
  SELECT table_id INTO v_t FROM board WHERE k = 'ladder_six';
  IF v_t IS NULL THEN
    SELECT tb.id INTO v_t FROM public.tables tb WHERE tb.cluster_id = v_g ORDER BY tb.created_at LIMIT 1;
  END IF;
  v_p := gen_random_uuid();
  INSERT INTO public.cash_player_session (player_id, scope_type, scope_id, table_id, cluster_id)
  VALUES (v_p, 'cluster', v_g, v_t, v_g) RETURNING id INTO v_cs;
  IF (public.fn_cash_cluster_lightning_state(v_g) ->> 'open_cluster_sessions')::bigint
     IS DISTINCT FROM v_before + 1 THEN
    RAISE EXCEPTION 'FAIL 19: opening a cash session left open_cluster_sessions at %',
      public.fn_cash_cluster_lightning_state(v_g) ->> 'open_cluster_sessions';
  END IF;
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'fixture' WHERE id = v_cs;
  IF (public.fn_cash_cluster_lightning_state(v_g) ->> 'open_cluster_sessions')::bigint
     IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL 19: closing the cash session left open_cluster_sessions at %',
      public.fn_cash_cluster_lightning_state(v_g) ->> 'open_cluster_sessions';
  END IF;
END $$;
\echo '  ok  19 THE READER IS CHEAP     the installed body of fn_cash_cluster_lightning_state, with its line comments stripped so that a comment NAMING the breakdown cannot be mistaken for a call to it, contains fn_cash_cluster_live_eligible and fn_cash_cluster_lightning_thresholds and does NOT contain fn_cash_cluster_population - proved non-vacuous against fn_cash_cluster_pool_health which does contain it after the same stripping - its answer carries no population key at all while still carrying the thresholds the number and a confidence of partial, every field the lobby already reads survived the replacement, and open_cluster_sessions is still a real count that rises when a cash session opens and falls when it closes'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'


-- 20 THE CONVERSION WINDOW: ONE HUMAN IS ONE PLAYER --------------------------
-- The two halves of the predicate are disjoint while a Cluster is cleanly in
-- one regime, and they are NOT disjoint for the length of a Phase 5
-- conversion: a player seated with chips whose lightning_pool_session has
-- already been written is in both relations at once. That window is precisely
-- when the threshold is being read, and a Cluster that counted the same human
-- twice would cross its ON threshold on a population that does not exist.
--
-- One count(DISTINCT) over a UNION is the whole guard, and UNION ALL would
-- undo it silently: every board in this file outside this section has disjoint
-- halves, so every other assertion here stays green under that change.
--
-- BOTH HALVES OR THE SECTION IS EMPTY. A function that reported the overlap as
-- the whole population, or that counted nobody at all, would pass a test that
-- only built the overlapping human - so the same board also carries a human who
-- is ONLY seated and a human who is ONLY pooled, and all three numbers are
-- asserted.
DO $$
DECLARE
  v_g uuid; v_main uuid; v_pop jsonb;
  v_both uuid; v_seat_only uuid; v_pool_only uuid;
  v_t uuid; v_cs uuid; v_ps uuid;
BEGIN
  v_g    := public.fx_cluster('P4 Conversion Window', 9);
  v_main := public.fx_table(v_g, 'main', 1, 9);
  INSERT INTO board (k, game_id, table_id) VALUES ('window', v_g, v_main);

  v_both      := gen_random_uuid();
  v_seat_only := gen_random_uuid();
  v_pool_only := gen_random_uuid();

  -- TWO HUMANS IN CHAIRS: one of them is about to be given a pool session too.
  PERFORM public.fx_seat(v_main, 1, v_both);
  PERFORM public.fx_seat(v_main, 2, v_seat_only);

  -- NON-VACUITY: two chairs, two players, no pool and no overlap yet.
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 0
     OR (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 20: the board starts at live % seated % lightning % both %, not 2 / 2 / 0 / 0',
      v_pop ->> 'live_eligible', v_pop -> 'counted' ->> 'seated_eligible',
      v_pop -> 'counted' ->> 'lightning_eligible', v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;

  -- THE WINDOW OPENS. The seated human at seat 1 is given an ACTIVE pool
  -- session at this cluster and this epoch, which is exactly what a Phase 5
  -- conversion writes before the chair is given up. Written directly rather
  -- than through fx_pool_session, because that helper invents a new player and
  -- the whole point here is that it is the SAME human.
  SELECT tb.id INTO v_t FROM public.tables tb WHERE tb.cluster_id = v_g ORDER BY tb.created_at LIMIT 1;
  INSERT INTO public.cash_player_session (player_id, scope_type, scope_id, table_id, cluster_id)
  VALUES (v_both, 'cluster', v_g, v_t, v_g) RETURNING id INTO v_cs;
  INSERT INTO public.lightning_pool_session
    (cluster_id, cluster_epoch, player_id, cash_player_session_id, state)
  VALUES (v_g, 0, v_both, v_cs, 'active') RETURNING id INTO v_ps;
  INSERT INTO public.lightning_pool_slot (pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  VALUES (v_ps, v_g, 0, v_both, 1);

  v_pop := public.fx_pop(v_g);
  -- THE NUMBER COUNTS THAT HUMAN ONCE. Two chairs and one pool session, and the
  -- answer is two players, because one of the three rows is the same person as
  -- one of the others.
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 20: a seated player who also holds an active pool session was counted % times - live_eligible reads % where two humans are present. One human is one player, in the conversion window as well as outside it.',
      (v_pop ->> 'live_eligible')::integer - 1, v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: counted.seated_and_pooled reads %, not the 1 human who is in both halves',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  -- AND BOTH HALVES STILL REPORT HIM, which is what makes the overlap an
  -- overlap rather than a reassignment.
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 20: the seated half dropped the player who joined the pool (% of 2)',
      v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: the Lightning half does not report the player who joined it (% of 1)',
      v_pop -> 'counted' ->> 'lightning_eligible';
  END IF;
  -- THE FOUR-TERM IDENTITY, with the overlap term finally non-zero. Everywhere
  -- else in this file it is 0 and the identity reduces to the sum; this is the
  -- board it was written for.
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: % + % - % - % is not the live_eligible % it reports',
      v_pop -> 'counted' ->> 'seated_eligible', v_pop -> 'counted' ->> 'lightning_eligible',
      v_pop -> 'counted' ->> 'seated_and_pooled', v_pop -> 'counted' ->> 'disconnected',
      v_pop ->> 'live_eligible';
  END IF;

  -- A THIRD HUMAN IN THE POOL ONLY, so the section cannot pass on a function
  -- that reports the intersection, or the seated half, or the pool half, as the
  -- whole population. Three humans now: one in both, one only seated, one only
  -- pooled - and the answer is three.
  PERFORM public.fx_pool_session(v_g, 'WINDOW_POOL_ONLY', 'active');
  v_pop := public.fx_pop(v_g);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 20: one human in both halves, one only seated and one only pooled read % live eligible, not 3',
      v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'lightning_eligible')::integer IS DISTINCT FROM 2
     OR (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: the three-human board reads seated % lightning % both %, not 2 / 2 / 1',
      v_pop -> 'counted' ->> 'seated_eligible', v_pop -> 'counted' ->> 'lightning_eligible',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: the four-term identity fails on the three-human board';
  END IF;

  -- AND NOW THE COMBINATION NOTHING ELSE IN THIS FILE EXERCISES: a real overlap
  -- AND a non-NULL disconnect count, on the same board, at the same time. The
  -- fourth term of the identity exists only for this path and is zero on every
  -- other board here, so this is where a three-term identity - which was what
  -- this section asserted until the migration corrected it - stops being true.
  --
  -- The board reads seated 2, lightning 2, overlap 1, so three humans. Handed a
  -- disconnect count of 2 the number is 1, and the three-term arithmetic would
  -- say 3. Both are asserted: the four-term form must give 1, and the three-term
  -- form must NOT - which is what makes the fourth term load-bearing here rather
  -- than an extra zero.
  v_pop := public.fx_pop(v_g, 2);
  IF (v_pop -> 'counted' ->> 'disconnected')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 20: the board was handed a disconnect count of 2 and reports %',
      v_pop -> 'counted' ->> 'disconnected';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: the overlap vanished when a disconnect count was handed down (% of 1)',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: three humans less two disconnects reads % live eligible, not 1', v_pop ->> 'live_eligible';
  END IF;
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: the four-term identity fails with an overlap AND a disconnect count on the same board';
  END IF;
  IF ((v_pop -> 'counted' ->> 'seated_eligible')::integer
      + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
      - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer)
     IS NOT DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: the THREE-term form still gives live_eligible on this board, so the disconnect term is an extra zero here and this case proves nothing about it';
  END IF;

  -- AND THE CLAMP AT ZERO, on both sides of the identity at once: more
  -- disconnects than there are humans is 0 rather than a negative population
  -- that a threshold comparison would read as "far below OFF".
  v_pop := public.fx_pop(v_g, 9);
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 20: nine disconnects among three humans reads % live eligible', v_pop ->> 'live_eligible';
  END IF;
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: the four-term identity fails where both sides of it clamp at zero';
  END IF;

  -- AND THE OVERLAP IS ONLY AN OVERLAP WHILE BOTH HALVES ACCEPT HIM. Taking the
  -- chair away leaves three rows and two players, which is the same arithmetic
  -- read from the other side: the seated half falls, the overlap falls with it,
  -- and the number does not move because he is still in the pool. This is the
  -- conversion COMPLETING, and it is the pair that stops seated_and_pooled
  -- being a counter that is always 1.
  UPDATE public.table_seats ts SET leave_pending = true
    FROM public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.user_id = v_both;
  v_pop := public.fx_pop(v_g);
  IF (v_pop -> 'counted' ->> 'seated_and_pooled')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 20: a player whose chair is no longer eligible is still counted in both halves (% of 0)',
      v_pop -> 'counted' ->> 'seated_and_pooled';
  END IF;
  IF (v_pop ->> 'live_eligible')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 20: giving up the chair while still in the pool moved the population to %, and it should not move at all',
      v_pop ->> 'live_eligible';
  END IF;
  IF (v_pop -> 'counted' ->> 'seated_eligible')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: the seated half reads % after one of its two chairs became ineligible',
      v_pop -> 'counted' ->> 'seated_eligible';
  END IF;
  IF GREATEST(0, (v_pop -> 'counted' ->> 'seated_eligible')::integer
                 + (v_pop -> 'counted' ->> 'lightning_eligible')::integer
                 - (v_pop -> 'counted' ->> 'seated_and_pooled')::integer
                 - (v_pop -> 'counted' ->> 'disconnected')::integer)
     IS DISTINCT FROM (v_pop ->> 'live_eligible')::integer THEN
    RAISE EXCEPTION 'FAIL 20: the four-term identity fails once the chair is given up';
  END IF;
  -- Put him back, so the estate carries a live overlap into the sections below
  -- and into the re-apply, where the migration's own two identity @live-proofs
  -- are then asked of a board that really has one.
  UPDATE public.table_seats ts SET leave_pending = false
    FROM public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.user_id = v_both;
  IF public.fx_cnt(v_g, 'seated_and_pooled') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 20: sitting the player back down did not restore the overlap';
  END IF;

  -- AND THE GUARD IS ASSERTED IN THE INSTALLED BODY, BOTH HALVES OF IT.
  --
  -- THE GUARD IS DOUBLED, ON PURPOSE, AND THE FILE NOW SAYS SO. The body reads
  -- `count(DISTINCT u.player_id)` over `... UNION ...`, and EITHER of those
  -- alone already counts the conversion-window human once: UNION deduplicates
  -- the rows before the count sees them, and count(DISTINCT) deduplicates them
  -- afterwards. Mutation testing established that, and it is the reason both
  -- halves are pinned here rather than one: `UNION` -> `UNION ALL` and
  -- `count(DISTINCT u.player_id)` -> `count(u.player_id)` are each
  -- BEHAVIOURALLY EQUIVALENT on every board this estate can build, so the
  -- assertions above - which are about the answer - cannot see either of them.
  -- Only removing both is visible in an answer, and that IS caught above and in
  -- section 15. What the three text assertions below add is that no SINGLE edit
  -- can get halfway there unnoticed, which is the whole value of doubling it.
  --
  -- Read against the body with its line comments stripped, the same way the
  -- migration's own @live-proof #16 now reads it, because a comment that
  -- explains why UNION ALL must not be there is not a UNION ALL - and this file
  -- shipped three proofs that could not tell those apart.
  DECLARE
    v_body text;
  BEGIN
    v_body := regexp_replace(
                pg_get_functiondef('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure),
                '--[^' || chr(10) || ']*', '', 'g');
    IF (v_body ~ 'UNION') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 20: the predicate does not take a UNION of its two halves at all';
    END IF;
    IF (v_body !~ 'UNION ALL') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 20: the predicate takes a UNION ALL, which is half the doubled guard gone';
    END IF;
    IF (v_body ~ 'count\(DISTINCT u.player_id\)') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 20: the predicate does not count DISTINCT players over the union, which is the other half of the doubled guard';
    END IF;
    -- NON-VACUITY FOR THE STRIPPER: it left a body with its two relations still
    -- in it, so the three tests above are about the code and not about
    -- regexp_replace having eaten it.
    IF (v_body ~ 'lightning_pool_session' AND v_body ~ 'table_seats') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 20: stripping the comments left a body with neither of its two relations in it';
    END IF;
  END;
END $$;
\echo '  ok  20 THE CONVERSION WINDOW   a human who is seated with chips AND holds an active lightning_pool_session at the same cluster and epoch - the window a Phase 5 conversion opens, and the moment the threshold is read - is counted ONCE by live_eligible, is reported by BOTH halves, and raises counted.seated_and_pooled to exactly 1, with a second human seated only and a third pooled only so the board reads 3 rather than the overlap or either half alone, the four-term identity GREATEST of zero and seated_eligible plus lightning_eligible less seated_and_pooled less counted.disconnected holding at every step including when the chair is given up and the population does not move because he is still in the pool, and - the combination nothing else in this file builds - with the overlap AND a disconnect count of 2 on the same board at once where the number is 1 and the four-term form gives 1 while the THREE-term form does not, and with nine disconnects among three humans where both sides of the identity clamp to zero'

-- 21 NOTHING CONVERTED -------------------------------------------------------
-- "It converts nothing. cluster_mode is not written, no epoch moves, no player
-- is seated or unseated." Everything above this line has read thresholds,
-- populations, verdicts and health for fifteen Clusters, some of them at and
-- above their ON threshold with every gate open. If any of that had a write in
-- it, this is where it shows.
--
-- The comparison is against what each Cluster WAS - recorded at the moment it
-- was created, which for the seeded ones is the moment the migration finished
-- - and not against the constant 'must_move', because one of these Clusters
-- has been in cluster_mode lightning since it was made and a check that
-- expected must_move everywhere would be asserting the fixture rather than the
-- migration.
DO $$
DECLARE v_bad text; v_n bigint;
BEGIN
  -- NON-VACUITY, THREE WAYS.
  SELECT count(*) INTO v_n FROM cluster_baseline;
  IF (v_n >= 12::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 21: only % cluster(s) were ever recorded, so "nothing converted" is a sentence about almost nothing', v_n;
  END IF;
  IF (SELECT count(*) FROM public.cash_games) IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'FAIL 21: % clusters exist and % were recorded, so some of them are not being checked',
      (SELECT count(*) FROM public.cash_games), v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cluster_baseline WHERE mode = 'lightning') THEN
    RAISE EXCEPTION 'FAIL 21: no cluster was ever in lightning, so "its mode is what it was" is a restatement of the default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM harness_moved) THEN
    RAISE EXCEPTION 'FAIL 21: the harness never moved a cluster_mode at all, so "it came back" is a sentence about a column nothing touched';
  END IF;

  -- EVERY MODE AND EVERY EPOCH IS WHAT IT WAS.
  SELECT string_agg(g.name || ' (' || b.mode || ' -> ' || g.cluster_mode || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g JOIN cluster_baseline b ON b.game_id = g.id
   WHERE g.cluster_mode IS DISTINCT FROM b.mode;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 21: a phase that converts nothing converted %', v_bad;
  END IF;
  SELECT string_agg(g.name || ' (' || b.epoch || ' -> ' || g.cluster_epoch || ')', ', ' ORDER BY g.name)
    INTO v_bad
    FROM public.cash_games g JOIN cluster_baseline b ON b.game_id = g.id
   WHERE g.cluster_epoch IS DISTINCT FROM b.epoch;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 21: a phase that moves no epoch moved %', v_bad;
  END IF;

  -- AND NO EPOCH ROW MOVED. One row per cluster, all of them still open, each
  -- at the epoch its cluster is at, under the mode its cluster is in, and
  -- every one of them still a genesis row: an epoch that had been ENDED and
  -- reopened would read the same cluster_epoch and is caught only here.
  IF (SELECT count(*) FROM public.cash_cluster_epoch)
     IS DISTINCT FROM (SELECT count(*) FROM public.cash_games) THEN
    RAISE EXCEPTION 'FAIL 21: % epoch row(s) for % cluster(s)',
      (SELECT count(*) FROM public.cash_cluster_epoch), (SELECT count(*) FROM public.cash_games);
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE ended_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 21: % epoch row(s) have been ended, and nothing here ends an epoch', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_cluster_epoch WHERE started_by IS DISTINCT FROM 'genesis';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 21: % epoch row(s) were started by something other than genesis', v_n;
  END IF;
  SELECT string_agg(g.name, ', ' ORDER BY g.name) INTO v_bad
    FROM public.cash_games g
   WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                      WHERE e.cluster_id = g.id AND e.ended_at IS NULL
                        AND e.epoch = g.cluster_epoch AND e.mode = g.cluster_mode);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 21: the open epoch row no longer agrees with the cluster for %', v_bad;
  END IF;
END $$;
\echo '  ok  21 NOTHING CONVERTED       after every threshold population verdict and health read above, all fifteen-odd clusters are in the cluster_mode and at the cluster_epoch they were created with - compared against what each one WAS and not against the constant must_move, because one of them has been in lightning since it was made and the harness itself moved another one and put it back - and cash_cluster_epoch still holds exactly one row per cluster, every one of them open, started_by genesis, at its cluster own epoch and under its cluster own mode'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- THE ONLY TWO THINGS THE SECOND APPLICATION NEEDS PUT BACK -------------------
-- The migration's post-apply block makes exactly two demands of the DATA, and
-- the boards are not one of them:
--
--   Every cluster is must_move. It counts that and refuses at anything else,
--   because this is a phase that converts nothing.
--
--   No cluster carries ruleset_snapshot -> lightning. It reads the mandated
--   defaults off `WHERE handedness <= 6 LIMIT 1` and `WHERE handedness > 6
--   LIMIT 1`, both UNORDERED, so one configured cluster in either band would
--   make which row that LIMIT returned decide whether the file applies.
--
-- AND THE BOARDS STAY. An earlier cut of this harness tore every seat out
-- before the re-apply, because an earlier cut of the migration asserted
-- `to_on = 18` on that same unordered row - a property of the DATA that one
-- seated player turned into a refusal to apply. That check is gone: what it
-- asserted about the CODE is now a relationship recomputed for EVERY cluster.
-- So the second application runs its whole read-back over eighteen real boards
-- carrying sitting-out, leaving, busted and empty chairs, a Lightning pool,
-- stale holds on closed tables and a ladder at seventeen - which is a far
-- better test of that read-back than an empty estate was.
UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot - 'lightning'
 WHERE ruleset_snapshot -> 'lightning' IS NOT NULL;
UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE cluster_mode <> 'must_move';

-- And it really IS the shape the migration expects, said here rather than
-- discovered inside the migration, because a failure there reads as "Phase 4
-- is broken" and a failure here reads as "this teardown is".
DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_n IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'FAIL teardown: % cluster(s) are not must_move', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.cash_games WHERE ruleset_snapshot -> 'lightning' IS NOT NULL;
  IF v_n IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'FAIL teardown: % cluster(s) still carry a lightning ruleset', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness <= 6)
     OR NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness > 6) THEN
    RAISE EXCEPTION 'FAIL teardown: one of the two handedness bands is empty and the migration refuses to commit without both';
  END IF;
  -- NON-VACUITY FOR THE RE-APPLY ITSELF: the boards really are still standing,
  -- so the second application's read-back has something to read back over.
  SELECT count(*) INTO v_n FROM public.table_seats WHERE left_at IS NULL;
  IF (v_n >= 60::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: only % chair(s) are standing before the re-apply, so the second read-back runs over almost nothing', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g WHERE public.fx_live(g.id) > 0;
  IF (v_n >= 8::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: only % cluster(s) have a population before the re-apply', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.lightning_pool_session WHERE exited_at IS NULL AND state = 'active';
  IF (v_n >= 1::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: no Lightning pool is standing before the re-apply';
  END IF;
END $$;

-- WHAT THE SECOND APPLICATION MUST NOT CHANGE. Five bodies, five access
-- control lists, five comments, every cash_games row, every epoch row and
-- every chair.
CREATE TEMP TABLE pre_reapply_fn AS
  SELECT p.fn,
         pg_get_functiondef(p.fn::regprocedure) AS def,
         coalesce((SELECT string_agg(x::text, E'\n' ORDER BY x::text)
                     FROM unnest(pr.proacl) x), '<owner default>') AS acl,
         coalesce(obj_description(p.fn::regprocedure, 'pg_proc'), '<none>') AS cmt,
         has_function_privilege('service_role', p.fn::regprocedure, 'EXECUTE') AS svc,
         has_function_privilege('anon',          p.fn::regprocedure, 'EXECUTE') AS anon_,
         has_function_privilege('authenticated', p.fn::regprocedure, 'EXECUTE') AS auth_
    FROM (VALUES
      ('public.fn_cash_cluster_lightning_thresholds(uuid)'),
      ('public.fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'),
      ('public.fn_cash_cluster_population(uuid,timestamp with time zone,integer)'),
      ('public.fn_cash_cluster_lightning_state(uuid)'),
      ('public.fn_cash_cluster_pool_health(uuid,timestamp with time zone)')) AS p(fn)
    JOIN pg_proc pr ON pr.oid = p.fn::regprocedure;

CREATE TEMP TABLE pre_reapply_games  AS SELECT * FROM public.cash_games;
CREATE TEMP TABLE pre_reapply_epochs AS SELECT * FROM public.cash_cluster_epoch;
CREATE TEMP TABLE pre_reapply_seats AS SELECT * FROM public.table_seats;
CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM pre_reapply_fn)            AS fns,
         (SELECT count(*) FROM public.cash_games)         AS games,
         (SELECT count(*) FROM public.tables)             AS tables_,
         (SELECT count(*) FROM public.cash_cluster_epoch) AS epochs,
         (SELECT count(*) FROM public.table_seats)        AS seats;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'

-- 23 RE-APPLY IS A NO-OP -----------------------------------------------------
-- All four of these are CREATE OR REPLACE, so a second application is expected
-- to be silent - but "it exited 0" is not the question. A REPLACE that landed
-- a different body, a REVOKE/GRANT pair that left a different access control
-- list, or a COMMENT that drifted would all exit 0, and all three are the kind
-- of difference that turns up months later as "the function on production is
-- not the function in the file".
--
-- So the comparison is byte for byte, on all three of those, for all four
-- functions, against a capture taken from the catalogue before the second
-- application rather than from the source text.
DO $$
DECLARE c pre_reapply_counts%ROWTYPE; v_bad text;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.fns IS NULL THEN RAISE EXCEPTION 'FAIL 23: the pre-re-apply capture is empty'; END IF;
  IF c.fns IS DISTINCT FROM 5::bigint THEN
    RAISE EXCEPTION 'FAIL 23: % function bodies were captured, not the five this migration writes', c.fns;
  END IF;
  -- NON-VACUITY: there is an estate to leave alone, and it is seated.
  IF (c.games >= 12::bigint AND c.tables_ >= 12::bigint AND c.epochs >= 12::bigint
      AND c.seats >= 60::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 23: the estate is too thin before the re-apply (games % / tables % / epochs % / seats %), so "nothing moved" compares almost nothing',
      c.games, c.tables_, c.epochs, c.seats;
  END IF;

  -- THE FIVE BODIES, BYTE FOR BYTE.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE pg_get_functiondef(p.fn::regprocedure) IS DISTINCT FROM p.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 23: the second application changed the body of %', v_bad;
  END IF;

  -- THE FOUR ACCESS CONTROL LISTS, and the four comments with them.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE coalesce((SELECT string_agg(x::text, E'\n' ORDER BY x::text)
                     FROM pg_proc pr, unnest(pr.proacl) x
                    WHERE pr.oid = p.fn::regprocedure), '<owner default>') IS DISTINCT FROM p.acl;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 23: the second application changed who may execute %', v_bad;
  END IF;
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE coalesce(obj_description(p.fn::regprocedure, 'pg_proc'), '<none>') IS DISTINCT FROM p.cmt;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 23: the second application changed the comment on %', v_bad;
  END IF;

  -- GRANTS IN BOTH DIRECTIONS, after the second pass as after the first. The
  -- negative half alone stays green when the whole family is unreachable by
  -- the API role, which is the failure that matters most: these functions feed
  -- a threshold, and an INVOKER function run by a browser role would return a
  -- SMALLER count rather than an error.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE has_function_privilege('service_role', p.fn::regprocedure, 'EXECUTE') IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 23: service_role cannot execute %', v_bad;
  END IF;
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad
    FROM pre_reapply_fn p
   WHERE has_function_privilege('anon', p.fn::regprocedure, 'EXECUTE') IS DISTINCT FROM false
      OR has_function_privilege('authenticated', p.fn::regprocedure, 'EXECUTE') IS DISTINCT FROM false;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 23: a browser role can execute %', v_bad;
  END IF;
  -- And the capture itself was not vacuous in either direction: service_role
  -- really did hold it before, and the browser roles really did not.
  IF EXISTS (SELECT 1 FROM pre_reapply_fn WHERE svc IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'FAIL 23: service_role did not hold EXECUTE before the re-apply either, so the positive half proves nothing';
  END IF;
  IF EXISTS (SELECT 1 FROM pre_reapply_fn WHERE anon_ IS DISTINCT FROM false OR auth_ IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'FAIL 23: a browser role already held EXECUTE before the re-apply';
  END IF;

  -- AND NOT ONE COLUMN OF ONE ROW MOVED. The post-apply block of this file
  -- reads every cluster's population twice; a read that wrote would land here.
  IF EXISTS (SELECT * FROM pre_reapply_games EXCEPT SELECT * FROM public.cash_games)
     OR EXISTS (SELECT * FROM public.cash_games EXCEPT SELECT * FROM pre_reapply_games) THEN
    RAISE EXCEPTION 'FAIL 23: a cash_games row changed on the second application';
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_epochs EXCEPT SELECT * FROM public.cash_cluster_epoch)
     OR EXISTS (SELECT * FROM public.cash_cluster_epoch EXCEPT SELECT * FROM pre_reapply_epochs) THEN
    RAISE EXCEPTION 'FAIL 23: a cash_cluster_epoch row changed on the second application';
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_seats EXCEPT SELECT * FROM public.table_seats)
     OR EXISTS (SELECT * FROM public.table_seats EXCEPT SELECT * FROM pre_reapply_seats) THEN
    RAISE EXCEPTION 'FAIL 23: a table_seats row changed on the second application';
  END IF;
END $$;

-- AND THE FUNCTIONS STILL WORK AFTER IT. Five byte-identical bodies prove the
-- text did not move; this proves the text is still the thing that answers.
DO $$
DECLARE v_g uuid; v_th jsonb;
BEGIN
  SELECT id INTO v_g FROM public.cash_games WHERE handedness <= 6 ORDER BY created_at LIMIT 1;
  v_th := public.fn_cash_cluster_lightning_thresholds(v_g);
  IF (v_th ->> 'on')::integer IS DISTINCT FROM 18 OR (v_th ->> 'off')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 23: after the second application a six-max cluster reads % / %', v_th ->> 'on', v_th ->> 'off';
  END IF;
  SELECT game_id INTO v_g FROM board WHERE k = 'ladder_six';
  PERFORM public.fx_populate(v_g, 18);
  IF public.fx_live(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 23: after the second application eighteen players read % live eligible', public.fx_live(v_g);
  END IF;
  IF public.fx_verdict(v_g, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 23: after the second application a six-max cluster at eighteen no longer says it would turn Lightning on';
  END IF;
  PERFORM public.fx_populate(v_g, 17);
  IF public.fx_verdict(v_g, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 23: after the second application a six-max cluster at seventeen says it would turn Lightning on';
  END IF;
  -- AND THE FOUR READERS STILL AGREE ON THE NUMBER, on every cluster, after the
  -- second pass: "one predicate" is the claim the whole restructure rests on
  -- and a REPLACE that installed an older body would break it here.
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE (public.fn_cash_cluster_population(g.id) ->> 'live_eligible')::integer
                    IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)
                 OR (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'live_eligible')::integer
                    IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)
                 OR (public.fn_cash_cluster_pool_health(g.id) ->> 'live_eligible')::integer
                    IS DISTINCT FROM public.fn_cash_cluster_live_eligible(g.id)) THEN
    RAISE EXCEPTION 'FAIL 23: after the second application the readers no longer agree with the one predicate';
  END IF;
END $$;
\echo '  ok  23 RE-APPLY IS A NO-OP     the migration applied a second time over every board this file built, all of them still STANDING - sitting-out leaving busted and empty chairs, a Lightning pool, an overlapping conversion-window player, stale holds on closed tables and a ladder at seventeen - left all five function bodies byte-identical along with their five access control lists and their five comments, changed no cash_games row no cash_cluster_epoch row and no table_seats row, still grants EXECUTE to service_role and still withholds it from anon and authenticated with both halves proved non-vacuous against the pre-re-apply capture, and the functions still answer: 18 / 12 on a six-max cluster, would_turn_on true at eighteen and false at seventeen, and all four readers still agreeing with the one predicate on every cluster'
REAPPLY


# 22 EVERY @live-proof THE MIGRATION MAKES, EVALUATED ---------------------------
# The migration ends its header with a block of `-- @live-proof:` lines: scalar
# SQL expressions meant to be true of the database the file produces. They are
# COMMENTS, so nothing in a psql run evaluates them - which is how this file
# came to ship THREE that were false, in three separate rounds, every one of
# them the proof drifting away from code that was right:
#
#   `position('fn_cash_cluster_population' in pg_get_functiondef(...state...)) = 0`
#   was false because the reader's own comment names the function it must not
#   call. `~ '''horses'', v_horses'` was false because the object it reads had
#   been column-aligned. `!~ 'UNION ALL'` was false because the predicate's own
#   comment explained why UNION ALL must not be there.
#
# All three are fixed, and six proofs now read the body through
# regexp_replace(..., '--[^chr(10)]*', '', 'g') so that a comment quoting what a
# proof forbids can never again be mistaken for the code doing it. There is no
# quarantine here and there must not be one: every proof in the file is
# evaluated and every one must be true.
#
# Generated from the file under test rather than written by hand, for the same
# reason the harness applies the real predecessor migrations rather than
# transcribing them: a hand-copied list is a second place for a proof to drift,
# and drift is the only thing this section exists to catch. The matrix carries
# two mutations for it - a proof whose regex goes stale, and one of the six
# comment-stripping wrappers reverted - and both are caught here and nowhere
# else in this file.
#
# It runs AFTER the teardown, which is where every cluster is must_move again -
# one of the proofs says so - and BEFORE the second application, so what it
# reads is the catalogue and the estate the FIRST application left behind, with
# every board still standing including the overlapping conversion-window player.
: > "$fixture/live-proofs.sql"
printf '%s\n' 'CREATE TEMP TABLE lp (n integer, lineno integer, ok boolean);' \
  >> "$fixture/live-proofs.sql"
proof_n=0
while IFS= read -r proof_line; do
  proof_n=$((proof_n + 1))
  proof_lineno=${proof_line%%:*}
  proof_expr=${proof_line#*:}
  proof_expr=${proof_expr#-- @live-proof: }
  # The expression is inlined as CODE, never as a string literal, so nothing in
  # it needs escaping and a proof that no longer PARSES fails the run too -
  # which is itself a kind of drift worth catching.
  {
    printf '%s%s%s%s%s' 'INSERT INTO lp VALUES (' "$proof_n" ', ' "$proof_lineno" ', coalesce(('
    printf '%s%s\n' "$proof_expr" ')::boolean, false));'
  } >> "$fixture/live-proofs.sql"
done < <(grep -n -- '^-- @live-proof: ' "$migration")

if [ "$proof_n" -lt 15 ]; then
  echo "FAIL 22: only $proof_n @live-proof line(s) were found in $migration, so this section would prove almost nothing"
  exit 1
fi

{
  printf '%s\n' 'DO $lp$'
  printf '%s\n' 'DECLARE v_bad text; v_n integer;'
  printf '%s\n' 'BEGIN'
  printf '%s%s%s\n' '  SELECT count(*)::integer INTO v_n FROM lp; IF v_n IS DISTINCT FROM ' "$proof_n" ' THEN'
  printf '%s%s%s\n' "    RAISE EXCEPTION 'FAIL 22: % of the " "$proof_n" " proof expressions were evaluated', v_n;"
  printf '%s\n' '  END IF;'
  printf '%s\n' '  -- NON-VACUITY: a run in which every proof answered NULL would coalesce to'
  printf '%s\n' '  -- false and fail below, and a run in which the table was empty fails above.'
  printf '%s\n' "  SELECT string_agg('#' || n || ' (line ' || lineno || ' of the migration)', ', ' ORDER BY n) INTO v_bad"
  printf '%s\n' '    FROM lp WHERE ok IS DISTINCT FROM true;'
  printf '%s\n' '  IF v_bad IS NOT NULL THEN'
  printf '%s\n' "    RAISE EXCEPTION 'FAIL 22: the migration carries @live-proof % that is NOT true of the database it just produced', v_bad;"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END $lp$;'
  printf '%s%s%s\n' "\\echo '  ok  22 EVERY LIVE PROOF    all " "$proof_n" " @live-proof expressions the migration carries in its own header were extracted from the file under test, inlined as code so that one which no longer PARSES is a failure too, and evaluated against the throwaway catalogue and the estate the first application left behind - every board still standing, with an overlapping conversion-window player among them - and every single one of them is true, with no quarantine and no exception list'"
} >> "$fixture/live-proofs.sql"

# ONE psql session, eleven files: the base fixture and the Phase 4 delta, the
# four real migrations this one sits on top of, the migration, the assertions,
# the migration's own @live-proofs evaluated against what it produced, the
# migration AGAIN, and the re-apply assertions. One session because the boards
# built by one section are read by the next, because the @live-proof block must
# see the estate the first application left behind, and because the
# pre-re-apply capture has to be a TEMP table in the same backend the second
# application lands in.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55547 -d postgres \
  -f "$base_fixture" \
  -f "$delta_fixture" \
  -f "$phase2" \
  -f "$phase2r" \
  -f "$phase3" \
  -f "$phase3r" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql" 2>&1 | grep -v -E '^psql:.*: NOTICE:' | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# TWENTY-ONE SECTIONS REPORTED, and the count is asserted rather than eyeballed: a
# psql that stopped early exits non-zero, but a section deleted from this file
# during a refactor would not, and the PASS line below would still print.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 23 ]; then
  echo "FAIL: $oks of the 23 sections reported, so this run proved less than this file claims"
  exit 1
fi

echo 'PASS: Lightning Phase 4, one live eligible population and the thresholds it is judged by, 23 checks: the mandated defaults are 18 / 12 on the six-max band and 27 / 18 on the full ring with the boundary asked from both sides at handedness 6 and 7 and the four numbers asserted as literals rather than rederived, ruleset_snapshot -> lightning is read when it names a number and HALF a configuration leaves the other number at its own band default under source ruleset, seventeen nonsense configurations fall back to the defaults of their own band without raising anywhere on the path a tick takes, a plain board of seven across a Main and a feeder reads live_eligible 7 three different ways under a six-key excluded object and a breakdown that says it is not arithmetic, each of is_sitting_out leave_pending a zero or NULL stack a NULL user_id and a set left_at drops it by exactly one and each comes back when it is undone while seated_total counts OCCUPIED chairs and an empty chair is filed under excluded.empty_chairs alone and is still a row to the census, A HORSE COUNTS EXACTLY LIKE A HUMAN under Law 10.5 with a board of nothing but horses reporting the full population to the census and to the verdict, a cash_game_waitlist row and a live table_waitlist hold are reported under excluded and never added while an expired hold is not even reserved, a pending cash_seat_moves row raises counted.pending_movers and moves nothing because a move inside a Cluster is not a leave, a deleted a closed and a not-running table become invisible to fn_cash_cluster_census and to the population TOGETHER and the two agree on the table count and the seat total for every cluster, the population is never larger than the board count and is EQUAL to it when nothing is excluded and STRICTLY below it when something is with the four-term identity - the two halves less the overlap less the disconnect count, floored at zero - exactly live_eligible everywhere at p_disconnected NULL and at 2, an active lightning_pool_session is in the population while sit_out leaving closed joining and exited are not and a committed reservation on a live instance and a participation in an unsettled hand raise their own counters without moving it, the four categories PostgreSQL cannot see are named under confidence partial and p_disconnected moves disconnected out of that list flips it to engine and subtracts with zero still an answer and a negative clamped rather than added, the verdict answers spec acceptance F02 F03 F09 and F10 at their exact boundary - six-max 17 / 18 / 19 and full ring 26 / 27 - and the Phase 10 ladder at 13 / 12 / 11 with the three gates shut and reopened one at a time, pool health reports the population own live_eligible the one place thresholds headroom both ways occupancy to one decimal and the slot distribution with p95 and p99 as the max and hands and fast folds as the sum and answers ok false for a cluster that does not exist rather than raising, ONE PREDICATE: the breakdown the verdict and pool health all report exactly what fn_cash_cluster_live_eligible reports on every board including at a disconnect count, its four terms - the two halves less the overlap less the disconnect count, floored at zero - give its own number back on every cluster at p_disconnected NULL and at 2, and the predicate counts PLAYERS so the same human at two of the Cluster tables counts once, a notified hold on a deleted a closed or a not-running table is no longer a reserved seat and excluded.reserved_seat equals the census summed reserved on every cluster, the breakdown is CATEGORIES not terms - a seat both sitting out and busted is in both, an empty chair is in empty_chairs alone, a role-less table seat is in seated_no_role, and subtracting the exclusions really does not give seated_eligible - lightning_idle is COUNTED so one active player holding nothing beside one sat-out player holding a committed seat reads idle 1 and in_instance 0, the reader the lobby embeds calls the two-statement predicate and not the nine-statement breakdown with its comments stripped so a comment naming the breakdown cannot be mistaken for a call to it, THE CONVERSION WINDOW: a human seated with chips who ALSO holds an active pool session at the same cluster and epoch is counted ONCE, is reported by both halves, raises counted.seated_and_pooled to 1, and sits on a board with one seated-only and one pooled-only human that reads 3 and reads 1 when handed a disconnect count of 2 where the three-term form would have said 3 - the doubled guard that makes it so - a UNION and a count(DISTINCT), each of which alone would already do it, so that no single edit can get halfway there unnoticed - asserted in the installed body with its comments stripped - every cluster is still in the cluster_mode and at the cluster_epoch it was created with and cash_cluster_epoch still holds one open genesis row each, EVERY @live-proof the migration carries is extracted from the file under test and inlined as code and evaluated against what that file produced and every one of them is true with no quarantine and no exception list - section 22 prints the count it actually found, and the migration applied a second time over every board this file built, all still standing, leaves all five bodies all five access control lists and all five comments byte-identical moves no cash_games cash_cluster_epoch or table_seats row and leaves all four readers still agreeing with the one predicate'
