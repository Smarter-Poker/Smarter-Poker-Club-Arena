#!/usr/bin/env bash
# Lightning Phase 7 (specification Phase 10): the pool reverts to must-move,
# and the Cluster tick drives both conversions.
#
# Proves 20261001222856 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55554 (LIGHTNING_P7_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The Lightning fixtures and every Lightning
# migration from 20260920235343 through the Phase 6 settlement remediation
# (20261001201216) in order, exactly as test-lightning-phase6-settlement.sh
# builds them, then the migration under test, twice. Every Cluster is
# converted ON by the REAL begin_pending_on and commit_lightning (through the
# new drive), every pool slot comes from the real slot sync, every hand is
# formed by the real barrier, dealt by the real begin_dealing and settled by
# the real fn_lightning_settle_hand through the physical door, and every
# reversion is the migration's own. Population moves only by real seat
# writes: a departure is table_seats.left_at (the pool follows the seat
# through the real deferred trigger) and an arrival is a real seat with a
# real cash session.
#
# LAW 10.5. Every Cluster seats horses through table_seats.horse_id beside
# humans; horses enter the pool, play, leave it on the reversion and keep
# every number exactly as humans do. The migration reads neither is_horse nor
# horse_id.
#
# LIGHTNING_P7_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P7_PORT:-55554}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
base_fixture=$F/lightning-phase3-remediation-schema.sql
pop_fixture=$F/lightning-phase4-population-schema.sql
p5_fixture=$F/lightning-phase5-conversion-schema.sql
p9_fixture=$F/lightning-phase9-formation-fixture.sql
r2_fixture=$F/lightning-remediation-two-fixture.sql
p6_fixture=$F/lightning-phase6-matcher-fixture.sql
s6_fixture=$F/lightning-phase6-settlement-fixture.sql
phase1=$M/20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql
phase1r=$M/20260920234647_lightning_phase_1_remediation_the_lobby_reads_one_lightning_.sql
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
r2a=$M/20260926072527_lightning_remediation_two_a_the_table_records_that_its_engin.sql
r2b=$M/20260926072551_lightning_remediation_two_b_cluster_events_carry_a_version_a.sql
r2c=$M/20260926072615_lightning_remediation_two_c_the_seat_is_the_anchor_and_the_p.sql
r2d=$M/20260926072638_lightning_remediation_two_d_the_seat_triggers_keep_the_pool_.sql
p6=$M/20260926080332_lightning_phase_6_and_7_the_matcher_explains_every_idle_play.sql
s6=$M/20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql
s6r=$M/20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql
mine=${LIGHTNING_P7_MIGRATION:-$M/20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p7-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p $port -h '' -c max_connections=40" start >/dev/null
started=1
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres)

# EVERY @live-proof OF EVERY LIGHTNING FILE, evaluated as code by fxr_eval
# (NULL when it no longer evaluates, never false).
gen_proofs() {
  local phase=$1 src=$2 file=$3 n=0 line expr lineno
  while IFS= read -r line; do
    n=$((n + 1))
    lineno=${line%%:*}
    expr=${line#*:}
    expr=${expr#-- @live-proof: }
    case "$expr" in *'$lpq$'*) echo "FAIL: a proof carries the quoting tag"; exit 1 ;; esac
    printf '%s\n' "INSERT INTO harness.lp7 VALUES ('$phase', '$src', $n, $lineno, public.fxr_eval(\$lpq\$${expr}\$lpq\$));"
  done < <(grep -n -- '^-- @live-proof: ' "$file")
}
predecessor_proofs() {
  local phase=$1
  gen_proofs "$phase" p1 "$phase1"; gen_proofs "$phase" p1r "$phase1r"
  gen_proofs "$phase" p2 "$phase2"; gen_proofs "$phase" p2r "$phase2r"
  gen_proofs "$phase" p3 "$phase3"; gen_proofs "$phase" p3r "$phase3r"
  gen_proofs "$phase" p4 "$phase4"; gen_proofs "$phase" p4r "$phase4r"
  gen_proofs "$phase" p5 "$phase5"; gen_proofs "$phase" p5r "$phase5r"
  gen_proofs "$phase" p9 "$phase9"; gen_proofs "$phase" p9r "$phase9r"
  gen_proofs "$phase" r2a "$r2a"; gen_proofs "$phase" r2b "$r2b"
  gen_proofs "$phase" r2c "$r2c"; gen_proofs "$phase" r2d "$r2d"
  gen_proofs "$phase" p6 "$p6"; gen_proofs "$phase" s6 "$s6"; gen_proofs "$phase" s6r "$s6r"
}

# ===========================================================================
# THE GROUND: section 00, against the Phase 6 code, before the file.
# ===========================================================================
cat > "$fixture/ground.sql" <<'ASSERT'
CREATE TABLE harness.p7 (k text PRIMARY KEY, game uuid, a uuid, b uuid, n numeric, t text, j jsonb);
CREATE TABLE harness.lp7 (phase text, src text, n integer, lineno integer, ok boolean);

-- A CLUSTER WITH A FRONT TABLE AND A FEEDER, humans and horses at both, every
-- stack different, every player with an open Cluster cash session. Built only
-- through the Phase 9 and remediation-two writers.
CREATE FUNCTION harness.c7(p_key text, p_handed integer, p_main integer, p_main_horses integer,
                           p_feed integer, p_feed_horses integer) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; v_f uuid; i integer;
BEGIN
  v_g := public.fx9_cluster('P7 ' || p_key, p_handed, 40, true);
  PERFORM public.fx9_seat(v_g, p_main, 1, false);
  IF p_main_horses > 0 THEN PERFORM public.fx9_seat(v_g, p_main_horses, p_main + 1, true); END IF;
  v_f := public.fx9_table(v_g, 'P7 ' || p_key || ' feeder', 'feeder', NULL, 40);
  FOR i IN 1 .. p_feed + p_feed_horses LOOP
    PERFORM public.fxr_join(v_g, v_f, i, 200.00 + 10 * i, i > p_feed);
  END LOOP;
  INSERT INTO harness.p7 (k, game, a) VALUES ('feeder:' || v_g, v_g, v_f);
  RETURN v_g;
END $f$;
CREATE FUNCTION harness.feeder(p_game uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT a FROM harness.p7 WHERE k = 'feeder:' || p_game;
$f$;
CREATE FUNCTION harness.live(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT public.fn_cash_cluster_live_eligible(p_game);
$f$;
CREATE FUNCTION harness.mode(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT cluster_mode FROM public.cash_games WHERE id = p_game;
$f$;
CREATE FUNCTION harness.epoch(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT cluster_epoch FROM public.cash_games WHERE id = p_game;
$f$;
-- A REAL ARRIVAL: a seat at the feeder and an open Cluster cash session. The
-- pool trigger is deferred, so the transaction's constraints are made
-- immediate and the arrival is in the pool (in lightning) when this returns.
CREATE FUNCTION harness.join(p_game uuid, p_n integer, p_horse boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE i integer; v_seat integer;
BEGIN
  FOR i IN 1 .. p_n LOOP
    SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat FROM public.table_seats ts WHERE ts.table_id = harness.feeder(p_game);
    PERFORM public.fxr_join(p_game, harness.feeder(p_game), v_seat, 300.00 + v_seat, p_horse);
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
END $f$;
-- A REAL DEPARTURE: table_seats.left_at, humans first and newest first, never
-- a player in a live hand. The pool session follows the seat out through the
-- real trigger, made immediate here.
CREATE FUNCTION harness.leave(p_game uuid, p_n integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record; k integer := 0;
BEGIN
  FOR r IN
    SELECT ts.id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = p_game AND ts.left_at IS NULL AND ts.user_id IS NOT NULL AND coalesce(ts.stack, 0) > 0
       AND public.fn_lightning_player_live_hand(ts.user_id, p_game) IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation rv WHERE rv.cluster_id = p_game
                        AND rv.player_id = ts.user_id AND rv.state IN ('pending', 'committed'))
     ORDER BY (ts.horse_id IS NOT NULL), ts.joined_at DESC, ts.id DESC
     LIMIT p_n
  LOOP
    UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = r.id;
    k := k + 1;
  END LOOP;
  IF k <> p_n THEN RAISE EXCEPTION 'FIXTURE: % could only leave % of %', p_game, k, p_n; END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
END $f$;
-- THE LIVE ELIGIBLE POPULATION, MOVED TO EXACTLY p_n by real arrivals or departures.
CREATE FUNCTION harness.to(p_game uuid, p_n integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v integer := harness.live(p_game);
BEGIN
  IF v < p_n THEN PERFORM harness.join(p_game, p_n - v); ELSIF v > p_n THEN PERFORM harness.leave(p_game, v - p_n); END IF;
  IF harness.live(p_game) IS DISTINCT FROM p_n THEN
    RAISE EXCEPTION 'FIXTURE: % is at % after moving to %', p_game, harness.live(p_game), p_n;
  END IF;
END $f$;
-- EVERY COLUMN OF EVERY SEAT, CASH SESSION AND BLIND LEDGER ROW OF A CLUSTER,
-- as one md5: computed here, independently of the migration's own check.
CREATE FUNCTION harness.money(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT md5(coalesce(string_agg(x.r, '|' ORDER BY x.r), '')) FROM (
      SELECT 'ts:' || to_jsonb(ts)::text AS r FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = p_game
      UNION ALL SELECT 'cps:' || to_jsonb(s)::text FROM public.cash_player_session s WHERE s.cluster_id = p_game
      UNION ALL SELECT 'bl:' || to_jsonb(bl)::text FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = p_game) x;
$f$;
-- PER PLAYER, the numbers the specification names: stack, baseline, stay
-- clock, rejoin window, join time and the cash session itself.
CREATE FUNCTION harness.rows(p_game uuid) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT coalesce(jsonb_object_agg(ts.user_id::text, jsonb_build_object(
           'seat', ts.id, 'stack', ts.stack, 'joined_at', ts.joined_at, 'horse', ts.horse_id IS NOT NULL,
           'cps', s.id, 'baseline', s.baseline, 'stay_clock_ms', s.stay_clock_ms, 'rejoin_window_ms', s.rejoin_window_ms,
           'stay_remaining_ms', s.stay_remaining_ms, 'stay_running', s.stay_running,
           'stay_last_tick_at', s.stay_last_tick_at, 'opened_at', s.opened_at, 'closed_at', s.closed_at)), '{}'::jsonb)
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    LEFT JOIN public.cash_player_session s ON s.player_id = ts.user_id AND s.cluster_id = p_game
   WHERE tb.cluster_id = p_game AND ts.left_at IS NULL;
$f$;
CREATE FUNCTION harness.drive(p_game uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE 'SELECT public.fn_cash_cluster_lightning_drive($1)' INTO v USING p_game;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the drive did not answer: %', v; END IF;
  RETURN v;
END $f$;
-- Open-pool players of a Cluster not holding a reservation, humans or horses.
CREATE FUNCTION harness.idle(p_game uuid, p_horse boolean, p_n integer) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT coalesce(array_agg(x.player_id ORDER BY x.player_id), ARRAY[]::uuid[]) FROM (
    SELECT ps.player_id FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
     WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL AND (ts.horse_id IS NOT NULL) = p_horse
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.cluster_id = p_game
                        AND r.player_id = ps.player_id AND r.state IN ('pending', 'committed'))
     ORDER BY ps.player_id LIMIT p_n) x;
$f$;
CREATE FUNCTION harness.anchor_stack(p_game uuid, p_player uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT ts.stack FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game AND ts.user_id = p_player AND ts.left_at IS NULL;
$f$;
CREATE FUNCTION harness.form(p_game uuid, p_players uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := public.fn_lightning_form_hand(p_game, p_players,
         p_target_size => cardinality(p_players)::smallint, p_max_size => cardinality(p_players)::smallint,
         p_matcher_version => 'p7-matcher', p_request_id => gen_random_uuid());
  IF (v ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the barrier did not form % players: %', cardinality(p_players), v;
  END IF;
  RETURN v;
END $f$;
-- The real begin_dealing, then the bind with the next number of the allocator.
CREATE FUNCTION harness.deal(p_instance uuid) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v jsonb; n bigint;
BEGIN
  v := public.fn_lightning_instance_begin_dealing(p_instance);
  IF (v ->> 'dealing')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: begin_dealing refused %: %', p_instance, v;
  END IF;
  n := nextval('harness.hand_numbers');
  EXECUTE 'SELECT public.fn_lightning_bind_hand_number($1, $2)' INTO v USING p_instance, n;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: bind refused %: %', p_instance, v;
  END IF;
  RETURN n;
END $f$;
-- p_results from {player: {d: delta, c: contributed, f: fold, s: showed}}.
CREATE FUNCTION harness.results(p_hand uuid, p_spec jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT jsonb_agg(jsonb_build_object(
           'player_id', hp.player_id,
           'stack_after', hp.stack_before + coalesce((p_spec -> hp.player_id::text ->> 'd')::numeric, 0),
           'contributed', coalesce((p_spec -> hp.player_id::text ->> 'c')::numeric, 0),
           'won', GREATEST(coalesce((p_spec -> hp.player_id::text ->> 'd')::numeric, 0)
                           + coalesce((p_spec -> hp.player_id::text ->> 'c')::numeric, 0), 0),
           'fold_type', coalesce(p_spec -> hp.player_id::text ->> 'f', 'none'),
           'showed', coalesce((p_spec -> hp.player_id::text ->> 's')::boolean, false)) ORDER BY hp.seat)
    FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand;
$f$;
-- A settlement with the host table's live lease.
CREATE FUNCTION harness.settle(p_hand uuid, p_request uuid, p_results jsonb, p_rake numeric, p_bbj numeric,
                               p_row jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_host uuid; v_l record; v jsonb;
BEGIN
  SELECT lh.host_table_id INTO v_host FROM public.lightning_hand lh WHERE lh.hand_id = p_hand;
  SELECT l.instance_id, l.lease_generation INTO v_l FROM public.engine_table_leases l WHERE l.table_id = v_host;
  EXECUTE 'SELECT public.fn_lightning_settle_hand($1, $2, $3, $4, $5, $6, $7, $8, $9)' INTO v
    USING p_hand, p_request, v_host, coalesce(v_l.instance_id, 'fxr-engine'),
          coalesce(v_l.lease_generation, gen_random_uuid()), p_results, p_rake, p_bbj, p_row;
  RETURN v;
END $f$;
-- A SECOND AND THIRD BACKEND, for the races.
CREATE FUNCTION harness.connect(p_name text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF coalesce(p_name = ANY (harness.dblink_get_connections()), false) THEN
    PERFORM harness.dblink_disconnect(p_name);
  END IF;
  PERFORM harness.dblink_connect(p_name,
    'host=' || current_setting('unix_socket_directories') || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=' || current_user);
  PERFORM harness.dblink_exec(p_name, 'SET lock_timeout = ''10s''');
END $f$;
CREATE FUNCTION harness.ask(p_name text, p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT t.a FROM harness.dblink(p_name, p_sql) AS t(a text);
$f$;

-- 00 THE CATCHERS CATCH, THE FILE IS ABSENT, AND THE DEFECT IS REAL ----------
DO $$
DECLARE v_l uuid; v_m uuid; v jsonb;
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF to_regprocedure('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.fn_cash_cluster_commit_must_move(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.fn_cash_cluster_lightning_drive(uuid)') IS NOT NULL
     OR pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) ~ 'lightning_drive'
     OR pg_get_functiondef('public.fn_lightning_my_session(uuid)'::regprocedure) ~ 'seat_table_id'
     OR pg_get_functiondef('public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)'::regprocedure) ~ 'pending_off_reaped' THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  -- A Lightning Cluster that fell to 11, and a must-move Cluster at 18: the
  -- real tick pass, before the file, reverts the one and converts the other
  -- never.
  v_l := harness.c7('GROUND L', 6, 7, 2, 7, 2);
  PERFORM public.fx9_convert(v_l);
  PERFORM public.fx9_pool(v_l);
  PERFORM harness.to(v_l, 11);
  v_m := harness.c7('GROUND M', 6, 7, 2, 7, 2);
  IF harness.live(v_m) <> 18 THEN RAISE EXCEPTION 'FAIL 00: the must-move ground Cluster is not at 18'; END IF;
  INSERT INTO harness.p7 (k, game, b) VALUES ('ground', v_l, v_m);
END $$;
DO $$
DECLARE v_l uuid; v_m uuid; v jsonb; i integer;
BEGIN
  SELECT game, b INTO v_l, v_m FROM harness.p7 WHERE k = 'ground';
  FOR i IN 1 .. 3 LOOP
    v := public.fn_cash_clusters_tick_all('{}'::jsonb);
    IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 00: the tick pass did not run: %', v; END IF;
  END LOOP;
  IF harness.mode(v_l) <> 'lightning' OR harness.mode(v_m) <> 'must_move'
     OR EXISTS (SELECT 1 FROM public.cash_cluster_conversion WHERE cluster_id = v_m) THEN
    RAISE EXCEPTION 'FAIL 00: before the file the tick already converts (L %, M %)', harness.mode(v_l), harness.mode(v_m);
  END IF;
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; none of the four functions exists, the tick pass, my_session and the reaper carry none of the change; and three real tick passes leave a Lightning Cluster at 11 in lightning and a must-move Cluster at 18 in must_move, unconverted'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 01 NOTHING BEFORE IT IS FALSIFIED --------------------------------------------
DO $$
DECLARE v_bad text; v_n integer;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ' ORDER BY b.src, b.n) INTO v_bad
    FROM harness.lp7 b JOIN harness.lp7 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: predecessor proofs falsified by the file: %', v_bad;
  END IF;
  SELECT count(*) INTO v_n FROM harness.lp7 WHERE phase = 'after' AND ok IS TRUE;
  IF v_n < 100 OR (SELECT count(*) FROM harness.lp7 WHERE phase = 'before') <> (SELECT count(*) FROM harness.lp7 WHERE phase = 'after') THEN
    RAISE EXCEPTION 'FAIL 01: only % predecessor proofs were read true, so this proves too little', v_n;
  END IF;
END $$;
\echo '  ok  01 NOTHING BEFORE IT IS FALSIFIED  every @live-proof of every Lightning file from Phase 1 to the Phase 6 settlement remediation that held before the file holds after it'

-- 02 SIX-MAX THROUGH THE DRIVE: F02, F03, F05 TO F08, AND THE HYSTERESIS ----------
DO $$
DECLARE v_g uuid; v jsonb; v_trail text := ''; n integer;
BEGIN
  v_g := harness.c7('SIX', 6, 6, 2, 7, 2);
  IF harness.live(v_g) <> 17 THEN RAISE EXCEPTION 'FIXTURE: six-max is not at 17'; END IF;
  v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 02: 17 is not must_move: %', v; END IF;
  PERFORM harness.join(v_g, 1, true);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'pending_on' THEN RAISE EXCEPTION 'FAIL 02: 18 did not open PENDING_ON: %', v; END IF;
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'lightning' OR (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL) <> 18
     OR (SELECT count(*) FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
          WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ts.horse_id IS NOT NULL) <> 5 THEN
    RAISE EXCEPTION 'FAIL 02: 18 did not become LIGHTNING with all eighteen, five horses among them, in the pool: %', v;
  END IF;
  PERFORM public.fx9_pool(v_g);
  FOREACH n IN ARRAY ARRAY[17, 16, 13] LOOP
    PERFORM harness.to(v_g, n);
    v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
    IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FAIL 02: % did not stay LIGHTNING: %', n, v; END IF;
  END LOOP;
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'pending_off' OR v -> 'result' ->> 'why' <> 'population_at_or_below_off_threshold' THEN
    RAISE EXCEPTION 'FAIL 02: 12 did not open PENDING_OFF: %', v;
  END IF;
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' OR (v -> 'result' ->> 'reverted')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 02: 12 did not revert after the drain: %', v;
  END IF;
  PERFORM harness.to(v_g, 11);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 02: 11 is not MUST_MOVE'; END IF;
  -- THE HYSTERESIS: back up through 12 to 17 converts nothing.
  FOREACH n IN ARRAY ARRAY[12, 13, 15, 17] LOOP
    PERFORM harness.to(v_g, n);
    v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
    IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 02: % in must_move converted: %', n, v; END IF;
  END LOOP;
  IF v_trail <> 'hold,begin_pending_on,commit_lightning,hold,hold,hold,begin_pending_off,commit_must_move,hold,hold,hold,hold,hold' THEN
    RAISE EXCEPTION 'FAIL 02: the drive took the steps %', v_trail;
  END IF;
  IF (SELECT string_agg(from_mode || '>' || to_mode || ':' || status || ':' || trigger_population || ':' || on_threshold || '/' || off_threshold, ' ' ORDER BY opened_at)
        FROM public.cash_cluster_conversion WHERE cluster_id = v_g)
     IS DISTINCT FROM 'must_move>lightning:committed:18:18/12 lightning>must_move:committed:12:18/12' THEN
    RAISE EXCEPTION 'FAIL 02: the conversions are not exactly one ON at 18 and one OFF at 12';
  END IF;
  INSERT INTO harness.p7 (k, game) VALUES ('six', v_g);
END $$;
\echo '  ok  02 SIX-MAX  17 holds MUST_MOVE; the 18th (a horse) opens PENDING_ON and the next pass makes LIGHTNING with all eighteen in the pool; 17, 16 and 13 stay LIGHTNING; 12 opens PENDING_OFF and the next pass reverts; 11 is MUST_MOVE; climbing back through 12, 13, 15 and 17 converts nothing; exactly one ON at 18 and one OFF at 12 are recorded with their thresholds'

-- 03 NINE-MAX: F09, F10, F11 ----------------------------------------------------
DO $$
DECLARE v_g uuid; v jsonb; v_trail text := ''; n integer;
BEGIN
  v_g := harness.c7('NINE', 9, 14, 3, 7, 2);
  IF harness.live(v_g) <> 26 THEN RAISE EXCEPTION 'FIXTURE: nine-max is not at 26'; END IF;
  v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' OR (v -> 'thresholds' ->> 'on')::integer <> 27 OR (v -> 'thresholds' ->> 'off')::integer <> 18 THEN
    RAISE EXCEPTION 'FAIL 03: 26 is not MUST_MOVE under 27/18: %', v;
  END IF;
  PERFORM harness.to(v_g, 27);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FAIL 03: 27 did not become LIGHTNING: %', v; END IF;
  FOREACH n IN ARRAY ARRAY[26, 19] LOOP
    PERFORM harness.to(v_g, n);
    v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
    IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FAIL 03: % did not stay LIGHTNING', n; END IF;
  END LOOP;
  PERFORM harness.to(v_g, 18);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'pending_off' THEN RAISE EXCEPTION 'FAIL 03: 18 did not open PENDING_OFF: %', v; END IF;
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 03: 18 did not revert: %', v; END IF;
  PERFORM harness.to(v_g, 17);
  v := harness.drive(v_g); v_trail := v_trail || ',' || (v ->> 'action');
  IF harness.mode(v_g) <> 'must_move' OR v_trail <> 'hold,begin_pending_on,commit_lightning,hold,hold,begin_pending_off,commit_must_move,hold' THEN
    RAISE EXCEPTION 'FAIL 03: the nine-max steps were %', v_trail;
  END IF;
END $$;
\echo '  ok  03 NINE-MAX  26 holds MUST_MOVE under ON 27 / OFF 18; 27 becomes LIGHTNING after PENDING_ON; 26 and 19 stay; 18 opens PENDING_OFF and reverts; 17 is MUST_MOVE'

-- 04 THE REVERSION IS NOT AN ECONOMIC TRANSACTION: F12 ------------------------------
-- Setup: a converted Cluster whose cash sessions carry a running stay clock and
-- a rejoin window, whose blind ledger has rows (a formation was made), at 12.
DO $$
DECLARE v_g uuid; v jsonb; v_r jsonb;
BEGIN
  v_g := harness.c7('MONEY', 6, 6, 3, 7, 2);
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FIXTURE: MONEY did not convert: %', v; END IF;
  PERFORM public.fx9_pool(v_g);
  UPDATE public.cash_player_session s
     SET stay_clock_ms = 600000 + 1000 * (s.baseline::integer), rejoin_window_ms = 7200000 + (s.baseline::integer),
         stay_remaining_ms = 300000 - (s.baseline::integer), stay_running = (s.baseline::integer % 2 = 0),
         stay_last_tick_at = clock_timestamp() - make_interval(secs => s.baseline::integer)
   WHERE s.cluster_id = v_g;
  PERFORM harness.to(v_g, 12);
  v_r := harness.form(v_g, harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1));
  INSERT INTO harness.p7 (k, game, a) VALUES ('money', v_g, (v_r ->> 'instance_id')::uuid);
END $$;
DO $$
DECLARE v_g uuid; v jsonb;
BEGIN
  SELECT game INTO v_g FROM harness.p7 WHERE k = 'money';
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR (v -> 'result' ->> 'instances_voided')::integer <> 1 THEN
    RAISE EXCEPTION 'FAIL 04: PENDING_OFF did not void the formation that had not dealt: %', v;
  END IF;
  IF (SELECT count(*) FROM public.lightning_blind_ledger WHERE cluster_id = v_g) = 0 THEN
    RAISE EXCEPTION 'FIXTURE: MONEY has no blind ledger row, so its preservation would be vacuous';
  END IF;
  IF (SELECT count(*) FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL
         AND public.fn_lightning_hand_view_access(ps.id, ps.player_id)) <> 12 THEN
    RAISE EXCEPTION 'FIXTURE: the twelve open pool sessions of MONEY cannot see their hands, so losing that sight would prove nothing';
  END IF;
  UPDATE harness.p7 SET t = harness.money(v_g), j = harness.rows(v_g),
         b = (SELECT conversion_request_id FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'pending'),
         n = (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL)
   WHERE k = 'money';
END $$;
-- THE COMMIT, ALONE IN ITS TRANSACTION, so the rows whose xmin is this
-- transaction are a census of exactly what it wrote, in every public table.
DO $$
DECLARE v_g uuid; v_req uuid; v jsonb; v_seen text := ''; t record; v_c bigint; v_x xid;
BEGIN
  SELECT game, b INTO v_g, v_req FROM harness.p7 WHERE k = 'money';
  v := public.fn_cash_cluster_commit_must_move(v_g, v_req);
  v_x := pg_current_xact_id()::xid;
  FOR t IN SELECT c2.relname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
            WHERE n2.nspname = 'public' AND c2.relkind = 'r' ORDER BY c2.relname LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE xmin = $1', t.relname) INTO v_c USING v_x;
    IF v_c > 0 THEN v_seen := v_seen || t.relname || ' '; END IF;
  END LOOP;
  IF (v ->> 'reverted')::boolean IS DISTINCT FROM true
     OR v_seen <> 'cash_cluster_conversion cash_cluster_epoch cash_cluster_events cash_games lightning_pool_session lightning_pool_slot tables ' THEN
    RAISE EXCEPTION 'FAIL 04: the commit wrote [%], not exactly the Cluster and Lightning rows: %', v_seen, v;
  END IF;
  UPDATE harness.p7 SET a = (v ->> 'conversion_id')::uuid WHERE k = 'money';
END $$;
DO $$
DECLARE v_g uuid; v_req uuid; v_conv uuid; v_md5 text; v_rows jsonb; v_n integer; v_bad text; c record; v_off jsonb;
BEGIN
  SELECT game, b, a, t, j, n INTO v_g, v_req, v_conv, v_md5, v_rows, v_n FROM harness.p7 WHERE k = 'money';
  IF harness.money(v_g) IS DISTINCT FROM v_md5 OR harness.rows(v_g) IS DISTINCT FROM v_rows OR v_n <> 12
     OR (SELECT count(*) FROM jsonb_each(v_rows) r WHERE (r.value ->> 'horse')::boolean) < 4
     OR (SELECT count(*) FROM jsonb_each(v_rows) r WHERE (r.value ->> 'stay_clock_ms') IS NULL OR (r.value ->> 'closed_at') IS NOT NULL) > 0 THEN
    RAISE EXCEPTION 'FAIL 04: a stack, baseline, stay clock, rejoin window, join time or cash session moved, or the proof is vacuous';
  END IF;
  SELECT * INTO c FROM public.cash_cluster_conversion WHERE id = v_conv;
  IF c.from_mode <> 'lightning' OR c.to_mode <> 'must_move' OR c.status <> 'committed' OR c.trigger_population <> 12
     OR c.on_threshold <> 18 OR c.off_threshold <> 12 OR c.epoch_before <> 1 OR c.epoch_after <> 2
     OR c.conversion_request_id <> v_req OR c.chips_at_begin IS DISTINCT FROM c.chips_at_commit
     OR c.chips_at_commit IS DISTINCT FROM (SELECT sum((r.value ->> 'stack')::numeric) FROM jsonb_each(v_rows) r) THEN
    RAISE EXCEPTION 'FAIL 04: the conversion row does not record the reversion: %', to_jsonb(c);
  END IF;
  IF (SELECT string_agg(e.epoch || ':' || e.mode || ':' || e.started_by || ':' || (e.ended_at IS NULL), ' ' ORDER BY e.epoch)
        FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_g)
     IS DISTINCT FROM '0:pending_on:genesis:false 1:pending_off:lightning_on:false 2:must_move:lightning_off:true' THEN
    RAISE EXCEPTION 'FAIL 04: the epochs are not genesis, lightning_on, lightning_off';
  END IF;
  SELECT payload INTO v_off FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_off';
  IF (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_off') <> 1
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_pending_off') <> 1
     OR (v_off ->> 'pool_sessions_exited')::integer <> 12 OR jsonb_array_length(v_off -> 'players') <> 12
     OR (v_off ->> 'epoch_after')::integer <> 2 OR (v_off ->> 'chip_total')::numeric IS DISTINCT FROM c.chips_at_commit
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'pool_player_left'
          AND payload ->> 'reason' = 'lightning_off' AND request_id = v_req) <> 12 THEN
    RAISE EXCEPTION 'FAIL 04: the events are not one lightning_pending_off, one lightning_off and twelve pool_player_left: %', v_off;
  END IF;
  SELECT string_agg(ps.player_id::text, ', ') INTO v_bad
    FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = v_g AND ps.exit_reason = 'lightning_off'
     AND (ps.state <> 'closed' OR ps.ending_stack IS DISTINCT FROM ts.stack OR ts.left_at IS NOT NULL);
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL) <> 0
     OR (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL) <> 0
     OR (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND close_reason = 'lightning_off') = 0
     OR (SELECT count(*) FROM public.lightning_reservation WHERE cluster_id = v_g AND state IN ('pending', 'committed')) <> 0 THEN
    RAISE EXCEPTION 'FAIL 04: a pool session, slot or reservation was left open, or an ending stack is not the seat: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
              WHERE ps.cluster_id = v_g AND public.fn_lightning_hand_view_access(ps.id, ps.player_id)) THEN
    RAISE EXCEPTION 'FAIL 04: a pool session the reversion exited can still open Lightning hand views';
  END IF;
END $$;
\echo '  ok  04 NO MONEY MOVES  PENDING_OFF voids the formation not yet dealt; the commit, alone in its transaction, writes only Cluster and Lightning rows (no table_seats, cash_player_session or blind ledger row: the xmin census of every public table); every stack, baseline, running stay clock, rejoin window, join time and open cash session of twelve players (four horses) and the blind ledger are exactly as before; the conversion, the epochs, one lightning_off and twelve pool_player_left record it; and no exited pool session can open a Lightning hand view'

-- 05 THE TABLES DEAL AGAIN AND THE TICK TAKES THE CLUSTER BACK ---------------------
DO $$
DECLARE v_g uuid; v jsonb; v_moves integer;
BEGIN
  v_g := harness.c7('TICK', 6, 7, 2, 7, 2);
  v := public.fn_cash_cluster_tick(v_g);
  SELECT count(*) INTO v_moves FROM public.cash_seat_moves WHERE game_id = v_g AND state = 'pending';
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR v_moves = 0 THEN
    RAISE EXCEPTION 'FIXTURE: the tick plans no move on TICK before the conversion, so a resumed tick would prove nothing: %', v;
  END IF;
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FIXTURE: TICK did not convert: %', v; END IF;
  v := public.fn_cash_cluster_tick(v_g);
  IF v ->> 'reason' IS DISTINCT FROM 'lightning_cluster_stands_down' THEN
    RAISE EXCEPTION 'FAIL 05: the tick does not stand down in LIGHTNING: %', v;
  END IF;
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR (v -> 'result' ->> 'tables_released')::integer <> 2
     OR (v -> 'result' ->> 'tables_still_halted')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL 05: the reversion did not release exactly the two tables Lightning halted: %', v;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables WHERE cluster_id = v_g AND (dealing_halted_at IS NOT NULL OR dealing_halted_reason IS NOT NULL OR dealing_halt_observed_at IS NOT NULL))
     OR public.fn_cash_table_observe_dealing_halt(public.fn_cash_cluster_front_table(v_g)) IS NOT NULL
     OR public.fn_cash_table_observe_dealing_halt(harness.feeder(v_g)) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: a Lightning halt survived the reversion';
  END IF;
  -- The conversion cancelled the tick's pending moves a moment ago, and the
  -- tick will not re-plan a player whose move was cancelled inside the last
  -- sixty seconds. A Lightning epoch lasts minutes, so the harness lets those
  -- sixty seconds pass on the clock the tick reads.
  UPDATE public.cash_seat_moves SET created_at = created_at - interval '2 minutes' WHERE game_id = v_g;
  v := public.fn_cash_cluster_tick(v_g);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR v ->> 'reason' IS NOT DISTINCT FROM 'lightning_cluster_stands_down'
     OR (v ->> 'seated_total')::integer <> 12
     OR (SELECT count(*) FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.state = 'pending' AND m.reason = 'must_move'
           AND m.from_table_id = harness.feeder(v_g) AND m.to_table_id = public.fn_cash_cluster_front_table(v_g)) = 0 THEN
    RAISE EXCEPTION 'FAIL 05: the tick did not take the Cluster back with must-move moves from the feeder to the main: %', v;
  END IF;
END $$;
\echo '  ok  05 THE TABLES DEAL AGAIN  the tick stands down in LIGHTNING; the reversion lifts both halts Lightning placed and nothing is left for an engine to observe; and the next tick answers ok for twelve seated players and plans must_move moves from the feeder to the main'

-- 05b MANY PARTLY FILLED TABLES: THE PLANNER CONSOLIDATES AND MOVES NOBODY MID-HAND --
-- Four six-max tables (Main 1, Main 2, Main 3, feeder), horses at each, 18
-- seated, converted; six humans leave, the Cluster reverts at 12 with Main 1
-- full, Main 2, Main 3 and the feeder at two each. The tick that takes it
-- back plans the feeder's players, oldest first, onto the shortest Main with
-- room, arms the feeder's break and, once its window has passed, breaks it.
-- Every move is a plan the engine executes at the player's hand boundary:
-- no tick writes a seat, so nobody is moved in the middle of a hand.
DO $$
DECLARE v_g uuid; v_m2 uuid; v_m3 uuid; v_f uuid; v jsonb; i integer; v_md5 text; v_want uuid[]; v_got uuid[]; v_shape text;
BEGIN
  v_g := public.fx9_cluster('P7 MANY', 6, 6, true);
  PERFORM public.fx9_seat(v_g, 5, 1, false);
  PERFORM public.fx9_seat(v_g, 1, 6, true);
  v_m2 := public.fx9_table(v_g, 'P7 MANY main2', 'main', 2, 6);
  FOR i IN 1 .. 5 LOOP PERFORM public.fxr_join(v_g, v_m2, i, 250.00 + i, i = 5); END LOOP;
  v_m3 := public.fx9_table(v_g, 'P7 MANY main3', 'main', 3, 6);
  FOR i IN 1 .. 4 LOOP PERFORM public.fxr_join(v_g, v_m3, i, 270.00 + i, i > 2); END LOOP;
  v_f := public.fx9_table(v_g, 'P7 MANY feeder', 'feeder', NULL, 6);
  FOR i IN 1 .. 3 LOOP PERFORM public.fxr_join(v_g, v_f, i, 290.00 + i, i > 1); END LOOP;
  INSERT INTO harness.p7 (k, game, a) VALUES ('feeder:' || v_g, v_g, v_f);
  SET CONSTRAINTS ALL IMMEDIATE;
  IF harness.live(v_g) <> 18 THEN RAISE EXCEPTION 'FIXTURE: MANY is at %, not 18', harness.live(v_g); END IF;
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FIXTURE: MANY did not convert: %', v; END IF;
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 05b: MANY did not revert at 12: %', v; END IF;
  SELECT string_agg(coalesce(tb.role, '?') || coalesce(tb.main_index::text, '') || '=' || n.c, ' ' ORDER BY tb.created_at) INTO v_shape
    FROM public.tables tb
    CROSS JOIN LATERAL (SELECT count(*) AS c FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) n
   WHERE tb.cluster_id = v_g;
  IF v_shape IS DISTINCT FROM 'main1=6 main2=2 main3=2 feeder=2' THEN
    RAISE EXCEPTION 'FIXTURE: MANY reverted onto %, not four partly filled tables', v_shape;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_seat_moves WHERE game_id = v_g) THEN
    RAISE EXCEPTION 'FIXTURE: MANY has a seat move before its first must-move tick';
  END IF;
  -- The feeder's two players, oldest join first, are what Main 2 must draw.
  SELECT array_agg(ts.user_id ORDER BY ts.joined_at, ts.id) INTO v_want
    FROM public.table_seats ts WHERE ts.table_id = v_f AND ts.left_at IS NULL;
  v_md5 := harness.money(v_g);
  v := public.fn_cash_cluster_tick(v_g);
  SELECT array_agg(m.player_id ORDER BY ts.joined_at, ts.id) INTO v_got
    FROM public.cash_seat_moves m JOIN public.table_seats ts ON ts.user_id = m.player_id AND ts.left_at IS NULL
   WHERE m.game_id = v_g AND m.state = 'pending' AND m.reason = 'must_move' AND m.from_table_id = v_f AND m.to_table_id = v_m2;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR v ->> 'reason' IS NOT DISTINCT FROM 'lightning_cluster_stands_down'
     OR v_got IS DISTINCT FROM v_want
     OR (SELECT count(*) FROM public.cash_seat_moves WHERE game_id = v_g) <> 2
     OR (SELECT break_eligible_since FROM public.tables WHERE id = v_f) IS NULL THEN
    RAISE EXCEPTION 'FAIL 05b: the first tick after the reversion did not plan the feeder''s two players, oldest first, onto Main 2 (the shortest Main with room) and arm the feeder''s break: % moves %', v,
      (SELECT jsonb_agg(to_jsonb(m)) FROM public.cash_seat_moves m WHERE m.game_id = v_g);
  END IF;
  IF harness.money(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 05b: the tick wrote a seat: a must-move plan teleported a player instead of waiting for the hand boundary';
  END IF;
  UPDATE public.tables SET break_eligible_since = break_eligible_since - interval '10 minutes' WHERE id = v_f;
  v := public.fn_cash_cluster_tick(v_g);
  IF (SELECT lifecycle FROM public.tables WHERE id = v_f) IS DISTINCT FROM 'breaking'
     OR EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = v_f AND ts.left_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending'))
     OR EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id = v_g AND m.state <> 'pending')
     OR harness.money(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL 05b: once its window passed the feeder did not break with every player planned off it, or a seat was written: %', v;
  END IF;
END $$;
\echo '  ok  05b MANY TABLES  a Cluster reverted onto Main 1 full and Main 2, Main 3 and the feeder at two each (horses at every table): the first tick plans the feeder''s two players, oldest join first, onto Main 2, the shortest Main with room, and arms the feeder''s break; the next tick past the window breaks the feeder with every player planned off it; every move stays a pending plan for the hand boundary and no tick writes a seat'

-- 06 A HAND DEALT BEFORE THE DRAIN SETTLES, AND ONLY THEN DOES THE CLUSTER REVERT ----
DO $$
DECLARE v_g uuid; v jsonb; v_r jsonb; v_inst uuid; v_hand uuid; v_inst2 uuid; v_p uuid[]; v_q uuid[]; v_before jsonb; v_q_before jsonb;
        v_res jsonb; v_money text; v_spec jsonb; v_ok boolean;
BEGIN
  v_g := harness.c7('INFLIGHT', 6, 7, 2, 7, 2);
  v := harness.drive(v_g); v := harness.drive(v_g);
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  v_p := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  v_r := harness.form(v_g, v_p); v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  PERFORM harness.deal(v_inst);
  v_q := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  v_r := harness.form(v_g, v_q); v_inst2 := (v_r ->> 'instance_id')::uuid;
  SELECT jsonb_object_agg(x::text, harness.anchor_stack(v_g, x)) INTO v_before FROM unnest(v_p) x;
  SELECT jsonb_object_agg(x::text, harness.anchor_stack(v_g, x)) INTO v_q_before FROM unnest(v_q) x;
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR (v -> 'result' ->> 'hands_in_flight')::integer <> 1
     OR (v -> 'result' ->> 'instances_voided')::integer <> 1
     OR (SELECT state FROM public.lightning_instance WHERE id = v_inst) <> 'dealing'
     OR (SELECT state FROM public.lightning_instance WHERE id = v_inst2) <> 'abandoned'
     OR EXISTS (SELECT 1 FROM public.lightning_reservation WHERE lightning_instance_id = v_inst2 AND state IN ('pending', 'committed')) THEN
    RAISE EXCEPTION 'FAIL 06: PENDING_OFF did not keep the dealt hand and void the undealt one: %', v;
  END IF;
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR v ->> 'action' <> 'commit_must_move' OR v -> 'result' ->> 'reason' <> 'instances_in_flight'
     OR (v -> 'result' ->> 'ready')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 06: the commit did not answer not-ready while a hand is dealing: %', v;
  END IF;
  v_r := public.fn_lightning_form_hand(v_g, harness.idle(v_g, false, 3), p_target_size => 3::smallint, p_max_size => 3::smallint,
                                       p_matcher_version => 'p7-matcher', p_request_id => gen_random_uuid());
  IF (v_r ->> 'formed')::boolean IS NOT DISTINCT FROM true OR v_r ->> 'reason' <> 'cluster_is_not_lightning' THEN
    RAISE EXCEPTION 'FAIL 06: a new hand formed in PENDING_OFF: %', v_r;
  END IF;
  v_spec := jsonb_build_object(v_p[1]::text, jsonb_build_object('d', 5.00, 'c', 3.00, 's', true),
                               v_p[2]::text, jsonb_build_object('d', -3.00, 'c', 3.00, 's', true),
                               v_p[3]::text, jsonb_build_object('d', -3.00, 'c', 3.00, 'f', 'normal'));
  v_res := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0.75, 0.25,
             jsonb_build_object('pot_size', 9.00, 'community_cards', ARRAY['As','Kd','7h','2c','2d'], 'actions', '[]'::jsonb, 'game_variant', 'nlh'));
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true OR (SELECT state FROM public.lightning_instance WHERE id = v_inst) <> 'complete' THEN
    RAISE EXCEPTION 'FAIL 06: the hand dealt before the drain did not settle in PENDING_OFF: %', v_res;
  END IF;
  SELECT bool_and(harness.anchor_stack(v_g, x) = (v_before ->> x::text)::numeric + (v_spec -> x::text ->> 'd')::numeric) INTO v_ok FROM unnest(v_p) x;
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 06: the settlement did not land its exact deltas on the anchors'; END IF;
  v_money := harness.money(v_g);
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR (v -> 'result' ->> 'reverted')::boolean IS DISTINCT FROM true
     OR harness.money(v_g) IS DISTINCT FROM v_money THEN
    RAISE EXCEPTION 'FAIL 06: the drained Cluster did not revert, or the reversion moved money: %', v;
  END IF;
  SELECT bool_and(harness.anchor_stack(v_g, x) = (v_before ->> x::text)::numeric + (v_spec -> x::text ->> 'd')::numeric) INTO v_ok FROM unnest(v_p) x;
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 06: the settled stacks did not survive the reversion'; END IF;
  SELECT bool_and(harness.anchor_stack(v_g, x) = (v_q_before ->> x::text)::numeric) INTO v_ok FROM unnest(v_q) x;
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 06: a player of the voided formation lost or gained a chip'; END IF;
END $$;
\echo '  ok  06 THE DRAIN  PENDING_OFF keeps a dealing hand (two humans and a horse) and voids a formation not yet dealt, whose players keep every chip; the commit answers instances_in_flight, not-ready; nothing new forms; the hand settles its exact deltas in PENDING_OFF; only then does the next pass revert, moving nothing, with the settled stacks intact'

-- 07 THE POPULATION COMES BACK BEFORE THE DRAIN POINT ---------------------------------
DO $$
DECLARE v_g uuid; v jsonb; v_new uuid; v_conv record; v_r jsonb;
BEGIN
  v_g := harness.c7('ABORT', 6, 7, 2, 7, 2);
  v := harness.drive(v_g); v := harness.drive(v_g);
  PERFORM public.fx9_pool(v_g);
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' THEN RAISE EXCEPTION 'FIXTURE: ABORT did not open PENDING_OFF: %', v; END IF;
  PERFORM harness.join(v_g, 1, true);
  SELECT ts.user_id INTO v_new FROM public.table_seats ts WHERE ts.table_id = harness.feeder(v_g) ORDER BY ts.joined_at DESC, ts.id DESC LIMIT 1;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_new AND exited_at IS NULL)
     OR harness.live(v_g) <> 13 THEN
    RAISE EXCEPTION 'FIXTURE: the arrival during the drain is already pooled, or the population is not 13';
  END IF;
  v := harness.drive(v_g);
  SELECT * INTO v_conv FROM public.cash_cluster_conversion WHERE cluster_id = v_g ORDER BY opened_at DESC LIMIT 1;
  IF harness.mode(v_g) <> 'lightning' OR v ->> 'action' <> 'abort_pending_off' OR (v -> 'result' ->> 'pool_sessions_entered')::integer <> 1
     OR v_conv.status <> 'aborted' OR v_conv.abort_reason <> 'population_rose_above_off_threshold' OR v_conv.epoch_after IS NOT NULL
     OR harness.epoch(v_g) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_new AND exited_at IS NULL AND cluster_epoch = 1)
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_pending_off_aborted') <> 1 THEN
    RAISE EXCEPTION 'FAIL 07: 13 before the drain point did not return the Cluster to LIGHTNING with the new arrival pooled: %', v;
  END IF;
  PERFORM public.fx9_pool(v_g);
  v_r := harness.form(v_g, harness.idle(v_g, false, 2) || ARRAY[v_new]);
  -- And the commit itself cancels a reversion the population has outgrown.
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR (v -> 'result' ->> 'instances_voided')::integer <> 1 THEN
    RAISE EXCEPTION 'FAIL 07: the second PENDING_OFF did not open with a new request: %', v;
  END IF;
  PERFORM harness.join(v_g, 2);
  v := public.fn_cash_cluster_commit_must_move(v_g, (SELECT conversion_request_id FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'pending'));
  IF harness.mode(v_g) <> 'lightning' OR (v ->> 'ok')::boolean IS DISTINCT FROM false OR (v ->> 'reverted')::boolean IS DISTINCT FROM false
     OR (v ->> 'aborted')::boolean IS DISTINCT FROM true OR v ->> 'abort_reason' <> 'population_rose_above_off_threshold_before_the_drain_point' THEN
    RAISE EXCEPTION 'FAIL 07: the commit did not cancel a reversion the population outgrew: %', v;
  END IF;
  IF (SELECT count(*) FROM public.cash_cluster_conversion WHERE cluster_id = v_g) <> 3
     OR (SELECT count(DISTINCT conversion_request_id) FROM public.cash_cluster_conversion WHERE cluster_id = v_g) <> 3 THEN
    RAISE EXCEPTION 'FAIL 07: the attempts did not each get their own request';
  END IF;
END $$;
\echo '  ok  07 THE REVERSION IS CANCELLED  at 12 PENDING_OFF opens; a horse sitting down makes 13 and the next pass returns LIGHTNING at the same epoch, puts the arrival in the pool and lets the barrier form his hand; a second PENDING_OFF gets its own request, and its own commit cancels it when two more arrive'

-- 08 F13: TWO BACKENDS, ONE CONVERSION ---------------------------------------------
DO $$
DECLARE v_g uuid; v jsonb;
BEGIN
  v_g := harness.c7('RACE', 6, 7, 2, 7, 2);
  PERFORM public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  PERFORM harness.to(v_g, 12);
  INSERT INTO harness.p7 (k, game) VALUES ('race', v_g);
END $$;
DO $$
DECLARE v_g uuid; v_a text; v_b text; v_busy integer;
BEGIN
  SELECT game INTO v_g FROM harness.p7 WHERE k = 'race';
  PERFORM harness.connect('p7a'); PERFORM harness.connect('p7b');
  PERFORM harness.dblink_exec('p7a', 'BEGIN');
  v_a := harness.ask('p7a', format('SELECT public.fn_cash_cluster_lightning_drive(%L)::text', v_g));
  PERFORM harness.dblink_send_query('p7b', format('SELECT public.fn_cash_cluster_lightning_drive(%L)::text', v_g));
  PERFORM pg_sleep(0.3);
  v_busy := harness.dblink_is_busy('p7b');
  PERFORM harness.dblink_exec('p7a', 'COMMIT');
  SELECT t.a INTO v_b FROM harness.dblink_get_result('p7b') AS t(a text);
  PERFORM * FROM harness.dblink_get_result('p7b') AS t(a text);
  IF v_busy <> 1 OR v_a::jsonb ->> 'action' <> 'begin_pending_off' OR (v_a::jsonb -> 'result' ->> 'ok')::boolean IS DISTINCT FROM true
     OR v_b::jsonb ->> 'action' <> 'begin_pending_off' OR v_b::jsonb -> 'result' ->> 'reason' <> 'already_known'
     OR (SELECT count(*) FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND to_mode = 'must_move') <> 1
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_pending_off') <> 1 THEN
    RAISE EXCEPTION 'FAIL 08: two passes racing to PENDING_OFF did not open exactly one (busy %): % / %', v_busy, v_a, v_b;
  END IF;
  UPDATE harness.p7 SET b = (SELECT conversion_request_id FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'pending') WHERE k = 'race';
END $$;
DO $$
DECLARE v_g uuid; v_req uuid; v_a text; v_b text; v_busy integer;
BEGIN
  SELECT game, b INTO v_g, v_req FROM harness.p7 WHERE k = 'race';
  PERFORM harness.dblink_exec('p7a', 'BEGIN');
  v_a := harness.ask('p7a', format('SELECT public.fn_cash_cluster_commit_must_move(%L, %L)::text', v_g, v_req));
  PERFORM harness.dblink_send_query('p7b', format('SELECT public.fn_cash_cluster_commit_must_move(%L, %L)::text', v_g, v_req));
  PERFORM pg_sleep(0.3);
  v_busy := harness.dblink_is_busy('p7b');
  PERFORM harness.dblink_exec('p7a', 'COMMIT');
  SELECT t.a INTO v_b FROM harness.dblink_get_result('p7b') AS t(a text);
  PERFORM * FROM harness.dblink_get_result('p7b') AS t(a text);
  PERFORM harness.dblink_disconnect('p7a'); PERFORM harness.dblink_disconnect('p7b');
  IF v_busy <> 1 OR (v_a::jsonb ->> 'reverted')::boolean IS DISTINCT FROM true OR v_a::jsonb ->> 'reason' <> 'must_move'
     OR v_b::jsonb ->> 'reason' <> 'already_committed' OR (v_b::jsonb ->> 'reverted')::boolean IS DISTINCT FROM true
     OR harness.epoch(v_g) <> 2
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_off') <> 1
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'pool_player_left' AND payload ->> 'reason' = 'lightning_off') <> 12 THEN
    RAISE EXCEPTION 'FAIL 08: two commits racing did not revert exactly once (busy %): % / %', v_busy, v_a, v_b;
  END IF;
  IF public.fn_cash_cluster_commit_must_move(v_g, gen_random_uuid()) ->> 'reason' <> 'no_such_conversion'
     OR public.fn_cash_cluster_begin_pending_off(v_g, v_req) ->> 'reason' <> 'already_committed'
     OR public.fn_cash_cluster_abort_pending_off(v_g, v_req) ->> 'reason' <> 'conversion_already_closed'
     OR public.fn_cash_cluster_begin_pending_off(v_g, gen_random_uuid()) ->> 'reason' <> 'wrong_state'
     OR public.fn_cash_cluster_begin_pending_off((SELECT game FROM harness.p7 WHERE k = 'six'), v_req) ->> 'reason' <> 'request_id_belongs_to_another_cluster' THEN
    RAISE EXCEPTION 'FAIL 08: a retry, a stranger request, a foreign request or a wrong state was not answered for what it is';
  END IF;
END $$;
\echo '  ok  08 F13  two backends driving one Cluster at 12 open one PENDING_OFF (the second waits on the lock and is told already_known); two backends committing it revert once (the second is told already_committed): one epoch, one lightning_off, twelve pool_player_left; retries, unknown, foreign and wrong-state requests are each answered for what they are'

-- 09 LIGHTNING SWITCHED OFF IS DRAINED, NEVER STRANDED ----------------------------------
DO $$
DECLARE v_g uuid; v_h uuid; v jsonb;
BEGIN
  v_g := harness.c7('DISABLE', 6, 7, 2, 7, 2);
  v := harness.drive(v_g); v := harness.drive(v_g);
  PERFORM public.fx9_pool(v_g);
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR v -> 'result' ->> 'why' <> 'lightning_disabled' OR harness.live(v_g) <> 18 THEN
    RAISE EXCEPTION 'FAIL 09: switching Lightning off at 18 did not begin the drain: %', v;
  END IF;
  v := public.fn_cash_cluster_abort_pending_off(v_g, (SELECT conversion_request_id FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'pending'));
  IF v ->> 'reason' <> 'lightning_disabled' OR harness.mode(v_g) <> 'pending_off' THEN
    RAISE EXCEPTION 'FAIL 09: a switched-off Cluster was returned to LIGHTNING: %', v;
  END IF;
  v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR v ->> 'action' <> 'commit_must_move' THEN
    RAISE EXCEPTION 'FAIL 09: the switched-off Cluster at 18 did not revert: %', v;
  END IF;
  v := harness.drive(v_g);
  IF v ->> 'action' <> 'hold' OR harness.mode(v_g) <> 'must_move'
     OR EXISTS (SELECT 1 FROM public.tables WHERE cluster_id = v_g AND dealing_halted_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL)
     OR (SELECT count(*) FROM public.cash_player_session WHERE cluster_id = v_g AND closed_at IS NULL) <> 18
     OR harness.live(v_g) <> 18 THEN
    RAISE EXCEPTION 'FAIL 09: after the drain someone is stranded, a table is still halted, or the Cluster converts again while switched off: %', v;
  END IF;
  -- And PENDING_ON is abandoned, not committed, when Lightning is switched off mid-conversion.
  v_h := harness.c7('DISABLE ON', 6, 7, 2, 7, 2);
  v := harness.drive(v_h);
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_h;
  v := harness.drive(v_h);
  IF harness.mode(v_h) <> 'must_move' OR v ->> 'action' <> 'abort_pending_on' OR v -> 'result' ->> 'abort_reason' <> 'lightning_disabled'
     OR EXISTS (SELECT 1 FROM public.tables WHERE cluster_id = v_h AND dealing_halted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 09: PENDING_ON switched off was not aborted with every table resumed: %', v;
  END IF;
END $$;
\echo '  ok  09 SWITCHED OFF  lightning_enabled false at 18 begins PENDING_OFF (lightning_disabled), refuses to be aborted back, reverts on the next pass, then holds: all eighteen seated at dealing tables with open cash sessions and no pool session; PENDING_ON switched off is aborted with every table resumed'

-- 10 A STUCK PENDING_OFF IS REAPED, AND THE VOID HAND MOVES NOTHING ---------------------
DO $$
DECLARE v_g uuid; v jsonb; v_r jsonb; v_inst uuid; v_p uuid[]; v_before jsonb; v_money text; v_ok boolean; v_row jsonb;
BEGIN
  v_g := harness.c7('STUCK', 6, 7, 2, 7, 2);
  v := harness.drive(v_g); v := harness.drive(v_g);
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  v_p := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  SELECT jsonb_object_agg(x::text, harness.anchor_stack(v_g, x)) INTO v_before FROM unnest(v_p) x;
  v_r := harness.form(v_g, v_p); v_inst := (v_r ->> 'instance_id')::uuid;
  PERFORM harness.deal(v_inst);
  PERFORM harness.to(v_g, 12);
  v := harness.drive(v_g); v := harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' OR v -> 'result' ->> 'reason' <> 'instances_in_flight' THEN
    RAISE EXCEPTION 'FIXTURE: STUCK is not waiting on its hand: %', v;
  END IF;
  v_money := harness.money(v_g);
  v := public.fn_cash_cluster_reap_stuck_conversions(interval '15 minutes', clock_timestamp() + interval '20 minutes', 50);
  SELECT x INTO v_row FROM jsonb_array_elements(v -> 'conversions') x WHERE (x ->> 'cluster_id')::uuid = v_g;
  IF (v_row ->> 'reaped')::boolean IS DISTINCT FROM true OR v_row ->> 'direction' <> 'off' OR (v_row ->> 'instances_abandoned')::integer <> 1
     OR harness.mode(v_g) <> 'must_move' OR (SELECT state FROM public.lightning_instance WHERE id = v_inst) <> 'abandoned'
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'lightning_pending_off_reaped') <> 1
     OR harness.money(v_g) IS DISTINCT FROM v_money THEN
    RAISE EXCEPTION 'FAIL 10: the stuck PENDING_OFF was not reaped to MUST_MOVE with its hand void and nothing moved: %', v_row;
  END IF;
  SELECT bool_and(harness.anchor_stack(v_g, x) = (v_before ->> x::text)::numeric) INTO v_ok FROM unnest(v_p) x;
  IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 10: a player of the void hand lost or gained a chip'; END IF;
END $$;
\echo '  ok  10 THE REAPER  a PENDING_OFF waiting on a hand nobody finishes is reaped past its age: the hand (two humans and a horse) is abandoned void, the reversion commits through the same commit, every seat, session and ledger row is as it was, and lightning_pending_off_reaped records it'

-- 11 THE WHOLE CYCLE, TWICE, WITH A LIVE ENGINE ------------------------------------------
DO $$
DECLARE v_g uuid; v jsonb; v_trail text := ''; v_rows jsonb; v_anchors jsonb; v_cycle integer; t record;
BEGIN
  v_g := harness.c7('CYCLE', 6, 7, 2, 7, 2);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM public.fxr_lease(harness.feeder(v_g), true);
  v_rows := harness.rows(v_g);
  FOR v_cycle IN 1 .. 2 LOOP
    PERFORM harness.to(v_g, 18);
    -- Whoever arrived since is added; whoever was here keeps the seat first recorded.
    v_rows := harness.rows(v_g) || v_rows;
    v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action') || ',';
    v := harness.drive(v_g); v_trail := v_trail || (v -> 'result' ->> 'reason') || ',';
    IF harness.mode(v_g) <> 'pending_on' THEN RAISE EXCEPTION 'FAIL 11: the ON commit did not wait for the engines: %', v; END IF;
    FOR t IN SELECT id FROM public.tables WHERE cluster_id = v_g LOOP
      PERFORM public.fn_cash_table_observe_dealing_halt(t.id);
    END LOOP;
    v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action') || ',';
    IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FAIL 11: cycle % did not convert once observed: %', v_cycle, v; END IF;
    PERFORM public.fx9_pool(v_g);
    SELECT jsonb_object_agg(ps.player_id::text, ps.anchor_seat_id) INTO v_anchors
      FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(v_anchors) a WHERE (v_rows -> a.key ->> 'seat') IS DISTINCT FROM a.value)
       OR (SELECT count(*) FROM jsonb_each_text(v_anchors)) <> 18
       OR (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_g AND closed_at IS NULL) <> 18 THEN
      RAISE EXCEPTION 'FAIL 11: cycle % did not anchor all eighteen on the seats they always had', v_cycle;
    END IF;
    PERFORM harness.to(v_g, 12);
    v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action') || ',';
    v := harness.drive(v_g); v_trail := v_trail || (v ->> 'action') || ';';
    IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL 11: cycle % did not revert: %', v_cycle, v; END IF;
    PERFORM harness.to(v_g, 17);
  END LOOP;
  IF v_trail <> 'begin_pending_on,halt_not_observed,commit_lightning,begin_pending_off,commit_must_move;begin_pending_on,halt_not_observed,commit_lightning,begin_pending_off,commit_must_move;' THEN
    RAISE EXCEPTION 'FAIL 11: the cycle took the steps %', v_trail;
  END IF;
  IF (SELECT string_agg(e.epoch || ':' || e.mode, ' ' ORDER BY e.epoch) FROM public.cash_cluster_epoch e WHERE e.cluster_id = v_g)
       IS DISTINCT FROM '0:pending_on 1:pending_off 2:pending_on 3:pending_off 4:must_move'
     OR (SELECT count(*) FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'committed') <> 4
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND exited_at IS NULL)
     OR (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND cluster_epoch = 3) < 18 THEN
    RAISE EXCEPTION 'FAIL 11: the epochs, the conversions or the pool sessions of two full cycles are wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(harness.rows(v_g)) r WHERE v_rows ? r.key AND (r.value ->> 'stack') IS DISTINCT FROM (v_rows -> r.key ->> 'stack'))
     OR (SELECT count(*) FROM jsonb_each(harness.rows(v_g)) r WHERE v_rows ? r.key) < 12 THEN
    RAISE EXCEPTION 'FAIL 11: two cycles moved a stack';
  END IF;
END $$;
\echo '  ok  11 THE CYCLE  with live engines on both tables, MUST_MOVE -> LIGHTNING -> MUST_MOVE -> LIGHTNING -> MUST_MOVE: each ON waits for both engines to observe the new halt, every pool session anchors on the seat its player always had, each OFF reverts, five epochs and four committed conversions, and no stack moved'

-- 12 THE TICK PASS DRIVES BOTH DIRECTIONS -------------------------------------------------
DO $$
DECLARE v_l uuid; v_m uuid; v1 jsonb; v2 jsonb; v3 jsonb; a1 jsonb; a2 jsonb; m1 jsonb; m2 jsonb; v_tick jsonb; v_d uuid;
BEGIN
  SELECT game, b INTO v_l, v_m FROM harness.p7 WHERE k = 'ground';
  -- A DARK CLUSTER: lightning_enabled false, as every production Cluster is,
  -- at eighteen (three horses). The pass must not so much as look at it.
  v_d := public.fx9_cluster('P7 DARK', 6, 40, false);
  PERFORM public.fx9_seat(v_d, 15, 1, false);
  PERFORM public.fx9_seat(v_d, 3, 16, true);
  IF harness.live(v_d) <> 18 THEN RAISE EXCEPTION 'FIXTURE: DARK is at %, so leaving it alone would prove nothing', harness.live(v_d); END IF;
  INSERT INTO harness.p7 (k, game) VALUES ('dark', v_d);
  v1 := public.fn_cash_clusters_tick_all('{}'::jsonb);
  SELECT x INTO a1 FROM jsonb_array_elements(v1 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_l;
  SELECT x INTO m1 FROM jsonb_array_elements(v1 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_m;
  IF a1 ->> 'action' <> 'begin_pending_off' OR m1 ->> 'action' <> 'begin_pending_on'
     OR harness.mode(v_l) <> 'pending_off' OR harness.mode(v_m) <> 'pending_on'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v1 -> 'lightning_driven') x WHERE x ? 'error') THEN
    RAISE EXCEPTION 'FAIL 12: the first pass did not open both conversions: % / %', a1, m1;
  END IF;
  v2 := public.fn_cash_clusters_tick_all('{}'::jsonb);
  SELECT x INTO a2 FROM jsonb_array_elements(v2 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_l;
  SELECT x INTO m2 FROM jsonb_array_elements(v2 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_m;
  SELECT x -> 'result' INTO v_tick FROM jsonb_array_elements(v2 -> 'results') x WHERE (x ->> 'game_id')::uuid = v_l;
  IF a2 ->> 'action' <> 'commit_must_move' OR m2 ->> 'action' <> 'commit_lightning'
     OR harness.mode(v_l) <> 'must_move' OR harness.mode(v_m) <> 'lightning'
     OR v_tick IS NULL OR (v_tick ->> 'ok')::boolean IS DISTINCT FROM true OR v_tick ->> 'reason' IS NOT DISTINCT FROM 'lightning_cluster_stands_down'
     OR (SELECT count(*) FROM public.lightning_pool_slot WHERE cluster_id = v_m AND closed_at IS NULL) <> 18
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v2 -> 'lightning_driven') x WHERE x ? 'error') THEN
    RAISE EXCEPTION 'FAIL 12: the second pass did not commit both, tick the reverted one and slot the converted one: % / % / %', a2, m2, v_tick;
  END IF;
  v3 := public.fn_cash_clusters_tick_all('{}'::jsonb);
  IF (SELECT x ->> 'action' FROM jsonb_array_elements(v3 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_l) <> 'hold'
     OR (SELECT x ->> 'action' FROM jsonb_array_elements(v3 -> 'lightning_driven') x WHERE (x ->> 'cluster_id')::uuid = v_m) <> 'hold'
     OR (SELECT count(*) FROM jsonb_array_elements(v3 -> 'lightning_driven') x WHERE x ->> 'action' NOT IN ('hold', 'mode_not_driven')) <> 0 THEN
    RAISE EXCEPTION 'FAIL 12: the third pass did not hold every Cluster still: %', v3 -> 'lightning_driven';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements((v1 -> 'lightning_driven') || (v2 -> 'lightning_driven') || (v3 -> 'lightning_driven')) x
              WHERE (x ->> 'cluster_id')::uuid = v_d)
     OR harness.mode(v_d) <> 'must_move' OR harness.epoch(v_d) <> 0
     OR EXISTS (SELECT 1 FROM public.cash_cluster_conversion WHERE cluster_id = v_d)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_d)
     OR EXISTS (SELECT 1 FROM public.tables WHERE cluster_id = v_d AND dealing_halted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 12: a Cluster with Lightning disabled at eighteen was driven, converted or halted';
  END IF;
END $$;
\echo '  ok  12 THE TICK  the ground''s two Clusters, which three passes left alone before the file: the first pass opens PENDING_OFF on the one at 11 and PENDING_ON on the one at 18, the second commits both, ticks the reverted one in the same pass without standing down and slots all eighteen of the converted one, and the third holds every Cluster in the estate; a Cluster with Lightning disabled at eighteen is never driven, converted or halted'

-- 13 THE CLIENT IS TOLD WHERE ITS PLAYER SITS -----------------------------------------------
DO $$
DECLARE v_l uuid; v_m uuid; v_p uuid; v_q uuid; v jsonb; v_seat record; v_ps uuid; v_state text; v_gone uuid;
BEGIN
  SELECT game, b INTO v_l, v_m FROM harness.p7 WHERE k = 'ground';
  SELECT ts.user_id, ts.table_id, ts.seat_number INTO v_seat
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_l AND ts.left_at IS NULL AND ts.horse_id IS NULL ORDER BY ts.joined_at LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_seat.user_id::text, true);
  SET LOCAL ROLE authenticated;
  v := public.fn_lightning_my_session(v_l);
  RESET ROLE;
  IF v IS DISTINCT FROM jsonb_build_object('pool_session_id', NULL, 'cluster_mode', 'must_move',
                                           'seat_table_id', v_seat.table_id, 'seat_number', v_seat.seat_number) THEN
    RAISE EXCEPTION 'FAIL 13: a seated must-move player was not told exactly where they sit: %', v;
  END IF;
  SELECT ps.player_id, ps.id INTO v_q, v_ps FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_m AND ps.exited_at IS NULL ORDER BY ps.player_id LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_q::text, true);
  SET LOCAL ROLE authenticated;
  v := public.fn_lightning_my_session(v_m);
  RESET ROLE;
  IF (v ->> 'pool_session_id')::uuid IS DISTINCT FROM v_ps OR v ->> 'cluster_mode' <> 'lightning'
     OR (v ->> 'seat_table_id') IS NULL OR v ->> 'seat_table_id' IS DISTINCT FROM v ->> 'anchor_table_id'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k)
        IS DISTINCT FROM ARRAY['anchor_table_id', 'cluster_mode', 'in_hand', 'occupancy_id', 'pool_session_id', 'seat_number', 'seat_table_id', 'stack', 'state'] THEN
    RAISE EXCEPTION 'FAIL 13: a pooled player did not keep every key and gain seat_table_id: %', v;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_seat.user_id::text, true);
  IF public.fn_lightning_my_session(v_m) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 13: a player was told of a seat in a Cluster they are not in';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF public.fn_lightning_my_session(v_l) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 13: a stranger was told of a seat';
  END IF;
  SELECT ts.user_id INTO v_gone FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_l AND ts.left_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats t2 WHERE t2.user_id = ts.user_id AND t2.left_at IS NULL) LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_gone::text, true);
  IF v_gone IS NULL OR public.fn_lightning_my_session(v_l) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 13: a player who left was told of a seat';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.fn_lightning_my_session(v_l) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 13: a caller with no identity was told of a seat';
  END IF;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.fn_lightning_my_session(v_l);
    v_state := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := 'refused';
  END;
  RESET ROLE;
  IF v_state <> 'refused' THEN RAISE EXCEPTION 'FAIL 13: anon could ask'; END IF;
END $$;
\echo '  ok  13 MY SESSION  a seated must-move player with no pool session gets exactly {pool_session_id: null, cluster_mode, seat_table_id, seat_number}; a pooled player keeps every key and gains seat_table_id equal to the anchor table; a stranger, a player of another Cluster, one who left and a caller with no identity get only a null session; anon cannot ask'

-- 14 ONLY THE SERVICE ROLE MAY DRIVE ------------------------------------------------------
DO $$
DECLARE f text; r text; v_state text; v_bad text := '';
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)', 'public.fn_cash_cluster_abort_pending_off(uuid,uuid,text)',
                           'public.fn_cash_cluster_commit_must_move(uuid,uuid)', 'public.fn_cash_cluster_lightning_drive(uuid)',
                           'public.fn_cash_cluster_reap_stuck_conversions(interval,timestamp with time zone,integer)',
                           'public.fn_cash_clusters_tick_all(jsonb)'] LOOP
    IF NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('public', f::regprocedure, 'EXECUTE') THEN
      v_bad := v_bad || f || ' ';
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.fn_cash_cluster_commit_must_move(gen_random_uuid(), gen_random_uuid());
      v_state := 'no error';
    EXCEPTION WHEN insufficient_privilege THEN
      v_state := 'refused';
    END;
    RESET ROLE;
    IF v_state <> 'refused' THEN v_bad := v_bad || r || ' called the commit '; END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 14: %', v_bad; END IF;
END $$;
\echo '  ok  14 THE GRANTS  the four new functions, the reaper and the tick pass are executable by service_role and by no anon, authenticated or public caller, and an attempt as either is refused'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 15 EVERY @live-proof OF THE FILE HOLDS -------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp7 WHERE phase = 'own') <> 6
     OR EXISTS (SELECT 1 FROM harness.lp7 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 15: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp7 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  15 THE LIVE PROOFS  all six @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['cash_cluster_conversion', 'cash_cluster_events', 'lightning_pool_session', 'lightning_pool_slot', 'lightning_instance', 'cash_cluster_epoch']) x(t)
UNION ALL
SELECT 'modes', md5(string_agg(id::text || ':' || cluster_mode || ':' || cluster_epoch, '|' ORDER BY id)) FROM public.cash_games
UNION ALL
SELECT 'stacks', md5(string_agg(id::text || ':' || coalesce(stack::text, ''), '|' ORDER BY id)) FROM public.table_seats;
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 16 RE-APPLIABLE -----------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(a.what, ', ') INTO v_bad
    FROM harness.rcap a
    FULL JOIN (
      SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
      UNION ALL
      SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
        FROM unnest(ARRAY['cash_cluster_conversion', 'cash_cluster_events', 'lightning_pool_session', 'lightning_pool_slot', 'lightning_instance', 'cash_cluster_epoch']) x(t)
      UNION ALL
      SELECT 'modes', md5(string_agg(id::text || ':' || cluster_mode || ':' || cluster_epoch, '|' ORDER BY id)) FROM public.cash_games
      UNION ALL
      SELECT 'stacks', md5(string_agg(id::text || ':' || coalesce(stack::text, ''), '|' ORDER BY id)) FROM public.table_seats
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 16: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 16: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  16 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, acl and comment, six row counts, every Cluster mode and epoch and every seat stack exactly as they were'
ASSERT

{ predecessor_proofs before; } > "$fixture/proofs-before.sql"
{ predecessor_proofs after; } > "$fixture/proofs-after.sql"
{ gen_proofs own mine "$mine"; } > "$fixture/own-proofs-eval.sql"

# ===========================================================================
# THE RUN.
# ===========================================================================
set +e
"${PSQL[@]}" \
  -f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture" \
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r" \
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture" \
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" -f "$p6" -f "$s6_fixture" -f "$s6" -f "$s6r" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# SEVENTEEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 17 ]; then
  echo "FAIL: $oks of the 17 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 7 (spec Phase 10), 18 sections: before the file three real tick passes neither revert a Lightning Cluster at 11 nor convert a must-move Cluster at 18; after it no earlier proof is falsified; six-max 17 holds, 18 converts, 17/16/13 hold, 12 drains and reverts, 11 holds and the climb back to 17 converts nothing; nine-max 26 holds, 27 converts, 26/19 hold, 18 reverts, 17 holds; the reversion writes no seat, cash session or blind ledger row (an xmin census of every table) and keeps every stack, baseline, stay clock, rejoin window and join time of humans and horses; Lightning halts and their acknowledgements lift and the tick plans must-move moves again; on four partly filled tables the tick plans the feeder oldest first onto the shortest Main and breaks it without writing a seat; no exited pool session sees a Lightning hand; a dealt hand settles in PENDING_OFF before the revert while an undealt one is void; a population back above OFF cancels the drain; two backends open one PENDING_OFF and revert once; Lightning switched off drains and never strands; a stuck PENDING_OFF is reaped with its hand void; two full cycles with live engines keep every anchor and stack; the tick pass drives both directions and never touches a Cluster with Lightning disabled; my_session names the seat of a player with no pool session; service_role alone may call; every @live-proof holds and the file is re-appliable"
