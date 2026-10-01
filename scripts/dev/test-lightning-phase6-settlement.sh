#!/usr/bin/env bash
# Lightning Phase 6, the database half of dealing: the hand is numbered, a
# fold frees a player at once, and the hand settles onto its anchor seats
# through the physical settlement path.
#
# Proves 20261001154813 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55553 (LIGHTNING_P6S_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The Lightning fixtures and every Lightning
# migration from 20260920235343 through the matcher (20260926080332) in
# order, with the Phase 9, remediation-two and matcher writers between them;
# then lightning-phase6-settlement-fixture.sql, which carries the physical
# settlement path as production's own bodies (the lease-fenced door
# fn_ca_commit_hand_settlement, its exact-generation fence, the accepted-hand
# core, the delta-mode stack core, the hand insert, the provenance receipt,
# and fn_ca_process_hand_post_commit_obligations); then the migration under
# test, twice. Every Cluster is converted by the REAL conversion, every pool
# slot comes from the real slot sync, every hand is formed by the real barrier
# and dealt by the real begin_dealing, and every chip a settlement moves is
# written by the real physical stack core through the migration's adapter.
# Anchors sit at the Cluster's front table AND at a feeder, so the adapter is
# exercised where it matters.
#
# LAW 10.5. Every Cluster seats horses through table_seats.horse_id beside
# humans; the fast folder dealt into a second hand is a horse; horses are
# settled, counted and paid promo playthrough exactly as humans are. The
# migration reads neither is_horse nor horse_id.
#
# LIGHTNING_P6S_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P6S_PORT:-55553}
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
mine=${LIGHTNING_P6S_MIGRATION:-$M/20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p6s-test.XXXXXX")
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
    printf '%s\n' "INSERT INTO harness.lp6 VALUES ('$phase', '$src', $n, $lineno, public.fxr_eval(\$lpq\$${expr}\$lpq\$));"
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
  gen_proofs "$phase" p6 "$p6"
}

# ===========================================================================
# THE GROUND: section 00, against the matcher's code, before the file.
# ===========================================================================
cat > "$fixture/ground.sql" <<'ASSERT'
CREATE TABLE harness.s6 (k text PRIMARY KEY, game uuid, a uuid, b uuid, n numeric, t text, j jsonb);
CREATE TABLE harness.lp6 (phase text, src text, n integer, lineno integer, ok boolean);

-- A CONVERTED CLUSTER WITH ANCHORS AT TWO TABLES: seven humans and three
-- horses at its front table (main 1), six humans and two horses at a feeder
-- (eighteen, the 6-max ON threshold), every stack different, a live engine
-- lease on the front table. Built only through
-- the Phase 9 and remediation-two writers and the REAL conversion and slot
-- sync.
CREATE FUNCTION harness.cluster(p_key text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; v_feeder uuid; i integer;
BEGIN
  v_g := public.fx9_cluster('P6S ' || p_key, 6, 40, true);
  PERFORM public.fx9_seat(v_g, 7, 1, false);
  PERFORM public.fx9_seat(v_g, 3, 8, true);
  v_feeder := public.fx9_table(v_g, p_key || ' feeder', 'feeder', NULL, 40);
  FOR i IN 1 .. 8 LOOP
    PERFORM public.fxr_join(v_g, v_feeder, i, 200.00 + 10 * i, i > 6);
  END LOOP;
  PERFORM public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  INSERT INTO harness.s6 (k, game, a) VALUES ('feeder:' || v_g, v_g, v_feeder);
  RETURN v_g;
END $f$;
-- The open pool players of a Cluster at one table, horses or humans.
CREATE FUNCTION harness.at(p_game uuid, p_front boolean, p_horse boolean) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT coalesce(array_agg(ps.player_id ORDER BY ps.player_id), ARRAY[]::uuid[])
    FROM public.lightning_pool_session ps
    JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL
     AND (ts.table_id = public.fn_cash_cluster_front_table(p_game)) = p_front
     AND (ts.horse_id IS NOT NULL) = p_horse;
$f$;
CREATE FUNCTION harness.form(p_game uuid, p_players uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := public.fn_lightning_form_hand(p_game, p_players,
         p_target_size => cardinality(p_players)::smallint, p_max_size => cardinality(p_players)::smallint,
         p_matcher_version => 'p6s-matcher', p_request_id => gen_random_uuid());
  IF (v ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the barrier did not form % players: %', cardinality(p_players), v;
  END IF;
  RETURN v;
END $f$;
-- The real begin_dealing, then the bind with the next number of the allocator.
CREATE FUNCTION harness.deal(p_instance uuid, p_bind boolean DEFAULT true) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v jsonb; n bigint;
BEGIN
  v := public.fn_lightning_instance_begin_dealing(p_instance);
  IF (v ->> 'dealing')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: begin_dealing refused %: %', p_instance, v;
  END IF;
  IF NOT p_bind THEN RETURN NULL; END IF;
  n := nextval('harness.hand_numbers');
  EXECUTE 'SELECT public.fn_lightning_bind_hand_number($1, $2)' INTO v USING p_instance, n;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: bind refused %: %', p_instance, v;
  END IF;
  RETURN n;
END $f$;
CREATE FUNCTION harness.anchor_stack(p_game uuid, p_player uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT ts.stack FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = p_game AND ps.player_id = p_player AND ps.exited_at IS NULL;
$f$;
-- p_results for a hand from a spec {player: {d: delta, c: contributed, f: fold, s: showed}}:
-- stack_after = stack_before + d, every participant named.
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
                               p_row jsonb DEFAULT '{}'::jsonb, p_generation uuid DEFAULT NULL,
                               p_host uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_host uuid; v_l record; v jsonb;
BEGIN
  SELECT lh.host_table_id INTO v_host FROM public.lightning_hand lh WHERE lh.hand_id = p_hand;
  SELECT l.instance_id, l.lease_generation INTO v_l FROM public.engine_table_leases l WHERE l.table_id = v_host;
  EXECUTE 'SELECT public.fn_lightning_settle_hand($1, $2, $3, $4, $5, $6, $7, $8, $9)' INTO v
    USING p_hand, p_request, coalesce(p_host, v_host), coalesce(v_l.instance_id, 'fxr-engine'),
          coalesce(p_generation, v_l.lease_generation, gen_random_uuid()), p_results, p_rake, p_bbj, p_row;
  RETURN v;
END $f$;

-- 00 THE CATCHERS CATCH, AND THE DEFECT THE FILE CLOSES IS REAL ---------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_hand uuid; v_inst uuid; v_p uuid; v_seat uuid; v_said text;
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero'
     OR public.fx6_after('SELECT 1/0', 'SELECT 1') !~ '^ERROR 22012' THEN
    RAISE EXCEPTION 'FAIL 00: the catchers do not catch';
  END IF;
  IF to_regprocedure('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)') IS NOT NULL
     OR to_regclass('public.lightning_settlement_marker') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_hand'::regclass AND attname = 'hand_number') THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  -- THE FORGEABLE SETTING. Before the file, any session that names a dealing
  -- hand in ca.lightning_settlement_hand moves its participants' anchor chips.
  v_g := harness.cluster('GROUND');
  v_r := harness.form(v_g, (public.fx9_candidates(v_g, 3)));
  v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  PERFORM harness.deal(v_inst, false);
  SELECT hp.player_id INTO v_p FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand ORDER BY hp.seat LIMIT 1;
  v_seat := public.fxr_anchor(v_g, v_p);
  v_said := public.fx6_after(
    format('SELECT set_config(%L, %L, true); UPDATE public.table_seats SET stack = stack + 1000 WHERE id = %L',
           'ca.lightning_settlement_hand', v_hand, v_seat),
    format('SELECT stack::text FROM public.table_seats WHERE id = %L', v_seat));
  IF v_said IS DISTINCT FROM ((SELECT stack FROM public.table_seats WHERE id = v_seat) + 1000)::text THEN
    RAISE EXCEPTION 'FAIL 00: the forged setting did not move the chips before the file, so its closure would prove nothing: %', v_said;
  END IF;
  IF public.fx6_after(format('UPDATE public.table_seats SET stack = stack + 1000 WHERE id = %L', v_seat), 'SELECT 1')
     !~ '^ERROR PLT01' THEN
    RAISE EXCEPTION 'FAIL 00: the guard does not hold the anchor without the setting';
  END IF;
  INSERT INTO harness.s6 (k, game, a, b) VALUES ('ground', v_g, v_inst, v_hand);
END $$;
\echo '  ok  00 THE GROUND  the catchers catch, nothing of the file exists, and before it any session that names a dealing hand in ca.lightning_settlement_hand moves +1000 onto a participant''s anchor while the same write without it is refused PLT01'
ASSERT

pred_n=0
for f in "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6"; do
  pred_n=$((pred_n + $(grep -c -- '^-- @live-proof: ' "$f")))
done
{ printf '%s\n' "INSERT INTO harness.s6 (k, n) VALUES ('pred_n', $pred_n);"; predecessor_proofs before; } > "$fixture/proofs-before.sql"
{ predecessor_proofs after; } > "$fixture/proofs-after.sql"

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 01 NOTHING BEFORE IT IS FALSIFIED BUT THE SUPERSEDED -------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(b.src || '#' || b.n || ' ' || coalesce(b.ok::text, 'error') || '->' || coalesce(a.ok::text, 'error'), ', ' ORDER BY b.src, b.n)
    INTO v_bad
    FROM harness.lp6 b JOIN harness.lp6 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND a.ok IS DISTINCT FROM b.ok;
  IF v_bad IS DISTINCT FROM 'p9#28 true->false, p9#30 true->false, p9r#31 true->false, p9r#32 true->false, r2c#9 true->false' THEN
    RAISE EXCEPTION 'FAIL 01: the predecessor proofs the file changed are [%], not exactly the superseded p9#28, p9#30, p9r#31, p9r#32 (no fn_lightning_ definer or browser grant) and r2c#9 (the guard reads ca.lightning_settlement_hand)', v_bad;
  END IF;
  -- THE FAMILY RULE'S INTENT, AS CONTAINMENT: service_role executes every
  -- fn_lightning_ function; the only browser grant is the caller's own
  -- session reader, to authenticated and never anon; exactly five are
  -- definers; every one pins its search_path.
  IF (SELECT bool_and((has_function_privilege('service_role', p.oid, 'EXECUTE') OR p.prorettype = 'trigger'::regtype)
                      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                      AND array_to_string(p.proconfig, ',') ~ 'search_path')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_') IS DISTINCT FROM true
     OR (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
        IS DISTINCT FROM ARRAY['fn_lightning_my_session']
     OR (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_' AND p.prosecdef)
        IS DISTINCT FROM ARRAY['fn_lightning_bind_hand_number', 'fn_lightning_my_session', 'fn_lightning_settle_hand',
                               'fn_lightning_settlement_freeze', 'fn_lightning_settlement_seats'] THEN
    RAISE EXCEPTION 'FAIL 01: the Lightning family rule does not hold as containment';
  END IF;
  IF (SELECT count(*) FROM harness.lp6 WHERE phase = 'before') IS DISTINCT FROM (SELECT n FROM harness.s6 x6 WHERE x6.k = 'pred_n')
     OR (SELECT count(*) FROM harness.lp6 WHERE phase = 'after') IS DISTINCT FROM (SELECT n FROM harness.s6 x6 WHERE x6.k = 'pred_n') THEN
    RAISE EXCEPTION 'FAIL 01: the predecessor proofs were not all read';
  END IF;
  -- THE SUPERSEDED PROOF'S INTENT, AS CONTAINMENT: the guard is still the
  -- SECURITY DEFINER PLT01 guard on the anchor, still asks for the open pool
  -- session first, and no longer reads any setting at all.
  IF NOT (SELECT p.prosecdef AND s ~ 'LIGHTNING_HAND_IN_PROGRESS' AND s ~ 'ERRCODE = ''PLT01'''
                 AND s ~ 'ps\.anchor_seat_id = OLD\.id AND ps\.exited_at IS NULL'
                 AND position('ps.anchor_seat_id = OLD.id' in s) < position('fn_lightning_player_live_hand' in s)
                 AND s !~ 'current_setting'
            FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q
           WHERE p.oid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 01: the guard is not the marker guard the superseded proof is replaced by';
  END IF;
END $$;
SELECT count(*) AS proof_count FROM harness.lp6 WHERE phase = 'before' \gset
\echo '  ok  01 NOTHING BEFORE IT IS FALSIFIED BUT THE SUPERSEDED  of the' :proof_count '@live-proof expressions of the seventeen Lightning files before it, every one evaluates exactly as before except r2c#9, which named the forgeable setting, and p9#28, p9#30, p9r#31 and p9r#32, which forbade any fn_lightning_ definer or browser grant; their intent holds as containment: the SECURITY DEFINER PLT01 guard asks for the open pool session first and reads no setting, service_role executes every fn_lightning_ function, the one browser grant is fn_lightning_my_session to authenticated, exactly five are definers and all pin search_path'

-- 02 THE NUMBER ------------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_inst uuid; v_hand uuid; v_inst2 uuid; n bigint; v jsonb; v_front uuid;
BEGIN
  v_g := harness.cluster('BIND');
  v_front := public.fn_cash_cluster_front_table(v_g);
  v_r := harness.form(v_g, public.fx9_candidates(v_g, 3));
  v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  n := nextval('harness.hand_numbers');
  v := public.fn_lightning_bind_hand_number(v_inst, n);
  IF v ->> 'reason' IS DISTINCT FROM 'instance_not_dealing' THEN
    RAISE EXCEPTION 'FAIL 02: a reserved (not yet dealing) instance was bound: %', v;
  END IF;
  PERFORM harness.deal(v_inst, false);
  v := public.fn_lightning_bind_hand_number(v_inst, n);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'hand_number')::bigint IS DISTINCT FROM n
     OR (v ->> 'hand_id')::uuid IS DISTINCT FROM v_hand OR (v ->> 'host_table_id')::uuid IS DISTINCT FROM v_front
     OR (SELECT hand_number FROM public.lightning_hand WHERE hand_id = v_hand) IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'FAIL 02: the bind did not answer and record the number and the front table: %', v;
  END IF;
  v := public.fn_lightning_bind_hand_number(v_inst, n);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'replay')::boolean IS DISTINCT FROM true
     OR (v ->> 'host_table_id')::uuid IS DISTINCT FROM v_front THEN
    RAISE EXCEPTION 'FAIL 02: the same number again is not the same receipt: %', v;
  END IF;
  v := public.fn_lightning_bind_hand_number(v_inst, n + 1000);
  IF v ->> 'reason' IS DISTINCT FROM 'hand_number_already_bound' THEN
    RAISE EXCEPTION 'FAIL 02: a different number was accepted: %', v;
  END IF;
  IF public.fxr_try(format('UPDATE public.lightning_hand SET hand_number = %s WHERE hand_id = %L', n + 1000, v_hand))
     !~ 'LIGHTNING_HAND_NUMBER_IS_WRITE_ONCE' THEN
    RAISE EXCEPTION 'FAIL 02: the immutability trigger lets the number be rewritten';
  END IF;
  -- A second dealing hand: a number taken by a hand, by a physical hand,
  -- and out of range, are refused; and a number is never shared.
  v_r := harness.form(v_g, public.fx9_candidates(v_g, 3));
  v_inst2 := (v_r ->> 'instance_id')::uuid;
  PERFORM harness.deal(v_inst2, false);
  IF public.fn_lightning_bind_hand_number(v_inst2, n) ->> 'reason' IS DISTINCT FROM 'hand_number_taken' THEN
    RAISE EXCEPTION 'FAIL 02: a number bound to another hand was accepted';
  END IF;
  INSERT INTO public.hand_history (table_id, hand_number) VALUES (v_front, 5999999);
  IF public.fn_lightning_bind_hand_number(v_inst2, 5999999) ->> 'reason' IS DISTINCT FROM 'hand_number_taken'
     OR public.fn_lightning_bind_hand_number(v_inst2, 999999) ->> 'reason' IS DISTINCT FROM 'hand_number_out_of_range'
     OR public.fn_lightning_bind_hand_number(v_inst2, 2147483648) ->> 'reason' IS DISTINCT FROM 'hand_number_out_of_range'
     OR public.fn_lightning_bind_hand_number(gen_random_uuid(), n) ->> 'reason' IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'FAIL 02: a physical number, an out-of-range number or an unknown instance was not refused';
  END IF;
  DELETE FROM public.hand_history WHERE hand_number = 5999999;
  IF (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'hand_number_bound') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 02: hand_number_bound was not emitted exactly once';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'p6s: bind section done');
  PERFORM public.fn_lightning_instance_abandon(v_inst2, 'p6s: bind section done');
END $$;
\echo '  ok  02 THE NUMBER  a reserved instance is refused; a dealing one binds the allocator''s number and the Cluster''s front table, once (the same number replays, another is refused, the trigger refuses a rewrite); a number another hand or a physical hand holds, 999999, 2147483648 and an unknown instance are refused; hand_number_bound is emitted once'

-- 03 THE SETTLEMENT, WITH EXACT DELTAS, AT TWO TABLES ---------------------------
DO $$
DECLARE v_g uuid; v_front uuid; v_feeder uuid; v_players uuid[]; v_r jsonb; v_inst uuid; v_hand uuid; n bigint;
        v_spec jsonb := '{}'::jsonb; v_res jsonb; v_req uuid := gen_random_uuid(); v_before jsonb; v_hh uuid;
        d numeric[] := ARRAY[12.25, -5.00, -4.00, -3.25, -2.00, 0.00]; c numeric[] := ARRAY[6.00, 5.00, 4.00, 3.25, 2.00, 0.00];
        k integer := 0; p uuid; v_ac record; v_bad text;
BEGIN
  v_g := harness.cluster('SETTLE');
  v_front := public.fn_cash_cluster_front_table(v_g);
  SELECT a INTO v_feeder FROM harness.s6 x6 WHERE x6.k = 'feeder:' || v_g;
  -- Two humans and a horse from each table.
  v_players := (harness.at(v_g, true, false))[1:2] || (harness.at(v_g, true, true))[1:1]
            || (harness.at(v_g, false, false))[1:2] || (harness.at(v_g, false, true))[1:1];
  v_r := harness.form(v_g, v_players);
  v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  n := harness.deal(v_inst);
  FOR p IN SELECT hp.player_id FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand ORDER BY hp.seat LOOP
    k := k + 1;
    v_spec := v_spec || jsonb_build_object(p::text, jsonb_build_object('d', d[k], 'c', c[k],
                'f', CASE k WHEN 5 THEN 'normal' WHEN 6 THEN 'fast' ELSE 'none' END, 's', k <= 2));
  END LOOP;
  SELECT jsonb_object_agg(x, harness.anchor_stack(v_g, x)) INTO v_before FROM unnest(v_players) x;
  IF (SELECT count(DISTINCT ts.table_id) FROM public.lightning_hand_player hp
        JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
        JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
        JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id WHERE hp.hand_id = v_hand) IS DISTINCT FROM 2::bigint
     OR (SELECT count(*) FROM public.lightning_hand_player hp JOIN public.table_seats ts ON ts.user_id = hp.player_id
          WHERE hp.hand_id = v_hand AND ts.horse_id IS NOT NULL AND ts.left_at IS NULL) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL 03: the hand does not hold anchors at two tables with a horse at each, so the proof is narrower than it claims';
  END IF;
  v_res := harness.settle(v_hand, v_req, harness.results(v_hand, v_spec), 1.50, 0.50,
                          jsonb_build_object('pot_size', 20.25, 'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                                             'actions', '[]'::jsonb, 'game_variant', 'nlh'));
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true OR (v_res ->> 'hand_number')::bigint IS DISTINCT FROM n
     OR (v_res ->> 'hand_id')::uuid IS DISTINCT FROM v_hand OR v_res ->> 'receipt_hash' !~ '^[0-9a-f]{64}$'
     OR (v_res ->> 'hand_history_id') IS NULL THEN
    RAISE EXCEPTION 'FAIL 03: the settlement did not answer its receipt: %', v_res;
  END IF;
  v_hh := (v_res ->> 'hand_history_id')::uuid;
  -- EXACT DELTAS, onto each anchor, at whichever table it sits.
  SELECT string_agg(hp.player_id::text, ', ') INTO v_bad
    FROM public.lightning_hand_player hp
   WHERE hp.hand_id = v_hand
     AND (harness.anchor_stack(v_g, hp.player_id)
            IS DISTINCT FROM (v_before ->> hp.player_id::text)::numeric + (v_spec -> hp.player_id::text ->> 'd')::numeric
          OR (v_res -> 'deltas' ->> hp.player_id::text)::numeric IS DISTINCT FROM (v_spec -> hp.player_id::text ->> 'd')::numeric
          OR hp.stack_after IS DISTINCT FROM hp.stack_before + (v_spec -> hp.player_id::text ->> 'd')::numeric
          OR hp.net_result IS DISTINCT FROM (v_spec -> hp.player_id::text ->> 'd')::numeric
          OR hp.fold_type IS DISTINCT FROM (v_spec -> hp.player_id::text ->> 'f')
          OR (hp.folded_at IS NULL) IS DISTINCT FROM (hp.fold_type = 'none'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: these anchors or participant rows did not settle to the exact delta: %', v_bad;
  END IF;
  IF (SELECT sum(ts.stack) FROM unnest(v_players) x JOIN public.lightning_pool_session ps ON ps.player_id = x AND ps.cluster_id = v_g AND ps.exited_at IS NULL
        JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id)
     IS DISTINCT FROM (SELECT sum(value::numeric) FROM jsonb_each_text(v_before)) - 2.00 THEN
    RAISE EXCEPTION 'FAIL 03: the felt did not lose exactly the rake and the drop';
  END IF;
  -- THE LIGHTNING RECORD.
  IF (SELECT state FROM public.lightning_instance WHERE id = v_inst) IS DISTINCT FROM 'complete'
     OR EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.lightning_instance_id = v_inst AND r.state <> 'released')
     OR (SELECT settled_at IS NULL OR hand_history_id IS DISTINCT FROM v_hh OR settle_request_id IS DISTINCT FROM v_req
                OR settle_receipt ->> 'receipt_hash' IS DISTINCT FROM v_res ->> 'receipt_hash'
           FROM public.lightning_hand WHERE hand_id = v_hand)
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'hand_settled' AND request_id = v_req
           AND (payload ->> 'hand_id')::uuid = v_hand) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'instance_completed'
           AND (payload ->> 'instance_id')::uuid = v_inst) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 03: the instance, its reservations, the hand''s receipt or the events are wrong';
  END IF;
  SELECT string_agg(ps.player_id::text, ', ') INTO v_bad
    FROM public.lightning_pool_session ps
    JOIN public.lightning_pool_slot sl ON sl.pool_session_id = ps.id AND sl.closed_at IS NULL
   WHERE ps.cluster_id = v_g AND ps.player_id = ANY (v_players)
     AND (ps.hands, ps.net_result, ps.showdowns, ps.fast_folds, ps.normal_folds, ps.fold_and_watch,
          sl.hands, sl.showdowns, sl.fast_folds, sl.normal_folds)
         IS DISTINCT FROM (1, (v_spec -> ps.player_id::text ->> 'd')::numeric(14,2),
                           ((v_spec -> ps.player_id::text ->> 's')::boolean)::integer,
                           (v_spec -> ps.player_id::text ->> 'f' = 'fast')::integer,
                           (v_spec -> ps.player_id::text ->> 'f' = 'normal')::integer, 0,
                           1, ((v_spec -> ps.player_id::text ->> 's')::boolean)::integer,
                           (v_spec -> ps.player_id::text ->> 'f' = 'fast')::integer,
                           (v_spec -> ps.player_id::text ->> 'f' = 'normal')::integer);
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.hands = 1) IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL 03: the pool session or slot counters are wrong for: %', v_bad;
  END IF;
  -- THE PHYSICAL RECORD, at the front table under the bound number.
  IF NOT EXISTS (SELECT 1 FROM public.hand_history h WHERE h.id = v_hh AND h.table_id = v_front AND h.hand_number = n
                    AND h.rake_amount = 1.50 AND h.bbj_amount = 0.50 AND h.pot_size = 20.25 AND h.tournament_id IS NULL
                    AND jsonb_array_length(h.players) = 6 AND h.community_cards = ARRAY['As','Kd','7h','2c','2d'] AND h.ended_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = v_hh AND o.table_id = v_front AND o.hand_number = n)
     OR NOT EXISTS (SELECT 1 FROM public.settlement_idempotency_keys k2 WHERE k2.table_id = v_front AND k2.status = 'succeeded'
                       AND (k2.result ->> 'hand_number')::bigint = n AND k2.result ->> 'mode' = 'delta')
     OR NOT EXISTS (SELECT 1 FROM public.ca_settlements s WHERE s.table_id = v_front AND s.state = 'final'
                       AND (s.totals ->> 'net_deltas')::numeric = -2.00)
     OR EXISTS (SELECT 1 FROM public.lightning_settlement_marker) THEN
    RAISE EXCEPTION 'FAIL 03: the physical record (hand_history, outbox, idempotency key, ca_settlements) is wrong, or a marker survived';
  END IF;
  SELECT * INTO v_ac FROM public.hand_atomic_commits c2 WHERE c2.table_id = v_front AND c2.hand_number = n;
  IF v_ac.hand_id IS DISTINCT FROM v_hh
     OR (v_ac.post_commit_payload -> 'rake' ->> 'amount')::numeric IS DISTINCT FROM 1.50
     OR (v_ac.post_commit_payload -> 'rake' ->> 'bbj')::numeric IS DISTINCT FROM 0.50
     OR (v_ac.post_commit_payload -> 'bbj_contribution' ->> 'amount')::numeric IS DISTINCT FROM 0.50
     OR (v_ac.post_commit_payload -> 'rake' ->> 'num_players')::integer IS DISTINCT FROM 5
     OR jsonb_array_length(v_ac.post_commit_payload -> 'time_banks') IS DISTINCT FROM 6
     OR jsonb_array_length(v_ac.post_commit_payload -> 'promo_playthrough') IS DISTINCT FROM 5
     OR v_ac.post_commit_payload -> 'accepted_hand_facts' -> 'contributions' IS DISTINCT FROM v_ac.post_commit_payload -> 'rake' -> 'contributions'
     OR v_ac.post_commit_payload_hash IS NULL OR v_ac.post_commit_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: hand_atomic_commits does not carry the envelope the post-commit path reads: %', to_jsonb(v_ac);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_hand_provenance_receipts r WHERE r.table_id = v_front AND r.hand_number = n
                    AND r.hand_id = v_hh AND r.rake = 1.50 AND r.bbj = 0.50 AND r.signed_external_net = 0) THEN
    RAISE EXCEPTION 'FAIL 03: no provenance receipt keyed by (front table, hand number)';
  END IF;
  INSERT INTO harness.s6 (k, game, a, b, n, j, t) VALUES ('settled', v_g, v_hand, v_hh, n, v_res, v_req::text);
  INSERT INTO harness.s6 (k, j) VALUES ('settled_spec', v_spec);
  INSERT INTO harness.s6 (k, j) VALUES ('settled_results', harness.results(v_hand, v_spec));
END $$;
\echo '  ok  03 THE SETTLEMENT  a six-player hand with two humans and a horse anchored at the front table and the same at a feeder settles +12.25/-5/-4/-3.25/-2/0 with rake 1.50 and drop 0.50 exactly onto each anchor (the felt loses exactly 2.00); the participants, pool sessions and slots carry stack_after, net_result, folds and showdowns; the instance completes and releases everyone; hand_settled and instance_completed; hand_history, the outbox, the idempotency key, ca_settlements, hand_atomic_commits with its post-commit envelope and the provenance receipt are written at the front table under the bound number; no marker survives'

-- 04 THE POST-COMMIT PATH ACCEPTS THE HAND -------------------------------------
DO $$
DECLARE v_g uuid; v_hh uuid; n bigint; v_front uuid; v jsonb; v_spec jsonb; v_club uuid := 'cb000000-0000-0000-0000-000000000001';
BEGIN
  SELECT game, b, s.n INTO v_g, v_hh, n FROM harness.s6 s WHERE s.k = 'settled';
  SELECT j INTO v_spec FROM harness.s6 x6 WHERE x6.k = 'settled_spec';
  v_front := public.fn_cash_cluster_front_table(v_g);
  v := public.fn_ca_process_hand_post_commit_obligations(v_hh);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'rake')::boolean IS DISTINCT FROM true
     OR (v ->> 'bbj_contribution')::boolean IS DISTINCT FROM true OR (v ->> 'promo_playthrough')::integer IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 04: the post-commit processor did not accept the hand: %', v;
  END IF;
  IF (SELECT count(*) FROM harness.rake_calls r
       WHERE r.table_id = v_front AND r.club_id = v_club AND r.hand_id = v_hh AND r.hand_number = n
         AND r.rake = 1.50 AND r.bbj = 0.50 AND r.pot = 20.25 AND r.num_players = 5 AND r.method = 'WEIGHTED_CONTRIBUTED'
         AND r.tournament_id IS NULL
         AND r.contributions = (SELECT jsonb_object_agg(e.key, (e.value ->> 'c')::numeric) FROM jsonb_each(v_spec) e
                                 WHERE (e.value ->> 'c')::numeric > 0)) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM public.bbj_contributions b WHERE b.hand_id = v_hh AND b.table_id = v_front
           AND b.amount = 0.50 AND b.hand_number = n AND b.club_id = v_club AND b.big_blind = 2.00) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM harness.promo_calls pc JOIN jsonb_each(v_spec) e ON e.key::uuid = pc.user_id
          WHERE pc.club_id = v_club AND pc.wagered = (e.value ->> 'c')::numeric) IS DISTINCT FROM 5::bigint
     OR (SELECT post_commit_completed_at FROM public.hand_atomic_commits WHERE hand_id = v_hh) IS NULL THEN
    RAISE EXCEPTION 'FAIL 04: the rake, the drop or the playthrough did not reach their writers with the host table, the hand and its number';
  END IF;
  -- The horse in the hand is paid its playthrough like everyone else.
  IF NOT EXISTS (SELECT 1 FROM harness.promo_calls pc JOIN public.table_seats ts ON ts.user_id = pc.user_id AND ts.horse_id IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 04: no horse received playthrough, so Law 10.5 is unproved here';
  END IF;
  IF (public.fn_ca_process_hand_post_commit_obligations(v_hh) ->> 'already_completed')::boolean IS DISTINCT FROM true
     OR (SELECT count(*) FROM harness.rake_calls) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 04: a second run of the processor was not a replay';
  END IF;
END $$;
\echo '  ok  04 THE POST-COMMIT PATH  fn_ca_process_hand_post_commit_obligations(hand_history_id) accepts the Lightning hand and passes atomic_distribute_rake the front table, the club, the hand, its number, rake 1.50, drop 0.50, pot 20.25, the five contributors and WEIGHTED_CONTRIBUTED; bbj_record_contribution 0.50 at big blind 2; promo playthrough to all five contributors, a horse among them; a second run is a replay'

-- 05 A RETRY IS THE SAME ANSWER ---------------------------------------------------
DO $$
DECLARE v_g uuid; v_hand uuid; v_hh uuid; n bigint; v_res jsonb; v_req uuid; v jsonb; v_stacks text;
BEGIN
  SELECT game, a, b, s.n, j, t::uuid INTO v_g, v_hand, v_hh, n, v_res, v_req FROM harness.s6 s WHERE s.k = 'settled';
  SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) INTO v_stacks FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;
  v := harness.settle(v_hand, v_req, (SELECT j FROM harness.s6 x6 WHERE x6.k = 'settled_results'), 1.50, 0.50,
                      jsonb_build_object('pot_size', 20.25, 'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                                         'actions', '[]'::jsonb, 'game_variant', 'nlh'));
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'replay')::boolean IS DISTINCT FROM true
     OR v ->> 'receipt_hash' IS DISTINCT FROM v_res ->> 'receipt_hash'
     OR (v ->> 'hand_history_id')::uuid IS DISTINCT FROM v_hh THEN
    RAISE EXCEPTION 'FAIL 05: the same request did not answer the stored receipt: %', v;
  END IF;
  v := harness.settle(v_hand, gen_random_uuid(), (SELECT j FROM harness.s6 x6 WHERE x6.k = 'settled_results'), 1.50, 0.50);
  IF v ->> 'reason' IS DISTINCT FROM 'already_settled' THEN
    RAISE EXCEPTION 'FAIL 05: a different request against a settled hand was not refused: %', v;
  END IF;
  IF (SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) FROM public.table_seats ts
        JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g) IS DISTINCT FROM v_stacks
     OR (SELECT count(*) FROM public.hand_history WHERE hand_number = n) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'hand_settled') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 05: a retry moved a chip or wrote a second record';
  END IF;
END $$;
\echo '  ok  05 A RETRY IS THE SAME ANSWER  the same request answers the stored receipt (same receipt hash and hand history), another request is already_settled, and neither moves a chip or writes a second hand or event'

-- 06 THE REFUSALS MOVE NOTHING -----------------------------------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_inst uuid; v_hand uuid; n bigint; v_inst2 uuid; v_hand2 uuid; v_res jsonb; v_spec jsonb := '{}'::jsonb;
        v_stacks text; v_feeder uuid; p uuid; k integer := 0; v_said text;
BEGIN
  v_g := harness.cluster('REFUSE');
  SELECT a INTO v_feeder FROM harness.s6 x6 WHERE x6.k = 'feeder:' || v_g;
  v_r := harness.form(v_g, (harness.at(v_g, true, true))[1:1] || (harness.at(v_g, false, false))[1:2]);
  v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  n := harness.deal(v_inst);
  FOR p IN SELECT hp.player_id FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand ORDER BY hp.seat LOOP
    k := k + 1;
    v_spec := v_spec || jsonb_build_object(p::text, jsonb_build_object('d', CASE k WHEN 1 THEN 3.00 WHEN 2 THEN -2.00 ELSE -1.50 END,
                                                                       'c', CASE k WHEN 1 THEN 1.50 ELSE 2.00 END));
  END LOOP;
  SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) INTO v_stacks FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;
  -- A stale lease generation, a stale heartbeat, the wrong host, a missing
  -- participant, a malformed result.
  v_res := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0.50, 0, '{}'::jsonb, gen_random_uuid());
  IF v_res ->> 'reason' IS DISTINCT FROM 'hand_lease_lost' THEN
    RAISE EXCEPTION 'FAIL 06: a stale lease generation was not refused: %', v_res;
  END IF;
  v_said := public.fx6_after(
    format('UPDATE public.engine_table_leases SET heartbeat_at = clock_timestamp() - interval ''1 minute'' WHERE table_id = %L',
           public.fn_cash_cluster_front_table(v_g)),
    format('SELECT harness.settle(%L, gen_random_uuid(), harness.results(%L, %L), 0.50, 0) ->> ''reason''', v_hand, v_hand, v_spec));
  IF v_said IS DISTINCT FROM 'hand_lease_stale' THEN
    RAISE EXCEPTION 'FAIL 06: a stale heartbeat was not refused: %', v_said;
  END IF;
  IF harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0.50, 0, '{}'::jsonb, NULL, v_feeder) ->> 'reason'
       IS DISTINCT FROM 'host_table_mismatch'
     OR harness.settle(v_hand, gen_random_uuid(), (SELECT jsonb_agg(x) FROM jsonb_array_elements(harness.results(v_hand, v_spec)) WITH ORDINALITY t(x, o) WHERE o < 3), 0.50, 0) ->> 'reason'
       IS DISTINCT FROM 'results_do_not_name_every_participant'
     OR harness.settle(v_hand, gen_random_uuid(), jsonb_set(harness.results(v_hand, v_spec), '{0,stack_after}', '-1'), 0.50, 0) ->> 'reason'
       IS DISTINCT FROM 'invalid_results'
     OR harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0.505, 0) ->> 'reason'
       IS DISTINCT FROM 'invalid_arguments' THEN
    RAISE EXCEPTION 'FAIL 06: a wrong host, a missing participant, a negative stack or a fractional cent was not refused';
  END IF;
  -- An unbound hand, and an abandoned one.
  v_r := harness.form(v_g, public.fx9_candidates(v_g, 3));
  v_inst2 := (v_r ->> 'instance_id')::uuid; v_hand2 := (v_r ->> 'hand_id')::uuid;
  PERFORM harness.deal(v_inst2, false);
  IF harness.settle(v_hand2, gen_random_uuid(), harness.results(v_hand2, '{}'), 0, 0, '{}'::jsonb, NULL, public.fn_cash_cluster_front_table(v_g)) ->> 'reason'
       IS DISTINCT FROM 'hand_number_not_bound' THEN
    RAISE EXCEPTION 'FAIL 06: an unbound hand was not refused';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst2, 'p6s: the engine voided it');
  IF harness.settle(v_hand2, gen_random_uuid(), harness.results(v_hand2, '{}'), 0, 0, '{}'::jsonb, NULL, public.fn_cash_cluster_front_table(v_g)) ->> 'reason'
       IS DISTINCT FROM 'instance_abandoned' THEN
    RAISE EXCEPTION 'FAIL 06: an abandoned instance was not refused';
  END IF;
  IF (SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) FROM public.table_seats ts
        JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g) IS DISTINCT FROM v_stacks
     OR EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = n)
     OR EXISTS (SELECT 1 FROM public.hand_atomic_commits WHERE hand_number = n)
     OR EXISTS (SELECT 1 FROM public.lightning_settlement_marker)
     OR (SELECT state FROM public.lightning_instance WHERE id = v_inst) IS DISTINCT FROM 'dealing'
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 06: a refusal moved a chip, wrote a record, left a marker, ended the instance or froze the Cluster';
  END IF;
  INSERT INTO harness.s6 (k, game, a, b, n, j) VALUES ('refuse', v_g, v_inst, v_hand, n, v_spec);
END $$;
\echo '  ok  06 THE REFUSALS MOVE NOTHING  a stale lease generation (hand_lease_lost), a stale heartbeat (hand_lease_stale), a feeder named as host, a missing participant, a negative stack, a fractional cent, an unbound hand and an abandoned instance are each refused, and no chip, record, marker, instance state or Cluster mode moved'

-- 07 A CONSERVATION VIOLATION FREEZES THE CLUSTER ---------------------------------
DO $$
DECLARE v_g uuid; v_inst uuid; v_hand uuid; n bigint; v_spec jsonb; v_res jsonb; v_req uuid := gen_random_uuid(); v_stacks text; p text;
BEGIN
  SELECT game, a, b, s.n, j INTO v_g, v_inst, v_hand, n, v_spec FROM harness.s6 s WHERE s.k = 'refuse';
  SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) INTO v_stacks FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g;
  -- Deltas +3, -2, -1.50 with rake 0.50 conserve; a rake of 0.25 does not.
  v_res := harness.settle(v_hand, v_req, harness.results(v_hand, v_spec), 0.25, 0);
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM false OR (v_res ->> 'frozen')::boolean IS DISTINCT FROM true
     OR v_res ->> 'invariant' IS DISTINCT FROM 'conservation' OR (v_res ->> 'retry')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 07: a non-conserving hand was not answered frozen: %', v_res;
  END IF;
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM 'frozen'
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND request_id = v_req
           AND kind IN ('stack_invariant_failed', 'cluster_frozen')) IS DISTINCT FROM 2::bigint
     OR NOT EXISTS (SELECT 1 FROM public.financial_alerts fa WHERE fa.source = 'lightning_settlement' AND fa.severity = 'critical')
     OR (SELECT string_agg(ts.id::text || ':' || ts.stack, ',' ORDER BY ts.id) FROM public.table_seats ts
           JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = v_g) IS DISTINCT FROM v_stacks
     OR EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = n)
     OR (SELECT state FROM public.lightning_instance WHERE id = v_inst) IS DISTINCT FROM 'dealing'
     OR EXISTS (SELECT 1 FROM public.lightning_settlement_marker) THEN
    RAISE EXCEPTION 'FAIL 07: the freeze is not whole, or the violation moved something';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'p6s: settlement froze the Cluster');
END $$;
\echo '  ok  07 A CONSERVATION VIOLATION FREEZES  sum(stack_before) <> sum(stack_after) + rake + bbj answers {ok:false, frozen:true, invariant:conservation}: the Cluster is frozen, stack_invariant_failed and cluster_frozen carry the request, a critical alert is raised, and no chip, hand or marker was written'

-- 08 A FAST FOLDER PLAYS ON; FOLD AND WATCH WAITS ---------------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_a_inst uuid; v_a uuid; v_b_inst uuid; v_b uuid; na bigint; nb bigint;
        p uuid; q uuid; w uuid; x uuid; y uuid; o1 uuid; o2 uuid; s_p numeric; s_q numeric; v jsonb; v_req uuid := gen_random_uuid();
        v_seat uuid; v_folded timestamptz; v_res jsonb; v_spec jsonb;
BEGIN
  v_g := harness.cluster('FOLD');
  p := (harness.at(v_g, false, true))[1];          -- the fast folder: a horse at the feeder
  q := (harness.at(v_g, true, false))[1];          -- a normal folder who does not say what he put in
  w := (harness.at(v_g, false, false))[1];         -- fold and watch
  x := (harness.at(v_g, true, false))[2];
  y := (harness.at(v_g, true, true))[1];
  o1 := (harness.at(v_g, false, false))[2];
  o2 := (harness.at(v_g, true, false))[3];
  s_p := harness.anchor_stack(v_g, p); s_q := harness.anchor_stack(v_g, q);
  v_r := harness.form(v_g, ARRAY[p, q, w, x, y]);
  v_a_inst := (v_r ->> 'instance_id')::uuid; v_a := (v_r ->> 'hand_id')::uuid;
  na := harness.deal(v_a_inst);
  IF public.fx6_reason(v_g, p) IS DISTINCT FROM 'IN_HAND' THEN
    RAISE EXCEPTION 'FAIL 08: a dealt participant is not IN_HAND: %', public.fx6_reason(v_g, p);
  END IF;
  IF public.fn_lightning_fast_fold(v_a, o1, gen_random_uuid(), 'fast') ->> 'reason' IS DISTINCT FROM 'not_a_participant'
     OR public.fn_lightning_fast_fold(v_a, p, gen_random_uuid(), 'muck') ->> 'reason' IS DISTINCT FROM 'invalid_fold_type'
     OR public.fn_lightning_fast_fold(v_a, p, gen_random_uuid(), 'fast', 100000) ->> 'reason' IS DISTINCT FROM 'committed_exceeds_stack_before' THEN
    RAISE EXCEPTION 'FAIL 08: a stranger, an unknown fold type or a commitment above the stack was not refused';
  END IF;
  -- THE FAST FOLD: recorded, the reservation released, the player legal now.
  v := public.fn_lightning_fast_fold(v_a, p, v_req, 'fast', 3.00);
  SELECT folded_at INTO v_folded FROM public.lightning_hand_player WHERE hand_id = v_a AND player_id = p;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'released')::boolean IS DISTINCT FROM true
     OR (SELECT (fold_type, committed_at_fold) FROM public.lightning_hand_player WHERE hand_id = v_a AND player_id = p)
        IS DISTINCT FROM ('fast'::text, 3.00::numeric(14,2))
     OR (SELECT r.state || ':' || r.reason FROM public.lightning_reservation r WHERE r.lightning_instance_id = v_a_inst AND r.player_id = p)
        IS DISTINCT FROM 'released:fast_fold'
     OR (SELECT count(*) FROM public.lightning_reservation r WHERE r.lightning_instance_id = v_a_inst AND r.state = 'committed') IS DISTINCT FROM 4::bigint
     OR (SELECT sl.idle_since FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_g AND sl.player_id = p AND sl.closed_at IS NULL) < v_folded
     OR public.fx6_reason(v_g, p) IS DISTINCT FROM 'LEGAL'
     OR public.fn_lightning_player_in_hand(p, v_g)
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind = 'fast_fold' AND request_id = v_req) IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'FAIL 08: the fast fold did not free exactly that player at once: %', v;
  END IF;
  IF public.fn_lightning_pool_stack((SELECT id FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = p AND exited_at IS NULL))
       IS DISTINCT FROM s_p - 3.00 THEN
    RAISE EXCEPTION 'FAIL 08: the next hand would deal the fast folder chips already in the first pot';
  END IF;
  IF (public.fn_lightning_fast_fold(v_a, p, gen_random_uuid(), 'fast') ->> 'replay')::boolean IS DISTINCT FROM true
     OR public.fn_lightning_fast_fold(v_a, p, gen_random_uuid(), 'normal') ->> 'reason' IS DISTINCT FROM 'already_folded'
     OR public.fxr_try(format('UPDATE public.lightning_hand_player SET committed_at_fold = 1 WHERE hand_id = %L AND player_id = %L', v_a, p))
        !~ 'LIGHTNING_FOLD_IS_FINAL' THEN
    RAISE EXCEPTION 'FAIL 08: the fold is not idempotent on (hand, player), or can be rewritten';
  END IF;
  -- A NORMAL FOLD THAT DOES NOT SAY: freed, but holding everything brought in.
  v := public.fn_lightning_fast_fold(v_a, q, gen_random_uuid(), 'normal');
  IF (v ->> 'released')::boolean IS DISTINCT FROM true
     OR public.fn_lightning_pool_stack((SELECT id FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = q AND exited_at IS NULL))
        IS DISTINCT FROM GREATEST(s_q - (SELECT stack_before FROM public.lightning_hand_player WHERE hand_id = v_a AND player_id = q), 0)
     OR public.fx6_reason(v_g, q) IS DISTINCT FROM 'NO_STACK' THEN
    RAISE EXCEPTION 'FAIL 08: a normal fold with no commitment did not hold the whole stack it brought in: %', public.fx6_reason(v_g, q);
  END IF;
  -- FOLD AND WATCH: recorded, the reservation kept, still in the hand.
  v := public.fn_lightning_fast_fold(v_a, w, gen_random_uuid(), 'fold_watch', 1.00);
  IF (v ->> 'released')::boolean IS DISTINCT FROM false
     OR (SELECT r.state FROM public.lightning_reservation r WHERE r.lightning_instance_id = v_a_inst AND r.player_id = w) IS DISTINCT FROM 'committed'
     OR public.fx6_reason(v_g, w) IS DISTINCT FROM 'IN_HAND'
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_g AND kind IN ('normal_fold', 'fold_and_watch')) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL 08: fold and watch released the player or did not record';
  END IF;
  -- THE ANCHOR IS HELD while the first hand is live, though p is free.
  v_seat := public.fxr_anchor(v_g, p);
  IF public.fx6_after(format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_seat), 'SELECT 1') !~ '^ERROR PLT01'
     OR public.fx6_after(format('UPDATE public.table_seats SET stack = stack - 1 WHERE id = %L', v_seat), 'SELECT 1') !~ '^ERROR PLT01' THEN
    RAISE EXCEPTION 'FAIL 08: a fast folder cashed out, or moved chips, while the hand holding his chips was live';
  END IF;
  -- THE SECOND HAND: p and two players who were never in the first.
  v_r := harness.form(v_g, ARRAY[p, o1, o2]);
  v_b_inst := (v_r ->> 'instance_id')::uuid; v_b := (v_r ->> 'hand_id')::uuid;
  IF (SELECT stack_before FROM public.lightning_hand_player WHERE hand_id = v_b AND player_id = p) IS DISTINCT FROM s_p - 3.00 THEN
    RAISE EXCEPTION 'FAIL 08: the second hand was not dealt from the stack less the chips in the first pot';
  END IF;
  nb := harness.deal(v_b_inst);
  -- B SETTLES FIRST: p wins 7.00.
  v_spec := jsonb_build_object(p::text, jsonb_build_object('d', 7.00, 'c', 3.50, 's', true),
                               o1::text, jsonb_build_object('d', -3.50, 'c', 3.50, 's', true),
                               o2::text, jsonb_build_object('d', -3.50, 'c', 3.50, 'f', 'normal'));
  v_res := harness.settle(v_b, gen_random_uuid(), harness.results(v_b, v_spec), 0, 0);
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true OR harness.anchor_stack(v_g, p) IS DISTINCT FROM s_p + 7.00
     OR public.fx6_after(format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_seat), 'SELECT 1') !~ '^ERROR PLT01' THEN
    RAISE EXCEPTION 'FAIL 08: the second hand did not settle its delta onto the anchor while the first still holds it: % / %', v_res, harness.anchor_stack(v_g, p);
  END IF;
  -- A SETTLES: p's committed 3.00, q's 2.00, w's 1.00 and y's 4.00 to x, less 0.50 rake.
  v_spec := jsonb_build_object(p::text, jsonb_build_object('d', -3.00, 'c', 3.00, 'f', 'fast'),
                               q::text, jsonb_build_object('d', -2.00, 'c', 2.00, 'f', 'normal'),
                               w::text, jsonb_build_object('d', -1.00, 'c', 1.00, 'f', 'fold_watch'),
                               y::text, jsonb_build_object('d', -4.00, 'c', 4.00, 's', true),
                               x::text, jsonb_build_object('d', 9.50, 'c', 4.00, 's', true));
  v_res := harness.settle(v_a, gen_random_uuid(), harness.results(v_a, v_spec), 0.50, 0);
  IF (v_res ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the first hand did not settle after the second: %', v_res;
  END IF;
  IF harness.anchor_stack(v_g, p) IS DISTINCT FROM s_p + 4.00
     OR harness.anchor_stack(v_g, q) IS DISTINCT FROM s_q - 2.00
     OR public.fn_lightning_pool_stack((SELECT id FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = p AND exited_at IS NULL))
        IS DISTINCT FROM s_p + 4.00
     OR (SELECT count(*) FROM public.ca_seat_stack_rebases rb WHERE rb.user_id = p) IS DISTINCT FROM 2::bigint
     OR (SELECT count(DISTINCT hand_number) FROM public.hand_history WHERE hand_number IN (na, nb)
           AND table_id = public.fn_cash_cluster_front_table(v_g)) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL 08: the anchor did not end at stack + 7 - 3 whichever hand settled first (p % expected %, q %)',
      harness.anchor_stack(v_g, p), s_p + 4.00, harness.anchor_stack(v_g, q);
  END IF;
  -- Fold and watch is released by the settlement, and only then.
  IF (SELECT r.state FROM public.lightning_reservation r WHERE r.lightning_instance_id = v_a_inst AND r.player_id = w) IS DISTINCT FROM 'released'
     OR public.fx6_reason(v_g, w) IS DISTINCT FROM 'LEGAL'
     OR (SELECT fold_and_watch FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = w) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 08: fold and watch was not released by the settlement';
  END IF;
  -- THE CASHOUT IS ALLOWED ONCE NOTHING HOLDS THE ANCHOR.
  IF public.fx6_after(format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_seat),
                      format('SELECT (left_at IS NOT NULL)::text FROM public.table_seats WHERE id = %L', v_seat)) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL 08: the cashout was still refused after both hands settled';
  END IF;
  INSERT INTO harness.s6 (k, game, a) VALUES ('fold', v_g, p);
END $$;
\echo '  ok  08 A FAST FOLDER PLAYS ON  a horse''s fast fold (committing 3.00) releases only its reservation, stamps idle_since and makes it LEGAL at once (never IN_HAND), idempotently; the next hand deals it its stack less 3.00; a normal fold that does not say holds all it brought (NO_STACK); fold and watch keeps its reservation (IN_HAND) until the settlement; the anchor refuses a cashout and a chip move while either hand is live; the second hand settles first (+7) and the first after it (-3), ending exactly at stack + 4 with both rebases recorded, both hands at the front table, and the cashout allowed afterwards'

-- 09 THE MARKER IS THE ONLY AUTHORITY ----------------------------------------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_inst uuid; v_hand uuid; v_p uuid; v_seat uuid; v_other uuid; v_said text; v_state text;
BEGIN
  SELECT game INTO v_g FROM harness.s6 x6 WHERE x6.k = 'fold';
  v_r := harness.form(v_g, public.fx9_candidates(v_g, 3));
  v_inst := (v_r ->> 'instance_id')::uuid; v_hand := (v_r ->> 'hand_id')::uuid;
  PERFORM harness.deal(v_inst);
  SELECT hp.player_id INTO v_p FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand ORDER BY hp.seat LIMIT 1;
  v_seat := public.fxr_anchor(v_g, v_p);
  SELECT public.fxr_anchor(v_g, hp.player_id) INTO v_other FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand AND hp.player_id <> v_p LIMIT 1;
  -- The forged setting no longer moves a chip.
  v_said := public.fx6_after(
    format('SELECT set_config(%L, %L, true); UPDATE public.table_seats SET stack = stack + 1000 WHERE id = %L',
           'ca.lightning_settlement_hand', v_hand, v_seat), 'SELECT 1');
  IF v_said !~ '^ERROR PLT01' THEN
    RAISE EXCEPTION 'FAIL 09: the forged setting still moves chips: %', v_said;
  END IF;
  -- A marker row of THIS transaction for THIS seat lets a stack change through
  -- (written here as the owner, which only the settlement is in production)...
  v_said := public.fx6_after(
    format('INSERT INTO public.lightning_settlement_marker (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
            SELECT pg_current_xact_id(), ts.id, ts.table_id, ts.user_id, %L, ts.table_id, 1 FROM public.table_seats ts WHERE ts.id = %L;
            UPDATE public.table_seats SET stack = stack + 1 WHERE id = %L', v_hand, v_seat, v_seat), 'SELECT ''moved''');
  IF v_said IS DISTINCT FROM 'moved' THEN
    RAISE EXCEPTION 'FAIL 09: the marker of this transaction did not authorise its seat: %', v_said;
  END IF;
  -- ...but not a departure, not another seat, and not another transaction's.
  IF public.fx6_after(
       format('INSERT INTO public.lightning_settlement_marker (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
               SELECT pg_current_xact_id(), ts.id, ts.table_id, ts.user_id, %L, ts.table_id, 1 FROM public.table_seats ts WHERE ts.id = %L;
               UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', v_hand, v_seat, v_seat), 'SELECT 1') !~ '^ERROR PLT01'
     OR public.fx6_after(
       format('INSERT INTO public.lightning_settlement_marker (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
               SELECT pg_current_xact_id(), ts.id, ts.table_id, ts.user_id, %L, ts.table_id, 1 FROM public.table_seats ts WHERE ts.id = %L;
               UPDATE public.table_seats SET stack = stack + 1 WHERE id = %L', v_hand, v_seat, v_other), 'SELECT 1') !~ '^ERROR PLT01'
     OR public.fx6_after(
       format('INSERT INTO public.lightning_settlement_marker (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
               SELECT ''1''::xid8, ts.id, ts.table_id, ts.user_id, %L, ts.table_id, 1 FROM public.table_seats ts WHERE ts.id = %L;
               UPDATE public.table_seats SET stack = stack + 1 WHERE id = %L', v_hand, v_seat, v_seat), 'SELECT 1') !~ '^ERROR PLT01' THEN
    RAISE EXCEPTION 'FAIL 09: a marker authorised a departure, another seat, or another transaction';
  END IF;
  -- Nobody but the owner can write it.
  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.lightning_settlement_marker (txid, seat_id, anchor_table_id, player_id, hand_id, host_table_id, hand_number)
    VALUES (pg_current_xact_id(), v_seat, v_seat, v_p, v_hand, v_seat, 1);
    v_state := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state IS DISTINCT FROM '42501' OR EXISTS (SELECT 1 FROM public.lightning_settlement_marker) THEN
    RAISE EXCEPTION 'FAIL 09: service_role wrote a marker (%), or one survived', v_state;
  END IF;
  INSERT INTO harness.s6 (k, game, a, b) VALUES ('live', v_g, v_inst, v_hand);
END $$;
\echo '  ok  09 THE MARKER IS THE ONLY AUTHORITY  after the file the forged setting is refused PLT01; a marker row of this transaction for this seat lets its stack move, but not its departure, not another seat and not another transaction''s; service_role cannot write the marker (42501) and none survives'

-- 10 THE PLAYER'S OWN SESSION ----------------------------------------------------------
DO $$
DECLARE v_g uuid; v_hand uuid; v_inst uuid; v_in uuid; v_out uuid; v_ps_in uuid; v_ps_out uuid; v jsonb; v_state text; v_other uuid;
BEGIN
  SELECT game, a, b INTO v_g, v_inst, v_hand FROM harness.s6 x6 WHERE x6.k = 'live';
  SELECT hp.player_id INTO v_in FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand ORDER BY hp.seat LIMIT 1;
  SELECT ps.player_id INTO v_out FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND public.fn_lightning_player_live_hand(ps.player_id, v_g) IS NULL LIMIT 1;
  SELECT id INTO v_ps_in FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_in AND exited_at IS NULL;
  SELECT id INTO v_ps_out FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = v_out AND exited_at IS NULL;
  SELECT game INTO v_other FROM harness.s6 x6 WHERE x6.k = 'settled';
  PERFORM set_config('request.jwt.claim.sub', v_in::text, true);
  SET LOCAL ROLE authenticated;
  v := public.fn_lightning_my_session(v_g);
  RESET ROLE;
  IF (v ->> 'pool_session_id')::uuid IS DISTINCT FROM v_ps_in OR (v ->> 'in_hand')::boolean IS DISTINCT FROM true
     OR (v ->> 'hand_id')::uuid IS DISTINCT FROM v_hand OR v ->> 'cluster_mode' IS DISTINCT FROM 'lightning'
     OR v ->> 'state' IS DISTINCT FROM 'active'
     OR (v ->> 'stack')::numeric IS DISTINCT FROM harness.anchor_stack(v_g, v_in)
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k)
        IS DISTINCT FROM ARRAY['cluster_mode', 'hand_id', 'in_hand', 'pool_session_id', 'stack', 'state']
     OR v::text ~ v_inst::text THEN
    RAISE EXCEPTION 'FAIL 10: the player in a hand did not get exactly their own session and hand: %', v;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_out::text, true);
  SET LOCAL ROLE authenticated;
  v := public.fn_lightning_my_session(v_g);
  RESET ROLE;
  IF (v ->> 'pool_session_id')::uuid IS DISTINCT FROM v_ps_out OR (v ->> 'in_hand')::boolean IS DISTINCT FROM false OR v ? 'hand_id' THEN
    RAISE EXCEPTION 'FAIL 10: an idle player did not get exactly their own idle session: %', v;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF public.fn_lightning_my_session(v_g) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 10: a stranger was given a session';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_in::text, true);
  IF public.fn_lightning_my_session(v_other) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 10: a player was given a session in a Cluster they are not in';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.fn_lightning_my_session(v_g) IS DISTINCT FROM '{"pool_session_id": null}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 10: a caller with no identity was given a session';
  END IF;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.fn_lightning_my_session(v_g);
    v_state := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FAIL 10: anon could read a session';
  END IF;
  IF public.fn_lightning_hand_view_access(v_ps_in, v_in) IS DISTINCT FROM true
     OR public.fn_lightning_hand_view_access(v_ps_in, v_out) IS DISTINCT FROM false
     OR public.fn_lightning_hand_view_access(v_ps_out, v_in) IS DISTINCT FROM false
     OR public.fn_lightning_hand_view_access(NULL, v_in) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 10: view access is not exactly the owner of the open session';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'p6s: session section done');
END $$;
\echo '  ok  10 THE PLAYER''S OWN SESSION  as authenticated, a player in a dealing hand reads exactly {pool_session_id, state, cluster_mode, stack, in_hand:true, hand_id} of their own session and never an instance id, an idle player their own idle session, a stranger, another Cluster and no identity {pool_session_id:null}; anon is refused 42501; view access is true for the owner only'
ASSERT

# ===========================================================================
# 11 EVERY LIVE PROOF; 12 the grants; 13 the file applied a second time.
# ===========================================================================
{
  printf '%s\n' 'CREATE TABLE harness.lpm (phase text, src text, n integer, lineno integer, ok boolean);'
  gen_proofs mine mine "$mine" | sed 's/INSERT INTO harness.lp6/INSERT INTO harness.lpm/'
} > "$fixture/live-proofs.sql"
mine_n=$(grep -c -- '^-- @live-proof: ' "$mine")
if [ "$mine_n" -lt 10 ]; then
  echo "FAIL 11: only $mine_n @live-proof lines in the file under test"
  exit 1
fi
cat >> "$fixture/live-proofs.sql" <<ASSERT
DO \$lp\$
DECLARE v_bad text;
BEGIN
  SELECT string_agg('#' || n || ' (line ' || lineno || ')', ', ' ORDER BY n) INTO v_bad FROM harness.lpm WHERE ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM harness.lpm) IS DISTINCT FROM ${mine_n}::bigint THEN
    RAISE EXCEPTION 'FAIL 11: a proof of the file under test is not true: %', v_bad;
  END IF;
END \$lp\$;
\echo '  ok  11 EVERY LIVE PROOF  all ${mine_n} @live-proof expressions of the file under test are true, evaluated as code over the final estate'
ASSERT
cat >> "$fixture/live-proofs.sql" <<'ASSERT'
-- 12 WHO MAY CALL WHAT -------------------------------------------------------------
DO $$
DECLARE f text; v_state text; v jsonb; v_hand uuid;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_lightning_bind_hand_number(uuid,bigint)', 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)',
                           'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
                           'public.fn_lightning_hand_view_access(uuid,uuid)'] LOOP
    IF NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 12: % is not service_role only', f;
    END IF;
  END LOOP;
  -- service_role settles as itself (the definer answers), a browser is refused.
  SELECT b INTO v_hand FROM harness.s6 x6 WHERE x6.k = 'live';
  SET LOCAL ROLE service_role;
  v := public.fn_lightning_settle_hand(v_hand, gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), '[]'::jsonb, 0, 0, '{}'::jsonb);
  RESET ROLE;
  IF v ->> 'reason' IS DISTINCT FROM 'instance_abandoned' THEN
    RAISE EXCEPTION 'FAIL 12: service_role could not reach the settlement: %', v;
  END IF;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.fn_lightning_settle_hand(v_hand, gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), '[]'::jsonb, 0, 0, '{}'::jsonb);
    v_state := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FAIL 12: authenticated reached the settlement';
  END IF;
  -- The marker, and the unchanged physical grants.
  IF has_function_privilege('authenticated', 'public.fn_lightning_settlement_seats(uuid,bigint)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure, 'EXECUTE')
     OR has_table_privilege('service_role', 'public.lightning_settlement_marker', 'SELECT')
     OR has_table_privilege('service_role', 'public.lightning_settlement_marker', 'INSERT')
     OR NOT has_function_privilege('service_role', 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 12: an owner-only object is reachable, or the substitution changed a physical grant';
  END IF;
END $$;
\echo '  ok  12 WHO MAY CALL WHAT  bind, fold, settle and view access are service_role only (service_role reaches the settlement, authenticated is refused 42501); the marker reader and the freeze reach no browser, the marker no role; the substituted physical door keeps service_role and the stack core stays owner only'
ASSERT
cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.cap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
   AND (p.proname ~ '^fn_lightning_' OR p.proname IN ('fn_table_seats_lightning_anchor_guard', 'fn_ca_settle_hand_stacks_absolute', 'fn_ca_commit_hand_settlement'))
UNION ALL
SELECT 'con:' || c.conrelid::regclass || '.' || c.conname, md5(pg_get_constraintdef(c.oid) || c.convalidated)
  FROM pg_constraint c WHERE c.conrelid IN ('public.lightning_hand'::regclass, 'public.lightning_hand_player'::regclass, 'public.lightning_settlement_marker'::regclass)
UNION ALL
SELECT 'col:' || a.attrelid::regclass || '.' || a.attname, md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull || coalesce(col_description(a.attrelid, a.attnum), ''))
  FROM pg_attribute a WHERE a.attrelid IN ('public.lightning_hand'::regclass, 'public.lightning_hand_player'::regclass, 'public.lightning_settlement_marker'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'idx:' || i.indexrelid::regclass, md5(pg_get_indexdef(i.indexrelid))
  FROM pg_index i WHERE i.indrelid IN ('public.lightning_hand'::regclass, 'public.lightning_settlement_marker'::regclass)
UNION ALL
SELECT 'acl:' || c.oid::regclass, md5(coalesce(c.relacl::text, '') || c.relrowsecurity || coalesce(obj_description(c.oid, 'pg_class'), ''))
  FROM pg_class c WHERE c.oid IN ('public.lightning_settlement_marker'::regclass, 'public.lightning_hand'::regclass)
UNION ALL
SELECT 'note', md5(note) FROM public.ca_declared_money_triggers WHERE trigger_name = 'trg_table_seats_lightning_anchor_guard'
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'hand_history', 'hand_atomic_commits', 'cash_cluster_events', 'lightning_settlement_marker']) x(t)
UNION ALL
SELECT 'stacks', md5(string_agg(id::text || ':' || coalesce(stack::text, ''), '|' ORDER BY id)) FROM public.table_seats;
ASSERT
cat > "$fixture/reapply.sql" <<'ASSERT'
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.cap a FULL JOIN (
      SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND (p.proname ~ '^fn_lightning_' OR p.proname IN ('fn_table_seats_lightning_anchor_guard', 'fn_ca_settle_hand_stacks_absolute', 'fn_ca_commit_hand_settlement'))
      UNION ALL
      SELECT 'con:' || c.conrelid::regclass || '.' || c.conname, md5(pg_get_constraintdef(c.oid) || c.convalidated)
        FROM pg_constraint c WHERE c.conrelid IN ('public.lightning_hand'::regclass, 'public.lightning_hand_player'::regclass, 'public.lightning_settlement_marker'::regclass)
      UNION ALL
      SELECT 'col:' || a.attrelid::regclass || '.' || a.attname, md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull || coalesce(col_description(a.attrelid, a.attnum), ''))
        FROM pg_attribute a WHERE a.attrelid IN ('public.lightning_hand'::regclass, 'public.lightning_hand_player'::regclass, 'public.lightning_settlement_marker'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'idx:' || i.indexrelid::regclass, md5(pg_get_indexdef(i.indexrelid))
        FROM pg_index i WHERE i.indrelid IN ('public.lightning_hand'::regclass, 'public.lightning_settlement_marker'::regclass)
      UNION ALL
      SELECT 'acl:' || c.oid::regclass, md5(coalesce(c.relacl::text, '') || c.relrowsecurity || coalesce(obj_description(c.oid, 'pg_class'), ''))
        FROM pg_class c WHERE c.oid IN ('public.lightning_settlement_marker'::regclass, 'public.lightning_hand'::regclass)
      UNION ALL
      SELECT 'note', md5(note) FROM public.ca_declared_money_triggers WHERE trigger_name = 'trg_table_seats_lightning_anchor_guard'
      UNION ALL
      SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
        FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'hand_history', 'hand_atomic_commits', 'cash_cluster_events', 'lightning_settlement_marker']) x(t)
      UNION ALL
      SELECT 'stacks', md5(string_agg(id::text || ':' || coalesce(stack::text, ''), '|' ORDER BY id)) FROM public.table_seats
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.cap) < 80 THEN
    RAISE EXCEPTION 'FAIL 13: the capture is too small to prove anything (%)', (SELECT count(*) FROM harness.cap);
  END IF;
END $$;
\echo '  ok  13 THE FILE IS RE-APPLIABLE  applied a second time over every hand above, it leaves every fn_lightning_ body, the guard, both substituted physical bodies, their acls and comments, the constraints, columns, indexes and acls it touched, the guard''s declaration, six row counts and every seat stack exactly as they were'
ASSERT

# ===========================================================================
# THE RUN.
# ===========================================================================
set +e
"${PSQL[@]}" \
  -f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture" \
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r" \
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture" \
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" -f "$p6" -f "$s6_fixture" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# FOURTEEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 14 ]; then
  echo "FAIL: $oks of the 14 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 6 settlement, 14 sections: every predecessor proof holds but the five superseded (the setting-reading guard and the no-definer, no-browser family rule), whose intent holds as containment; a dealing hand binds the allocator's number and the front table once; a six-player hand with humans and horses anchored at the front table and a feeder settles exact deltas through the unchanged physical door onto each anchor, writing hand_history, hand_atomic_commits with its envelope and the provenance receipt at the front table, and the post-commit processor pays its rake, drop and playthrough; a retry is the stored receipt; a stale lease, an abandoned instance and six other refusals move nothing; a conservation violation freezes the Cluster with its evidence; a fast-folding horse is legal at once, is dealt its stack less its committed chips, and ends exact whichever hand settles first, while fold and watch waits for the settlement and the anchor refuses a cashout until both are settled; the forged setting is refused and only this transaction's marker for this seat moves a stack; my_session answers only the caller; service_role alone may call the doors; every @live-proof holds and the file is re-appliable"
