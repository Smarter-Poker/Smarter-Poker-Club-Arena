#!/usr/bin/env bash
# Lightning Phase 5: the MUST-MOVE -> LIGHTNING conversion is one transaction,
# the tables stop dealing, and the tick and the balancer stand down.
#
# Applies the real fixture chain - including the REAL 44KB fn_cash_cluster_tick
# and the REAL fn_cash_cluster_balance, assembled by line range out of the
# migrations that produced them - and then 20260921151618 itself, and exercises
# every claim it makes against a running catalogue and a running estate rather
# than against a reading of the file.
#
# WHAT IS ACTUALLY AT RISK HERE, AND WHY THE SECTIONS ARE SHAPED THE WAY THEY
# ARE.
#
#   A SUBSTITUTION INTO A FAKE IS THE FIRST AND WORST FAILURE. Two of this
#   migration's eight sections do not write a function body: they read one out
#   of pg_get_functiondef, assert an anchor occurs exactly once, replace() it
#   and EXECUTE the result. Against a stub body that happened to carry the
#   anchor, all of that succeeds and proves precisely nothing - the anchor
#   assertion passes, the growth assertion passes, the guard-survival assertion
#   passes, and not one line of the 40,443-character function anybody actually
#   runs has been tested. So scripts/dev/fixtures/lightning-phase5-conversion-schema.sql
#   carries the REAL tick: 20260906015029 lines 61-645, the last migration to
#   define the whole body, followed by the tick substitution blocks of
#   20260907171507, 20260907173251, 20260909035726, 20260909181632 and
#   20260909181704, each lifted whole out of its own file and applied in version
#   order, and then 20260921025523 and 20260921044045 applied by this harness on
#   top. Section 01 runs BEFORE the migration and measures that body: over
#   40,000 characters, the anchor exactly once, fn_platform_frozen and FOR
#   UPDATE and manual_game present, is_horse absent, no stand-down yet - and a
#   must_move tick that really plans seat moves and really writes tables, so
#   that "the stood-down tick moved nothing" in section 09 is a statement about
#   the stand-down and not about a tick that never did anything.
#
#   AN INVARIANT NOBODY MEASURES IS AN INVARIANT NOBODY KNOWS ABOUT. F12 says
#   no money moves. The migration's own defence is that it never writes
#   table_seats, which is true and is asserted from the catalogue - and is also
#   exactly the kind of claim that survives the day someone adds a write. So
#   section 04 does not compare a sum. It compares an md5 of every column of
#   every table_seats row of the Cluster, ordered, before and after, and the
#   same for cash_player_session: same id, same opened_at, still open, same
#   baseline, same stay clock. A stack that moved and came back would pass a
#   sum and fail this.
#
#   AN ABORT THAT STRANDS SOMEBODY is F04, and the reason it cannot happen here
#   is step ordering rather than cleanup: PENDING_ON creates no pool session and
#   moves no epoch, so an abort is a two-column clear. Section 05 proves that
#   twice - once through the commit's own re-check, which aborts by itself when
#   the population falls, and once through a direct abort_pending_on call - and
#   asserts each time that the mode went back, that every halt was lifted, that
#   the conversion row says aborted WITH a reason, that no pool session exists
#   anywhere, and that the tables can deal again in the only sense the database
#   has: dealing_halted_at is NULL and the tick, run again, plans moves again.
#
#   TWO DIFFERENT RACES WEAR THE SAME NAME. F13 is not one test. Two converters
#   with DIFFERENT request ids must produce exactly one conversion, and the
#   second must be told what state the Cluster is in rather than silently
#   no-opping; the SAME request id twice must be idempotent and must answer with
#   what already happened. Section 06 does both, and proves the partial unique
#   index cash_cluster_conversion_one_open_per_cluster is what stops the first
#   by attempting the INSERT directly and catching the unique violation, rather
#   than by reading pg_indexes and believing it.
#
#   A POOL SET MEASURED AT THE WRONG MOMENT is F14. The population is asked at
#   step 3 and asked AGAIN at step 10, and the set that enters the pool must be
#   the set as it stands at step 10 - not the set that was counted when the
#   conversion opened. Section 07 has one player join and another leave between
#   begin and commit, at the threshold, and asserts the pool is exactly the
#   re-measured eligible set, that the player who left is not in it, that the
#   player who joined is, and that nobody appears twice.
#
#   A STAND-DOWN THAT IS ONLY A RETURN VALUE is the failure section 09 exists
#   for. "It returns lightning_cluster_stands_down" is satisfied by a function
#   that returns that string after doing all its work. So every stood-down tick
#   and every stood-down balance in this file is wrapped in a full before/after
#   md5 of tables, table_seats and cash_seat_moves, and the same Cluster, in
#   must_move, with the same three conditions planted, is proved to change all
#   three.
#
#   A SURGICAL EDIT THAT WAS NOT SURGICAL. The substitution is one replace()
#   into 44,000 characters. Section 09 asserts the post-substitution tick still
#   contains every guard it had before it, that it GREW rather than shrank, and
#   that neither it nor the balancer mentions is_horse - Law 10.5, pinned twice
#   in server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts, where a
#   horse counts exactly like a human.
#
#   A BOUNDARY THAT WEDGES A CLUSTER FOREVER. Step 9 waits for no hand in
#   flight. An abandoned hand_history row from a crashed engine has ended_at
#   NULL for ever, so a boundary that only tested ended_at would refuse the
#   conversion until somebody went in with a DELETE. Section 10 proves both
#   halves: a fresh in-flight hand blocks and changes nothing, ending it lets
#   the commit through, and a seven-hour-old in-flight row does NOT block.
#
#   A FREEZE THAT CANNOT BE ESCAPED. Section 11 asserts begin and commit both
#   refuse with platform_frozen, and that abort STILL WORKS - recovering a
#   half-converted Cluster is exactly what an operator does during an incident,
#   and the break is when incidents happen.
#
#   A NOT NULL VIOLATION WHERE A REFUSAL BELONGED. lightning_pool_session.
#   cash_player_session_id is NOT NULL. A seated eligible player with no open
#   Cluster session would make the INSERT raise 23502 and abort the whole
#   transaction with a message about a column. Section 12 asserts it aborts
#   cleanly instead, with a COUNTED reason, and leaves the Cluster in must_move
#   with its halts cleared.
#
#   A PROOF THAT HAS GONE STALE is the failure nothing catches, because
#   `-- @live-proof:` lines are comments and no psql run evaluates them. Section
#   15 extracts every one of them from the file under test and evaluates it,
#   with no quarantine and no exception list.
#
# THE RULES, inherited from scripts/dev/test-lightning-phase4-remediation.sh:
#
#   1. Every comparison in an assertion is IS DISTINCT FROM, never = or <>. A
#      NULL where a value was expected makes `IF NOT (x = y)` evaluate to NULL,
#      which plpgsql takes as false, so an absent jsonb key PASSES a check
#      written that way.
#   2. Every negative assertion is preceded by its non-vacuity proof. "Nothing
#      moved" is satisfied by a fixture that could not move; every "nothing
#      moved" here is paired with the same Cluster, one column different,
#      moving.
#   3. Grants are asserted in both directions.
#   4. Nothing in this file is read from the migration's text where the
#      catalogue or the estate can be asked instead.
#
# THE RE-APPLY IS PRECEDED BY A TEARDOWN, AND THAT IS A FINDING RATHER THAN A
# CONVENIENCE. Section 8 of the migration asserts the estate is untouched: no
# Cluster outside must_move, no Cluster off epoch 0, no halted table, no pool
# session, no conversion record and no lightning_enabled Cluster. Those are true
# of the estate on the day of the apply and false of any estate that has since
# converted anything, so the file is re-appliable over a PRISTINE estate and is
# refused by its own assertions over a converted one. Section 16 therefore tears
# the estate back down to pristine first - exactly as
# scripts/dev/test-lightning-phase4-remediation.sh does before its own re-apply -
# and says so rather than hiding it.
#
# AS OF THIS WRITING THIS HARNESS IS RED AGAINST THE MIGRATION AS IT STANDS IN
# THE REPOSITORY, AND THAT IS THE POINT RATHER THAN A DEFECT IN THE HARNESS.
# Three findings, in the order a run meets them. Nothing below is worked around
# here: the assertions stand and the run stays red until the migration is fixed.
#
#   1. THE MIGRATION CANNOT BE APPLIED AT ALL. Section 8's capability-gate
#      assertion, and @live-proof #22, both scan pg_proc with
#      `regexp_replace(pg_get_functiondef(p.oid), ...)` and filter the namespace
#      through a JOIN. A qual on one relation is pushed to that relation's scan,
#      so pg_get_functiondef is called for every row of pg_proc INCLUDING
#      pg_catalog's aggregates, and the statement dies with
#      `ERROR: "array_agg" is an aggregate function`. It is deterministic and it
#      will happen on Supabase exactly as it happens here. The fix is one
#      predicate in each of the two places: AND p.prokind = 'f'.
#
#   2. tables_dealing_halt_is_explained DOES NOT FORBID THE THING ITS OWN
#      COMMENT SAYS IT FORBIDS. With dealing_halted_at NOT NULL and
#      dealing_halted_reason NULL the second disjunct evaluates to
#      TRUE AND NULL = NULL, the first to FALSE, and FALSE OR NULL is NULL - and
#      a CHECK that evaluates to NULL PASSES. So "a halted table with no reason
#      is a table nobody can explain" is unenforced, and since Phase 10's revert
#      matches on the reason, such a table would stay halted for ever, which is
#      the exact failure the closed vocabulary was written to prevent. Section
#      14 catches it. The fix is one conjunct:
#      AND dealing_halted_reason IS NOT NULL AND dealing_halted_reason IN (...).
#
#   3. THE MIGRATION IS NOT RE-APPLIABLE. All five ALTER TABLE ... ADD
#      CONSTRAINT statements are unguarded, so a second application dies at
#      `constraint "tables_dealing_halt_is_explained" for relation "tables"
#      already exists`. Every other statement in the file is IF NOT EXISTS or
#      CREATE OR REPLACE, so this is the only thing standing between the file
#      and idempotence. Section 16 catches it.
#
# LIGHTNING_PHASE5_MIGRATION overrides the file under test, so that mutation
# testing - copying the migration to a scratch directory, deleting one clause
# from the copy and watching this harness go red - never has to touch the
# migration in the repository. LIGHTNING_PHASE5_PORT overrides the port.
set -euo pipefail
export LC_ALL=C  # else initdb's postmaster refuses to start on macOS ("became multithreaded during startup") and string_agg ordering stops being deterministic
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_PHASE5_PORT:-55549}
base_fixture=$root/scripts/dev/fixtures/lightning-phase3-remediation-schema.sql
pop_fixture=$root/scripts/dev/fixtures/lightning-phase4-population-schema.sql
p5_fixture=$root/scripts/dev/fixtures/lightning-phase5-conversion-schema.sql
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
phase3r=$root/supabase/migrations/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
phase4=$root/supabase/migrations/20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql
phase4r=$root/supabase/migrations/20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql
migration=${LIGHTNING_PHASE5_MIGRATION:-$root/supabase/migrations/20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" "$migration"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase5-test.XXXXXX")
started=0
cleanup() {
  # || true: the trap runs under set -e, so a non-zero stop would abort the
  # function before rm -rf, leak the fixture directory AND make a fully passing
  # run exit 1.
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p $port -h ''" start >/dev/null
started=1

# ONE psql session, thirteen files. One session because the bodies measured
# before the migration are compared to the bodies after it, because the estate
# built in sections 02 to 14 is the estate section 16's teardown has to undo,
# and because the pre-re-apply capture has to be a TEMP table in the backend the
# second application lands in.
cat > "$fixture/pre.sql" <<'ASSERT'
-- THE HARNESS'S OWN WRITERS. Clusters are built through these rather than
-- through fn_cash_cluster_open_table because this contract needs shapes the one
-- cluster writer correctly refuses to make: an eligible seated player with no
-- cash session, a Cluster sitting in pending_on, a table halted for a reason
-- nobody has defined yet.
CREATE TEMP TABLE board (k text PRIMARY KEY, game_id uuid, note text);
CREATE TEMP TABLE pre (k text PRIMARY KEY, n bigint, t text);

CREATE FUNCTION public.fx_cluster(p_key text, p_handed integer DEFAULT 6,
                                  p_cap integer DEFAULT 40,
                                  p_lightning boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, enabled,
     cluster_mode, cluster_epoch, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'P5 ' || p_key, 'classic', 'nlh', 1.00, 2.00, p_handed, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, p_lightning, true,
     -- BORN must_move AND MOVED LATER, never inserted straight into a pending
     -- state: that is the order the specification's conversion sequence uses
     -- and the order trg_cash_games_epoch_follows_its_game was written for.
     'must_move', 0, clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM public.fx_table(v_id, p_key || ' main1', 'main', 1, p_cap);
  INSERT INTO board (k, game_id, note) VALUES (p_key, v_id, NULL);
  RETURN v_id;
END $fx$;

CREATE FUNCTION public.fx_table(p_game uuid, p_name text, p_role text,
                                p_main integer, p_cap integer DEFAULT 40)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid;
BEGIN
  INSERT INTO public.tables
    (club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
     status, created_by, cluster_id, role, main_index, lifecycle, is_deleted,
     opened_at, live_at, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'P5 ' || p_name, 'nlh', 1.00, 2.00, p_cap, 'waiting',
     '00000000-0000-0000-0000-0000000000aa', p_game, p_role, p_main, 'live', false,
     clock_timestamp(), clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_tb;
  RETURN v_tb;
END $fx$;

-- SEATS p_n PLAYERS, each with an OPEN cluster-scoped cash_player_session
-- unless asked otherwise, because the conversion's whole subordination rule is
-- that a pool session points at a session the player ALREADY had. Every stack
-- is different, so a chip assertion cannot pass by coincidence of arithmetic.
CREATE FUNCTION public.fx_seat(p_game uuid, p_n integer, p_session boolean DEFAULT true,
                               p_from integer DEFAULT 1)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid; i integer; v_u uuid;
BEGIN
  SELECT tb.id INTO v_tb FROM public.tables tb
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
   ORDER BY tb.created_at, tb.id LIMIT 1;
  IF v_tb IS NULL THEN RAISE EXCEPTION 'FIXTURE: cluster % has no board to seat on', p_game; END IF;
  FOR i IN p_from .. p_from + p_n - 1 LOOP
    v_u := gen_random_uuid();
    INSERT INTO public.table_seats
      (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at)
    VALUES (v_tb, v_u, i, 100.00 + i, false, false, clock_timestamp());
    IF p_session THEN
      INSERT INTO public.cash_player_session
        (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
      VALUES (v_u, 'cb000000-0000-0000-0000-000000000001', 'cluster', p_game, v_tb,
              'nlh', 1.00, 2.00, 100.00 + i, p_game, clock_timestamp());
    END IF;
  END LOOP;
  RETURN p_n;
END $fx$;

-- SEATS ONTO A NAMED BOARD, which fx_seat structurally cannot do. fx_seat
-- picks its board with `tb.lifecycle <> 'closed'`, and that predicate is the
-- one section 17 exists to interrogate: against a NULL lifecycle it evaluates
-- to NULL, not true, so the board is never chosen and nobody can be seated on
-- it. Same seats, same all-different stacks, same open cluster-scoped
-- cash_player_session unless asked otherwise; only the board is named.
CREATE FUNCTION public.fx_seat_at(p_game uuid, p_table uuid, p_n integer,
                                  p_session boolean DEFAULT true,
                                  p_from integer DEFAULT 1)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE i integer; v_u uuid;
BEGIN
  FOR i IN p_from .. p_from + p_n - 1 LOOP
    v_u := gen_random_uuid();
    INSERT INTO public.table_seats
      (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at)
    VALUES (p_table, v_u, i, 100.00 + i, false, false, clock_timestamp());
    IF p_session THEN
      INSERT INTO public.cash_player_session
        (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
      VALUES (v_u, 'cb000000-0000-0000-0000-000000000001', 'cluster', p_game, p_table,
              'nlh', 1.00, 2.00, 100.00 + i, p_game, clock_timestamp());
    END IF;
  END LOOP;
  RETURN p_n;
END $fx$;

-- OPENS A BOARD WITH NO LIFECYCLE AT ALL, and proves the column took the NULL.
-- public.tables.lifecycle is plain nullable text with a CHECK and no default,
-- and a CHECK that evaluates to NULL PASSES - so the estate can carry, and does
-- carry, rows whose lifecycle nobody ever set. The board is opened the ordinary
-- way and the column is then cleared, which is how such a row arrives: a column
-- added after the row, or a writer that does not name it.
CREATE FUNCTION public.fx_board_without_lifecycle(p_game uuid, p_name text, p_role text)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid;
BEGIN
  v_tb := public.fx_table(p_game, p_name, p_role, NULL, 40);
  UPDATE public.tables SET lifecycle = NULL WHERE id = v_tb;
  IF (SELECT lifecycle FROM public.tables WHERE id = v_tb) IS NOT NULL THEN
    RAISE EXCEPTION 'FIXTURE: table % would not take a NULL lifecycle, so section 17 cannot be built', v_tb;
  END IF;
  RETURN v_tb;
END $fx$;

-- THE THREE SNAPSHOTS. Row-level, every column, ordered - not a sum. A stack
-- that moved and came back passes a sum and fails this.
CREATE FUNCTION public.fx_seats_md5(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(md5(string_agg(ts::text, '|' ORDER BY ts.id)), 'empty')
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game;
$fx$;
CREATE FUNCTION public.fx_tables_md5(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(md5(string_agg(tb::text, '|' ORDER BY tb.id)), 'empty')
    FROM public.tables tb WHERE tb.cluster_id = p_game;
$fx$;
CREATE FUNCTION public.fx_moves_md5(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(md5(string_agg(m::text, '|' ORDER BY m.id)), 'empty')
    FROM public.cash_seat_moves m WHERE m.game_id = p_game;
$fx$;
CREATE FUNCTION public.fx_sessions_md5(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(md5(string_agg(s::text, '|' ORDER BY s.id)), 'empty')
    FROM public.cash_player_session s WHERE s.cluster_id = p_game;
$fx$;
CREATE FUNCTION public.fx_chips(p_game uuid) RETURNS numeric LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(sum(ts.stack), 0) FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game AND ts.left_at IS NULL;
$fx$;

-- THE CATCHER, proved to catch against a real division by zero before any
-- assertion is made through it.
CREATE FUNCTION public.fx_try_boom() RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE n integer; s text;
BEGIN
  n := 1 / (SELECT 0);
  RETURN 'answered ' || n;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN 'raised ' || s;
END $fx$;

CREATE FUNCTION public.fx_freeze(p_on boolean) RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  DELETE FROM public.engine_maintenance_break;
  IF p_on THEN
    INSERT INTO public.engine_maintenance_break (id, phase, enforce_freeze, announced_at, break_ends_at)
    VALUES (true, 'counting_down', true, clock_timestamp(), clock_timestamp() + interval '3 minutes');
  END IF;
END $fx$;

-- PLANTS THE THREE THINGS A must_move TICK DEMONSTRABLY ACTS ON: a second live
-- board so the balancer has somewhere to move to, an unbalanced population so
-- it plans one, and a fresh ruleset so the tick writes tables. Returns nothing;
-- the caller measures.
CREATE FUNCTION public.fx_tickable(p_key text) RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_g uuid; v_f uuid; i integer;
BEGIN
  v_g := public.fx_cluster(p_key, 6, 9);
  PERFORM public.fx_seat(v_g, 6);
  v_f := public.fx_table(v_g, p_key || ' f1', 'feeder', NULL, 9);
  FOR i IN 1..2 LOOP
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at)
    VALUES (v_f, gen_random_uuid(), i, 200.00, false, false, clock_timestamp());
  END LOOP;
  RETURN v_g;
END $fx$;
ASSERT

cat >> "$fixture/pre.sql" <<'ASSERT'

-- 01 THE BODIES THE SUBSTITUTION WILL BITE ARE THE REAL ONES -------------------
-- Everything in this section runs BEFORE a line of the migration has been
-- applied, against the body the fixture chain actually installed. If any of it
-- is wrong, every assertion this file later makes about a stand-down is an
-- assertion about a stub, and the two most dangerous sections of the migration
-- have been tested against a fake.
DO $$
DECLARE
  v_tick text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_bal  text := pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure);
  v_anchor constant text := '  IF NOT g.must_move THEN RETURN jsonb_build_object(''ok'', false, ''reason'', ''manual_game''); END IF;';
  v_bal_anchor constant text := 'BEGIN' || chr(10) || '  v_census := public.fn_cash_cluster_census(p_game_id, p_now);';
  v_g uuid; v_tb text; v_mv text; v_res jsonb; v_n integer;
BEGIN
  IF public.fx_try_boom() IS DISTINCT FROM 'raised 22012' THEN
    RAISE EXCEPTION 'FAIL 01: the catcher does not catch a real division by zero, it reports %', public.fx_try_boom();
  END IF;

  -- IT IS THE REAL TICK, BY SIZE. The stub in the Phase 3 fixture is 8KB and
  -- names the eight steps it does not implement; production measured 40,443.
  IF (length(v_tick) > 40000) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: the installed tick is only % characters, so it is not the real body and nothing this file proves about a substitution into it is worth anything', length(v_tick);
  END IF;

  -- THE ANCHOR IS THERE EXACTLY ONCE, which is what the migration itself
  -- asserts before it substitutes. Measured here too, because a migration that
  -- refuses to apply and a migration that applies wrongly fail differently and
  -- this file has to be able to tell them apart.
  SELECT count(*) INTO v_n FROM regexp_matches(v_tick, regexp_replace(v_anchor, '([().*+?\[\]{}|^$\\])', '\\\1', 'g'), 'g');
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 01: the must_move anchor occurs % times in the installed tick, not once', v_n;
  END IF;
  IF position(v_bal_anchor in v_bal) = 0 THEN
    RAISE EXCEPTION 'FAIL 01: the census anchor is not in the installed balancer, so section 7 of the migration cannot bite';
  END IF;

  -- EVERY SIBLING GUARD THE MIGRATION ASSERTS SURVIVED WAS THERE TO SURVIVE.
  -- A read-back that asserts fn_platform_frozen is still present proves nothing
  -- against a body that never had it.
  IF v_tick !~ 'IF NOT g\.must_move THEN RETURN' OR v_tick !~ 'manual_game'
     OR v_tick !~ 'fn_platform_frozen' OR v_tick !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'FAIL 01: the installed tick is missing one of the four guards the migration asserts survive its edit';
  END IF;
  -- LAW 10.5 IS TRUE BEFORE THE EDIT. server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts
  -- pins it twice; a migration that asserts is_horse is absent afterwards has
  -- said nothing unless it was absent before.
  IF v_tick ~ 'is_horse' OR v_bal ~ 'is_horse' THEN
    RAISE EXCEPTION 'FAIL 01: the installed tick or balancer already mentions is_horse, so the migration''s Law 10.5 assertion is vacuous';
  END IF;

  -- NEITHER STANDS DOWN YET. This is the before half of section 09.
  IF v_tick ~ 'lightning_cluster_stands_down' THEN
    RAISE EXCEPTION 'FAIL 01: the tick already stands down before the migration was applied';
  END IF;
  IF v_bal ~ 'cluster_mode' THEN
    RAISE EXCEPTION 'FAIL 01: the balancer already reads cluster_mode before the migration was applied';
  END IF;
  -- AND NEITHER THE HALT COLUMNS NOR THE CONVERSION TABLE EXIST YET.
  IF to_regclass('public.cash_cluster_conversion') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: cash_cluster_conversion exists before the migration, so this is not a before';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tables' AND column_name='dealing_halted_at') THEN
    RAISE EXCEPTION 'FAIL 01: tables.dealing_halted_at exists before the migration, so this is not a before';
  END IF;

  INSERT INTO pre (k, n, t) VALUES
    ('tick_len', length(v_tick), NULL), ('bal_len', length(v_bal), NULL);

  -- THE REAL TICK REALLY WORKS, AND IT REALLY WRITES. Without this, section
  -- 09's "the stood-down tick moved nothing" is a statement about a tick that
  -- could not have moved anything.
  v_g := public.fx_tickable('pre_tick');
  v_tb := public.fx_tables_md5(v_g); v_mv := public.fx_moves_md5(v_g);
  v_res := public.fn_cash_cluster_tick(v_g);
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: the real tick does not even answer ok on a must_move Cluster, it says %', v_res;
  END IF;
  IF public.fx_tables_md5(v_g) IS NOT DISTINCT FROM v_tb THEN
    RAISE EXCEPTION 'FAIL 01: a must_move tick wrote no tables row, so section 09 could not tell a stand-down from a no-op';
  END IF;
  IF public.fx_moves_md5(v_g) IS NOT DISTINCT FROM v_mv THEN
    RAISE EXCEPTION 'FAIL 01: a must_move tick planned no seat move, so section 09 could not tell a stand-down from a no-op';
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_seat_moves WHERE game_id = v_g AND state = 'pending';
  IF (v_n > 0) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: the must_move tick left % pending seat moves', v_n;
  END IF;
  INSERT INTO pre (k, n, t) VALUES ('pre_tick_moves', v_n, v_res::text);
END $$;

-- THE CAPABILITY GATE IS SHUT BEFORE THE MIGRATION LANDS. Section 8 of the
-- migration refuses to commit if any Cluster is lightning_enabled, because the
-- whole safety argument for shipping a conversion before its matcher exists
-- rests on two independent gates and that is one of them. The Cluster section
-- 01 built to prove the real tick really works is a Cluster like any other, so
-- its capability is turned off here rather than the migration's gate being
-- weakened to let a harness through.
UPDATE public.cash_games SET lightning_enabled = false;
\echo '  ok  01 THE BODIES ARE REAL   before one line of the migration is applied: the installed fn_cash_cluster_tick is over 40,000 characters of the real body - 20260906015029 lines 61-645 plus five real substitution blocks in version order, then 25523 and 44045 - it carries the manual_game anchor exactly ONCE and carries IF NOT g.must_move THEN RETURN, manual_game, fn_platform_frozen and FOR UPDATE, fn_cash_cluster_balance carries the census anchor, NEITHER mentions is_horse so Law 10.5 is true before the edit as well as after it, neither stands down yet, cash_cluster_conversion and tables.dealing_halted_at do not exist yet - and the real tick, run on a real must_move Cluster, answers ok, rewrites the tables rows and plans real pending seat moves, so that every "nothing moved" later in this file is a statement about a stand-down rather than about a tick that could not move anything'
ASSERT

cat > "$fixture/assertions.sql" <<'ASSERT'
-- 02 STEPS 1 TO 6: MUST_MOVE -> PENDING_ON, AND IT CONVERTS NOTHING -----------
-- The half that DECIDES. What has to be true here is as much about what did NOT
-- happen as about what did: no epoch moved, no pool session was created, no
-- seat was touched. That ordering is the whole reason an abort is cheap, and it
-- is the specification's, not this file's.
DO $$
DECLARE
  v_g uuid; v_f uuid; v_r jsonb; v_c record; v_ev jsonb; v_seats text; v_sess text;
  v_n integer;
BEGIN
  v_g := public.fx_cluster('happy', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_f := public.fx_table(v_g, 'happy f1', 'feeder', NULL, 9);
  -- TWO PENDING SEAT MOVES, planted so that "every pending move was cancelled"
  -- is a statement about two real rows. The engine's start-up wait loop never
  -- re-reads its table row, so it can neither see the halt nor see it lifted,
  -- and it still runs executeIdleSeatMoves(): a move planned a second before
  -- PENDING_ON would execute mid-conversion and write table_seats.
  INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, state)
  SELECT v_g, ts.user_id, ts.table_id, v_f, 'must_move', 'pending'
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g ORDER BY ts.seat_number LIMIT 2;
  v_seats := public.fx_seats_md5(v_g); v_sess := public.fx_sessions_md5(v_g);

  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 02: the board is not at 18 live eligible, it is at %', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000001');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true OR v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 02: begin_pending_on refused a Cluster of 18 at an ON threshold of 18: %', v_r;
  END IF;
  IF (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 2
     OR (v_r ->> 'seat_moves_cancelled')::integer IS DISTINCT FROM 2
     OR (v_r ->> 'trigger_population')::integer IS DISTINCT FROM 18
     OR v_r ->> 'cluster_mode' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 02: begin_pending_on''s own answer is wrong: %', v_r;
  END IF;

  -- THE STATE MOVED AND THE EPOCH DID NOT. Step 13 creates the Epoch, after the
  -- re-check, and an aborted conversion must leave nothing bound to an epoch.
  SELECT * INTO v_c FROM public.cash_games WHERE id = v_g;
  IF v_c.cluster_mode IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 02: the Cluster is in % rather than pending_on', v_c.cluster_mode;
  END IF;
  IF v_c.cluster_epoch IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: the epoch moved to % during PENDING_ON, which is step 13 and has not happened yet', v_c.cluster_epoch;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: PENDING_ON created % pool session(s), and an aborted conversion would then have something to unwind', v_n;
  END IF;

  -- EVERY LIVE TABLE IS HALTED, WITH THE REASON THE REVERT PATH MATCHES ON.
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning_pending_on';
  IF v_n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 02: % of the Cluster''s 2 live tables are halted for lightning_pending_on', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NULL;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: % live table(s) of the Cluster are still dealing while a conversion is being decided', v_n;
  END IF;

  -- EVERY PENDING MOVE WAS CANCELLED, AND SAYS SO IN ITS OWN NOTE.
  SELECT count(*)::integer INTO v_n FROM public.cash_seat_moves
   WHERE game_id = v_g AND state = 'cancelled' AND resolved_at IS NOT NULL
     AND note LIKE '%cancelled by lightning pending_on%';
  IF v_n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 02: % of the 2 planted pending moves were cancelled with a reason', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_seat_moves WHERE game_id = v_g AND state = 'pending';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: % move(s) are still pending and executeIdleSeatMoves() would run them mid-conversion', v_n;
  END IF;

  -- THE RECORD CARRIES ALL NINE THINGS THE SPECIFICATION REQUIRES.
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.from_mode IS DISTINCT FROM 'must_move' OR v_c.to_mode IS DISTINCT FROM 'lightning'
     OR v_c.trigger_population IS DISTINCT FROM 18 OR v_c.on_threshold IS DISTINCT FROM 18
     OR v_c.off_threshold IS DISTINCT FROM 12 OR v_c.epoch_before IS DISTINCT FROM 0
     OR v_c.epoch_after IS NOT NULL OR v_c.status IS DISTINCT FROM 'pending'
     OR v_c.conversion_request_id IS DISTINCT FROM 'a0000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL 02: the conversion record does not carry the nine things the specification requires: %', to_jsonb(v_c);
  END IF;

  SELECT payload INTO v_ev FROM public.cash_cluster_events
   WHERE game_id = v_g AND kind = 'lightning_pending_on';
  IF v_ev IS NULL THEN RAISE EXCEPTION 'FAIL 02: no lightning_pending_on event was emitted'; END IF;
  IF (v_ev ->> 'tables_halted')::integer IS DISTINCT FROM 2
     OR (v_ev ->> 'seat_moves_cancelled')::integer IS DISTINCT FROM 2
     OR (v_ev ->> 'epoch_before')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: the lightning_pending_on payload does not describe what happened: %', v_ev;
  END IF;

  -- AND NOT ONE SEAT OR SESSION ROW WAS TOUCHED.
  IF public.fx_seats_md5(v_g) IS DISTINCT FROM v_seats THEN
    RAISE EXCEPTION 'FAIL 02: a table_seats row of the Cluster changed during PENDING_ON';
  END IF;
  IF public.fx_sessions_md5(v_g) IS DISTINCT FROM v_sess THEN
    RAISE EXCEPTION 'FAIL 02: a cash_player_session row of the Cluster changed during PENDING_ON';
  END IF;
END $$;
\echo '  ok  02 PENDING ON DECIDES    a six-max Cluster of 18 eligible seated players, each holding an open cluster-scoped cash_player_session, with two pending cash_seat_moves planted on it: begin_pending_on answers pending_on, the Cluster moves to pending_on, BOTH live tables are halted with reason lightning_pending_on and none is left dealing, BOTH pending moves are cancelled with resolved_at set and their own note saying why, the cash_cluster_conversion row carries all nine of the specification''s fields with status pending and epoch_after NULL, a lightning_pending_on event is emitted carrying the two counts and the epoch before - and the epoch did NOT move, NO pool session was created, and the row-level md5 of every table_seats and every cash_player_session row of the Cluster is byte-identical to what it was, because the half that decides converts nothing'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 03 STEPS 9 TO 22: PENDING_ON -> LIGHTNING ------------------------------------
-- The same Cluster, one call later. The pool session is the only thing this
-- creates for a player, and what it points at is what the player already had:
-- "A Lightning Pool Session is subordinate to the continuous Cash Player
-- Session. Entering/exiting Lightning does not create a new cash session."
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_c record; v_ev jsonb; v_n integer; v_seats text; v_sess text;
  v_chips numeric; v_ep record;
BEGIN
  SELECT game_id INTO v_g FROM board WHERE k = 'happy';
  v_seats := public.fx_seats_md5(v_g); v_sess := public.fx_sessions_md5(v_g);
  v_chips := public.fx_chips(v_g);

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000001');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true OR v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 03: commit_lightning did not convert: %', v_r;
  END IF;
  IF (v_r ->> 'epoch_before')::integer IS DISTINCT FROM 0
     OR (v_r ->> 'epoch_after')::integer IS DISTINCT FROM 1
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 18
     OR (v_r ->> 'chip_total')::numeric IS DISTINCT FROM v_chips THEN
    RAISE EXCEPTION 'FAIL 03: commit_lightning''s own answer is wrong: %', v_r;
  END IF;

  SELECT * INTO v_c FROM public.cash_games WHERE id = v_g;
  IF v_c.cluster_mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 03: the Cluster is in % rather than lightning', v_c.cluster_mode;
  END IF;
  IF v_c.cluster_epoch IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 03: the epoch is % rather than one past where it started', v_c.cluster_epoch;
  END IF;

  -- STEP 13. An epoch nobody can explain is an epoch nobody can audit, which is
  -- why the commit sets ca.epoch_reason before it bumps.
  SELECT * INTO v_ep FROM public.cash_cluster_epoch WHERE cluster_id = v_g AND epoch = 1;
  IF v_ep IS NULL THEN RAISE EXCEPTION 'FAIL 03: no cash_cluster_epoch row was opened for epoch 1'; END IF;
  IF v_ep.started_by IS DISTINCT FROM 'lightning_on' THEN
    RAISE EXCEPTION 'FAIL 03: epoch 1 records started_by = % rather than lightning_on', v_ep.started_by;
  END IF;
  IF v_ep.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: the new epoch row is already closed';
  END IF;
  IF v_ep.mode IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 03: epoch 1 records mode % rather than lightning', v_ep.mode;
  END IF;

  -- ONE POOL SESSION PER ELIGIBLE PLAYER, AT THE NEW EPOCH, POINTING AT THE
  -- SESSION THE PLAYER ALREADY HAD - not at one created here.
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 03: % pool sessions exist for 18 eligible players', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session
   WHERE cluster_id = v_g AND (cluster_epoch IS DISTINCT FROM 1 OR state IS DISTINCT FROM 'active' OR exited_at IS NOT NULL);
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: % pool session(s) are not open and active at the NEW epoch', v_n;
  END IF;
  -- THE SUBORDINATION, ASSERTED ROW BY ROW: every pool session names the open
  -- cluster session that player held BEFORE the conversion, and its starting
  -- stack is the stack on the seat.
  SELECT count(*)::integer INTO v_n
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g
     AND NOT EXISTS (SELECT 1 FROM public.cash_player_session s
                      WHERE s.id = ps.cash_player_session_id AND s.player_id = ps.player_id
                        AND s.cluster_id = v_g AND s.closed_at IS NULL
                        AND s.opened_at < ps.entered_at);
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: % pool session(s) do not point at the open cluster session the player already had', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n
    FROM public.lightning_pool_session ps
    JOIN public.table_seats ts ON ts.user_id = ps.player_id
    JOIN public.tables tb ON tb.id = ts.table_id AND tb.cluster_id = v_g
   WHERE ps.cluster_id = v_g AND ps.starting_stack IS DISTINCT FROM ts.stack;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: % pool session(s) carry a starting stack that is not the stack on the seat', v_n;
  END IF;
  -- AND NO CASH SESSION WAS CREATED OR CLOSED BY ANY OF IT.
  SELECT count(*)::integer INTO v_n FROM public.cash_player_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 03: the Cluster now has % cash sessions for 18 players, so the conversion created or closed one', v_n;
  END IF;

  -- THE HALT IS RE-STAMPED, NOT LIFTED. The tables are still not dealing, and
  -- now they are not dealing because the Cluster IS Lightning rather than
  -- because it is deciding - which is the difference Phase 10 matches on.
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning';
  IF v_n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 03: % of the Cluster''s 2 tables carry the lightning halt', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND dealing_halted_reason = 'lightning_pending_on';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: % table(s) still say they are halted because a conversion is being DECIDED', v_n;
  END IF;

  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'committed' OR v_c.epoch_after IS DISTINCT FROM 1
     OR v_c.closed_at IS NULL OR v_c.abort_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: the conversion record does not say it committed at epoch 1: %', to_jsonb(v_c);
  END IF;

  -- AND THE SEAT IS STILL THE ANCHOR. Captured before the commit above; the
  -- design is that the table_seats row survives untouched, keeping the stack,
  -- the custody binding and its cash_player_session.
  IF public.fx_seats_md5(v_g) IS DISTINCT FROM v_seats THEN
    RAISE EXCEPTION 'FAIL 03: a table_seats row of the Cluster changed during the commit';
  END IF;
  IF public.fx_sessions_md5(v_g) IS DISTINCT FROM v_sess THEN
    RAISE EXCEPTION 'FAIL 03: a cash_player_session row of the Cluster changed during the commit';
  END IF;

  SELECT payload INTO v_ev FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_on';
  IF v_ev IS NULL THEN RAISE EXCEPTION 'FAIL 03: no lightning_on event was emitted'; END IF;
  IF (v_ev ->> 'epoch_before')::integer IS DISTINCT FROM 0
     OR (v_ev ->> 'epoch_after')::integer IS DISTINCT FROM 1
     OR (v_ev ->> 'pool_sessions')::integer IS DISTINCT FROM 18
     OR v_ev ->> 'from_mode' IS DISTINCT FROM 'must_move' OR v_ev ->> 'to_mode' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 03: the lightning_on payload does not describe the conversion: %', v_ev;
  END IF;
END $$;
\echo '  ok  03 THE CONVERSION        commit_lightning on the same Cluster answers lightning: cluster_mode is lightning, the epoch is exactly one past where it started, cash_cluster_epoch carries a new OPEN row for epoch 1 with mode lightning and started_by lightning_on rather than unstated, there is exactly one lightning_pool_session per eligible player - all 18 open, active, at the NEW epoch - and every one of them points at the open cluster-scoped cash_player_session that player ALREADY held, with a starting stack equal to the stack on their seat, while the Cluster still has exactly 18 cash sessions because entering Lightning creates none, both halts are re-stamped from lightning_pending_on to lightning with none left saying the conversion is still being decided, the conversion record says committed with epoch_after 1 and no abort reason, and a lightning_on event carries from_mode, to_mode, both epochs and the pool count'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 04 F12, THE CONVERSION CHIP INVARIANT ---------------------------------------
-- "NO MONEY MOVES AS A RESULT OF THIS TRANSITION." The migration's defence is
-- that it never writes table_seats at all, which is true, asserted from the
-- catalogue by the migration itself, and exactly the kind of claim that
-- survives the day somebody adds a write. So this section does not compare a
-- sum. It compares an md5 of EVERY COLUMN of every table_seats row of the
-- Cluster, ordered by id, across the whole conversion - a stack that moved and
-- came back passes a sum and fails this - and the same for cash_player_session,
-- plus the four things the specification names one by one.
DO $$
DECLARE
  v_g uuid; v_seats text; v_sess text; v_chips numeric; v_stacks text; v_n integer; v_r jsonb;
BEGIN
  v_g := public.fx_cluster('chips', 6, 40);
  PERFORM public.fx_seat(v_g, 19);
  v_seats  := public.fx_seats_md5(v_g);
  v_sess   := public.fx_sessions_md5(v_g);
  v_chips  := public.fx_chips(v_g);
  SELECT md5(string_agg(ts.user_id::text || '=' || ts.stack::text, ',' ORDER BY ts.user_id)) INTO v_stacks
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;

  -- NON-VACUITY FOR THE MD5 ITSELF: it moves when a stack moves. Without this,
  -- "the md5 is unchanged" is satisfied by an md5 that is constant.
  UPDATE public.table_seats ts SET stack = ts.stack + 1
    FROM public.tables tb WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.seat_number = 1;
  IF public.fx_seats_md5(v_g) IS NOT DISTINCT FROM v_seats THEN
    RAISE EXCEPTION 'FAIL 04: the seat md5 does not change when a stack changes, so it can prove nothing';
  END IF;
  UPDATE public.table_seats ts SET stack = ts.stack - 1
    FROM public.tables tb WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.seat_number = 1;
  IF public.fx_seats_md5(v_g) IS DISTINCT FROM v_seats THEN
    RAISE EXCEPTION 'FAIL 04: the seat md5 did not come back, so the harness cannot measure what it claims to';
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000002');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 04: begin refused: %', v_r; END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000002');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FAIL 04: commit refused: %', v_r; END IF;

  IF public.fx_chips(v_g) IS DISTINCT FROM v_chips THEN
    RAISE EXCEPTION 'FAIL 04: the Cluster chip total went from % to % across a mode change, and a mode change is a seating transition rather than an economic transaction',
      v_chips, public.fx_chips(v_g);
  END IF;
  SELECT md5(string_agg(ts.user_id::text || '=' || ts.stack::text, ',' ORDER BY ts.user_id)) INTO v_stacks
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;
  IF public.fx_seats_md5(v_g) IS DISTINCT FROM v_seats THEN
    RAISE EXCEPTION 'FAIL 04: a table_seats row of the Cluster changed in SOME column across the conversion, and the seat is the one thing a conversion never touches';
  END IF;
  IF public.fx_sessions_md5(v_g) IS DISTINCT FROM v_sess THEN
    RAISE EXCEPTION 'FAIL 04: a cash_player_session row of the Cluster changed across the conversion';
  END IF;
  -- THE FOUR THE SPECIFICATION NAMES, ASSERTED SEPARATELY, because an md5 that
  -- went green for the wrong reason would say nothing about which value held.
  SELECT count(*)::integer INTO v_n FROM public.cash_player_session s
   WHERE s.cluster_id = v_g AND (s.closed_at IS NOT NULL OR s.baseline IS NULL
      OR s.stay_clock_ms IS DISTINCT FROM 600000 OR s.rejoin_window_ms IS DISTINCT FROM 7200000);
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: % cash session(s) were closed or had their baseline, stay clock or rejoin window rewritten', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND (ts.left_at IS NOT NULL OR ts.user_id IS NULL);
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 04: % seat(s) were vacated by the conversion', v_n;
  END IF;
END $$;

-- AND THE COMMIT'S OWN CHIP ASSERTION IS LIVE, WHICH NOTHING ELSE CAN SHOW.
-- Step 12 reads the chip total before its writes and again after them and
-- raises if they differ. As the function is written that can never fire - it
-- never touches table_seats - and the migration says as much: it is there so
-- that it starts failing the day somebody adds a write. Deleting it therefore
-- changes no behaviour any conversion can produce, and an assertion on the
-- FUNCTION TEXT would be the only thing left. So the write is added: a BEFORE
-- INSERT trigger on lightning_pool_session moves one chip, inside the commit's
-- own transaction, between its two reads. The guard must fire.
CREATE FUNCTION public.fx_move_a_chip() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  UPDATE public.table_seats ts SET stack = ts.stack + 1
    FROM public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = NEW.cluster_id AND ts.user_id = NEW.player_id;
  RETURN NEW;
END $fx$;
CREATE FUNCTION public.fx_leave_one_behind() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  IF NEW.starting_stack = (SELECT min(ts.stack) FROM public.table_seats ts
                             JOIN public.tables tb ON tb.id = ts.table_id
                            WHERE tb.cluster_id = NEW.cluster_id AND ts.left_at IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $fx$;

DO $$
DECLARE v_g uuid; v_r jsonb; v_msg text; v_sql text;
BEGIN
  v_g := public.fx_cluster('guards', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000001a');
  CREATE TRIGGER fx_chip_mover BEFORE INSERT ON public.lightning_pool_session
    FOR EACH ROW EXECUTE FUNCTION public.fx_move_a_chip();
  BEGIN
    v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000001a');
    RAISE EXCEPTION 'FAIL 04: a chip moved during the conversion and the commit''s own step 12 assertion did not fire - it answered %', v_r;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'LIGHTNING_CONVERSION_MOVED_MONEY%' THEN
      RAISE EXCEPTION 'FAIL 04: a chip moved and the check violation was % rather than the money assertion', v_msg;
    END IF;
  END;
  DROP TRIGGER fx_chip_mover ON public.lightning_pool_session;
END $$;

DO $$
DECLARE v_g uuid; v_r jsonb; v_msg text;
BEGIN
  -- AND THE OTHER HALF OF F15: nobody eligible may be left behind. A count
  -- cannot see it, so one insert is suppressed and the guard must fire.
  v_g := public.fx_cluster('behind', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000001b');
  CREATE TRIGGER fx_leaver BEFORE INSERT ON public.lightning_pool_session
    FOR EACH ROW EXECUTE FUNCTION public.fx_leave_one_behind();
  BEGIN
    v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000001b');
    RAISE EXCEPTION 'FAIL 04: one eligible player did not enter the pool and the commit converted anyway - it answered %', v_r;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND%' THEN
      RAISE EXCEPTION 'FAIL 04: a player was left behind and the check violation was % rather than the left-behind assertion', v_msg;
    END IF;
  END;
  DROP TRIGGER fx_leaver ON public.lightning_pool_session;
  -- NON-VACUITY: with both triggers gone the identical conversion converts.
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000001b');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 04: with the triggers removed the identical conversion still failed: %', v_r;
  END IF;
END $$;
\echo '  ok  04 F12 NO MONEY MOVES    a nineteen-player Cluster converted end to end: sum(stack) is byte-identical, the per-player stack map is byte-identical, and the row-level md5 of EVERY COLUMN of every table_seats row of the Cluster is byte-identical - measured through an md5 first proved to move when one stack moves by one and to come back when it comes back, so "unchanged" is a measurement rather than a constant - no seat was vacated and no user_id cleared, and every cash_player_session row is byte-identical too: same id, still open, same baseline, same stay clock and same rejoin window, because entering Lightning does not create, close or rewrite a cash session - and the commit''s OWN two assertions, which cannot fire as the function is written, are proved LIVE by making them fire: a BEFORE INSERT trigger on lightning_pool_session that moves one chip between step 12''s two reads raises LIGHTNING_CONVERSION_MOVED_MONEY, and one that suppresses a single pool session raises LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND, with the identical conversion succeeding once both are dropped'

-- 05 F04, THE ABORT, BOTH WAYS -------------------------------------------------
-- "TEST F04 - 18TH PLAYER LEAVES DURING PENDING_ON. Expected: conversion
-- canceled, state returns to MUST_MOVE, regular tables resume, no Lightning
-- player stranded." No Lightning player CAN be stranded here, because
-- PENDING_ON created none - and that is the step ordering rather than luck. So
-- what this has to prove is the other three, twice: once through the commit's
-- own re-check, which must abort by itself, and once through a direct call.
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_c record; v_n integer; v_tb text; v_mv text;
BEGIN
  v_g := public.fx_cluster('abort_self', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000003');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 05: begin refused: %', v_r; END IF;

  -- THE EIGHTEENTH PLAYER LEAVES.
  UPDATE public.table_seats ts SET left_at = clock_timestamp()
    FROM public.tables tb WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.seat_number = 1;
  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 17 THEN
    RAISE EXCEPTION 'FAIL 05: the population did not fall to 17, it is %', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000003');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 05: commit_lightning did not abort itself when the population fell below the ON threshold at the boundary: %', v_r;
  END IF;
  SELECT * INTO v_c FROM public.cash_games WHERE id = v_g;
  IF v_c.cluster_mode IS DISTINCT FROM 'must_move' OR v_c.cluster_epoch IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: after a self-abort the Cluster is % at epoch %', v_c.cluster_mode, v_c.cluster_epoch;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: % table(s) are still halted after the abort, so the Cluster cannot deal again', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_reason IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: % table(s) carry a halt reason with no halt, which the CHECK is supposed to forbid', v_n;
  END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR v_c.abort_reason IS NULL OR v_c.closed_at IS NULL
     OR v_c.epoch_after IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: the self-aborted conversion record is wrong: %', to_jsonb(v_c);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: % pool session(s) exist after an abort, so a Lightning player was stranded', v_n;
  END IF;
  -- NOWHERE, not just on this Cluster: an abort that stranded somebody on a
  -- neighbouring epoch would pass the count above.
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session ps
    JOIN public.table_seats ts ON ts.user_id = ps.player_id
    JOIN public.tables tb ON tb.id = ts.table_id AND tb.cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: % player(s) of this Cluster hold a pool session somewhere after the abort', v_n;
  END IF;
  -- AND THE TABLES REALLY DEAL AGAIN, in the only sense the database has: the
  -- tick, which stood down a moment ago, plans moves again.
  SELECT count(*)::integer INTO v_n FROM public.cash_seat_moves WHERE game_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 05: the abort Cluster was not clean of moves to begin with'; END IF;
  PERFORM public.fx_table(v_g, 'abort_self f1', 'feeder', NULL, 9);
  v_tb := public.fx_tables_md5(v_g); v_mv := public.fx_moves_md5(v_g);
  v_r := public.fn_cash_cluster_tick(v_g);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the tick does not run again after the abort, it says %', v_r;
  END IF;
  IF v_r ->> 'reason' IS NOT DISTINCT FROM 'lightning_cluster_stands_down' THEN
    RAISE EXCEPTION 'FAIL 05: the tick is still standing down after the abort, so the Cluster is not really back in must-move seating';
  END IF;
  IF public.fx_tables_md5(v_g) IS NOT DISTINCT FROM v_tb THEN
    RAISE EXCEPTION 'FAIL 05: the tick ran after the abort and wrote nothing, so it is not really doing its work again';
  END IF;
END $$;

DO $$
DECLARE v_g uuid; v_r jsonb; v_c record; v_n integer;
BEGIN
  -- THE SAME THING THROUGH A DIRECT CALL, which is the path an operator takes.
  v_g := public.fx_cluster('abort_direct', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  PERFORM public.fx_table(v_g, 'abort_direct f1', 'feeder', NULL, 9);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000004');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 05: begin refused: %', v_r; END IF;
  -- A TABLE HALTED FOR SOMETHING ELSE, so that "only our halt is lifted" is a
  -- statement about a row that really is halted for another reason.
  UPDATE public.tables SET dealing_halted_reason = 'lightning'
   WHERE id = (SELECT id FROM public.tables WHERE cluster_id = v_g ORDER BY created_at DESC LIMIT 1);

  v_r := public.fn_cash_cluster_abort_pending_on(v_g, 'a0000000-0000-0000-0000-000000000004', 'operator pulled it');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true OR v_r ->> 'reason' IS DISTINCT FROM 'aborted'
     OR (v_r ->> 'tables_resumed')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 05: the direct abort answered %', v_r;
  END IF;
  SELECT * INTO v_c FROM public.cash_games WHERE id = v_g;
  IF v_c.cluster_mode IS DISTINCT FROM 'must_move' OR v_c.cluster_epoch IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 05: after a direct abort the Cluster is % at epoch %', v_c.cluster_mode, v_c.cluster_epoch;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_reason = 'lightning_pending_on';
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 05: % table(s) still carry the pending_on halt after a direct abort', v_n; END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_reason = 'lightning';
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 05: the abort cleared a halt it did not place; % table(s) still carry the other reason rather than 1', v_n;
  END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR v_c.abort_reason IS DISTINCT FROM 'operator pulled it' THEN
    RAISE EXCEPTION 'FAIL 05: the directly aborted conversion record is wrong: %', to_jsonb(v_c);
  END IF;
  -- A BLANK REASON BECOMES unstated RATHER THAN NULL, because the CHECK forbids
  -- an aborted row with no reason and a NOT NULL violation is the shape that
  -- turns a five-minute diagnosis into an afternoon.
  v_g := public.fx_cluster('abort_blank', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000005');
  PERFORM public.fn_cash_cluster_abort_pending_on(v_g, 'a0000000-0000-0000-0000-000000000005', '   ');
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.abort_reason IS DISTINCT FROM 'unstated' THEN
    RAISE EXCEPTION 'FAIL 05: a blank abort reason was recorded as % rather than unstated', coalesce(v_c.abort_reason, '<null>');
  END IF;
END $$;
\echo '  ok  05 F04 THE ABORT         the eighteenth player leaves during PENDING_ON and commit_lightning ABORTS BY ITSELF at the boundary rather than converting seventeen: the Cluster is back in must_move at the epoch it started on, every halt is cleared with no reason left behind, the conversion record says aborted with a reason and epoch_after NULL, no pool session exists on the Cluster or anywhere for any of its players, and the tick - which was standing down a moment earlier - answers ok rather than lightning_cluster_stands_down and rewrites the tables rows of the Cluster again, which is what "regular tables resume" means in the database. The same through a direct abort_pending_on call, with tables_resumed 1, its stated reason recorded verbatim, and a table halted for the OTHER reason left exactly as it was, because a Lightning conversion may not silently restart a table somebody else stopped; and a blank reason recorded as unstated rather than as NULL'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 06 F13, THE DOUBLE CONVERSION RACE, WHICH IS TWO TESTS ----------------------
-- "One conversion commits, all others no-op/retry safely." Two DIFFERENT
-- converters and the SAME converter twice are different failures and the
-- migration answers them with different machinery: the row lock and the
-- wrong_state answer for the first, the unique conversion_request_id for the
-- second. The partial unique index is the backstop for the first, and it is
-- proved to be a real index by being made to fire rather than by being read out
-- of pg_indexes.
DO $$
DECLARE
  v_g uuid; v_r1 jsonb; v_r2 jsonb; v_n integer; v_state text; v_pool integer;
BEGIN
  v_g := public.fx_cluster('race', 6, 40);
  PERFORM public.fx_seat(v_g, 18);

  v_r1 := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000006');
  v_r2 := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000007');
  IF v_r1 ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 06: the first converter was refused: %', v_r1; END IF;
  IF (v_r2 ->> 'ok')::boolean IS DISTINCT FROM false OR v_r2 ->> 'reason' IS DISTINCT FROM 'wrong_state' THEN
    RAISE EXCEPTION 'FAIL 06: a second converter with a DIFFERENT request id was not refused: %', v_r2;
  END IF;
  -- THE REFUSAL NAMES THE STATE. A worker told "no" retries; a worker told
  -- "pending_on" knows a conversion is already in progress.
  IF v_r2 ->> 'cluster_mode' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 06: the refusal does not say what state the Cluster is in: %', v_r2;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 06: % conversions were opened on one Cluster', v_n;
  END IF;

  -- AND THE INDEX IS WHAT STOPS IT IN THE TABLE, not only the lock in the
  -- transaction: a lock protects a transaction and an index protects the table,
  -- and the table outlives every transaction. Proved by attempting the INSERT.
  BEGIN
    INSERT INTO public.cash_cluster_conversion
      (cluster_id, conversion_request_id, from_mode, to_mode, trigger_population,
       on_threshold, off_threshold, epoch_before)
    VALUES (v_g, gen_random_uuid(), 'must_move', 'lightning', 18, 18, 12, 0);
    RAISE EXCEPTION 'FAIL 06: cash_cluster_conversion_one_open_per_cluster did not stop a second open conversion on the same Cluster';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- NON-VACUITY: the same INSERT on a Cluster with no open conversion succeeds,
  -- so the violation above is about the partial index and not about the row.
  BEGIN
    INSERT INTO public.cash_cluster_conversion
      (cluster_id, conversion_request_id, from_mode, to_mode, trigger_population,
       on_threshold, off_threshold, epoch_before)
    SELECT game_id, gen_random_uuid(), 'must_move', 'lightning', 18, 18, 12, 0 FROM board WHERE k = 'abort_direct';
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'FAIL 06: the partial index refuses a conversion on a Cluster whose only conversion is CLOSED, so it is not partial at all';
  END;
  DELETE FROM public.cash_cluster_conversion
   WHERE cluster_id = (SELECT game_id FROM board WHERE k = 'abort_direct') AND status = 'pending';

  -- THE SAME REQUEST TWICE IS IDEMPOTENT AND IS TOLD WHAT HAPPENED, which is
  -- the difference between "no-op safely" and "no-op".
  v_r2 := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000006');
  IF (v_r2 ->> 'ok')::boolean IS DISTINCT FROM true OR v_r2 ->> 'reason' IS DISTINCT FROM 'already_known'
     OR v_r2 ->> 'status' IS DISTINCT FROM 'pending'
     OR v_r2 ->> 'conversion_id' IS DISTINCT FROM (v_r1 ->> 'conversion_id') THEN
    RAISE EXCEPTION 'FAIL 06: the same begin request twice did not answer with what already happened: %', v_r2;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FAIL 06: the idempotent retry created a % conversion record', v_n; END IF;

  -- AND THE SAME FOR THE COMMIT: a retry of a committed request is answered
  -- with the epoch it committed at, and creates no second set of pool sessions.
  v_r1 := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000006');
  IF v_r1 ->> 'reason' IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FAIL 06: the commit refused: %', v_r1; END IF;
  SELECT count(*)::integer INTO v_pool FROM public.lightning_pool_session WHERE cluster_id = v_g;
  v_r2 := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000006');
  IF (v_r2 ->> 'ok')::boolean IS DISTINCT FROM true OR v_r2 ->> 'reason' IS DISTINCT FROM 'already_committed'
     OR (v_r2 ->> 'epoch_after')::integer IS DISTINCT FROM (v_r1 ->> 'epoch_after')::integer
     OR v_r2 ->> 'cluster_mode' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 06: a second commit of a committed request did not answer already_committed with the right epoch: %', v_r2;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'FAIL 06: a second commit created a second set of pool sessions: % became %', v_pool, v_n;
  END IF;
  SELECT cluster_epoch::text INTO v_state FROM public.cash_games WHERE id = v_g;
  IF v_state IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'FAIL 06: a second commit moved the epoch to %', v_state;
  END IF;
END $$;
\echo '  ok  06 F13 THE DOUBLE RACE   two converters with DIFFERENT request ids on one Cluster: exactly one opens a conversion and the other is refused wrong_state and TOLD the state it is in, with exactly one cash_cluster_conversion row on the Cluster - and the partial unique index cash_cluster_conversion_one_open_per_cluster is proved to be what stops it in the table by attempting the INSERT directly and catching the unique violation, with the same INSERT on a Cluster whose only conversion is CLOSED succeeding so the violation is about the index being PARTIAL rather than about the row. Then the SAME request id twice: begin answers already_known with the same conversion_id and status and creates nothing, and commit of an already committed request answers already_committed with the same epoch_after, creates no second set of pool sessions and does not move the epoch again'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 07 F14, THE JOIN/LEAVE RACE AT THE THRESHOLD --------------------------------
-- The population is asked at step 3 and asked AGAIN at step 10, and the set
-- that enters the pool must be the set as it stands at step 10. A pool built
-- from the step 3 set would carry a player who left and miss one who arrived -
-- which is the duplicate-player failure arriving not from a race but from a
-- conversion that trusted a stale measurement.
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_left uuid; v_joined uuid; v_n integer; v_tb uuid;
BEGIN
  v_g := public.fx_cluster('joinleave', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000008');
  IF (v_r ->> 'trigger_population')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 07: the conversion opened at a trigger population of % rather than 18', v_r ->> 'trigger_population';
  END IF;

  -- ONE LEAVES AND ONE ARRIVES, between the two measurements, at the threshold.
  SELECT ts.user_id INTO v_left FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g ORDER BY ts.seat_number LIMIT 1;
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE user_id = v_left;
  PERFORM public.fx_seat(v_g, 1, true, 90);
  SELECT ts.user_id INTO v_joined FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND ts.seat_number = 90;
  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 07: the re-measured population is % rather than 18, so this is not a test at the threshold', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000008');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 07: the re-measured population is still 18 and the commit refused anyway: %', v_r;
  END IF;

  -- THE POOL IS THE SET AS RE-MEASURED, NOT AS FIRST COUNTED.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_left) THEN
    RAISE EXCEPTION 'FAIL 07: the player who left during PENDING_ON is in the pool, so the pool was built from the measurement taken at step 3';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_joined) THEN
    RAISE EXCEPTION 'FAIL 07: the player who joined during PENDING_ON is NOT in the pool, so an eligible player was left seated at a table that has stopped dealing';
  END IF;
  -- SET EQUALITY, BOTH DIRECTIONS, against the eligibility predicate itself.
  SELECT count(*)::integer INTO v_n FROM (
    SELECT ps.player_id FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g
    EXCEPT
    SELECT ts.user_id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = v_g AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND coalesce(ts.is_sitting_out, false) = false AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0) x;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 07: % player(s) entered the pool who were not eligible at commit time', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM (
    SELECT ts.user_id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = v_g AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND coalesce(ts.is_sitting_out, false) = false AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0
    EXCEPT
    SELECT ps.player_id FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g) x;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 07: % eligible player(s) were counted and did not enter the pool', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM (
    SELECT player_id FROM public.lightning_pool_session WHERE cluster_id = v_g
     GROUP BY player_id HAVING count(*) > 1) x;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 07: % player(s) hold more than one pool session on this Cluster', v_n;
  END IF;
  -- AND THE ONE WHO LEFT IS NOT STRANDED IN THE OTHER DIRECTION EITHER: their
  -- seat and their cash session are exactly as the leave left them.
  IF NOT EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = v_left AND left_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 07: the conversion rewrote the seat of the player who left';
  END IF;
END $$;
\echo '  ok  07 F14 THE JOIN LEAVE    one player leaves and another joins between begin_pending_on and commit_lightning, leaving the population back at exactly the ON threshold: the commit converts on the RE-MEASURED population rather than on the one recorded when the conversion opened, the player who left is not in the pool, the player who joined IS, the pool set and the eligible set as re-measured at commit time are equal in BOTH directions by EXCEPT, no player holds two pool sessions, and the seat of the player who left is exactly as the leave left it'

-- 08 F15, NO PLAYER IS EVER IN TWO POOLS --------------------------------------
-- "Each player appears in exactly one pool." The commit enforces the count
-- itself and raises LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND if it does not
-- match, and the database enforces the set underneath it. The index is proved
-- to bite by being made to fire, because a partial unique index that was
-- created with the wrong predicate reads correctly in pg_indexes and stops
-- nothing.
DO $$
DECLARE v_g uuid; v_ps record; v_n integer; v_sess uuid;
BEGIN
  SELECT game_id INTO v_g FROM board WHERE k = 'happy';
  SELECT * INTO v_ps FROM public.lightning_pool_session WHERE cluster_id = v_g ORDER BY player_id LIMIT 1;
  IF v_ps IS NULL THEN RAISE EXCEPTION 'FAIL 08: the converted Cluster has no pool session to test against'; END IF;

  BEGIN
    INSERT INTO public.lightning_pool_session
      (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at, starting_stack)
    VALUES (v_ps.cluster_id, v_ps.cluster_epoch, v_ps.player_id, v_ps.cash_player_session_id,
            'active', clock_timestamp(), 1.00);
    RAISE EXCEPTION 'FAIL 08: lightning_pool_session_one_open did not stop a second OPEN pool session for a player who already has one';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  -- NON-VACUITY: the same row for a DIFFERENT player goes in, so the violation
  -- is about (player_id, cluster_id) and not about the insert being impossible.
  SELECT s.id INTO v_sess FROM public.cash_player_session s
   WHERE s.cluster_id = v_g AND s.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session p WHERE p.player_id = s.player_id)
   LIMIT 1;
  IF v_sess IS NULL THEN
    -- every player already has one, so make a new player rather than weaken the proof
    PERFORM public.fx_seat(v_g, 1, true, 80);
    SELECT s.id INTO v_sess FROM public.cash_player_session s
     WHERE s.cluster_id = v_g AND s.closed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session p WHERE p.player_id = s.player_id) LIMIT 1;
  END IF;
  INSERT INTO public.lightning_pool_session
    (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at, starting_stack)
  SELECT v_ps.cluster_id, v_ps.cluster_epoch, s.player_id, s.id, 'active', clock_timestamp(), 1.00
    FROM public.cash_player_session s WHERE s.id = v_sess;
  DELETE FROM public.lightning_pool_session WHERE cash_player_session_id = v_sess;
  DELETE FROM public.table_seats ts USING public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.seat_number = 80;
  DELETE FROM public.cash_player_session WHERE id = v_sess;

  -- AND EVERY ELIGIBLE PLAYER OF EVERY CONVERTED CLUSTER APPEARS EXACTLY ONCE.
  SELECT count(*)::integer INTO v_n FROM (
    SELECT player_id, cluster_id FROM public.lightning_pool_session WHERE exited_at IS NULL
     GROUP BY player_id, cluster_id HAVING count(*) > 1) x;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: % (player, cluster) pair(s) hold more than one open pool session across the whole estate', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM (
    SELECT player_id FROM public.lightning_pool_session WHERE exited_at IS NULL
     GROUP BY player_id HAVING count(*) > 1) x;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: % player(s) are in two pools at once', v_n;
  END IF;
END $$;
\echo '  ok  08 F15 ONE POOL ONLY     lightning_pool_session_one_open (player_id, cluster_id) WHERE exited_at IS NULL is proved to be what stops a second open pool session for the same player by attempting the INSERT and catching the unique violation - with the identical INSERT for a DIFFERENT player succeeding, so the violation is about the pair and not about the row being unbuildable - and across the whole estate no (player, cluster) pair and no player at all holds two open pool sessions'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 09 THE STAND-DOWNS, WHICH ARE THE POINT --------------------------------------
-- fn_cash_cluster_tick gates on `IF NOT g.must_move`, a BOOLEAN CAPABILITY -
-- does this game use must-move seating at all - and it is TRUE throughout a
-- conversion and is supposed to be, because Phase 10 reverts to must-move
-- seating using these very rules. cluster_mode is the STATE. The tick read the
-- capability and never the state, so it would have gone on opening feeders,
-- planning moves, balancing and reconciling Main 1 underneath a Lightning pool.
--
-- "It returns lightning_cluster_stands_down" is satisfied by a function that
-- returns that string after doing all of its work, so every stood-down call
-- here is wrapped in a full before/after md5 of tables, table_seats AND
-- cash_seat_moves, and the same Cluster in must_move, with the same conditions
-- planted, is proved to change all three.
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_tb text; v_ts text; v_mv text; v_n integer; v_mode text;
BEGIN
  v_g := public.fx_tickable('stand');
  -- MUST_MOVE: THE CONTROL. Everything below is measured against this.
  v_tb := public.fx_tables_md5(v_g); v_ts := public.fx_seats_md5(v_g); v_mv := public.fx_moves_md5(v_g);
  v_r := public.fn_cash_cluster_tick(v_g);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the tick does not work on a must_move Cluster: %', v_r;
  END IF;
  IF public.fx_tables_md5(v_g) IS NOT DISTINCT FROM v_tb OR public.fx_moves_md5(v_g) IS NOT DISTINCT FROM v_mv THEN
    RAISE EXCEPTION 'FAIL 09: the must_move control tick changed nothing, so every stand-down below is vacuous';
  END IF;

  FOREACH v_mode IN ARRAY ARRAY['pending_on', 'lightning'] LOOP
    -- Re-plant the very conditions the control tick acted on, so the stood-down
    -- tick is refusing work it would otherwise have done.
    UPDATE public.cash_seat_moves SET state = 'pending', resolved_at = NULL, executed_at = NULL,
           expires_at = clock_timestamp() - interval '5 minutes'
     WHERE game_id = v_g;
    UPDATE public.tables SET ante = NULL, min_buy_in = NULL, max_buy_in = NULL WHERE cluster_id = v_g;
    UPDATE public.cash_games SET cluster_mode = v_mode WHERE id = v_g;
    v_tb := public.fx_tables_md5(v_g); v_ts := public.fx_seats_md5(v_g); v_mv := public.fx_moves_md5(v_g);

    v_r := public.fn_cash_cluster_tick(v_g);
    IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false
       OR v_r ->> 'reason' IS DISTINCT FROM 'lightning_cluster_stands_down'
       OR v_r ->> 'cluster_mode' IS DISTINCT FROM v_mode THEN
      RAISE EXCEPTION 'FAIL 09: the tick did not stand down in %, it said %', v_mode, v_r;
    END IF;
    IF public.fx_tables_md5(v_g) IS DISTINCT FROM v_tb THEN
      RAISE EXCEPTION 'FAIL 09: the tick stood down in % and wrote a tables row anyway', v_mode;
    END IF;
    IF public.fx_seats_md5(v_g) IS DISTINCT FROM v_ts THEN
      RAISE EXCEPTION 'FAIL 09: the tick stood down in % and wrote a table_seats row anyway', v_mode;
    END IF;
    IF public.fx_moves_md5(v_g) IS DISTINCT FROM v_mv THEN
      RAISE EXCEPTION 'FAIL 09: the tick stood down in % and wrote a cash_seat_moves row anyway - a move between tables that are not dealing', v_mode;
    END IF;

    -- THE BALANCER SEPARATELY, because fn_cash_clusters_tick_all calls it after
    -- every tick, in the same transaction, INDEPENDENTLY of what the tick
    -- returned: standing the tick down does not stand the balancer down.
    v_n := public.fn_cash_cluster_balance(v_g, clock_timestamp());
    IF v_n IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'FAIL 09: the balancer planned % move(s) on a % Cluster', v_n, v_mode;
    END IF;
    IF public.fx_moves_md5(v_g) IS DISTINCT FROM v_mv OR public.fx_seats_md5(v_g) IS DISTINCT FROM v_ts THEN
      RAISE EXCEPTION 'FAIL 09: the balancer answered 0 in % and wrote a row anyway', v_mode;
    END IF;
  END LOOP;

  -- AND BACK. The stand-down is about the MODE and about nothing else: one
  -- column moved, and the same Cluster with the same board works again.
  UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE id = v_g;
  v_r := public.fn_cash_cluster_tick(v_g);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the tick did not come back when the Cluster went back to must_move: %', v_r;
  END IF;
  -- AND A MANUAL GAME STILL ANSWERS manual_game, which is pinned in
  -- server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts. The new
  -- guard goes AFTER the must_move test for exactly this reason.
  UPDATE public.cash_games SET must_move = false WHERE id = v_g;
  v_r := public.fn_cash_cluster_tick(v_g);
  IF v_r ->> 'reason' IS DISTINCT FROM 'manual_game' THEN
    RAISE EXCEPTION 'FAIL 09: a manual game now answers % rather than manual_game', v_r ->> 'reason';
  END IF;
  UPDATE public.cash_games SET must_move = true WHERE id = v_g;
END $$;

-- THE SUBSTITUTION WAS SURGICAL, read back from the catalogue and compared to
-- the lengths measured in section 01 before the migration ran.
DO $$
DECLARE
  v_tick text := pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure);
  v_bal  text := pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure);
  v_was_tick bigint; v_was_bal bigint;
BEGIN
  SELECT n INTO v_was_tick FROM pre WHERE k = 'tick_len';
  SELECT n INTO v_was_bal  FROM pre WHERE k = 'bal_len';
  IF v_was_tick IS NULL OR v_was_bal IS NULL THEN
    RAISE EXCEPTION 'FAIL 09: section 01 did not record the pre-substitution lengths, so nothing here is a comparison';
  END IF;
  IF (length(v_tick) > v_was_tick) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the tick did not GROW - % characters became % - so the substitution was not additive', v_was_tick, length(v_tick);
  END IF;
  IF (length(v_bal) > v_was_bal) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the balancer did not GROW - % characters became %', v_was_bal, length(v_bal);
  END IF;
  IF v_tick !~ 'IF NOT g\.must_move THEN RETURN' OR v_tick !~ 'manual_game'
     OR v_tick !~ 'fn_platform_frozen' OR v_tick !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'FAIL 09: the substitution lost a guard the tick had before it';
  END IF;
  IF v_bal !~ 'fn_cash_cluster_census\(p_game_id, p_now\)' THEN
    RAISE EXCEPTION 'FAIL 09: the substitution lost the balancer''s census call';
  END IF;
  -- LAW 10.5: a horse counts exactly like a human, pinned twice in
  -- server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts against the
  -- worklist and against the balancer.
  IF v_tick ~ 'is_horse' OR v_bal ~ 'is_horse' THEN
    RAISE EXCEPTION 'FAIL 09: LAW 10.5 - one of the stood-down functions now mentions is_horse';
  END IF;
END $$;
\echo '  ok  09 THE STAND DOWNS       fn_cash_cluster_tick called directly on the SAME Cluster in must_move, pending_on and lightning: it works in the first and answers lightning_cluster_stands_down naming the mode in the other two - and that is proved to MATTER, because the conditions the control tick acted on are re-planted before each stood-down call and the row-level md5 of tables, table_seats AND cash_seat_moves is byte-identical across every one of them, while the must_move control changes two of the three. fn_cash_cluster_balance answers 0 and writes nothing in both states, separately, because tick_all calls it after every tick whatever the tick returned. One column back and the tick works again, and a manual game still answers manual_game because the new guard goes after the must_move test. The substitution is surgical: both bodies GREW against the lengths measured before the migration was applied, the tick still carries IF NOT g.must_move THEN RETURN, manual_game, fn_platform_frozen and FOR UPDATE, the balancer still calls the census, and NEITHER mentions is_horse'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 10 THE CONVERSION-SAFE HAND BOUNDARY -----------------------------------------
-- The specification names it once and never defines it, so the migration
-- defines it: no hand_history row of this Cluster with ended_at NULL that
-- started within six hours. Both halves matter. A boundary that only tested
-- ended_at would wait for ever on an abandoned row from a crashed engine and no
-- Cluster would ever convert again.
DO $$
DECLARE v_g uuid; v_r jsonb; v_tb uuid; v_h uuid; v_tbl text; v_seat text; v_conv text; v_n integer;
BEGIN
  v_g := public.fx_cluster('hands', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  SELECT id INTO v_tb FROM public.tables WHERE cluster_id = v_g LIMIT 1;
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000009');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 10: begin refused: %', v_r; END IF;

  INSERT INTO public.hand_history (table_id, hand_number, started_at, ended_at)
  VALUES (v_tb, 1, clock_timestamp(), NULL) RETURNING id INTO v_h;

  v_tbl := public.fx_tables_md5(v_g); v_seat := public.fx_seats_md5(v_g);
  SELECT md5(c::text) INTO v_conv FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000009');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'hands_in_flight'
     OR (v_r ->> 'hands_in_flight')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 10: the commit did not refuse on a hand in flight: %', v_r;
  END IF;
  -- AND IT CHANGED NOTHING. A refusal that half-converted would be worse than
  -- no boundary at all.
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'pending_on'
     OR (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 10: the refused commit moved the Cluster anyway';
  END IF;
  IF public.fx_tables_md5(v_g) IS DISTINCT FROM v_tbl OR public.fx_seats_md5(v_g) IS DISTINCT FROM v_seat THEN
    RAISE EXCEPTION 'FAIL 10: the refused commit wrote a tables or table_seats row';
  END IF;
  IF (SELECT md5(c::text) FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g) IS DISTINCT FROM v_conv THEN
    RAISE EXCEPTION 'FAIL 10: the refused commit wrote the conversion record';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 10: the refused commit created % pool session(s)', v_n; END IF;

  -- THE HAND ENDS AND THE BOUNDARY ARRIVES. The halt placed at step 6 is what
  -- makes it arrive rather than merely be tested for: no new hand starts, so
  -- the set of in-flight hands only shrinks.
  UPDATE public.hand_history SET ended_at = clock_timestamp() WHERE id = v_h;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000009');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 10: ending the hand did not let the conversion through: %', v_r;
  END IF;
END $$;

DO $$
DECLARE v_g uuid; v_r jsonb; v_tb uuid;
BEGIN
  -- AN ABANDONED HAND MUST NOT WEDGE A CLUSTER FOR EVER. Six hours is far
  -- beyond any real hand and far inside any plausible abandonment.
  v_g := public.fx_cluster('stale_hand', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  SELECT id INTO v_tb FROM public.tables WHERE cluster_id = v_g LIMIT 1;
  INSERT INTO public.hand_history (table_id, hand_number, started_at, ended_at)
  VALUES (v_tb, 1, clock_timestamp() - interval '7 hours', NULL);
  -- NON-VACUITY: the same row one interval later DOES block, so "it did not
  -- block" is a statement about the age and not about the row being invisible.
  INSERT INTO public.hand_history (table_id, hand_number, started_at, ended_at)
  VALUES (v_tb, 2, clock_timestamp() - interval '5 hours', NULL);
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000a');
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000000a');
  IF v_r ->> 'reason' IS DISTINCT FROM 'hands_in_flight' OR (v_r ->> 'hands_in_flight')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 10: a five-hour-old in-flight hand did not block, so the six-hour window is not being applied: %', v_r;
  END IF;
  DELETE FROM public.hand_history WHERE table_id = v_tb AND hand_number = 2;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000000a');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 10: a SEVEN-hour-old in-flight hand wedged the Cluster: %', v_r;
  END IF;
END $$;
\echo '  ok  10 THE HAND BOUNDARY     a hand_history row with ended_at NULL on a table of the Cluster makes commit_lightning refuse hands_in_flight counting exactly one, and the refusal changes NOTHING - the mode, the epoch, the tables md5, the table_seats md5 and the conversion record are all byte-identical and no pool session is created - ending the hand lets the same request through on the next call, and a SEVEN-hour-old in-flight row does not block at all, with a FIVE-hour-old one on the same table proved to block first so the six-hour window is measured rather than assumed: an abandoned hand from a crashed engine has ended_at NULL for ever and must not wedge a Cluster'

-- 11 THE FREEZE IS HONOURED ON THE WAY IN AND NOT ON THE WAY OUT ---------------
-- server/src/maintenance/theFreezeIsTotal.law.test.ts forbids any path that
-- seats, registers or moves chips during the break. A conversion moves no
-- chips, but it stops every table in a Cluster from dealing, which is
-- emphatically an engine-affecting act. Leaving a half-converted Cluster,
-- though, is exactly what an operator does DURING an incident.
DO $$
DECLARE v_g uuid; v_r jsonb; v_n integer;
BEGIN
  v_g := public.fx_cluster('freeze', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  PERFORM public.fx_freeze(true);
  IF public.fn_platform_frozen() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: the harness could not freeze the platform, so nothing below is a test';
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000b');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: a Cluster can be driven into PENDING_ON during the maintenance break: %', v_r;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 11: the frozen begin opened % conversion(s)', v_n; END IF;

  -- NON-VACUITY: thawed, the very same call works, so the refusal is about the
  -- freeze and not about the Cluster.
  PERFORM public.fx_freeze(false);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000b');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 11: the thawed begin was refused too, so the frozen refusal proved nothing: %', v_r;
  END IF;

  PERFORM public.fx_freeze(true);
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000000b');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: a Cluster can be committed into LIGHTNING during the maintenance break: %', v_r;
  END IF;
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the frozen commit moved the epoch anyway';
  END IF;

  -- AND THE ABORT STILL WORKS, frozen, because a Cluster stuck in PENDING_ON
  -- with every table halted is exactly the state an operator has to be able to
  -- leave during an incident, and the break is when incidents are handled.
  v_r := public.fn_cash_cluster_abort_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000b', 'incident recovery');
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true OR v_r ->> 'reason' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 11: a half-converted Cluster cannot be recovered during an incident: %', v_r;
  END IF;
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 11: the frozen abort answered ok and did not move the Cluster';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the frozen abort left % table(s) halted', v_n;
  END IF;
  PERFORM public.fx_freeze(false);
END $$;
\echo '  ok  11 THE FREEZE            with fn_platform_frozen() true, begin_pending_on refuses platform_frozen and opens no conversion and commit_lightning refuses platform_frozen and does not move the epoch - each proved non-vacuous by the identical call succeeding one break row later - and abort_pending_on STILL WORKS while frozen, returning the Cluster to must_move with every halt cleared, because recovering a half-converted Cluster during an incident must always be possible and the break is when incidents are handled'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 12 THE ORPHAN REFUSAL --------------------------------------------------------
-- lightning_pool_session.cash_player_session_id is NOT NULL, and the
-- subordination is the point: "Entering/exiting Lightning does not create a new
-- cash session." So a seated eligible player with no open Cluster session
-- cannot enter the pool - and the failure to guard it is not a missing feature,
-- it is a 23502 NOT NULL violation that aborts the whole transaction with a
-- message about a column instead of about a player.
DO $$
DECLARE v_g uuid; v_r jsonb; v_c record; v_n integer; v_p uuid;
BEGIN
  v_g := public.fx_cluster('orphan', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  SELECT ts.user_id INTO v_p FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g ORDER BY ts.seat_number LIMIT 1;
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'harness'
   WHERE cluster_id = v_g AND player_id = v_p;
  -- The player is STILL SEATED, STILL ELIGIBLE and still counted, which is what
  -- makes this an orphan rather than a departure.
  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 12: closing the cash session changed the eligible count to %, so this is not an orphan', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000c');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 12: begin refused: %', v_r; END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000000c');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 12: the commit did not abort cleanly on an orphan - it answered %, and if that is a raise the whole transaction died on a NOT NULL violation', v_r;
  END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR v_c.abort_reason NOT LIKE '%no open cash session%'
     OR v_c.abort_reason NOT LIKE '1 %' THEN
    RAISE EXCEPTION 'FAIL 12: the abort reason does not COUNT the orphans: %', coalesce(v_c.abort_reason, '<null>');
  END IF;
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 12: the orphan abort did not put the Cluster back in must_move';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 12: the orphan abort left % table(s) halted', v_n; END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 12: the orphan abort left % pool session(s) behind', v_n; END IF;

  -- NON-VACUITY: give the player a session back and the identical pair of calls
  -- converts, so the refusal is about the missing session and nothing else.
  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
  SELECT v_p, 'cb000000-0000-0000-0000-000000000001', 'cluster', v_g, ts.table_id, 'nlh', 1.00, 2.00, ts.stack, v_g, clock_timestamp()
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND ts.user_id = v_p;
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-00000000000d');
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-00000000000d');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 12: with the session restored the identical conversion still failed, so the orphan refusal proved nothing: %', v_r;
  END IF;
END $$;
\echo '  ok  12 THE ORPHAN REFUSAL    an eligible seated player whose only open cluster-scoped cash_player_session has been closed - still seated, still counted at 18 - makes commit_lightning ABORT CLEANLY rather than raise a NOT NULL violation out of lightning_pool_session.cash_player_session_id: the conversion record says aborted with a reason that COUNTS the orphans ("1 eligible seated player(s) have no open cash session"), the Cluster ends in must_move with every halt cleared and no pool session anywhere, and giving that one player a session back makes the identical pair of calls convert all 18'

-- 13 WRONG STATE AND NOT FOUND, ANSWERED RATHER THAN RAISED -------------------
-- Every one of these is a question a caller asks, so every one of them is
-- answered. A Cluster already in pending_on is not an error to the caller - it
-- is the answer to "is a conversion in progress".
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_mode text; v_req uuid := 'a0000000-0000-0000-0000-0000000000e0';
  v_missing uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
BEGIN
  -- NOT FOUND, all three.
  FOR v_mode IN SELECT unnest(ARRAY['begin', 'abort', 'commit']) LOOP
    v_r := CASE v_mode
             WHEN 'begin'  THEN public.fn_cash_cluster_begin_pending_on(v_missing, v_req)
             WHEN 'abort'  THEN public.fn_cash_cluster_abort_pending_on(v_missing, v_req, 'x')
             ELSE               public.fn_cash_cluster_commit_lightning(v_missing, v_req) END;
    IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'not_found' THEN
      RAISE EXCEPTION 'FAIL 13: % on a Cluster that does not exist answered %', v_mode, v_r;
    END IF;
  END LOOP;

  -- EVERY ILLEGAL STARTING MODE FOR begin. cluster_mode already admits all ten
  -- states, so nothing here widens anything.
  v_g := public.fx_cluster('states', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  FOREACH v_mode IN ARRAY ARRAY['created','opening','pending_on','lightning','pending_off','draining','paused','frozen','dead'] LOOP
    UPDATE public.cash_games SET cluster_mode = v_mode WHERE id = v_g;
    v_r := public.fn_cash_cluster_begin_pending_on(v_g, gen_random_uuid());
    IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'wrong_state'
       OR v_r ->> 'cluster_mode' IS DISTINCT FROM v_mode THEN
      RAISE EXCEPTION 'FAIL 13: begin_pending_on in % answered % rather than a wrong_state naming the mode', v_mode, v_r;
    END IF;
    IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion WHERE cluster_id = v_g) THEN
      RAISE EXCEPTION 'FAIL 13: begin_pending_on in % opened a conversion anyway', v_mode;
    END IF;
  END LOOP;
  -- AND must_move WORKS, so the nine refusals above are about the mode.
  UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE id = v_g;
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, v_req);
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 13: begin_pending_on is refused in must_move too, so the nine refusals proved nothing: %', v_r;
  END IF;

  -- EVERY ILLEGAL MODE FOR abort AND commit, on a conversion that really is
  -- open, so the refusal is about the mode and not about the record.
  FOREACH v_mode IN ARRAY ARRAY['must_move','created','opening','lightning','pending_off','draining','paused','frozen','dead'] LOOP
    UPDATE public.cash_games SET cluster_mode = v_mode WHERE id = v_g;
    v_r := public.fn_cash_cluster_abort_pending_on(v_g, v_req, 'x');
    IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'wrong_state'
       OR v_r ->> 'cluster_mode' IS DISTINCT FROM v_mode THEN
      RAISE EXCEPTION 'FAIL 13: abort_pending_on in % answered %', v_mode, v_r;
    END IF;
    v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
    IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'wrong_state'
       OR v_r ->> 'cluster_mode' IS DISTINCT FROM v_mode THEN
      RAISE EXCEPTION 'FAIL 13: commit_lightning in % answered %', v_mode, v_r;
    END IF;
  END LOOP;

  -- A REQUEST ID NOBODY EVER OPENED.
  UPDATE public.cash_games SET cluster_mode = 'pending_on' WHERE id = v_g;
  v_r := public.fn_cash_cluster_abort_pending_on(v_g, v_missing, 'x');
  IF v_r ->> 'reason' IS DISTINCT FROM 'no_such_conversion' THEN
    RAISE EXCEPTION 'FAIL 13: abort of an unknown request answered %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_missing);
  IF v_r ->> 'reason' IS DISTINCT FROM 'no_such_conversion' THEN
    RAISE EXCEPTION 'FAIL 13: commit of an unknown request answered %', v_r;
  END IF;

  -- AND A CONVERSION THAT IS ALREADY CLOSED.
  PERFORM public.fn_cash_cluster_abort_pending_on(v_g, v_req, 'closing it for the next assertion');
  UPDATE public.cash_games SET cluster_mode = 'pending_on' WHERE id = v_g;
  v_r := public.fn_cash_cluster_abort_pending_on(v_g, v_req, 'x');
  IF v_r ->> 'reason' IS DISTINCT FROM 'conversion_already_closed' OR v_r ->> 'status' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 13: aborting a closed conversion answered %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
  IF v_r ->> 'reason' IS DISTINCT FROM 'conversion_already_closed' OR v_r ->> 'status' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 13: committing a closed conversion answered %', v_r;
  END IF;
  UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE id = v_g;

  -- BELOW THE THRESHOLD IS ITS OWN ANSWER, carrying the verdict and the
  -- thresholds so the caller can see WHY.
  DELETE FROM public.table_seats ts USING public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = v_g AND ts.seat_number > 10;
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, gen_random_uuid());
  IF v_r ->> 'reason' IS DISTINCT FROM 'threshold_not_reached'
     OR (v_r -> 'thresholds' ->> 'on')::integer IS DISTINCT FROM 18
     OR (v_r -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'FAIL 13: a Cluster of ten under an ON threshold of eighteen answered %', v_r;
  END IF;
END $$;
\echo '  ok  13 WRONG STATE           all three functions answer not_found rather than raising on a Cluster id that does not exist; begin_pending_on answers wrong_state NAMING the mode in every one of the nine states that is not must_move and opens no conversion in any of them, and converts in must_move so the nine refusals are about the mode; abort_pending_on and commit_lightning answer wrong_state naming the mode in every one of the nine states that is not pending_on, on a conversion that really is open; both answer no_such_conversion for a request id nobody opened and conversion_already_closed with the status for one that is closed; and a Cluster of ten under an ON threshold of eighteen is told threshold_not_reached with the verdict and both thresholds in the answer'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 14 GRANTS AND RLS ------------------------------------------------------------
-- All three functions are SECURITY DEFINER and all three write. Asserted in
-- BOTH directions, three ways, because a REVOKE that silently did nothing and a
-- GRANT that silently did nothing look identical from one side.
DO $$
DECLARE v_n integer; v_fn text;
BEGIN
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN
     ('fn_cash_cluster_begin_pending_on','fn_cash_cluster_abort_pending_on','fn_cash_cluster_commit_lightning');
  IF v_n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'FAIL 14: % of the three conversion functions exist', v_n; END IF;
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname IN ('fn_cash_cluster_begin_pending_on','fn_cash_cluster_abort_pending_on','fn_cash_cluster_commit_lightning');
  IF v_n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'FAIL 14: only % of the three are SECURITY DEFINER', v_n; END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.fn_cash_cluster_begin_pending_on(uuid,uuid)',
                              'public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)',
                              'public.fn_cash_cluster_commit_lightning(uuid,uuid)'] LOOP
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 14: anon can execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 14: authenticated can execute %', v_fn;
    END IF;
    IF has_function_privilege('public', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 14: PUBLIC can execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 14: service_role CANNOT execute %, so nothing can drive a conversion at all', v_fn;
    END IF;
  END LOOP;
  -- THE SAME THING THROUGH THE CATALOGUE VIEW the @live-proof uses, because a
  -- privilege can be held by a role and also be visible as a grant, and the two
  -- readings disagree when a grant was made to PUBLIC.
  SELECT count(*)::integer INTO v_n FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public' AND grantee IN ('anon','authenticated','PUBLIC')
     AND routine_name IN ('fn_cash_cluster_begin_pending_on','fn_cash_cluster_abort_pending_on','fn_cash_cluster_commit_lightning');
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 14: % grant(s) to anon, authenticated or PUBLIC survive', v_n; END IF;

  -- THE RECORD TABLE IS LOCKED DOWN. RLS enabled and NO policy at all, so the
  -- only reader is a role that bypasses it.
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cash_cluster_conversion'::regclass) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 14: cash_cluster_conversion does not have row level security enabled';
  END IF;
  SELECT count(*)::integer INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_cluster_conversion';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 14: cash_cluster_conversion carries % polic(ies), so something other than service_role can read a conversion', v_n;
  END IF;
  IF has_table_privilege('anon', 'public.cash_cluster_conversion', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cash_cluster_conversion', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 14: anon or authenticated holds SELECT on cash_cluster_conversion';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.cash_cluster_conversion', 'SELECT')
          AND has_table_privilege('service_role', 'public.cash_cluster_conversion', 'INSERT')
          AND has_table_privilege('service_role', 'public.cash_cluster_conversion', 'UPDATE')) THEN
    RAISE EXCEPTION 'FAIL 14: service_role cannot read or write cash_cluster_conversion';
  END IF;
  -- AND THE HALT IS EXPLAINED OR IT IS NOT A HALT.
  BEGIN
    UPDATE public.tables SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = NULL
     WHERE id = (SELECT id FROM public.tables LIMIT 1);
    RAISE EXCEPTION 'FAIL 14: a table can be halted with no reason, so an operator at three in the morning is told nothing by the row';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.tables SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = 'because'
     WHERE id = (SELECT id FROM public.tables LIMIT 1);
    RAISE EXCEPTION 'FAIL 14: the halt reason vocabulary is open, so a typo in the string the revert path matches on would leave a table halted for ever';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
\echo '  ok  14 GRANTS AND RLS       all three conversion functions exist and all three are SECURITY DEFINER; anon, authenticated and PUBLIC hold EXECUTE on NONE of them and service_role holds EXECUTE on ALL of them, asserted through has_function_privilege in both directions and again through information_schema.role_routine_grants; cash_cluster_conversion has row level security ENABLED and carries no policy at all, anon and authenticated hold no SELECT on it and service_role holds SELECT, INSERT and UPDATE; and tables_dealing_halt_is_explained really fires - a halt with a NULL reason and a halt with a reason outside the closed vocabulary are both refused with a check violation'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 17 THE NULLABLE LIFECYCLE ---------------------------------------------------
-- public.tables.lifecycle is plain nullable text with a CHECK and no default
-- and no backfill, so a board whose lifecycle nobody ever set carries NULL -
-- and the CHECK does not object, because a CHECK that evaluates to NULL PASSES.
-- Everything below follows from that one column being nullable.
--
-- `tb.lifecycle <> 'closed'` against a NULL evaluates to NULL, not to true, so
-- a filter written that way SILENTLY DROPS THE BOARD. An earlier cut of this
-- migration coalesced that predicate in its two halt UPDATEs and did not
-- coalesce it in the orphan check, the lightning_pool_session INSERT or the
-- v_seated census - so a NULL-lifecycle board was STOPPED while every eligible
-- player sitting at it was left out of every player-set query. They ended the
-- transaction seated at a board that had stopped dealing, in a Cluster that
-- believed it owned them, with no pool session and no way back.
--
-- THE MIGRATION COULD NOT SEE IT, AND NEITHER COULD ANY COUNT. v_pool and
-- v_seated shared the excluding predicate, so the filter that wrongly narrowed
-- made BOTH numbers smaller and they still agreed. That is the general shape:
-- a guard that compares two queries over the same predicate is blind to that
-- predicate. The only assertion that bites is one asked from the OTHER side -
-- over the boards this conversion actually HALTED - and that is the assertion
-- this section makes, in the harness, independently of the migration making it
-- too, so that deleting the migration's own copy does not delete the coverage.
--
-- Every claim here is made twice over: once on a board whose lifecycle is NULL
-- and once on the SAME shape with lifecycle 'live', so that what is proved is
-- about the NULL and not about a Cluster that happens to have two boards.
--
-- THIS SECTION ALSO PINS A FINDING THAT IS NOT THIS MIGRATION'S.
-- fn_cash_cluster_live_eligible - 20260921064717, the threshold reader this
-- conversion asks at step 4 and again at step 10 - STILL carries the bare
-- `tb.lifecycle <> 'closed'`, uncoalesced. It is the same three-valued-logic
-- defect in the same column, one migration upstream, and it is live. Phase 5
-- is safe from it (its own player-set queries are coalesced, and the stranding
-- assertion catches what a count cannot) but it is not INVISIBLE to it: the
-- population that authorises a conversion, and the trigger_population written
-- into the conversion record, are both taken from that reader. So a Cluster
-- whose players sit on a NULL-lifecycle board is told it is below the ON
-- threshold and never converts at all. Both facts are asserted below rather
-- than described, and the assertions say in their own messages that the fix
-- belongs in Phase 4 and that THIS section is what must then be updated.

CREATE FUNCTION public.fx_stranded(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- THE QUESTION ASKED FROM THE HALTED SIDE. It names no lifecycle at all, so
  -- no predicate that wrongly narrows can shrink both sides of it into
  -- agreement: if this conversion stopped a board, every eligible player
  -- sitting at that board must have somewhere to play.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game
     AND tb.dealing_halted_at IS NOT NULL
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                      WHERE s.cluster_id = p_game AND s.player_id = ts.user_id
                        AND s.exited_at IS NULL);
$fx$;

CREATE FUNCTION public.fx_eligible_coalesced(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active')
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;
$fx$;

CREATE FUNCTION public.fx_eligible_bare(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- The SAME query with the ONE difference this section is about.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active')
     AND tb.lifecycle <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;
$fx$;

CREATE FUNCTION public.fx_unhalted_eligible(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- The mirror of fx_stranded: an eligible player of a converted Cluster whose
  -- board is still DEALING. A Cluster in lightning with a board nobody stopped
  -- is the same defect wearing the other hat.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game
     AND tb.dealing_halted_at IS NULL
     AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active')
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;
$fx$;

-- 17a THE CONVERSION ITSELF, AND 17b THE SAME SHAPE WITH lifecycle 'live' -----
DO $$
DECLARE
  v_g uuid; v_nb uuid; v_ctl uuid; v_lb uuid;
  v_r jsonb; v_c record; v_n integer; v_m integer;
  v_epoch integer; v_ctl_epoch integer; v_bad text;
BEGIN
  -- 17a. Eighteen eligible on a live Main 1, three more on a board with NO
  -- lifecycle, all twenty-one carrying an open cluster-scoped cash session.
  v_g  := public.fx_cluster('nullcycle', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_nb := public.fx_board_without_lifecycle(v_g, 'nullcycle nb', 'feeder');
  PERFORM public.fx_seat_at(v_g, v_nb, 3, true, 19);

  -- NON-VACUITY, AND IT IS THE WHOLE POINT OF THE SECTION: the bare predicate
  -- really does drop this board. Two boards satisfy the coalesced predicate and
  -- exactly ONE satisfies the bare one, because NULL <> 'closed' is NULL and
  -- SQL takes NULL as not-true.
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND coalesce(lifecycle, '') <> 'closed';
  SELECT count(*)::integer INTO v_m FROM public.tables
   WHERE cluster_id = v_g AND lifecycle <> 'closed';
  IF v_n IS DISTINCT FROM 2 OR v_m IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 17: the NULL-lifecycle board is not built - the coalesced predicate sees % board(s) and the bare one sees %, so nothing below is about three-valued logic at all', v_n, v_m;
  END IF;
  IF public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 21
     OR public.fx_eligible_bare(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 17: the Cluster is not eighteen-plus-three - the coalesced eligible set is % and the bare one is %', public.fx_eligible_coalesced(v_g), public.fx_eligible_bare(v_g);
  END IF;

  -- PINNED FINDING, PHASE 4 AND NOT THIS FILE. fn_cash_cluster_live_eligible
  -- carries the bare predicate, so the one reader the lobby embeds and the one
  -- the conversion asks at steps 4 and 10 cannot see these three players.
  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: fn_cash_cluster_live_eligible answered % on a Cluster of 21 with 3 of them on a NULL-lifecycle board. It must answer 21: Phase 5 re-cut it to use the SAME membership predicate as the conversion, because a reader that undercounts is the number that AUTHORISES a conversion - a Cluster whose players sit on such a board would be told threshold_not_reached however many were playing, and any conversion it did make would record a trigger_population short of the truth', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  -- BEGIN STOPS BOTH BOARDS, including the one no player-set query used to see.
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000170');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: begin_pending_on over a NULL-lifecycle board answered %', v_r;
  END IF;
  IF (SELECT dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning_pending_on'
        FROM public.tables WHERE id = v_nb) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 17: the NULL-lifecycle board was NOT halted, so the stranding this section is about cannot even arise here and nothing below would prove anything';
  END IF;

  -- NON-VACUITY FOR THE STRANDING QUERY ITSELF, one step before the commit.
  -- The same query, the same Cluster: both boards are stopped and no pool
  -- session exists yet, so it answers 21. An assertion that can only ever
  -- answer zero is not an assertion.
  IF public.fx_stranded(v_g) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: with both boards halted and not one pool session created, the stranding query answered % rather than 21 - it cannot detect a stranding and the zero it reports after the commit would mean nothing', public.fx_stranded(v_g);
  END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000170');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 17: the Cluster with a NULL-lifecycle board did not convert: %', v_r;
  END IF;
  v_epoch := (v_r ->> 'epoch_after')::integer;

  -- THE STRANDING ASSERTION, FIRST AND ALONE, so a run that goes red here says
  -- STRANDED and names the boards rather than reporting a count that differs.
  v_n := public.fx_stranded(v_g);
  IF v_n IS DISTINCT FROM 0 THEN
    SELECT string_agg(DISTINCT tb.name, ', ') INTO v_bad
      FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = v_g AND tb.dealing_halted_at IS NOT NULL
       AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0
       AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                        WHERE s.cluster_id = v_g AND s.player_id = ts.user_id AND s.exited_at IS NULL);
    RAISE EXCEPTION 'FAIL 17: THE CONVERSION STRANDED % ELIGIBLE PLAYER(S). They are seated at halted board(s) % of a Cluster that is now lightning, their boards have stopped dealing and not one of them has a pool session - a NULL lifecycle let the halt see the board while the player-set queries could not', v_n, coalesce(v_bad, '<unnamed>');
  END IF;

  -- AND THE MIRROR: nobody eligible is still being dealt to.
  IF public.fx_unhalted_eligible(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: % eligible player(s) are seated at a board that is STILL DEALING in a Cluster that is now lightning', public.fx_unhalted_eligible(v_g);
  END IF;

  -- v_pool, v_seated AND THE HALTED SET ALL AGREE, and they agree at 21.
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session
   WHERE cluster_id = v_g AND cluster_epoch = v_epoch AND exited_at IS NULL;
  SELECT count(DISTINCT player_id)::integer INTO v_m FROM public.lightning_pool_session
   WHERE cluster_id = v_g;
  IF (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 21 OR v_n IS DISTINCT FROM 21
     OR v_m IS DISTINCT FROM 21 OR public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: the conversion answered % pool session(s), the estate holds % at epoch % over % distinct player(s), and the eligible seated set is % - all four must be 21',
      v_r ->> 'pool_sessions', v_n, v_epoch, v_m, public.fx_eligible_coalesced(v_g);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning';
  IF v_n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: % board(s) of the converted Cluster carry the lightning halt rather than 2', v_n;
  END IF;

  -- EVERY ONE OF THE THREE ON THE NULL BOARD IS SUBORDINATE TO THE CASH SESSION
  -- THEY ALREADY HAD - same player, same Cluster, still open, at the NEW epoch,
  -- with the stack they are sitting behind.
  SELECT count(*)::integer INTO v_n FROM public.table_seats ts
   WHERE ts.table_id = v_nb AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.lightning_pool_session s
                   JOIN public.cash_player_session c ON c.id = s.cash_player_session_id
                  WHERE s.cluster_id = v_g AND s.player_id = ts.user_id
                    AND s.cluster_epoch = v_epoch AND s.state = 'active'
                    AND s.exited_at IS NULL AND s.starting_stack = ts.stack
                    AND c.player_id = ts.user_id AND c.cluster_id = v_g
                    AND c.closed_at IS NULL);
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 17: only % of the 3 players on the NULL-lifecycle board hold a pool session at epoch % pointing at the open cash session they already had', v_n, v_epoch;
  END IF;

  -- AND THE RECORD. trigger_population is taken from the Phase 4 reader, so it
  -- says 18 over a pool of 21: the conversion is right and the number written
  -- beside it is not. Asserted rather than described, with the same note.
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'committed' OR v_c.epoch_after IS DISTINCT FROM v_epoch THEN
    RAISE EXCEPTION 'FAIL 17: the conversion record says % at epoch %', v_c.status, v_c.epoch_after;
  END IF;
  IF v_c.trigger_population IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: the conversion record recorded a trigger_population of % over a pool of 21. The record and the pool must agree, because that number is what an operator reads afterwards to understand what happened', v_c.trigger_population;
  END IF;

  -- 17b. THE SAME CLUSTER WITH lifecycle 'live' ON THAT BOARD. Everything the
  -- conversion does must be identical, or what 17a proved was about a Cluster
  -- with two boards rather than about a NULL.
  v_ctl := public.fx_cluster('livecycle', 6, 40);
  PERFORM public.fx_seat(v_ctl, 18);
  v_lb  := public.fx_table(v_ctl, 'livecycle lb', 'feeder', NULL, 40);
  PERFORM public.fx_seat_at(v_ctl, v_lb, 3, true, 19);
  IF (SELECT lifecycle FROM public.tables WHERE id = v_lb) IS DISTINCT FROM 'live'
     OR public.fx_eligible_bare(v_ctl) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: the control Cluster is not the same shape with a live lifecycle';
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_ctl, 'a0000000-0000-0000-0000-000000000171');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: begin_pending_on on the live-lifecycle control answered %', v_r;
  END IF;
  IF public.fx_stranded(v_ctl) IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: the control did not reach the same pre-commit stranding count';
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_ctl, 'a0000000-0000-0000-0000-000000000171');
  v_ctl_epoch := (v_r ->> 'epoch_after')::integer;
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 21
     OR public.fx_stranded(v_ctl) IS DISTINCT FROM 0
     OR public.fx_unhalted_eligible(v_ctl) IS DISTINCT FROM 0
     OR v_ctl_epoch IS DISTINCT FROM v_epoch THEN
    RAISE EXCEPTION 'FAIL 17: the live-lifecycle control did NOT behave as the NULL one did: % with % stranded and % still dealing', v_r, public.fx_stranded(v_ctl), public.fx_unhalted_eligible(v_ctl);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.table_seats ts
   WHERE ts.table_id = v_lb AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.lightning_pool_session s
                   JOIN public.cash_player_session c ON c.id = s.cash_player_session_id
                  WHERE s.cluster_id = v_ctl AND s.player_id = ts.user_id
                    AND s.cluster_epoch = v_ctl_epoch AND s.state = 'active'
                    AND s.exited_at IS NULL AND s.starting_stack = ts.stack
                    AND c.player_id = ts.user_id AND c.cluster_id = v_ctl AND c.closed_at IS NULL);
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 17: only % of the 3 players on the live-lifecycle board are subordinate to their cash session', v_n;
  END IF;

  -- THE ONE THING THAT IS ALLOWED TO DIFFER, AND IT IS NOT THE CONVERSION. The
  -- control was counted at 21 by the Phase 4 reader and the NULL board at 18 -
  -- same shape, same players, same stacks, one column different.
  SELECT trigger_population INTO v_m FROM public.cash_cluster_conversion WHERE cluster_id = v_ctl;
  IF v_m IS DISTINCT FROM 21 THEN
    RAISE EXCEPTION 'FAIL 17: the live-lifecycle control recorded a trigger_population of % rather than 21, so the 18 recorded for the NULL board is not attributable to the NULL', v_m;
  END IF;
END $$;

-- 17c WHAT THE PHASE 4 READER COSTS: A CLUSTER THAT WILL NOT CONVERT ----------
-- Nineteen eligible players, four of them on a board with no lifecycle. The
-- conversion is authorised by fn_cash_cluster_live_eligible, which cannot see
-- those four, so the Cluster is told it is below the ON threshold of 18 and
-- stays in must_move for ever. Non-vacuous by construction: one UPDATE to that
-- board's lifecycle and the identical call converts all nineteen.
DO $$
DECLARE v_g uuid; v_nb uuid; v_r jsonb; v_n integer;
BEGIN
  v_g  := public.fx_cluster('nullthresh', 6, 40);
  PERFORM public.fx_seat(v_g, 15);
  v_nb := public.fx_board_without_lifecycle(v_g, 'nullthresh nb', 'feeder');
  PERFORM public.fx_seat_at(v_g, v_nb, 4, true, 16);
  IF public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 17: the threshold Cluster holds % eligible players rather than 19', public.fx_eligible_coalesced(v_g);
  END IF;

  -- THE WHOLE POINT OF THE RE-CUT. fifteen on a live board and four on a board
  -- whose lifecycle is NULL is nineteen, and nineteen is over a six-max ON
  -- threshold of eighteen. Before Phase 5 re-cut fn_cash_cluster_live_eligible
  -- onto the same membership predicate as the conversion, this Cluster was
  -- told threshold_not_reached at FIFTEEN and stayed in must_move for ever,
  -- however many people were playing on that board.
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000172');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'trigger_population')::integer IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 17: a Cluster of 19 with 4 on a NULL-lifecycle board answered % to begin_pending_on. It must reach PENDING_ON at a trigger_population of 19: the authorising number reads the same membership as the conversion, so a board the column permits to be NULL cannot hide four players from the threshold', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000172');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 19
     OR public.fx_stranded(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: the NULL-lifecycle threshold Cluster did not convert all 19: % with % stranded', v_r, public.fx_stranded(v_g);
  END IF;

  -- NON-VACUITY, FROM THE OTHER SIDE: a Cluster of 15 on a live board plus 2 on
  -- a NULL one is SEVENTEEN and must still be refused, so what is proved above
  -- is that the four are counted and not that the threshold stopped mattering.
  v_g  := public.fx_cluster('nullthresh2', 6, 40);
  PERFORM public.fx_seat(v_g, 15);
  v_nb := public.fx_board_without_lifecycle(v_g, 'nullthresh2 nb', 'feeder');
  PERFORM public.fx_seat_at(v_g, v_nb, 2, true, 16);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000174');
  IF v_r ->> 'reason' IS DISTINCT FROM 'threshold_not_reached'
     OR (v_r -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM 17 THEN
    RAISE EXCEPTION 'FAIL 17: a Cluster of 17 across a live and a NULL-lifecycle board was not refused at 17: %', v_r;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 17: the refused Cluster opened % conversion(s) and is in %', v_n, (SELECT cluster_mode FROM public.cash_games WHERE id = v_g);
  END IF;
END $$;

-- 17d THE ORPHAN PATH ON A NULL-LIFECYCLE BOARD -------------------------------
-- This is the assertion that would have turned the defect into a 23502 rather
-- than a silent stranding, and it is the strongest single proof that the orphan
-- check is coalesced: the ONE player with no open cash session is on the board
-- the bare predicate drops. An orphan check that could not see them would find
-- nothing to refuse, the coalesced INSERT would then select them, and
-- lightning_pool_session.cash_player_session_id - NOT NULL - would raise 23502
-- and kill the whole transaction with a message about a column.
DO $$
DECLARE v_g uuid; v_nb uuid; v_r jsonb; v_c record; v_n integer; v_p uuid;
BEGIN
  v_g  := public.fx_cluster('nullorphan', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_nb := public.fx_board_without_lifecycle(v_g, 'nullorphan nb', 'feeder');
  PERFORM public.fx_seat_at(v_g, v_nb, 1, true, 19);
  SELECT ts.user_id INTO v_p FROM public.table_seats ts WHERE ts.table_id = v_nb;
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'harness'
   WHERE cluster_id = v_g AND player_id = v_p;
  -- STILL SEATED, STILL ELIGIBLE: an orphan, not a departure.
  IF public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 17: closing the cash session changed the eligible set to %', public.fx_eligible_coalesced(v_g);
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000174');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 17: begin refused: %', v_r; END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000174');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 17: an orphan on a NULL-lifecycle board did not abort the conversion cleanly - it answered %, and if that is a raise then the orphan check could not see the board the INSERT could and the whole transaction died on a NOT NULL violation', v_r;
  END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR v_c.abort_reason NOT LIKE '1 %'
     OR v_c.abort_reason NOT LIKE '%no open cash session%' THEN
    RAISE EXCEPTION 'FAIL 17: the abort reason does not COUNT the orphan on the NULL-lifecycle board: %', coalesce(v_c.abort_reason, '<null>');
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 17: the orphan abort left % board(s) halted and the Cluster in %', v_n, (SELECT cluster_mode FROM public.cash_games WHERE id = v_g);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 17: the orphan abort left % pool session(s) behind', v_n; END IF;

  -- NON-VACUITY: give that one player a session back and the identical pair of
  -- calls converts all nineteen, the NULL board included.
  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
  SELECT v_p, 'cb000000-0000-0000-0000-000000000001', 'cluster', v_g, ts.table_id, 'nlh', 1.00, 2.00, ts.stack, v_g, clock_timestamp()
    FROM public.table_seats ts WHERE ts.table_id = v_nb AND ts.user_id = v_p;
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000175');
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000175');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 19
     OR public.fx_stranded(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: with the session restored the identical conversion still failed, so the orphan refusal proved nothing: % with % stranded', v_r, public.fx_stranded(v_g);
  END IF;
END $$;

-- 17e THE ABORT PATH ON A NULL-LIFECYCLE BOARD --------------------------------
-- The halt is placed by a coalesced predicate and lifted by matching on the
-- reason, so the abort is symmetrical with the halt no matter what the
-- lifecycle says - and F04 says no player may be left stranded by an abort. A
-- board stopped by the conversion and not restarted by the abort is a board
-- nobody will ever deal at again.
DO $$
DECLARE v_g uuid; v_nb uuid; v_r jsonb; v_c record; v_n integer;
BEGIN
  v_g  := public.fx_cluster('nullabort', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_nb := public.fx_board_without_lifecycle(v_g, 'nullabort nb', 'feeder');
  PERFORM public.fx_seat_at(v_g, v_nb, 3, true, 19);

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000176');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: begin refused or halted the wrong number of boards: %', v_r;
  END IF;
  -- NON-VACUITY: the NULL board really is stopped before the abort is asked to
  -- restart it.
  IF (SELECT dealing_halted_at FROM public.tables WHERE id = v_nb) IS NULL THEN
    RAISE EXCEPTION 'FAIL 17: the NULL-lifecycle board was never halted, so lifting it proves nothing';
  END IF;

  v_r := public.fn_cash_cluster_abort_pending_on(v_g, 'a0000000-0000-0000-0000-000000000176', 'harness');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' OR (v_r ->> 'tables_resumed')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 17: the abort answered % - both boards, the NULL one included, had to resume', v_r;
  END IF;
  IF (SELECT dealing_halted_at IS NULL AND dealing_halted_reason IS NULL
        FROM public.tables WHERE id = v_nb) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 17: the abort left the NULL-lifecycle board halted, so it stopped a board it cannot restart';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 17: after the abort % board(s) are still halted and the Cluster is in %', v_n, (SELECT cluster_mode FROM public.cash_games WHERE id = v_g);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 17: the abort left % pool session(s) behind', v_n; END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR coalesce(v_c.abort_reason, '') IS DISTINCT FROM 'harness' THEN
    RAISE EXCEPTION 'FAIL 17: the aborted conversion record says % with reason %', v_c.status, coalesce(v_c.abort_reason, '<null>');
  END IF;
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 17: the abort moved the epoch';
  END IF;
END $$;
\echo '  ok  17 THE NULLABLE LIFECYCLE a board whose tables.lifecycle is NULL - which the column permits, because it is plain nullable text whose CHECK a NULL PASSES - is seen identically by every part of the conversion: the coalesced predicate counts two boards of the Cluster where the bare tb.lifecycle <> closed counts one, and against that Cluster of 18 plus 3 begin_pending_on halts BOTH boards, commit_lightning creates all 21 pool sessions at the new epoch, each of the three on the NULL board pointing at the open cluster-scoped cash session that player ALREADY had with the stack they are sitting behind, and this harness own stranding query - asked from the halted side, naming no lifecycle at all, and proved non-vacuous by answering 21 at the moment between the halt and the pool - answers ZERO, with no eligible player left at a board that is still dealing and both boards carrying the lightning halt; the identical Cluster with lifecycle live on that board converts identically, epoch for epoch and pool for pool, so what is proved is about the NULL; the orphan path on a NULL board aborts cleanly with a reason that COUNTS the one player rather than raising a NOT NULL violation out of cash_player_session_id, and converts all 19 once the session is restored; and the abort lifts the halt from the NULL board too, leaving no pool session, no halt and the epoch where it was - AND THE AUTHORISING NUMBER AGREES WITH ALL OF IT: fn_cash_cluster_live_eligible, re-cut by this migration onto the same membership predicate, answers 21 rather than the 18 the uncoalesced form answered, the conversion record carries 21 as its trigger_population so an operator reading it afterwards sees the pool that was actually created, a Cluster of 19 with 4 players on a NULL-lifecycle board converts on its own rather than being told threshold_not_reached at 15 for ever, and one of 17 across the same two boards is still refused at 17 so what is proved is that the four are counted rather than that the threshold stopped mattering'
ASSERT


cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 18 THE NULLABLE STATUS -------------------------------------------------------
-- tables.status is the WORSE sibling of section 17's nullable lifecycle, and it
-- is worse for one reason: when the excluding predicate is on BOTH the halt and
-- the player-set queries, every number the conversion computes still agrees.
--
-- public.tables.status is plain nullable text. In production it carries a CHECK
-- and in this fixture it carries none, which is if anything MORE permissive
-- than the estate - and the CHECK would not help anyway, because a CHECK that
-- evaluates to NULL PASSES, exactly as section 14 proves for
-- tables_dealing_halt_is_explained. So a board whose status nobody ever set
-- carries NULL, and `tb.status IN ('waiting', 'running', 'active')` against a
-- NULL evaluates to NULL, not to true. SQL takes NULL as not-true, so a filter
-- written that way SILENTLY DROPS THE BOARD.
--
-- WHY THE STRANDING ASSERTION COULD NOT SEE IT, AND SECTION 17 COULD NOT EITHER.
-- An earlier cut of this migration carried that predicate in the two halt
-- UPDATEs AND in the orphan check AND in the pool INSERT AND in the v_seated
-- census. A NULL-status board was therefore dropped by BOTH SIDES AT ONCE: it
-- was never halted, and its players were never counted. v_pool equalled
-- v_seated, trigger_population equalled the pool, the re-cut reader agreed with
-- all of them, and LIGHTNING_CONVERSION_STRANDED_A_PLAYER - which inspects only
-- boards that were HALTED - found nothing to complain about. The live probe
-- that found it: a Cluster of 21 converted, 18 entered the pool, and 3 players
-- kept being dealt cash at a board nobody stopped, inside a Cluster that was
-- now Lightning and held no pool session for them, with the tick and the
-- balancer stood down so that nothing would ever come for them.
--
-- THE FIX WAS NOT TO COALESCE IT. status is an engine-facing field that may be
-- NULL, may be 'paused', and may be a value somebody adds next year; it must
-- not decide who is in a Cluster. So the migration removed it from membership
-- ENTIRELY - one predicate everywhere, `coalesce(tb.is_deleted, false) = false
-- AND coalesce(tb.lifecycle, '') <> 'closed'`, in both halt UPDATEs, the orphan
-- check, the pool INSERT, the v_seated census, the hand-boundary query and the
-- re-cut fn_cash_cluster_live_eligible. Halting a paused board costs nothing.
-- Missing one costs a player.
--
-- SO THIS SECTION IS ASKED FROM THE UNHALTED SIDE, and 18a exists to make that
-- the ONLY thing it asks. Section 17's fx_unhalted_eligible cannot be reused
-- here: it names `tb.status IN ('waiting', 'running', 'active')` itself, so the
-- very board this section is about is invisible to it. Every query below names
-- no status at all.
--
-- AND THE OTHER HALF IS ESSENTIAL. A section that only proved status stopped
-- excluding boards would pass just as happily against a migration that had
-- stopped filtering membership altogether and halted every table in the
-- database. So a lifecycle = 'closed' board and an is_deleted = true board are
-- built alongside, each carrying a status of 'waiting' that the old predicate
-- would have ADMITTED, and each is proved to be excluded still: not halted, not
-- counted, not pooled.

CREATE FUNCTION public.fx_board_with_status(p_game uuid, p_name text, p_role text,
                                            p_status text)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid;
BEGIN
  v_tb := public.fx_table(p_game, p_name, p_role, NULL, 40);
  UPDATE public.tables SET status = p_status WHERE id = v_tb;
  IF (SELECT status FROM public.tables WHERE id = v_tb) IS DISTINCT FROM p_status THEN
    RAISE EXCEPTION 'FIXTURE: table % would not take a status of %, so section 18 cannot be built at all', v_tb, coalesce(p_status, '<null>');
  END IF;
  RETURN v_tb;
END $fx$;

-- A BOARD THAT REALLY IS OUT OF THE CLUSTER, AND OUT FOR A REASON THAT IS NOT
-- status. Its status is left at 'waiting' - a value the discarded predicate
-- ADMITTED - so when it is proved excluded, the exclusion is attributable to
-- lifecycle or is_deleted and to nothing else.
CREATE FUNCTION public.fx_board_excluded(p_game uuid, p_name text, p_how text)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid; v_ok boolean;
BEGIN
  v_tb := public.fx_table(p_game, p_name, 'feeder', NULL, 40);
  IF p_how = 'closed' THEN
    UPDATE public.tables SET lifecycle = 'closed' WHERE id = v_tb;
  ELSIF p_how = 'deleted' THEN
    UPDATE public.tables SET is_deleted = true WHERE id = v_tb;
  ELSE
    RAISE EXCEPTION 'FIXTURE: fx_board_excluded does not know how to exclude a board by %', p_how;
  END IF;
  SELECT (CASE WHEN p_how = 'closed' THEN tb.lifecycle = 'closed' ELSE tb.is_deleted END)
         AND tb.status = 'waiting'
    INTO v_ok FROM public.tables tb WHERE tb.id = v_tb;
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the % board % is not excluded the way section 18 needs it, or its status is not the waiting the old predicate admitted', p_how, v_tb;
  END IF;
  RETURN v_tb;
END $fx$;

-- THE MEMBERSHIP PREDICATE, WRITTEN OUT ONCE AND NAMING NO status. Everything
-- below asks with this and only this, so a status filter put back into the
-- migration cannot narrow the question the same way it narrows the answer.
CREATE FUNCTION public.fx_member_boards_dealing(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT count(*)::integer FROM public.tables tb
   WHERE tb.cluster_id = p_game
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND tb.dealing_halted_at IS NULL;
$fx$;

CREATE FUNCTION public.fx_member_dealing(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- THE QUESTION THE OLD DEFECT COULD NOT BE ASKED. Eligible players of this
  -- Cluster who are seated at a board that is STILL DEALING. After a
  -- conversion it must be zero, and no predicate that wrongly narrows both
  -- sides together can make it zero, because it is not compared to anything.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND tb.dealing_halted_at IS NULL
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;
$fx$;

CREATE FUNCTION public.fx_unpooled(p_game uuid, p_epoch integer) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- The third angle: an eligible player of a member board with no open pool
  -- session at the epoch this conversion created. It mentions neither status
  -- nor the halt, so it is blind to both mistakes and can only be satisfied by
  -- the conversion having actually taken everybody.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                      WHERE s.cluster_id = p_game AND s.player_id = ts.user_id
                        AND s.cluster_epoch = p_epoch AND s.exited_at IS NULL);
$fx$;

CREATE FUNCTION public.fx_eligible_statusblind(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  -- The membership predicate the migration now uses, and section 17's
  -- fx_eligible_coalesced is the SAME query with the status filter still on it,
  -- so the pair measures exactly what status costs.
  SELECT count(DISTINCT ts.user_id)::integer
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;
$fx$;

-- BUILDS THE SHAPE THE OLD DEFECT COMMITTED SILENTLY OVER: eighteen eligible
-- players on a status 'waiting' board - which is the six-max ON threshold ALL
-- BY ITSELF - plus three on a board whose status is NULL and three on a board
-- whose status is 'paused', plus two on a closed board and two on a deleted one
-- that must stay out. Returns the Cluster; the caller names the boards again
-- through board_x when it needs them.
CREATE TEMP TABLE board_x (k text PRIMARY KEY, nb uuid, pb uuid, cb uuid, db uuid);
CREATE FUNCTION public.fx_status_cluster(p_key text, p_main integer DEFAULT 18)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_g uuid; v_nb uuid; v_pb uuid; v_cb uuid; v_db uuid;
BEGIN
  v_g  := public.fx_cluster(p_key, 6, 40);
  PERFORM public.fx_seat(v_g, p_main);
  v_nb := public.fx_board_with_status(v_g, p_key || ' nb', 'feeder', NULL);
  PERFORM public.fx_seat_at(v_g, v_nb, 3, true, p_main + 1);
  v_pb := public.fx_board_with_status(v_g, p_key || ' pb', 'feeder', 'paused');
  PERFORM public.fx_seat_at(v_g, v_pb, 3, true, p_main + 4);
  v_cb := public.fx_board_excluded(v_g, p_key || ' cb', 'closed');
  PERFORM public.fx_seat_at(v_g, v_cb, 2, true, p_main + 7);
  v_db := public.fx_board_excluded(v_g, p_key || ' db', 'deleted');
  PERFORM public.fx_seat_at(v_g, v_db, 2, true, p_main + 9);
  INSERT INTO board_x (k, nb, pb, cb, db) VALUES (p_key, v_nb, v_pb, v_cb, v_db);
  RETURN v_g;
END $fx$;

-- 18a THE COUNTS ALL AGREE AND IT IS STILL WRONG ------------------------------
-- This block asserts NO absolute number until it has finished asking from the
-- unhalted side, and it never asserts how many boards begin_pending_on stopped.
-- It asserts only that the conversion's own numbers agree with each other -
-- which they do under the defect, at 18, exactly as they do under the fix, at
-- 24 - and then asks the three questions a narrowing predicate cannot answer.
-- A red run here is therefore a red run that no count, no census and no
-- self-consistency check anywhere in the migration could have produced.
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_epoch integer; v_agree integer;
  v_n integer; v_m integer; v_live integer; v_trig integer; v_bad text;
BEGIN
  v_g := public.fx_status_cluster('statusquiet', 18);

  -- NON-VACUITY, BEFORE ANYTHING IS HALTED: three member boards of this Cluster
  -- are dealing and twenty-four eligible players are sitting at them. A query
  -- that can only ever answer zero is not an assertion.
  IF public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 3
     OR public.fx_member_dealing(v_g) IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: before the conversion the Cluster shows % dealing member board(s) and % player(s) at them rather than 3 and 24, so the unhalted-side questions below prove nothing', public.fx_member_boards_dealing(v_g), public.fx_member_dealing(v_g);
  END IF;

  -- AND THE TRAP, MEASURED RATHER THAN DESCRIBED. The discarded predicate sees
  -- EIGHTEEN of the twenty-four, and eighteen is the six-max ON threshold
  -- exactly - so a conversion run under it is authorised, commits, and agrees
  -- with itself all the way down. That is what makes this the dangerous shape
  -- and not merely a wrong number.
  IF public.fx_eligible_statusblind(v_g) IS DISTINCT FROM 24
     OR public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 18: the Cluster is not the eighteen-plus-six the trap needs - status-blind it holds % eligible players and with the status filter on it holds %', public.fx_eligible_statusblind(v_g), public.fx_eligible_coalesced(v_g);
  END IF;
  IF (public.fn_cash_cluster_lightning_state(v_g) -> 'thresholds' ->> 'on')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 18: the six-max ON threshold is % rather than 18, so the narrowed population is not at the threshold and the defect would refuse rather than commit silently', (public.fn_cash_cluster_lightning_state(v_g) -> 'thresholds' ->> 'on')::integer;
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000180');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 18: begin_pending_on answered % - the Cluster holds 24 eligible players over an ON threshold of 18 and 18 of them are on a board the discarded predicate admitted, so it must reach pending_on under the fix AND under the defect', v_r;
  END IF;
  IF public.fx_unpooled(v_g, (SELECT cluster_epoch + 1 FROM public.cash_games WHERE id = v_g)) IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: between the halt and the pool the unpooled count is % rather than 24, so the zero it reports after the commit would mean nothing', public.fx_unpooled(v_g, (SELECT cluster_epoch + 1 FROM public.cash_games WHERE id = v_g));
  END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000180');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 18: the Cluster did not convert: %', v_r;
  END IF;
  v_epoch := (v_r ->> 'epoch_after')::integer;
  v_agree := (v_r ->> 'pool_sessions')::integer;

  -- EVERY NUMBER THE CONVERSION KNOWS ABOUT AGREES WITH EVERY OTHER, and this
  -- assertion is written WITHOUT a constant on purpose: it passes at 24 under
  -- the fix and it passed at 18 under the defect. It is here to record that
  -- self-consistency is not evidence.
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session
   WHERE cluster_id = v_g AND cluster_epoch = v_epoch AND exited_at IS NULL;
  SELECT count(DISTINCT player_id)::integer INTO v_m FROM public.lightning_pool_session
   WHERE cluster_id = v_g;
  SELECT trigger_population INTO v_trig FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  v_live := public.fn_cash_cluster_live_eligible(v_g);
  IF v_n IS DISTINCT FROM v_agree OR v_m IS DISTINCT FROM v_agree
     OR v_trig IS DISTINCT FROM v_agree OR v_live IS DISTINCT FROM v_agree THEN
    RAISE EXCEPTION 'FAIL 18: the conversion answered % pool session(s), the estate holds % at epoch % over % distinct player(s), the record says trigger_population % and fn_cash_cluster_live_eligible says % - they must all be the same number whatever that number is', v_agree, v_n, v_epoch, v_m, v_trig, v_live;
  END IF;

  -- AND THE ASSERTION THAT CANNOT SEE IT, ASSERTED ANYWAY so the contrast is on
  -- the record. fx_stranded asks from the HALTED side, which is where section
  -- 17 had to ask, and under a predicate that narrows BOTH sides it answers
  -- zero while six people are still being dealt cards.
  IF public.fx_stranded(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: % player(s) are seated at a HALTED board of a Cluster that is now lightning with no pool session', public.fx_stranded(v_g);
  END IF;

  -- THE THREE QUESTIONS A NARROWING PREDICATE CANNOT ANSWER. First: is any
  -- member board of a Lightning Cluster still dealing.
  IF public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 0 THEN
    SELECT string_agg(tb.name || ' [status ' || coalesce(tb.status, 'NULL') || ']', ', ' ORDER BY tb.name) INTO v_bad
      FROM public.tables tb
     WHERE tb.cluster_id = v_g AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed' AND tb.dealing_halted_at IS NULL;
    RAISE EXCEPTION 'FAIL 18: THE CLUSTER IS LIGHTNING AND % OF ITS BOARDS ARE STILL DEALING: %. Not one number this conversion computed disagreed with another - the pool, the distinct players, the conversion record and the threshold reader all said % - because a predicate that excludes a board narrows the halt and the player-set queries alike, and the halted-side stranding check only ever inspects boards that were stopped. A board is in a Cluster or it is not; tables.status may be NULL, may be paused and may be a value added next year, and it must not decide',
      public.fx_member_boards_dealing(v_g), coalesce(v_bad, '<unnamed>'), v_agree;
  END IF;

  -- Second: is any eligible player of this Cluster still being dealt to.
  IF public.fx_member_dealing(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: % ELIGIBLE PLAYER(S) ARE STILL BEING DEALT CASH at a board nobody stopped, inside a Cluster that is now lightning - and the tick and the balancer have stood down, so nothing will ever come for them', public.fx_member_dealing(v_g);
  END IF;

  -- Third: did every one of them get a pool session, asked without mentioning
  -- the halt at all.
  IF public.fx_unpooled(v_g, v_epoch) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: % eligible player(s) of the converted Cluster hold no open pool session at epoch %', public.fx_unpooled(v_g, v_epoch), v_epoch;
  END IF;

  -- ONLY NOW THE ABSOLUTE NUMBER, so that a mutated run reports the stranding
  -- rather than a count that differs.
  IF v_agree IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: the Cluster converted % players rather than the 24 it holds', v_agree;
  END IF;
END $$;
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 18b THE WHOLE AUDIT, AND THE EXCLUSIONS THAT MUST SURVIVE IT ----------------
-- Everything 18a deliberately did not assert: how many boards were stopped,
-- which ones, what each player got, and - the half without which this section
-- would pass against a migration that had stopped filtering membership
-- altogether - that a closed board and a deleted board are STILL out, each of
-- them carrying the status 'waiting' that the discarded predicate admitted.
DO $$
DECLARE
  v_g uuid; v_ctl uuid; v_nb uuid; v_pb uuid; v_cb uuid; v_db uuid;
  v_cnb uuid; v_cpb uuid; v_r jsonb; v_epoch integer; v_ctl_epoch integer;
  v_n integer; v_m integer;
BEGIN
  v_g := public.fx_status_cluster('statusaudit', 18);
  SELECT nb, pb, cb, db INTO v_nb, v_pb, v_cb, v_db FROM board_x WHERE k = 'statusaudit';

  -- THE COLUMN REALLY TOOK THE NULL AND REALLY TOOK THE 'paused'. fx_board_with_status
  -- raises if it did not, and it is re-read here from the estate rather than
  -- believed, because every claim below is about those two values.
  IF (SELECT status FROM public.tables WHERE id = v_nb) IS NOT NULL
     OR (SELECT status FROM public.tables WHERE id = v_pb) IS DISTINCT FROM 'paused'
     OR (SELECT status FROM public.tables WHERE id = v_cb) IS DISTINCT FROM 'waiting'
     OR (SELECT status FROM public.tables WHERE id = v_db) IS DISTINCT FROM 'waiting' THEN
    RAISE EXCEPTION 'FAIL 18: the four extra boards do not carry NULL, paused, waiting and waiting, so nothing below is about three-valued logic or about exclusion';
  END IF;

  -- THE AUTHORISING NUMBER SEES ALL TWENTY-FOUR. fn_cash_cluster_live_eligible
  -- is what decides whether a Cluster may convert at all, and Phase 5 re-cut it
  -- onto the same membership predicate for that reason: a board whose status is
  -- NULL or 'paused' cannot hide six players from the threshold.
  IF public.fn_cash_cluster_live_eligible(v_g) IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: fn_cash_cluster_live_eligible answered % on a Cluster of 24 with 3 on a NULL-status board, 3 on a paused one and 4 more on a closed and a deleted board that must NOT be counted. It must answer 24', public.fn_cash_cluster_live_eligible(v_g);
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000181');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: begin_pending_on answered % - it must reach pending_on and stop exactly THREE boards: the waiting one, the one whose status is NULL and the paused one. A halt that reads status leaves a board dealing under a Cluster that has stopped deciding', v_r;
  END IF;
  IF (SELECT dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning_pending_on'
        FROM public.tables WHERE id = v_nb) IS DISTINCT FROM true
     OR (SELECT dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning_pending_on'
        FROM public.tables WHERE id = v_pb) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 18: the NULL-status board or the paused one was NOT halted by begin_pending_on';
  END IF;
  -- AND THE EXCLUDED BOARDS WERE LEFT ALONE, which is what makes the halt a
  -- membership decision rather than a blanket one.
  IF (SELECT count(*)::integer FROM public.tables
       WHERE id IN (v_cb, v_db) AND dealing_halted_at IS NULL) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 18: the conversion halted the closed board or the deleted one, so membership has stopped being filtered rather than stopped reading status';
  END IF;

  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000181');
  v_epoch := (v_r ->> 'epoch_after')::integer;
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: the Cluster of 24 across a waiting, a NULL-status and a paused board answered %', v_r;
  END IF;
  IF public.fx_stranded(v_g) IS DISTINCT FROM 0
     OR public.fx_member_dealing(v_g) IS DISTINCT FROM 0
     OR public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 0
     OR public.fx_unpooled(v_g, v_epoch) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: after the conversion % player(s) sit at a halted board with no pool session, % sit at a board still dealing across % such board(s), and % hold no pool session at epoch %',
      public.fx_stranded(v_g), public.fx_member_dealing(v_g), public.fx_member_boards_dealing(v_g), public.fx_unpooled(v_g, v_epoch), v_epoch;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables
   WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL AND dealing_halted_reason = 'lightning';
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: % board(s) of the converted Cluster carry the lightning halt rather than 3', v_n;
  END IF;

  -- EVERY PLAYER ON THE NULL-STATUS BOARD AND EVERY PLAYER ON THE PAUSED ONE IS
  -- SUBORDINATE TO THE CASH SESSION THEY ALREADY HAD: same player, same
  -- Cluster, still open, at the NEW epoch, with the stack they are sitting
  -- behind. Six players, three from each board, counted separately so a message
  -- names which board failed.
  SELECT count(*)::integer INTO v_n FROM public.table_seats ts
   WHERE ts.table_id = v_nb AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.lightning_pool_session s
                   JOIN public.cash_player_session c ON c.id = s.cash_player_session_id
                  WHERE s.cluster_id = v_g AND s.player_id = ts.user_id
                    AND s.cluster_epoch = v_epoch AND s.state = 'active'
                    AND s.exited_at IS NULL AND s.starting_stack = ts.stack
                    AND c.player_id = ts.user_id AND c.cluster_id = v_g AND c.closed_at IS NULL);
  SELECT count(*)::integer INTO v_m FROM public.table_seats ts
   WHERE ts.table_id = v_pb AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.lightning_pool_session s
                   JOIN public.cash_player_session c ON c.id = s.cash_player_session_id
                  WHERE s.cluster_id = v_g AND s.player_id = ts.user_id
                    AND s.cluster_epoch = v_epoch AND s.state = 'active'
                    AND s.exited_at IS NULL AND s.starting_stack = ts.stack
                    AND c.player_id = ts.user_id AND c.cluster_id = v_g AND c.closed_at IS NULL);
  IF v_n IS DISTINCT FROM 3 OR v_m IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: % of the 3 on the NULL-status board and % of the 3 on the paused board hold a pool session at epoch % pointing at the open cluster-scoped cash session they already had', v_n, v_m, v_epoch;
  END IF;

  -- THE EXCLUSION HALF. The four players on the closed board and the deleted
  -- one were never counted, never halted and must hold no pool session at all -
  -- otherwise this section would be passing on a migration that had simply
  -- stopped filtering.
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session s
   WHERE s.cluster_id = v_g
     AND s.player_id IN (SELECT ts.user_id FROM public.table_seats ts WHERE ts.table_id IN (v_cb, v_db));
  SELECT count(*)::integer INTO v_m FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 OR v_m IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: % of the 4 players on the closed and deleted boards entered the pool and the Cluster holds % pool session(s) rather than 24. Removing status from membership must not have removed membership', v_n, v_m;
  END IF;
  SELECT trigger_population INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: the conversion record recorded a trigger_population of % over a pool of 24, and that number is what an operator reads afterwards to understand what happened', v_n;
  END IF;

  -- 18b CONTROL: THE SAME SHAPE WITH status 'waiting' ON BOTH EXTRA BOARDS.
  -- Identical in every respect, or what is proved above is about a Cluster with
  -- five boards rather than about a NULL and a 'paused'.
  v_ctl := public.fx_cluster('statuscontrol', 6, 40);
  PERFORM public.fx_seat(v_ctl, 18);
  v_cnb := public.fx_board_with_status(v_ctl, 'statuscontrol nb', 'feeder', 'waiting');
  PERFORM public.fx_seat_at(v_ctl, v_cnb, 3, true, 19);
  v_cpb := public.fx_board_with_status(v_ctl, 'statuscontrol pb', 'feeder', 'running');
  PERFORM public.fx_seat_at(v_ctl, v_cpb, 3, true, 22);
  PERFORM public.fx_seat_at(v_ctl, public.fx_board_excluded(v_ctl, 'statuscontrol cb', 'closed'), 2, true, 25);
  PERFORM public.fx_seat_at(v_ctl, public.fx_board_excluded(v_ctl, 'statuscontrol db', 'deleted'), 2, true, 27);
  IF public.fx_eligible_coalesced(v_ctl) IS DISTINCT FROM 24
     OR public.fn_cash_cluster_live_eligible(v_ctl) IS DISTINCT FROM 24 THEN
    RAISE EXCEPTION 'FAIL 18: the control Cluster is not the same 24 with every status inside the discarded vocabulary - the old predicate counts % and the reader says %', public.fx_eligible_coalesced(v_ctl), public.fn_cash_cluster_live_eligible(v_ctl);
  END IF;
  v_r := public.fn_cash_cluster_begin_pending_on(v_ctl, 'a0000000-0000-0000-0000-000000000182');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: the control answered % to begin_pending_on', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_ctl, 'a0000000-0000-0000-0000-000000000182');
  v_ctl_epoch := (v_r ->> 'epoch_after')::integer;
  SELECT trigger_population INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_ctl;
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 24
     OR v_ctl_epoch IS DISTINCT FROM v_epoch
     OR v_n IS DISTINCT FROM 24
     OR public.fx_member_dealing(v_ctl) IS DISTINCT FROM 0
     OR public.fx_unpooled(v_ctl, v_ctl_epoch) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: the all-waiting control did NOT behave as the NULL-and-paused Cluster did: % with trigger_population %, % still dealing and % unpooled', v_r, v_n, public.fx_member_dealing(v_ctl), public.fx_unpooled(v_ctl, v_ctl_epoch);
  END IF;
END $$;

-- 18c THE AUTHORISING NUMBER: status MUST NOT HIDE A PLAYER FROM THE THRESHOLD -
-- Nineteen eligible players, four of them split across a NULL-status board and
-- a paused one. The conversion is authorised by fn_cash_cluster_live_eligible,
-- and before it was re-cut that reader could see fifteen - so the Cluster was
-- told it was below the ON threshold of eighteen and stayed in must_move for
-- ever, however many people were playing. Non-vacuous from the other side: the
-- same two boards holding one player fewer each is SIXTEEN and is still refused.
DO $$
DECLARE v_g uuid; v_nb uuid; v_pb uuid; v_r jsonb; v_n integer;
BEGIN
  v_g  := public.fx_cluster('statusthresh', 6, 40);
  PERFORM public.fx_seat(v_g, 15);
  v_nb := public.fx_board_with_status(v_g, 'statusthresh nb', 'feeder', NULL);
  PERFORM public.fx_seat_at(v_g, v_nb, 2, true, 16);
  v_pb := public.fx_board_with_status(v_g, 'statusthresh pb', 'feeder', 'paused');
  PERFORM public.fx_seat_at(v_g, v_pb, 2, true, 18);
  IF public.fx_eligible_statusblind(v_g) IS DISTINCT FROM 19
     OR public.fx_eligible_coalesced(v_g) IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'FAIL 18: the threshold Cluster holds % status-blind and % with the status filter on, rather than 19 and 15', public.fx_eligible_statusblind(v_g), public.fx_eligible_coalesced(v_g);
  END IF;
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000183');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'trigger_population')::integer IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 18: a Cluster of 19 with 2 on a NULL-status board and 2 on a paused one answered % to begin_pending_on. It must reach PENDING_ON at a trigger_population of 19: an engine-facing field that may be NULL or paused cannot be allowed to decide that four people are not playing', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000183');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 19
     OR public.fx_member_dealing(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: the NULL-status threshold Cluster did not convert all 19: % with % still being dealt to', v_r, public.fx_member_dealing(v_g);
  END IF;

  -- NON-VACUITY, FROM THE OTHER SIDE: fifteen plus one plus one is SIXTEEN and
  -- must still be refused, so what is proved above is that the four are counted
  -- and not that the threshold stopped mattering.
  v_g  := public.fx_cluster('statusthresh2', 6, 40);
  PERFORM public.fx_seat(v_g, 14);
  v_nb := public.fx_board_with_status(v_g, 'statusthresh2 nb', 'feeder', NULL);
  PERFORM public.fx_seat_at(v_g, v_nb, 1, true, 15);
  v_pb := public.fx_board_with_status(v_g, 'statusthresh2 pb', 'feeder', 'paused');
  PERFORM public.fx_seat_at(v_g, v_pb, 1, true, 16);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000184');
  IF v_r ->> 'reason' IS DISTINCT FROM 'threshold_not_reached'
     OR (v_r -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM 16 THEN
    RAISE EXCEPTION 'FAIL 18: a Cluster of 16 across a waiting, a NULL-status and a paused board was not refused at 16: %', v_r;
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move'
     OR public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: the refused Cluster opened % conversion(s), is in % and has % board(s) still dealing rather than all 3', v_n, (SELECT cluster_mode FROM public.cash_games WHERE id = v_g), public.fx_member_boards_dealing(v_g);
  END IF;
END $$;
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 18d THE ORPHAN PATH ON A NULL-STATUS BOARD ----------------------------------
-- The strongest single proof that the orphan check and the pool INSERT read the
-- same membership: the ONE player with no open cash session is on the board the
-- discarded predicate dropped. An orphan check that could not see that board
-- would find nothing to refuse, the INSERT would then select the player anyway,
-- and lightning_pool_session.cash_player_session_id - NOT NULL - would raise
-- 23502 and kill the whole transaction with a message about a column.
DO $$
DECLARE v_g uuid; v_nb uuid; v_r jsonb; v_c record; v_n integer; v_p uuid;
BEGIN
  v_g  := public.fx_cluster('statusorphan', 6, 40);
  PERFORM public.fx_seat(v_g, 18);
  v_nb := public.fx_board_with_status(v_g, 'statusorphan nb', 'feeder', NULL);
  PERFORM public.fx_seat_at(v_g, v_nb, 1, true, 19);
  SELECT ts.user_id INTO v_p FROM public.table_seats ts WHERE ts.table_id = v_nb;
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'harness'
   WHERE cluster_id = v_g AND player_id = v_p;
  -- STILL SEATED, STILL ELIGIBLE: an orphan, not a departure.
  IF public.fx_eligible_statusblind(v_g) IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 18: closing the cash session changed the eligible set to %', public.fx_eligible_statusblind(v_g);
  END IF;

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000185');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on' THEN RAISE EXCEPTION 'FAIL 18: begin refused: %', v_r; END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000185');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 18: an orphan on a NULL-status board did not abort the conversion cleanly - it answered %, and if that is a raise then the orphan check could not see the board the INSERT could and the whole transaction died on a NOT NULL violation', v_r;
  END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR v_c.abort_reason NOT LIKE '1 %'
     OR v_c.abort_reason NOT LIKE '%no open cash session%' THEN
    RAISE EXCEPTION 'FAIL 18: the abort reason does not COUNT the orphan on the NULL-status board: %', coalesce(v_c.abort_reason, '<null>');
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move'
     OR public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 18: the orphan abort left % board(s) halted with the Cluster in % and only % of the 2 member boards dealing again', v_n, (SELECT cluster_mode FROM public.cash_games WHERE id = v_g), public.fx_member_boards_dealing(v_g);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 18: the orphan abort left % pool session(s) behind', v_n; END IF;

  -- NON-VACUITY: give that one player a session back and the identical pair of
  -- calls converts all nineteen, the NULL-status board included.
  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
  SELECT v_p, 'cb000000-0000-0000-0000-000000000001', 'cluster', v_g, ts.table_id, 'nlh', 1.00, 2.00, ts.stack, v_g, clock_timestamp()
    FROM public.table_seats ts WHERE ts.table_id = v_nb AND ts.user_id = v_p;
  PERFORM public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000186');
  v_r := public.fn_cash_cluster_commit_lightning(v_g, 'a0000000-0000-0000-0000-000000000186');
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning'
     OR (v_r ->> 'pool_sessions')::integer IS DISTINCT FROM 19
     OR public.fx_member_dealing(v_g) IS DISTINCT FROM 0
     OR public.fx_unpooled(v_g, (v_r ->> 'epoch_after')::integer) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: with the session restored the identical conversion still failed, so the orphan refusal proved nothing: % with % still dealing', v_r, public.fx_member_dealing(v_g);
  END IF;
END $$;

-- 18e THE ABORT PATH ON A NULL-STATUS AND A PAUSED BOARD ----------------------
-- The halt is placed by a membership predicate and lifted by matching on the
-- reason, so the abort is symmetrical with the halt whatever the status says.
-- F04 is the point: a board this conversion stopped and the abort did not
-- restart is a board nobody will ever deal at again, and a paused board is
-- exactly the one an abort would have been most likely to forget.
DO $$
DECLARE v_g uuid; v_nb uuid; v_pb uuid; v_r jsonb; v_c record; v_n integer;
BEGIN
  v_g := public.fx_status_cluster('statusabort', 18);
  SELECT nb, pb INTO v_nb, v_pb FROM board_x WHERE k = 'statusabort';

  v_r := public.fn_cash_cluster_begin_pending_on(v_g, 'a0000000-0000-0000-0000-000000000187');
  IF v_r ->> 'reason' IS DISTINCT FROM 'pending_on'
     OR (v_r ->> 'tables_halted')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: begin refused or halted the wrong number of boards: %', v_r;
  END IF;
  -- NON-VACUITY: both boards really are stopped before the abort is asked to
  -- restart them.
  IF (SELECT count(*)::integer FROM public.tables
       WHERE id IN (v_nb, v_pb) AND dealing_halted_at IS NOT NULL) IS DISTINCT FROM 2
     OR public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: the NULL-status board or the paused one was never halted, so lifting it proves nothing';
  END IF;

  v_r := public.fn_cash_cluster_abort_pending_on(v_g, 'a0000000-0000-0000-0000-000000000187', 'harness');
  IF v_r ->> 'reason' IS DISTINCT FROM 'aborted' OR (v_r ->> 'tables_resumed')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 18: the abort answered % - all three boards, the NULL-status one and the paused one included, had to resume', v_r;
  END IF;
  IF (SELECT count(*)::integer FROM public.tables
       WHERE id IN (v_nb, v_pb) AND dealing_halted_at IS NULL AND dealing_halted_reason IS NULL) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 18: the abort left the NULL-status board or the paused one halted, so it stopped a board it cannot restart';
  END IF;
  IF public.fx_member_boards_dealing(v_g) IS DISTINCT FROM 3
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 18: after the abort only % of the 3 member boards are dealing and the Cluster is in %', public.fx_member_boards_dealing(v_g), (SELECT cluster_mode FROM public.cash_games WHERE id = v_g);
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_pool_session WHERE cluster_id = v_g;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FAIL 18: the abort left % pool session(s) behind', v_n; END IF;
  SELECT * INTO v_c FROM public.cash_cluster_conversion WHERE cluster_id = v_g;
  IF v_c.status IS DISTINCT FROM 'aborted' OR coalesce(v_c.abort_reason, '') IS DISTINCT FROM 'harness' THEN
    RAISE EXCEPTION 'FAIL 18: the aborted conversion record says % with reason %', v_c.status, coalesce(v_c.abort_reason, '<null>');
  END IF;
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 18: the abort moved the epoch';
  END IF;
END $$;
\echo '  ok  18 THE NULLABLE STATUS   a board whose tables.status is NULL - which the column permits, and which no CHECK can forbid because a CHECK that evaluates to NULL PASSES - is in the Cluster exactly as a waiting board is, and so is one whose status is paused: against a Cluster of 24 built as 18 on a waiting board plus 3 on a NULL-status board plus 3 on a paused one, with 4 more on a closed board and a deleted board that must stay out, begin_pending_on halts exactly THREE boards and leaves the closed and the deleted ones alone, commit_lightning creates all 24 pool sessions at the new epoch, and each of the six on the NULL-status and paused boards points at the open cluster-scoped cash session that player ALREADY had with the stack they are sitting behind, while not one of the four excluded players enters the pool and the Cluster holds 24 sessions rather than 28 - so what is proved is that status stopped deciding membership and NOT that membership stopped being filtered; the whole section is asked from the UNHALTED side, because that is the one direction the old defect could not be seen from - a separate Cluster of the same shape is converted with no assertion at all about how many boards were stopped, its pool count, its distinct players, its trigger_population and fn_cash_cluster_live_eligible are asserted only to EQUAL ONE ANOTHER, which they did at 18 under the defect exactly as they do at 24 under the fix, and the three questions that follow name no status at all: no member board of a lightning Cluster is still dealing, no eligible player of it is still being dealt cash, and nobody on a member board is without a pool session at the new epoch, each proved non-vacuous at 3, 24 and 24 before the conversion; the identical Cluster with waiting and running on those two boards converts identically, epoch for epoch, pool for pool and record for record, so what is proved is about the NULL and the paused; a Cluster of 19 with 2 on a NULL-status board and 2 on a paused one reaches PENDING_ON at a trigger_population of 19 rather than being told threshold_not_reached at 15 for ever, while one of 16 across the same three boards is still refused at 16 with all three boards left dealing; the orphan path on a NULL-status board aborts cleanly with a reason that COUNTS the one player rather than raising a NOT NULL violation out of cash_player_session_id, and converts all 19 once the session is restored; and the abort lifts the halt from the NULL-status board and the paused one too, leaving all three boards dealing, no pool session and the epoch where it was'
ASSERT
cat >> "$fixture/assertions.sql" <<'ASSERT'

-- WHAT THE SECOND APPLICATION AND THE @live-proof BLOCK NEED PUT BACK ----------
--
-- THIS TEARDOWN IS A FINDING, NOT A CONVENIENCE, AND IT IS WRITTEN DOWN HERE
-- RATHER THAN HIDDEN IN A DELETE. Section 8 of the migration asserts that the
-- estate is exactly as it was: no Cluster outside must_move, no Cluster off
-- epoch 0, no halted table, no pool session, no conversion record and no
-- lightning_enabled Cluster. Every one of those is true of the estate on the
-- day of the apply and FALSE of any estate that has since converted anything,
-- so the file is re-appliable over a pristine estate and is refused by its own
-- assertions over a converted one. Eight of the migration's own @live-proof
-- lines say the same things and would be false for the same reason.
--
-- So the estate is returned to the shape the migration was written against,
-- and the second application is a test of the SUBSTITUTIONS being idempotent -
-- which is what a re-apply of this file actually risks - rather than a test of
-- an estate assertion that was never meant to survive a conversion.
DO $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.lightning_pool_session;
  DELETE FROM public.cash_cluster_conversion;
  DELETE FROM public.engine_maintenance_break;
  UPDATE public.tables SET dealing_halted_at = NULL, dealing_halted_reason = NULL
   WHERE dealing_halted_at IS NOT NULL OR dealing_halted_reason IS NOT NULL;
  -- THE EPOCH ONLY EVER GOES FORWARD, and the trigger that enforces that is
  -- right. Winding it back is something only a harness may do, so it is done
  -- with the triggers explicitly off and turned straight back on, rather than
  -- by weakening the guard that protects the estate.
  ALTER TABLE public.cash_games DISABLE TRIGGER USER;
  UPDATE public.cash_games SET cluster_mode = 'must_move', cluster_epoch = 0,
         lightning_enabled = false, must_move = true;
  ALTER TABLE public.cash_games ENABLE TRIGGER USER;
  DELETE FROM public.cash_cluster_epoch WHERE epoch <> 0;
  UPDATE public.cash_cluster_epoch SET ended_at = NULL, mode = 'must_move', started_by = 'genesis';
  -- NO CLUSTER MAY BE OVER ITS ON THRESHOLD EITHER: nothing in the migration
  -- says so, but a re-apply that found one would be reading an estate this
  -- file invented rather than the one the migration was measured against.
  DELETE FROM public.table_seats ts USING public.tables tb
   WHERE tb.id = ts.table_id AND ts.seat_number > 4;

  SELECT count(*)::integer INTO v_n FROM public.cash_games WHERE cluster_mode <> 'must_move' OR cluster_epoch <> 0 OR lightning_enabled;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'TEARDOWN: % cluster(s) are still converted', v_n; END IF;
  SELECT count(*)::integer INTO v_n FROM public.tables WHERE dealing_halted_at IS NOT NULL OR dealing_halted_reason IS NOT NULL;
  IF v_n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'TEARDOWN: % table(s) are still halted', v_n; END IF;
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_epoch WHERE ended_at IS NULL GROUP BY cluster_id HAVING count(*) > 1 LIMIT 1;
  IF v_n IS NOT NULL THEN RAISE EXCEPTION 'TEARDOWN: a Cluster has more than one open epoch row'; END IF;
END $$;

-- AND THE ESTATE, AS IT NOW STANDS, IS CAPTURED FOR THE RE-APPLY. A TEMP table
-- in this backend, because the second application lands in this backend too.
CREATE TEMP TABLE before_reapply AS
SELECT p.proname,
       pg_get_functiondef(p.oid) AS def,
       array_to_string(p.proacl, ',') AS acl,
       obj_description(p.oid, 'pg_proc') AS comment
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('fn_cash_cluster_tick', 'fn_cash_cluster_balance',
                     'fn_cash_cluster_begin_pending_on', 'fn_cash_cluster_abort_pending_on',
                     'fn_cash_cluster_commit_lightning');

CREATE TEMP TABLE before_rows AS
SELECT (SELECT md5(string_agg(g::text, '|' ORDER BY g.id)) FROM public.cash_games g)   AS games,
       (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM public.tables t)       AS tables,
       (SELECT md5(string_agg(s::text, '|' ORDER BY s.id)) FROM public.table_seats s)  AS seats,
       (SELECT md5(string_agg(e::text, '|' ORDER BY e.cluster_id, e.epoch)) FROM public.cash_cluster_epoch e) AS epochs;

CREATE TEMP TABLE before_answers AS
SELECT g.id,
       public.fn_cash_cluster_lightning_state(g.id) AS state,
       public.fn_cash_cluster_live_eligible(g.id)   AS live
  FROM public.cash_games g;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
-- 16 THE SECOND APPLICATION ---------------------------------------------------
-- The migration has now been applied twice into the same backend. What is at
-- risk is not the DDL - every statement of it is IF NOT EXISTS or CREATE OR
-- REPLACE - but the two ASSERTED SUBSTITUTIONS, which read a body out of the
-- catalogue and replace an anchor in it. A second pass that did not notice its
-- own work would substitute into an already-substituted body, and the tick
-- would carry the stand-down twice. Both guards are structured as an early
-- RETURN with a NOTICE, and the way to prove they fired is that the body did
-- not move a byte and did not grow a second time.
DO $$
DECLARE v_bad text; v_n integer;
BEGIN
  SELECT string_agg(b.proname, ', ' ORDER BY b.proname) INTO v_bad
    FROM before_reapply b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE pg_get_functiondef(p.oid) IS DISTINCT FROM b.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the second application changed the body of %, so it is not idempotent', v_bad;
  END IF;
  SELECT string_agg(b.proname, ', ' ORDER BY b.proname) INTO v_bad
    FROM before_reapply b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE array_to_string(p.proacl, ',') IS DISTINCT FROM b.acl
      OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.comment;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the second application changed the acl or the comment of %', v_bad;
  END IF;

  -- THE STAND-DOWN IS THERE ONCE, NOT TWICE. A guard that did not fire would
  -- leave an unmistakable fingerprint.
  SELECT count(*)::integer INTO v_n FROM regexp_matches(
    pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure),
    'lightning_cluster_stands_down', 'g');
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 16: the tick carries the Lightning stand-down % times after two applications', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM regexp_matches(
    pg_get_functiondef('public.fn_cash_cluster_balance(uuid,timestamp with time zone)'::regprocedure),
    'LIGHTNING 2\.0 PHASE 5', 'g');
  IF v_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 16: the balancer carries the Phase 5 stand-down % times after two applications', v_n;
  END IF;

  -- AND NOT A ROW MOVED.
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'cash_games' AS x FROM before_rows WHERE games IS DISTINCT FROM (SELECT md5(string_agg(g::text, '|' ORDER BY g.id)) FROM public.cash_games g)
    UNION ALL
    SELECT 'tables' FROM before_rows WHERE tables IS DISTINCT FROM (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM public.tables t)
    UNION ALL
    SELECT 'table_seats' FROM before_rows WHERE seats IS DISTINCT FROM (SELECT md5(string_agg(s::text, '|' ORDER BY s.id)) FROM public.table_seats s)
    UNION ALL
    SELECT 'cash_cluster_epoch' FROM before_rows WHERE epochs IS DISTINCT FROM (SELECT md5(string_agg(e::text, '|' ORDER BY e.cluster_id, e.epoch)) FROM public.cash_cluster_epoch e)) y;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the second application rewrote rows in %', v_bad;
  END IF;

  -- AND EVERY CLUSTER ANSWERS IDENTICALLY. Phase 2's remediation failed exactly
  -- here: the bodies matched and the answers did not.
  SELECT count(*)::integer INTO v_n FROM before_answers b
   WHERE b.state IS DISTINCT FROM public.fn_cash_cluster_lightning_state(b.id)
      OR b.live  IS DISTINCT FROM public.fn_cash_cluster_live_eligible(b.id);
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 16: % cluster(s) answer differently after the second application', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM before_answers;
  IF (v_n > 10) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 16: only % cluster(s) were compared, so this is not a comparison', v_n;
  END IF;
END $$;
\echo '  ok  16 THE RE-APPLY          the migration applied a SECOND time over the standing estate - returned first to the shape its own section 8 asserts, which is a finding recorded in this file rather than a convenience - leaves all five function bodies, all five acls and all five comments byte-identical, and the two asserted substitutions DETECT their own previous work and say so rather than substituting again: the tick carries lightning_cluster_stands_down exactly ONCE and the balancer carries its Phase 5 guard exactly once, so neither grew twice; not one row of cash_games, tables, table_seats or cash_cluster_epoch changed; and every one of the Clusters standing answers fn_cash_cluster_lightning_state and fn_cash_cluster_live_eligible identically'
REAPPLY

# 15 EVERY @live-proof THE MIGRATION MAKES, EVALUATED ---------------------------
# The migration ends its header with a block of `-- @live-proof:` lines: scalar
# SQL expressions meant to be true of the database the file produces. They are
# COMMENTS, so nothing in a psql run evaluates them, and three of them shipped
# false in three separate rounds of an earlier Lightning phase - every one the
# proof drifting away from code that was right.
#
# Generated from the file under test rather than written by hand, for the same
# reason this harness applies the real predecessor migrations rather than
# transcribing them: a hand-copied list is a second place for a proof to drift,
# and drift is the only thing this section exists to catch. The mechanism is
# section 14 of scripts/dev/test-lightning-phase4-remediation.sh, copied exactly:
# each expression is inlined as CODE rather than as a string literal, so nothing
# in it needs escaping and a proof that no longer PARSES fails the run too.
#
# It runs AFTER the teardown - where every Cluster is must_move at epoch 0 with
# no halt, no pool session and no conversion record, which is what eight of
# these proofs assert - and BEFORE the second application.
#
# There is no quarantine here and there must not be one: every proof in the file
# is evaluated and every one must be true.
: > "$fixture/live-proofs.sql"
printf '%s\n' 'CREATE TEMP TABLE lp (n integer, lineno integer, ok boolean);' \
  >> "$fixture/live-proofs.sql"
proof_n=0
while IFS= read -r proof_line; do
  proof_n=$((proof_n + 1))
  proof_lineno=${proof_line%%:*}
  proof_expr=${proof_line#*:}
  proof_expr=${proof_expr#-- @live-proof: }
  {
    printf '%s%s%s%s%s' 'INSERT INTO lp VALUES (' "$proof_n" ', ' "$proof_lineno" ', coalesce(('
    printf '%s%s\n' "$proof_expr" ')::boolean, false));'
  } >> "$fixture/live-proofs.sql"
done < <(grep -n -- '^-- @live-proof: ' "$migration")

if [ "$proof_n" -lt 20 ]; then
  echo "FAIL 15: only $proof_n @live-proof line(s) were found in $migration, so this section would prove almost nothing"
  exit 1
fi

{
  printf '%s\n' 'DO $lp$'
  printf '%s\n' 'DECLARE v_bad text; v_n integer;'
  printf '%s\n' 'BEGIN'
  printf '%s%s%s\n' '  SELECT count(*)::integer INTO v_n FROM lp; IF v_n IS DISTINCT FROM ' "$proof_n" ' THEN'
  printf '%s%s%s\n' "    RAISE EXCEPTION 'FAIL 15: % of the " "$proof_n" " proof expressions were evaluated', v_n;"
  printf '%s\n' '  END IF;'
  printf '%s\n' '  -- NON-VACUITY: a run in which every proof answered NULL would coalesce to'
  printf '%s\n' '  -- false and fail below, and a run in which the table was empty fails above.'
  printf '%s\n' "  SELECT string_agg('#' || n || ' (line ' || lineno || ' of the migration)', ', ' ORDER BY n) INTO v_bad"
  printf '%s\n' '    FROM lp WHERE ok IS DISTINCT FROM true;'
  printf '%s\n' '  IF v_bad IS NOT NULL THEN'
  printf '%s\n' "    RAISE EXCEPTION 'FAIL 15: the migration carries @live-proof % that is NOT true of the database it just produced', v_bad;"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END $lp$;'
  printf '%s%s%s\n' "\\echo '  ok  15 EVERY LIVE PROOF    all " "$proof_n" " @live-proof expressions the migration carries in its own header were extracted from the file under test, inlined as code so that one which no longer PARSES is a failure too, and evaluated against the throwaway catalogue and the estate the first application left behind, every board still standing - and every single one of them is true, with no quarantine and no exception list'"
} >> "$fixture/live-proofs.sql"

# ONE psql session, thirteen files: the three fixtures, the six predecessor
# migrations, the pre-migration measurements of the bodies the substitution will
# bite, the migration, the assertions and the teardown, the migration's own
# @live-proofs, the migration AGAIN and the re-apply assertions. One session
# because the bodies measured before the migration are compared to the bodies
# after it, and because the pre-re-apply capture has to be a TEMP table in the
# backend the second application lands in.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres \
  -f "$base_fixture" \
  -f "$pop_fixture" \
  -f "$p5_fixture" \
  -f "$phase2" \
  -f "$phase2r" \
  -f "$phase3" \
  -f "$phase3r" \
  -f "$phase4" \
  -f "$phase4r" \
  -f "$fixture/pre.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# EIGHTEEN SECTIONS REPORTED, and the count is asserted rather than eyeballed: a
# psql that stopped early exits non-zero, but a section deleted from this file
# during a refactor would not, and the PASS line below would still print.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 18 ]; then
  echo "FAIL: $oks of the 18 sections reported, so this run proved less than this file claims"
  exit 1
fi

echo "PASS: Lightning Phase 5, the conversion is one transaction and the tables stop dealing, 18 checks: THE BODIES ARE REAL - the fixture installs the REAL 40,000+ character fn_cash_cluster_tick, assembled by line range from 20260906015029 and five real substitution migrations in version order, carrying the manual_game anchor exactly once and fn_platform_frozen, FOR UPDATE and no is_horse, plus the REAL fn_cash_cluster_balance, and a must_move tick that really rewrites tables and really plans seat moves so that nothing later is vacuous - then, against the migration: a six-max Cluster of eighteen eligible seated players with open cluster sessions goes to PENDING_ON with both tables halted for lightning_pending_on, both pending seat moves cancelled with a reason, a conversion record carrying all nine of the specification's fields, a lightning_pending_on event, and NO epoch move and NO pool session; commit_lightning then bumps the epoch by exactly one, opens a cash_cluster_epoch row with started_by lightning_on, creates one pool session per eligible player at the NEW epoch pointing at the cash session the player ALREADY had, re-stamps the halt to lightning and commits the record; F12 holds byte for byte across a nineteen-player conversion on a row-level md5 of every table_seats and cash_player_session column, through an md5 first proved to move and come back; F04 aborts BY ITSELF when the eighteenth player leaves at the boundary and again through a direct call, clearing only its own halt, and the tick plans moves again afterwards; F13 is answered twice - two different request ids produce one conversion and a wrong_state naming the mode, with the partial unique index proved to bite by being made to fire, and the same request id twice is idempotent through both begin and commit with no second set of pool sessions; F14 converts on the population re-measured AT the boundary with the pool set equal to the eligible set in both directions; F15's one-open index is proved to bite for a player and not for a different one; the tick and the balancer STAND DOWN in pending_on and in lightning and are proved to write nothing while doing it, the substitution is proved surgical by growth and by every sibling guard, and neither function mentions is_horse; the hand boundary refuses on a hand in flight and changes nothing, admits the conversion once the hand ends, and does not wedge on a seven-hour-old abandoned row while a five-hour-old one still blocks; the freeze refuses begin and commit and does NOT refuse abort; an eligible player with no open cash session aborts cleanly with a counted reason instead of a NOT NULL violation; all three functions answer not_found and wrong_state naming the mode in every one of the nine illegal starting states rather than raising; anon, authenticated and PUBLIC execute none of the three and service_role executes all three, cash_cluster_conversion has RLS on and no policy, and the halt vocabulary is closed; all of the migration's own @live-proof expressions are extracted from the file under test and true; and the migration applied a SECOND time leaves five bodies, five acls and five comments byte-identical with the stand-down present exactly once in each, no row moved and every Cluster answering identically; and a board whose tables.lifecycle is NULL - which the column permits - is halted, pooled, counted, orphan-refused and abort-resumed exactly as a live one is, with the harness own stranding query, asked from the halted side and proved non-vacuous at 21, answering ZERO, and the authorising number itself - fn_cash_cluster_live_eligible, re-cut onto the same membership predicate - answers 21 rather than 18 and writes 21 into the conversion record, because a reader that undercounts is the number that decides whether a Cluster may convert at all; and the WORSE sibling of that column, tables.status, which is nullable, may legally say 'paused', and whose CHECK could not forbid a NULL either because a CHECK that evaluates to NULL PASSES: a Cluster of 24 built as 18 on a waiting board plus 3 on a NULL-status board plus 3 on a paused one halts THREE boards, pools all 24 at the new epoch with every one of the six subordinate to the cash session they already held, and leaves the closed board and the deleted board - both carrying the waiting the discarded predicate admitted - unhalted, uncounted and unpooled, so what is proved is that status stopped deciding membership and not that membership stopped being filtered. The same shape is then converted a second time with NOTHING asserted about how many boards were stopped and NO absolute number asserted at all - only that the pool, the distinct players, the conversion record and fn_cash_cluster_live_eligible equal ONE ANOTHER, which they did at 18 under the defect exactly as they do at 24 under the fix - and is then asked the three questions that name no status: is any member board of a lightning Cluster still dealing, is any eligible player of it still being dealt cash, and is anybody on a member board without a pool session. That is the direction the halted-side stranding assertion could not see, and it is the only thing that catches a predicate which narrows the halt and the player-set queries together"
