#!/usr/bin/env bash
# Lightning Phase 4 REMEDIATION: a threshold reader that never raises, and a
# verdict that can see the pending states.
#
# Applies the real fixture chain and 20260921064717 to a throwaway PostgreSQL 17
# cluster, exercises the BLOCKER against that pre-remediation body until it
# raises, then applies 20260921142954 into the same backend and exercises every
# one of its claims against a real catalogue rather than against a reading of
# the file.
#
# WHAT IS ACTUALLY AT RISK HERE, AND WHY THE SECTIONS ARE SHAPED THE WAY THEY
# ARE.
#
# This file repairs two defects that were both invisible to the harness of the
# migration that introduced them, for two different reasons, and a harness
# written only against the NEW body would be invisible to them in exactly the
# same way. Six failure modes are worth naming:
#
#   A REPAIR THAT REPAIRS NOTHING is the first and the worst. "The reader no
#   longer raises on {"on_threshold": 18.0}" is satisfied by a reader that
#   never raised, and a harness that only ever sees the fixed body cannot tell
#   the difference between a blocker that was real and a blocker that was
#   imagined. So sections 01 and 02 run BEFORE the remediation is applied, over
#   the body 20260921064717 actually installed, and they assert the RAISE:
#   four badly typed configurations, each caught and its SQLSTATE recorded -
#   22P02 for 18.0 and 18.5, 22003 for 2147483648 and 1e300 - and the same
#   error travelling up through fn_cash_cluster_lightning_state and out of
#   fn_cash_game_lobby, which is SECURITY DEFINER, granted to authenticated and
#   polled every five seconds while the modal is open. Section 03 then asserts
#   that every one of those four now ANSWERS. Two directions, one backend, one
#   session: the same four shapes, the same Cluster, before and after.
#
#   A DEFAULT THAT SWALLOWS THE EVIDENCE is how a widened guard passes a test
#   that looks strict. {"on_threshold": 18.0} on the six-max band must answer
#   18 - and 18 is ALSO the band default, so a regex that stopped honouring
#   whole-valued decimals would still answer 18 and still be green. Every
#   honouring assertion here is therefore made at a number that is NOT the
#   default for its band (24.0 / 16.000 on a band whose defaults are 18 / 12)
#   or on `source`, which says where the number came from and cannot be faked
#   by a coincidence of value.
#
#   A VERDICT THAT IS BLIND IN THE STATES NOBODY BUILT is the second defect,
#   and no proof in 20260921064717 could discriminate it, because every Cluster
#   on that database was must_move and the file's own last proof asserts so.
#   Section 08 builds EIGHT Clusters - one in each of must_move, pending_on,
#   lightning and pending_off with a population that should make the verdict
#   true, and one in each with a population that makes the MIRROR non-vacuous -
#   and every mirror is proved to be a statement about the MODE rather than
#   about the population, by moving that one Cluster's mode and watching the
#   verdict flip. `cluster_mode` already admits all ten states: the CHECK
#   installed by 20260920172736 and mirrored by the fixture is
#   ('created','opening','must_move','pending_on','lightning','pending_off',
#   'draining','paused','frozen','dead'), so nothing here widens anything and
#   spec Phase 5 needs no constraint change to drive a conversion.
#
#   A FUZZ THAT QUIETLY SHRANK is what seventeen hand-written nonsense
#   configurations turned out to be: they covered every jsonb_typeof and missed
#   the one class that raises, a JSON number the guard admits and the cast
#   refuses. Section 05 does not carry a list. It carries thirty-odd SLOT
#   values - every jsonb_typeof in both threshold slots, plus whole-valued
#   decimals, non-whole decimals, nine ten and eleven digit integers, int4's
#   exact boundary on both sides, negatives, -0 and four exponent forms - and
#   CROSS JOINs them against each other and against eight handednesses
#   including NULL, zero and a negative. Several thousand shapes, generated,
#   with one invariant asserted for every one of them: it does not raise, ON is
#   strictly above OFF, OFF is at least two, and `source` is one of exactly
#   four legal strings. The catcher it is measured through is itself proved to
#   catch, against a real division by zero.
#
#   AN EQUIVALENT MUTATION IS STILL A MUTATION. floor() and round() agree on
#   every value this guard admits - the guard admits only whole numbers - so no
#   behaviour can distinguish them and only an anchor on the installed body
#   can. Section 03 carries that anchor and says why, because the day someone
#   widens the guard is the day the difference becomes real and silent.
#
#   A PROOF THAT HAS GONE STALE is the failure nothing catches, because
#   `-- @live-proof:` lines are comments and no psql run evaluates them.
#   Section 14 extracts every one of them from the file under test and asks the
#   database, with no quarantine and no exception list, exactly as section 22
#   of scripts/dev/test-lightning-phase4-population.sh does.
#
# THE RULES, inherited from scripts/dev/test-lightning-phase4-population.sh:
#
#   1. Every comparison in an assertion is IS DISTINCT FROM, never = or <>. A
#      NULL where a value was expected makes `IF NOT (x = y)` evaluate to NULL,
#      which plpgsql takes as false, so an absent key PASSES a check written
#      that way - and this file reads jsonb by ->>, which answers NULL for a
#      key that is not there. Relational assertions are spelled
#      `IF (a > b) IS DISTINCT FROM true`.
#   2. Every negative assertion is preceded by its non-vacuity proof. "It did
#      not raise" is satisfied by a function that was never called, so every
#      catcher here is first proved to catch, and every false verdict is proved
#      to be false for the reason claimed by flipping the one input and
#      watching it turn true.
#   3. Grants are asserted in both directions: anon, authenticated and PUBLIC
#      hold nothing on all three functions, and service_role holds EXECUTE on
#      all three.
#   4. The re-apply is compared body by body, and the ANSWERS are compared too:
#      every Cluster's whole state object is captured before the second
#      application and compared to itself after it. Phase 2's remediation is
#      the reason - it failed exactly here.
#
# THE FIXTURE CHAIN IS THE ONE PHASE 4 ALREADY USES, UNCHANGED. This migration
# creates one function and replaces two that 20260921064717 already installed,
# and it reads no relation that file did not read, so no delta fixture is
# needed and none is added: scripts/dev/fixtures/lightning-phase3-remediation-schema.sql
# then scripts/dev/fixtures/lightning-phase4-population-schema.sql then the four
# real predecessor migrations then 20260921064717 itself. One copy of that text
# in the repository, free to be corrected in one place.
#
# LIGHTNING_PHASE4R_MIGRATION overrides the file under test, so that mutation
# testing - copying the migration to a scratch directory, deleting one clause
# from the copy and watching this harness go red - never has to touch the
# migration in the repository. LIGHTNING_PHASE4R_PORT overrides the port.
set -euo pipefail
export LC_ALL=C  # else initdb's postmaster refuses to start on macOS ("became multithreaded during startup") and string_agg ordering stops being deterministic
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_PHASE4R_PORT:-55548}
base_fixture=$root/scripts/dev/fixtures/lightning-phase3-remediation-schema.sql
delta_fixture=$root/scripts/dev/fixtures/lightning-phase4-population-schema.sql
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
phase3r=$root/supabase/migrations/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
phase4=$root/supabase/migrations/20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql
migration=${LIGHTNING_PHASE4R_MIGRATION:-$root/supabase/migrations/20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql}
for f in "$base_fixture" "$delta_fixture" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$migration"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase4r-test.XXXXXX")
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

# ONE psql session, nine files: the two fixtures, the four predecessor
# migrations, 20260921064717, the PRE-remediation assertions, the remediation
# itself, the POST assertions, its own @live-proofs, the remediation AGAIN and
# the re-apply assertions. One session because the Clusters built before the
# remediation are the same rows asserted on after it, because the @live-proof
# block must see the estate the first application left behind, and because the
# pre-re-apply capture has to be a TEMP table in the same backend the second
# application lands in.
cat > "$fixture/pre-assertions.sql" <<'ASSERT'
-- THE HARNESS'S OWN WRITERS. Clusters are built through these rather than
-- through fn_cash_cluster_open_table because the shapes this contract needs -
-- a Cluster sitting in pending_on, a disabled Cluster over its ON threshold, a
-- Cluster carrying a configuration value no operator interface would let you
-- type - are shapes the one cluster writer correctly refuses to make.
CREATE TEMP TABLE board (k text PRIMARY KEY, game_id uuid, table_id uuid, note text);

CREATE FUNCTION public.fx_cluster(p_key text, p_handed integer DEFAULT 6,
                                  p_lightning boolean DEFAULT true,
                                  p_enabled boolean DEFAULT true,
                                  p_cap integer DEFAULT 40)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_id uuid; v_tb uuid;
BEGIN
  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness,
     ruleset_snapshot, created_by, must_move, lightning_enabled, enabled,
     cluster_mode, cluster_epoch, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'R4 ' || p_key, 'classic', 'nlh', 1.00, 2.00, p_handed, '{"seats": 9}'::jsonb,
     '00000000-0000-0000-0000-0000000000aa', true, p_lightning, p_enabled,
     -- BORN must_move AND MOVED LATER, never inserted straight into a pending
     -- state: that is the order the specification's conversion sequence uses,
     -- and trg_cash_games_epoch_follows_its_game fires on the UPDATE the same
     -- way it fires on the INSERT.
     'must_move', 0, clock_timestamp())
  RETURNING id INTO v_id;
  -- One live Main 1 with room for every population this file needs on a single
  -- board: 20260921044045's read-back counts clusters that have a live Main 1
  -- and refuses to commit at zero.
  INSERT INTO public.tables
    (club_id, union_id, name, game_variant, small_blind, big_blind, max_players,
     status, created_by, cluster_id, role, main_index, lifecycle, is_deleted,
     opened_at, live_at, created_at)
  VALUES
    ('cb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-0000000000f1',
     'R4 ' || p_key, 'nlh', 1.00, 2.00, p_cap, 'waiting',
     '00000000-0000-0000-0000-0000000000aa', v_id, 'main', 1, 'live', false,
     clock_timestamp(), clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_tb;
  INSERT INTO board (k, game_id, table_id, note) VALUES (p_key, v_id, v_tb, NULL);
  RETURN v_id;
END $fx$;

-- SEATS A POPULATION OF EXACTLY p_n, from zero, every time: the harness moves
-- the same Cluster up and down the ladder and a populate that only ever added
-- would make "seventeen" mean "seventeen more".
CREATE FUNCTION public.fx_populate(p_game uuid, p_n integer)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE v_tb uuid; i integer;
BEGIN
  DELETE FROM public.table_seats ts USING public.tables tb
   WHERE tb.id = ts.table_id AND tb.cluster_id = p_game;
  SELECT tb.id INTO v_tb FROM public.tables tb
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle <> 'closed'
   ORDER BY tb.created_at, tb.id LIMIT 1;
  IF v_tb IS NULL THEN RAISE EXCEPTION 'FIXTURE: cluster % has no board to seat on', p_game; END IF;
  FOR i IN 1..p_n LOOP
    INSERT INTO public.table_seats
      (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at)
    VALUES (v_tb, gen_random_uuid(), i, 200.00, false, false, clock_timestamp());
  END LOOP;
  RETURN p_n;
END $fx$;

CREATE FUNCTION public.fx_mode(p_game uuid, p_mode text)
RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  UPDATE public.cash_games SET cluster_mode = p_mode WHERE id = p_game;
END $fx$;

CREATE FUNCTION public.fx_cfg(p_game uuid, p_cfg jsonb)
RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  IF p_cfg IS NULL THEN
    UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot - 'lightning' WHERE id = p_game;
  ELSE
    UPDATE public.cash_games
       SET ruleset_snapshot = coalesce(ruleset_snapshot, '{}'::jsonb) || jsonb_build_object('lightning', p_cfg)
     WHERE id = p_game;
  END IF;
END $fx$;

CREATE FUNCTION public.fx_live(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $fx$
  SELECT public.fn_cash_cluster_live_eligible(p_game);
$fx$;
CREATE FUNCTION public.fx_verdict(p_game uuid, p_key text) RETURNS text LANGUAGE sql STABLE AS $fx$
  SELECT public.fn_cash_cluster_lightning_state(p_game) -> 'verdict' ->> p_key;
$fx$;

-- THE CATCHERS. Each one returns a TEXT verdict rather than propagating, so
-- that "it raised" and "it answered" are both values an assertion can compare -
-- and so that the SQLSTATE itself is recorded rather than merely survived.
-- Every one of them is proved to catch, against a real division by zero, before
-- any assertion is made through it.
CREATE FUNCTION public.fx_try_thresholds(p_game uuid, p_cfg jsonb)
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v jsonb; s text;
BEGIN
  PERFORM public.fx_cfg(p_game, p_cfg);
  BEGIN
    v := public.fn_cash_cluster_lightning_thresholds(p_game);
    RETURN 'answered ' || coalesce(v ->> 'on', '<no on>') || '/' || coalesce(v ->> 'off', '<no off>')
           || ' ' || coalesce(v ->> 'source', '<no source>');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
    RETURN 'raised ' || s;
  END;
END $fx$;

CREATE FUNCTION public.fx_try_state(p_game uuid)
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v jsonb; s text;
BEGIN
  v := public.fn_cash_cluster_lightning_state(p_game);
  RETURN 'answered ' || coalesce(v -> 'verdict' ->> 'live_eligible', '<no live_eligible>');
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN 'raised ' || s;
END $fx$;

CREATE FUNCTION public.fx_try_lobby(p_game uuid)
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v jsonb; s text;
BEGIN
  v := public.fn_cash_game_lobby(p_game);
  RETURN 'answered ' || coalesce(v -> 'lightning' -> 'thresholds' ->> 'on', '<no lightning.thresholds.on>');
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN 'raised ' || s;
END $fx$;

CREATE FUNCTION public.fx_try_boom()
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE n integer; s text;
BEGIN
  n := 1 / (SELECT 0);
  RETURN 'answered ' || n;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN 'raised ' || s;
END $fx$;

-- 01 THE BLOCKER IS REAL ------------------------------------------------------
-- Everything in this section runs against the body 20260921064717 actually
-- installed, before a line of the remediation has been applied. If any of it
-- goes green the remediation is repairing a defect that was not there, and
-- section 03 - which asserts the mirror of every one of these - is proving
-- nothing at all.
DO $$
DECLARE
  v_game uuid; v_got text; v_def text;
BEGIN
  -- NON-VACUITY FOR THE WHOLE FILE: this really is the pre-remediation
  -- catalogue. The probe does not exist yet, the reader carries no integer
  -- pattern, and the state reader is still LANGUAGE sql.
  IF to_regprocedure('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: the probe already exists before the remediation was applied, so nothing here is a before';
  END IF;
  v_def := pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds(uuid)'::regprocedure);
  IF position('[0-9]{1,9}' in v_def) > 0 THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation reader already carries the integer pattern';
  END IF;
  IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.oid = 'public.fn_cash_cluster_lightning_state(uuid)'::regprocedure)
     IS DISTINCT FROM 'sql' THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation state reader is not LANGUAGE sql, so this is not the body the audit measured';
  END IF;

  -- THE CATCHER CATCHES. Every "it raised" below is measured through this
  -- shape, and a handler that swallowed everything would report a raise for a
  -- function that answered.
  IF public.fx_try_boom() IS DISTINCT FROM 'raised 22012' THEN
    RAISE EXCEPTION 'FAIL 01: the catcher does not catch a division by zero, it reports %', public.fx_try_boom();
  END IF;

  v_game := public.fx_cluster('blocker', 6);
  PERFORM public.fx_populate(v_game, 3);

  -- AND IT ANSWERS WHEN THE CONFIGURATION IS WELL TYPED. The four raises below
  -- are about the SHAPE of the value, not about the reader being unreachable.
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 24, "off_threshold": 16}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 24/16 ruleset' THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation reader does not even answer a well-typed configuration, it says %', v_got;
  END IF;

  -- THE FOUR SHAPES, AND THE TWO SQLSTATES THE AUDIT MEASURED. 18.0 is the one
  -- that matters: jsonb preserves the trailing zero, to_jsonb(numeric) produces
  -- it, and the error text is literally "18.0".
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 18.0}'::jsonb);
  IF v_got IS DISTINCT FROM 'raised 22P02' THEN
    RAISE EXCEPTION 'FAIL 01: {"on_threshold": 18.0} did not raise 22P02 against the pre-remediation body, it said %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 18.5}'::jsonb);
  IF v_got IS DISTINCT FROM 'raised 22P02' THEN
    RAISE EXCEPTION 'FAIL 01: {"on_threshold": 18.5} did not raise 22P02 against the pre-remediation body, it said %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 2147483648}'::jsonb);
  IF v_got IS DISTINCT FROM 'raised 22003' THEN
    RAISE EXCEPTION 'FAIL 01: {"on_threshold": 2147483648} did not raise 22003 against the pre-remediation body, it said %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 1e300}'::jsonb);
  IF v_got IS DISTINCT FROM 'raised 22003' THEN
    RAISE EXCEPTION 'FAIL 01: {"on_threshold": 1e300} did not raise 22003 against the pre-remediation body, it said %', v_got;
  END IF;

  -- IT DOES NOT STOP AT THE READER. The same one value, still installed on the
  -- same Cluster, travels up through the state reader and out of the lobby -
  -- SECURITY DEFINER, granted to authenticated, polled every five seconds.
  PERFORM public.fx_cfg(v_game, '{"on_threshold": 18.0}'::jsonb);
  IF public.fx_try_state(v_game) IS DISTINCT FROM 'raised 22P02' THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation state reader did not propagate the raise, it said %', public.fx_try_state(v_game);
  END IF;
  IF public.fx_try_lobby(v_game) IS DISTINCT FROM 'raised 22P02' THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation lobby did not propagate the raise, it said %', public.fx_try_lobby(v_game);
  END IF;
  -- AND THE LOBBY WORKS AT ALL, on the same Cluster, one configuration value
  -- later: "the lobby raised" has to be a statement about that value.
  PERFORM public.fx_cfg(v_game, '{"on_threshold": 24, "off_threshold": 16}'::jsonb);
  IF public.fx_try_lobby(v_game) IS DISTINCT FROM 'answered 24' THEN
    RAISE EXCEPTION 'FAIL 01: the pre-remediation lobby does not answer a well-typed configuration either, it says %', public.fx_try_lobby(v_game);
  END IF;
  -- Left installed as the badly typed one: section 04 asserts the mirror of
  -- this, on this row, with this value.
  PERFORM public.fx_cfg(v_game, '{"on_threshold": 18.0}'::jsonb);
END $$;
\echo '  ok  01 THE BLOCKER IS REAL    against the body 20260921064717 actually installed - no probe yet, no integer pattern in the reader, the state reader still LANGUAGE sql - a Cluster carrying {"on_threshold": 18.0} raises 22P02 out of fn_cash_cluster_lightning_thresholds, so do 18.5 (22P02), 2147483648 (22003) and 1e300 (22003), and the 18.0 travels all the way up through fn_cash_cluster_lightning_state and out of SECURITY DEFINER fn_cash_game_lobby with the same SQLSTATE, while a well-typed {"on_threshold": 24, "off_threshold": 16} answers 24/16 through both of them - measured through a catcher first proved to catch a real division by zero'

-- 02 THE VERDICT IS BLIND IN THE PENDING STATES -------------------------------
-- Also pre-remediation, and also a mirror of a later section. The eight
-- Clusters this section builds are the eight section 08 asserts on: the same
-- rows, the same populations, moved back to must_move at the end of this file
-- because the remediation's own post-apply block counts that every Cluster is
-- must_move and refuses at anything else.
DO $$
DECLARE
  g_mm uuid; g_pon uuid; g_lt uuid; g_poff uuid;
BEGIN
  -- Four Clusters whose verdict SHOULD be true, one in each state.
  g_mm   := public.fx_cluster('on_must_move', 6);   PERFORM public.fx_populate(g_mm, 18);
  g_pon  := public.fx_cluster('on_pending_on', 6);  PERFORM public.fx_populate(g_pon, 18);
  g_lt   := public.fx_cluster('off_lightning', 6);  PERFORM public.fx_populate(g_lt, 5);
  g_poff := public.fx_cluster('off_pending_off', 6);PERFORM public.fx_populate(g_poff, 5);
  -- Four more whose verdict should be FALSE for the mode and for nothing else:
  -- over the ON threshold in a state the ON side must not answer in, and under
  -- the OFF threshold in a state the OFF side must not answer in.
  PERFORM public.fx_populate(public.fx_cluster('mirror_on_lightning', 6), 20);
  PERFORM public.fx_populate(public.fx_cluster('mirror_on_pending_off', 6), 20);
  PERFORM public.fx_populate(public.fx_cluster('mirror_off_must_move', 6), 5);
  PERFORM public.fx_populate(public.fx_cluster('mirror_off_pending_on', 6), 5);
  -- And the two the enabled asymmetry needs.
  PERFORM public.fx_populate(public.fx_cluster('disabled_over_on', 6, true, false), 20);
  PERFORM public.fx_populate(public.fx_cluster('disabled_under_off', 6, true, false), 5);

  PERFORM public.fx_mode(g_pon, 'pending_on');
  PERFORM public.fx_mode(g_lt, 'lightning');
  PERFORM public.fx_mode(g_poff, 'pending_off');

  -- NON-VACUITY: the settled twins say true at these very populations, so the
  -- false below is about the STATE and not about the count.
  IF public.fx_verdict(g_mm, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: a must_move Cluster at 18 does not say it would turn on even before the remediation';
  END IF;
  IF public.fx_verdict(g_lt, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: a lightning Cluster at 5 does not say it would turn off even before the remediation';
  END IF;
  IF public.fx_live(g_pon) IS DISTINCT FROM 18 OR public.fx_live(g_poff) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 02: the pending Clusters are not at the populations this section needs (% and %)',
      public.fx_live(g_pon), public.fx_live(g_poff);
  END IF;

  -- THE DEFECT. Same population, same thresholds, one state along - and the
  -- verdict goes blind. Spec Phase 5 re-asks both of these questions in exactly
  -- these two states, so every conversion would abort at its own safety check.
  IF public.fx_verdict(g_pon, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 02: the pre-remediation verdict already answers in pending_on, so the second repair repairs nothing';
  END IF;
  IF public.fx_verdict(g_poff, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 02: the pre-remediation verdict already answers in pending_off, so the second repair repairs nothing';
  END IF;
END $$;
\echo '  ok  02 THE VERDICT WAS BLIND  built eight Clusters - one in each of must_move, pending_on, lightning and pending_off with a population that should make the verdict true, and one in each with the population that makes its mirror non-vacuous - and against the pre-remediation body a must_move Cluster at 18 says would_turn_on true while an OTHERWISE IDENTICAL pending_on Cluster at 18 says false, and a lightning Cluster at 5 says would_turn_off true while an identical pending_off Cluster at 5 says false: the exact two askings the specification makes at the conversion-safe hand boundary, both answered blind'

-- EVERY CLUSTER BACK TO must_move BEFORE THE REMEDIATION IS APPLIED. Its
-- post-apply block counts `cluster_mode <> 'must_move'` and refuses to commit
-- at anything but zero, because Phase 4 converts nothing. Section 08 moves them
-- again afterwards. Said here rather than discovered inside the migration,
-- because a failure there reads as "the remediation is broken" and a failure
-- here reads as "this harness is".
UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE cluster_mode <> 'must_move';
DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL: % cluster(s) are not must_move, and the remediation refuses to apply over them', v_n;
  END IF;
END $$;
ASSERT

cat > "$fixture/assertions.sql" <<'ASSERT'
-- 03 THE BLOCKER IS REPAIRED --------------------------------------------------
-- The mirror of section 01, on the same Cluster, with the same four values.
-- Every assertion about a number that was HONOURED is made either at a number
-- that is not the default for its band, or on `source` - because 18 is the
-- six-max ON default, so "it answered 18" is satisfied by a reader that threw
-- the configuration away.
DO $$
DECLARE v_game uuid; v_got text; v_body text;
BEGIN
  SELECT game_id INTO v_game FROM board WHERE k = 'blocker';
  IF public.fx_try_boom() IS DISTINCT FROM 'raised 22012' THEN
    RAISE EXCEPTION 'FAIL 03: the catcher no longer catches, so "it did not raise" means nothing here';
  END IF;

  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 18.0}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 ruleset_partial' THEN
    RAISE EXCEPTION 'FAIL 03: {"on_threshold": 18.0} is not honoured AS 18 by configuration, it says %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 18.5}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 default' THEN
    RAISE EXCEPTION 'FAIL 03: {"on_threshold": 18.5} does not fall back to the band defaults, it says %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 2147483648}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 default' THEN
    RAISE EXCEPTION 'FAIL 03: {"on_threshold": 2147483648} does not fall back to the band defaults, it says %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 1e300}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 default' THEN
    RAISE EXCEPTION 'FAIL 03: {"on_threshold": 1e300} does not fall back to the band defaults, it says %', v_got;
  END IF;
  -- THE ONE THAT CANNOT BE FAKED BY A COINCIDENCE OF VALUE. 24 and 16 are not
  -- the six-max defaults, so a guard that stopped admitting whole-valued
  -- decimals answers 18 / 12 here and goes red, where at 18.0 it would have
  -- answered 18 and stayed green.
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": 24.0, "off_threshold": 16.000}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 24/16 ruleset' THEN
    RAISE EXCEPTION 'FAIL 03: a whole-valued configuration written with a decimal point is not honoured, it says %', v_got;
  END IF;
  -- The negative int4 overflow the migration's own loop carries, which raised
  -- 22003 against the previous body for the same reason 2147483648 did.
  v_got := public.fx_try_thresholds(v_game, '{"on_threshold": -2147483649}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 default' THEN
    RAISE EXCEPTION 'FAIL 03: {"on_threshold": -2147483649} does not fall back to the band defaults, it says %', v_got;
  END IF;

  -- THE ANCHORS, AND WHY THEY ARE HERE RATHER THAN IN A BEHAVIOUR.
  --
  -- The guard admits only whole numbers, so floor() and round() agree on every
  -- value that reaches them and NO input can tell them apart: that mutation is
  -- equivalent under the current guard and becomes a silent off-by-one the day
  -- the guard is widened. An anchor on the installed body is the only thing
  -- that can catch it, so the anchor is here and this comment is why.
  v_body := regexp_replace(pg_get_functiondef('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure),
                           '--[^' || chr(10) || ']*', '', 'g');
  IF position('floor(' in v_body) = 0 THEN
    RAISE EXCEPTION 'FAIL 03: the installed rule does not floor the configured value';
  END IF;
  IF position('round(' in v_body) > 0 THEN
    RAISE EXCEPTION 'FAIL 03: the installed rule rounds where it must floor, which is invisible to every input this guard admits and stops being invisible the day the guard widens';
  END IF;
  IF position('^-?[0-9]{1,9}(\.0+)?$' in v_body) = 0 THEN
    RAISE EXCEPTION 'FAIL 03: the installed rule does not carry the pattern that makes its guard and its cast admit the same set';
  END IF;
  IF position('RAISE' in v_body) > 0 THEN
    RAISE EXCEPTION 'FAIL 03: the installed rule can raise, and it is read on the path a tick takes';
  END IF;
  -- Left installed as the badly typed one, for section 04.
  PERFORM public.fx_cfg(v_game, '{"on_threshold": 18.0}'::jsonb);
END $$;
\echo '  ok  03 THE BLOCKER REPAIRED   the same Cluster and the same four values that raised in section 01 now ANSWER - 18.0 honoured AS 18 under source ruleset_partial, and 18.5, 2147483648, 1e300 and -2147483649 each falling back to the mandated band defaults under source default - with the honouring proved at 24.0 / 16.000 where 24 and 16 are NOT the defaults so a guard that stopped admitting whole-valued decimals cannot hide behind a coincidence of value, the installed body still carrying the nine-digit pattern and floor() and still containing no RAISE at all'

-- 04 THE PROPAGATION IS REPAIRED ----------------------------------------------
-- fn_cash_game_lobby IS in this fixture chain and it embeds the state reader,
-- so the end-to-end path the audit traced - lobby -> state -> thresholds - is
-- exercised here directly rather than by proxy.
DO $$
DECLARE v_game uuid; v_cfg jsonb; v_got text; v_lobby jsonb;
BEGIN
  SELECT game_id INTO v_game FROM board WHERE k = 'blocker';
  FOR v_cfg IN SELECT * FROM unnest(ARRAY[
      '{"on_threshold": 18.0}', '{"on_threshold": 18.5}', '{"on_threshold": 2147483648}',
      '{"on_threshold": 1e300}', '{"on_threshold": -2147483649}', '{"on_threshold": 99999999999}',
      '{"on_threshold": 0.5}', '{"on_threshold": -0}', '{"off_threshold": 20.5}',
      '{"on_threshold": {"n": 20}}', '{"on_threshold": [20]}', '{"on_threshold": "20"}',
      '{"on_threshold": true}', '{"on_threshold": null}', 'null', '[]', '"x"', '{}'
    ]::jsonb[]) LOOP
    PERFORM public.fx_cfg(v_game, v_cfg);
    v_got := public.fx_try_state(v_game);
    IF v_got IS DISTINCT FROM 'answered 3' THEN
      RAISE EXCEPTION 'FAIL 04: the state reader did not answer 3 for %, it said %', v_cfg, v_got;
    END IF;
    v_got := public.fx_try_lobby(v_game);
    IF v_got LIKE 'raised%' THEN
      RAISE EXCEPTION 'FAIL 04: fn_cash_game_lobby still raises for %, it said %', v_cfg, v_got;
    END IF;
  END LOOP;

  -- AND THE LOBBY CARRIES THE SAME OBJECT, not merely a surviving one: the
  -- thing the modal reads every five seconds is this reader's whole answer.
  PERFORM public.fx_cfg(v_game, '{"on_threshold": 18.0}'::jsonb);
  v_lobby := public.fn_cash_game_lobby(v_game);
  IF v_lobby -> 'lightning' IS DISTINCT FROM public.fn_cash_cluster_lightning_state(v_game) THEN
    RAISE EXCEPTION 'FAIL 04: the lobby no longer embeds the state reader''s own answer';
  END IF;
  IF (v_lobby -> 'lightning' -> 'thresholds' ->> 'on')::integer IS DISTINCT FROM 18
     OR (v_lobby -> 'lightning' -> 'thresholds' ->> 'source') IS DISTINCT FROM 'ruleset_partial' THEN
    RAISE EXCEPTION 'FAIL 04: the lobby reports % / % for a Cluster configured 18.0',
      v_lobby -> 'lightning' -> 'thresholds' ->> 'on', v_lobby -> 'lightning' -> 'thresholds' ->> 'source';
  END IF;
END $$;
\echo '  ok  04 THE PROPAGATION HELD   with eighteen badly typed configurations installed in turn on a real Cluster - whole and fractional decimals, both int4 overflows, an eleven-digit integer, -0, every jsonb_typeof in the threshold slot and four non-object rulesets - fn_cash_cluster_lightning_state answers its population every time and SECURITY DEFINER fn_cash_game_lobby never raises once, and the lobby''s lightning object is byte-identical to the state reader''s own answer reporting 18 under source ruleset_partial'

-- 05 THE FUZZ IS GENERATED, NOT WRITTEN ---------------------------------------
-- Seventeen hand-written nonsense configurations covered every jsonb_typeof and
-- missed the one class that raised. This section carries no list of cases: it
-- carries slot VALUES and CROSS JOINs them, so the only way for it to shrink is
-- for someone to delete a value and leave the count assertion below red.
CREATE FUNCTION public.fx_try_probe(p_cfg jsonb, p_h integer)
RETURNS jsonb LANGUAGE plpgsql AS $fx$
DECLARE v jsonb; s text;
BEGIN
  v := public.fn_cash_cluster_lightning_thresholds_probe(p_cfg, p_h);
  RETURN v;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN jsonb_build_object('raised', s);
END $fx$;

CREATE FUNCTION public.fx_try_probe_boom()
RETURNS jsonb LANGUAGE plpgsql AS $fx$
DECLARE n integer; s text;
BEGIN
  n := 1 / (SELECT 0);
  RETURN jsonb_build_object('answered', n);
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
  RETURN jsonb_build_object('raised', s);
END $fx$;

-- EVERY jsonb_typeof IN BOTH SLOTS, plus every numeric shape the gap between a
-- `= 'number'` guard and an `::integer` cast ever contained. NULL v means the
-- key is ABSENT, which is its own case and not the same as JSON null.
CREATE TEMP TABLE fuzz_slot (k text PRIMARY KEY, v jsonb);
INSERT INTO fuzz_slot (k, v) VALUES
  ('absent', NULL),
  ('object', '{"n": 20}'), ('object_empty', '{}'),
  ('array', '[20]'), ('array_empty', '[]'),
  ('string_num', '"20"'), ('string_text', '"twenty"'), ('string_empty', '""'),
  ('bool_true', 'true'), ('bool_false', 'false'),
  ('json_null', 'null'),
  ('int_30', '30'), ('int_18', '18'), ('int_12', '12'), ('int_2', '2'),
  ('int_1', '1'), ('int_0', '0'),
  ('whole_dec_24_0', '24.0'), ('whole_dec_16_000', '16.000'), ('whole_dec_0_0', '0.0'),
  ('frac_18_5', '18.5'), ('frac_0_5', '0.5'), ('frac_24_0001', '24.0001'),
  ('neg_5', '-5'), ('neg_zero', '-0'), ('neg_whole_dec', '-18.0'),
  ('nine_digits', '999999999'), ('nine_digits_dec', '999999999.0'),
  ('ten_digits', '1234567890'), ('eleven_digits', '12345678901'),
  ('int4_max', '2147483647'), ('int4_over', '2147483648'), ('int4_under', '-2147483649'),
  ('exp_1e3', '1e3'), ('exp_1e300', '1e300'), ('exp_1_5e1', '1.5e1'), ('exp_1e_3', '1e-3');

-- A CONFIGURATION THAT IS NOT AN OBJECT AT ALL, including a SQL NULL, which is
-- what `ruleset_snapshot -> 'lightning'` answers for every Cluster alive today.
CREATE TEMP TABLE fuzz_scalar (k text PRIMARY KEY, v jsonb);
INSERT INTO fuzz_scalar (k, v) VALUES
  ('sql_null', NULL), ('json_null', 'null'), ('array_empty', '[]'), ('array', '[18, 12]'),
  ('string', '"18"'), ('number', '18'), ('number_dec', '18.0'), ('bool', 'true'),
  ('object_empty', '{}');

-- INCLUDING THE HANDEDNESSES NO cash_games ROW CAN CARRY: the column is
-- CHECK (handedness BETWEEN 2 AND 9), so NULL, zero and a negative are
-- reachable only because the rule was pulled out into a pure function.
CREATE TEMP TABLE fuzz_handed (h integer);
INSERT INTO fuzz_handed (h) VALUES (NULL), (-7), (0), (1), (2), (5), (6), (7), (9), (12);

CREATE TEMP TABLE fuzz_case AS
  SELECT row_number() OVER (ORDER BY 1) AS n, q.label, q.cfg, q.h
    FROM (
      SELECT 'on=' || a.k || ' off=' || b.k AS label,
             (CASE WHEN a.v IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('on_threshold', a.v) END)
             || (CASE WHEN b.v IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('off_threshold', b.v) END) AS cfg,
             h.h
        FROM fuzz_slot a CROSS JOIN fuzz_slot b CROSS JOIN fuzz_handed h
      UNION ALL
      SELECT 'cfg=' || s.k, s.v, h.h FROM fuzz_scalar s CROSS JOIN fuzz_handed h
    ) q;

CREATE TEMP TABLE fuzz_out AS
  SELECT c.n, c.label, c.cfg, c.h, public.fx_try_probe(c.cfg, c.h) AS out FROM fuzz_case c;

DO $$
DECLARE v_n bigint; v_expected bigint; v_bad record; v_srcs text;
BEGIN
  -- THE MATRIX IS THE SIZE ITS OWN INPUTS SAY IT IS. A generator that silently
  -- stopped crossing one of its dimensions would leave this red.
  SELECT (SELECT count(*) FROM fuzz_slot) * (SELECT count(*) FROM fuzz_slot) * (SELECT count(*) FROM fuzz_handed)
       + (SELECT count(*) FROM fuzz_scalar) * (SELECT count(*) FROM fuzz_handed)
    INTO v_expected;
  SELECT count(*) INTO v_n FROM fuzz_out;
  IF v_n IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'FAIL 05: the matrix holds % cases where its own inputs say %', v_n, v_expected;
  END IF;
  IF (v_n >= 10000::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the matrix has shrunk to % cases', v_n;
  END IF;
  -- THE CATCHER CATCHES, in the exact shape every one of those cases was
  -- measured through: "none of them raised" is otherwise a sentence about a
  -- handler that hides everything.
  IF public.fx_try_probe_boom() ->> 'raised' IS DISTINCT FROM '22012' THEN
    RAISE EXCEPTION 'FAIL 05: the fuzz catcher does not catch a real division by zero';
  END IF;

  -- THE INVARIANT, FOR EVERY SHAPE: it did not raise, it answered, ON is
  -- strictly above OFF, OFF is at least two, the band is one of two, the
  -- handedness is echoed, and source is one of exactly four legal strings.
  SELECT * INTO v_bad FROM fuzz_out o
   WHERE o.out ? 'raised'
      OR (o.out ->> 'ok')::boolean IS DISTINCT FROM true
      OR ((o.out ->> 'on')::integer > (o.out ->> 'off')::integer) IS DISTINCT FROM true
      OR ((o.out ->> 'off')::integer >= 2) IS DISTINCT FROM true
      OR (o.out ->> 'band' IN ('six_max', 'full_ring')) IS DISTINCT FROM true
      OR (o.out ->> 'handedness')::integer IS DISTINCT FROM o.h
      OR (o.out ->> 'source' IN ('ruleset', 'ruleset_partial', 'default', 'default_after_invalid_config'))
         IS DISTINCT FROM true
   LIMIT 1;
  IF v_bad.n IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: case #% (% at handedness %) with cfg % answered %',
      v_bad.n, v_bad.label, coalesce(v_bad.h::text, 'NULL'), coalesce(v_bad.cfg::text, 'SQL NULL'), v_bad.out;
  END IF;

  -- NON-VACUITY, FOUR WAYS. All four sources are reachable from this matrix, a
  -- whole-valued decimal really is honoured somewhere in it at a value that is
  -- not a band default, and both bands really appear.
  SELECT string_agg(DISTINCT o.out ->> 'source', ',' ORDER BY o.out ->> 'source') INTO v_srcs FROM fuzz_out o;
  IF v_srcs IS DISTINCT FROM 'default,default_after_invalid_config,ruleset,ruleset_partial' THEN
    RAISE EXCEPTION 'FAIL 05: the matrix reaches sources % rather than all four', v_srcs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fuzz_out o
                  WHERE o.label = 'on=whole_dec_24_0 off=whole_dec_16_000'
                    AND (o.out ->> 'on')::integer = 24 AND (o.out ->> 'off')::integer = 16
                    AND o.out ->> 'source' = 'ruleset') THEN
    RAISE EXCEPTION 'FAIL 05: 24.0 / 16.000 is not honoured anywhere in the matrix';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fuzz_out WHERE out ->> 'band' = 'six_max')
     OR NOT EXISTS (SELECT 1 FROM fuzz_out WHERE out ->> 'band' = 'full_ring') THEN
    RAISE EXCEPTION 'FAIL 05: the matrix only ever reaches one band';
  END IF;
END $$;
\echo '  ok  05 THE FUZZ IS GENERATED  every jsonb_typeof in BOTH threshold slots crossed with every other and with ten handednesses including NULL, zero and a negative - objects arrays strings booleans JSON nulls and absent keys, whole-valued decimals at 24.0 and 16.000 and 0.0, non-whole decimals, nine ten and eleven digit integers, int4''s exact boundary on both sides, negatives, -0 and four exponent forms - plus nine configurations that are not objects at all including the SQL NULL every live Cluster carries today: more than ten thousand generated shapes, the count asserted against the product of its own inputs so it cannot quietly shrink, and for EVERY one of them the probe did not raise, answered ok, put ON strictly above OFF, kept OFF at two or more, echoed its handedness, named one of two bands and reported one of exactly four legal sources - measured through a catcher proved to catch a real division by zero, with all four sources reached and 24.0 / 16.000 honoured inside the matrix itself'
ASSERT

# APPENDED TO THE PRE FILE ON PURPOSE, AND LAST. Section 10 compares the
# re-created reader's key set against the set the lobby was ACTUALLY reading
# before the re-create, captured from the running catalogue, rather than
# against a list typed into this harness - a list typed here would drift with
# the same edit that dropped the key. It reads a Cluster with no lightning
# configuration on it, because the configured one raises at this point in the
# file and that is section 01's whole subject.
cat >> "$fixture/pre-assertions.sql" <<'ASSERT'
CREATE TEMP TABLE pre_state_keys AS
  SELECT array_agg(kk ORDER BY kk) AS keys
    FROM jsonb_object_keys(public.fn_cash_cluster_lightning_state(
           (SELECT b.game_id FROM board b WHERE b.k = 'on_must_move'))) AS t(kk);
DO $$
DECLARE v_n integer;
BEGIN
  SELECT array_length(keys, 1) INTO v_n FROM pre_state_keys;
  IF (v_n >= 8) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: the pre-remediation key capture found % key(s), so section 10 would compare nothing', v_n;
  END IF;
END $$;
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 06 source IS PER-FIELD ------------------------------------------------------
-- The first cut reported 'ruleset' whenever EITHER half came from configuration,
-- so an operator who wrote {"on_threshold": "30", "off_threshold": 5} was told
-- 'ruleset' for a pair of 18 and 5 in which the 18 was the band default. That
-- pair passes the hysteresis guard, so nothing else in the system flagged it.
DO $$
DECLARE v_r jsonb;
BEGIN
  -- ruleset: BOTH halves came from configuration.
  v_r := public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 24, "off_threshold": 16}'::jsonb, 6);
  IF v_r ->> 'source' IS DISTINCT FROM 'ruleset'
     OR (v_r ->> 'on')::integer IS DISTINCT FROM 24 OR (v_r ->> 'off')::integer IS DISTINCT FROM 16 THEN
    RAISE EXCEPTION 'FAIL 06: a fully configured pair reports %', v_r;
  END IF;
  -- ruleset_partial: exactly one did, and the other is still the BAND DEFAULT.
  v_r := public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 30}'::jsonb, 6);
  IF v_r ->> 'source' IS DISTINCT FROM 'ruleset_partial'
     OR (v_r ->> 'on')::integer IS DISTINCT FROM 30 OR (v_r ->> 'off')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 06: an ON-only configuration reports %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_lightning_thresholds_probe('{"off_threshold": 16}'::jsonb, 6);
  IF v_r ->> 'source' IS DISTINCT FROM 'ruleset_partial'
     OR (v_r ->> 'on')::integer IS DISTINCT FROM 18 OR (v_r ->> 'off')::integer IS DISTINCT FROM 16 THEN
    RAISE EXCEPTION 'FAIL 06: an OFF-only configuration reports %', v_r;
  END IF;
  -- THE EXACT CASE IN THE MIGRATION'S OWN HEADER: a string and a number. 18 is
  -- the band default and only the 5 is the operator's, and the answer has to
  -- say so.
  v_r := public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": "30", "off_threshold": 5}'::jsonb, 6);
  IF v_r ->> 'source' IS DISTINCT FROM 'ruleset_partial'
     OR (v_r ->> 'on')::integer IS DISTINCT FROM 18 OR (v_r ->> 'off')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 06: {"on_threshold": "30", "off_threshold": 5} reports %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_lightning_thresholds_probe('{"on_threshold": 30, "off_threshold": "12"}'::jsonb, 6);
  IF v_r ->> 'source' IS DISTINCT FROM 'ruleset_partial' THEN
    RAISE EXCEPTION 'FAIL 06: a half-applied configuration still reports itself as fully configured: %', v_r;
  END IF;
  -- default: NEITHER did, whether because the key is absent, the whole object
  -- is absent, or the value is a shape the guard never lets through.
  FOR v_r IN SELECT public.fn_cash_cluster_lightning_thresholds_probe(c, 6)
               FROM unnest(ARRAY['{}', 'null', '{"on_threshold": "30"}', '{"on_threshold": 18.5}',
                                 '{"on_threshold": true}', '{"on_threshold": null}']::jsonb[]) c LOOP
    IF v_r ->> 'source' IS DISTINCT FROM 'default'
       OR (v_r ->> 'on')::integer IS DISTINCT FROM 18 OR (v_r ->> 'off')::integer IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'FAIL 06: an unconfigured pair reports %', v_r;
    END IF;
  END LOOP;
  IF public.fn_cash_cluster_lightning_thresholds_probe(NULL, 6) ->> 'source' IS DISTINCT FROM 'default' THEN
    RAISE EXCEPTION 'FAIL 06: a NULL configuration does not report source default';
  END IF;
  -- default_after_invalid_config: the pair FAILED hysteresis - inverted, equal,
  -- an OFF below two, or a configured value the guard admitted and the rule
  -- refuses.
  FOR v_r IN SELECT public.fn_cash_cluster_lightning_thresholds_probe(c, 6)
               FROM unnest(ARRAY['{"on_threshold": 5, "off_threshold": 9}',
                                 '{"on_threshold": 12, "off_threshold": 12}',
                                 '{"off_threshold": 1}', '{"off_threshold": 0}',
                                 '{"on_threshold": 0}', '{"on_threshold": -5}',
                                 '{"on_threshold": 24, "off_threshold": -0}']::jsonb[]) c LOOP
    IF v_r ->> 'source' IS DISTINCT FROM 'default_after_invalid_config'
       OR (v_r ->> 'on')::integer IS DISTINCT FROM 18 OR (v_r ->> 'off')::integer IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'FAIL 06: a pair that fails hysteresis reports %', v_r;
    END IF;
  END LOOP;
END $$;

-- AND THE SAME RULE, RESTATED INDEPENDENTLY, OVER THE WHOLE GENERATED MATRIX.
-- Four hand-picked cases prove the four values exist; this proves the CHOICE
-- between them is right for every shape section 05 generates, against a second
-- implementation of the rule written here rather than read out of the body
-- under test. It is the assertion that catches a widened or narrowed guard, a
-- moved default and a per-field source that reverted to per-object, on ten
-- thousand shapes at once.
DO $$
DECLARE v_bad record; v_n bigint;
BEGIN
  WITH ev AS (
    SELECT o.n, o.label, o.cfg, o.h, o.out,
           (jsonb_typeof(o.cfg) = 'object'
            AND jsonb_typeof(o.cfg -> 'on_threshold') = 'number'
            AND (o.cfg ->> 'on_threshold') ~ '^-?[0-9]{1,9}(\.0+)?$') AS got_on,
           (jsonb_typeof(o.cfg) = 'object'
            AND jsonb_typeof(o.cfg -> 'off_threshold') = 'number'
            AND (o.cfg ->> 'off_threshold') ~ '^-?[0-9]{1,9}(\.0+)?$') AS got_off,
           CASE WHEN o.h IS NULL OR o.h <= 0 OR o.h > 6 THEN 27 ELSE 18 END AS def_on,
           CASE WHEN o.h IS NULL OR o.h <= 0 OR o.h > 6 THEN 18 ELSE 12 END AS def_off
      FROM fuzz_out o),
  raw AS (
    SELECT ev.*,
           CASE WHEN got_on THEN floor((cfg ->> 'on_threshold')::numeric)::integer ELSE def_on END AS r_on,
           CASE WHEN got_off THEN floor((cfg ->> 'off_threshold')::numeric)::integer ELSE def_off END AS r_off
      FROM ev),
  want AS (
    SELECT raw.*,
           CASE WHEN r_on <= r_off OR r_off < 2 THEN def_on ELSE r_on END AS w_on,
           CASE WHEN r_on <= r_off OR r_off < 2 THEN def_off ELSE r_off END AS w_off,
           CASE WHEN r_on <= r_off OR r_off < 2 THEN 'default_after_invalid_config'
                WHEN got_on AND got_off THEN 'ruleset'
                WHEN got_on OR got_off THEN 'ruleset_partial'
                ELSE 'default' END AS w_source
      FROM raw)
  SELECT * INTO v_bad FROM want
   WHERE (out ->> 'on')::integer IS DISTINCT FROM w_on
      OR (out ->> 'off')::integer IS DISTINCT FROM w_off
      OR (out ->> 'source') IS DISTINCT FROM w_source
      OR (out ->> 'band') IS DISTINCT FROM CASE WHEN h IS NOT NULL AND h > 0 AND h <= 6 THEN 'six_max' ELSE 'full_ring' END
   LIMIT 1;
  IF v_bad.n IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: case #% (%, handedness %) with cfg % answered % where the rule restated says % / % under %',
      v_bad.n, v_bad.label, coalesce(v_bad.h::text, 'NULL'), coalesce(v_bad.cfg::text, 'SQL NULL'),
      v_bad.out, v_bad.w_on, v_bad.w_off, v_bad.w_source;
  END IF;
  -- NON-VACUITY: the restatement really did disagree with something, somewhere,
  -- if the implementation moved - so it has to be exercised over a matrix that
  -- contains cases of all four kinds. Section 05 asserts the four are present;
  -- this asserts the comparison ran over every row rather than over none.
  SELECT count(*) INTO v_n FROM fuzz_out;
  IF (v_n >= 10000::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: the restatement was compared against only % case(s)', v_n;
  END IF;
END $$;
\echo '  ok  06 source IS PER-FIELD    ruleset only when BOTH numbers came from configuration, ruleset_partial when exactly one did with the other left at its own band default - including the migration header''s own {"on_threshold": "30", "off_threshold": 5} answering 18 / 5 as ruleset_partial rather than claiming a pair the operator never wrote - default when neither did whether the key was absent the object was absent the value was a string a boolean a JSON null or a non-whole number, and default_after_invalid_config for seven pairs that fail hysteresis by inversion by equality by an OFF below two and by a negative or zero ON - and then the whole rule RESTATED INDEPENDENTLY in this file and compared against the installed one on every one of the ten thousand generated shapes, value by value and source by source and band by band'

-- 07 BOTH BANDS, FROM THE RULE ITSELF -----------------------------------------
-- The four mandated numbers are asserted as LITERALS, never rederived from the
-- function that is under test, and the boundary is asked from both sides.
-- handedness 6 is six-max; 7 is full ring; NULL, zero and a negative are a
-- MISSING value rather than a small game and take the full-ring default.
DO $$
DECLARE v_r jsonb; h integer;
BEGIN
  FOREACH h IN ARRAY ARRAY[2, 5, 6] LOOP
    v_r := public.fn_cash_cluster_lightning_thresholds_probe(NULL, h);
    IF (v_r ->> 'on')::integer IS DISTINCT FROM 18 OR (v_r ->> 'off')::integer IS DISTINCT FROM 12
       OR v_r ->> 'band' IS DISTINCT FROM 'six_max' THEN
      RAISE EXCEPTION 'FAIL 07: handedness % is not 18 / 12 six_max, it is %', h, v_r;
    END IF;
  END LOOP;
  FOREACH h IN ARRAY ARRAY[7, 8, 9, 12] LOOP
    v_r := public.fn_cash_cluster_lightning_thresholds_probe(NULL, h);
    IF (v_r ->> 'on')::integer IS DISTINCT FROM 27 OR (v_r ->> 'off')::integer IS DISTINCT FROM 18
       OR v_r ->> 'band' IS DISTINCT FROM 'full_ring' THEN
      RAISE EXCEPTION 'FAIL 07: handedness % is not 27 / 18 full_ring, it is %', h, v_r;
    END IF;
  END LOOP;
  FOREACH h IN ARRAY ARRAY[0, -1, -9] LOOP
    v_r := public.fn_cash_cluster_lightning_thresholds_probe(NULL, h);
    IF (v_r ->> 'on')::integer IS DISTINCT FROM 27 OR (v_r ->> 'off')::integer IS DISTINCT FROM 18
       OR v_r ->> 'band' IS DISTINCT FROM 'full_ring' THEN
      RAISE EXCEPTION 'FAIL 07: a handedness of % is not treated as a missing value, it is %', h, v_r;
    END IF;
  END LOOP;
  v_r := public.fn_cash_cluster_lightning_thresholds_probe(NULL, NULL);
  IF (v_r ->> 'on')::integer IS DISTINCT FROM 27 OR (v_r ->> 'off')::integer IS DISTINCT FROM 18
     OR v_r ->> 'band' IS DISTINCT FROM 'full_ring' OR v_r ->> 'handedness' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 07: a NULL handedness is not 27 / 18 full_ring, it is %', v_r;
  END IF;

  -- AND THROUGH A REAL CLUSTER, so that the delegation really passes the row's
  -- own handedness rather than a constant. The fixture seeds the boundary on
  -- both sides of itself.
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE g.ruleset_snapshot -> 'lightning' IS NULL
                AND (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer
                    IS DISTINCT FROM CASE WHEN g.handedness <= 6 THEN 18 ELSE 27 END) THEN
    RAISE EXCEPTION 'FAIL 07: an unconfigured Cluster does not read its own band''s ON default';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE g.ruleset_snapshot -> 'lightning' IS NULL
                AND (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'off')::integer
                    IS DISTINCT FROM CASE WHEN g.handedness <= 6 THEN 12 ELSE 18 END) THEN
    RAISE EXCEPTION 'FAIL 07: an unconfigured Cluster does not read its own band''s OFF default';
  END IF;
  -- NON-VACUITY: the estate really does straddle the boundary, at 6 and at 7.
  IF NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness = 6)
     OR NOT EXISTS (SELECT 1 FROM public.cash_games WHERE handedness = 7) THEN
    RAISE EXCEPTION 'FAIL 07: the handedness 6 / 7 boundary is not populated on both sides';
  END IF;
  -- THE CLUSTER-SHAPED READER CARRIES game_id AND THE PURE ONE DOES NOT.
  IF NOT (public.fn_cash_cluster_lightning_thresholds(
            (SELECT b.game_id FROM board b WHERE b.k = 'on_must_move')) ? 'game_id') THEN
    RAISE EXCEPTION 'FAIL 07: the Cluster-shaped reader dropped game_id';
  END IF;
  IF public.fn_cash_cluster_lightning_thresholds_probe(NULL, 6) ? 'game_id' THEN
    RAISE EXCEPTION 'FAIL 07: the pure rule invented a game_id';
  END IF;
  -- A CLUSTER THAT DOES NOT EXIST ANSWERS rather than raising, on the path a
  -- tick takes.
  v_r := public.fn_cash_cluster_lightning_thresholds('00000000-0000-0000-0000-00000000dead'::uuid);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM false OR v_r ->> 'reason' IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'FAIL 07: a missing Cluster reports % rather than ok false / not_found', v_r;
  END IF;
  IF public.fn_cash_cluster_lightning_state('00000000-0000-0000-0000-00000000dead'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 07: the state reader invents an answer for a Cluster that does not exist';
  END IF;
END $$;
\echo '  ok  07 BOTH BANDS AND THE EDGE  handedness 2, 5 and 6 read 18 / 12 under band six_max and 7, 8, 9 and 12 read 27 / 18 under full_ring with all four numbers asserted as LITERALS rather than rederived, the boundary asked from both sides at 6 and at 7, a NULL a zero and a negative handedness treated as a MISSING value that takes the full-ring default rather than silently landing in the smaller band, every unconfigured Cluster in the estate reading its own band''s pair through the delegation so the row''s handedness really is what is passed, game_id present on the Cluster-shaped answer and absent from the pure one, and a Cluster that does not exist answering ok false / not_found and NULL rather than raising on the path a tick takes'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 08 THE PENDING STATES -------------------------------------------------------
-- The assertion the previous harness could not make, because it never built a
-- Cluster outside must_move. Eight Clusters, four states, both directions, and
-- every FALSE proved to be a statement about the MODE by moving that one
-- Cluster's mode and watching the same population turn the verdict true.
--
-- THE CHECK CONSTRAINT ALREADY ALLOWS ALL OF THIS. cash_games_cluster_mode_check
-- is ('created','opening','must_move','pending_on','lightning','pending_off',
-- 'draining','paused','frozen','dead') - installed by 20260920172736 and
-- mirrored byte for byte by scripts/dev/fixtures/lightning-phase3-remediation-schema.sql -
-- so nothing here widens anything and spec Phase 5 needs no constraint change
-- to drive a conversion through pending_on and pending_off.
DO $$
DECLARE
  g_mm uuid; g_pon uuid; g_lt uuid; g_poff uuid;
  m_on_lt uuid; m_on_poff uuid; m_off_mm uuid; m_off_pon uuid;
BEGIN
  SELECT game_id INTO g_mm      FROM board WHERE k = 'on_must_move';
  SELECT game_id INTO g_pon     FROM board WHERE k = 'on_pending_on';
  SELECT game_id INTO g_lt      FROM board WHERE k = 'off_lightning';
  SELECT game_id INTO g_poff    FROM board WHERE k = 'off_pending_off';
  SELECT game_id INTO m_on_lt   FROM board WHERE k = 'mirror_on_lightning';
  SELECT game_id INTO m_on_poff FROM board WHERE k = 'mirror_on_pending_off';
  SELECT game_id INTO m_off_mm  FROM board WHERE k = 'mirror_off_must_move';
  SELECT game_id INTO m_off_pon FROM board WHERE k = 'mirror_off_pending_on';

  PERFORM public.fx_mode(g_pon, 'pending_on');
  PERFORM public.fx_mode(g_lt, 'lightning');
  PERFORM public.fx_mode(g_poff, 'pending_off');
  PERFORM public.fx_mode(m_on_lt, 'lightning');
  PERFORM public.fx_mode(m_on_poff, 'pending_off');
  PERFORM public.fx_mode(m_off_pon, 'pending_on');

  -- NON-VACUITY FIRST: the populations really are what the rest of this section
  -- reasons about, on a band whose thresholds are 18 and 12.
  IF public.fx_live(g_mm) IS DISTINCT FROM 18 OR public.fx_live(g_pon) IS DISTINCT FROM 18
     OR public.fx_live(g_lt) IS DISTINCT FROM 5 OR public.fx_live(g_poff) IS DISTINCT FROM 5
     OR public.fx_live(m_on_lt) IS DISTINCT FROM 20 OR public.fx_live(m_on_poff) IS DISTINCT FROM 20
     OR public.fx_live(m_off_mm) IS DISTINCT FROM 5 OR public.fx_live(m_off_pon) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 08: the eight Clusters are not at the populations this section needs';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games g
              WHERE g.id IN (g_mm, g_pon, g_lt, g_poff, m_on_lt, m_on_poff, m_off_mm, m_off_pon)
                AND (public.fn_cash_cluster_lightning_thresholds(g.id) ->> 'on')::integer IS DISTINCT FROM 18) THEN
    RAISE EXCEPTION 'FAIL 08: one of the eight Clusters is not on the 18 / 12 band';
  END IF;

  -- THE ON SIDE ANSWERS IN BOTH STATES THE SPECIFICATION ASKS IT IN.
  IF public.fx_verdict(g_mm, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a must_move Cluster at 18 does not say it would turn on';
  END IF;
  IF public.fx_verdict(g_pon, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a PENDING_ON Cluster at 18 does not say it would turn on - spec Phase 5 would abort every conversion at step 11';
  END IF;
  -- AND THE OFF SIDE IN BOTH OF ITS OWN.
  IF public.fx_verdict(g_lt, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a lightning Cluster at 5 does not say it would turn off';
  END IF;
  IF public.fx_verdict(g_poff, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a PENDING_OFF Cluster at 5 does not say it would turn off - a recovered population could never cancel the drain';
  END IF;

  -- THE MIRROR, AND IT IS NOT VACUOUS. Each of these is OVER the threshold the
  -- other side reads, so the false below can only be about the mode.
  IF public.fx_verdict(m_on_lt, 'would_turn_on')::boolean IS DISTINCT FROM false
     OR public.fx_verdict(m_on_poff, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: a Cluster already in lightning or pending_off says it would turn ON';
  END IF;
  IF public.fx_verdict(m_off_mm, 'would_turn_off')::boolean IS DISTINCT FROM false
     OR public.fx_verdict(m_off_pon, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: a Cluster in must_move or pending_on says it would turn OFF';
  END IF;
  -- MOVE THE MODE AND NOTHING ELSE, AND THE SAME POPULATION FLIPS IT.
  PERFORM public.fx_mode(m_on_lt, 'must_move');
  IF public.fx_verdict(m_on_lt, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the ON mirror was false for a reason other than its mode';
  END IF;
  PERFORM public.fx_mode(m_on_lt, 'lightning');
  PERFORM public.fx_mode(m_on_poff, 'pending_on');
  IF public.fx_verdict(m_on_poff, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the second ON mirror was false for a reason other than its mode';
  END IF;
  PERFORM public.fx_mode(m_on_poff, 'pending_off');
  PERFORM public.fx_mode(m_off_mm, 'lightning');
  IF public.fx_verdict(m_off_mm, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the OFF mirror was false for a reason other than its mode';
  END IF;
  PERFORM public.fx_mode(m_off_mm, 'must_move');
  PERFORM public.fx_mode(m_off_pon, 'pending_off');
  IF public.fx_verdict(m_off_pon, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the second OFF mirror was false for a reason other than its mode';
  END IF;
  PERFORM public.fx_mode(m_off_pon, 'pending_on');

  -- THE WIDENING IS EXACTLY ONE STATE ON EACH SIDE, not "any state". draining
  -- and paused are in the same vocabulary and must still answer false on both
  -- sides, at populations that would otherwise make both true.
  PERFORM public.fx_mode(m_on_lt, 'draining');
  IF public.fx_verdict(m_on_lt, 'would_turn_on')::boolean IS DISTINCT FROM false
     OR public.fx_verdict(m_on_lt, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: a draining Cluster answers a verdict the specification does not ask there';
  END IF;
  PERFORM public.fx_mode(m_on_lt, 'lightning');
  PERFORM public.fx_mode(m_off_mm, 'paused');
  IF public.fx_verdict(m_off_mm, 'would_turn_on')::boolean IS DISTINCT FROM false
     OR public.fx_verdict(m_off_mm, 'would_turn_off')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: a paused Cluster answers a verdict the specification does not ask there';
  END IF;
  PERFORM public.fx_mode(m_off_mm, 'must_move');
END $$;
\echo '  ok  08 THE PENDING STATES     four Clusters one in each of must_move, pending_on, lightning and pending_off, each at a population that should make its verdict true: would_turn_on is true in must_move AND in PENDING_ON at 18, would_turn_off is true in lightning AND in PENDING_OFF at 5, and the mirror holds on four more Clusters built OVER the other side''s threshold so the false is about the mode and nothing else - proved by moving that one Cluster''s mode, watching the same population flip the verdict true, and moving it back - with draining and paused still answering false on both sides so the widening is exactly one state on each side rather than any state at all, and cash_games_cluster_mode_check already admitting all ten states so nothing here had to be widened'

-- 09 would_turn_off IS NOT GATED ON enabled, AND would_turn_on IS -------------
-- Deliberate and asymmetric: a disabled Cluster must not be allowed INTO
-- Lightning and must always be allowed to drain OUT of it. A harness that only
-- asserted the ON half would be green for a body that gated both.
DO $$
DECLARE g_over uuid; g_under uuid; g_mm uuid;
BEGIN
  SELECT game_id INTO g_over  FROM board WHERE k = 'disabled_over_on';
  SELECT game_id INTO g_under FROM board WHERE k = 'disabled_under_off';
  SELECT game_id INTO g_mm    FROM board WHERE k = 'on_must_move';
  PERFORM public.fx_mode(g_under, 'lightning');

  -- NON-VACUITY: both are really disabled, and really at the populations that
  -- would otherwise decide each verdict.
  IF EXISTS (SELECT 1 FROM public.cash_games WHERE id IN (g_over, g_under) AND enabled) THEN
    RAISE EXCEPTION 'FAIL 09: the disabled Clusters are not disabled';
  END IF;
  IF public.fx_live(g_over) IS DISTINCT FROM 20 OR public.fx_live(g_under) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 09: the disabled Clusters are at % and % rather than 20 and 5',
      public.fx_live(g_over), public.fx_live(g_under);
  END IF;

  -- A DISABLED CLUSTER OVER THE ON THRESHOLD MUST NOT BE ALLOWED IN.
  IF public.fx_verdict(g_over, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 09: a DISABLED Cluster at 20 says it would turn Lightning on';
  END IF;
  -- And enabling it - one column, nothing else - turns it true, so the false
  -- above was about `enabled`.
  UPDATE public.cash_games SET enabled = true WHERE id = g_over;
  IF public.fx_verdict(g_over, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the disabled ON verdict was false for a reason other than enabled';
  END IF;
  UPDATE public.cash_games SET enabled = false WHERE id = g_over;

  -- A DISABLED CLUSTER UNDER THE OFF THRESHOLD MUST ALWAYS BE ALLOWED OUT.
  IF public.fx_verdict(g_under, 'would_turn_off')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: a DISABLED Cluster in lightning at 5 cannot drain out, which is the one thing it must always be able to do';
  END IF;

  -- AND lightning_enabled GATES THE ON SIDE TOO, separately from enabled.
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = g_mm;
  IF public.fx_verdict(g_mm, 'would_turn_on')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 09: a Cluster with lightning_enabled false at 18 says it would turn on';
  END IF;
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = g_mm;
  IF public.fx_verdict(g_mm, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the lightning_enabled gate did not reopen';
  END IF;
END $$;
\echo '  ok  09 THE enabled ASYMMETRY  a DISABLED Cluster at 20 over an ON threshold of 18 says would_turn_on false and says true the moment `enabled` alone is flipped, a DISABLED Cluster in lightning at 5 under an OFF threshold of 12 says would_turn_off TRUE because a disabled Cluster must always be allowed to drain out, and lightning_enabled gates the ON side separately with the gate proved shut and reopened on one Cluster at one population'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 10 TEN KEYS, AND THEY ARE THE SAME TEN --------------------------------------
-- fn_cash_game_lobby embeds this object whole, so a re-create that silently
-- dropped or renamed one would be invisible until a client read it. The count
-- alone cannot see a rename, so the KEY SET is asserted - on every Cluster in
-- the estate, and against the set captured from the running catalogue before
-- the re-create rather than against a list typed into this harness.
DO $$
DECLARE v_pre text[]; v_bad uuid; v_keys text[];
BEGIN
  SELECT keys INTO v_pre FROM pre_state_keys;
  IF v_pre IS DISTINCT FROM ARRAY['cluster_epoch','cluster_mode','enabled','game_id','handedness',
                                  'lightning_enabled','must_move','open_cluster_sessions',
                                  'thresholds','verdict']::text[] THEN
    RAISE EXCEPTION 'FAIL 10: the key set captured before the re-create is %, not the ten the lobby was reading', v_pre;
  END IF;
  -- EVERY CLUSTER, so this cannot pass on a lucky row.
  SELECT g.id, k.keys INTO v_bad, v_keys
    FROM public.cash_games g,
         LATERAL (SELECT array_agg(kk ORDER BY kk) AS keys
                    FROM jsonb_object_keys(public.fn_cash_cluster_lightning_state(g.id)) AS t(kk)) k
   WHERE k.keys IS DISTINCT FROM v_pre
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 10: Cluster % reports the key set % rather than the ten the lobby had', v_bad, v_keys;
  END IF;
  -- AND THE TWO NESTED OBJECTS, which the top-level count cannot see at all: a
  -- dropped `confidence` or a renamed `to_off` leaves the ten intact.
  SELECT g.id, k.keys INTO v_bad, v_keys
    FROM public.cash_games g,
         LATERAL (SELECT array_agg(kk ORDER BY kk) AS keys
                    FROM jsonb_object_keys(public.fn_cash_cluster_lightning_state(g.id) -> 'verdict') AS t(kk)) k
   WHERE k.keys IS DISTINCT FROM ARRAY['confidence','live_eligible','to_off','to_on',
                                       'would_turn_off','would_turn_on']::text[]
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 10: Cluster %''s verdict reports the key set % rather than its own six', v_bad, v_keys;
  END IF;
  SELECT g.id, k.keys INTO v_bad, v_keys
    FROM public.cash_games g,
         LATERAL (SELECT array_agg(kk ORDER BY kk) AS keys
                    FROM jsonb_object_keys(public.fn_cash_cluster_lightning_state(g.id) -> 'thresholds') AS t(kk)) k
   WHERE k.keys IS DISTINCT FROM ARRAY['band','game_id','handedness','off','ok','on','rejected','source']::text[]
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 10: Cluster %''s thresholds report the key set % rather than its own eight', v_bad, v_keys;
  END IF;
  -- NON-VACUITY: there is an estate to have asserted this over.
  IF (SELECT count(*) FROM public.cash_games) < 15::bigint THEN
    RAISE EXCEPTION 'FAIL 10: only % Cluster(s) exist, so "every Cluster" is almost none', (SELECT count(*) FROM public.cash_games);
  END IF;
END $$;
\echo '  ok  10 TEN KEYS, THE SAME TEN  the re-created reader''s key set is asserted as a SET rather than as a count so a rename cannot pass, on every Cluster in the estate, against the ten keys captured from the running catalogue BEFORE the re-create - cluster_epoch cluster_mode enabled game_id handedness lightning_enabled must_move open_cluster_sessions thresholds verdict - and the two nested objects the top-level count cannot see are pinned too, the verdict''s own six and the thresholds'' own eight, rejected among them'

-- 11 LANGUAGE plpgsql, FROM THE CATALOGUE -------------------------------------
-- Read from pg_proc.prolang rather than from the file, because the file is not
-- what answers. Section 01 asserted the same column said `sql` before the
-- remediation was applied, so this is a change rather than a coincidence.
DO $$
DECLARE f text; v_lang text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_cash_cluster_lightning_state(uuid)',
                           'public.fn_cash_cluster_lightning_thresholds(uuid)',
                           'public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'] LOOP
    SELECT l.lanname INTO v_lang FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = f::regprocedure;
    IF v_lang IS DISTINCT FROM 'plpgsql' THEN
      RAISE EXCEPTION 'FAIL 11: % is LANGUAGE % rather than plpgsql, so it plans a fresh tree on every call', f, v_lang;
    END IF;
  END LOOP;
  -- AND THE OTHER THREE PROPERTIES THE HEADER CLAIMS, from the same row.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'::regprocedure
                    AND p.provolatile = 'i' AND p.prosecdef = false
                    AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'FAIL 11: the probe is not IMMUTABLE SECURITY INVOKER with a pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_cash_cluster_lightning_state(uuid)'::regprocedure
                    AND p.provolatile = 's' AND p.prosecdef = false) THEN
    RAISE EXCEPTION 'FAIL 11: the state reader is not STABLE SECURITY INVOKER';
  END IF;
END $$;
\echo '  ok  11 LANGUAGE plpgsql       all three functions read plpgsql out of pg_proc.prolang rather than out of the file, where section 01 read `sql` for the state reader against the body 20260921064717 installed, with the probe also IMMUTABLE SECURITY INVOKER on a pinned search_path and the state reader STABLE SECURITY INVOKER'

-- 12 THE NUMBER DID NOT MOVE --------------------------------------------------
-- A re-create is an opportunity for the answer to change by accident. Every
-- field of the object is recomputed here from its own inputs, on every Cluster,
-- including the two the audit never mentioned - open_cluster_sessions, which is
-- its own statement, and the whole thresholds object, which must be the
-- delegation's own answer rather than a copy that has drifted.
INSERT INTO public.cash_player_session
  (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, cluster_id)
SELECT gen_random_uuid(), g.club_id, 'cluster', g.id, b.table_id, g.variant, g.sb, g.bb, g.id
  FROM board b JOIN public.cash_games g ON g.id = b.game_id, generate_series(1, 2) s
 WHERE b.k = 'blocker';

DO $$
DECLARE v_bad record; v_n bigint;
BEGIN
  SELECT g.id AS gid, x.st AS st, x.live AS live INTO v_bad
    FROM public.cash_games g,
         LATERAL (SELECT public.fn_cash_cluster_lightning_state(g.id) AS st,
                         public.fn_cash_cluster_lightning_thresholds(g.id) AS th,
                         public.fn_cash_cluster_live_eligible(g.id) AS live) x
   WHERE (x.st -> 'verdict' ->> 'live_eligible')::integer IS DISTINCT FROM x.live
      OR (x.st -> 'verdict' ->> 'to_on')::integer
         IS DISTINCT FROM GREATEST(0, (x.th ->> 'on')::integer - x.live)
      OR (x.st -> 'verdict' ->> 'to_off')::integer
         IS DISTINCT FROM GREATEST(0, x.live - (x.th ->> 'off')::integer)
      OR (x.st -> 'verdict' ->> 'confidence') IS DISTINCT FROM 'partial'
      OR x.st -> 'thresholds' IS DISTINCT FROM x.th
      OR (x.st ->> 'game_id')::uuid IS DISTINCT FROM g.id
      OR (x.st ->> 'cluster_mode') IS DISTINCT FROM g.cluster_mode
      OR (x.st ->> 'cluster_epoch')::integer IS DISTINCT FROM g.cluster_epoch
      OR (x.st ->> 'lightning_enabled')::boolean IS DISTINCT FROM g.lightning_enabled
      OR (x.st ->> 'must_move')::boolean IS DISTINCT FROM g.must_move
      OR (x.st ->> 'enabled')::boolean IS DISTINCT FROM g.enabled
      OR (x.st ->> 'handedness')::integer IS DISTINCT FROM g.handedness
      OR (x.st ->> 'open_cluster_sessions')::integer IS DISTINCT FROM
         (SELECT count(*)::integer FROM public.cash_player_session s
           WHERE s.cluster_id = g.id AND s.closed_at IS NULL)
   LIMIT 1;
  IF v_bad.gid IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12: Cluster % disagrees with its own inputs at a population of %: %',
      v_bad.gid, v_bad.live, v_bad.st;
  END IF;

  -- NON-VACUITY, FOUR WAYS. An estate of empty Clusters satisfies every
  -- identity above, so each term has to be non-zero somewhere.
  SELECT count(*) INTO v_n FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) > 0;
  IF (v_n >= 8::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: only % Cluster(s) have any population at all', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'to_on')::integer > 0;
  IF (v_n >= 1::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: no Cluster has any distance left to the ON threshold, so to_on proved nothing';
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'to_off')::integer > 0;
  IF (v_n >= 1::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: no Cluster is above its OFF threshold, so to_off proved nothing';
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) ->> 'open_cluster_sessions')::integer > 0;
  IF (v_n >= 1::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: no Cluster has an open cash_player_session, so open_cluster_sessions proved nothing';
  END IF;
END $$;
\echo '  ok  12 THE NUMBER DID NOT MOVE  on every Cluster in the estate the verdict''s live_eligible is exactly fn_cash_cluster_live_eligible, to_on is GREATEST(0, ON - live) and to_off is GREATEST(0, live - OFF) recomputed from the thresholds reader''s own answer, the embedded thresholds object is byte-identical to that reader, confidence is partial, open_cluster_sessions is the real count of open cash_player_session rows for the Cluster and the seven scalars are the row''s own columns - with a population on at least eight Clusters and a non-zero to_on, to_off and open_cluster_sessions somewhere, so none of those identities is satisfied by an empty estate'

-- 13 GRANTS, IN BOTH DIRECTIONS ------------------------------------------------
-- A check of the negative half alone stays green when the whole family is
-- unreachable by every role, which is its own outage.
DO $$
DECLARE f text; v_n bigint;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)',
                           'public.fn_cash_cluster_lightning_thresholds(uuid)',
                           'public.fn_cash_cluster_lightning_state(uuid)'] LOOP
    IF has_function_privilege('anon', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 13: anon can execute %', f;
    END IF;
    IF has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 13: authenticated can execute %', f;
    END IF;
    IF NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 13: service_role CANNOT execute %, so the family is unreachable', f;
    END IF;
    -- PUBLIC is not a role has_function_privilege can be asked about: an ACL
    -- entry granted to PUBLIC is one whose grantee is empty, and a NULL acl is
    -- the owner default, which grants EXECUTE to PUBLIC implicitly.
    IF (SELECT p.proacl FROM pg_proc p WHERE p.oid = f::regprocedure) IS NULL THEN
      RAISE EXCEPTION 'FAIL 13: % carries the owner default acl, which grants EXECUTE to PUBLIC', f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proacl) a
                WHERE p.oid = f::regprocedure AND a::text LIKE '=%') THEN
      RAISE EXCEPTION 'FAIL 13: % still carries a grant to PUBLIC', f;
    END IF;
  END LOOP;

  -- AND THROUGH THE VIEW THE MIGRATION'S OWN PROOF READS, both halves.
  SELECT count(*) INTO v_n FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name IN ('fn_cash_cluster_lightning_thresholds', 'fn_cash_cluster_lightning_state',
                          'fn_cash_cluster_lightning_thresholds_probe')
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 13: % grant(s) to anon, authenticated or PUBLIC are listed', v_n;
  END IF;
  SELECT count(DISTINCT routine_name) INTO v_n FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name IN ('fn_cash_cluster_lightning_thresholds', 'fn_cash_cluster_lightning_state',
                          'fn_cash_cluster_lightning_thresholds_probe')
     AND grantee = 'service_role' AND privilege_type = 'EXECUTE';
  IF v_n IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL 13: service_role is listed with EXECUTE on % of the three functions', v_n;
  END IF;
END $$;
\echo '  ok  13 GRANTS BOTH WAYS       none of the three functions is executable by anon or by authenticated, none carries an acl entry granted to PUBLIC and none carries the owner default acl that would grant EXECUTE to PUBLIC implicitly, and all three are executable by service_role - asserted through has_function_privilege, through pg_proc.proacl and through the information_schema view the migration''s own last proof reads, with the positive half counted as three'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- WHAT THE SECOND APPLICATION AND THE @live-proof BLOCK NEED PUT BACK ---------
-- Two demands, both about the DATA rather than about the code, and the boards
-- are not one of them:
--
--   EVERY CLUSTER IS must_move. The migration's post-apply block counts that
--   and refuses at anything else, because this is a phase that converts
--   nothing, and section 08 deliberately left four Clusters elsewhere.
--
--   NO CLUSTER WOULD TURN ON. One of the file's own @live-proof lines asserts
--   `NOT EXISTS (... would_turn_on)`, which is true of the live estate because
--   no Cluster there is anywhere near its threshold, and false here because
--   section 08 built four that are. That is a statement about POPULATION, so
--   the populations come down rather than the proof being quarantined: every
--   Cluster is drained to at most twelve seated, which is below the lowest ON
--   threshold any Cluster in this estate carries (18).
--
-- AND THE BOARDS STAY. The second application's whole read-back then runs over
-- a real estate - eighteen Clusters, hundreds of chairs, open cash_player
-- sessions and a badly typed {"on_threshold": 18.0} still installed on one of
-- them, which is a far better test of that read-back than an empty one.
UPDATE public.cash_games SET cluster_mode = 'must_move' WHERE cluster_mode <> 'must_move';
WITH ranked AS (
  SELECT ts.id, row_number() OVER (PARTITION BY tb.cluster_id ORDER BY ts.joined_at, ts.id) AS rn
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.left_at IS NULL)
UPDATE public.table_seats ts SET left_at = clock_timestamp()
  FROM ranked r WHERE r.id = ts.id AND r.rn > 12;

DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games WHERE cluster_mode <> 'must_move';
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL teardown: % Cluster(s) are not must_move', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE (public.fn_cash_cluster_lightning_state(g.id) -> 'verdict' ->> 'would_turn_on')::boolean;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL teardown: % Cluster(s) would still turn on, and the migration proves that none do', v_n;
  END IF;
  -- NON-VACUITY FOR EVERYTHING THAT FOLLOWS: the estate is still standing and
  -- still populated, so the @live-proof block and the second read-back have
  -- something real to run over.
  SELECT count(*) INTO v_n FROM public.table_seats WHERE left_at IS NULL;
  IF (v_n >= 80::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: only % chair(s) are standing, so the second read-back runs over almost nothing', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games g WHERE public.fn_cash_cluster_live_eligible(g.id) > 0;
  IF (v_n >= 8::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: only % Cluster(s) have a population left', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.cash_games WHERE ruleset_snapshot -> 'lightning' IS NOT NULL;
  IF (v_n >= 1::bigint) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL teardown: the badly typed configuration is gone, and the second application is meant to read back over one';
  END IF;
END $$;

-- WHAT THE SECOND APPLICATION MUST NOT CHANGE. Three bodies, three access
-- control lists, three comments - and the ANSWERS, which is where Phase 2's
-- remediation failed: a REPLACE that landed a different body exits 0.
CREATE TEMP TABLE pre_reapply_fn AS
  SELECT p.fn,
         pg_get_functiondef(p.fn::regprocedure) AS def,
         coalesce((SELECT string_agg(x::text, E'\n' ORDER BY x::text) FROM unnest(pr.proacl) x),
                  '<owner default>') AS acl,
         coalesce(obj_description(p.fn::regprocedure, 'pg_proc'), '<none>') AS cmt
    FROM (VALUES
      ('public.fn_cash_cluster_lightning_thresholds_probe(jsonb,integer)'),
      ('public.fn_cash_cluster_lightning_thresholds(uuid)'),
      ('public.fn_cash_cluster_lightning_state(uuid)')) AS p(fn)
    JOIN pg_proc pr ON pr.oid = p.fn::regprocedure;

CREATE TEMP TABLE pre_reapply_answers AS
  SELECT g.id,
         public.fn_cash_cluster_lightning_state(g.id) AS st,
         public.fn_cash_cluster_lightning_thresholds(g.id) AS th
    FROM public.cash_games g;
CREATE TEMP TABLE pre_reapply_fuzz AS SELECT n, out FROM fuzz_out;
CREATE TEMP TABLE pre_reapply_games AS SELECT * FROM public.cash_games;
CREATE TEMP TABLE pre_reapply_seats AS SELECT * FROM public.table_seats;
CREATE TEMP TABLE pre_reapply_counts AS
  SELECT (SELECT count(*) FROM pre_reapply_fn)      AS fns,
         (SELECT count(*) FROM pre_reapply_answers) AS answers,
         (SELECT count(*) FROM pre_reapply_fuzz)    AS fuzz,
         (SELECT count(*) FROM public.cash_games)   AS games,
         (SELECT count(*) FROM public.table_seats)  AS seats;
ASSERT

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'

-- 15 RE-APPLY IS A NO-OP ------------------------------------------------------
-- Everything in the file is CREATE OR REPLACE, so a second application is
-- expected to be silent - but "it exited 0" is not the question. Phase 2's
-- remediation exited 0 and failed here. A REPLACE that landed a different body,
-- a REVOKE/GRANT pair that left a different access control list, a COMMENT that
-- drifted or an ANSWER that moved would all exit 0, and all four are the kind
-- of difference that turns up months later as "the function on production is
-- not the function in the file".
DO $$
DECLARE c pre_reapply_counts%ROWTYPE; v_bad text; v_n bigint;
BEGIN
  SELECT * INTO c FROM pre_reapply_counts;
  IF c.fns IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL 15: % function bodies were captured, not the three this migration writes', c.fns;
  END IF;
  IF (c.answers >= 15::bigint AND c.fuzz >= 10000::bigint AND c.seats >= 80::bigint)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 15: the capture is too thin (answers % / fuzz % / seats %), so "nothing moved" compares almost nothing',
      c.answers, c.fuzz, c.seats;
  END IF;

  -- THE THREE BODIES, BYTE FOR BYTE, and the three acls and three comments.
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad FROM pre_reapply_fn p
   WHERE pg_get_functiondef(p.fn::regprocedure) IS DISTINCT FROM p.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the second application changed the body of %', v_bad;
  END IF;
  SELECT string_agg(p.fn, ', ' ORDER BY p.fn) INTO v_bad FROM pre_reapply_fn p
   WHERE coalesce((SELECT string_agg(x::text, E'\n' ORDER BY x::text)
                     FROM pg_proc pr, unnest(pr.proacl) x WHERE pr.oid = p.fn::regprocedure),
                  '<owner default>') IS DISTINCT FROM p.acl
      OR coalesce(obj_description(p.fn::regprocedure, 'pg_proc'), '<none>') IS DISTINCT FROM p.cmt;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the second application changed the acl or the comment of %', v_bad;
  END IF;

  -- AND THE ANSWERS ARE IDENTICAL, which is the half that a byte-comparison of
  -- the text cannot see if the text was right and the data moved under it.
  SELECT count(*) INTO v_n FROM pre_reapply_answers a
   WHERE public.fn_cash_cluster_lightning_state(a.id) IS DISTINCT FROM a.st
      OR public.fn_cash_cluster_lightning_thresholds(a.id) IS DISTINCT FROM a.th;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 15: % Cluster(s) answer differently after the second application', v_n;
  END IF;
  -- Including on every one of the ten thousand generated configurations.
  SELECT count(*) INTO v_n FROM pre_reapply_fuzz f JOIN fuzz_case q ON q.n = f.n
   WHERE public.fx_try_probe(q.cfg, q.h) IS DISTINCT FROM f.out;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 15: % generated configuration(s) answer differently after the second application', v_n;
  END IF;

  -- AND NO ROW MOVED.
  IF EXISTS (SELECT * FROM pre_reapply_games EXCEPT SELECT * FROM public.cash_games)
     OR EXISTS (SELECT * FROM public.cash_games EXCEPT SELECT * FROM pre_reapply_games) THEN
    RAISE EXCEPTION 'FAIL 15: a cash_games row changed on the second application';
  END IF;
  IF EXISTS (SELECT * FROM pre_reapply_seats EXCEPT SELECT * FROM public.table_seats)
     OR EXISTS (SELECT * FROM public.table_seats EXCEPT SELECT * FROM pre_reapply_seats) THEN
    RAISE EXCEPTION 'FAIL 15: a table_seats row changed on the second application';
  END IF;
END $$;

-- AND THE FUNCTIONS STILL WORK AFTER IT. Three identical bodies prove the text
-- did not move; this proves the text is still the thing that answers.
DO $$
DECLARE v_g uuid; v_got text;
BEGIN
  SELECT game_id INTO v_g FROM board WHERE k = 'blocker';
  v_got := public.fx_try_thresholds(v_g, '{"on_threshold": 24.0, "off_threshold": 16.000}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 24/16 ruleset' THEN
    RAISE EXCEPTION 'FAIL 15: after the second application a whole-valued configuration reports %', v_got;
  END IF;
  v_got := public.fx_try_thresholds(v_g, '{"on_threshold": 18.0}'::jsonb);
  IF v_got IS DISTINCT FROM 'answered 18/12 ruleset_partial' THEN
    RAISE EXCEPTION 'FAIL 15: after the second application {"on_threshold": 18.0} reports %', v_got;
  END IF;
  IF public.fx_try_lobby(v_g) LIKE 'raised%' THEN
    RAISE EXCEPTION 'FAIL 15: after the second application the lobby raises again';
  END IF;
  SELECT game_id INTO v_g FROM board WHERE k = 'on_pending_on';
  PERFORM public.fx_populate(v_g, 18);
  PERFORM public.fx_mode(v_g, 'pending_on');
  IF public.fx_verdict(v_g, 'would_turn_on')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 15: after the second application a pending_on Cluster at 18 is blind again';
  END IF;
  PERFORM public.fx_mode(v_g, 'must_move');
  PERFORM public.fx_populate(v_g, 5);
END $$;
\echo '  ok  15 RE-APPLY IS A NO-OP    the migration applied a SECOND time over the standing estate - eighteen Clusters, eighty-odd chairs, open cash_player sessions and a badly typed {"on_threshold": 18.0} still installed on one of them - left all three function bodies byte-identical along with their three access control lists and their three comments, changed no cash_games and no table_seats row, and ANSWERED IDENTICALLY: every Cluster''s whole state object and threshold object unchanged and all ten thousand generated configurations unchanged, with the functions still working afterwards - 24.0 / 16.000 honoured, 18.0 honoured as 18, the lobby not raising and a pending_on Cluster at 18 still saying it would turn on'
REAPPLY

# 14 EVERY @live-proof THE MIGRATION MAKES, EVALUATED ---------------------------
# The migration ends its header with a block of `-- @live-proof:` lines: scalar
# SQL expressions meant to be true of the database the file produces. They are
# COMMENTS, so nothing in a psql run evaluates them, and 20260921064717 shipped
# three that were false in three separate rounds - every one of them the proof
# drifting away from code that was right.
#
# Generated from the file under test rather than written by hand, for the same
# reason this harness applies the real predecessor migrations rather than
# transcribing them: a hand-copied list is a second place for a proof to drift,
# and drift is the only thing this section exists to catch. The mechanism is
# section 22 of scripts/dev/test-lightning-phase4-population.sh, copied exactly:
# each expression is inlined as CODE rather than as a string literal, so nothing
# in it needs escaping and a proof that no longer PARSES fails the run too.
#
# It runs AFTER the teardown - where every Cluster is must_move again and none
# is over its ON threshold, both of which two of these proofs assert - and
# BEFORE the second application, so what it reads is the catalogue and the
# estate the FIRST application left behind, every board still standing and one
# of them still carrying the badly typed configuration that started all this.
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

if [ "$proof_n" -lt 15 ]; then
  echo "FAIL 14: only $proof_n @live-proof line(s) were found in $migration, so this section would prove almost nothing"
  exit 1
fi

{
  printf '%s\n' 'DO $lp$'
  printf '%s\n' 'DECLARE v_bad text; v_n integer;'
  printf '%s\n' 'BEGIN'
  printf '%s%s%s\n' '  SELECT count(*)::integer INTO v_n FROM lp; IF v_n IS DISTINCT FROM ' "$proof_n" ' THEN'
  printf '%s%s%s\n' "    RAISE EXCEPTION 'FAIL 14: % of the " "$proof_n" " proof expressions were evaluated', v_n;"
  printf '%s\n' '  END IF;'
  printf '%s\n' '  -- NON-VACUITY: a run in which every proof answered NULL would coalesce to'
  printf '%s\n' '  -- false and fail below, and a run in which the table was empty fails above.'
  printf '%s\n' "  SELECT string_agg('#' || n || ' (line ' || lineno || ' of the migration)', ', ' ORDER BY n) INTO v_bad"
  printf '%s\n' '    FROM lp WHERE ok IS DISTINCT FROM true;'
  printf '%s\n' '  IF v_bad IS NOT NULL THEN'
  printf '%s\n' "    RAISE EXCEPTION 'FAIL 14: the migration carries @live-proof % that is NOT true of the database it just produced', v_bad;"
  printf '%s\n' '  END IF;'
  printf '%s\n' 'END $lp$;'
  printf '%s%s%s\n' "\\echo '  ok  14 EVERY LIVE PROOF    all " "$proof_n" " @live-proof expressions the migration carries in its own header were extracted from the file under test, inlined as code so that one which no longer PARSES is a failure too, and evaluated against the throwaway catalogue and the estate the first application left behind - every board still standing, a badly typed configuration still installed on one Cluster - and every single one of them is true, with no quarantine and no exception list'"
} >> "$fixture/live-proofs.sql"

# ONE psql session, thirteen files: the two fixtures, the four predecessor
# migrations, 20260921064717, the PRE-remediation assertions that prove the
# blocker was real, the remediation, the POST assertions, the migration's own
# @live-proofs, the migration AGAIN and the re-apply assertions. One session
# because the Clusters built before the remediation are the rows asserted on
# after it, because the @live-proof block must see the estate the first
# application left behind, and because the pre-re-apply capture has to be a TEMP
# table in the same backend the second application lands in.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres \
  -f "$base_fixture" \
  -f "$delta_fixture" \
  -f "$phase2" \
  -f "$phase2r" \
  -f "$phase3" \
  -f "$phase3r" \
  -f "$phase4" \
  -f "$fixture/pre-assertions.sql" \
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

# FIFTEEN SECTIONS REPORTED, and the count is asserted rather than eyeballed: a
# psql that stopped early exits non-zero, but a section deleted from this file
# during a refactor would not, and the PASS line below would still print.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 15 ]; then
  echo "FAIL: $oks of the 15 sections reported, so this run proved less than this file claims"
  exit 1
fi

echo "PASS: Lightning Phase 4 remediation, a threshold reader that never raises and a verdict that can see the pending states, 15 checks: THE BLOCKER IS REAL - against the body 20260921064717 actually installed, {\"on_threshold\": 18.0} raises 22P02 out of fn_cash_cluster_lightning_thresholds and so do 18.5, 2147483648 (22003) and 1e300 (22003), and the 18.0 travels up through fn_cash_cluster_lightning_state and out of SECURITY DEFINER fn_cash_game_lobby, while a well-typed pair answers through both - THE VERDICT WAS BLIND - a must_move Cluster at 18 says would_turn_on true while an identical pending_on Cluster says false, and a lightning Cluster at 5 says would_turn_off true while an identical pending_off Cluster says false - and then, after the remediation: the same four values ANSWER, 18.0 honoured AS 18 under source ruleset_partial and the other three falling back to the mandated band defaults with the honouring proved at 24.0 / 16.000 where the value is not the default, eighteen badly typed configurations installed in turn on a real Cluster and the lobby never raising once while carrying the state reader's own object byte for byte, more than ten thousand GENERATED configurations - every jsonb_typeof in both slots crossed with each other and with ten handednesses including NULL zero and a negative, whole-valued decimals, non-whole decimals, nine ten and eleven digit integers, int4's boundary on both sides, negatives, -0 and four exponent forms - none of which raises and all of which answer ON above OFF with OFF at two or more and one of four legal sources, the whole rule restated independently in the harness and compared value by value against the installed one on every one of them, source per-field with ruleset only when BOTH numbers came from configuration and the header's own {\"on_threshold\": \"30\", \"off_threshold\": 5} answering 18 / 5 as ruleset_partial, both bands from the rule itself with all four numbers as literals and the boundary asked at 6 and at 7 and a NULL zero or negative handedness taking the full ring, THE PENDING STATES - would_turn_on true in must_move AND pending_on, would_turn_off true in lightning AND pending_off, each mirror proved to be about the mode by flipping that one column and watching the verdict flip, and draining and paused still answering false so the widening is exactly one state on each side - a disabled Cluster over the ON threshold refused entry and a disabled Cluster under the OFF threshold still allowed to drain out, the ten keys asserted as a SET against the set captured before the re-create with the verdict's six and the thresholds' eight pinned too, rejected among them, LANGUAGE plpgsql read from pg_proc.prolang where section 01 read sql, every field recomputed from its own inputs on every Cluster with a non-zero to_on to_off and open_cluster_sessions somewhere, grants withheld from anon authenticated and PUBLIC and held by service_role asserted three ways, every @live-proof the migration carries extracted from the file under test and true with no quarantine, and the migration applied a SECOND time over the standing estate leaving three bodies three acls and three comments byte-identical, no row moved, and every Cluster and all ten thousand generated configurations answering identically"
