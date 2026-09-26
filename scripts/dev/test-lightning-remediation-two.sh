#!/usr/bin/env bash
# Lightning Phases 5 and 9, remediation two: the seat is the anchor, the pool
# follows it, and a halt is a stop only once the engine has seen it.
#
# Proves 20260926045132 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55551 (LIGHTNING_R2_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The three Lightning fixtures, every Lightning
# migration from 20260920235343 through 20260926023047 in order, the Phase 9
# writers, this harness's own fixture, then the migration under test - twice.
# Every Cluster here is made Lightning by the REAL fn_cash_cluster_begin_pending_on
# and the REAL fn_cash_cluster_commit_lightning (fx9_convert raises unless it
# converted), every pool slot comes from the real sync or the real pool door,
# and every hand is formed by the real barrier.
#
# THE SHAPE OF EVERY PROOF. Section 01 runs against 20260926023047's code and
# REPRODUCES every defect the migration repairs, on the estate it builds; the
# migration is then applied over that estate, and each later section proves
# one repair with a bad twin (refused, frozen, not entered, not counted) and a
# good twin one thing apart (accepted, retried, entered, counted), on the same
# board. A refusal a fixture could never have satisfied proves nothing, and a
# catcher that swallows everything makes every refusal vacuous - section 00
# proves the catchers catch.
#
# LAW 10.5. Horses are seated through table_seats.horse_id and are converted,
# entered, formed, guarded and exited exactly as humans are; nothing here or in
# the migration reads is_horse.
#
# THE RULES, inherited from the Phase 5 and Phase 9 harnesses: every
# comparison in an assertion is IS DISTINCT FROM; every negative is paired with
# its positive; grants are asserted both ways; the catalogue and the estate are
# asked, never the migration's text, except where the text IS the claim (the
# @live-proof lines, section 17).
#
# LIGHTNING_R2_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_R2_PORT:-55551}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
base_fixture=$F/lightning-phase3-remediation-schema.sql
pop_fixture=$F/lightning-phase4-population-schema.sql
p5_fixture=$F/lightning-phase5-conversion-schema.sql
p9_fixture=$F/lightning-phase9-formation-fixture.sql
r2_fixture=$F/lightning-remediation-two-fixture.sql
phase2=$M/20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql
phase2r=$M/20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql
phase3=$M/20260921025523_lightning_phase_3_a_lightning_capable_game_opens_as_a_feeder.sql
phase3r=$M/20260921044045_lightning_phase_3_remediation_the_front_table_is_the_main_ga.sql
phase4=$M/20260921064717_lightning_phase_4_one_live_eligible_population_and_the_thres.sql
phase4r=$M/20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_.sql
phase5=$M/20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_.sql
phase5r=$M/20260925204249_lightning_phase_5_remediation_the_halt_is_a_standing_bar.sql
phase9=$M/20260925215731_lightning_phase_9_the_hand_formation_barrier_is_atomic_and_t.sql
phase9r=$M/20260926023047_lightning_phase_9_remediation_nothing_holds_a_player_that_no.sql
mine=${LIGHTNING_R2_MIGRATION:-$M/20260926045132_lightning_phase_5_and_9_remediation_two_the_seat_is_the_anch.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$phase2" "$phase2r" \
         "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" "$phase9" "$phase9r" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-r2-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p $port -h ''" start >/dev/null
started=1

# THE GROUND: sections 00 and 01, against 20260926023047's code.
cat > "$fixture/ground.sql" <<'ASSERT'
CREATE TEMP TABLE r2 (k text PRIMARY KEY, game uuid, a uuid, b uuid, t text, n bigint);
-- pg_stat_get_xact_function_calls is how the WHEN clauses are proved to keep
-- PL/pgSQL out of an ordinary stack update (section 04).
SET track_functions = 'all';

-- THE INJECTORS, named zz_ so they fire after the migration's own triggers.
CREATE TRIGGER zz_fxr_raise_hand_player BEFORE INSERT ON public.lightning_hand_player
  FOR EACH ROW EXECUTE FUNCTION public.fxr_raise('hand_player');
CREATE TRIGGER zz_fxr_move_anchor_chip BEFORE INSERT ON public.lightning_hand_player
  FOR EACH ROW EXECUTE FUNCTION public.fxr_move_anchor_chip();
CREATE TRIGGER zz_fxr_elsewhere_during BEFORE INSERT ON public.lightning_hand_player
  FOR EACH ROW EXECUTE FUNCTION public.fxr_elsewhere_during();
CREATE TRIGGER zz_fxr_break_abort BEFORE UPDATE ON public.cash_cluster_conversion
  FOR EACH ROW EXECUTE FUNCTION public.fxr_break_abort();

-- 00 THE CATCHERS CATCH ---------------------------------------------------------
DO $$
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: fxr_try does not report a real division by zero with its class: %', public.fxr_try('SELECT 1/0');
  END IF;
  IF public.fxr_try('SELECT 1') IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 00: fxr_try reports an error for a statement that has none';
  END IF;
  IF public.fxr_probe('SELECT 1') IS DISTINCT FROM 'ok 1' OR public.fxr_probe('SELECT 1/0') !~ '^22012' THEN
    RAISE EXCEPTION 'FAIL 00: fxr_probe does not tell a statement that ran from one that failed';
  END IF;
  IF public.fx9_try('SELECT 1/0') !~ 'division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: fx9_try does not catch';
  END IF;
  IF public.fxr_other('SET application_name = ''fxr_other''') IS DISTINCT FROM 'SET'
     OR public.fxr_other_ask('SELECT pg_backend_pid()::text') IS NOT DISTINCT FROM pg_backend_pid()::text THEN
    RAISE EXCEPTION 'FAIL 00: the second backend does not answer';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'FAIL 00: the platform is frozen before anything has happened';
  END IF;
  PERFORM public.fx9_freeze();
  PERFORM public.fx9_thaw();
END $$;
\echo '  ok  00 THE CATCHERS CATCH  fxr_try reports a real division by zero with its SQLSTATE and nothing for a clean statement, fxr_probe tells a statement that ran and was undone from one that failed, fx9_try catches, the second backend answers, and the freeze switch turns fn_platform_frozen() on and off before anything depends on it'

-- 01 THE GROUND: EVERY DEFECT, REPRODUCED ON 20260926023047'S CODE ------------
DO $$
DECLARE
  v_g uuid; v_g2 uuid; v_g7a uuid; v_g7b uuid; v_g8 uuid; v_main uuid; v_req uuid := gen_random_uuid();
  v_r jsonb; v_h uuid; v_i uuid; v_p uuid[]; v_p2 uuid[]; v_q uuid; v_l uuid; v_x uuid; v_seat uuid;
  v_u uuid; v_ui uuid; v_t text; v_feeder uuid; v_n integer;
BEGIN
  -- NOTHING OF THIS FILE EXISTS YET.
  IF to_regprocedure('public.fn_lightning_pool_enter(uuid,timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_pool_session'::regclass AND attname = 'anchor_seat_id') THEN
    RAISE EXCEPTION 'FAIL 01: an object of the migration under test exists before it is applied';
  END IF;

  -- DEFECT 1, THE COMMIT CANNOT SEE A HAND IN FLIGHT. Eighteen players, two of
  -- them horses; PENDING_ON; then a hand in flight on Main 1 in the shape the
  -- engine leaves it - an incomplete hand_state_snapshots row - and a live
  -- engine lease on that table that has never reported seeing the halt. The
  -- commit of 20260925204249 converts anyway.
  v_g := public.fx9_cluster('G1', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 16);
  PERFORM public.fx9_seat(v_g, 2, 17, true);
  v_main := public.fxr_main(v_g);
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, v_req);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: begin_pending_on refused G1: %', v_r;
  END IF;
  PERFORM public.fxr_snapshot(v_main, false);
  PERFORM public.fxr_lease(v_main, true);
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
  IF (v_r ->> 'converted')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: the old commit did not convert over a hand in flight, so the defect is not reproduced: %', v_r;
  END IF;
  INSERT INTO r2 (k, game, a, n) VALUES ('g1', v_g, v_main, (v_r ->> 'epoch_after')::integer);
  -- Complete that hand and retire the lease, so nothing later reads them.
  UPDATE public.hand_state_snapshots SET is_complete = true WHERE table_id = v_main;
  DELETE FROM public.engine_table_leases WHERE table_id = v_main;

  PERFORM public.fx9_pool(v_g);
  -- Humans only in this first hand, so that section 05 always has a free
  -- horse to form with; horses are formed, guarded and exited there.
  v_p := ARRAY(SELECT x FROM unnest(public.fx9_candidates(v_g)) x
                WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.user_id = x AND ts.horse_id IS NOT NULL)
                LIMIT 6);
  v_r := public.fn_lightning_form_hand(v_g, v_p, p_matcher_version => 'fxr-matcher-1');
  IF (v_r ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: the old barrier did not form G1''s first hand: %', v_r;
  END IF;
  v_h := (v_r ->> 'hand_id')::uuid;
  v_i := (v_r ->> 'instance_id')::uuid;
  INSERT INTO r2 (k, game, a, b) VALUES ('g1_hand', v_g, v_h, v_i);

  -- DEFECT 4, A PLAYER IN A LIVE HAND CAN BE CASHED OUT. A participant's seat
  -- stack and departure are both writable under the old code (each undone).
  SELECT ts.id INTO v_seat FROM public.table_seats ts
   WHERE ts.user_id = v_p[1] AND ts.left_at IS NULL LIMIT 1;
  IF public.fxr_probe(format('UPDATE public.table_seats SET stack = stack - 50 WHERE id = %L', v_seat)) IS DISTINCT FROM 'ok 1'
     OR public.fxr_probe(format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_seat)) IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 01: a participant''s seat was already guarded before the migration, so defect 4 is not reproduced';
  END IF;

  -- DEFECT 3, TWO COPIES OF THE STACK. A non-participant's seat gains 25 chips
  -- (a top-up); the pool's copy does not move.
  SELECT ps.player_id INTO v_q FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.player_id <> ALL (v_p)
   ORDER BY ps.entered_at, ps.id LIMIT 1;
  UPDATE public.table_seats SET stack = stack + 25 WHERE user_id = v_q AND left_at IS NULL;
  IF public.fn_lightning_pool_stack((SELECT id FROM public.lightning_pool_session WHERE player_id = v_q AND exited_at IS NULL))
     IS NOT DISTINCT FROM (SELECT stack FROM public.table_seats WHERE user_id = v_q AND left_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 01: the pool stack followed the seat before the migration, so defect 3 is not reproduced';
  END IF;
  INSERT INTO r2 (k, game, a) VALUES ('g1_topped_up', v_g, v_q);

  -- DEFECT 2, NOTHING TAKES A PLAYER OUT, NOBODY NEW GETS IN. Another
  -- non-participant leaves; a new player sits down after the conversion.
  SELECT ps.player_id INTO v_l FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.player_id <> ALL (v_p) AND ps.player_id <> v_q
   ORDER BY ps.entered_at, ps.id LIMIT 1;
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE user_id = v_l AND left_at IS NULL;
  INSERT INTO r2 (k, game, a) VALUES ('g1_left', v_g, v_l);
  v_seat := public.fxr_join(v_g, v_main, 30, 150.00);
  INSERT INTO r2 (k, game, a, b) VALUES ('g1_joined', v_g, (SELECT user_id FROM public.table_seats WHERE id = v_seat), v_seat);

  -- DEFECT 5, A PARTICIPANT MOVED OUT OF A LOCKED HAND. An unlocked hand on
  -- the same Cluster and epoch, and one of H1's rows moved into it (undone).
  v_ui := ((public.fn_lightning_instance_open(v_g)) ->> 'instance_id')::uuid;
  v_u := gen_random_uuid();
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id,
      rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version)
  SELECT v_u, v_g, g.cluster_epoch, v_ui, 'fxr', 'fxr', 'fxr', 'fxr', 'fxr'
    FROM public.cash_games g WHERE g.id = v_g;
  INSERT INTO r2 (k, game, a, b) VALUES ('g1_unlocked', v_g, v_u, v_ui);
  IF public.fxr_probe(format('UPDATE public.lightning_hand_player SET hand_id = %L WHERE hand_id = %L AND player_id = %L',
                             v_u, v_h, v_p[3])) IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 01: moving a participant out of a locked hand was already refused, so defect 5 is not reproduced';
  END IF;

  -- DEFECT 7, AN IMPOSSIBLE STATE IS RETRIED. A check_violation injected at
  -- the participant write comes back as a retry, and the Cluster keeps dealing.
  PERFORM set_config('fxr.raise_hand_player', '23514', false);
  v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6), p_matcher_version => 'fxr-matcher-1');
  PERFORM set_config('fxr.raise_hand_player', '', false);
  IF (v_r ->> 'retry')::boolean IS DISTINCT FROM true
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 01: an injected check_violation was not a retry before the migration: %', v_r;
  END IF;

  -- DEFECT 11, THE GROUND IT STANDS ON.
  IF NOT has_table_privilege('service_role', 'public.lightning_hand', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.cash_cluster_conversion', 'DELETE')
     OR pg_get_functiondef('public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure) !~ 'bl\.updated_at' THEN
    RAISE EXCEPTION 'FAIL 01: DELETE was already revoked or the blind order already ignored updated_at';
  END IF;
END $$;

-- DEFECT 2, OBSERVED AFTER THE COMMITS THAT WOULD HAVE ACTED.
DO $$
DECLARE v_g uuid; v_l uuid; v_j uuid;
BEGIN
  SELECT game, a INTO v_g, v_l FROM r2 WHERE k = 'g1_left';
  SELECT a INTO v_j FROM r2 WHERE k = 'g1_joined';
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_l AND exited_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_l AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 01: a departed player''s pool session or slot was already closed, so defect 2 is not reproduced';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_j) THEN
    RAISE EXCEPTION 'FAIL 01: a player who joined after the conversion already got a pool session';
  END IF;
END $$;

-- DEFECTS 6 AND 8, ON A SECOND CLUSTER, EACH UNDONE.
DO $$
DECLARE
  v_g uuid; v_r jsonb; v_d jsonb; v_i uuid; v_m uuid; v_t text; v_ok boolean;
BEGIN
  v_g := public.fx9_cluster('G2', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  PERFORM public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  INSERT INTO r2 (k, game) VALUES ('g2', v_g);

  -- DEFECT 6: an old caller clock deals a formation that is already dead, and
  -- a Cluster with Lightning switched off still deals.
  BEGIN
    v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6),
             p_now => clock_timestamp() - interval '10 minutes', p_matcher_version => 'fxr-matcher-1');
    v_i := (v_r ->> 'instance_id')::uuid;
    v_d := public.fn_lightning_instance_begin_dealing(v_i, p_now => clock_timestamp() - interval '10 minutes');
    IF (v_d ->> 'dealing')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 01: an old p_now did not deal a dead formation, so defect 6 is not reproduced: % / %', v_r, v_d;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;
  BEGIN
    v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6), p_matcher_version => 'fxr-matcher-1');
    UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
    v_d := public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid);
    IF (v_d ->> 'dealing')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 01: begin_dealing already refused a Cluster with Lightning off, so defect 6 is not reproduced: %', v_d;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;

END $$;

-- The other backend sees only what is committed, so G2 is committed first.
DO $$
DECLARE v_g uuid; v_t text; v_m uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  -- DEFECT 8: the slot pass takes no Cluster lock (it runs while another
  -- backend holds the row), while the tick takes the row FOR UPDATE even for a
  -- Lightning Cluster it is only going to stand down for.
  v_t := public.fxr_other('BEGIN');
  IF v_t IS DISTINCT FROM 'BEGIN' THEN
    RAISE EXCEPTION 'FAIL 01: the other backend could not open a transaction: %', v_t;
  END IF;
  v_t := public.fxr_other_ask(format('SELECT id::text FROM public.cash_games WHERE id = %L FOR UPDATE', v_g));
  IF v_t IS DISTINCT FROM v_g::text THEN
    RAISE EXCEPTION 'FAIL 01: the other backend could not hold G2''s row: %', v_t;
  END IF;
  PERFORM set_config('lock_timeout', '200ms', true);
  v_t := public.fxr_try(format('SELECT public.fn_lightning_pool_slots_sync(%L)', v_g));
  IF v_t IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 01: the old slot pass waited on the Cluster row: %', v_t;
  END IF;
  v_t := public.fxr_try(format('SELECT public.fn_cash_cluster_tick(%L)', v_g));
  IF v_t !~ '^55P03' THEN
    RAISE EXCEPTION 'FAIL 01: the old tick did not wait on a Lightning Cluster''s row: %', v_t;
  END IF;
  PERFORM set_config('lock_timeout', '0', true);
  PERFORM public.fxr_other('ROLLBACK');

  -- DEFECT 8: a slot whose opened_at is ahead of the pass's clock cannot be
  -- closed by the old pass - the CHECK refuses the whole pass.
  BEGIN
    SELECT ps.id INTO v_m FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL ORDER BY ps.entered_at, ps.id LIMIT 1;
    UPDATE public.lightning_pool_slot SET opened_at = clock_timestamp() + interval '1 hour'
     WHERE pool_session_id = v_m AND closed_at IS NULL;
    UPDATE public.lightning_pool_session SET exited_at = clock_timestamp() + interval '2 hours', exit_reason = 'fxr'
     WHERE id = v_m;
    v_t := public.fxr_try(format('SELECT public.fn_lightning_pool_slots_sync(%L)', v_g));
    IF v_t !~ '^23514' THEN
      RAISE EXCEPTION 'FAIL 01: the old pass closed a slot opened in the future without violating its CHECK: %', v_t;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;
END $$;

-- DEFECTS 1 AND 9, ON CLUSTERS LEFT PENDING_ON FOR THE SECTIONS AFTER.
DO $$
DECLARE v_a uuid; v_b uuid; v_c uuid; v_f uuid; v_t text;
BEGIN
  v_a := public.fx9_cluster('G7A', 6, 40, true); PERFORM public.fx9_seat(v_a, 18);
  v_b := public.fx9_cluster('G7B', 6, 40, true); PERFORM public.fx9_seat(v_b, 18);
  v_c := public.fx9_cluster('G8', 6, 40, true);  PERFORM public.fx9_seat(v_c, 18);
  IF (public.fn_cash_cluster_begin_pending_on(v_a, gen_random_uuid()) ->> 'ok')::boolean IS DISTINCT FROM true
     OR (public.fn_cash_cluster_begin_pending_on(v_b, gen_random_uuid()) ->> 'ok')::boolean IS DISTINCT FROM true
     OR (public.fn_cash_cluster_begin_pending_on(v_c, gen_random_uuid()) ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 01: a Cluster did not enter PENDING_ON';
  END IF;

  -- DEFECT 1: a table opened inside a PENDING_ON Cluster is born dealing.
  v_f := public.fn_cash_cluster_open_table(v_c, 'feeder', NULL, 'live', NULL);
  IF (SELECT dealing_halted_at FROM public.tables WHERE id = v_f) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: a table opened in PENDING_ON was already born halted';
  END IF;
  INSERT INTO r2 (k, game, a) VALUES ('g8', v_c, v_f);

  -- DEFECT 9: two stuck conversions, one whose abort fails; the old reaper
  -- rolls the whole pass back and both stay stuck.
  UPDATE public.cash_cluster_conversion SET opened_at = clock_timestamp() - interval '1 hour'
   WHERE cluster_id IN (v_a, v_b);
  PERFORM set_config('fxr.break_abort_cluster', v_a::text, false);
  v_t := public.fxr_try('SELECT public.fn_cash_cluster_reap_stuck_conversions()');
  PERFORM set_config('fxr.break_abort_cluster', '', false);
  IF v_t !~ 'FXR_INJECTED_ABORT_FAULT'
     OR (SELECT count(*) FROM public.cash_cluster_conversion WHERE cluster_id IN (v_a, v_b) AND status = 'pending') IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL 01: the old reaper survived one failed abort, so defect 9 is not reproduced: %', v_t;
  END IF;
  INSERT INTO r2 (k, game, b) VALUES ('g7', v_a, v_b);

  -- DEFECT 10: not one of the specification's events exists anywhere.
  IF EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind IN ('cluster_epoch_started', 'pool_player_joined',
               'pool_player_left', 'instance_created', 'instance_started', 'instance_completed',
               'instance_destroyed', 'pool_player_reserved', 'pool_player_released', 'hand_created')) THEN
    RAISE EXCEPTION 'FAIL 01: a specification event already exists before the migration';
  END IF;
END $$;
\echo '  ok  01 THE GROUND  on 20260926023047''s code every defect is reproduced: a real commit converts G1 over an incomplete hand_state_snapshots row and a live engine lease that never saw the halt; a participant of a live hand can have their seat stack cut and their seat vacated; a top-up moves the seat and not the pool''s copy; a departed player keeps an open pool session and slot and a player seated after the conversion gets none; a participant moves out of a locked hand into an unlocked one; an injected check_violation is a retry and the Cluster keeps dealing; an old p_now deals a dead formation and a Cluster with Lightning off still deals; the slot pass runs under another backend''s Cluster lock while the tick waits on a Lightning Cluster''s row; a slot opened in the future breaks the pass''s CHECK; a table opened in PENDING_ON is born dealing; one failed abort rolls the whole conversion reap back; no specification event exists; and DELETE is granted and the blind order ages debt by updated_at'
ASSERT

# SECTIONS 02 TO 16, against the migration.
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 02 THE SCHEMA, AND THE ESTATE IT WAS APPLIED OVER ----------------------------
DO $$
DECLARE
  v_g uuid; v_j uuid; v_jseat uuid; v_l uuid; v_n bigint; v_t text; v_other_seat uuid; v_e integer;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g1';
  SELECT a, b INTO v_j, v_jseat FROM r2 WHERE k = 'g1_joined';
  SELECT a INTO v_l FROM r2 WHERE k = 'g1_left';
  SELECT cluster_epoch INTO v_e FROM public.cash_games WHERE id = v_g;

  -- EVERY POOL SESSION THE GROUND LEFT IS ANCHORED, to a seat of its own
  -- player in its own Cluster, and there are enough of them to mean it.
  SELECT count(*) INTO v_n FROM public.lightning_pool_session;
  IF v_n < 36 THEN
    RAISE EXCEPTION 'FAIL 02: only % pool sessions stood before the migration, so the backfill proves little', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.lightning_pool_session ps
    LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
    LEFT JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.id IS NULL OR ts.user_id IS DISTINCT FROM ps.player_id OR tb.cluster_id IS DISTINCT FROM ps.cluster_id;
  IF v_n IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 02: % pool session(s) are anchored to a seat that is not their player''s in their Cluster', v_n;
  END IF;
  -- The departed player of the ground is anchored to the seat that left, the
  -- only seat they ever had there.
  IF (SELECT ts.left_at FROM public.table_seats ts WHERE ts.id = public.fxr_anchor(v_g, v_l)) IS NULL THEN
    RAISE EXCEPTION 'FAIL 02: the departed player''s backfilled anchor is not the seat that left';
  END IF;

  -- THE PLAYER THE OLD CODE NEVER LET IN is entered by the migration's one-time
  -- sweep, through the same door, anchored to his own seat with a slot.
  IF public.fxr_anchor(v_g, v_j) IS DISTINCT FROM v_jseat
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE cluster_id = v_g AND player_id = v_j AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 02: the player seated after the old conversion was not swept into the pool';
  END IF;

  -- ONE OPEN SESSION PER ANCHOR, and the anchor is a real seat. A stranger
  -- with a seat but no cash session (so no pool session) is given one by hand:
  -- on somebody else's anchor it is refused by the anchor index; on his own
  -- seat it is accepted; on no seat at all the foreign key refuses it.
  SELECT anchor_seat_id INTO v_other_seat FROM public.lightning_pool_session
   WHERE cluster_id = v_g AND exited_at IS NULL AND player_id <> v_l ORDER BY entered_at, id LIMIT 1;
  v_jseat := public.fxr_join(v_g, (SELECT a FROM r2 WHERE k = 'g1'), 36, 100.00, false, false);
  v_j := (SELECT user_id FROM public.table_seats WHERE id = v_jseat);
  v_t := public.fxr_probe(format('INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, anchor_seat_id) VALUES (%L, %s, %L, gen_random_uuid(), %L, %L)',
                                 v_g, v_e, v_j, 'active', v_other_seat));
  IF v_t !~ '^23505: .*lightning_pool_session_one_open_per_anchor' THEN
    RAISE EXCEPTION 'FAIL 02: a second open session on one anchor was not refused by its index: %', v_t;
  END IF;
  v_t := public.fxr_probe(format('INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, anchor_seat_id) VALUES (%L, %s, %L, gen_random_uuid(), %L, %L)',
                                 v_g, v_e, v_j, 'active', v_jseat));
  IF v_t IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 02: an open session on the player''s own free seat was refused: %', v_t;
  END IF;
  v_t := public.fxr_probe(format('INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, anchor_seat_id) VALUES (%L, %s, %L, gen_random_uuid(), %L, gen_random_uuid())',
                                 v_g, v_e, v_j, 'active'));
  IF v_t !~ '^23503' THEN
    RAISE EXCEPTION 'FAIL 02: an anchor that is no seat was not refused by the foreign key: %', v_t;
  END IF;
  v_t := public.fxr_probe(format('INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, state) VALUES (%L, %s, %L, gen_random_uuid(), %L)',
                                 v_g, v_e, v_j, 'active'));
  IF v_t !~ '^23502' THEN
    RAISE EXCEPTION 'FAIL 02: a pool session with no anchor was not refused: %', v_t;
  END IF;
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = v_jseat;

  -- GRANTS, BOTH WAYS.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_t FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('fn_cash_table_observe_dealing_halt', 'fn_lightning_anchor_is_live_eligible',
           'fn_lightning_pool_stack', 'fn_lightning_player_in_hand', 'fn_lightning_pool_enter', 'fn_lightning_form_hand')
     AND (NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_t IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 02: the grants are wrong on: %', v_t;
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       AND p.proname = 'fn_lightning_form_hand') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 02: fn_lightning_form_hand is not exactly one function';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
       AND p.proname IN ('fn_table_seats_lightning_anchor_guard', 'fn_table_seats_lightning_pool_follows_seat') AND p.prosecdef) IS DISTINCT FROM 2::bigint
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
                 AND p.proname ~ '^fn_lightning_' AND p.prosecdef) THEN
    RAISE EXCEPTION 'FAIL 02: the definer set is wrong: only the two table_seats trigger functions may run as their owner';
  END IF;
END $$;
\echo '  ok  02 THE SCHEMA AND THE ESTATE  every pool session the ground left - thirty-six and more, across two Clusters - is anchored to a seat of its own player in its own Cluster, the departed player''s to the seat that left, and the player the old code never let in is swept into the pool through the new door; a second open session on one anchor is refused by lightning_pool_session_one_open_per_anchor while the same INSERT on the player''s own free seat is accepted, an anchor that is no seat is refused by the foreign key and a missing one by NOT NULL; service_role and no browser role executes each new function and the one ten-argument barrier; and only the two table_seats trigger functions run as their owner'

-- 03 DEFECT 1: A HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT ---------------
DO $$
DECLARE
  v_g uuid; v_main uuid; v_req uuid := gen_random_uuid(); v_r jsonb; v_s timestamptz; v_s2 timestamptz;
  v_f0 uuid; v_f1 uuid; v_f2 uuid; v_g8 uuid; v_f8 uuid; v_req8 uuid; v_sum numeric;
BEGIN
  v_g := public.fx9_cluster('G3', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 16);
  PERFORM public.fx9_seat(v_g, 2, 17, true);
  v_main := public.fxr_main(v_g);

  -- THE OBSERVATION DOOR. A table that is not halted is not stamped.
  IF public.fn_cash_table_observe_dealing_halt(v_main) IS NOT NULL
     OR (SELECT dealing_halt_observed_at FROM public.tables WHERE id = v_main) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: an unhalted table was stamped as having observed a halt';
  END IF;

  -- BORN HALTED, OR NOT: a table opened in must_move deals; one opened in
  -- PENDING_ON is born halted with PENDING_ON's reason.
  v_f0 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT dealing_halted_at FROM public.tables WHERE id = v_f0) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: a table opened in must_move was born halted';
  END IF;
  v_r := public.fn_cash_cluster_begin_pending_on(v_g, v_req);
  IF (v_r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: begin_pending_on refused G3: %', v_r;
  END IF;
  v_f1 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT dealing_halted_at FROM public.tables WHERE id = v_f1) IS NULL
     OR (SELECT dealing_halted_reason FROM public.tables WHERE id = v_f1) IS DISTINCT FROM 'lightning_pending_on' THEN
    RAISE EXCEPTION 'FAIL 03: a table opened in PENDING_ON was not born halted with its reason';
  END IF;
  IF (SELECT chips_at_begin FROM public.cash_cluster_conversion WHERE conversion_request_id = v_req) IS NULL THEN
    RAISE EXCEPTION 'FAIL 03: begin_pending_on did not record chips_at_begin';
  END IF;

  -- A HAND IN FLIGHT, in the engine's own shape: the commit refuses, and the
  -- Cluster stays PENDING_ON.
  PERFORM public.fxr_snapshot(v_main, false);
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
  IF v_r ->> 'reason' IS DISTINCT FROM 'hands_in_flight' OR (v_r ->> 'converted')::boolean IS DISTINCT FROM false
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'pending_on' THEN
    RAISE EXCEPTION 'FAIL 03: a hand in flight did not stop the commit: %', v_r;
  END IF;
  -- The hand settles; and a snapshot a dead engine left seven hours ago on
  -- another table is a corpse, not a hand.
  UPDATE public.hand_state_snapshots SET is_complete = true WHERE table_id = v_main;
  PERFORM public.fxr_snapshot(v_f0, false, interval '7 hours');

  -- A LIVE ENGINE THAT HAS NOT SEEN THE HALT stops the commit and is named;
  -- a dead engine (a lease past the stale window) on another table does not.
  PERFORM public.fxr_lease(v_main, true);
  PERFORM public.fxr_lease(v_f1, false);
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
  IF v_r ->> 'reason' IS DISTINCT FROM 'halt_not_observed'
     OR (v_r ->> 'tables_not_observed')::integer IS DISTINCT FROM 1
     OR (v_r -> 'tables') IS DISTINCT FROM jsonb_build_array(v_main) THEN
    RAISE EXCEPTION 'FAIL 03: an engine that had not seen the halt did not stop the commit, or a dead one did: %', v_r;
  END IF;

  -- THE ENGINE REPORTS FROM ITS HALT GATE: one stamp, not moved by a second report.
  v_s := public.fn_cash_table_observe_dealing_halt(v_main);
  v_s2 := public.fn_cash_table_observe_dealing_halt(v_main);
  IF v_s IS NULL OR v_s IS DISTINCT FROM v_s2
     OR v_s < (SELECT dealing_halted_at FROM public.tables WHERE id = v_main) THEN
    RAISE EXCEPTION 'FAIL 03: the observation stamp is absent, earlier than the halt, or moved by a second report';
  END IF;

  SELECT sum(ts.stack) INTO v_sum FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND ts.left_at IS NULL;
  v_r := public.fn_cash_cluster_commit_lightning(v_g, v_req);
  IF (v_r ->> 'converted')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: the commit did not convert once the hand settled and the halt was observed: %', v_r;
  END IF;
  IF (SELECT chips_at_commit FROM public.cash_cluster_conversion WHERE conversion_request_id = v_req) IS DISTINCT FROM v_sum
     OR (SELECT chips_at_begin FROM public.cash_cluster_conversion WHERE conversion_request_id = v_req) IS DISTINCT FROM v_sum THEN
    RAISE EXCEPTION 'FAIL 03: the chip totals on the conversion row are not the seats'' sum';
  END IF;
  v_f2 := public.fn_cash_cluster_open_table(v_g, 'feeder', NULL, 'live', NULL);
  IF (SELECT dealing_halted_reason FROM public.tables WHERE id = v_f2) IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 03: a table opened in a Lightning Cluster was not born halted with the lightning reason';
  END IF;
  INSERT INTO r2 (k, game, a, b, t, n) VALUES ('g3', v_g, v_main, v_f2, v_req::text, (v_r ->> 'epoch_after')::integer);

  -- THE STRAGGLER. The ground opened a table in G8 while it was PENDING_ON and
  -- it was born dealing; the commit halts it and waits, and the next commit
  -- (it has no engine) converts.
  SELECT game, a INTO v_g8, v_f8 FROM r2 WHERE k = 'g8';
  SELECT conversion_request_id INTO v_req8 FROM public.cash_cluster_conversion WHERE cluster_id = v_g8 AND status = 'pending';
  v_r := public.fn_cash_cluster_commit_lightning(v_g8, v_req8);
  IF v_r ->> 'reason' IS DISTINCT FROM 'halt_not_observed' OR (v_r ->> 'tables_newly_halted')::integer IS DISTINCT FROM 1
     OR (SELECT dealing_halted_reason FROM public.tables WHERE id = v_f8) IS DISTINCT FROM 'lightning_pending_on' THEN
    RAISE EXCEPTION 'FAIL 03: the commit did not halt the straggler and wait: %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_commit_lightning(v_g8, v_req8);
  IF (v_r ->> 'converted')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: the second commit did not convert G8: %', v_r;
  END IF;
END $$;
\echo '  ok  03 DEFECT 1, THE HALT IS A STOP ONLY ONCE SEEN  an unhalted table is not stamped; a table opened in must_move deals while one opened in PENDING_ON is born halted with PENDING_ON''s reason and one opened after the conversion with the lightning reason; an incomplete hand_state_snapshots row stops the commit with hands_in_flight while one seven hours dead does not; a live engine lease on a table that has not reported the halt stops it with halt_not_observed naming exactly that table while a dead lease does not; the halt gate''s report stamps once, no earlier than the halt, and a second report does not move it; then the commit converts, recording chips_at_begin and chips_at_commit equal to the seats'' sum; and a straggler born dealing in PENDING_ON is halted by the commit, which waits once and converts on the next call'
-- 04 DEFECT 2: THE POOL FOLLOWS THE SEAT ---------------------------------------
-- The conversion wrote every anchor, and wrote the seat its DISTINCT ON picked.
DO $$
DECLARE v_g uuid; v_n bigint;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g3';
  SELECT count(*) INTO v_n FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL
     AND ps.anchor_seat_id IS DISTINCT FROM (
       SELECT ts.id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.cluster_id = v_g AND ts.user_id = ps.player_id AND ts.left_at IS NULL
          AND coalesce(ts.is_sitting_out, false) = false AND coalesce(ts.leave_pending, false) = false
          AND coalesce(ts.stack, 0) > 0
        ORDER BY ts.joined_at, ts.id LIMIT 1);
  IF v_n IS DISTINCT FROM 0::bigint
     OR (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL) IS DISTINCT FROM 18::bigint THEN
    RAISE EXCEPTION 'FAIL 04: the conversion did not anchor its eighteen pool sessions to the seats its DISTINCT ON picks (% wrong)', v_n;
  END IF;
  PERFORM public.fx9_pool(v_g);
END $$;

-- ARRIVALS AFTER THE CONVERSION, each in the buy-in's own order (the seat,
-- then the cash session, in one transaction): a human, a horse, a player with
-- no cash session, a player with no chips, and a human at a must_move Cluster.
DO $$
DECLARE v_g uuid; v_main uuid; v_mm uuid;
BEGIN
  SELECT game, a INTO v_g, v_main FROM r2 WHERE k = 'g3';
  v_mm := public.fx9_cluster('G5MM', 6, 40, true);
  INSERT INTO r2 (k, game, a) VALUES ('j_human', v_g, public.fxr_join(v_g, v_main, 31, 140.00));
  INSERT INTO r2 (k, game, a) VALUES ('j_horse', v_g, public.fxr_join(v_g, v_main, 32, 160.00, true));
  INSERT INTO r2 (k, game, a) VALUES ('j_nosession', v_g, public.fxr_join(v_g, v_main, 33, 120.00, false, false));
  INSERT INTO r2 (k, game, a) VALUES ('j_broke', v_g, public.fxr_join(v_g, v_main, 34, 0.00));
  INSERT INTO r2 (k, game, a) VALUES ('j_mustmove', v_mm, public.fxr_join(v_mm, public.fxr_main(v_mm), 1, 140.00));
END $$;

-- AND THE SAME ARRIVAL WITH THE TRIGGER FIRED IMMEDIATELY rather than at
-- commit: the seat is written before the cash session exists, so the pool
-- door finds nothing to be subordinate to. This is why the triggers are
-- deferred.
DO $$
DECLARE v_g uuid; v_main uuid;
BEGIN
  SELECT game, a INTO v_g, v_main FROM r2 WHERE k = 'g3';
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO r2 (k, game, a) VALUES ('j_immediate', v_g, public.fxr_join(v_g, v_main, 35, 130.00));
END $$;

DO $$
DECLARE v_g uuid; v_e integer; r record; v_ps record;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g3';
  SELECT cluster_epoch INTO v_e FROM public.cash_games WHERE id = v_g;
  FOR r IN SELECT k, a FROM r2 WHERE k IN ('j_human', 'j_horse') LOOP
    SELECT ps.* INTO v_ps FROM public.lightning_pool_session ps
     WHERE ps.anchor_seat_id = r.a AND ps.exited_at IS NULL;
    IF NOT FOUND OR v_ps.cluster_epoch IS DISTINCT FROM v_e OR v_ps.state IS DISTINCT FROM 'active'
       OR v_ps.starting_stack IS DISTINCT FROM (SELECT stack FROM public.table_seats WHERE id = r.a)
       OR v_ps.player_id IS DISTINCT FROM (SELECT user_id FROM public.table_seats WHERE id = r.a) THEN
      RAISE EXCEPTION 'FAIL 04: % did not enter the pool at the current epoch anchored to the seat with its stack', r.k;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl WHERE sl.pool_session_id = v_ps.id AND sl.closed_at IS NULL) THEN
      RAISE EXCEPTION 'FAIL 04: % entered the pool without a slot', r.k;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'pool_player_joined'
                     AND e.payload ->> 'anchor_seat_id' = r.a::text AND e.cluster_epoch = v_e) THEN
      RAISE EXCEPTION 'FAIL 04: % entered without a pool_player_joined event', r.k;
    END IF;
  END LOOP;
  FOR r IN SELECT k, a FROM r2 WHERE k IN ('j_nosession', 'j_broke', 'j_mustmove', 'j_immediate') LOOP
    IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                WHERE ps.player_id = (SELECT user_id FROM public.table_seats WHERE id = r.a)) THEN
      RAISE EXCEPTION 'FAIL 04: % entered a pool it does not belong in', r.k;
    END IF;
  END LOOP;
END $$;

-- A SIT-IN AND A STACK CROSSING ZERO ENTER THE POOL. The immediate arrival
-- sits out and back in; the broke one buys chips.
DO $$
BEGIN
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = (SELECT a FROM r2 WHERE k = 'j_immediate');
END $$;
DO $$
BEGIN
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = (SELECT a FROM r2 WHERE k = 'j_immediate');
  UPDATE public.table_seats SET stack = 80.00 WHERE id = (SELECT a FROM r2 WHERE k = 'j_broke');
END $$;
DO $$
BEGIN
  IF public.fxr_anchor((SELECT game FROM r2 WHERE k = 'g3'), (SELECT user_id FROM public.table_seats WHERE id = (SELECT a FROM r2 WHERE k = 'j_immediate')))
       IS DISTINCT FROM (SELECT a FROM r2 WHERE k = 'j_immediate')
     OR public.fxr_anchor((SELECT game FROM r2 WHERE k = 'g3'), (SELECT user_id FROM public.table_seats WHERE id = (SELECT a FROM r2 WHERE k = 'j_broke')))
       IS DISTINCT FROM (SELECT a FROM r2 WHERE k = 'j_broke') THEN
    RAISE EXCEPTION 'FAIL 04: a sit-in or a stack crossing zero did not enter the pool';
  END IF;
END $$;

-- THE WHEN CLAUSES KEEP PL/pgSQL OUT OF AN ORDINARY STACK UPDATE, counted in
-- function calls in this transaction, with the deferred triggers made
-- immediate so a queued one would be counted too.
DO $$
DECLARE
  v_seat uuid; f0 bigint; g0 bigint; f1 bigint; g1 bigint;
  v_follow oid := 'public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure;
  v_guard oid := 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure;
BEGIN
  SELECT a INTO v_seat FROM r2 WHERE k = 'j_human';
  SET CONSTRAINTS ALL IMMEDIATE;
  f0 := coalesce(pg_stat_get_xact_function_calls(v_follow), 0);
  g0 := coalesce(pg_stat_get_xact_function_calls(v_guard), 0);
  UPDATE public.table_seats SET stack = stack + 1 WHERE id = v_seat;
  UPDATE public.table_seats SET joined_at = joined_at WHERE id = v_seat;
  f1 := coalesce(pg_stat_get_xact_function_calls(v_follow), 0);
  g1 := coalesce(pg_stat_get_xact_function_calls(v_guard), 0);
  IF f1 - f0 IS DISTINCT FROM 0::bigint OR g1 - g0 IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 04: an ordinary stack update reached the pool trigger % time(s) and the guard % time(s)', f1 - f0, g1 - g0;
  END IF;
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_seat;
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = v_seat;
  UPDATE public.table_seats SET stack = stack - 1 WHERE id = v_seat;
  IF coalesce(pg_stat_get_xact_function_calls(v_follow), 0) - f1 IS DISTINCT FROM 2::bigint
     OR coalesce(pg_stat_get_xact_function_calls(v_guard), 0) - g1 IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 04: a sit-out and a sit-in did not each reach the pool trigger exactly once, or a stack change did not reach the guard';
  END IF;
END $$;

-- DEPARTURES. The human leaves; a converted player seated at a second table
-- leaves the first (and is entered again through the second); a seat turns
-- over to somebody else.
DO $$
DECLARE v_g uuid; v_f2 uuid; v_k uuid; v_t uuid;
BEGIN
  SELECT game, b INTO v_g, v_f2 FROM r2 WHERE k = 'g3';
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = (SELECT a FROM r2 WHERE k = 'j_human');
  -- Humans, so the turnover below never hands a horse's seat to a stranger.
  SELECT ps.player_id INTO v_k FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats h WHERE h.user_id = ps.player_id AND h.horse_id IS NOT NULL)
   ORDER BY ps.entered_at, ps.id LIMIT 1;
  INSERT INTO r2 (k, game, a, b) VALUES ('k_two_seats', v_g, v_k, public.fxr_join(v_g, v_f2, 1, 90.00, false, false, v_k));
  SELECT ps.player_id INTO v_t FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.player_id <> v_k
     AND NOT EXISTS (SELECT 1 FROM public.table_seats h WHERE h.user_id = ps.player_id AND h.horse_id IS NOT NULL)
   ORDER BY ps.entered_at, ps.id LIMIT 1;
  INSERT INTO r2 (k, game, a, b) VALUES ('t_turnover', v_g, v_t, public.fxr_anchor(v_g, v_t));
END $$;
DO $$
DECLARE v_g uuid; v_k uuid;
BEGIN
  SELECT game, a INTO v_g, v_k FROM r2 WHERE k = 'k_two_seats';
  -- A second seat did not make a second session.
  IF (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_k AND exited_at IS NULL) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 04: a player seated twice holds more than one open pool session';
  END IF;
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = public.fxr_anchor(v_g, v_k);
  UPDATE public.table_seats SET user_id = gen_random_uuid()
   WHERE id = (SELECT b FROM r2 WHERE k = 't_turnover');
END $$;
DO $$
DECLARE v_g uuid; v_ps record; v_k uuid; v_kseat uuid; v_t uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g3';
  SELECT ps.* INTO v_ps FROM public.lightning_pool_session ps
   WHERE ps.anchor_seat_id = (SELECT a FROM r2 WHERE k = 'j_human');
  IF v_ps.exited_at IS NULL OR v_ps.exit_reason IS DISTINCT FROM 'anchor_seat_left' OR v_ps.state IS DISTINCT FROM 'closed'
     OR v_ps.ending_stack IS DISTINCT FROM 140.00
     OR EXISTS (SELECT 1 FROM public.lightning_pool_slot WHERE pool_session_id = v_ps.id AND closed_at IS NULL)
     OR public.fn_lightning_pool_stack(v_ps.id) IS DISTINCT FROM 0::numeric
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'pool_player_left'
                      AND payload ->> 'pool_session_id' = v_ps.id::text AND payload ->> 'reason' = 'anchor_seat_left') THEN
    RAISE EXCEPTION 'FAIL 04: the departed human''s session was not exited with its slot closed, its stack zeroed and pool_player_left recorded';
  END IF;
  SELECT a, b INTO v_k, v_kseat FROM r2 WHERE k = 'k_two_seats';
  IF public.fxr_anchor(v_g, v_k) IS DISTINCT FROM v_kseat
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_k AND exit_reason = 'anchor_seat_left')
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_slot sl JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                     WHERE ps.anchor_seat_id = v_kseat AND ps.exited_at IS NULL AND sl.closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 04: a player who left one seat of the Cluster was not entered again through the other';
  END IF;
  SELECT a INTO v_t FROM r2 WHERE k = 't_turnover';
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_t AND exited_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_t AND exit_reason = 'anchor_seat_turned_over') THEN
    RAISE EXCEPTION 'FAIL 04: a seat that turned over to somebody else left its old occupant in the pool';
  END IF;
END $$;
\echo '  ok  04 DEFECT 2, THE POOL FOLLOWS THE SEAT  the conversion anchored all eighteen sessions to the seats its own DISTINCT ON picks; a human and a horse seated after it, in the buy-in''s order, enter the pool at the current epoch anchored to their seats with their stacks, a slot and pool_player_joined, while a player with no cash session, one with no chips and one at a must_move Cluster do not, and the same arrival with the trigger fired immediately does not either - which is why it is deferred; a sit-in and a stack crossing zero enter the pool; an ordinary stack update reaches the guard once and the pool trigger never, while a sit-out and a sit-in each reach it once; a departure exits the session with its slot closed, its ending stack and a zero pool stack and pool_player_left, a player seated twice holds one session and is re-entered through the second seat when the first leaves, and a seat that turns over takes its old occupant out'

-- 05 DEFECT 3: ONE COPY OF THE STACK ---------------------------------------------
DO $$
DECLARE v_g uuid; v_q uuid; v_l uuid; v_ps record;
BEGIN
  SELECT game, a INTO v_g, v_q FROM r2 WHERE k = 'g1_topped_up';
  SELECT a INTO v_l FROM r2 WHERE k = 'g1_left';
  -- The very row the ground showed diverging now reads the seat.
  SELECT * INTO v_ps FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_q AND exited_at IS NULL;
  IF public.fn_lightning_pool_stack(v_ps.id) IS DISTINCT FROM (SELECT stack FROM public.table_seats WHERE id = v_ps.anchor_seat_id)
     OR public.fn_lightning_pool_stack(v_ps.id) IS NOT DISTINCT FROM v_ps.starting_stack + v_ps.net_result THEN
    RAISE EXCEPTION 'FAIL 05: the pool stack of the topped-up player is not the seat''s stack';
  END IF;
  -- The player the ground let leave with an open session backs no stack.
  IF public.fn_lightning_pool_stack((SELECT id FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_l AND exited_at IS NULL))
     IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION 'FAIL 05: an anchor that has left still backs a stack';
  END IF;
END $$;

-- THE CANDIDATE FILTER. Six legal candidates, a horse first; four of them
-- impaired one way each - sitting out, leaving, no chips, cash session closed -
-- plus the departed player: two are legal. Restored: the six form.
DO $$
DECLARE v_g uuid; v_l uuid; v_q uuid; v_c uuid[]; v_r jsonb; v_horse uuid;
BEGIN
  SELECT game, a INTO v_g, v_l FROM r2 WHERE k = 'g1_left';
  SELECT a INTO v_q FROM r2 WHERE k = 'g1_topped_up';
  SELECT ts.user_id INTO v_horse FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    JOIN public.lightning_pool_slot sl ON sl.player_id = ts.user_id AND sl.cluster_id = v_g AND sl.closed_at IS NULL
   WHERE tb.cluster_id = v_g AND ts.horse_id IS NOT NULL AND ts.left_at IS NULL
     AND NOT public.fn_lightning_player_in_hand(ts.user_id, v_g)
     AND ts.user_id NOT IN (v_l, v_q)
   ORDER BY ts.seat_number LIMIT 1;
  IF v_horse IS NULL THEN
    RAISE EXCEPTION 'FAIL 05: no free horse in G1 to form with';
  END IF;
  v_c := ARRAY[v_horse] || ARRAY(SELECT x FROM unnest(public.fx9_candidates(v_g)) x
                                  WHERE x NOT IN (v_horse, v_l, v_q) LIMIT 5);
  IF cardinality(v_c) IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 05: G1 does not have six free candidates';
  END IF;
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = public.fxr_anchor(v_g, v_c[2]);
  UPDATE public.table_seats SET leave_pending = true WHERE id = public.fxr_anchor(v_g, v_c[3]);
  UPDATE public.table_seats SET stack = 0 WHERE id = public.fxr_anchor(v_g, v_c[4]);
  UPDATE public.cash_player_session SET closed_at = clock_timestamp() WHERE player_id = v_c[5] AND closed_at IS NULL;
  v_r := public.fxr_form(v_g, v_c || v_l);
  IF v_r ->> 'reason' IS DISTINCT FROM 'insufficient_legal_candidates' OR (v_r ->> 'legal')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 05: impaired anchors were not excluded from the legal set: %', v_r;
  END IF;
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = public.fxr_anchor(v_g, v_c[2]);
  UPDATE public.table_seats SET leave_pending = false WHERE id = public.fxr_anchor(v_g, v_c[3]);
  UPDATE public.table_seats SET stack = 104.00 WHERE id = public.fxr_anchor(v_g, v_c[4]);
  UPDATE public.cash_player_session SET closed_at = NULL WHERE player_id = v_c[5];
  INSERT INTO r2 (k, game, t) VALUES ('g1_c', v_g, array_to_string(v_c, ','));
END $$;

-- THE ANCHOR SEATS ARE HELD FOR SHARE WHILE THE HAND FORMS. From inside the
-- formation the other backend tries to touch a participant's seat and waits
-- out its lock timeout; stack_before is the seat's stack.
DO $$
DECLARE v_g uuid; v_c uuid[]; v_r jsonb; v_bad bigint;
BEGIN
  SELECT game, string_to_array(t, ',')::uuid[] INTO v_g, v_c FROM r2 WHERE k = 'g1_c';
  PERFORM set_config('fxr.during_sql', format('UPDATE public.table_seats SET is_sitting_out = is_sitting_out WHERE id = %L',
                                              public.fxr_anchor(v_g, v_c[1])), false);
  v_r := public.fxr_form(v_g, v_c || (SELECT a FROM r2 WHERE k = 'g1_left'));
  IF (v_r ->> 'formed')::boolean IS DISTINCT FROM true OR (v_r ->> 'players')::integer IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 05: the restored six did not form: %', v_r;
  END IF;
  IF current_setting('fxr.during_said', true) !~ 'lock timeout' THEN
    RAISE EXCEPTION 'FAIL 05: a participant''s anchor seat was writable during the formation: %', current_setting('fxr.during_said', true);
  END IF;
  SELECT count(*) INTO v_bad FROM public.lightning_hand_player hp
    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
    JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE hp.hand_id = (v_r ->> 'hand_id')::uuid AND hp.stack_before IS DISTINCT FROM ts.stack;
  IF v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 05: % stack_before value(s) are not the anchor seat''s stack', v_bad;
  END IF;
  INSERT INTO r2 (k, game, a, b) VALUES ('g1_hand2', v_g, (v_r ->> 'hand_id')::uuid, (v_r ->> 'instance_id')::uuid);
END $$;
-- AND THE TWIN: from inside a formation on G2, a seat that is NOT a
-- participant's is written by the other backend at once.
DO $$
DECLARE v_g uuid; v_c uuid[]; v_other uuid; v_r jsonb;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  v_c := public.fx9_candidates(v_g, 6);
  SELECT ps.anchor_seat_id INTO v_other FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.player_id <> ALL (v_c) ORDER BY ps.entered_at, ps.id LIMIT 1;
  PERFORM set_config('fxr.during_sql', format('UPDATE public.table_seats SET is_sitting_out = is_sitting_out WHERE id = %L', v_other), false);
  v_r := public.fxr_form(v_g, v_c);
  IF (v_r ->> 'formed')::boolean IS DISTINCT FROM true OR current_setting('fxr.during_said', true) IS DISTINCT FROM 'UPDATE 1' THEN
    RAISE EXCEPTION 'FAIL 05: a non-participant''s seat was not writable during a formation: % / %', current_setting('fxr.during_said', true), v_r;
  END IF;
  -- Give the six back, so G2 is whole for the sections after.
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'fxr: section 05 twin');
END $$;

-- ONE PREDICATE, TWO READERS. On a must_move Cluster seated in every shape
-- that decides eligibility, the new per-seat predicate and the population
-- count the same players.
DO $$
DECLARE v_g uuid; v_main uuid; v_closed uuid; v_deleted uuid; v_null uuid; v_s uuid; v_mine bigint; v_pop integer; v_all bigint;
BEGIN
  v_g := public.fx9_cluster('G5', 6, 40, false);
  v_main := public.fxr_main(v_g);
  v_closed := public.fx9_table(v_g, 'G5 closed', 'feeder', NULL);
  v_deleted := public.fx9_table(v_g, 'G5 deleted', 'feeder', NULL);
  v_null := public.fx9_table(v_g, 'G5 null', 'feeder', NULL);
  PERFORM public.fxr_join(v_g, v_main, 1, 100);
  PERFORM public.fxr_join(v_g, v_main, 2, 100);
  PERFORM public.fxr_join(v_g, v_main, 3, 100);
  PERFORM public.fxr_join(v_g, v_main, 4, 100, true);
  v_s := public.fxr_join(v_g, v_main, 5, 100); UPDATE public.table_seats SET is_sitting_out = true WHERE id = v_s;
  v_s := public.fxr_join(v_g, v_main, 6, 100); UPDATE public.table_seats SET leave_pending = true WHERE id = v_s;
  PERFORM public.fxr_join(v_g, v_main, 7, 0);
  v_s := public.fxr_join(v_g, v_main, 8, 100); UPDATE public.table_seats SET stack = NULL WHERE id = v_s;
  v_s := public.fxr_join(v_g, v_main, 9, 100); UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = v_s;
  PERFORM public.fxr_join(v_g, v_closed, 1, 100);
  PERFORM public.fxr_join(v_g, v_deleted, 1, 100);
  PERFORM public.fxr_join(v_g, v_null, 1, 100);
  UPDATE public.tables SET lifecycle = 'closed' WHERE id = v_closed;
  UPDATE public.tables SET is_deleted = true WHERE id = v_deleted;
  UPDATE public.tables SET lifecycle = NULL WHERE id = v_null;
  SELECT count(DISTINCT ts.user_id) INTO v_mine FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND public.fn_lightning_anchor_is_live_eligible(ts.id, v_g, ts.user_id);
  SELECT count(DISTINCT ts.user_id) INTO v_all FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g;
  v_pop := public.fn_cash_cluster_live_eligible(v_g);
  IF v_mine IS DISTINCT FROM v_pop::bigint OR v_mine IS DISTINCT FROM 5::bigint OR v_all IS DISTINCT FROM 12::bigint THEN
    RAISE EXCEPTION 'FAIL 05: the per-seat predicate counts % of % where the population counts %', v_mine, v_all, v_pop;
  END IF;
  INSERT INTO r2 (k, game, a) VALUES ('g5', v_g, v_main);
END $$;
\echo '  ok  05 DEFECT 3, ONE COPY OF THE STACK  the topped-up player the ground showed diverging now has a pool stack equal to his seat''s and not to starting_stack plus net_result, and the player who left backs none; of six candidates led by a horse, one sitting out, one leaving, one with no chips and one whose cash session closed are illegal with the departed player, leaving exactly two, and restored they form; during that formation the other backend cannot write a participant''s anchor seat (lock timeout) while in a twin formation it writes a non-participant''s at once, and every stack_before is the anchor seat''s stack; and on a must_move Cluster seated in twelve shapes - sitting out, leaving, no chips, NULL chips, departed, closed, deleted and NULL-lifecycle tables, a horse - the per-seat predicate counts the same five players the population does'

-- 06 DEFECT 4: THE ANCHOR STACK MOVES ONLY BY LIGHTNING SETTLEMENT ------------
DO $$
DECLARE v_g uuid; v_h uuid; v_i uuid; v_c uuid[]; v_seat uuid; v_hseat uuid; v_q uuid; v_t text; v_mm uuid;
BEGIN
  SELECT game, a, b INTO v_g, v_h, v_i FROM r2 WHERE k = 'g1_hand2';
  SELECT string_to_array(t, ',')::uuid[] INTO v_c FROM r2 WHERE k = 'g1_c';
  SELECT a INTO v_q FROM r2 WHERE k = 'g1_topped_up';
  v_seat := public.fxr_anchor(v_g, v_c[2]);
  v_hseat := public.fxr_anchor(v_g, v_c[1]);   -- the horse
  IF NOT public.fn_lightning_player_in_hand(v_c[2], v_g) OR public.fn_lightning_player_in_hand(v_q, v_g) THEN
    RAISE EXCEPTION 'FAIL 06: fn_lightning_player_in_hand does not tell a participant from a pool member who is not';
  END IF;
  FOREACH v_t IN ARRAY ARRAY[
      public.fxr_try(format('UPDATE public.table_seats SET stack = stack - 10 WHERE id = %L', v_seat)),
      public.fxr_try(format('UPDATE public.table_seats SET stack = stack + 10 WHERE id = %L', v_hseat)),
      public.fxr_try(format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_seat)),
      public.fxr_try(format('UPDATE public.table_seats SET user_id = gen_random_uuid() WHERE id = %L', v_seat))] LOOP
    IF v_t !~ '^PLT01: LIGHTNING_HAND_IN_PROGRESS' THEN
      RAISE EXCEPTION 'FAIL 06: a change to a participant''s anchor was not refused as LIGHTNING_HAND_IN_PROGRESS: %', v_t;
    END IF;
  END LOOP;
  -- A settlement naming ANOTHER hand is refused; the settlement of THIS hand passes.
  PERFORM set_config('ca.lightning_settlement_hand', gen_random_uuid()::text, true);
  v_t := public.fxr_try(format('UPDATE public.table_seats SET stack = stack - 10 WHERE id = %L', v_seat));
  IF v_t !~ '^PLT01' THEN
    RAISE EXCEPTION 'FAIL 06: a settlement of another hand was let through: %', v_t;
  END IF;
  PERFORM set_config('ca.lightning_settlement_hand', v_h::text, true);
  v_t := public.fxr_probe(format('UPDATE public.table_seats SET stack = stack - 10 WHERE id = %L', v_seat));
  IF v_t IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 06: the settlement of the participant''s own hand was refused: %', v_t;
  END IF;
  PERFORM set_config('ca.lightning_settlement_hand', '', true);
  -- A pool member who is not in hand, and a seat at a must_move Cluster, move freely.
  IF public.fxr_probe(format('UPDATE public.table_seats SET stack = stack - 10 WHERE id = %L', public.fxr_anchor(v_g, v_q))) IS DISTINCT FROM 'ok 1'
     OR public.fxr_probe(format('UPDATE public.table_seats SET stack = stack - 10 WHERE table_id = %L AND left_at IS NULL AND stack > 50',
                                (SELECT a FROM r2 WHERE k = 'g5'))) !~ '^ok [1-9]' THEN
    RAISE EXCEPTION 'FAIL 06: a seat that is not in a Lightning hand was guarded';
  END IF;
END $$;

-- AND WHEN THE HAND ENDS THE BAR COMES OFF.
DO $$
DECLARE v_g uuid; v_i uuid; v_c uuid[];
BEGIN
  SELECT game, b INTO v_g, v_i FROM r2 WHERE k = 'g1_hand2';
  SELECT string_to_array(t, ',')::uuid[] INTO v_c FROM r2 WHERE k = 'g1_c';
  PERFORM public.fn_lightning_instance_abandon(v_i, 'fxr: section 06');
  IF public.fn_lightning_player_in_hand(v_c[2], v_g)
     OR public.fxr_probe(format('UPDATE public.table_seats SET stack = stack - 10 WHERE id = %L', public.fxr_anchor(v_g, v_c[2]))) IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 06: an abandoned hand still guards its players'' seats';
  END IF;
END $$;

-- THE COST FOR AN ORDINARY SEAT. The guard's probe is served by the partial
-- anchor index, and over three thousand ordinary stack updates the guard -
-- called once for each - adds a bounded amount per row.
DO $$
DECLARE v_plan text := ''; v_seat uuid; v_line text;
BEGIN
  SELECT id INTO v_seat FROM public.table_seats WHERE table_id = (SELECT a FROM r2 WHERE k = 'g5') LIMIT 1;
  SET LOCAL enable_seqscan = off;
  FOR v_line IN EXECUTE format('EXPLAIN SELECT ps.id, ps.player_id, ps.cluster_id FROM public.lightning_pool_session ps WHERE ps.anchor_seat_id = %L AND ps.exited_at IS NULL', v_seat) LOOP
    v_plan := v_plan || v_line || ' ';
  END LOOP;
  -- Either anchor index answers it: the partial one of open sessions, or the
  -- full one the foreign key needs; both are one probe on anchor_seat_id.
  IF v_plan !~ 'Index (Only )?Scan using lightning_pool_session_(one_open_per_anchor|by_anchor_seat)'
     OR v_plan !~ 'anchor_seat_id = ' THEN
    RAISE EXCEPTION 'FAIL 06: the guard''s probe is not an index probe on anchor_seat_id: %', v_plan;
  END IF;
END $$;
DO $$
DECLARE
  v_g uuid; v_tb uuid; i integer; k integer; t0 timestamptz;
  v_on interval := interval '1 day'; v_off interval := interval '1 day'; v_calls bigint; v_per numeric;
  v_guard oid := 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure;
BEGIN
  v_g := public.fx9_cluster('G9', 9, 60, false);
  v_tb := public.fxr_main(v_g);
  FOR i IN 1 .. 50 LOOP PERFORM public.fxr_join(v_g, v_tb, i, 500 + i); END LOOP;
  -- The arrivals' deferred pool events fire now; the timed updates queue none.
  SET CONSTRAINTS ALL IMMEDIATE;
  FOR k IN 1 .. 3 LOOP
    v_calls := coalesce(pg_stat_get_xact_function_calls(v_guard), 0);
    t0 := clock_timestamp();
    FOR i IN 1 .. 60 LOOP UPDATE public.table_seats SET stack = stack + 1 WHERE table_id = v_tb; END LOOP;
    v_on := LEAST(v_on, clock_timestamp() - t0);
    IF coalesce(pg_stat_get_xact_function_calls(v_guard), 0) - v_calls IS DISTINCT FROM 3000::bigint THEN
      RAISE EXCEPTION 'FAIL 06: the guard was not called once per ordinary stack update';
    END IF;
    ALTER TABLE public.table_seats DISABLE TRIGGER trg_table_seats_lightning_anchor_guard;
    t0 := clock_timestamp();
    FOR i IN 1 .. 60 LOOP UPDATE public.table_seats SET stack = stack + 1 WHERE table_id = v_tb; END LOOP;
    v_off := LEAST(v_off, clock_timestamp() - t0);
    ALTER TABLE public.table_seats ENABLE TRIGGER trg_table_seats_lightning_anchor_guard;
  END LOOP;
  v_per := round((extract(epoch FROM v_on - v_off) * 1000000 / 3000)::numeric, 2);
  INSERT INTO r2 (k, t) VALUES ('guard_cost', format('%s microseconds per ordinary stack update (best of three: %s ms with the guard, %s ms without, 3000 rows)',
                                                     v_per, round((extract(epoch FROM v_on) * 1000)::numeric, 1), round((extract(epoch FROM v_off) * 1000)::numeric, 1)));
  IF v_per > 100 THEN
    RAISE EXCEPTION 'FAIL 06: the guard costs % microseconds per ordinary stack update', v_per;
  END IF;
END $$;
SELECT t AS guard_cost FROM r2 WHERE k = 'guard_cost' \gset
\echo '  ok  06 DEFECT 4, THE ANCHOR IS GUARDED  fn_lightning_player_in_hand tells a participant from a pool member; a participant''s anchor stack cut, a horse participant''s top-up, a departure and a turnover are each refused with PLT01 LIGHTNING_HAND_IN_PROGRESS, a settlement naming another hand is refused and the settlement of the participant''s own hand passes, while a pool member not in hand and a must_move seat move freely; the bar comes off when the hand is abandoned; the guard''s probe is an index probe on anchor_seat_id, it is called exactly once per ordinary stack update, and it costs' :guard_cost

-- 07 DEFECT 5: NOBODY LEAVES A LOCKED HAND ------------------------------------
DO $$
DECLARE v_g uuid; v_h uuid; v_u uuid; v_u2 uuid; v_ui2 uuid; v_x uuid; v_y uuid; v_slot uuid; v_t text; v_e integer;
BEGIN
  SELECT game, a INTO v_g, v_h FROM r2 WHERE k = 'g1_hand';
  SELECT a INTO v_u FROM r2 WHERE k = 'g1_unlocked';
  SELECT cluster_epoch INTO v_e FROM public.lightning_hand WHERE hand_id = v_u;
  SELECT player_id INTO v_x FROM public.lightning_hand_player WHERE hand_id = v_h ORDER BY seat LIMIT 1;
  v_t := public.fxr_try(format('UPDATE public.lightning_hand_player SET hand_id = %L WHERE hand_id = %L AND player_id = %L', v_u, v_h, v_x));
  IF v_t !~ '^23514: LIGHTNING_HAND_PLAYER_IS_IMMUTABLE: .*may not be moved' THEN
    RAISE EXCEPTION 'FAIL 07: a participant was moved out of a locked hand: %', v_t;
  END IF;
  -- The twin: between two UNLOCKED hands the same UPDATE is accepted.
  v_ui2 := ((public.fn_lightning_instance_open(v_g)) ->> 'instance_id')::uuid;
  v_u2 := gen_random_uuid();
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id,
      rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version)
  VALUES (v_u2, v_g, v_e, v_ui2, 'fxr', 'fxr', 'fxr', 'fxr', 'fxr');
  SELECT sl.player_id, sl.id INTO v_y, v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.cluster_epoch = v_e AND sl.closed_at IS NULL ORDER BY sl.opened_at, sl.id LIMIT 1;
  INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch)
  VALUES (v_u, v_y, v_slot, 1, v_g, v_e);
  v_t := public.fxr_probe(format('UPDATE public.lightning_hand_player SET hand_id = %L WHERE hand_id = %L AND player_id = %L', v_u2, v_u, v_y));
  IF v_t IS DISTINCT FROM 'ok 1' THEN
    RAISE EXCEPTION 'FAIL 07: a row could not move between two unlocked hands: %', v_t;
  END IF;
END $$;
\echo '  ok  07 DEFECT 5, NOBODY LEAVES A LOCKED HAND  the very UPDATE the ground let through - a participant of a locked hand moved into an unlocked one - is refused by name, while the same UPDATE between two unlocked hands on the same Cluster and epoch is accepted'

-- 08 DEFECT 6: begin_dealing LOOKS OUTSIDE THE INSTANCE -------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_d jsonb; v_i uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  -- The ground dealt this with an old clock. Now the database's clock judges.
  v_r := public.fn_lightning_form_hand(v_g, public.fx9_candidates(v_g, 6),
           p_now => clock_timestamp() - interval '10 minutes', p_matcher_version => 'fxr-matcher-1');
  v_d := public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid, p_now => clock_timestamp() - interval '10 minutes');
  IF v_d ->> 'reason' IS DISTINCT FROM 'past_deadline' OR (v_d ->> 'dealing')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: an old p_now still dealt a dead formation: %', v_d;
  END IF;
  -- The twin, formed now, deals.
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  v_i := (v_r ->> 'instance_id')::uuid;
  v_d := public.fn_lightning_instance_begin_dealing(v_i);
  IF (v_d ->> 'dealing')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a live formation on a live Cluster did not deal: %', v_d;
  END IF;
  INSERT INTO r2 (k, game, a, b) VALUES ('g2_dealt', v_g, (v_r ->> 'hand_id')::uuid, v_i);
  -- It is played out, so section 12 has a completed instance to read.
  UPDATE public.lightning_instance SET state = 'settling' WHERE id = v_i;
  UPDATE public.lightning_instance SET state = 'complete', completed_at = clock_timestamp() WHERE id = v_i;
END $$;

DO $$
DECLARE v_g uuid; v_r jsonb; v_d jsonb; v_i uuid; v_p uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  -- LIGHTNING SWITCHED OFF between formation and deal.
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  v_i := (v_r ->> 'instance_id')::uuid;
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  v_d := public.fn_lightning_instance_begin_dealing(v_i);
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_g;
  IF v_d ->> 'reason' IS DISTINCT FROM 'lightning_disabled' OR (v_d ->> 'abandoned')::boolean IS DISTINCT FROM true
     OR (SELECT state FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM 'abandoned'
     OR (SELECT abandon_reason FROM public.lightning_instance WHERE id = v_i) !~ '^begin_dealing refused: lightning_disabled'
     OR EXISTS (SELECT 1 FROM public.lightning_reservation WHERE lightning_instance_id = v_i AND state IN ('pending', 'committed')) THEN
    RAISE EXCEPTION 'FAIL 08: a Cluster with Lightning off was dealt, or its formation was not abandoned and released: %', v_d;
  END IF;
  INSERT INTO r2 (k, game, b) VALUES ('g2_refused', v_g, v_i);

  -- A PARTICIPANT WHO SAT OUT between formation and deal.
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  v_i := (v_r ->> 'instance_id')::uuid;
  v_p := (v_r ->> 'bb')::uuid;
  UPDATE public.table_seats SET is_sitting_out = true WHERE id = public.fxr_anchor(v_g, v_p);
  v_d := public.fn_lightning_instance_begin_dealing(v_i);
  UPDATE public.table_seats SET is_sitting_out = false WHERE id = public.fxr_anchor(v_g, v_p);
  IF v_d ->> 'reason' IS DISTINCT FROM 'participant_left_the_pool' OR v_d ->> 'players' IS DISTINCT FROM v_p::text
     OR (SELECT state FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'FAIL 08: a participant who sat out was dealt in: %', v_d;
  END IF;

  -- THE EPOCH MOVED, and THE CLUSTER LEFT LIGHTNING: each undone afterwards.
  BEGIN
    v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
    UPDATE public.cash_games SET cluster_epoch = cluster_epoch + 1 WHERE id = v_g;
    v_d := public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid);
    IF v_d ->> 'reason' IS DISTINCT FROM 'epoch_is_not_current' THEN
      RAISE EXCEPTION 'FAIL 08: a formation from a dead epoch was dealt: %', v_d;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;
  BEGIN
    v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
    UPDATE public.cash_games SET cluster_mode = 'paused' WHERE id = v_g;
    v_d := public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid);
    IF v_d ->> 'reason' IS DISTINCT FROM 'cluster_is_not_lightning' THEN
      RAISE EXCEPTION 'FAIL 08: a formation in a Cluster that left Lightning was dealt: %', v_d;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;
END $$;
\echo '  ok  08 DEFECT 6, begin_dealing LOOKS OUTSIDE THE INSTANCE  the old caller clock the ground dealt with now gets past_deadline while a formation made now deals; a formation whose Cluster had Lightning switched off, one with a participant who sat out, one whose epoch moved and one whose Cluster left Lightning are each refused by name, the first two abandoned with the reason and their reservations released'

-- 09 DEFECT 7: AN IMPOSSIBLE STATE FREEZES THE CLUSTER; ONLY A RACE IS RETRIED --
DO $$
DECLARE v_g uuid; v_r jsonb; v_n bigint; v_before numeric; v_ev jsonb;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  SELECT count(*) INTO v_n FROM public.lightning_instance WHERE cluster_id = v_g;
  -- A check_violation inside the atomic block: frozen, not retried.
  PERFORM set_config('fxr.raise_hand_player', '23514', false);
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6), gen_random_uuid());
  PERFORM set_config('fxr.raise_hand_player', '', false);
  IF v_r ->> 'reason' IS DISTINCT FROM 'formation_invariant_failed' OR (v_r ->> 'retry')::boolean IS DISTINCT FROM false
     OR (v_r ->> 'frozen')::boolean IS DISTINCT FROM true OR v_r ->> 'sqlstate' IS DISTINCT FROM '23514'
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'frozen'
     OR (SELECT mode FROM public.cash_cluster_epoch WHERE cluster_id = v_g AND ended_at IS NULL) IS DISTINCT FROM 'frozen' THEN
    RAISE EXCEPTION 'FAIL 09: an impossible state was not frozen: %', v_r;
  END IF;
  IF (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = v_g) IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'FAIL 09: the frozen formation left an instance behind';
  END IF;
  SELECT payload INTO v_ev FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'stack_invariant_failed' ORDER BY at DESC LIMIT 1;
  IF v_ev ->> 'sqlstate' IS DISTINCT FROM '23514' OR jsonb_array_length(v_ev -> 'players') IS DISTINCT FROM 6
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'cluster_frozen'
                      AND payload ->> 'to_mode' = 'frozen' AND request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 09: the freeze did not write its evidence: %', v_ev;
  END IF;
  -- Frozen means frozen: the next formation is refused.
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  IF v_r ->> 'reason' IS DISTINCT FROM 'cluster_is_not_lightning' THEN
    RAISE EXCEPTION 'FAIL 09: a frozen Cluster formed a hand: %', v_r;
  END IF;
  UPDATE public.cash_games SET cluster_mode = 'lightning' WHERE id = v_g;

  -- A SERIALIZATION FAILURE, and a unique violation on an index two matchers
  -- race for, are retries, and the Cluster keeps dealing.
  PERFORM set_config('fxr.raise_hand_player', '40001', false);
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  PERFORM set_config('fxr.raise_hand_player', '23505', false);
  PERFORM set_config('fxr.raise_constraint_hand_player', 'lightning_reservation_one_active_per_player', false);
  IF (v_r ->> 'retry')::boolean IS DISTINCT FROM true OR v_r ->> 'reason' IS DISTINCT FROM 'formation_refused' THEN
    RAISE EXCEPTION 'FAIL 09: a serialization failure was not a retry: %', v_r;
  END IF;
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  IF (v_r ->> 'retry')::boolean IS DISTINCT FROM true OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 09: a raced reservation index was not a retry: %', v_r;
  END IF;
  -- The same class on an index nobody races for is an impossible state.
  PERFORM set_config('fxr.raise_constraint_hand_player', 'lightning_hand_pkey', false);
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  PERFORM set_config('fxr.raise_hand_player', '', false);
  PERFORM set_config('fxr.raise_constraint_hand_player', '', false);
  IF (v_r ->> 'frozen')::boolean IS DISTINCT FROM true OR v_r ->> 'constraint' IS DISTINCT FROM 'lightning_hand_pkey' THEN
    RAISE EXCEPTION 'FAIL 09: a unique violation on an unraced index was retried: %', v_r;
  END IF;
  UPDATE public.cash_games SET cluster_mode = 'lightning' WHERE id = v_g;

  -- MONEY MOVED ON A PARTICIPANT'S ANCHOR DURING A FORMATION: the barrier's
  -- own comparison catches it as PLT02, freezes, and the chip is rolled back.
  SELECT sum(ts.stack) INTO v_before FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;
  PERFORM set_config('fxr.move_anchor_chip', 'on', false);
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  PERFORM set_config('fxr.move_anchor_chip', '', false);
  SELECT payload INTO v_ev FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'stack_invariant_failed' ORDER BY at DESC LIMIT 1;
  IF v_r ->> 'sqlstate' IS DISTINCT FROM 'PLT02' OR (v_r ->> 'frozen')::boolean IS DISTINCT FROM true
     OR v_ev ->> 'message' !~ '^LIGHTNING_FORMATION_MOVED_MONEY'
     OR v_ev ->> 'money_before' IS NOT DISTINCT FROM v_ev ->> 'money_after'
     OR (SELECT sum(ts.stack) FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL 09: a chip moved during a formation was not caught, frozen and rolled back: %', v_r;
  END IF;
  UPDATE public.cash_games SET cluster_mode = 'lightning' WHERE id = v_g;
END $$;
\echo '  ok  09 DEFECT 7, AN IMPOSSIBLE STATE IS NOT RETRIED  a check_violation inside the atomic block now answers formation_invariant_failed with retry false, freezes the Cluster and its epoch through cluster_mode, leaves no instance, and writes stack_invariant_failed with the six players and cluster_frozen with the request, after which the Cluster forms nothing; a serialization failure and a unique violation on lightning_reservation_one_active_per_player are still retries on a Cluster that keeps dealing, while the same class on lightning_hand_pkey freezes; and a chip moved on a participant''s anchor during a formation is caught by the barrier''s own PLT02 comparison, rolled back and frozen with both money snapshots in the evidence'

-- 10 DEFECT 8: THE PASS TAKES THE CLUSTER FIRST, NEVER WAITS, AND IS BUDGETED ---
DO $$
DECLARE v_g uuid; v_mm uuid; v_r jsonb; v_t text; t0 timestamptz;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  SELECT game INTO v_mm FROM r2 WHERE k = 'g5';
  PERFORM public.fxr_other('BEGIN');
  IF public.fxr_other_ask(format('SELECT id::text FROM public.cash_games WHERE id = %L FOR UPDATE', v_g)) IS DISTINCT FROM v_g::text
     OR public.fxr_other_ask(format('SELECT id::text FROM public.cash_games WHERE id = %L FOR UPDATE', v_mm)) IS DISTINCT FROM v_mm::text THEN
    RAISE EXCEPTION 'FAIL 10: the other backend could not hold the two Cluster rows';
  END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  t0 := clock_timestamp();
  v_r := public.fn_lightning_pool_slots_sync(v_g);
  IF v_r ->> 'reason' IS DISTINCT FROM 'cluster_busy' OR clock_timestamp() - t0 > interval '1 second' THEN
    RAISE EXCEPTION 'FAIL 10: the slot pass waited on, or ignored, a held Cluster row: %', v_r;
  END IF;
  t0 := clock_timestamp();
  v_r := public.fn_cash_cluster_tick(v_g);
  IF v_r ->> 'reason' IS DISTINCT FROM 'lightning_cluster_stands_down' OR (v_r ->> 'locked')::boolean IS DISTINCT FROM false
     OR clock_timestamp() - t0 > interval '1 second' THEN
    RAISE EXCEPTION 'FAIL 10: the tick waited on a Lightning Cluster''s row: %', v_r;
  END IF;
  -- The twin: a must_move Cluster's tick does take its row, and waits for it.
  PERFORM set_config('lock_timeout', '200ms', true);
  v_t := public.fxr_try(format('SELECT public.fn_cash_cluster_tick(%L)', v_mm));
  IF v_t !~ '^55P03' THEN
    RAISE EXCEPTION 'FAIL 10: a must_move tick did not take its row: %', v_t;
  END IF;
  PERFORM set_config('lock_timeout', '0', true);
  PERFORM public.fxr_other('ROLLBACK');
  IF public.fn_lightning_pool_slots_sync(v_g) ->> 'reason' IS DISTINCT FROM 'synced' THEN
    RAISE EXCEPTION 'FAIL 10: the slot pass did not run once the row was free';
  END IF;
END $$;
DO $$
DECLARE v_g uuid; v_r jsonb; v_m uuid;
BEGIN
  -- THE PASS DEADLINE. Eighteen slotless sessions; past the deadline the pass
  -- opens none and says it deferred; with no deadline it opens all eighteen.
  v_g := public.fx9_cluster('G10', 6, 40, true);
  PERFORM public.fx9_seat(v_g, 18);
  PERFORM public.fx9_convert(v_g);
  PERFORM set_config('ca.cluster_pass_deadline', (clock_timestamp() - interval '1 second')::text, true);
  v_r := public.fn_lightning_pool_slots_sync(v_g);
  IF (v_r ->> 'slots_opened')::integer IS DISTINCT FROM 0 OR (v_r ->> 'deferred')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: the slot pass ran past its deadline: %', v_r;
  END IF;
  PERFORM set_config('ca.cluster_pass_deadline', '', true);
  v_r := public.fn_lightning_pool_slots_sync(v_g);
  IF (v_r ->> 'slots_opened')::integer IS DISTINCT FROM 18 OR (v_r ->> 'deferred')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 10: the slot pass did not open eighteen slots with no deadline: %', v_r;
  END IF;
  -- A SLOT OPENED AHEAD OF THE PASS'S CLOCK closes at its own opened_at (undone).
  BEGIN
    SELECT ps.id INTO v_m FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL ORDER BY ps.entered_at, ps.id LIMIT 1;
    UPDATE public.lightning_pool_slot SET opened_at = clock_timestamp() + interval '1 hour'
     WHERE pool_session_id = v_m AND closed_at IS NULL;
    UPDATE public.lightning_pool_session SET exited_at = clock_timestamp() + interval '2 hours', exit_reason = 'fxr'
     WHERE id = v_m;
    v_r := public.fn_lightning_pool_slots_sync(v_g);
    IF (v_r ->> 'slots_closed')::integer IS DISTINCT FROM 1
       OR (SELECT closed_at = opened_at FROM public.lightning_pool_slot WHERE pool_session_id = v_m) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 10: a slot opened in the future was not closed at its own opened_at: %', v_r;
    END IF;
    RAISE EXCEPTION 'FXR_UNDO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM 'FXR_UNDO' THEN RAISE; END IF;
  END;
END $$;
\echo '  ok  10 DEFECT 8, THE CLUSTER ROW FIRST AND NEVER WAITED FOR  with another backend holding the rows, the slot pass answers cluster_busy at once and the tick stands a Lightning Cluster down at once without taking its row, while a must_move tick takes and waits on its own; once released the pass syncs; past the pass deadline the pass opens none of eighteen slotless sessions and says deferred, and with none it opens all eighteen; and the slot opened in the future that broke the old pass is closed at its own opened_at'

-- 11 DEFECT 9: ONE FAILED ABORT COSTS ONE CONVERSION -----------------------------
DO $$
DECLARE v_a uuid; v_b uuid; v_r jsonb;
BEGIN
  SELECT game, b INTO v_a, v_b FROM r2 WHERE k = 'g7';
  PERFORM set_config('fxr.break_abort_cluster', v_a::text, false);
  v_r := public.fn_cash_cluster_reap_stuck_conversions();
  PERFORM set_config('fxr.break_abort_cluster', '', false);
  IF (v_r ->> 'failed')::integer IS DISTINCT FROM 1 OR (v_r ->> 'reaped')::integer IS DISTINCT FROM 1
     OR (SELECT status FROM public.cash_cluster_conversion WHERE cluster_id = v_b) IS DISTINCT FROM 'aborted'
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_b) IS DISTINCT FROM 'must_move'
     OR (SELECT status FROM public.cash_cluster_conversion WHERE cluster_id = v_a) IS DISTINCT FROM 'pending'
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_a AND kind = 'lightning_pending_on_reap_failed'
                      AND payload ->> 'sqlstate' = '23514') THEN
    RAISE EXCEPTION 'FAIL 11: one failed abort still cost the other conversion, or left no row: %', v_r;
  END IF;
  v_r := public.fn_cash_cluster_reap_stuck_conversions();
  IF (SELECT status FROM public.cash_cluster_conversion WHERE cluster_id = v_a) IS DISTINCT FROM 'aborted' THEN
    RAISE EXCEPTION 'FAIL 11: the conversion whose abort failed was not reaped once it could be: %', v_r;
  END IF;
END $$;
\echo '  ok  11 DEFECT 9, ONE FAILED ABORT COSTS ONE CONVERSION  of the two stuck conversions the ground could not reap, the one whose abort fails is left pending with a lightning_pending_on_reap_failed row carrying its SQLSTATE while the other is aborted and its Cluster back in must_move in the same pass, and the next pass reaps the first'

-- 12 DEFECT 10: THE SPECIFICATION'S EVENTS ---------------------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_d jsonb; v_i uuid; v_ev record;
BEGIN
  -- The reaper voids a dealing hand nothing has vouched for.
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  v_r := public.fxr_form(v_g, public.fx9_candidates(v_g, 6));
  v_i := (v_r ->> 'instance_id')::uuid;
  v_d := public.fn_lightning_instance_begin_dealing(v_i);
  IF (v_d ->> 'dealing')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 12: the hand to be voided did not deal: % / %', v_r, v_d;
  END IF;
  UPDATE public.lightning_instance SET deadline_at = started_at + interval '1 millisecond' WHERE id = v_i;
  PERFORM pg_sleep(0.01);
  PERFORM public.fn_lightning_reap_formations();
  IF (SELECT state FROM public.lightning_instance WHERE id = v_i) IS DISTINCT FROM 'abandoned' THEN
    RAISE EXCEPTION 'FAIL 12: the reaper did not void a dealing hand past its deadline';
  END IF;
  INSERT INTO r2 (k, game, b) VALUES ('g2_voided', v_g, v_i);
END $$;
DO $$
DECLARE
  v_g1 uuid; v_g2 uuid; v_g3 uuid; v_e3 integer; v_req3 uuid; v_h uuid; v_i uuid; v_n integer; v_bad text; v_p jsonb;
BEGIN
  SELECT game, t::uuid, n INTO v_g3, v_req3, v_e3 FROM r2 WHERE k = 'g3';
  SELECT game INTO v_g1 FROM r2 WHERE k = 'g1';
  SELECT game, a, b INTO v_g2, v_h, v_i FROM r2 WHERE k = 'g2_dealt';
  SELECT player_count INTO v_n FROM public.lightning_hand WHERE hand_id = v_h;
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('cluster_epoch_started at the conversion, with its request and reason',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_g3 AND kind = 'cluster_epoch_started'
               AND cluster_epoch = v_e3 AND request_id = v_req3 AND payload ->> 'started_by' = 'lightning_on'
               AND (payload ->> 'previous_epoch')::integer = v_e3 - 1)),
    ('cluster_epoch_started at genesis',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_g3 AND kind = 'cluster_epoch_started'
               AND payload ->> 'started_by' = 'genesis')),
    ('pool_player_joined, one per converted player, with the conversion request',
     (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g3 AND kind = 'pool_player_joined'
        AND request_id = v_req3 AND payload ->> 'via' = 'fn_cash_cluster_commit_lightning') = 18),
    ('instance_created by the barrier',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'instance_created' AND payload ->> 'instance_id' = v_i::text
               AND payload ->> 'via' = 'fn_lightning_form_hand')),
    ('instance_created by fn_lightning_instance_open',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_g1 AND kind = 'instance_created'
               AND payload ->> 'via' = 'fn_lightning_instance_open')),
    ('ONE pool_player_reserved per instance, carrying every player',
     (SELECT count(*) FROM public.cash_cluster_events WHERE kind = 'pool_player_reserved' AND payload ->> 'instance_id' = v_i::text) = 1
     AND (SELECT jsonb_array_length(payload -> 'players') FROM public.cash_cluster_events WHERE kind = 'pool_player_reserved' AND payload ->> 'instance_id' = v_i::text) = v_n),
    ('hand_created with every participant''s seat, position and blind role',
     (SELECT count(*) FROM public.cash_cluster_events e, jsonb_array_elements(e.payload -> 'participants') x
       WHERE e.kind = 'hand_created' AND e.payload ->> 'hand_id' = v_h::text
         AND x ->> 'position' IS NOT NULL AND x ->> 'blind_role' IS NOT NULL AND x ->> 'seat' IS NOT NULL AND x ->> 'player_id' IS NOT NULL) = v_n),
    ('no lightning_hand_formed after the migration',
     NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.kind = 'lightning_hand_formed'
                   AND e.payload ->> 'hand_id' = v_h::text)),
    ('instance_started',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'instance_started' AND payload ->> 'instance_id' = v_i::text)),
    ('instance_completed, and pool_player_released with every player',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'instance_completed' AND payload ->> 'instance_id' = v_i::text)
     AND (SELECT jsonb_array_length(payload -> 'players') FROM public.cash_cluster_events WHERE kind = 'pool_player_released' AND payload ->> 'instance_id' = v_i::text) = v_n),
    ('instance_destroyed with begin_dealing''s reason',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'instance_destroyed'
               AND payload ->> 'instance_id' = (SELECT b FROM r2 WHERE k = 'g2_refused')::text
               AND payload ->> 'reason' ~ 'lightning_disabled' AND (payload ->> 'hand_voided')::boolean = false)),
    ('instance_destroyed for a dealing hand the reaper voided',
     EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'instance_destroyed'
               AND payload ->> 'instance_id' = (SELECT b FROM r2 WHERE k = 'g2_voided')::text
               AND payload ->> 'reason' ~ '^reaped' AND (payload ->> 'hand_voided')::boolean = true
               AND payload ->> 'from_state' = 'dealing')),
    ('every specification event is version 1 and names its Cluster and epoch',
     NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind IN ('cluster_epoch_started', 'pool_player_joined',
                   'pool_player_left', 'instance_created', 'instance_started', 'instance_completed', 'instance_destroyed',
                   'pool_player_reserved', 'pool_player_released', 'hand_created', 'stack_invariant_failed', 'cluster_frozen')
                   AND (event_version IS DISTINCT FROM 1::smallint OR payload ->> 'cluster_id' IS DISTINCT FROM game_id::text
                        OR (payload ->> 'cluster_epoch')::integer IS DISTINCT FROM cluster_epoch)))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12: missing or wrong: %', v_bad;
  END IF;
END $$;
\echo '  ok  12 DEFECT 10, THE SPECIFICATION''S EVENTS  cluster_epoch_started at genesis and at the conversion, carrying the conversion''s request and reason; eighteen pool_player_joined from the conversion with its request; instance_created from the barrier and from fn_lightning_instance_open; ONE pool_player_reserved per instance carrying every player; hand_created with every participant''s seat, position and blind role and no lightning_hand_formed; instance_started; instance_completed with one pool_player_released carrying every player; instance_destroyed with begin_dealing''s reason, and for the dealing hand the real reaper voided; and every one of them version 1 and naming its Cluster and epoch'

-- 13 DEFECT 11: IDEMPOTENT FORMATION, CLOSED HISTORY, THE AGE OF A DEBT -------
DO $$
DECLARE v_g uuid; v_req uuid := gen_random_uuid(); v_r1 jsonb; v_r2 jsonb; v_n bigint; v_t text; v_h uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  v_r1 := public.fxr_form(v_g, public.fx9_candidates(v_g, 6), v_req);
  SELECT count(*) INTO v_n FROM public.lightning_hand WHERE cluster_id = v_g;
  v_r2 := public.fxr_form(v_g, public.fx9_candidates(v_g, 6), v_req);
  v_h := (v_r1 ->> 'hand_id')::uuid;
  IF (v_r1 ->> 'formed')::boolean IS DISTINCT FROM true OR (v_r2 ->> 'replayed')::boolean IS DISTINCT FROM true
     OR v_r2 ->> 'hand_id' IS DISTINCT FROM v_r1 ->> 'hand_id' OR v_r2 -> 'seats' IS DISTINCT FROM v_r1 -> 'seats'
     OR v_r2 ->> 'bb' IS DISTINCT FROM v_r1 ->> 'bb'
     OR (SELECT count(*) FROM public.lightning_hand WHERE cluster_id = v_g) IS DISTINCT FROM v_n
     OR (SELECT request_id FROM public.lightning_hand WHERE hand_id = v_h) IS DISTINCT FROM v_req
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE kind = 'hand_created' AND request_id = v_req) THEN
    RAISE EXCEPTION 'FAIL 13: a retried formation did not answer with the hand it formed: % / %', v_r1, v_r2;
  END IF;
  v_r2 := public.fxr_form((SELECT game FROM r2 WHERE k = 'g1'), public.fx9_candidates((SELECT game FROM r2 WHERE k = 'g1'), 6), v_req);
  IF v_r2 ->> 'reason' IS DISTINCT FROM 'request_id_belongs_to_another_cluster' THEN
    RAISE EXCEPTION 'FAIL 13: a request id was reused on another Cluster: %', v_r2;
  END IF;
  v_t := public.fxr_try(format('UPDATE public.lightning_hand SET request_id = gen_random_uuid() WHERE hand_id = %L', v_h));
  IF v_t !~ '^23514: LIGHTNING_HAND_IS_IMMUTABLE' THEN
    RAISE EXCEPTION 'FAIL 13: a hand''s request id could be rewritten: %', v_t;
  END IF;
  v_t := public.fxr_probe(format('INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id, rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version, request_id) SELECT gen_random_uuid(), cluster_id, cluster_epoch, lightning_instance_id, %L, %L, %L, %L, %L, request_id FROM public.lightning_hand WHERE hand_id = %L',
                                 'x', 'x', 'x', 'x', 'x', v_h));
  IF v_t !~ '^23505: .*lightning_hand_one_per_request' THEN
    RAISE EXCEPTION 'FAIL 13: a second hand with the same request id was not refused by its index: %', v_t;
  END IF;
  PERFORM public.fn_lightning_instance_abandon((v_r1 ->> 'instance_id')::uuid, 'fxr: section 13');
END $$;

-- NOTHING MAY DELETE THE HISTORY, AS THE APPLICATION'S ROLE; READING IS UNTOUCHED.
DO $$
DECLARE v_t text; v_tab text; v_bad text := '';
BEGIN
  SET LOCAL ROLE service_role;
  FOREACH v_tab IN ARRAY ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_instance', 'lightning_reservation',
                               'lightning_pool_slot', 'lightning_pool_session', 'lightning_blind_ledger', 'cash_cluster_conversion'] LOOP
    v_t := public.fxr_try(format('DELETE FROM public.%I WHERE false', v_tab));
    IF v_t !~ '^42501' THEN v_bad := v_bad || v_tab || ' delete: ' || v_t || '; '; END IF;
    v_t := public.fxr_try(format('SELECT 1 FROM public.%I LIMIT 1', v_tab));
    IF v_t IS DISTINCT FROM 'no error' THEN v_bad := v_bad || v_tab || ' select: ' || v_t || '; '; END IF;
  END LOOP;
  v_t := public.fxr_try('TRUNCATE public.cash_cluster_conversion');
  IF v_t !~ '^42501' THEN v_bad := v_bad || 'conversion truncate: ' || v_t; END IF;
  RESET ROLE;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL 13: %', v_bad;
  END IF;
END $$;

-- debt_since: set when a debt first becomes unresolved, kept, cleared.
DO $$
DECLARE v_g uuid; v_z uuid := gen_random_uuid(); v_s timestamptz;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  INSERT INTO public.lightning_blind_ledger (cluster_id, player_id) VALUES (v_g, v_z);
  IF (SELECT debt_since FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_z) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: a ledger row that owes nothing has a debt age';
  END IF;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1 WHERE cluster_id = v_g AND player_id = v_z;
  SELECT debt_since INTO v_s FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_z;
  PERFORM pg_sleep(0.01);
  UPDATE public.lightning_blind_ledger SET bb_count = bb_count + 1, sb_owed = 1 WHERE cluster_id = v_g AND player_id = v_z;
  IF v_s IS NULL OR (SELECT debt_since FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_z) IS DISTINCT FROM v_s THEN
    RAISE EXCEPTION 'FAIL 13: debt_since was not set when the debt arose, or moved while it stood';
  END IF;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 0, sb_owed = 0 WHERE cluster_id = v_g AND player_id = v_z;
  IF (SELECT debt_since FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_z) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: debt_since was not cleared when the debt was resolved';
  END IF;
END $$;

-- THE P2 TIE-BREAK READS THE DEBT'S AGE. Two players owing a big blind with
-- the same last_bb_at: the one whose debt is older ranks first, although his
-- ledger row was touched more recently - which is exactly the pair the old
-- key, updated_at, ranked the other way. Swapped, the order swaps.
DO $$
DECLARE v_g uuid; v_e integer; v_x uuid; v_y uuid; v_first uuid;
BEGIN
  SELECT game INTO v_g FROM r2 WHERE k = 'g2';
  SELECT cluster_epoch INTO v_e FROM public.cash_games WHERE id = v_g;
  SELECT (array_agg(player_id ORDER BY player_id))[1], (array_agg(player_id ORDER BY player_id))[2] INTO v_x, v_y
    FROM public.lightning_pool_slot WHERE cluster_id = v_g AND cluster_epoch = v_e AND closed_at IS NULL;
  UPDATE public.lightning_pool_slot SET last_bb_at = timestamptz '2026-01-01 00:00:00+00'
   WHERE cluster_id = v_g AND closed_at IS NULL AND player_id IN (v_x, v_y);
  INSERT INTO public.lightning_blind_ledger (cluster_id, player_id) VALUES (v_g, v_x), (v_g, v_y) ON CONFLICT DO NOTHING;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 0, missed_sb_debt = 0, bb_owed = 0, sb_owed = 0
   WHERE cluster_id = v_g AND player_id IN (v_x, v_y);
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1, debt_since = clock_timestamp() - interval '2 hours', updated_at = clock_timestamp()
   WHERE cluster_id = v_g AND player_id = v_x;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1, debt_since = clock_timestamp() - interval '1 hour', updated_at = clock_timestamp() - interval '3 hours'
   WHERE cluster_id = v_g AND player_id = v_y;
  SELECT player_id INTO v_first FROM public.fn_lightning_blind_order(v_g, v_e, ARRAY[v_x, v_y]) ORDER BY p2_rank LIMIT 1;
  IF v_first IS DISTINCT FROM v_x
     OR (SELECT updated_at FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_x)
        <= (SELECT updated_at FROM public.lightning_blind_ledger WHERE cluster_id = v_g AND player_id = v_y) THEN
    RAISE EXCEPTION 'FAIL 13: the older debt did not rank first, or updated_at would have agreed anyway';
  END IF;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 0 WHERE cluster_id = v_g AND player_id IN (v_x, v_y);
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1, debt_since = clock_timestamp() - interval '1 hour' WHERE cluster_id = v_g AND player_id = v_x;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1, debt_since = clock_timestamp() - interval '2 hours' WHERE cluster_id = v_g AND player_id = v_y;
  SELECT player_id INTO v_first FROM public.fn_lightning_blind_order(v_g, v_e, ARRAY[v_x, v_y]) ORDER BY p2_rank LIMIT 1;
  IF v_first IS DISTINCT FROM v_y THEN
    RAISE EXCEPTION 'FAIL 13: swapping the debt ages did not swap the order';
  END IF;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 0 WHERE cluster_id = v_g AND player_id IN (v_x, v_y);
END $$;
\echo '  ok  13 DEFECT 11, IDEMPOTENT, CLOSED, AGED  a formation retried with its request id answers replayed with the same hand, seats and big blind and forms nothing, hand_created carries the request, the id is refused on another Cluster, cannot be rewritten on the hand and cannot be used twice; as service_role DELETE is refused on all seven lightning tables and on cash_cluster_conversion (TRUNCATE too) while SELECT is untouched; debt_since is set when a debt arises, kept while it stands and cleared when it is resolved; and P2 ranks the older debt first even when updated_at says the opposite, and swaps when the ages swap'

-- 14 LAW 10.5: A HORSE IS A PLAYER ------------------------------------------------
DO $$
DECLARE v_n bigint; v_bad bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    JOIN public.cash_games g ON g.id = tb.cluster_id
   WHERE ts.horse_id IS NOT NULL AND g.cluster_mode = 'lightning'
     AND public.fn_lightning_anchor_is_live_eligible(ts.id, g.id, ts.user_id);
  SELECT count(*) INTO v_bad FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    JOIN public.cash_games g ON g.id = tb.cluster_id
   WHERE ts.horse_id IS NOT NULL AND g.cluster_mode = 'lightning'
     AND public.fn_lightning_anchor_is_live_eligible(ts.id, g.id, ts.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = g.id
                       AND ps.player_id = ts.user_id AND ps.exited_at IS NULL);
  IF v_n < 3 OR v_bad IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'FAIL 14: % of % eligible horses at Lightning Clusters are not in the pool', v_bad, v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp JOIN public.table_seats ts ON ts.user_id = hp.player_id
                  WHERE ts.horse_id IS NOT NULL AND hp.position IS NOT NULL AND hp.blind_role IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 14: no horse was ever seated in a formed hand';
  END IF;
END $$;
\echo '  ok  14 LAW 10.5, A HORSE IS A PLAYER  every eligible horse at a Lightning Cluster - converted, or seated after the conversion - holds an open pool session, a horse was formed into a hand with a position and a blind role and its anchor guarded (section 06), and not one body this file installs mentions is_horse (section 15)'
ASSERT

# 15 EVERY LIVE PROOF, THIS FILE'S AND ITS FOUR PREDECESSORS'.
#
# Each `-- @live-proof:` expression is extracted from the file and evaluated
# as code by fxr_eval. Every proof THIS file carries must be true. Every proof
# of 20260921151618, 20260925204249, 20260925215731 and 20260926023047 must be
# true too, EXCEPT the ones listed in SUPERSEDED below - which must now be
# FALSE, because each names a set or a body this file deliberately changed; a
# supersession that left the old proof true would mean nothing changed. The
# same list is the Corrections section of
# docs/changelog/2026-09-26-lightning-phase-5-9-remediation-2.md. A superseded
# proof that names the nine-argument fn_lightning_form_hand is ALSO evaluated
# with that signature rewritten to the ten-argument one, and the harness
# records which of them still hold in substance.
#
# Two predecessor proofs (one of 20260921151618, one of 20260925204249) scan
# the whole catalogue for callers of the conversion functions, and this
# harness's own fx9_ and fxr_ writers are such callers by design; those two,
# and only those, are evaluated with them set aside, and the narrowing is
# counted.
SUPERSEDED=${LIGHTNING_R2_SUPERSEDED:-p5r#4 p9#15 p9#2 p9#6 p9r#1 p9r#13 p9r#14 p9r#15 p9r#16 p9r#2 p9r#20 p9r#21 p9r#22 p9r#25 p9r#29}
gen_proofs() {
  local src=$1 file=$2 n=0 line expr lineno tag
  while IFS= read -r line; do
    n=$((n + 1))
    lineno=${line%%:*}
    expr=${line#*:}
    expr=${expr#-- @live-proof: }
    case "$expr" in
      *"AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on'"*)
        expr=${expr/"AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on'"/"AND p.proname !~ '^(fx9|fxr)_' AND p.proname NOT IN ('fn_cash_cluster_begin_pending_on'"}
        echo "narrowed $src:$n" >> "$fixture/narrowed.txt" ;;
    esac
    case "$expr" in *'$lpq$'*) echo "FAIL 15: a proof carries the quoting tag"; exit 1 ;; esac
    printf '%s\n' "INSERT INTO lp VALUES ('$src', $n, $lineno, public.fxr_eval(\$lpq\$${expr}\$lpq\$), public.fxr_eval(replace(\$lpq\$${expr}\$lpq\$, 'timestamp with time zone,text)', 'timestamp with time zone,text,uuid)')));"
  done < <(grep -n -- '^-- @live-proof: ' "$file")
}
: > "$fixture/narrowed.txt"
{
  # THE TWO SHAPES THE SECTIONS BENT THE ESTATE INTO ON PURPOSE are put right
  # first, as an operator would: the player the ground let leave under the old
  # code, whose pool session nothing then closed, and the two players seated
  # with no cash session. Three proofs of 20260921151618 are statements about the
  # estate - the population agrees with the seats, and nobody eligible is
  # stranded at a halted table - and must be true of the estate this file
  # leaves, not merely of its code.
  cat <<'CLEAN'
DO $$
DECLARE v_g uuid; v_l uuid;
BEGIN
  SELECT game, a INTO v_g, v_l FROM r2 WHERE k = 'g1_left';
  UPDATE public.lightning_pool_slot SET closed_at = GREATEST(clock_timestamp(), opened_at), close_reason = 'pool_session_exited'
   WHERE cluster_id = v_g AND player_id = v_l AND closed_at IS NULL;
  UPDATE public.lightning_pool_session SET exited_at = GREATEST(clock_timestamp(), entered_at), state = 'closed',
         exit_reason = 'fxr: left under the code before 20260926045132'
   WHERE cluster_id = v_g AND player_id = v_l AND exited_at IS NULL;
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = (SELECT a FROM r2 WHERE k = 'j_nosession');
  -- and the stranger section 04 turned a seat over to, who has no cash session.
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = (SELECT b FROM r2 WHERE k = 't_turnover');
END $$;
CLEAN
  printf '%s\n' 'CREATE TEMP TABLE lp (src text, n integer, lineno integer, ok boolean, ok_rewritten boolean);'
  gen_proofs mine "$mine"
  gen_proofs p5 "$phase5"
  gen_proofs p5r "$phase5r"
  gen_proofs p9 "$phase9"
  gen_proofs p9r "$phase9r"
} > "$fixture/live-proofs.sql"
if [ "$(wc -l < "$fixture/narrowed.txt" | tr -d ' ')" != 2 ]; then
  echo "FAIL 15: the caller-scan narrowing applied $(wc -l < "$fixture/narrowed.txt" | tr -d ' ') time(s), not twice"
  exit 1
fi
mine_n=$(grep -c -- '^-- @live-proof: ' "$mine")
if [ "$mine_n" -lt 25 ]; then
  echo "FAIL 15: only $mine_n @live-proof lines in the file under test"
  exit 1
fi
cat >> "$fixture/live-proofs.sql" <<ASSERT
DO \$lp\$
DECLARE v_bad text; v_expected text[] := string_to_array('${SUPERSEDED}', ' ');
BEGIN
  SELECT string_agg(src || ' #' || n || ' (line ' || lineno || ')', ', ' ORDER BY src, n) INTO v_bad
    FROM lp WHERE src = 'mine' AND ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM lp WHERE src = 'mine') IS DISTINCT FROM ${mine_n}::bigint THEN
    RAISE EXCEPTION 'FAIL 15: a proof of the file under test is not true: %', v_bad;
  END IF;
  SELECT string_agg(src || '#' || n, ' ' ORDER BY src || '#' || n) INTO v_bad
    FROM lp WHERE src <> 'mine' AND ok IS DISTINCT FROM true;
  IF coalesce(v_bad, '') IS DISTINCT FROM coalesce((SELECT string_agg(x, ' ' ORDER BY x) FROM unnest(v_expected) x WHERE x <> ''), '') THEN
    RAISE EXCEPTION 'FAIL 15: the predecessor proofs that are no longer true are [%], and the superseded list is [%]', v_bad, array_to_string(v_expected, ' ');
  END IF;
END \$lp\$;
SELECT string_agg(src || '#' || n || '=' || coalesce(ok_rewritten::text, 'error'), ' ' ORDER BY src, n) AS superseded_detail
  FROM lp WHERE src <> 'mine' AND ok IS DISTINCT FROM true \gset
\echo '  ok  15 EVERY LIVE PROOF  all ${mine_n} @live-proof expressions of the file under test are true, evaluated as code over the estate sections 00 to 14 built; every proof of the four Lightning files before it is still true except exactly the superseded list, each of which is now false; rewritten to the ten-argument barrier they evaluate as:' :superseded_detail
ASSERT

# 16 THE FILE IS RE-APPLIABLE: applied a second time over everything above,
# it changes no body, acl, comment, trigger, index, constraint, column or row.
cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TEMP TABLE cap (what text PRIMARY KEY, v text);
INSERT INTO cap
SELECT 'fn ' || p.oid::regprocedure::text,
       md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND (p.proname ~ '^fn_lightning_' OR p.proname ~ '^fn_cash_cluster' OR p.proname ~ '^fn_table_seats_lightning_'
        OR p.proname IN ('fn_cash_clusters_tick_all', 'fn_cash_table_observe_dealing_halt'));
INSERT INTO cap
SELECT 'rel ' || c.relname,
       md5(coalesce((SELECT string_agg(t.tgname || pg_get_triggerdef(t.oid) || t.tgenabled::text, '|' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '')
           || coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid), '|' ORDER BY 1) FROM pg_index i WHERE i.indrelid = c.oid), '')
           || coalesce((SELECT string_agg(k.conname || pg_get_constraintdef(k.oid), '|' ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid = c.oid), '')
           || coalesce((SELECT string_agg(a.attname || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text || coalesce(col_description(c.oid, a.attnum), ''), '|' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '')
           || coalesce(c.relacl::text, ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND (c.relname LIKE 'lightning%' OR c.relname IN ('table_seats', 'tables', 'cash_cluster_events', 'cash_cluster_conversion', 'ca_declared_money_triggers'));
INSERT INTO cap
SELECT 'rows ' || t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_pool_session', 'lightning_pool_slot', 'lightning_instance', 'lightning_reservation', 'lightning_hand',
                    'lightning_hand_player', 'lightning_blind_ledger', 'cash_cluster_events', 'cash_cluster_conversion', 'table_seats']) t;
ASSERT
cat > "$fixture/reapply.sql" <<'ASSERT'
DO $$
DECLARE v_bad text; v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM cap;
  IF v_n < 40 THEN
    RAISE EXCEPTION 'FAIL 16: only % objects were captured, so the comparison proves little', v_n;
  END IF;
  SELECT string_agg(c.what, ', ') INTO v_bad FROM cap c
   WHERE c.v IS DISTINCT FROM CASE
     WHEN c.what LIKE 'fn %' THEN (SELECT md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), ''))
                                     FROM pg_proc p WHERE p.oid = to_regprocedure(substr(c.what, 4)))
     WHEN c.what LIKE 'rel %' THEN (SELECT md5(coalesce((SELECT string_agg(t.tgname || pg_get_triggerdef(t.oid) || t.tgenabled::text, '|' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = k.oid AND NOT t.tgisinternal), '')
           || coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid), '|' ORDER BY 1) FROM pg_index i WHERE i.indrelid = k.oid), '')
           || coalesce((SELECT string_agg(x.conname || pg_get_constraintdef(x.oid), '|' ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid = k.oid), '')
           || coalesce((SELECT string_agg(a.attname || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text || coalesce(col_description(k.oid, a.attnum), ''), '|' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = k.oid AND a.attnum > 0 AND NOT a.attisdropped), '')
           || coalesce(k.relacl::text, ''))
                                     FROM pg_class k WHERE k.oid = to_regclass('public.' || substr(c.what, 5)))
     ELSE (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', substr(c.what, 6)), false, true, '')))[1]::text
   END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the second application changed: %', v_bad;
  END IF;
  -- Each re-cut is present exactly once.
  SELECT string_agg(q.what, ', ') INTO v_bad FROM (VALUES
    ('replay', (SELECT count(*) FROM regexp_matches(pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = 'fn_lightning_form_hand')), 'A RETRY IS ANSWERED WITH THE HAND', 'g'))),
    ('anchor lock', (SELECT count(*) FROM regexp_matches(pg_get_functiondef((SELECT oid FROM pg_proc WHERE proname = 'fn_lightning_form_hand')), 'THE ANCHOR SEATS, FOR SHARE, FIRST', 'g'))),
    ('outside', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_lightning_instance_begin_dealing(uuid,interval,timestamp with time zone)'::regprocedure), 'THE WORLD OUTSIDE THE INSTANCE', 'g'))),
    ('observed', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure), 'THE HALT IS A STOP ONLY ONCE', 'g'))),
    ('stand down', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure), 'STAND DOWN BEFORE THE LOCK', 'g'))),
    ('budget', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure), 'ca\.cluster_pass_deadline', 'g'))),
    ('reap', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure), 'lightning_pending_on_reap_failed', 'g'))),
    ('born halted', (SELECT count(*) FROM regexp_matches(pg_get_functiondef('public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)'::regprocedure), 'BORN HALTED IN A CLUSTER', 'g')))
  ) q(what, n) WHERE q.n IS DISTINCT FROM 1::bigint;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: a re-cut is not present exactly once in: %', v_bad;
  END IF;
  -- And the estate still works: a Cluster still forms.
  IF (public.fxr_form((SELECT game FROM r2 WHERE k = 'g2'), public.fx9_candidates((SELECT game FROM r2 WHERE k = 'g2'), 6)) ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 16: a Cluster cannot form a hand after the second application';
  END IF;
END $$;
\echo '  ok  16 THE FILE IS RE-APPLIABLE  applied a second time over every hand, pool session and event above, it leaves every captured body, acl and comment, every trigger, index, constraint, column and table acl of the lightning tables, table_seats, tables, cash_cluster_events, cash_cluster_conversion and the trigger register, and every row count, exactly as they were; each re-cut is present exactly once; and a Cluster still forms'
ASSERT

# ONE psql SESSION: the fixtures, the twelve predecessor files and the ground,
# the migration, its assertions, its @live-proofs, the capture, the migration
# AGAIN and the re-apply assertions. One session, because the estate the
# ground builds is the estate the migration is applied over, and because the
# temporary table that carries ids between sections lives in this backend.
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres \
  -f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture" \
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r" \
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture" \
  -f "$fixture/ground.sql" \
  -f "$mine" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
psql_status=${PIPESTATUS[0]}
set -e
if [ "$psql_status" != 0 ]; then
  echo "FAIL: psql exited $psql_status"
  exit 1
fi

# SEVENTEEN SECTIONS REPORTED, counted rather than eyeballed: a section deleted
# during a refactor would not make psql fail, and the PASS line would still print.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 17 ]; then
  echo "FAIL: $oks of the 17 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning remediation two, 17 sections: on 20260926023047's own code every defect is reproduced first; then, applied over that estate, a conversion waits for a hand in flight and for every live engine to report its halt, a table is born halted in a halted Cluster, the pool session is anchored to a seat and follows it in and out through deferred WHEN-guarded triggers (horses exactly as humans), the pool's stack is the seat's, the formation filter is the population's predicate and the anchors are held FOR SHARE, a player in a live hand cannot be cashed out except by that hand's settlement at a few microseconds per ordinary seat update, nobody leaves a locked hand, begin_dealing abandons a formation whose world has moved, an impossible state freezes the Cluster while only a race is retried, the slot pass takes the Cluster row first and never waits, one failed abort costs one conversion, every specification event is written, formation is idempotent on its request id, history cannot be deleted and P2 ages a debt by debt_since; every @live-proof holds, exactly the superseded predecessor proofs are false, and the file is re-appliable"
