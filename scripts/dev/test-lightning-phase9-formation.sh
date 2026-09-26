#!/usr/bin/env bash
# Lightning Phase 9: the hand formation barrier is atomic, and the participant
# set is locked the moment it is complete.
#
# Applies the real fixture chain - the same three fixtures and six predecessor
# migrations scripts/dev/test-lightning-phase5-conversion.sh applies, including
# the REAL 40,000-character fn_cash_cluster_tick - then 20260921151618 and
# 20260925204249, then this harness's own writers, then the migration under
# test, and exercises every claim it makes against a running catalogue and a
# running estate rather than against a reading of the file.
#
# THE ESTATE IS BUILT BY THE REAL CONVERSION. Not one Cluster in this file is
# made Lightning by an UPDATE. fx9_convert drives fn_cash_cluster_begin_pending_on
# and fn_cash_cluster_commit_lightning and RAISES unless the Cluster actually
# converted, so every hand formed below is formed inside an epoch a real
# conversion opened, over pool sessions a real conversion wrote, against
# starting_stack values a real conversion copied out of table_seats. A harness
# that set cluster_mode itself would prove the barrier works against a shape
# production never produces.
#
# WHAT IS ACTUALLY AT RISK, AND WHY THE SECTIONS ARE SHAPED THE WAY THEY ARE.
#
#   A NEGATIVE THAT NOTHING COULD HAVE SATISFIED. Almost every assertion in
#   this file is "X is refused". A refusal is trivially satisfied by a fixture
#   that could not have done X anyway, so every refusal here is paired with its
#   non-vacuity half on the same estate, one thing different: the same call
#   with the fault injector off forms a hand; the same player after the reaper
#   runs is legal again; the same INSERT on an unlocked hand succeeds.
#
#   A CATCHER THAT CATCHES NOTHING. Every refusal is read through fx9_try,
#   which EXECUTEs a statement and returns SQLERRM. A fx9_try that silently
#   swallowed would make all of them vacuous, so section 00 makes it catch a
#   real division by zero before anything else in this file runs.
#
#   A ROLLBACK NOBODY MADE HAPPEN. Section 03 is the one this file exists for.
#   The barrier's failure path is an inner BEGIN ... EXCEPTION block, and the
#   claim is that a refusal anywhere inside it un-creates the instance, the
#   reservations, the hand and the participants together. There is no way to
#   provoke that from a single session with legitimate data - the races it
#   defends against need two backends - so it is provoked by FAULT INJECTION:
#   a harness-owned trigger that raises check_violation on the last write, and
#   a second one that raises on a middle write, each switched by a GUC. The
#   injector is the only difference between the failing call and the passing
#   one, and both are made on the same estate a line apart.
#
#   AN INVARIANT NOBODY MEASURES. F12 one phase on: forming a hand moves no
#   money. Section 09 does not compare a sum. It compares an md5 of every
#   money-bearing column of every table_seats, cash_player_session and
#   lightning_pool_session row of the Cluster, ordered, before and after a
#   formation - through an md5 first proved to MOVE when one cent moves and to
#   come back when it is put back.
#
#   AN IMMUTABILITY RULE THAT IS ONLY A COMMENT. Specification 519-524 is four
#   sentences. Section 07 attempts every one of them against a hand that has
#   really been formed and really been locked, catches the refusal, reads the
#   error text to check it is the RIGHT refusal rather than any refusal, and
#   then proves the same statement succeeds against the same hand's unlocked
#   twin - so what is proved is the latch and not the absence of the row.
#
#   A LAW THAT ONLY APPLIES TO PEOPLE. Law 10.5: a horse counts exactly like a
#   human. Section 10 seats a horse - table_seats.horse_id, the only place this
#   estate records one - converts, and proves the horse gets a pool session, a
#   slot, a reservation, a seat, a position, a blind role and a stack snapshot
#   identical in kind to a human's, and is chosen as the big blind by the same
#   P2 key. P0's legality list has no carve-out and must not gain one.
#
#   A FREEZE WITH A HOLE IN IT, AND A FREEZE THAT WEDGES AN INCIDENT. Section
#   11 proves both halves: forming, opening an instance, beginning to deal and
#   opening a pool slot are all refused during a real engine_maintenance_break
#   row, and abandoning an instance, reaping a formation and closing the slot of
#   somebody who has left are NOT - because recovering from a half-formed hand
#   is exactly what an operator does during the break.
#
#   A PROOF THAT HAS GONE STALE. `-- @live-proof:` lines are comments and no
#   psql run evaluates them. Section 14 extracts every one of them from the
#   file under test, inlines it as CODE so that one which no longer parses is a
#   failure too, and evaluates it. No quarantine and no exception list.
#
# THE RULES, inherited from scripts/dev/test-lightning-phase5-conversion.sh:
#
#   1. Every comparison in an assertion is IS DISTINCT FROM, never = or <>. A
#      NULL where a value was expected makes `IF NOT (x = y)` evaluate to NULL,
#      which plpgsql takes as false, so an absent jsonb key PASSES a check
#      written that way.
#   2. Every negative assertion is preceded by its non-vacuity proof.
#   3. Grants are asserted in both directions.
#   4. Nothing is read from the migration's text where the catalogue or the
#      estate can be asked instead.
#
# LIGHTNING_PHASE9_MIGRATION overrides the file under test, so that mutation
# testing - copying the migration to a scratch directory, deleting one clause
# from the copy and watching this harness go red - never has to touch the
# migration in the repository. LIGHTNING_PHASE9_PORT overrides the port.
set -euo pipefail
export LC_ALL=C  # else initdb's postmaster refuses to start on macOS ("became multithreaded during startup") and string_agg ordering stops being deterministic
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_PHASE9_PORT:-55550}
base_fixture=$root/scripts/dev/fixtures/lightning-phase3-remediation-schema.sql
pop_fixture=$root/scripts/dev/fixtures/lightning-phase4-population-schema.sql
p5_fixture=$root/scripts/dev/fixtures/lightning-phase5-conversion-schema.sql
p9_fixture=$root/scripts/dev/fixtures/lightning-phase9-formation-fixture.sql
phase2=$root/supabase/migrations/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$root/supabase/migrations/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$root/supabase/migrations/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
phase3r=$root/supabase/migrations/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
phase4=$root/supabase/migrations/20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql
phase4r=$root/supabase/migrations/20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql
phase5=$root/supabase/migrations/20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_.sql
phase5r=$root/supabase/migrations/20260925204249_lightning_phase_5_remediation_the_halt_is_a_standing_bar.sql
migration=${LIGHTNING_PHASE9_MIGRATION:-$root/supabase/migrations/20260925215731_lightning_phase_9_the_hand_formation_barrier_is_atomic_and_t.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$phase2" "$phase2r" \
         "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" "$migration"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-phase9-test.XXXXXX")
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

# ONE psql SESSION, FIFTEEN FILES. One session because the estate built before
# the migration is the estate the migration is applied over, because the bodies
# and acls measured before the re-apply are compared to the ones after it, and
# because the TEMP tables that carry Cluster ids between sections have to live
# in the backend every file lands in.
cat > "$fixture/pre.sql" <<'ASSERT'
CREATE TEMP TABLE b9 (k text PRIMARY KEY, game uuid, a uuid, b uuid, t text, n bigint);

-- THE FAULT INJECTORS. See section 03. Two triggers, each switched by a GUC, so
-- that the barrier's inner rollback can be provoked at two different depths -
-- after the instance and the reservations exist but before the hand, and after
-- everything exists but before the latch. They are named zz_ so that they fire
-- AFTER the migration's own BEFORE triggers rather than instead of them.
CREATE FUNCTION public.fx9_break() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  IF coalesce(current_setting('fx9.break_' || TG_ARGV[0], true), '') = 'on' THEN
    RAISE EXCEPTION 'FX9_INJECTED_FAULT at %', TG_ARGV[0] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fx$;

CREATE TRIGGER zz_fx9_break_hand BEFORE INSERT ON public.lightning_hand
  FOR EACH ROW EXECUTE FUNCTION public.fx9_break('hand');
CREATE TRIGGER zz_fx9_break_hand_player BEFORE INSERT ON public.lightning_hand_player
  FOR EACH ROW EXECUTE FUNCTION public.fx9_break('hand_player');

-- 00 THE CATCHER CATCHES ------------------------------------------------------
DO $$
BEGIN
  IF public.fx9_boom() !~ 'division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: fx9_try does not catch a real division by zero, it reports %', public.fx9_boom();
  END IF;
  IF public.fx9_try('SELECT 1') IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 00: fx9_try reports an error for a statement that has none';
  END IF;
  -- AND THE FREEZE SWITCH WORKS IN BOTH DIRECTIONS, before anything depends on
  -- it: a fx9_freeze that did not freeze would make every assertion in section
  -- 11 pass for the wrong reason.
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'FAIL 00: the platform is frozen before this file has done anything';
  END IF;
  PERFORM public.fx9_freeze();
  PERFORM public.fx9_thaw();
END $$;
\echo '  ok  00 THE CATCHER CATCHES  fx9_try really does return the message of a real division by zero and really does return no error for a statement that has none, and the freeze switch this file leans on is proved to turn fn_platform_frozen() on and off again before one assertion depends on it'

-- 01 THE GROUND BEFORE THE MIGRATION -------------------------------------------
-- Everything here runs against the estate the six predecessor migrations built,
-- before a line of 20260925215731 has been applied. If any of it is wrong then
-- the migration is not the thing that changed what sections 02 onward measure.
DO $$
DECLARE
  v_g uuid; v_e integer; v_p uuid[]; v_s1 uuid; v_s2 uuid; v_n integer; v_msg text;
BEGIN
  -- NOTHING OF PHASE 9 EXISTS YET.
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 01: % fn_lightning_ function(s) already exist before the migration', v_n;
  END IF;
  SELECT count(*)::integer INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND ns.nspname = 'public' AND c.relname LIKE 'lightning%'
     AND t.tgname NOT LIKE 'zz_fx9%';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 01: % trigger(s) are already on the lightning tables before the migration', v_n;
  END IF;

  -- THE P2 INDEX IS THERE AND HAS NO READER. This is the migration's claim
  -- about why the blind order belongs in the barrier, measured rather than
  -- asserted.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                   AND indexname = 'lightning_pool_slot_oldest_bb') THEN
    RAISE EXCEPTION 'FAIL 01: the P2 index lightning_pool_slot_oldest_bb does not exist, so the migration is building on something that is not there';
  END IF;
  -- fx9_ IS THIS HARNESS'S OWN. fx9_residue reads last_bb_at because that is
  -- one of the fairness columns section 03 proves a failed formation did not
  -- move, so it is excluded here rather than making the estate's answer wrong.
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname !~ '^fx9_'
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'last_bb_at';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 01: % function(s) already read last_bb_at, so "the P2 index has no reader" is not the ground this migration stands on', v_n;
  END IF;

  -- AND NOTHING CREATES A POOL SLOT, which is the whole of DECISION 1.
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname !~ '^fx9_'
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
         ~ 'INSERT INTO[[:space:]]+(public\.)?lightning_pool_slot';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 01: % function(s) already insert a lightning_pool_slot', v_n;
  END IF;

  -- A REAL CONVERSION OF EIGHTEEN PLAYERS, and it leaves the pool slotless.
  v_g := public.fx9_cluster('GROUND', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  IF (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL) IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 01: the real conversion did not create eighteen pool sessions';
  END IF;
  IF (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 01: the conversion created a pool slot, so DECISION 1 is answering a question nobody has';
  END IF;

  -- THE BYPASS DECISION 3 CLOSES, DEMONSTRATED RATHER THAN DESCRIBED. Under the
  -- schema as built, one player may hold two open slots in one Cluster, because
  -- lightning_pool_slot_one_open is unique on (player_id, cluster_id, SLOT).
  -- Section 04 attempts exactly this again after the migration and is refused.
  SELECT ps.player_id INTO v_s1 FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL ORDER BY ps.entered_at, ps.id LIMIT 1;
  INSERT INTO public.lightning_pool_slot (pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 1
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_s1;
  INSERT INTO public.lightning_pool_slot (pool_session_id, cluster_id, cluster_epoch, player_id, slot)
  SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 2
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_s1;
  IF (SELECT count(*) FROM public.lightning_pool_slot
       WHERE cluster_id = v_g AND player_id = v_s1 AND closed_at IS NULL) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 01: the two-open-slots bypass did not reproduce, so section 04 proves nothing';
  END IF;
  DELETE FROM public.lightning_pool_slot WHERE cluster_id = v_g;

  INSERT INTO b9 (k, game, a, t, n) VALUES ('ground', v_g, v_s1, 'converted', v_e);
END $$;
\echo '  ok  01 THE GROUND BEFORE IT  before the migration is applied there is no fn_lightning_ function and no trigger on any lightning table, the P2 index lightning_pool_slot_oldest_bb exists and NOT ONE function in the estate reads last_bb_at, NOT ONE function in the estate inserts a lightning_pool_slot, a REAL eighteen-player conversion through begin_pending_on and commit_lightning opens eighteen pool sessions and ZERO pool slots - which is why a reservation could not be taken for anybody at all - and the bypass DECISION 3 closes is demonstrated by actually opening two concurrent slots for one player under the index the schema already carries'
ASSERT

cat > "$fixture/assertions.sql" <<'ASSERT'
-- 02 THE HAPPY PATH ------------------------------------------------------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_p uuid[]; v_r jsonb; v_d jsonb; v_h uuid; v_i uuid;
  v_n integer; v_t text; v_ev integer;
BEGIN
  SELECT game, n INTO v_g, v_e FROM b9 WHERE k = 'ground';

  -- DECISION 1'S DOOR. The conversion left eighteen pool sessions and no slots;
  -- the sync pass is what gives the founding population somewhere to be
  -- reserved from, and it is the same pass that will pick up the next arrival.
  IF (public.fx9_pool(v_g) ->> 'slots_opened')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 02: the sync pass did not open eighteen slots';
  END IF;
  IF (public.fx9_pool(v_g) ->> 'slots_opened')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: the sync pass is not idempotent, a second run opened slots again';
  END IF;

  SELECT count(*)::integer INTO v_ev FROM public.cash_cluster_events
   WHERE game_id = v_g AND kind = 'lightning_hand_formed';

  v_p := public.fx9_candidates(v_g, 6);
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: the barrier refused a legal six-hand: %', v_r;
  END IF;
  v_h := (v_r ->> 'hand_id')::uuid;
  v_i := (v_r ->> 'instance_id')::uuid;
  INSERT INTO b9 (k, game, a, b) VALUES ('hand1', v_g, v_h, v_i);

  -- STEP 8 AND STEP 9: the instance is bound and the epoch is the Cluster's.
  SELECT state INTO v_t FROM public.lightning_instance WHERE id = v_i;
  IF v_t IS DISTINCT FROM 'reserved' THEN
    RAISE EXCEPTION 'FAIL 02: the instance is in % after formation, not reserved', v_t;
  END IF;
  IF (SELECT hand_id FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM v_h THEN
    RAISE EXCEPTION 'FAIL 02: the instance is not bound to the hand it formed';
  END IF;
  IF (SELECT cluster_epoch FROM public.lightning_hand WHERE hand_id = v_h) IS DISTINCT FROM v_e
     OR (SELECT cluster_epoch FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM v_e THEN
    RAISE EXCEPTION 'FAIL 02: the hand or the instance is not bound to the epoch the conversion opened';
  END IF;

  -- STEP 10: the latch, and a count that agrees with the rows.
  IF (SELECT participants_locked_at FROM public.lightning_hand WHERE hand_id = v_h) IS NULL THEN
    RAISE EXCEPTION 'FAIL 02: the participant set was never locked';
  END IF;
  IF (SELECT player_count FROM public.lightning_hand WHERE hand_id = v_h) IS DISTINCT FROM 6::smallint THEN
    RAISE EXCEPTION 'FAIL 02: the hand did not record a player_count of six';
  END IF;

  -- STEPS 3, 4 AND 5: six distinct seats, the six positions, one sb, one bb.
  SELECT string_agg(seat || ':' || coalesce("position", 'null') || '/' || coalesce(blind_role, 'null'),
                    ' ' ORDER BY seat) INTO v_t
    FROM public.lightning_hand_player WHERE hand_id = v_h;
  IF v_t IS DISTINCT FROM '1:sb/sb 2:bb/bb 3:utg/none 4:hj/none 5:co/none 6:btn/none' THEN
    RAISE EXCEPTION 'FAIL 02: the six-hand seat map is %, not the canonical sb bb utg hj co btn', v_t;
  END IF;

  -- STEP 6: stack_before is the pool session stack and nothing else.
  IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp
               JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
               JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
              WHERE hp.hand_id = v_h
                AND hp.stack_before IS DISTINCT FROM
                    round(coalesce(ps.starting_stack, 0) + coalesce(ps.net_result, 0), 2)) THEN
    RAISE EXCEPTION 'FAIL 02: a stack_before does not equal its pool session starting_stack plus net_result';
  END IF;

  -- STEPS 2 AND 3 AS ROWS: six committed reservations, in the seats the hand gave.
  SELECT count(*)::integer INTO v_n FROM public.lightning_reservation r
   WHERE r.lightning_instance_id = v_i AND r.state = 'committed' AND r.resolved_at IS NOT NULL;
  IF v_n IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 02: % committed reservations for a six-hand', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_reservation r
              WHERE r.lightning_instance_id = v_i
                AND NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                                 WHERE hp.hand_id = v_h AND hp.player_id = r.player_id
                                   AND hp.seat = r.seat_number)) THEN
    RAISE EXCEPTION 'FAIL 02: a committed reservation does not sit in the seat the hand gave it';
  END IF;

  -- STEP 13'S DOOR.
  v_d := public.fn_lightning_instance_begin_dealing(v_i);
  IF coalesce((v_d ->> 'dealing')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: the instance would not begin dealing: %', v_d;
  END IF;
  SELECT state INTO v_t FROM public.lightning_instance WHERE id = v_i;
  IF v_t IS DISTINCT FROM 'dealing'
     OR (SELECT started_at FROM public.lightning_instance WHERE id = v_i) IS NULL THEN
    RAISE EXCEPTION 'FAIL 02: the instance did not reach dealing with a started_at';
  END IF;
  IF public.fx9_try(format('SELECT public.fn_lightning_instance_begin_dealing(%L)', v_i)) IS DISTINCT FROM 'no error'
     OR (public.fn_lightning_instance_begin_dealing(v_i) ->> 'reason') IS DISTINCT FROM 'wrong_state' THEN
    RAISE EXCEPTION 'FAIL 02: a second begin_dealing on a dealing instance was not answered with wrong_state';
  END IF;

  IF (SELECT count(*)::integer FROM public.cash_cluster_events
       WHERE game_id = v_g AND kind = 'lightning_hand_formed') IS DISTINCT FROM v_ev + 1 THEN
    RAISE EXCEPTION 'FAIL 02: the formation emitted no lightning_hand_formed event, or more than one';
  END IF;

  -- AND THE POOL KEEPS DEALING. The twelve who were not in the first hand form
  -- a second one, at the same epoch, in a different instance.
  v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6));
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: a second hand could not be formed out of the remaining pool: %', v_r;
  END IF;
  IF (v_r ->> 'instance_id')::uuid IS NOT DISTINCT FROM v_i THEN
    RAISE EXCEPTION 'FAIL 02: the second hand reused the first hand''s instance';
  END IF;
  INSERT INTO b9 (k, game, a, b) VALUES ('hand2', v_g, (v_r ->> 'hand_id')::uuid, (v_r ->> 'instance_id')::uuid);
END $$;
\echo '  ok  02 THE HAPPY PATH  the sync pass opens one slot for each of the eighteen pool sessions a REAL conversion wrote and opens none on a second run, and the barrier then forms a six-hand end to end: an instance bound to the hand and to the epoch the conversion opened, participants_locked_at set with a player_count of six that the latch trigger checked against the rows, seats 1 to 6 carrying exactly sb bb utg hj co btn with one small blind and one big blind, every stack_before equal to its own pool session starting_stack plus net_result, six committed reservations each sitting in the seat the hand gave it, one lightning_hand_formed event, the instance released into gameplay by begin_dealing with a started_at and refusing a second release with wrong_state, and twelve players left in the pool who form a second hand in a different instance at the same epoch'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 03 A FAILED FORMATION LEAVES NOTHING -----------------------------------------
-- Specification 727-733. The claim is not that the reservations are released;
-- it is that they never existed. That cannot be provoked from one session with
-- legitimate data, so it is provoked by fault injection at two depths, and the
-- injector is the ONLY difference between the failing call and the passing one
-- a line below it.
DO $$
DECLARE
  v_g uuid; v_p uuid[]; v_r jsonb; v_res text; v_money text; v_ev integer; v_ev2 integer;
BEGIN
  SELECT game INTO v_g FROM b9 WHERE k = 'ground';
  v_p := public.fx9_candidates(v_g, 6);
  IF coalesce(array_length(v_p, 1), 0) < 6 THEN
    RAISE EXCEPTION 'FAIL 03: there are not six free players left to fail a formation with';
  END IF;

  FOREACH v_res IN ARRAY ARRAY['hand', 'hand_player'] LOOP
    v_money := public.fx9_residue(v_g);
    SELECT count(*)::integer INTO v_ev FROM public.cash_cluster_events
     WHERE game_id = v_g AND kind = 'lightning_matcher_retry';

    PERFORM set_config('fx9.break_' || v_res, 'on', false);
    v_r := public.fn_lightning_form_hand(v_g, v_p);
    PERFORM set_config('fx9.break_' || v_res, 'off', false);

    IF coalesce((v_r ->> 'formed')::boolean, true) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL 03: the injected fault at % did not stop the formation: %', v_res, v_r;
    END IF;
    IF (v_r ->> 'reason') IS DISTINCT FROM 'formation_refused'
       OR (v_r ->> 'sqlstate') IS DISTINCT FROM '23514'
       OR (v_r ->> 'message') !~ 'FX9_INJECTED_FAULT'
       OR coalesce((v_r ->> 'retry')::boolean, false) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 03: the refusal at % does not carry the sqlstate, the message and a retry flag: %', v_res, v_r;
    END IF;

    -- NOT ONE ROW. Instances, reservations, hands, participants and every
    -- fairness column of every pool slot, all at once.
    IF public.fx9_residue(v_g) IS DISTINCT FROM v_money THEN
      RAISE EXCEPTION 'FAIL 03: the failed formation at % left residue: % became %',
        v_res, v_money, public.fx9_residue(v_g);
    END IF;

    -- AND THE ONE THING THAT MUST SURVIVE THE ROLLBACK.
    SELECT count(*)::integer INTO v_ev2 FROM public.cash_cluster_events
     WHERE game_id = v_g AND kind = 'lightning_matcher_retry';
    IF v_ev2 IS DISTINCT FROM v_ev + 1 THEN
      RAISE EXCEPTION 'FAIL 03: the failed formation at % emitted % matcher_retry events, not one', v_res, v_ev2 - v_ev;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                    WHERE e.game_id = v_g AND e.kind = 'lightning_matcher_retry'
                      AND e.payload ->> 'sqlstate' = '23514'
                      AND e.payload ->> 'message' ~ 'FX9_INJECTED_FAULT') THEN
      RAISE EXCEPTION 'FAIL 03: the matcher_retry event does not say what refused';
    END IF;
  END LOOP;

  -- THE NON-VACUITY HALF: the same call, the same players, the injectors off.
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: with the injectors off the same six players could not form, so nothing above was about the rollback: %', v_r;
  END IF;
  INSERT INTO b9 (k, game, a, b) VALUES ('hand3', v_g, (v_r ->> 'hand_id')::uuid, (v_r ->> 'instance_id')::uuid);

  -- AND A REFUSAL BEFORE ANY WRITE STILL EMITS THE RETRY. A matcher spinning on
  -- a pool that can never fill has to leave a trace somewhere.
  SELECT count(*)::integer INTO v_ev FROM public.cash_cluster_events
   WHERE game_id = v_g AND kind = 'lightning_matcher_retry';
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'insufficient_legal_candidates'
     OR (v_r ->> 'legal')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: six players already in a hand were not refused as illegal candidates: %', v_r;
  END IF;
  IF (SELECT count(*)::integer FROM public.cash_cluster_events
       WHERE game_id = v_g AND kind = 'lightning_matcher_retry') IS DISTINCT FROM v_ev + 1 THEN
    RAISE EXCEPTION 'FAIL 03: a pre-write refusal emitted no matcher_retry';
  END IF;
END $$;
\echo '  ok  03 NOTHING IS LEFT BEHIND  a fault injected at the hand write and again at the participant write makes the barrier answer formed:false with the SQLSTATE and the message of whatever refused and a retry flag, and leaves not one instance, not one reservation, not one hand, not one participant and not one moved fairness column behind - compared as a whole-Cluster census rather than as four counts - while the matcher_retry event, emitted after the rollback and therefore the only thing that survives it, records the sqlstate and the message; with the injectors off the same six players form immediately, so what was proved is the rollback and not a fixture that could not form; and a refusal that happens BEFORE any write - six players already in a hand - emits its matcher_retry too'

-- 04 ONE ACTIVE RESERVATION, AND IT CANNOT BE WALKED AROUND ---------------------
DO $$
DECLARE
  v_g uuid; v_i uuid; v_pl uuid; v_slot uuid; v_sess uuid; v_msg text; v_r jsonb; v_n integer;
BEGIN
  SELECT game, b INTO v_g, v_i FROM b9 WHERE k = 'hand1';
  SELECT hp.player_id, hp.pool_slot_id INTO v_pl, v_slot
    FROM public.lightning_hand_player hp WHERE hp.hand_id = (SELECT a FROM b9 WHERE k = 'hand1')
   ORDER BY hp.seat LIMIT 1;
  SELECT sl.pool_session_id INTO v_sess FROM public.lightning_pool_slot sl WHERE sl.id = v_slot;

  IF (SELECT count(*)::integer FROM public.lightning_reservation
       WHERE cluster_id = v_g AND player_id = v_pl AND state IN ('pending', 'committed')) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 04: the player does not hold exactly one active reservation to begin with';
  END IF;

  -- A SECOND CLAIM ON A PLAYER WHO IS IN A HAND, attempted directly against the
  -- table rather than through a function, because rule 725 has to be true
  -- regardless of what is calling.
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_reservation (cluster_id, cluster_epoch, player_id, pool_slot_id, expires_at) '
    'SELECT sl.cluster_id, sl.cluster_epoch, sl.player_id, sl.id, clock_timestamp() + interval ''20 seconds'' '
    'FROM public.lightning_pool_slot sl WHERE sl.id = %L', v_slot));
  IF v_msg !~ 'lightning_reservation_one_active_per_player' THEN
    RAISE EXCEPTION 'FAIL 04: a second active reservation for a player already in a hand was refused by % rather than by the one-active index', v_msg;
  END IF;

  -- AND THE BYPASS THAT MADE THE PER-SLOT INDEX ORTHOGONAL TO RULE 725. Section
  -- 01 opened two concurrent slots for one player on this same estate; the
  -- same INSERT is now refused.
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_pool_slot (pool_session_id, cluster_id, cluster_epoch, player_id, slot) '
    'SELECT ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 2 FROM public.lightning_pool_session ps WHERE ps.id = %L', v_sess));
  IF v_msg !~ 'lightning_pool_slot_one_open_per_player' THEN
    RAISE EXCEPTION 'FAIL 04: a second open slot for the same player was refused by % rather than by the one-open-per-player index', v_msg;
  END IF;

  -- THE CLAIM COMES OFF WHEN THE INSTANCE ENDS, and it comes off through the
  -- trigger rather than through the function, so that it is true of every road
  -- into a terminal state including the settlement phase nobody has written.
  IF coalesce((public.fn_lightning_instance_abandon(v_i, 'harness: section 04') ->> 'abandoned')::boolean, false)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 04: the instance would not abandon';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_reservation
   WHERE lightning_instance_id = v_i AND state = 'released' AND resolved_at IS NOT NULL
     AND reason = 'instance_abandoned';
  IF v_n IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 04: % of the six committed reservations were released when the instance was abandoned', v_n;
  END IF;

  -- AND THE PLAYER IS MATCHABLE AGAIN. This is the half that matters: an index
  -- that never lets go is a player permanently removed from the pool.
  v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6));
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 04: the released players could not be formed into a new hand: %', v_r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                  WHERE hp.hand_id = (v_r ->> 'hand_id')::uuid AND hp.player_id = v_pl) THEN
    RAISE EXCEPTION 'FAIL 04: the player whose reservation was released is not in the new hand';
  END IF;
  INSERT INTO b9 (k, game, a, b) VALUES ('hand4', v_g, (v_r ->> 'hand_id')::uuid, (v_r ->> 'instance_id')::uuid);
END $$;
\echo '  ok  04 ONE ACTIVE RESERVATION  a player who is in a hand cannot be reserved again - the refusal comes from lightning_reservation_one_active_per_player, attempted straight against the table rather than through a function so that it holds regardless of the caller - the two-concurrent-slots bypass section 01 demonstrated on this same estate is now refused by lightning_pool_slot_one_open_per_player, and the claim comes OFF when the instance reaches a terminal state, through an AFTER trigger rather than a line in abandon, releasing all six committed reservations with a stated reason and making every one of those players matchable into a new hand immediately'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 05 A RESERVATION EXPIRES, AND THE REAPER IS WHAT GIVES IT BACK ----------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_pl uuid; v_slot uuid; v_p uuid[]; v_r jsonb; v_reap jsonb; v_t text;
BEGIN
  v_g := public.fx9_cluster('EXPIRE', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_p := public.fx9_candidates(v_g, 6);
  SELECT sl.player_id, sl.id INTO v_pl, v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.player_id = v_p[1];

  -- A MATCHER THAT DIED BETWEEN RESERVING AND COMMITTING. This is the row it
  -- would have left: pending, bound to nothing, already past its expiry.
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, expires_at, created_at)
  VALUES (v_g, v_e, v_pl, v_slot, clock_timestamp() - interval '30 seconds',
          clock_timestamp() - interval '90 seconds');

  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'insufficient_legal_candidates'
     OR (v_r ->> 'legal')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 05: a player holding a stale pending reservation was still counted legal: %', v_r;
  END IF;

  v_reap := public.fn_lightning_reap_formations();
  IF (v_reap ->> 'reservations_expired')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 05: the reaper expired % reservations, not one: %', (v_reap ->> 'reservations_expired'), v_reap;
  END IF;
  SELECT state INTO v_t FROM public.lightning_reservation
   WHERE cluster_id = v_g AND player_id = v_pl;
  IF v_t IS DISTINCT FROM 'expired'
     OR (SELECT resolved_at FROM public.lightning_reservation WHERE cluster_id = v_g AND player_id = v_pl) IS NULL
     OR (SELECT reason FROM public.lightning_reservation WHERE cluster_id = v_g AND player_id = v_pl) IS NULL THEN
    RAISE EXCEPTION 'FAIL 05: the reaped reservation is in state % with no resolution or no reason', v_t;
  END IF;

  -- AND AN EXPIRED CLAIM CANNOT COME BACK TO LIFE.
  IF public.fx9_try(format('UPDATE public.lightning_reservation SET state = ''pending'', resolved_at = NULL WHERE cluster_id = %L AND player_id = %L', v_g, v_pl))
     !~ 'LIGHTNING_RESERVATION_STATE_IS_NOT_REVERSIBLE' THEN
    RAISE EXCEPTION 'FAIL 05: an expired reservation could be made pending again';
  END IF;

  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the player was still unmatchable after the reaper gave the claim back: %', v_r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player WHERE hand_id = (v_r ->> 'hand_id')::uuid AND player_id = v_pl) THEN
    RAISE EXCEPTION 'FAIL 05: the reaped player is not in the hand that formed';
  END IF;
  INSERT INTO b9 (k, game, a, b, n) VALUES ('expire', v_g, (v_r ->> 'hand_id')::uuid, (v_r ->> 'instance_id')::uuid, v_e);
END $$;
\echo '  ok  05 A RESERVATION EXPIRES  the row a matcher that died between reserving and committing would leave - pending, bound to no instance, already past its expiry - makes its player illegal and the hand refuse at five legal candidates of six, the reaper expires exactly that one claim with a resolution time and a stated reason, an expired claim is refused when it tries to become pending again, and the same six players then form immediately with the reaped player in the hand'

-- 06 NOTHING IS LEFT FORMING FOR EVER -------------------------------------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_i uuid; v_i2 uuid; v_live uuid; v_r jsonb; v_msg text; v_p uuid[]; v_n integer;
BEGIN
  v_g := public.fx9_cluster('DEADLINE', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);

  -- THE DEADLINE IS BORN WITH THE ROW. An INSERT that names no deadline still
  -- gets one, and it is in the future.
  INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size)
  VALUES (v_g, v_e, 2, 6) RETURNING id INTO v_i;
  IF (SELECT deadline_at > created_at FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: an instance inserted with no deadline did not get one in the future';
  END IF;

  -- AND A DEADLINE THAT IS NOT A DEADLINE IS REFUSED.
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size, created_at, deadline_at) '
    'VALUES (%L, %s, 2, 6, clock_timestamp(), clock_timestamp())', v_g, v_e));
  IF v_msg !~ 'lightning_instance_deadline_follows_creation' THEN
    RAISE EXCEPTION 'FAIL 06: an instance whose deadline equals its creation time was refused by % rather than by the CHECK', v_msg;
  END IF;

  -- AND THE DEADLINE CANNOT BE BACKDATED UNDER A LIVE INSTANCE EITHER, which
  -- is the CHECK doing a second job: an operator cannot reach in and make an
  -- instance look expired, and this harness cannot fake one.
  IF public.fx9_try(format('UPDATE public.lightning_instance SET deadline_at = clock_timestamp() - interval ''1 minute'' WHERE id = %L', v_i))
     !~ 'lightning_instance_deadline_follows_creation' THEN
    RAISE EXCEPTION 'FAIL 06: an instance deadline could be moved behind its own creation time';
  END IF;

  -- THE SELF-HEALING HALF, WITH NOTHING SCHEDULED ANYWHERE. One stale forming
  -- instance - opened ten minutes ago through the REAL writer with a five
  -- second window, so it is genuinely past its deadline rather than edited to
  -- look it - and one live one; opening the next instance for this Cluster
  -- buries the stale one and leaves the live one alone.
  v_i := (public.fn_lightning_instance_open(v_g, NULL, NULL, interval '5 seconds',
            clock_timestamp() - interval '10 minutes') ->> 'instance_id')::uuid;
  v_live := (public.fn_lightning_instance_open(v_g) ->> 'instance_id')::uuid;
  v_r := public.fn_lightning_instance_open(v_g);
  IF coalesce((v_r ->> 'opened')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: a Lightning Cluster would not open an instance: %', v_r;
  END IF;
  IF (SELECT state FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'FAIL 06: the instance past its deadline was not buried by the next formation that started';
  END IF;
  IF (SELECT abandon_reason FROM public.lightning_instance WHERE id = v_i) !~ 'reaped' THEN
    RAISE EXCEPTION 'FAIL 06: the reaped instance does not say why it ended';
  END IF;
  IF (SELECT state FROM public.lightning_instance WHERE id = v_live) IS DISTINCT FROM 'forming' THEN
    RAISE EXCEPTION 'FAIL 06: the same pass buried an instance that was still inside its deadline, so nothing above was about the deadline';
  END IF;

  -- A FORMED HAND THAT WAS NEVER RELEASED. Its deadline runs out too: it cannot
  -- be dealt late, and the reaper hands its players back.
  v_p := public.fx9_candidates(v_g, 6);
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: could not form the hand this section needs: %', v_r;
  END IF;
  v_i2 := (v_r ->> 'instance_id')::uuid;
  IF coalesce((public.fn_lightning_instance_begin_dealing(v_i2) ->> 'dealing')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: a freshly reserved instance would not begin dealing, so the past-deadline refusal below would be about something else';
  END IF;
  -- The state graph is one-way, so the past-deadline refusal is proved on a
  -- SECOND, identical formation - taken ten minutes ago with a five second
  -- window, so that its instance is genuinely stale rather than edited to look
  -- it, which the CHECK above has just proved is impossible anyway.
  v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6), NULL, NULL, NULL,
           interval '20 seconds', interval '5 seconds', clock_timestamp() - interval '10 minutes');
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: could not form the stranded hand: %', v_r;
  END IF;
  v_i2 := (v_r ->> 'instance_id')::uuid;
  IF (public.fn_lightning_instance_begin_dealing(v_i2) ->> 'reason') IS DISTINCT FROM 'past_deadline' THEN
    RAISE EXCEPTION 'FAIL 06: a reserved instance past its deadline was still released into gameplay';
  END IF;
  SELECT count(*)::integer INTO v_n FROM public.lightning_reservation
   WHERE lightning_instance_id = v_i2 AND state = 'committed';
  IF v_n IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 06: the stranded instance holds % committed reservations, not six', v_n;
  END IF;
  PERFORM public.fn_lightning_reap_formations();
  IF (SELECT state FROM public.lightning_instance WHERE id = v_i2) IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'FAIL 06: the reaper did not bury a reserved instance past its deadline';
  END IF;
  IF (SELECT count(*)::integer FROM public.lightning_reservation
       WHERE lightning_instance_id = v_i2 AND state IN ('pending', 'committed')) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 06: the reaped instance is still holding its players';
  END IF;
  INSERT INTO b9 (k, game, n) VALUES ('deadline', v_g, v_e);
END $$;
\echo '  ok  06 NOTHING FORMS FOR EVER  an instance inserted with no deadline gets one in the future because the column is NOT NULL with a default, an instance whose deadline equals its creation time is refused by lightning_instance_deadline_follows_creation, and a stale forming instance is buried by the NEXT formation that starts on the same Cluster with nothing scheduled anywhere - while an instance still inside its deadline survives the identical pass - and a hand that was formed and never released cannot be dealt late, is buried by the sweep, and hands all six of its committed players back'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 07 THE FOUR "NO" RULES OF SPECIFICATION 519-524 --------------------------------
-- Every refusal below is attempted against a hand this file really formed and
-- really locked, and every one of them is paired with the SAME statement
-- succeeding against an UNLOCKED twin hand on the same Cluster - so what is
-- proved is lightning_hand.participants_locked_at and not the absence of a row.
DO $$
DECLARE
  v_g uuid; v_e integer; v_h uuid; v_i uuid; v_twin uuid; v_ti uuid;
  v_free uuid[]; v_msg text; v_pl uuid; v_slot uuid; v_pl2 uuid; v_slot2 uuid;
BEGIN
  v_g := public.fx9_cluster('LOCK', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_h := (public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6)) ->> 'hand_id')::uuid;
  SELECT lightning_instance_id INTO v_i FROM public.lightning_hand WHERE hand_id = v_h;
  IF (SELECT participants_locked_at FROM public.lightning_hand WHERE hand_id = v_h) IS NULL THEN
    RAISE EXCEPTION 'FAIL 07: the hand this section tests was not locked';
  END IF;

  v_free := public.fx9_candidates(v_g, 4);
  SELECT sl.player_id, sl.id INTO v_pl, v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.player_id = v_free[1];
  SELECT sl.player_id, sl.id INTO v_pl2, v_slot2 FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.player_id = v_free[2];

  -- THE UNLOCKED TWIN.
  v_ti := (public.fn_lightning_instance_open(v_g) ->> 'instance_id')::uuid;
  v_twin := gen_random_uuid();
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id)
  VALUES (v_twin, v_g, v_e, v_ti);
  INSERT INTO public.lightning_hand_player
    (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before, cluster_id, cluster_epoch)
  VALUES (v_twin, v_pl, v_slot, 1, 'sb', 'sb', 100, v_g, v_e);

  -- RULE 1: no participant substitution.
  v_msg := public.fx9_try(format('UPDATE public.lightning_hand_player SET player_id = %L WHERE hand_id = %L AND seat = 3', v_pl, v_h));
  IF v_msg !~ 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' THEN
    RAISE EXCEPTION 'FAIL 07: substituting a participant was refused by % rather than by rule 1', v_msg;
  END IF;
  v_msg := public.fx9_try(format('DELETE FROM public.lightning_hand_player WHERE hand_id = %L AND seat = 3', v_h));
  IF v_msg !~ 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' THEN
    RAISE EXCEPTION 'FAIL 07: deleting a participant was refused by % rather than by rule 1', v_msg;
  END IF;
  IF public.fx9_try(format('UPDATE public.lightning_hand_player SET player_id = %L, pool_slot_id = %L WHERE hand_id = %L AND seat = 1', v_pl2, v_slot2, v_twin))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: the same substitution on the UNLOCKED twin was refused, so rule 1 is not about the latch';
  END IF;

  -- RULE 2: no silent seat swap.
  v_msg := public.fx9_try(format('UPDATE public.lightning_hand_player SET seat = 9 WHERE hand_id = %L AND seat = 4', v_h));
  IF v_msg !~ 'LIGHTNING_NO_SILENT_SEAT_SWAP' THEN
    RAISE EXCEPTION 'FAIL 07: a seat swap was refused by % rather than by rule 2', v_msg;
  END IF;
  IF public.fx9_try(format('UPDATE public.lightning_hand_player SET seat = 9 WHERE hand_id = %L AND seat = 1', v_twin))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: the same seat swap on the UNLOCKED twin was refused, so rule 2 is not about the latch';
  END IF;

  -- RULE 3: no blind reassignment.
  v_msg := public.fx9_try(format('UPDATE public.lightning_hand_player SET blind_role = ''bb'' WHERE hand_id = %L AND seat = 5', v_h));
  IF v_msg !~ 'LIGHTNING_NO_BLIND_REASSIGNMENT' THEN
    RAISE EXCEPTION 'FAIL 07: a blind reassignment was refused by % rather than by rule 3', v_msg;
  END IF;
  v_msg := public.fx9_try(format('UPDATE public.lightning_hand_player SET "position" = ''btn'' WHERE hand_id = %L AND seat = 5', v_h));
  IF v_msg !~ 'LIGHTNING_NO_BLIND_REASSIGNMENT' THEN
    RAISE EXCEPTION 'FAIL 07: a position reassignment was refused by % rather than by rule 3', v_msg;
  END IF;
  v_msg := public.fx9_try(format('UPDATE public.lightning_hand_player SET stack_before = 1 WHERE hand_id = %L AND seat = 5', v_h));
  IF v_msg !~ 'LIGHTNING_HAND_PLAYER_IS_IMMUTABLE' THEN
    RAISE EXCEPTION 'FAIL 07: rewriting the stack the blinds are posted against was refused by %', v_msg;
  END IF;
  IF public.fx9_try(format('UPDATE public.lightning_hand_player SET blind_role = ''bb'', "position" = ''bb'' WHERE hand_id = %L', v_twin))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: the same blind reassignment on the UNLOCKED twin was refused, so rule 3 is not about the latch';
  END IF;

  -- RULE 4: no additional player insertion.
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch) '
    'VALUES (%L, %L, %L, 7, %L, %s)', v_h, v_pl, v_slot, v_g, v_e));
  IF v_msg !~ 'LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION' THEN
    RAISE EXCEPTION 'FAIL 07: inserting a seventh player was refused by % rather than by rule 4', v_msg;
  END IF;
  IF public.fx9_try(format(
    'INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before, cluster_id, cluster_epoch) '
    'VALUES (%L, %L, %L, 2, ''bb'', ''bb'', 100, %L, %s)', v_twin, v_free[3], (SELECT id FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_free[3] AND closed_at IS NULL), v_g, v_e))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: the same insertion on the UNLOCKED twin was refused, so rule 4 is not about the latch';
  END IF;

  -- NO MATCHER MUTATION: the hand and the instance themselves.
  IF public.fx9_try(format('UPDATE public.lightning_hand SET participants_locked_at = NULL WHERE hand_id = %L', v_h))
     !~ 'LIGHTNING_HAND_IS_IMMUTABLE' THEN
    RAISE EXCEPTION 'FAIL 07: the latch could be cleared, which would unlock all four rules in one statement';
  END IF;
  IF public.fx9_try(format('DELETE FROM public.lightning_hand WHERE hand_id = %L', v_h))
     !~ 'LIGHTNING_HAND_IS_NOT_DELETABLE' THEN
    RAISE EXCEPTION 'FAIL 07: a formed hand could be deleted, which is substitution by delete and re-form';
  END IF;
  IF public.fx9_try(format('UPDATE public.lightning_instance SET hand_id = %L WHERE id = %L', v_twin, v_i))
     !~ 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' THEN
    RAISE EXCEPTION 'FAIL 07: an instance could be re-pointed at a different hand';
  END IF;

  -- AND THE GAME IS STILL PLAYABLE. Freezing fold_type and stack_after would
  -- freeze the hand the barrier exists to start.
  IF public.fx9_try(format('UPDATE public.lightning_hand_player SET fold_type = ''fast'', stack_after = 12.34 WHERE hand_id = %L AND seat = 3', v_h))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: a locked hand cannot be played, which is not what specification 519-524 says';
  END IF;

  -- THE LATCH CANNOT BE SET OVER A COUNT THAT IS NOT THERE.
  IF public.fx9_try(format('UPDATE public.lightning_hand SET participants_locked_at = clock_timestamp(), player_count = 9 WHERE hand_id = %L', v_twin))
     !~ 'LIGHTNING_HAND_IS_IMMUTABLE' THEN
    RAISE EXCEPTION 'FAIL 07: a hand could be locked at a player_count that does not match its rows';
  END IF;
  IF public.fx9_try(format('UPDATE public.lightning_hand SET participants_locked_at = clock_timestamp(), player_count = 2 WHERE hand_id = %L', v_twin))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: the twin could not be locked at its own true count';
  END IF;
  IF public.fx9_try(format('DELETE FROM public.lightning_hand_player WHERE hand_id = %L AND seat = 2', v_twin))
     !~ 'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION' THEN
    RAISE EXCEPTION 'FAIL 07: the twin is still mutable after being locked, so the latch is not what does this';
  END IF;

  -- AND THE CASCADE THAT WOULD HAVE ERASED THE RECORD.
  -- lightning_reservation_belongs_to_its_slot is ON DELETE CASCADE, so without
  -- this guard deleting one pool slot silently erases every committed
  -- reservation ever taken against it - the record of who was in which hand.
  IF public.fx9_try(format('DELETE FROM public.lightning_pool_slot WHERE id = %L',
       (SELECT hp.pool_slot_id FROM public.lightning_hand_player hp WHERE hp.hand_id = v_h ORDER BY hp.seat LIMIT 1)))
     !~ 'LIGHTNING_POOL_SLOT_HOLDS_A_RESERVATION' THEN
    RAISE EXCEPTION 'FAIL 07: a pool slot that sat in a hand could be deleted, cascading its reservations away';
  END IF;
  -- THE NON-VACUITY HALF: a slot that never sat in a hand and never held a
  -- reservation deletes cleanly, so the refusal above is about the history and
  -- not about pool slots being undeletable.
  IF public.fx9_try(format('DELETE FROM public.lightning_pool_slot WHERE id = %L', v_slot))
     IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: a pool slot with no history could not be deleted, so the refusal above is not about the history';
  END IF;
  INSERT INTO b9 (k, game, a, b, n) VALUES ('lock', v_g, v_h, v_twin, v_e);
END $$;
\echo '  ok  07 THE FOUR NO RULES BITE  against a hand this file really formed and really locked, substituting a participant, deleting one, swapping a seat, reassigning a blind role or a position, rewriting the stack the blinds are posted against and inserting a seventh player are each refused BY NAME - and every one of those same statements succeeds against an unlocked twin hand on the same Cluster, so what bites is lightning_hand.participants_locked_at and not the absence of a row; the latch itself cannot be cleared, a formed hand cannot be deleted, an instance cannot be re-pointed at another hand, a hand cannot be locked at a count its rows do not have, the twin becomes immutable the moment it IS locked, a pool slot that sat in a hand cannot be deleted out from under its reservations - and fold_type and stack_after stay writable, because a locked hand that cannot be played is a barrier that froze the game'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 08 NOT A LIGHTNING CLUSTER, AND NOT THIS EPOCH --------------------------------
DO $$
DECLARE
  v_mm uuid; v_g uuid; v_e integer; v_p uuid[]; v_r jsonb; v_msg text; v_sync jsonb;
BEGIN
  -- A Cluster that never converted. Two random candidate ids so that the
  -- refusal is about the Cluster and not about an empty array.
  v_mm := public.fx9_cluster('MUSTMOVE', 6, 40, true);
  PERFORM public.fx9_seat(v_mm, 18);
  v_r := public.fn_lightning_form_hand(v_mm, ARRAY[gen_random_uuid(), gen_random_uuid()]);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'cluster_is_not_lightning'
     OR (v_r ->> 'cluster_mode') IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 08: a must_move Cluster was not refused by name: %', v_r;
  END IF;
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size) VALUES (%L, 0, 2, 6)', v_mm));
  IF v_msg !~ 'LIGHTNING_INSTANCE_CLUSTER_IS_NOT_LIGHTNING' THEN
    RAISE EXCEPTION 'FAIL 08: an instance could be created for a must_move Cluster straight against the table: %', v_msg;
  END IF;

  -- A Cluster that IS Lightning, and its epoch moves under the matcher.
  v_g := public.fx9_cluster('EPOCH', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_p := public.fx9_candidates(v_g, 6);

  -- NON-VACUITY: these six form right now, at this epoch.
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the six could not form before the epoch moved, so nothing below is about the epoch: %', v_r;
  END IF;
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'harness: freeing the six for the epoch test');

  -- lightning_enabled turned off under a lightning Cluster.
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'cluster_is_not_lightning'
     OR coalesce((v_r ->> 'lightning_enabled')::boolean, true) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: a Cluster with lightning_enabled false still formed: %', v_r;
  END IF;
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_g;
  IF coalesce((public.fn_lightning_form_hand(v_g, v_p) ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: turning lightning_enabled back on did not restore formation';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(
    (SELECT li.id FROM public.lightning_instance li WHERE li.cluster_id = v_g AND li.state = 'reserved'
      ORDER BY li.created_at DESC LIMIT 1), 'harness: freeing the six again');

  -- THE EPOCH BUMP. The slots and the pool sessions stay at the old epoch; the
  -- Cluster does not.
  PERFORM set_config('ca.epoch_reason', 'harness_epoch_bump', true);
  UPDATE public.cash_games SET cluster_epoch = cluster_epoch + 1 WHERE id = v_g;
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM v_e + 1 THEN
    RAISE EXCEPTION 'FAIL 08: the epoch did not move';
  END IF;

  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'insufficient_legal_candidates'
     OR (v_r ->> 'legal')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 08: players holding slots at the previous epoch were still legal candidates: %', v_r;
  END IF;
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size) VALUES (%L, %s, 2, 6)', v_g, v_e));
  IF v_msg !~ 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT' THEN
    RAISE EXCEPTION 'FAIL 08: an instance could be created at the previous epoch: %', v_msg;
  END IF;
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size) VALUES (%L, %s, 2, 6)', v_g, v_e + 1));
  IF v_msg IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 08: an instance at the CURRENT epoch was refused too, so the refusal above is not about the epoch: %', v_msg;
  END IF;

  -- AND A DECLARED, OPEN EPOCH THAT IS SIMPLY NOT THIS CLUSTER'S. Without this
  -- the epoch binding has only one testable failure - an epoch that has ENDED -
  -- and the guard that compares against cash_games.cluster_epoch could be
  -- deleted with nothing noticing, because the ended-epoch guard would catch
  -- the same case. This row is open, so only the comparison can refuse it.
  -- cash_cluster_epoch_current permits exactly one open epoch per Cluster, so
  -- the Cluster's own is closed first and a higher one opened in its place;
  -- cash_games.cluster_epoch does not follow, which is the shape this needs.
  UPDATE public.cash_cluster_epoch SET ended_at = clock_timestamp()
   WHERE cluster_id = v_g AND epoch = v_e + 1 AND ended_at IS NULL;
  INSERT INTO public.cash_cluster_epoch (cluster_id, epoch, mode, started_by, started_at)
  VALUES (v_g, v_e + 5, 'lightning', 'harness_open_but_not_current', clock_timestamp());
  v_msg := public.fx9_try(format(
    'INSERT INTO public.lightning_instance (cluster_id, cluster_epoch, target_size, max_size) VALUES (%L, %s, 2, 6)', v_g, v_e + 5));
  IF v_msg !~ 'LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT' THEN
    RAISE EXCEPTION 'FAIL 08: an instance could be bound to a declared, OPEN epoch that is not the Cluster''s: %', v_msg;
  END IF;
  DELETE FROM public.cash_cluster_epoch WHERE cluster_id = v_g AND epoch = v_e + 5;
  UPDATE public.cash_cluster_epoch SET ended_at = NULL WHERE cluster_id = v_g AND epoch = v_e + 1;

  v_sync := public.fn_lightning_pool_slots_sync(v_g);
  IF (v_sync ->> 'slots_closed')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 08: the sync pass closed % slots after an epoch bump, not eighteen: %', (v_sync ->> 'slots_closed'), v_sync;
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NOT NULL
               AND close_reason IS DISTINCT FROM 'epoch_advanced') THEN
    RAISE EXCEPTION 'FAIL 08: a slot closed by the epoch bump does not say so';
  END IF;
END $$;
\echo '  ok  08 NOT LIGHTNING NOT THIS EPOCH  a Cluster that never converted is refused by name with its mode in the answer and cannot have an instance created for it straight against the table, a Lightning Cluster whose lightning_enabled is turned off stops forming and starts again when it is turned back on, and after a real epoch bump the players holding slots at the previous epoch are ZERO legal candidates, an instance at the previous epoch is refused by LIGHTNING_INSTANCE_EPOCH_IS_NOT_CURRENT while one at the current epoch is accepted in the same breath, an instance bound to a declared and still-OPEN epoch that is simply not this Cluster''s is refused by the same name - which is the only case the ended-epoch guard cannot also catch, and therefore the only way to prove the comparison against cash_games.cluster_epoch is load-bearing - and the sync pass closes all eighteen stale slots saying epoch_advanced'

-- 09 FORMING A HAND MOVES NO MONEY ----------------------------------------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_p uuid[]; v_md5 text; v_md5b text; v_r jsonb; v_msg text; v_sess uuid;
BEGIN
  v_g := public.fx9_cluster('MONEY', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_p := public.fx9_candidates(v_g, 6);

  -- THE MEASURE IS PROVED TO MOVE FIRST. One cent on one pool session changes
  -- it, and putting the cent back brings it back - an md5 that could not move
  -- would make every comparison below vacuous.
  v_md5 := public.fx9_money_md5(v_g);
  SELECT id INTO v_sess FROM public.lightning_pool_session WHERE cluster_id = v_g ORDER BY entered_at, id LIMIT 1;
  UPDATE public.lightning_pool_session SET net_result = net_result + 0.01 WHERE id = v_sess;
  IF public.fx9_money_md5(v_g) IS NOT DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: one cent did not change the money measure, so it measures nothing';
  END IF;
  UPDATE public.lightning_pool_session SET net_result = net_result - 0.01 WHERE id = v_sess;
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: the money measure did not come back when the cent did';
  END IF;

  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: could not form the hand this section measures: %', v_r;
  END IF;
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: forming a hand moved money';
  END IF;
  PERFORM public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid);
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: releasing a hand into gameplay moved money';
  END IF;
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'harness: section 09');
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: abandoning an instance moved money';
  END IF;

  -- AND THE BARRIER'S OWN GUARD IS PROVED TO BITE. A trigger that moves a chip
  -- during the formation makes it RAISE rather than retry, because money moving
  -- during formation is not a thing to retry.
  CREATE TRIGGER zz_fx9_move_money AFTER INSERT ON public.lightning_hand_player
    FOR EACH ROW EXECUTE FUNCTION public.fx9_move_money();
  v_msg := public.fx9_try(format('SELECT public.fn_lightning_form_hand(%L, public.fx9_candidates(%L, 6))', v_g, v_g));
  DROP TRIGGER zz_fx9_move_money ON public.lightning_hand_player;
  IF v_msg !~ 'LIGHTNING_FORMATION_MOVED_MONEY' THEN
    RAISE EXCEPTION 'FAIL 09: a formation that moved a chip was not refused by the barrier''s own guard, it answered %', v_msg;
  END IF;
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: the chip the injected trigger moved was not rolled back';
  END IF;

  -- AND A PLAYER WITH NOTHING TO POST IS NOT A LEGAL CANDIDATE. stack_before is
  -- read as starting_stack plus net_result, so a player whose net_result has
  -- taken their whole stack is in the pool, active, slotted and unreserved -
  -- and cannot pay a blind. P0 legality is the only thing standing between
  -- them and a seat.
  v_p := public.fx9_candidates(v_g, 6);
  SELECT sl.pool_session_id INTO v_sess FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.player_id = v_p[1];
  UPDATE public.lightning_pool_session ps SET net_result = -ps.starting_stack WHERE ps.id = v_sess;
  IF public.fn_lightning_pool_stack(v_sess) IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'FAIL 09: the busted player still reads a stack of %', public.fn_lightning_pool_stack(v_sess);
  END IF;
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'insufficient_legal_candidates'
     OR (v_r ->> 'legal')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 09: a player with no chips to post was still a legal candidate: %', v_r;
  END IF;
  UPDATE public.lightning_pool_session ps SET net_result = 0 WHERE ps.id = v_sess;
  IF public.fx9_money_md5(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 09: the money measure did not come back when the stack did';
  END IF;
  IF coalesce((public.fn_lightning_form_hand(v_g, v_p) ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 09: the same six could not form once the stack was back, so the refusal was not about the stack';
  END IF;
END $$;
\echo '  ok  09 FORMING MOVES NO MONEY  through a measure first proved to move when one cent moves on one pool session and to come back when the cent does - an md5 of every stack, baseline, starting_stack, net_result, ending_stack and blind-debt total of every table_seats, cash_player_session, lightning_pool_session and lightning_blind_ledger row of the Cluster - forming a hand, releasing it into gameplay and abandoning its instance each leave that measure byte for byte identical, a trigger injected to move one chip DURING a formation is refused by the barrier''s own LIGHTNING_FORMATION_MOVED_MONEY guard, which raises rather than retrying, with the chip rolled back, and a player who is in the pool, active, slotted and unreserved but whose net_result has taken their whole stack is refused as a legal candidate at five of six - and is legal again the moment the stack is back, so the refusal was about the chips and not about the player'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 10 A HORSE IS A PLAYER (LAW 10.5) ---------------------------------------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_horses uuid[]; v_r jsonb; v_n integer; v_h uuid;
BEGIN
  v_g := public.fx9_cluster('HORSE', 6, 40, true);
  -- Seventeen humans and one horse, and the horse is seated the only way this
  -- estate records one: table_seats.horse_id.
  PERFORM public.fx9_seat(v_g, 17, 1, false);
  v_horses := public.fx9_seat(v_g, 1, 18, true);
  IF (SELECT count(*)::integer FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = v_g AND ts.horse_id IS NOT NULL) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 10: the horse was not seated as a horse, so nothing below is about Law 10.5';
  END IF;

  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);

  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_horses[1] AND exited_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 10: the horse got no pool session';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_horses[1] AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 10: the horse got no pool slot';
  END IF;

  -- THE HORSE IS THE FIRST NAME IN THE CANDIDATE SET AND IS THE BIG BLIND, by
  -- the same P2 key as anyone: nobody in this pool has ever paid a big blind,
  -- so last_bb_at is NULL for all eighteen and the tie falls to pool entry and
  -- then to player_id - none of which is is_horse.
  v_r := public.fn_lightning_form_hand(v_g, ARRAY[v_horses[1]] ||
           ARRAY(SELECT c FROM unnest(public.fx9_candidates(v_g)) AS c
                  WHERE c IS DISTINCT FROM v_horses[1] LIMIT 5));
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: a hand containing a horse would not form: %', v_r;
  END IF;
  v_h := (v_r ->> 'hand_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                  WHERE hp.hand_id = v_h AND hp.player_id = v_horses[1]
                    AND hp.seat BETWEEN 1 AND 9 AND hp."position" IS NOT NULL
                    AND hp.blind_role IS NOT NULL AND hp.stack_before > 0) THEN
    RAISE EXCEPTION 'FAIL 10: the horse is not in the hand with a seat, a position, a blind role and a stack';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                  WHERE r.lightning_instance_id = (v_r ->> 'instance_id')::uuid
                    AND r.player_id = v_horses[1] AND r.state = 'committed') THEN
    RAISE EXCEPTION 'FAIL 10: the horse holds no committed reservation';
  END IF;
  IF (SELECT bb_count + sb_count + btn_count + utg_count + hj_count + co_count
        FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_horses[1]) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 10: the horse got no blind-ledger row, so P2 would never rotate it';
  END IF;

  -- AND THE CODE ITSELF, from the catalogue rather than from the file.
  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_'
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'horse';
  IF v_n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 10: % Phase 9 function(s) mention a horse', v_n;
  END IF;
  INSERT INTO b9 (k, game, a, n) VALUES ('horse', v_g, v_horses[1], v_e);
END $$;
\echo '  ok  10 A HORSE IS A PLAYER  a Cluster of seventeen humans and one horse - seated the only way this estate records one, table_seats.horse_id - converts the horse into the pool like anybody else, the sync pass opens its slot like anybody else, and it takes a seat, a position, a blind role, a positive stack snapshot, a committed reservation and a blind-ledger row in a formed hand exactly as a human does, while not one Phase 9 function body mentions a horse in any predicate, ordering or filter'

-- 11 THE FREEZE REFUSES FORMATION AND DOES NOT REFUSE RELEASE --------------------
DO $$
DECLARE
  v_g uuid; v_e integer; v_p uuid[]; v_r jsonb; v_i uuid; v_sess uuid; v_sync jsonb; v_open integer;
BEGIN
  v_g := public.fx9_cluster('FREEZE', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_p := public.fx9_candidates(v_g, 6);
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: could not form the hand this section recovers: %', v_r;
  END IF;
  v_i := (v_r ->> 'instance_id')::uuid;

  -- A player who has left the pool, so that the recovery half has something to
  -- recover.
  SELECT ps.id INTO v_sess FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp WHERE hp.player_id = ps.player_id AND hp.cluster_id = v_g)
   ORDER BY ps.entered_at DESC, ps.id LIMIT 1;
  UPDATE public.lightning_pool_session SET exited_at = clock_timestamp(), exit_reason = 'harness', state = 'closed'
   WHERE id = v_sess;

  PERFORM public.fx9_freeze();

  IF (public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6)) ->> 'reason') IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: a hand could be formed during the maintenance break';
  END IF;
  IF (public.fn_lightning_instance_open(v_g) ->> 'reason') IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: an instance could be opened during the maintenance break';
  END IF;
  IF (public.fn_lightning_instance_begin_dealing(v_i) ->> 'reason') IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: a hand could be released into gameplay during the maintenance break';
  END IF;
  IF (public.fn_lightning_pool_slot_open(v_sess) ->> 'reason') IS DISTINCT FROM 'platform_frozen' THEN
    RAISE EXCEPTION 'FAIL 11: a pool slot could be opened during the maintenance break';
  END IF;
  SELECT count(*)::integer INTO v_open FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL;

  -- AND THE RECOVERY PATHS ARE NOT GATED, because recovering a half-formed hand
  -- is exactly what an operator does during the break.
  IF coalesce((public.fn_lightning_instance_abandon(v_i, 'harness: abandoning during the break') ->> 'abandoned')::boolean, false)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: an instance could not be abandoned during the maintenance break, which wedges every incident that starts in one';
  END IF;
  IF (SELECT count(*)::integer FROM public.lightning_reservation
       WHERE lightning_instance_id = v_i AND state IN ('pending', 'committed')) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the players were not handed back by an abandon during the break';
  END IF;
  IF (public.fn_lightning_reap_formations() ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: the reaper refused to run during the maintenance break';
  END IF;
  v_sync := public.fn_lightning_pool_slots_sync(v_g);
  IF (v_sync ->> 'reason') IS DISTINCT FROM 'platform_frozen'
     OR (v_sync ->> 'slots_closed')::integer IS DISTINCT FROM 1
     OR (v_sync ->> 'slots_opened')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the sync pass did not close the departed player''s slot and refuse to open any during the break: %', v_sync;
  END IF;

  PERFORM public.fx9_thaw();
  IF coalesce((public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6)) ->> 'formed')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 11: formation did not resume when the break ended, so nothing above was about the freeze';
  END IF;
END $$;
\echo '  ok  11 THE FREEZE IS TOTAL ONE WAY  during a real engine_maintenance_break row that fn_platform_frozen() is proved to answer true for, forming a hand, opening an instance, releasing a hand into gameplay and opening a pool slot are all refused with platform_frozen - and abandoning an instance, having it hand its six committed players back, running the reaper and closing the slot of a player who has left the pool ALL STILL WORK, because recovering a half-formed hand is what an operator does during a break; and formation resumes the moment the break is lifted, so none of the refusals above were about anything else'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'

-- 12 P2 IS CONSULTED, AND CANNOT BE OVERRULED WITH SOMEBODY IT WOULD NOT PICK ----
DO $$
DECLARE
  v_g uuid; v_e integer; v_p uuid[]; v_q uuid[]; v_r jsonb; v_h uuid; v_i uuid; v_t text; i integer;
BEGIN
  v_g := public.fx9_cluster('P2', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  v_e := public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  v_p := public.fx9_candidates(v_g, 6);

  -- A KNOWN BB HISTORY. p[6] has never paid one; the others paid at known and
  -- distinct times, most recent first.
  FOR i IN 1 .. 5 LOOP
    UPDATE public.lightning_pool_slot SET last_bb_at = clock_timestamp() - (i || ' minutes')::interval
     WHERE cluster_id = v_g AND player_id = v_p[i] AND closed_at IS NULL;
  END LOOP;

  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'bb')::uuid IS DISTINCT FROM v_p[6] THEN
    RAISE EXCEPTION 'FAIL 12: the big blind is not the player who has never paid one';
  END IF;
  IF (v_r ->> 'sb')::uuid IS DISTINCT FROM v_p[5] THEN
    RAISE EXCEPTION 'FAIL 12: the small blind is not the next oldest unpaid big blind';
  END IF;
  v_h := (v_r ->> 'hand_id')::uuid; v_i := (v_r ->> 'instance_id')::uuid;
  SELECT string_agg(hp.player_id::text, ',' ORDER BY hp.seat) INTO v_t
    FROM public.lightning_hand_player hp WHERE hp.hand_id = v_h AND hp.seat >= 3;
  IF v_t IS DISTINCT FROM v_p[1] || ',' || v_p[2] || ',' || v_p[3] || ',' || v_p[4] THEN
    RAISE EXCEPTION 'FAIL 12: seats 3 to 6 are not in the order the caller gave them, so P3 has been quietly overruled: %', v_t;
  END IF;
  IF (v_r ->> 'btn')::uuid IS DISTINCT FROM v_p[4] THEN
    RAISE EXCEPTION 'FAIL 12: the button is not the last of the caller-ordered seats';
  END IF;

  -- THE STAMP, WITHOUT WHICH THE SAME PLAYER IS THE BIG BLIND FOR EVER.
  IF (SELECT last_bb_at FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_p[6] AND closed_at IS NULL) IS NULL
     OR (SELECT hands_since_bb FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_p[6] AND closed_at IS NULL) IS DISTINCT FROM 0
     OR (SELECT hands_since_bb FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_p[1] AND closed_at IS NULL) IS DISTINCT FROM 1
     OR (SELECT last_sb_at FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_p[5] AND closed_at IS NULL) IS NULL
     OR (SELECT last_button_at FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_p[4] AND closed_at IS NULL) IS NULL THEN
    RAISE EXCEPTION 'FAIL 12: the barrier did not stamp last_bb_at, last_sb_at, last_button_at and the hands_since counters';
  END IF;
  IF (SELECT bb_count FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_p[6]) IS DISTINCT FROM 1
     OR (SELECT sb_count FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_p[5]) IS DISTINCT FROM 1
     OR (SELECT btn_count FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_p[4]) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 12: the blind ledger did not count the roles the barrier assigned';
  END IF;
  -- AND NOT ONE DEBT COLUMN MOVED. Those are created when a blind is DUE and
  -- discharged when it is POSTED, and posting is barrier step 12.
  IF EXISTS (SELECT 1 FROM public.lightning_blind_ledger WHERE cluster_id = v_g
               AND (missed_bb_debt <> 0 OR missed_sb_debt <> 0 OR bb_owed <> 0 OR sb_owed <> 0)) THEN
    RAISE EXCEPTION 'FAIL 12: the barrier wrote a blind DEBT, which is money and is not its to write';
  END IF;

  -- THE ROTATION MOVES.
  PERFORM public.fn_lightning_instance_abandon(v_i, 'harness: section 12 rotation');
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'bb')::uuid IS NOT DISTINCT FROM v_p[6] THEN
    RAISE EXCEPTION 'FAIL 12: the same player is the big blind twice running, so last_bb_at is not being read';
  END IF;
  IF (v_r ->> 'bb')::uuid IS DISTINCT FROM v_p[5] THEN
    RAISE EXCEPTION 'FAIL 12: the second big blind is not the next oldest by the P2 key';
  END IF;

  -- AN UNRESOLVED OBLIGATION OUTRANKS A TIMESTAMP, which is tie-break order and
  -- not a preference: specification 601 puts the unresolved BB first.
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'harness: section 12 debt');
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 3, updated_at = clock_timestamp()
   WHERE cluster_id = v_g AND player_id = v_p[1];
  v_r := public.fn_lightning_form_hand(v_g, v_p);
  IF (v_r ->> 'bb')::uuid IS DISTINCT FROM v_p[1] THEN
    RAISE EXCEPTION 'FAIL 12: the player carrying an unresolved BB obligation was not the big blind';
  END IF;
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'harness: section 12 override');
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 0 WHERE cluster_id = v_g AND player_id = v_p[1];

  -- THE MATCHER MAY CHOOSE, AND MAY NOT CHOOSE SOMEBODY P2 WOULD NEVER HAVE.
  -- q[1..5] have never played and never paid a blind, so they tie on the whole
  -- key; v_p[6] paid one a moment ago and does not.
  v_q := ARRAY(SELECT sl.player_id FROM public.lightning_pool_slot sl
                WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.last_bb_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM public.lightning_blind_ledger bl
                                   WHERE bl.cluster_id = sl.cluster_id AND bl.player_id = sl.player_id)
                ORDER BY sl.player_id LIMIT 5);
  IF coalesce(array_length(v_q, 1), 0) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 12: there are not five untouched players to test the tie with';
  END IF;
  v_r := public.fn_lightning_form_hand(v_g, v_q || ARRAY[v_p[6]], NULL, NULL, v_p[6]);
  IF (v_r ->> 'reason') IS DISTINCT FROM 'bb_choice_is_not_p2_legal' THEN
    RAISE EXCEPTION 'FAIL 12: a big blind P2 would never have chosen was accepted: %', v_r;
  END IF;
  v_r := public.fn_lightning_form_hand(v_g, v_q || ARRAY[v_p[6]], NULL, NULL, v_q[5]);
  IF coalesce((v_r ->> 'formed')::boolean, false) IS DISTINCT FROM true
     OR (v_r ->> 'bb')::uuid IS DISTINCT FROM v_q[5] THEN
    RAISE EXCEPTION 'FAIL 12: a big blind that TIES with the barrier''s own choice on the whole key was refused: %', v_r;
  END IF;
END $$;
\echo '  ok  12 P2 IS CONSULTED  the big blind is the player who has never paid one and the small blind the next oldest, seats 3 to 6 stay in the order the CALLER gave them so that P3 is left to the matcher, the barrier stamps last_bb_at last_sb_at last_button_at and both hands_since counters and increments the six role counters in lightning_blind_ledger while touching not one of the four DEBT columns, the rotation really moves - the second hand out of the same six has a different big blind, and the next oldest by the key - an unresolved BB obligation outranks a fresher timestamp exactly as specification 601 orders it, a matcher-supplied big blind that P2 would never have chosen is refused by name, and one that TIES with the barrier''s own choice on the whole key is accepted'

-- 13 NOTHING HERE IS REACHABLE BY A BROWSER -------------------------------------
DO $$
DECLARE v_n integer; v_bad text;
BEGIN
  SELECT string_agg(DISTINCT routine_name || '/' || grantee, ', ') INTO v_bad
    FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public' AND routine_name ~ '^fn_lightning_'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: a browser role can execute %', v_bad;
  END IF;

  SELECT count(*)::integer INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_'
     AND p.prorettype <> 'trigger'::regtype;
  IF v_n IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'FAIL 13: this phase installed % callable functions, not nine', v_n;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_'
     AND p.prorettype <> 'trigger'::regtype
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: service_role cannot execute %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_'
     AND (p.prosecdef OR array_to_string(p.proconfig, ',') !~ 'search_path');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: % is SECURITY DEFINER or carries no search_path', v_bad;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO v_bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'lightning%'
     AND NOT c.relrowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: row level security is off on %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname LIKE 'lightning%') THEN
    RAISE EXCEPTION 'FAIL 13: a lightning table has an RLS policy, so something believes a browser reaches it';
  END IF;
  SELECT string_agg(DISTINCT table_name || '/' || grantee, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name LIKE 'lightning%'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: a browser role holds a grant on %', v_bad;
  END IF;

  -- AND ONLY THE BARRIER FORMS A HAND.
  SELECT string_agg(p.proname, ', ') INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
         ~ 'INSERT INTO[[:space:]]+(public\.)?lightning_hand_player';
  IF v_bad IS DISTINCT FROM 'fn_lightning_form_hand' THEN
    RAISE EXCEPTION 'FAIL 13: the functions that can seat a participant are %, not the barrier alone', v_bad;
  END IF;
END $$;
\echo '  ok  13 NO BROWSER REACHES IT  specification 532 holds in the catalogue: anon, authenticated and PUBLIC execute NONE of the fifteen functions this phase installs, service_role executes all nine callable ones, not one of them is SECURITY DEFINER and every one carries an explicit search_path, every lightning table still has row level security on with zero policies and no grant to any browser role, and the only function in the entire estate that can insert a participant into a hand is the barrier itself'
ASSERT

# 14 EVERY LIVE PROOF ----------------------------------------------------------
# `-- @live-proof:` lines are COMMENTS, so nothing in a psql run evaluates them,
# and proofs that drift away from the code they were written about have shipped
# false in three separate rounds of an earlier Lightning phase.
#
# Generated from the file under test rather than written by hand, for the same
# reason this harness applies the real predecessor migrations rather than
# transcribing them: a hand-copied list is a second place for a proof to drift.
# Each expression is inlined as CODE rather than as a string literal, so nothing
# in it needs escaping and a proof that no longer PARSES fails the run too.
#
# There is no quarantine here and there must not be one.
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
  printf '%s%s%s\n' "\\echo '  ok  14 EVERY LIVE PROOF    all " "$proof_n" " @live-proof expressions the migration carries in its own header were extracted from the file under test, inlined as code so that one which no longer PARSES is a failure too, and evaluated against the catalogue and the estate every section above built - twelve Clusters converted by the real conversion, dozens of hands formed, reserved, dealt, abandoned and reaped - and every single one of them is true, with no quarantine and no exception list'"
} >> "$fixture/live-proofs.sql"

# 15 THE FILE IS RE-APPLIABLE --------------------------------------------------
cat > "$fixture/precapture.sql" <<'CAP'
CREATE TEMP TABLE reapply AS
  SELECT p.proname::text AS name,
         pg_get_functiondef(p.oid) AS body,
         coalesce(array_to_string(p.proacl, ','), '(default)') AS acl,
         coalesce(obj_description(p.oid, 'pg_proc'), '') AS note
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_';
CREATE TEMP TABLE reapply_rows AS
  SELECT 'instance' AS t, count(*) AS n FROM public.lightning_instance
  UNION ALL SELECT 'reservation', count(*) FROM public.lightning_reservation
  UNION ALL SELECT 'hand', count(*) FROM public.lightning_hand
  UNION ALL SELECT 'hand_player', count(*) FROM public.lightning_hand_player
  UNION ALL SELECT 'pool_slot', count(*) FROM public.lightning_pool_slot
  UNION ALL SELECT 'blind_ledger', count(*) FROM public.lightning_blind_ledger;
CREATE TEMP TABLE reapply_idx AS
  SELECT indexname::text AS name, indexdef AS def FROM pg_indexes
   WHERE schemaname = 'public' AND tablename LIKE 'lightning%';
CAP

cat > "$fixture/reapply-assertions.sql" <<'REAPPLY'
DO $$
DECLARE v_bad text; v_n integer;
BEGIN
  IF (SELECT count(*) FROM reapply) IS DISTINCT FROM 15 THEN
    RAISE EXCEPTION 'FAIL 15: % function bodies were captured before the re-apply, not fifteen', (SELECT count(*) FROM reapply);
  END IF;
  SELECT string_agg(r.name, ', ') INTO v_bad
    FROM reapply r LEFT JOIN (
      SELECT p.proname::text AS name, pg_get_functiondef(p.oid) AS body,
             coalesce(array_to_string(p.proacl, ','), '(default)') AS acl,
             coalesce(obj_description(p.oid, 'pg_proc'), '') AS note
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_') now
      ON now.name = r.name
   WHERE now.body IS DISTINCT FROM r.body OR now.acl IS DISTINCT FROM r.acl OR now.note IS DISTINCT FROM r.note;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the second application changed the body, the acl or the comment of %', v_bad;
  END IF;

  SELECT string_agg(r.t, ', ') INTO v_bad FROM reapply_rows r
   WHERE r.n IS DISTINCT FROM (CASE r.t
     WHEN 'instance' THEN (SELECT count(*) FROM public.lightning_instance)
     WHEN 'reservation' THEN (SELECT count(*) FROM public.lightning_reservation)
     WHEN 'hand' THEN (SELECT count(*) FROM public.lightning_hand)
     WHEN 'hand_player' THEN (SELECT count(*) FROM public.lightning_hand_player)
     WHEN 'pool_slot' THEN (SELECT count(*) FROM public.lightning_pool_slot)
     ELSE (SELECT count(*) FROM public.lightning_blind_ledger) END);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the second application changed the row count of %', v_bad;
  END IF;

  SELECT string_agg(i.name, ', ') INTO v_bad FROM reapply_idx i
   WHERE i.def IS DISTINCT FROM (SELECT x.indexdef FROM pg_indexes x
                                  WHERE x.schemaname = 'public' AND x.indexname = i.name);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 15: the second application changed index %', v_bad;
  END IF;

  SELECT count(*)::integer INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname LIKE 'lightning%'
     AND t.tgname LIKE 'trg_lightning%';
  IF v_n IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 15: there are % Phase 9 triggers after the second application, not six', v_n;
  END IF;

  -- AND THE ESTATE STILL WORKS. A migration that applies twice and leaves a
  -- Cluster unable to form is re-appliable and broken. Everybody on the ground
  -- Cluster is in a hand by now, so the instances are ended first - which also
  -- exercises the release trigger one more time, after a second application.
  PERFORM public.fn_lightning_instance_abandon(li.id, 'harness: section 15 re-apply')
     FROM public.lightning_instance li
    WHERE li.cluster_id = (SELECT game FROM b9 WHERE k = 'ground')
      AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
  IF (SELECT count(*)::integer FROM public.lightning_reservation r
       WHERE r.cluster_id = (SELECT game FROM b9 WHERE k = 'ground')
         AND r.state IN ('pending', 'committed')) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 15: the release trigger did not run after the second application';
  END IF;
  IF coalesce((public.fn_lightning_form_hand((SELECT game FROM b9 WHERE k = 'ground'),
       public.fx9_candidates((SELECT game FROM b9 WHERE k = 'ground'), 6)) ->> 'formed')::boolean, false)
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 15: a Cluster that formed hands before the re-apply cannot form one after it';
  END IF;
END $$;
\echo '  ok  15 IT IS RE-APPLIABLE  the migration applied a second time over an estate full of formed hands, committed reservations, abandoned instances and stamped blind ledgers leaves all fifteen function bodies, all fifteen acls and every comment byte-identical, every index definition identical, exactly six Phase 9 triggers rather than twelve, not one row added or removed from any of the six lightning tables - and the estate still forms a hand afterwards, because a file that re-applies cleanly and leaves the feature dead is re-appliable and broken'
REAPPLY

# ONE psql SESSION, FIFTEEN FILES: the four fixtures, the seven predecessor
# migrations, the pre-migration measurements and the estate they build, the
# migration, the assertions, the migration's own @live-proofs, the pre-re-apply
# capture, the migration AGAIN and the re-apply assertions.
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
  -f "$phase5" \
  -f "$phase5r" \
  -f "$p9_fixture" \
  -f "$fixture/pre.sql" \
  -f "$migration" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$migration" \
  -f "$fixture/reapply-assertions.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# SIXTEEN SECTIONS REPORTED, and the count is asserted rather than eyeballed: a
# psql that stopped early exits non-zero, but a section deleted from this file
# during a refactor would not, and the PASS line below would still print.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 16 ]; then
  echo "FAIL: $oks of the 16 sections reported, so this run proved less than this file claims"
  exit 1
fi

echo "PASS: Lightning Phase 9, the hand formation barrier is atomic and the participant set is locked, 16 checks: THE ESTATE IS REAL - every Cluster in this file is made Lightning by the REAL fn_cash_cluster_begin_pending_on and the REAL fn_cash_cluster_commit_lightning over the real 40,000-character tick, and fx9_convert RAISES rather than continuing if a conversion did not happen, so every hand formed below is formed inside an epoch a real conversion opened, over pool sessions a real conversion wrote, against starting_stack values a real conversion copied out of table_seats. Before the migration: no fn_lightning_ function, no trigger on any lightning table, the P2 index lightning_pool_slot_oldest_bb standing with NOT ONE reader of last_bb_at anywhere in the estate, NOT ONE function that inserts a lightning_pool_slot, an eighteen-player conversion that opens eighteen pool sessions and zero slots - which is why a reservation could not have been taken for anybody - and the two-concurrent-slots bypass demonstrated by actually opening two. After it: the sync pass opens the founding population's slots and is idempotent; the barrier forms a six-hand with the instance bound to the hand and the epoch, participants_locked_at set at a player_count the latch trigger checked against the rows, seats 1 to 6 carrying sb bb utg hj co btn, every stack_before equal to its own pool session's starting_stack plus net_result, six committed reservations each in the seat the hand gave it, and begin_dealing releasing it into gameplay and refusing a second release; a fault injected at the hand write and again at the participant write leaves NOT ONE instance, reservation, hand, participant or moved fairness column behind - compared as a whole-Cluster census - while the matcher_retry event emitted after the rollback carries the sqlstate and the message, and the same six players form immediately with the injectors off; a player in a hand cannot be reserved again, the refusal coming from lightning_reservation_one_active_per_player attempted straight against the table, the two-slot bypass is refused by lightning_pool_slot_one_open_per_player, and the claim comes off through an AFTER trigger when the instance reaches a terminal state so that the settlement phase nobody has written yet cannot forget it; a stale pending reservation makes its player illegal at five candidates of six, the reaper expires it with a reason, an expired claim cannot become pending again, and the six form immediately afterwards; an instance inserted with no deadline gets one in the future, one whose deadline equals its creation is refused by CHECK, a stale forming instance is buried by the NEXT formation on the same Cluster with nothing scheduled anywhere while one inside its deadline survives the identical pass, and a formed hand that was never released cannot be dealt late and hands its six players back; all four of specification 519-524 are attempted against a hand this file really formed and really locked and refused BY NAME, and every one of those same statements succeeds against an unlocked twin hand on the same Cluster, with the latch unclearable, the hand undeletable, the instance un-re-pointable, a lock at a wrong count refused, the twin immutable the moment it IS locked, a pool slot that sat in a hand undeletable out from under its reservations, and fold_type and stack_after still writable because a locked hand that cannot be played is a barrier that froze the game; a must_move Cluster is refused by name and cannot have an instance created for it against the table, lightning_enabled false stops formation and true restores it, and after a real epoch bump the previous epoch's slot holders are ZERO legal candidates while an instance at the previous epoch is refused and one at the current epoch accepted in the same breath; forming, releasing and abandoning leave an md5 of every money-bearing column of every table_seats, cash_player_session, lightning_pool_session and lightning_blind_ledger row byte-identical, through a measure first proved to move for one cent and come back, and a trigger injected to move a chip DURING a formation is refused by the barrier's own LIGHTNING_FORMATION_MOVED_MONEY guard, which raises rather than retrying; a horse seated by table_seats.horse_id converts, pools, slots, reserves, seats, takes a position and a blind role and a stack snapshot and a blind-ledger row exactly as a human does, and no Phase 9 function body mentions a horse at all; the freeze refuses forming, opening, releasing and slot-opening and does NOT refuse abandoning, reaping or closing a departed player's slot, and formation resumes when the break lifts; P2's oldest-unresolved-BB key really decides the big blind, the rotation really moves, an unresolved obligation outranks a fresher timestamp, seats 3 to 6 stay in the caller's order so P3 is left to the matcher, not one DEBT column is written, and a matcher-supplied big blind is refused unless it ties with the barrier's own choice on the whole key; anon, authenticated and PUBLIC execute none of the fifteen functions, service_role executes all nine callable ones, none is SECURITY DEFINER, RLS is on with no policies and no browser grant on any lightning table, and the barrier is the ONLY function in the estate that can seat a participant; all of the migration's own @live-proof expressions are extracted from the file under test and true; and the migration applied a SECOND time leaves fifteen bodies, fifteen acls, every comment and every index definition byte-identical with exactly six triggers and not one row moved, over an estate full of formed hands"
