#!/usr/bin/env bash
# Lightning Phases 6 and 7: the matcher explains every idle player, and the
# blinds rotate fairly.
#
# Proves 20260926080332 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55552 (LIGHTNING_P6_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The three Lightning fixtures, every Lightning
# migration from 20260920235343 through the four remediation-two files
# (20260926072527, 20260926072551, 20260926072615, 20260926072638) in order with the Phase
# 9 and remediation-two writers between them, this harness's own fixture, then
# the migration under test - twice. Every Cluster is made Lightning by the REAL
# fn_cash_cluster_begin_pending_on and fn_cash_cluster_commit_lightning
# (fx9_convert raises unless it converted), every pool slot comes from the real
# slot sync or the real pool door, every hand is formed by the real barrier and
# ended through the real begin_dealing and the instance discipline trigger.
#
# THE SHAPE OF EVERY PROOF. A refusal is paired with its twin one fact apart:
# each P0 reason is produced by flipping one fact and disappears when the fact
# is flipped back; each diagnosis state is produced and its neighbour shown.
# Most facts are flipped inside fx6_after, which applies a statement, asks a
# question and rolls everything back, so no probe leaks into the next one and
# no deferred trigger fires; section 00 proves the catcher catches and rolls
# back.
#
# THE FAIRNESS SIMULATION (spec Phase 7), section 15: LIGHTNING_P6_SIM_ROUNDS
# formation rounds (default 1000) for each of 18, 25 and 50 players, every
# population with horses, each round a full matcher pass followed by the real
# terminal path, committed per round; then a churn run with disconnects. The
# BB burden, the BB gap, the small blind, the button, the positions and the
# repeat-opponent rate are measured from lightning_hand_player and printed.
#
# LAW 10.5. Horses are seated through table_seats.horse_id and are converted,
# matched, blinded, queued and diversified exactly as humans are; section 03
# runs every P0 probe on a horse as well as a human, section 13 flips the flag
# between two players and gets a byte-identical plan, and nothing in the
# migration reads is_horse or horse_id.
#
# LIGHTNING_P6_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P6_PORT:-55552}
rounds=${LIGHTNING_P6_SIM_ROUNDS:-1000}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
base_fixture=$F/lightning-phase3-remediation-schema.sql
pop_fixture=$F/lightning-phase4-population-schema.sql
p5_fixture=$F/lightning-phase5-conversion-schema.sql
p9_fixture=$F/lightning-phase9-formation-fixture.sql
r2_fixture=$F/lightning-remediation-two-fixture.sql
p6_fixture=$F/lightning-phase6-matcher-fixture.sql
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
mine=${LIGHTNING_P6_MIGRATION:-$M/20260926080332_lightning_phase_6_and_7_the_matcher_explains_every_idle_play.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
case "$rounds" in ''|*[!0-9]*) echo "FAIL: LIGHTNING_P6_SIM_ROUNDS must be a whole number"; exit 1 ;; esac
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p6-test.XXXXXX")
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

# EVERY @live-proof OF EVERY LIGHTNING FILE, as INSERTs into harness.lp6 under
# a phase label, evaluated as code by fxr_eval (NULL when it no longer
# evaluates, never false).
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
}

# ===========================================================================
# THE GROUND: section 00, against remediation two's code, before the file.
# ===========================================================================
cat > "$fixture/ground.sql" <<'ASSERT'
CREATE TABLE harness.m6 (k text PRIMARY KEY, game uuid, a uuid, b uuid, t text, n bigint, j jsonb);
CREATE TABLE harness.lp6 (phase text, src text, n integer, lineno integer, ok boolean);

-- 00 THE CATCHERS CATCH, AND THE ESTATE THE FILE IS APPLIED OVER ---------------
DO $$
DECLARE v_g uuid; v_r jsonb; v_i uuid; v_name text; v_players uuid[];
BEGIN
  -- fx6_after returns what the question saw and undoes the statement.
  v_g := public.fx9_cluster('P6 catcher', 6, 40, true);
  SELECT name INTO v_name FROM public.cash_games WHERE id = v_g;
  IF public.fx6_after(format('UPDATE public.cash_games SET name = %L WHERE id = %L', 'renamed', v_g),
                      format('SELECT name FROM public.cash_games WHERE id = %L', v_g)) IS DISTINCT FROM 'renamed'
     OR (SELECT name FROM public.cash_games WHERE id = v_g) IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'FAIL 00: fx6_after did not show the statement''s effect and then undo it';
  END IF;
  IF public.fx6_after('SELECT 1/0', 'SELECT 1') !~ '^ERROR 22012' THEN
    RAISE EXCEPTION 'FAIL 00: fx6_after does not report a failing statement with its class';
  END IF;
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: fxr_try does not catch';
  END IF;
  IF public.fxr_other('SET application_name = ''fxr_other''') IS DISTINCT FROM 'SET'
     OR public.fxr_other_ask('SELECT pg_backend_pid()::text') IS NOT DISTINCT FROM pg_backend_pid()::text THEN
    RAISE EXCEPTION 'FAIL 00: the second backend does not answer';
  END IF;
  -- NOTHING OF THE FILE EXISTS YET.
  IF to_regprocedure('public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_config(uuid)') IS NOT NULL
     OR to_regclass('public.cash_cluster_matcher_pass') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_pool_slot'::regclass AND attname = 'idle_since') THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  -- THE ESTATE THE BACKFILL MUST READ: a converted Cluster with one hand
  -- formed and completed, so six slots have a released reservation.
  v_g := public.fx6_cluster('PRE', 6, 16, 2);
  v_players := public.fx9_candidates(v_g, 6);
  v_r := public.fxr_form(v_g, v_players);
  IF (v_r ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 00: the pre-migration hand did not form: %', v_r;
  END IF;
  PERFORM pg_sleep(0.02);
  PERFORM public.fx6_complete((v_r ->> 'instance_id')::uuid);
  -- And six others formed and abandoned before they were dealt: released,
  -- but never dealt, so the backfill must leave their place in the queue.
  v_r := public.fxr_form(v_g, ARRAY(SELECT c FROM unnest(public.fx9_candidates(v_g)) c WHERE NOT (c = ANY (v_players)) LIMIT 6));
  IF (v_r ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 00: the pre-migration second hand did not form: %', v_r;
  END IF;
  PERFORM pg_sleep(0.02);
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'fx6: abandoned before dealing');
  INSERT INTO harness.m6 (k, game, j) VALUES ('pre', v_g, to_jsonb(v_players));
END $$;
\echo '  ok  00 THE CATCHERS CATCH  fx6_after shows a statement''s effect and undoes it and names a failure by class, fxr_try catches, the second backend answers, nothing of the file exists yet, and a converted Cluster has one completed hand and one formation abandoned before dealing for the backfill to read'
ASSERT

# THE PREDECESSOR PROOFS, BEFORE AND AFTER THE FILE, over one estate.
pred_n=0
for f in "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d"; do
  pred_n=$((pred_n + $(grep -c -- '^-- @live-proof: ' "$f")))
done
{ printf '%s\n' "INSERT INTO harness.m6 (k, n) VALUES ('pred_n', $pred_n);"; predecessor_proofs before; } > "$fixture/proofs-before.sql"
{ predecessor_proofs after; } > "$fixture/proofs-after.sql"

# ===========================================================================
# THE ASSERTIONS, sections 01 to 14, against the file.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- THE HARNESS'S READERS OF A PLAN.
CREATE FUNCTION harness.grouped(p jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg(x.pid::uuid ORDER BY x.pid::uuid), ARRAY[]::uuid[])
    FROM jsonb_array_elements(p -> 'groups') g, jsonb_array_elements_text(g -> 'players') x(pid);
$f$;
CREATE FUNCTION harness.state(p jsonb, who uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT (d ->> 'state') || coalesce(':' || (d ->> 'reason_code'), '')
    FROM jsonb_array_elements(p -> 'diagnosis') d WHERE (d ->> 'player_id')::uuid = who;
$f$;
CREATE FUNCTION harness.sizes(p jsonb) RETURNS integer[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg(jsonb_array_length(g -> 'players') ORDER BY o), ARRAY[]::integer[])
    FROM jsonb_array_elements(p -> 'groups') WITH ORDINALITY t(g, o);
$f$;
CREATE FUNCTION harness.bbs(p jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(array_agg((g ->> 'bb')::uuid ORDER BY o), ARRAY[]::uuid[])
    FROM jsonb_array_elements(p -> 'groups') WITH ORDINALITY t(g, o);
$f$;
-- The groups as sorted member sets, in group order.
CREATE FUNCTION harness.sets(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(string_agg(s.m, ' | ' ORDER BY s.o), '')
    FROM (SELECT t.o, (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(t.g -> 'players') x) AS m
            FROM jsonb_array_elements(p -> 'groups') WITH ORDINALITY t(g, o)) s;
$f$;
-- Every open-pool player diagnosed exactly once, and MATCHED iff grouped.
CREATE FUNCTION harness.diag_problem(p jsonb, g uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN (SELECT count(*) FROM jsonb_array_elements(p -> 'diagnosis'))
         IS DISTINCT FROM (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = g AND ps.exited_at IS NULL)
      THEN 'the diagnosis does not have one row per open pool session'
    WHEN (SELECT count(DISTINCT d ->> 'player_id') FROM jsonb_array_elements(p -> 'diagnosis') d)
         IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(p -> 'diagnosis'))
      THEN 'a player is diagnosed twice'
    WHEN EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = g AND ps.exited_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'diagnosis') d WHERE (d ->> 'player_id')::uuid = ps.player_id))
      THEN 'an open-pool player is missing from the diagnosis'
    WHEN (SELECT coalesce(array_agg((d ->> 'player_id')::uuid ORDER BY (d ->> 'player_id')::uuid), ARRAY[]::uuid[])
            FROM jsonb_array_elements(p -> 'diagnosis') d WHERE d ->> 'state' = 'MATCHED') IS DISTINCT FROM harness.grouped(p)
      THEN 'MATCHED is not exactly the grouped players'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'diagnosis') d
                  WHERE d ->> 'state' NOT IN ('MATCHED', 'WAITING_FOR_PLAYERS', 'WAITING_FOR_BB', 'WAITING_FOR_FORMATION',
                                              'WAITING_FOR_RECONNECT', 'BLOCKED_WITH_REASON')
                     OR (d ->> 'state' = 'MATCHED') IS DISTINCT FROM (d ->> 'reason_code' IS NULL))
      THEN 'a state outside the specification, or a reason on MATCHED, or none elsewhere'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'groups') x WHERE jsonb_array_length(x -> 'players') < 2)
      THEN 'a one-player group'
  END;
$f$;
-- A plan at a fixed moment.
CREATE FUNCTION harness.plan(g uuid, disc uuid[] DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT public.fn_lightning_match(g, clock_timestamp(), disc, NULL);
$f$;
-- A full matcher pass then the real terminal path for every hand it formed.
CREATE FUNCTION harness.pass_and_complete(g uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb; h jsonb;
BEGIN
  r := public.fn_lightning_match_and_form(g, clock_timestamp(), NULL, NULL, gen_random_uuid());
  FOR h IN SELECT x FROM jsonb_array_elements(r -> 'hands') x LOOP
    PERFORM public.fx6_complete((h ->> 'instance_id')::uuid);
  END LOOP;
  RETURN r;
END $f$;
-- The ids of one pool member.
CREATE FUNCTION harness.who(g uuid, p uuid) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT jsonb_build_object('ps', ps.id, 'slot', sl.id, 'seat', ps.anchor_seat_id, 'cps', ps.cash_player_session_id,
                            'epoch', ps.cluster_epoch)
    FROM public.lightning_pool_session ps
    LEFT JOIN public.lightning_pool_slot sl ON sl.pool_session_id = ps.id AND sl.closed_at IS NULL
   WHERE ps.cluster_id = g AND ps.player_id = p AND ps.exited_at IS NULL;
$f$;
-- A formation that includes this player and five others of the Cluster.
CREATE FUNCTION harness.form_with(g uuid, p uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.fxr_form(g, ARRAY[p] || ARRAY(SELECT c FROM unnest(public.fx9_candidates(g)) c WHERE c <> p LIMIT 5));
$f$;

-- 01 NOTHING BEFORE IT IS FALSIFIED, AND THE BACKFILL READ THE HISTORY -------------
DO $$
DECLARE v_bad text; v_g uuid; v_in uuid[];
BEGIN
  -- EXACTLY THE SUPERSEDED PROOFS CHANGE, from true to false, and nothing
  -- else does. p9#3 and p9r#12 are exact lists of the fn_lightning_ functions
  -- whose body names fn_platform_frozen, written when only the five writers
  -- did; the planner's P0 now reads the freeze too (PLATFORM_FROZEN), without
  -- writing anything. Their intent is re-proved below as containment.
  SELECT string_agg(b.src || '#' || b.n || ' ' || coalesce(b.ok::text, 'error') || '->' || coalesce(a.ok::text, 'error'), ', ' ORDER BY b.src, b.n)
    INTO v_bad
    FROM harness.lp6 b JOIN harness.lp6 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND a.ok IS DISTINCT FROM b.ok;
  IF v_bad IS DISTINCT FROM 'p9#3 true->false, p9r#12 true->false' THEN
    RAISE EXCEPTION 'FAIL 01: the predecessor proofs the file changed are [%], not exactly the superseded p9#3 and p9r#12', v_bad;
  END IF;
  -- THE SUPERSEDED PROOFS' INTENT, AS CONTAINMENT: the five writers still
  -- refuse during the freeze, the planner's P0 is the only new reader, and
  -- nothing the recovery path runs asks it.
  IF (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname ~ '^fn_lightning_' OR p.proname = 'fn_cash_cluster_matcher_pass_prune')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'fn_platform_frozen')
     IS DISTINCT FROM ARRAY['fn_lightning_form_hand', 'fn_lightning_instance_begin_dealing', 'fn_lightning_instance_open',
                            'fn_lightning_player_legality', 'fn_lightning_pool_slot_open', 'fn_lightning_pool_slots_sync'] THEN
    RAISE EXCEPTION 'FAIL 01: the readers of the freeze are not the five writers and the planner''s P0';
  END IF;
  IF (SELECT count(*) FROM harness.lp6 WHERE phase = 'before') IS DISTINCT FROM (SELECT n FROM harness.m6 WHERE k = 'pred_n')
     OR (SELECT count(*) FROM harness.lp6 WHERE phase = 'before')
        IS DISTINCT FROM (SELECT count(*) FROM harness.lp6 WHERE phase = 'after') THEN
    RAISE EXCEPTION 'FAIL 01: the predecessor proofs were not all read (% before, % after)',
      (SELECT count(*) FROM harness.lp6 WHERE phase = 'before'), (SELECT count(*) FROM harness.lp6 WHERE phase = 'after');
  END IF;
  -- THE BACKFILL: the six players of the completed hand are idle from their
  -- release, the other twelve from their slot's open.
  SELECT game, ARRAY(SELECT jsonb_array_elements_text(j)::uuid) INTO v_g, v_in FROM harness.m6 WHERE k = 'pre';
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
              WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL
                AND sl.idle_since IS DISTINCT FROM CASE WHEN sl.player_id = ANY (v_in)
                      THEN (SELECT max(r.resolved_at) FROM public.lightning_reservation r WHERE r.pool_slot_id = sl.id)
                      ELSE sl.opened_at END)
     OR (SELECT count(*) FROM public.lightning_pool_slot sl
          WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.idle_since > sl.opened_at) IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL 01: the backfill did not set idle_since from the released reservations of the dealt hand only';
  END IF;
  -- The abandoned formation's six were released too, and kept opened_at.
  IF (SELECT count(DISTINCT r.player_id) FROM public.lightning_reservation r
        JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
       WHERE r.cluster_id = v_g AND r.state = 'released' AND i.started_at IS NULL) IS DISTINCT FROM 6::bigint THEN
    RAISE EXCEPTION 'FAIL 01: the fixture did not leave six released, never-dealt reservations, so the backfill proof is vacuous';
  END IF;
END $$;
SELECT count(*) AS proof_count FROM harness.lp6 WHERE phase = 'before' \gset
\echo '  ok  01 NOTHING BEFORE IT IS FALSIFIED BUT THE SUPERSEDED  of the' :proof_count '@live-proof expressions of the sixteen Lightning files before it, every one evaluates exactly as it did the moment before it was applied except p9#3 and p9r#12 (exact lists of the fn_lightning_ readers of fn_platform_frozen), which turn false because the planner''s P0 reads the freeze, and whose intent holds as containment - the five writers and fn_lightning_player_legality are exactly the readers; and its backfill set idle_since from the six released reservations of the dealt hand, and from opened_at for the twelve others - six of them released from a formation abandoned before it was dealt'

-- 02 THE CONFIGURATION ---------------------------------------------------------
DO $$
DECLARE v6 uuid; v9 uuid; c jsonb; v_keys text[];
BEGIN
  v6 := public.fx9_cluster('CFG6', 6, 40, true);
  v9 := public.fx9_cluster('CFG9', 9, 40, true);
  c := public.fn_lightning_config(v6);
  IF (c ->> 'instance_min', c ->> 'instance_target', c ->> 'instance_max', c ->> 'worker_mode', c ->> 'matcher_version',
      c ->> 'diversity_thin_min', c ->> 'diversity_medium_min', c ->> 'diversity_large_min', c ->> 'pass_interval_ms',
      c ->> 'first_entry_rule', c ->> 'multi_table_limit', c -> 'invalid')
     IS DISTINCT FROM ('2', '6', '6', 'off', 'm1', '12', '18', '36', '1000', 'any_seat', '4', '[]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 02: the 6-max defaults are wrong: %', c;
  END IF;
  -- Every tunable the matcher reads has a key.
  v_keys := ARRAY['matcher_version', 'worker_mode', 'pass_interval_ms', 'pass_time_budget_ms', 'keepalive_interval_ms',
                  'instance_min', 'instance_target', 'instance_max', 'reservation_ttl_ms', 'form_window_ms', 'deal_window_ms',
                  'recent_opponent_window_hands', 'recent_opponent_window_seconds', 'diversity_thin_min',
                  'diversity_medium_min', 'diversity_large_min', 'diversity_weight_large', 'diversity_weight_medium',
                  'diversity_weight_thin', 'diversity_weight_tiny', 'multi_table_limit', 'admission_batch_hands',
                  'max_replans', 'cluster_row_wait_ms', 'pass_record_retention_hours', 'pass_record_prune_batch',
                  'first_entry_rule', 'position_fairness', 'on_threshold', 'off_threshold', 'invalid'];
  IF NOT (c ?& v_keys) THEN
    RAISE EXCEPTION 'FAIL 02: a tunable has no key: %', (SELECT array_agg(k) FROM unnest(v_keys) k WHERE NOT c ? k);
  END IF;
  c := public.fn_lightning_config(v9);
  IF (c ->> 'instance_min', c ->> 'instance_target', c ->> 'instance_max',
      c ->> 'diversity_thin_min', c ->> 'diversity_medium_min', c ->> 'diversity_large_min')
     IS DISTINCT FROM ('2', '9', '9', '18', '27', '54') THEN
    RAISE EXCEPTION 'FAIL 02: the 9-max defaults are wrong: %', c;
  END IF;
  -- OVERRIDES are honoured.
  PERFORM public.fx6_reset(v6, '{"pass_interval_ms": 2000, "instance_max": 5, "instance_target": 4, "instance_min": 3,
    "matcher_version": "m2", "worker_mode": "shadow", "first_entry_rule": "big_blind", "diversity_weight_large": 0.25,
    "multi_table_limit": 2, "position_fairness": false, "admission_batch_hands": 7, "max_replans": 1}');
  c := public.fn_lightning_config(v6);
  IF (c ->> 'pass_interval_ms', c ->> 'instance_max', c ->> 'instance_target', c ->> 'instance_min', c ->> 'matcher_version',
      c ->> 'worker_mode', c ->> 'first_entry_rule', c ->> 'diversity_weight_large', c ->> 'multi_table_limit',
      c ->> 'position_fairness', c ->> 'admission_batch_hands', c ->> 'max_replans', c -> 'invalid')
     IS DISTINCT FROM ('2000', '5', '4', '3', 'm2', 'shadow', 'big_blind', '0.25', '2', 'false', '7', '1', '[]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 02: an override was not honoured: %', c;
  END IF;
  -- A BAD VALUE falls back and is reported: wrong type to the default, out of
  -- range clamped, bands out of order reset, thin weight zero by rule.
  PERFORM public.fx6_reset(v6, '{"pass_interval_ms": "fast", "instance_max": 12, "reservation_ttl_ms": 1.5,
    "worker_mode": "yes", "matcher_version": 7, "diversity_thin_min": 50, "diversity_medium_min": 20,
    "diversity_weight_thin": 0.3, "position_fairness": "no", "multi_table_limit": 0}');
  c := public.fn_lightning_config(v6);
  IF (c ->> 'pass_interval_ms', c ->> 'instance_max', c ->> 'reservation_ttl_ms', c ->> 'worker_mode', c ->> 'matcher_version',
      c ->> 'diversity_thin_min', c ->> 'diversity_medium_min', c ->> 'diversity_weight_thin', c ->> 'position_fairness',
      c ->> 'multi_table_limit')
     IS DISTINCT FROM ('1000', '6', '20000', 'off', 'm1', '12', '18', '0', 'true', '1') THEN
    RAISE EXCEPTION 'FAIL 02: a bad value was not replaced: %', c;
  END IF;
  IF (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason') ORDER BY x ->> 'key') FROM jsonb_array_elements(c -> 'invalid') x)
     IS DISTINCT FROM ARRAY['diversity_bands:bands_out_of_order', 'diversity_weight_thin:zero_by_rule',
                            'instance_max:out_of_range_clamped', 'matcher_version:not_a_version_name',
                            'multi_table_limit:out_of_range_clamped', 'pass_interval_ms:wrong_type',
                            'position_fairness:wrong_type', 'reservation_ttl_ms:not_an_integer',
                            'worker_mode:not_off_shadow_or_form'] THEN
    RAISE EXCEPTION 'FAIL 02: the invalid report is not exactly the bad keys: %', c -> 'invalid';
  END IF;
  -- THE POPULATION'S THRESHOLD READER sets the bands: ON 20 / OFF 14 moves
  -- them to 14/20/40, and its own invalid-pair rule is its own.
  PERFORM public.fx6_reset(v6, '{"on_threshold": 20, "off_threshold": 14}');
  c := public.fn_lightning_config(v6);
  IF (c ->> 'diversity_thin_min', c ->> 'diversity_medium_min', c ->> 'diversity_large_min', c ->> 'on_threshold', c ->> 'threshold_source')
     IS DISTINCT FROM ('14', '20', '40', '20', 'ruleset') THEN
    RAISE EXCEPTION 'FAIL 02: the bands do not follow the population''s threshold reader: %', c;
  END IF;
  IF (public.fn_lightning_config(v6) ->> 'on_threshold')::integer
     IS DISTINCT FROM (public.fn_cash_cluster_lightning_thresholds(v6) ->> 'on')::integer THEN
    RAISE EXCEPTION 'FAIL 02: the matcher and the population read different thresholds';
  END IF;
  -- A 'lightning' that is not an object, and a Cluster that does not exist.
  UPDATE public.cash_games SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{lightning}', '"on"') WHERE id = v6;
  c := public.fn_lightning_config(v6);
  IF (c -> 'invalid' -> 0 ->> 'key') IS DISTINCT FROM 'lightning' OR (c ->> 'instance_max') IS DISTINCT FROM '6' THEN
    RAISE EXCEPTION 'FAIL 02: a non-object lightning block was not reported and defaulted: %', c;
  END IF;
  c := public.fn_lightning_config(gen_random_uuid());
  IF (c ->> 'ok')::boolean IS DISTINCT FROM false OR (c ->> 'reason') IS DISTINCT FROM 'not_found'
     OR (c ->> 'worker_mode', c ->> 'pass_interval_ms', c ->> 'pass_time_budget_ms', c ->> 'keepalive_interval_ms', c ->> 'instance_max')
        IS DISTINCT FROM ('off', '1000', '750', '5000', '6') OR NOT (c ?& v_keys) THEN
    RAISE EXCEPTION 'FAIL 02: a missing Cluster was not answered ok false with every key at its default (worker off): %', c;
  END IF;
  -- THE FLOOR OF TWO: a minimum of one, or none, is clamped to two and reported.
  PERFORM public.fx6_reset(v6, '{"instance_min": 1}');
  c := public.fn_lightning_config(v6);
  IF (c ->> 'instance_min') IS DISTINCT FROM '2'
     OR (c -> 'invalid' -> 0 ->> 'key', c -> 'invalid' -> 0 ->> 'reason', c -> 'invalid' -> 0 ->> 'used')
        IS DISTINCT FROM ('instance_min', 'out_of_range_clamped', '2') THEN
    RAISE EXCEPTION 'FAIL 02: an instance_min of 1 was not clamped to 2 and reported: %', c;
  END IF;
END $$;
\echo '  ok  02 THE CONFIGURATION  every tunable has a key and a default (6-max 2/6/6 and bands 12/18/36, 9-max 2/9/9 and 18/27/54, worker off, version m1); every override is honoured; a wrong type falls back to the default, an out-of-range value is clamped, bands out of order are reset and a thin weight is zero by rule, each listed under invalid and nothing else is; the bands follow the population''s own threshold reader; a minimum of one is clamped to two and reported; a non-object block is reported; a missing Cluster answers ok false with every key at its default, worker off'

-- 03 P0: EVERY REASON, ONE FACT AWAY FROM LEGAL, FOR A HUMAN AND A HORSE --------
DO $$
DECLARE
  v_l uuid; v_l2 uuid; v_x uuid; v_h uuid; v_p uuid; w jsonb; v_ask text; v_got text; v_want text;
  v_inst uuid; v_codes text[] := ARRAY[]::text[]; v_seen text[] := ARRAY[]::text[]; v_all text[];
  pr record; v_other uuid;
BEGIN
  -- L: nineteen players, two of them horses. L2: seventeen others and the
  -- human X, so X holds a pool session in two Clusters.
  v_l := public.fx6_cluster('L', 6, 17, 2);
  SELECT ps.player_id INTO v_x FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL AND ts.horse_id IS NULL ORDER BY ps.player_id LIMIT 1;
  SELECT ps.player_id INTO v_h FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL AND ts.horse_id IS NOT NULL ORDER BY ps.player_id LIMIT 1;
  v_l2 := public.fx9_cluster('L2', 6, 40, true);
  PERFORM public.fx9_seat(v_l2, 17, 1, false);
  PERFORM public.fxr_join(v_l2, public.fxr_main(v_l2), 18, 150.00, false, true, v_x);
  PERFORM public.fx9_convert(v_l2);
  PERFORM public.fx9_pool(v_l2);
  INSERT INTO harness.m6 (k, game, a, b) VALUES ('L', v_l, v_x, v_h), ('L2', v_l2, v_x, NULL);
  IF (SELECT count(*) FROM public.lightning_pool_session WHERE player_id = v_x AND exited_at IS NULL) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'FAIL 03: the fixture did not put X in two Lightning Clusters';
  END IF;

  FOREACH v_p IN ARRAY ARRAY[v_x, v_h] LOOP
    w := harness.who(v_l, v_p);
    v_ask := format('SELECT public.fx6_reason(%L, %L)', v_l, v_p);
    IF public.fx6_reason(v_l, v_p) IS DISTINCT FROM 'LEGAL' THEN
      RAISE EXCEPTION 'FAIL 03: % is not legal before any fact is flipped: %', v_p, public.fx6_reason(v_l, v_p);
    END IF;
    FOR pr IN SELECT * FROM (VALUES
      ('CLUSTER_NOT_LIGHTNING', format('UPDATE public.cash_games SET cluster_mode = %L WHERE id = %L', 'draining', v_l)),
      ('CLUSTER_FROZEN',        format('UPDATE public.cash_games SET cluster_mode = %L WHERE id = %L', 'frozen', v_l)),
      ('LIGHTNING_DISABLED',    format('UPDATE public.cash_games SET lightning_enabled = false WHERE id = %L', v_l)),
      ('PLATFORM_FROZEN',       'SELECT public.fx9_freeze()'),
      ('WRONG_EPOCH',           format('UPDATE public.cash_cluster_epoch SET ended_at = clock_timestamp() WHERE cluster_id = %L AND ended_at IS NULL', v_l)),
      ('SESSION_CLOSED',        format('UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = %L WHERE id = %L', 'fx6', w ->> 'cps')),
      ('POOL_SESSION_NOT_ACTIVE', format('UPDATE public.lightning_pool_session SET state = %L WHERE id = %L', 'joining', w ->> 'ps')),
      ('CASHOUT_PENDING',       format('UPDATE public.table_seats SET leave_pending = true WHERE id = %L', w ->> 'seat')),
      ('ANCHOR_LEFT',           format('UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = %L', w ->> 'seat')),
      ('SITTING_OUT',           format('UPDATE public.table_seats SET is_sitting_out = true WHERE id = %L', w ->> 'seat')),
      ('NO_STACK',              format('UPDATE public.table_seats SET stack = 0 WHERE id = %L', w ->> 'seat')),
      ('RESTRICTED',            format('INSERT INTO public.ca_player_restrictions (user_id, scope, reason_code) VALUES (%L, %L, %L); UPDATE public.ca_operator_policy SET restrictions_enforced = true', v_p, 'cash', 'terms_violation')),
      ('RG_EXCLUDED',           format('INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until) VALUES (%L, now() + interval %L)', v_p, '1 day')),
      ('DISCONNECTED',          format('UPDATE public.lightning_pool_session SET state = %L WHERE id = %L', 'disconnected', w ->> 'ps')),
      ('ALREADY_RESERVED',      format('WITH i AS (SELECT (public.fn_lightning_instance_open(%L) ->> %L)::uuid AS id) INSERT INTO public.lightning_reservation (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, state, created_at, expires_at) SELECT %L, %s, %L, %L, i.id, 1, %L, clock_timestamp(), clock_timestamp() + interval %L FROM i',
                                       v_l, 'instance_id', v_l, w ->> 'epoch', v_p, w ->> 'slot', 'pending', '20 seconds')),
      ('IN_HAND',               format('SELECT harness.form_with(%L, %L)', v_l, v_p)),
      ('SLOT_NOT_OPEN',         format('UPDATE public.lightning_pool_slot SET closed_at = clock_timestamp(), close_reason = %L WHERE id = %L', 'fx6', w ->> 'slot')),
      ('MULTI_TABLE_LIMIT',     CASE WHEN v_p = v_x THEN format('SELECT harness.form_with(%L, %L); SELECT public.fx6_set(%L, %L)', v_l2, v_p, v_l, '{"multi_table_limit": 1}') END)
    ) q(code, fact) WHERE q.fact IS NOT NULL LOOP
      v_got := public.fx6_after(pr.fact, v_ask);
      IF v_got IS DISTINCT FROM pr.code THEN
        RAISE EXCEPTION 'FAIL 03: flipping the % fact gave % % rather than %', pr.code, v_p, v_got, pr.code;
      END IF;
      v_seen := v_seen || pr.code;
      -- The population's anchor predicate agrees wherever the anchor is the fact.
      IF pr.code IN ('CASHOUT_PENDING', 'ANCHOR_LEFT', 'SITTING_OUT', 'NO_STACK')
         AND public.fx6_after(pr.fact, format('SELECT public.fn_lightning_anchor_is_live_eligible(%L, %L, %L)::text', w ->> 'seat', v_l, v_p)) IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'FAIL 03: % was named for % while the population''s anchor predicate still accepts it', pr.code, v_p;
      END IF;
    END LOOP;
    IF public.fn_lightning_anchor_is_live_eligible((w ->> 'seat')::uuid, v_l, v_p) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'FAIL 03: a legal player''s anchor is refused by the population''s predicate';
    END IF;

    -- THE TWINS: the same fact one thing different is legal again.
    FOR pr IN SELECT * FROM (VALUES
      ('restriction observed, not enforced', 'LEGAL', format('INSERT INTO public.ca_player_restrictions (user_id, scope, reason_code) VALUES (%L, %L, %L)', v_p, 'cash', 'terms_violation')),
      ('restriction for tournaments only', 'LEGAL', format('INSERT INTO public.ca_player_restrictions (user_id, scope, reason_code) VALUES (%L, %L, %L); UPDATE public.ca_operator_policy SET restrictions_enforced = true', v_p, 'tournaments', 'terms_violation')),
      ('restriction of the whole account', 'RESTRICTED', format('INSERT INTO public.ca_player_restrictions (user_id, scope, reason_code) VALUES (%L, %L, %L); UPDATE public.ca_operator_policy SET restrictions_enforced = true', v_p, 'account', 'terms_violation')),
      ('restriction lifted', 'LEGAL', format('INSERT INTO public.ca_player_restrictions (user_id, scope, reason_code, status, lifted_at, lifted_by) VALUES (%L, %L, %L, %L, now(), %L); UPDATE public.ca_operator_policy SET restrictions_enforced = true', v_p, 'cash', 'terms_violation', 'lifted', v_p)),
      ('self-exclusion that ended', 'LEGAL', format('INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until) VALUES (%L, now() - interval %L)', v_p, '1 day')),
      ('cooling off', 'RG_EXCLUDED', format('INSERT INTO public.responsible_gaming_limits (user_id, cooling_off_until) VALUES (%L, now() + interval %L)', v_p, '1 hour')),
      ('a pending claim the reaper expired', 'LEGAL', format('WITH i AS (SELECT (public.fn_lightning_instance_open(%L) ->> %L)::uuid AS id) INSERT INTO public.lightning_reservation (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, state, created_at, expires_at) SELECT %L, %s, %L, %L, i.id, 1, %L, clock_timestamp() - interval %L, clock_timestamp() - interval %L FROM i; SELECT public.fn_lightning_reap_formations(clock_timestamp())',
                                       v_l, 'instance_id', v_l, w ->> 'epoch', v_p, w ->> 'slot', 'pending', '1 minute', '1 second')),
      ('the hand completed', 'LEGAL', format('SELECT public.fx6_complete((harness.form_with(%L, %L) ->> %L)::uuid)', v_l, v_p, 'instance_id')),
      ('two facts: sitting out and excluded', 'SITTING_OUT', format('UPDATE public.table_seats SET is_sitting_out = true WHERE id = %L; INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until) VALUES (%L, now() + interval %L)', w ->> 'seat', v_p, '1 day')),
      ('two facts: frozen Cluster and frozen platform', 'CLUSTER_FROZEN', format('SELECT public.fx9_freeze(); UPDATE public.cash_games SET cluster_mode = %L WHERE id = %L', 'frozen', v_l)),
      ('two facts: excluded and disconnected', 'RG_EXCLUDED', format('UPDATE public.lightning_pool_session SET state = %L WHERE id = %L; INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until) VALUES (%L, now() + interval %L)', 'disconnected', w ->> 'ps', v_p, '1 day'))
    ) q(what, want, fact) LOOP
      v_got := public.fx6_after(pr.fact, v_ask);
      IF v_got IS DISTINCT FROM pr.want THEN
        RAISE EXCEPTION 'FAIL 03: twin "%": % answered % rather than %', pr.what, v_p, v_got, pr.want;
      END IF;
    END LOOP;
    -- DISCONNECTED by the worker's own list, and its twin.
    SELECT ps.player_id INTO v_other FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL AND ps.player_id <> v_p ORDER BY ps.player_id LIMIT 1;
    IF public.fx6_reason(v_l, v_p, ARRAY[v_p]) IS DISTINCT FROM 'DISCONNECTED'
       OR public.fx6_reason(v_l, v_p, ARRAY[v_other]) IS DISTINCT FROM 'LEGAL' THEN
      RAISE EXCEPTION 'FAIL 03: the reported-disconnected list is not honoured for exactly the players it names';
    END IF;
  END LOOP;
  -- MULTI_TABLE_LIMIT's twin: the same hand elsewhere at a limit of two.
  IF public.fx6_after(format('SELECT harness.form_with(%L, %L); SELECT public.fx6_set(%L, %L)', v_l2, v_x, v_l, '{"multi_table_limit": 2}'),
                      format('SELECT public.fx6_reason(%L, %L)', v_l, v_x)) IS DISTINCT FROM 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 03: a live hand in another Cluster blocked X under a limit it does not reach';
  END IF;

  -- EVERY CODE THE FUNCTION CAN ANSWER WAS PRODUCED ABOVE.
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1]) INTO v_all
    FROM regexp_matches(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])'::regprocedure),
                        'THEN ''([A-Z_]+)''', 'g') m;
  IF v_all IS DISTINCT FROM (SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(v_seen) s) THEN
    RAISE EXCEPTION 'FAIL 03: the codes the function can answer % are not the codes proved %', v_all,
      (SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(v_seen) s);
  END IF;
  INSERT INTO harness.m6 (k, n) VALUES ('p0_codes', cardinality(v_all));

  -- THE RESPONSIBLE-GAMING READER IS THE PLATFORM'S: RG_EXCLUDED exactly when
  -- fn_rg_require_not_excluded says ok false, across every shape of the row.
  FOR pr IN SELECT * FROM (VALUES
    ('none', NULL::interval, NULL::interval), ('past', interval '-1 day', NULL), ('future', interval '1 day', NULL),
    ('cooling', NULL, interval '1 hour'), ('cooled', NULL, interval '-1 hour'), ('both', interval '1 day', interval '1 hour'),
    ('forever', interval '100 years', NULL)) q(what, excl, cool) LOOP
    v_got := public.fx6_after(
      CASE WHEN pr.what = 'none' THEN NULL ELSE
        format('INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until, cooling_off_until) VALUES (%L, now() + %L::interval, now() + %L::interval)',
               v_x, pr.excl, pr.cool) END,
      format('SELECT (public.fx6_reason(%L, %L) = %L)::text || %L || ((public.fn_rg_require_not_excluded(%L) ->> %L)::boolean = false)::text',
             v_l, v_x, 'RG_EXCLUDED', '/', v_x, 'ok'));
    IF split_part(v_got, '/', 1) IS DISTINCT FROM split_part(v_got, '/', 2) THEN
      RAISE EXCEPTION 'FAIL 03: RG_EXCLUDED and the platform reader disagree for the % row: %', pr.what, v_got;
    END IF;
  END LOOP;

  -- EVERY POOL SESSION IS ITS CLUSTER'S BY CONSTRUCTION: its anchor seat is at
  -- a table of that Cluster, its cash session is scoped to it with the
  -- Cluster's own variant and stakes, and legality lists a Cluster's sessions
  -- and no other's - X appears in L and in L2 under two different sessions.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
               JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
               JOIN public.tables tb ON tb.id = ts.table_id
               JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
               JOIN public.cash_games cg ON cg.id = ps.cluster_id
              WHERE ps.exited_at IS NULL
                AND (tb.cluster_id IS DISTINCT FROM ps.cluster_id
                     OR NOT (cps.cluster_id = ps.cluster_id OR cps.scope_id = ps.cluster_id)
                     OR cps.variant IS DISTINCT FROM cg.variant OR cps.sb IS DISTINCT FROM cg.sb
                     OR cps.bb IS DISTINCT FROM cg.bb)) THEN
    RAISE EXCEPTION 'FAIL 03: a pool session is not its Cluster''s in table, scope, variant or stakes';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_lightning_player_legality(v_l, clock_timestamp(), NULL) l
              JOIN public.lightning_pool_session ps ON ps.id = l.pool_session_id WHERE ps.cluster_id <> v_l)
     OR (SELECT l.pool_session_id FROM public.fn_lightning_player_legality(v_l, clock_timestamp(), NULL) l WHERE l.player_id = v_x)
        IS NOT DISTINCT FROM (SELECT l.pool_session_id FROM public.fn_lightning_player_legality(v_l2, clock_timestamp(), NULL) l WHERE l.player_id = v_x) THEN
    RAISE EXCEPTION 'FAIL 03: legality listed a session of another Cluster';
  END IF;
END $$;
SELECT n AS p0_codes FROM harness.m6 WHERE k = 'p0_codes' \gset
\echo '  ok  03 P0 LEGALITY' :p0_codes 'reasons, one ordered CASE  each produced by flipping one fact of a legal human and of a legal horse and gone when it is not flipped; every code the function can answer was produced; a restriction binds only when the operator enforces it, for cash or the account, not while lifted; an exclusion binds only while current; an expired claim, a completed hand and a limit not reached leave the player legal; two facts give the first; RG_EXCLUDED equals the platform reader across seven row shapes; the anchor predicate refuses every anchor fact it names; every pool session is its own Cluster''s in table, scope, variant and stakes'

-- 04 THE DIAGNOSIS: EVERY PLAYER EXACTLY ONCE, IN EVERY STATE ----------------------
DO $$
DECLARE v_l uuid; v_x uuid; p jsonb; v_prob text; v_ids uuid[]; v_r jsonb; v_new uuid[]; v_states text[] := ARRAY[]::text[];
BEGIN
  SELECT game, a INTO v_l, v_x FROM harness.m6 WHERE k = 'L';
  -- All nineteen legal: four groups, 5/5/5/4, all MATCHED.
  p := harness.plan(v_l);
  IF harness.diag_problem(p, v_l) IS NOT NULL OR harness.sizes(p) IS DISTINCT FROM ARRAY[5,5,5,4]
     OR (p ->> 'legal_count')::integer IS DISTINCT FROM 19 THEN
    RAISE EXCEPTION 'FAIL 04: nineteen legal players did not make 5/5/5/4, all matched: % %', harness.diag_problem(p, v_l), harness.sizes(p);
  END IF;
  v_states := v_states || 'MATCHED'::text;
  -- WAITING_FOR_RECONNECT, and its twin.
  p := harness.plan(v_l, ARRAY[v_x]);
  IF harness.state(p, v_x) IS DISTINCT FROM 'WAITING_FOR_RECONNECT:DISCONNECTED' OR harness.diag_problem(p, v_l) IS NOT NULL
     OR harness.sizes(p) IS DISTINCT FROM ARRAY[6,6,6] THEN
    RAISE EXCEPTION 'FAIL 04: a disconnected player is not WAITING_FOR_RECONNECT, or the other eighteen are not 6/6/6: %', harness.state(p, v_x);
  END IF;
  v_states := v_states || 'WAITING_FOR_RECONNECT'::text;
  -- BLOCKED_WITH_REASON carries the P0 reason.
  v_prob := public.fx6_after(format('INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until) VALUES (%L, now() + interval %L)', v_x, '1 day'),
                             format('SELECT coalesce(harness.diag_problem(p, %L), harness.state(p, %L)) FROM harness.plan(%L) p', v_l, v_x, v_l));
  IF v_prob IS DISTINCT FROM 'BLOCKED_WITH_REASON:RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 04: an excluded player is not BLOCKED_WITH_REASON:RG_EXCLUDED: %', v_prob;
  END IF;
  v_states := v_states || 'BLOCKED_WITH_REASON'::text;
  -- WAITING_FOR_FORMATION for capacity: one hand per pass.
  v_prob := public.fx6_after(format('SELECT public.fx6_set(%L, %L)', v_l, '{"admission_batch_hands": 1}'),
    format($q$SELECT coalesce(harness.diag_problem(p, %L), array_to_string(harness.sizes(p), ',') || '/' ||
             (SELECT count(*) FROM jsonb_array_elements(p -> 'diagnosis') d WHERE d ->> 'state' = 'WAITING_FOR_FORMATION' AND d ->> 'reason_code' = 'PASS_CAPACITY'))
             FROM harness.plan(%L) p$q$, v_l, v_l));
  IF v_prob IS DISTINCT FROM '5/14' THEN
    RAISE EXCEPTION 'FAIL 04: one hand per pass did not seat 5 and hold 14 for capacity: %', v_prob;
  END IF;
  v_states := v_states || 'WAITING_FOR_FORMATION'::text;
  -- WAITING_FOR_FORMATION for sizing: a minimum of four and seven legal (the
  -- other twelve reported disconnected) seats six, and the seventh in queue
  -- order waits.
  v_ids := ARRAY(SELECT ps.player_id FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL
                 ORDER BY ps.player_id LIMIT 12);
  v_prob := public.fx6_after(format('SELECT public.fx6_set(%L, %L)', v_l, '{"instance_min": 4}'),
    format($q$SELECT coalesce(harness.diag_problem(p, %L), array_to_string(harness.sizes(p), ',') || '/' ||
             (SELECT string_agg(d ->> 'reason_code', ',') FROM jsonb_array_elements(p -> 'diagnosis') d WHERE d ->> 'state' = 'WAITING_FOR_FORMATION'))
             FROM (SELECT public.fn_lightning_match(%L, clock_timestamp(), %L::uuid[], NULL) AS p) q$q$, v_l, v_l, v_ids));
  IF v_prob IS DISTINCT FROM '6/GROUP_SIZING' THEN
    RAISE EXCEPTION 'FAIL 04: seven legal at a minimum of four did not seat six and hold one for sizing: %', v_prob;
  END IF;
  -- WAITING_FOR_PLAYERS: one legal player makes no hand.
  v_ids := ARRAY(SELECT ps.player_id FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL AND ps.player_id <> v_x);
  p := public.fn_lightning_match(v_l, clock_timestamp(), v_ids, NULL);
  IF harness.state(p, v_x) IS DISTINCT FROM 'WAITING_FOR_PLAYERS:NOT_ENOUGH_LEGAL_PLAYERS' OR jsonb_array_length(p -> 'groups') <> 0
     OR harness.diag_problem(p, v_l) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 04: a lone legal player was not WAITING_FOR_PLAYERS with no group: %', harness.state(p, v_x);
  END IF;
  v_states := v_states || 'WAITING_FOR_PLAYERS'::text;
  -- WAITING_FOR_BB: one real pass, then two players join; under the
  -- big_blind first-entry rule they wait for a big blind, and under any_seat
  -- they are dealt in.
  PERFORM public.fx6_set(v_l, '{"worker_mode": "form"}');
  v_r := harness.pass_and_complete(v_l);
  IF (v_r ->> 'formed')::integer IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'FAIL 04: the pass on nineteen did not form four hands: %', v_r;
  END IF;
  INSERT INTO harness.m6 (k, game) VALUES ('L_joined', v_l);
END $$;
-- The two newcomers sit down in their own transaction, so the deferred pool
-- door enters them at its commit, exactly as a buy-in does.
DO $$
DECLARE v_l uuid;
BEGIN
  SELECT game INTO v_l FROM harness.m6 WHERE k = 'L';
  UPDATE harness.m6 SET a = public.fxr_join(v_l, public.fxr_main(v_l), 30, 150.00, false, true),
                        b = public.fxr_join(v_l, public.fxr_main(v_l), 31, 160.00, true, true)
   WHERE k = 'L_joined';
END $$;
DO $$
DECLARE v_l uuid; v_new uuid[]; p jsonb; v_bad text;
BEGIN
  SELECT game INTO v_l FROM harness.m6 WHERE k = 'L';
  v_new := ARRAY(SELECT ts.user_id FROM public.table_seats ts WHERE ts.id IN (SELECT a FROM harness.m6 WHERE k = 'L_joined'
                                                                                UNION ALL SELECT b FROM harness.m6 WHERE k = 'L_joined'));
  IF (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_l AND ps.exited_at IS NULL AND ps.player_id = ANY (v_new)) <> 2 THEN
    RAISE EXCEPTION 'FAIL 04: the two newcomers did not enter the pool through the door';
  END IF;
  UPDATE harness.m6 SET j = to_jsonb(v_new) WHERE k = 'L_joined';
  PERFORM public.fx6_set(v_l, '{"first_entry_rule": "big_blind"}');
  p := harness.plan(v_l);
  SELECT string_agg(harness.state(p, n), ',') INTO v_bad FROM unnest(v_new) n;
  IF v_bad IS DISTINCT FROM 'WAITING_FOR_BB:FIRST_ENTRY_WAITS_FOR_BB,WAITING_FOR_BB:FIRST_ENTRY_WAITS_FOR_BB'
     OR harness.diag_problem(p, v_l) IS NOT NULL OR harness.sizes(p) IS DISTINCT FROM ARRAY[5,5,5,4] THEN
    RAISE EXCEPTION 'FAIL 04: the newcomers under the big_blind rule are % (sizes %)', v_bad, harness.sizes(p);
  END IF;
  PERFORM public.fx6_set(v_l, '{"first_entry_rule": "any_seat"}');
  p := harness.plan(v_l);
  SELECT string_agg(harness.state(p, n), ',') INTO v_bad FROM unnest(v_new) n;
  IF v_bad IS DISTINCT FROM 'MATCHED,MATCHED' OR harness.diag_problem(p, v_l) IS NOT NULL OR harness.sizes(p) IS DISTINCT FROM ARRAY[6,5,5,5] THEN
    RAISE EXCEPTION 'FAIL 04: the newcomers under any_seat are % (sizes %)', v_bad, harness.sizes(p);
  END IF;
END $$;
\echo '  ok  04 THE DIAGNOSIS  every open-pool player appears exactly once and MATCHED is exactly the grouped players, in every plan below; nineteen legal make 5/5/5/4 all MATCHED; a reported disconnect is WAITING_FOR_RECONNECT and the other eighteen make 6/6/6; an exclusion is BLOCKED_WITH_REASON with its code; one hand per pass holds fourteen as WAITING_FOR_FORMATION (PASS_CAPACITY); a minimum of four over seven legal seats six and holds one (GROUP_SIZING); a lone legal player is WAITING_FOR_PLAYERS; two newcomers wait as WAITING_FOR_BB under the big_blind rule without costing a hand, and are MATCHED under any_seat'

-- 05 P1: GROUP SIZES FOR EVERY COUNT FROM 0 TO 60 ------------------------------------
DO $$
DECLARE n integer; s integer[]; cfg integer[]; v_best numeric; k integer; v_seat integer; v_bad text; v_dist numeric;
BEGIN
  FOREACH cfg SLICE 1 IN ARRAY ARRAY[[2,6,6],[2,9,9],[2,4,6],[3,6,6],[4,6,6],[2,6,9]] LOOP
    FOR n IN 0 .. 60 LOOP
      s := public.fn_lightning_group_sizes(n, cfg[1], cfg[2], cfg[3]);
      v_seat := coalesce((SELECT sum(x) FROM unnest(s) x), 0)::integer;
      v_bad := CASE
        WHEN n < cfg[1] AND cardinality(s) <> 0 THEN 'a group below the minimum count'
        WHEN EXISTS (SELECT 1 FROM unnest(s) x WHERE x < cfg[1] OR x > cfg[3] OR x < 2) THEN 'a group outside [min, max] or of one'
        WHEN cardinality(s) > 0 AND (SELECT max(x) - min(x) FROM unnest(s) x) > 1 THEN 'sizes differ by more than one'
        WHEN s IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x DESC), ARRAY[]::integer[]) FROM unnest(s) x) THEN 'not larger first'
        WHEN v_seat > n THEN 'more seats than players'
        -- NOBODY LEFT OVER WHEN A SPLIT EXISTS, and no split seats more.
        WHEN EXISTS (SELECT 1 FROM generate_series(1, 60) kk WHERE kk * cfg[1] <= n AND LEAST(n, kk * cfg[3]) > v_seat) THEN 'another split seats more'
        -- THE FEWEST INSTANCES at the closest average to the target.
        WHEN v_seat = n AND n >= cfg[1] AND EXISTS (
               SELECT 1 FROM generate_series(1, 60) kk
                WHERE kk * cfg[1] <= n AND kk * cfg[3] >= n
                  AND (abs(n::numeric / kk - cfg[2]) < abs(n::numeric / cardinality(s) - cfg[2])
                       OR (abs(n::numeric / kk - cfg[2]) = abs(n::numeric / cardinality(s) - cfg[2]) AND kk < cardinality(s))))
          THEN 'a feasible count is closer to the target, or as close with fewer instances'
      END;
      IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL 05: min % target % max % legal %: % (sizes %)', cfg[1], cfg[2], cfg[3], n, v_bad, s;
      END IF;
      -- At the defaults everyone from two up is seated, in ceil(n / max) hands.
      IF cfg[1] = 2 AND cfg[2] = cfg[3] AND n >= 2
         AND (v_seat IS DISTINCT FROM n OR cardinality(s) IS DISTINCT FROM ceil(n::numeric / cfg[3])::integer) THEN
        RAISE EXCEPTION 'FAIL 05: at %-max, % legal players are not all seated in ceil(n/max) hands: %', cfg[3], n, s;
      END IF;
    END LOOP;
  END LOOP;
  -- THE FLOOR IS TWO WHATEVER THE CALLER ASKS: minimum 0, 1 or 2.
  IF EXISTS (SELECT 1 FROM generate_series(0, 60) nn, generate_series(0, 2) mm, generate_series(2, 9) xx,
                           unnest(public.fn_lightning_group_sizes(nn, mm, xx, xx)) z WHERE z < 2)
     OR public.fn_lightning_group_sizes(1, 0, 6, 6) IS DISTINCT FROM ARRAY[]::integer[]
     OR public.fn_lightning_group_sizes(1, 1, 6, 6) IS DISTINCT FROM ARRAY[]::integer[] THEN
    RAISE EXCEPTION 'FAIL 05: a minimum below two produced a group of one';
  END IF;
  IF public.fn_lightning_group_sizes(13, 2, 6, 6) IS DISTINCT FROM ARRAY[5,4,4]
     OR public.fn_lightning_group_sizes(7, 2, 6, 6) IS DISTINCT FROM ARRAY[4,3]
     OR public.fn_lightning_group_sizes(19, 2, 9, 9) IS DISTINCT FROM ARRAY[7,6,6]
     OR public.fn_lightning_group_sizes(7, 4, 6, 6) IS DISTINCT FROM ARRAY[6]
     OR public.fn_lightning_group_sizes(1, 2, 6, 6) IS DISTINCT FROM ARRAY[]::integer[]
     OR public.fn_lightning_group_sizes(13, 2, 4, 6) IS DISTINCT FROM ARRAY[5,4,4] THEN
    RAISE EXCEPTION 'FAIL 05: a documented example is wrong';
  END IF;
END $$;
\echo '  ok  05 P1 GROUP SIZES  for every legal count 0 to 60 at 6-max, 9-max and four other configurations: never a group of one or outside [min, max], sizes within one of each other and larger first, nobody left over whenever a split exists and no split seats more when none does, the fewest instances at the average closest to the target; at the defaults every count from 2 is fully seated in ceil(n/max) hands (13 -> 5/4/4, 7 -> 4/3, 19 at 9-max -> 7/6/6), a minimum of 4 over 7 seats 6, and a minimum of 0 or 1 still never yields a group below two for any count 0 to 60 at any size'

-- 06 P2: THE BARRIER AGREES WITH EVERY PLANNED BIG BLIND ------------------------------
DO $$
DECLARE v_l uuid; p jsonb; grp jsonb; r jsonb; v_top uuid[]; v_pl uuid[]; v_got text; v_d uuid;
BEGIN
  SELECT game INTO v_l FROM harness.m6 WHERE k = 'L';
  p := harness.plan(v_l);
  -- The k big blinds are the first k legal players in the barrier's own order.
  v_top := ARRAY(SELECT bo.player_id FROM public.fn_lightning_blind_order(v_l,
                   (SELECT cluster_epoch FROM public.cash_games WHERE id = v_l),
                   ARRAY(SELECT l.player_id FROM public.fn_lightning_player_legality(v_l, clock_timestamp(), NULL) l WHERE l.legal)) bo
                  ORDER BY bo.p2_rank LIMIT jsonb_array_length(p -> 'groups'));
  IF harness.bbs(p) IS DISTINCT FROM v_top THEN
    RAISE EXCEPTION 'FAIL 06: the planned big blinds % are not the first % in P2 order %', harness.bbs(p), jsonb_array_length(p -> 'groups'), v_top;
  END IF;
  -- The bad twin: the barrier refuses, as a group's big blind, a member of it
  -- who has already posted one (so is not P2-equivalent to the planned one).
  SELECT x, sl.player_id INTO grp, v_d
    FROM jsonb_array_elements(p -> 'groups') x
    JOIN public.lightning_pool_slot sl ON sl.cluster_id = v_l AND sl.closed_at IS NULL AND sl.last_bb_at IS NOT NULL
     AND sl.player_id::text IN (SELECT jsonb_array_elements_text(x -> 'players')) AND sl.player_id <> (x ->> 'bb')::uuid
   ORDER BY sl.player_id LIMIT 1;
  IF v_d IS NULL THEN
    RAISE EXCEPTION 'FAIL 06: no group holds a member who has posted a big blind, so the refusal would prove nothing';
  END IF;
  v_pl := ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(grp -> 'players') WITH ORDINALITY t(e, o) ORDER BY o);
  v_got := public.fx6_after(NULL, format($q$SELECT public.fn_lightning_form_hand(%L, %L::uuid[], %s::smallint, 6::smallint, %L, p_matcher_version => 'x') ->> 'reason'$q$,
                                   v_l, v_pl, cardinality(v_pl), v_d));
  IF v_got IS DISTINCT FROM 'bb_choice_is_not_p2_legal' THEN
    RAISE EXCEPTION 'FAIL 06: the barrier accepted a non-P2 big blind: %', v_got;
  END IF;
  -- EVERY PLANNED GROUP FORMS through the barrier, with the planned blinds and button.
  FOR grp IN SELECT x FROM jsonb_array_elements(p -> 'groups') x LOOP
    v_pl := ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(grp -> 'players') WITH ORDINALITY t(e, o) ORDER BY o);
    r := public.fn_lightning_form_hand(v_l, v_pl, cardinality(v_pl)::smallint, 6::smallint, (grp ->> 'bb')::uuid,
                                       p_matcher_version => 'fx6', p_request_id => gen_random_uuid());
    IF (r ->> 'formed')::boolean IS DISTINCT FROM true OR (r ->> 'bb') IS DISTINCT FROM (grp ->> 'bb')
       OR (r ->> 'sb') IS DISTINCT FROM (grp -> 'keys' -> 'p2' ->> 'sb')
       OR (r ->> 'btn') IS DISTINCT FROM (grp -> 'keys' -> 'p3' ->> 'btn')
       OR (r ->> 'players')::integer IS DISTINCT FROM cardinality(v_pl) THEN
      RAISE EXCEPTION 'FAIL 06: the barrier did not form a planned group as planned: plan % answer %', grp, r;
    END IF;
  END LOOP;
  PERFORM public.fx6_complete_all(v_l);
  -- A PLAYER OWING A BIG BLIND COMES FIRST, whatever their last_bb_at.
  SELECT sl.player_id INTO v_d FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_l AND sl.closed_at IS NULL AND sl.last_bb_at IS NOT NULL
   ORDER BY sl.last_bb_at DESC, sl.player_id LIMIT 1;
  IF (harness.bbs(harness.plan(v_l)))[1] IS NOT DISTINCT FROM v_d
     OR public.fx6_after(format('UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1 WHERE cluster_id = %L AND player_id = %L', v_l, v_d),
                         format('SELECT (harness.bbs(harness.plan(%L)))[1]::text', v_l)) IS DISTINCT FROM v_d::text THEN
    RAISE EXCEPTION 'FAIL 06: a player owing a big blind is not the first big blind, or already was without the debt';
  END IF;
END $$;
\echo '  ok  06 P2 BLIND FAIRNESS  the planned big blinds are exactly the first k legal players of fn_lightning_blind_order, the barrier''s own key; every planned group forms through fn_lightning_form_hand with the planned big blind, small blind and button; the barrier refuses the same group with a member who has already posted a big blind as its big blind; a player owing a big blind becomes the first big blind and was not without the debt'

-- 07 P4: THE QUEUE, KEY BY KEY -------------------------------------------------------
DO $$
DECLARE v_l uuid; v_t timestamptz; lvl record; v_got text; v_want text; v_idorder text; v_q text;
BEGIN
  SELECT game INTO v_l FROM harness.m6 WHERE k = 'L';
  PERFORM public.fx6_set(v_l, '{"admission_batch_hands": 1}');
  -- One hand per pass: its five non-blind seats go to the first five of the
  -- queue among the legal non-big-blind players.
  v_q := format($q$
    WITH p AS (SELECT harness.plan(%1$L) AS p),
    bb AS (SELECT (p -> 'groups' -> 0 ->> 'bb')::uuid AS bb FROM p),
    seated AS (SELECT string_agg(x, ',' ORDER BY x) AS s FROM p, bb, jsonb_array_elements_text(p -> 'groups' -> 0 -> 'players') x WHERE x::uuid <> bb.bb),
    q AS (SELECT sl.player_id FROM public.lightning_pool_slot sl
            JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
            JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id, bb
           WHERE sl.cluster_id = %1$L AND sl.closed_at IS NULL AND sl.player_id <> bb.bb
           ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, sl.player_id LIMIT 5)
    SELECT (SELECT s FROM seated) || '=' || (SELECT string_agg(player_id::text, ',' ORDER BY player_id::text) FROM q)$q$, v_l);
  v_idorder := format($q$SELECT string_agg(x::text, ',' ORDER BY x::text) FROM (SELECT sl.player_id AS x FROM public.lightning_pool_slot sl
    WHERE sl.cluster_id = %1$L AND sl.closed_at IS NULL AND sl.player_id <> (harness.plan(%1$L) -> 'groups' -> 0 ->> 'bb')::uuid
    ORDER BY sl.player_id LIMIT 5) z$q$, v_l);
  v_got := public.fx6_after(NULL, v_q);
  IF split_part(v_got, '=', 1) IS DISTINCT FROM split_part(v_got, '=', 2) THEN
    RAISE EXCEPTION 'FAIL 07: the seated players are not the head of the queue: %', v_got;
  END IF;
  SELECT max(sl.opened_at) INTO v_t FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_l AND sl.closed_at IS NULL;
  -- Each level decides when every level above it is tied, and is arranged
  -- against player_id so that the answer differs from the id order.
  FOR lvl IN SELECT * FROM (VALUES
    ('idle_since', format($s$UPDATE public.lightning_pool_slot sl SET idle_since = %1$L::timestamptz + (r.rk * interval '1 millisecond')
        FROM (SELECT id, row_number() OVER (ORDER BY player_id DESC) AS rk FROM public.lightning_pool_slot WHERE cluster_id = %2$L AND closed_at IS NULL) r
       WHERE sl.id = r.id$s$, v_t, v_l)),
    ('entered_at', format($s$UPDATE public.lightning_pool_slot SET idle_since = %1$L WHERE cluster_id = %2$L AND closed_at IS NULL;
       UPDATE public.lightning_pool_session ps SET entered_at = %1$L::timestamptz - interval '1 hour' + (r.rk * interval '1 millisecond')
         FROM (SELECT id, row_number() OVER (ORDER BY player_id DESC) AS rk FROM public.lightning_pool_session WHERE cluster_id = %2$L AND exited_at IS NULL) r
        WHERE ps.id = r.id$s$, v_t, v_l)),
    ('cluster join', format($s$UPDATE public.lightning_pool_slot SET idle_since = %1$L WHERE cluster_id = %2$L AND closed_at IS NULL;
       UPDATE public.lightning_pool_session SET entered_at = %1$L::timestamptz - interval '1 hour' WHERE cluster_id = %2$L AND exited_at IS NULL;
       UPDATE public.cash_player_session c SET opened_at = %1$L::timestamptz - interval '2 hours' + (r.rk * interval '1 millisecond')
         FROM (SELECT ps.cash_player_session_id AS id, row_number() OVER (ORDER BY ps.player_id DESC) AS rk
                 FROM public.lightning_pool_session ps WHERE ps.cluster_id = %2$L AND ps.exited_at IS NULL) r
        WHERE c.id = r.id$s$, v_t, v_l)),
    ('player_id', format($s$UPDATE public.lightning_pool_slot SET idle_since = %1$L WHERE cluster_id = %2$L AND closed_at IS NULL;
       UPDATE public.lightning_pool_session SET entered_at = %1$L::timestamptz - interval '1 hour' WHERE cluster_id = %2$L AND exited_at IS NULL;
       UPDATE public.cash_player_session SET opened_at = %1$L::timestamptz - interval '2 hours'
        WHERE id IN (SELECT cash_player_session_id FROM public.lightning_pool_session WHERE cluster_id = %2$L AND exited_at IS NULL)$s$, v_t, v_l))
  ) q(level, fact) LOOP
    v_got := public.fx6_after(lvl.fact, v_q || ' || ''#'' || (' || v_idorder || ')');
    IF split_part(split_part(v_got, '#', 1), '=', 1) IS DISTINCT FROM split_part(split_part(v_got, '#', 1), '=', 2) THEN
      RAISE EXCEPTION 'FAIL 07: with % deciding, the seated players are not the head of the queue: %', lvl.level, v_got;
    END IF;
    IF (lvl.level = 'player_id') IS DISTINCT FROM (split_part(split_part(v_got, '#', 1), '=', 1) = split_part(v_got, '#', 2)) THEN
      RAISE EXCEPTION 'FAIL 07: with % deciding, the seating % did not % the id order %', lvl.level,
        split_part(split_part(v_got, '#', 1), '=', 1), CASE WHEN lvl.level = 'player_id' THEN 'equal' ELSE 'differ from' END, split_part(v_got, '#', 2);
    END IF;
  END LOOP;
  PERFORM public.fx6_set(v_l, '{"admission_batch_hands": 32}');
END $$;
\echo '  ok  07 P4 QUEUE FAIRNESS  with one hand per pass the five non-blind seats go to the head of the queue; tied above, idle_since decides, then pool entry, then the Cluster join, then player_id - each level arranged against the id order and seating differently from it, and the last one seating exactly by it'

-- 08 P5: DIVERSITY IN A LARGE POOL, NONE IN A THIN ONE ---------------------------------
DO $$
DECLARE v_d uuid; v_d0 uuid; i integer; p_on jsonb; p_off jsonb; p_thin jsonb; r jsonb; v_rep_on bigint := 0; v_rep_off bigint := 0;
        v_score_on numeric := 0; v_score_off numeric := 0; p jsonb; v_med jsonb; v_t timestamptz;
BEGIN
  -- Two identical fifty-player pools (two horses each); history built with P5
  -- off in both.
  v_d  := public.fx6_cluster('D',  6, 48, 2);
  v_d0 := public.fx6_cluster('D0', 6, 48, 2);
  PERFORM public.fx6_set(v_d,  '{"worker_mode": "form", "diversity_weight_large": 0, "diversity_weight_medium": 0}');
  PERFORM public.fx6_set(v_d0, '{"worker_mode": "form", "diversity_weight_large": 0, "diversity_weight_medium": 0}');
  FOR i IN 1 .. 4 LOOP
    PERFORM harness.pass_and_complete(v_d);
    PERFORM harness.pass_and_complete(v_d0);
  END LOOP;
  v_t := clock_timestamp();
  p_off := public.fn_lightning_match(v_d, v_t, NULL, NULL);
  PERFORM public.fx6_set(v_d, '{"diversity_weight_large": 1, "diversity_weight_medium": 0.5}');
  p_on := public.fn_lightning_match(v_d, v_t, NULL, NULL);
  -- ONLY AMONG P4-EQUIVALENTS: same sizes, same big blinds in the same order,
  -- the same players seated; fewer repeated pairs.
  IF harness.sizes(p_on) IS DISTINCT FROM harness.sizes(p_off) OR harness.bbs(p_on) IS DISTINCT FROM harness.bbs(p_off)
     OR harness.grouped(p_on) IS DISTINCT FROM harness.grouped(p_off) OR harness.diag_problem(p_on, v_d) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 08: P5 changed a size, a big blind or who is seated';
  END IF;
  IF NOT ((SELECT sum((g -> 'keys' -> 'p5' ->> 'repeat_pairs')::integer) FROM jsonb_array_elements(p_on -> 'groups') g)
          < (SELECT sum((g -> 'keys' -> 'p5' ->> 'repeat_pairs')::integer) FROM jsonb_array_elements(p_off -> 'groups') g))
     OR NOT ((p_on ->> 'pool_diversity_score')::numeric > (p_off ->> 'pool_diversity_score')::numeric)
     OR (SELECT sum((g -> 'keys' -> 'p5' ->> 'moved_here')::integer) FROM jsonb_array_elements(p_on -> 'groups') g) = 0
     OR (SELECT sum((g -> 'keys' -> 'p5' ->> 'moved_here')::integer) FROM jsonb_array_elements(p_off -> 'groups') g) <> 0
     OR (p_on -> 'groups' -> 0 -> 'keys' -> 'p5' ->> 'band') IS DISTINCT FROM 'large' THEN
    RAISE EXCEPTION 'FAIL 08: P5 on did not reduce repeated pairs in a large pool: on % off %', p_on ->> 'pool_diversity_score', p_off ->> 'pool_diversity_score';
  END IF;
  -- MEDIUM IS SOFTER: at weight 0.5 no more players move than at weight 1.
  v_med := public.fx6_after(format('SELECT public.fx6_set(%L, %L)', v_d, '{"diversity_weight_large": 0.5}'),
                            format('SELECT public.fn_lightning_match(%L, %L, NULL, NULL)::text', v_d, v_t))::jsonb;
  IF (SELECT sum((g -> 'keys' -> 'p5' ->> 'moved_here')::integer) FROM jsonb_array_elements(v_med -> 'groups') g)
     > (SELECT sum((g -> 'keys' -> 'p5' ->> 'moved_here')::integer) FROM jsonb_array_elements(p_on -> 'groups') g) THEN
    RAISE EXCEPTION 'FAIL 08: half the weight moved more players';
  END IF;
  -- A THIN POOL: the same Cluster with the bands moved so fifty is thin forms
  -- exactly the P4 plan - P5 has no effect at all - and still seats everyone.
  p_thin := public.fx6_after(format('SELECT public.fx6_set(%L, %L)', v_d, '{"diversity_thin_min": 2, "diversity_medium_min": 100, "diversity_large_min": 200}'),
                             format('SELECT public.fn_lightning_match(%L, %L, NULL, NULL)::text', v_d, v_t))::jsonb;
  IF harness.sets(p_thin) IS DISTINCT FROM harness.sets(p_off) OR harness.sets(p_thin) IS NOT DISTINCT FROM harness.sets(p_on)
     OR (p_thin -> 'groups' -> 0 -> 'keys' -> 'p5' ->> 'band', p_thin -> 'groups' -> 0 -> 'keys' -> 'p5' ->> 'weight') IS DISTINCT FROM ('thin', '0')
     OR cardinality(harness.grouped(p_thin)) <> 50 THEN
    RAISE EXCEPTION 'FAIL 08: a thin pool was not formed exactly as P4 forms it, or did not seat all fifty';
  END IF;
  -- OVER TEN MORE PASSES, P5 on against its P5-off twin.
  FOR i IN 1 .. 10 LOOP
    r := harness.pass_and_complete(v_d);
    v_score_on := v_score_on + (r ->> 'pool_diversity_score')::numeric;
    r := harness.pass_and_complete(v_d0);
    v_score_off := v_score_off + (r ->> 'pool_diversity_score')::numeric;
  END LOOP;
  IF NOT (v_score_on > v_score_off) THEN
    RAISE EXCEPTION 'FAIL 08: over ten passes P5 on did not keep a higher diversity score (% against %)', v_score_on / 10, v_score_off / 10;
  END IF;
  INSERT INTO harness.m6 (k, game, t) VALUES ('D', v_d, round(v_score_on / 10, 4)::text || ' against ' || round(v_score_off / 10, 4)::text);
END $$;
-- 08 (CONTINUED): A REPEATED FULL TABLE, AND THE DIVERSITY MEASURES.
DO $$
DECLARE b1 uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); b2 uuid := gen_random_uuid();
        s2 uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); v_enc jsonb; v_set jsonb; v_both jsonb; r jsonb;
        v_d uuid; v_t timestamptz := clock_timestamp(); p jsonb; grp jsonb; v_members uuid[]; v_last integer; v_n integer;
BEGIN
  -- r1 has met each of the four blinds once, so every group costs it two
  -- pair encounters; only the table r1 would complete differs.
  SELECT jsonb_object_agg(LEAST(r1, x)::text || '/' || GREATEST(r1, x)::text, 1) INTO v_enc FROM unnest(ARRAY[b1, s1, b2, s2]) x;
  v_set := jsonb_build_object((SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[b1, s1, r1]) x), true);
  v_both := v_set || jsonb_build_object((SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[b2, s2, r1]) x), true);
  r := public.fn_lightning_diversity_assign(jsonb_build_array(jsonb_build_array(b1, s1), jsonb_build_array(b2, s2)), ARRAY[r1], ARRAY[1, 1], v_enc, v_set, 1);
  IF r -> 'moved' IS DISTINCT FROM '[0, 1]'::jsonb OR NOT ((r -> 'groups' -> 1) @> to_jsonb(ARRAY[r1])) THEN
    RAISE EXCEPTION 'FAIL 08: a player completing a recently repeated full table was not moved to the other group: %', r;
  END IF;
  IF (public.fn_lightning_diversity_assign(jsonb_build_array(jsonb_build_array(b1, s1), jsonb_build_array(b2, s2)), ARRAY[r1], ARRAY[1, 1], v_enc, '{}'::jsonb, 1) -> 'moved')
       IS DISTINCT FROM '[0, 0]'::jsonb
     OR (public.fn_lightning_diversity_assign(jsonb_build_array(jsonb_build_array(b1, s1), jsonb_build_array(b2, s2)), ARRAY[r1], ARRAY[1, 1], v_enc, v_set, 0) -> 'moved')
       IS DISTINCT FROM '[0, 0]'::jsonb
     OR (public.fn_lightning_diversity_assign(jsonb_build_array(jsonb_build_array(b1, s1), jsonb_build_array(b2, s2)), ARRAY[r1], ARRAY[1, 1], v_enc, v_both, 1) -> 'moved')
       IS DISTINCT FROM '[0, 0]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 08: the full-table penalty moved a player with no repeated table, at weight zero, or when both tables repeat';
  END IF;
  -- THE MEASURES, on a real plan of the large pool: consistent with each
  -- other, and the immediate-repeat rate recomputed from lightning_hand_player.
  SELECT game INTO v_d FROM harness.m6 WHERE k = 'D';
  p := public.fn_lightning_match(v_d, v_t, NULL, NULL);
  FOR grp IN SELECT x FROM jsonb_array_elements(p -> 'groups') x LOOP
    v_n := jsonb_array_length(grp -> 'players');
    IF ((grp -> 'keys' -> 'p5' ->> 'unique_opponents')::integer
          IS DISTINCT FROM (grp -> 'keys' -> 'p5' ->> 'pairs')::integer - (grp -> 'keys' -> 'p5' ->> 'repeat_pairs')::integer)
       OR ((grp -> 'keys' -> 'p5' ->> 'new_opponents_per_hand')::numeric
          IS DISTINCT FROM round(2 * (grp -> 'keys' -> 'p5' ->> 'unique_opponents')::numeric / v_n, 4))
       OR ((grp -> 'keys' -> 'p5' ->> 'repeat_pair_rate')::numeric
          IS DISTINCT FROM round((grp -> 'keys' -> 'p5' ->> 'repeat_pairs')::numeric / (grp -> 'keys' -> 'p5' ->> 'pairs')::numeric, 4))
       OR NOT ((grp -> 'keys' -> 'p5' ->> 'repeat_opponent_rate')::numeric BETWEEN 0 AND 1) THEN
      RAISE EXCEPTION 'FAIL 08: the diversity measures of a group disagree with each other: %', grp -> 'keys' -> 'p5';
    END IF;
  END LOOP;
  grp := p -> 'groups' -> 0;
  v_members := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(grp -> 'players') x);
  v_n := cardinality(v_members);
  WITH last AS (
    SELECT DISTINCT ON (hp.player_id) hp.player_id, hp.hand_id
      FROM public.lightning_hand_player hp JOIN public.lightning_hand h ON h.hand_id = hp.hand_id
     WHERE h.cluster_id = v_d AND h.formed_at <= v_t AND hp.player_id = ANY (v_members)
     ORDER BY hp.player_id, h.formed_at DESC, h.hand_id)
  SELECT count(*)::integer INTO v_last
    FROM last l JOIN public.lightning_hand_player o ON o.hand_id = l.hand_id AND o.player_id <> l.player_id
   WHERE o.player_id = ANY (v_members);
  IF (grp -> 'keys' -> 'p5' ->> 'repeat_opponent_rate')::numeric IS DISTINCT FROM round(v_last::numeric / (v_n * (v_n - 1)), 4) THEN
    RAISE EXCEPTION 'FAIL 08: repeat_opponent_rate % is not the % immediate repeats recounted from the hands', grp -> 'keys' -> 'p5' ->> 'repeat_opponent_rate', v_last;
  END IF;
END $$;
SELECT t AS p5_scores FROM harness.m6 WHERE k = 'D' \gset
\echo '  ok  08 P5 OPPONENT DIVERSITY  in a large pool of fifty P5 keeps every size, every big blind and everyone seated, moves players only among those seated in the same pass, and strictly reduces repeated pairs; half the weight moves no more; the same pool read as thin forms exactly the P4 plan and seats all fifty; over ten further passes the mean pool_diversity_score with P5 on beats its P5-off twin:' :p5_scores '; a player who would complete a recently repeated full table is moved when the pair penalty ties, and not when no table repeats, at weight zero, or when both do; every group carries unique_opponents, new_opponents_per_hand, repeat_pair_rate and repeat_opponent_rate, consistent with each other and the last recounted from the hands'

-- 09 P3: ORDER ONLY, NEVER MEMBERSHIP OR BLINDS ------------------------------------------
DO $$
DECLARE v_d uuid; v_t timestamptz := clock_timestamp(); p_on jsonb; p_off jsonb; grp jsonb; v_diff integer := 0; r jsonb; v_pl uuid[];
BEGIN
  SELECT game INTO v_d FROM harness.m6 WHERE k = 'D';
  p_on := public.fn_lightning_match(v_d, v_t, NULL, NULL);
  p_off := public.fx6_after(format('SELECT public.fx6_set(%L, %L)', v_d, '{"position_fairness": false}'),
                            format('SELECT public.fn_lightning_match(%L, %L, NULL, NULL)::text', v_d, v_t))::jsonb;
  IF harness.sets(p_on) IS DISTINCT FROM harness.sets(p_off) OR harness.bbs(p_on) IS DISTINCT FROM harness.bbs(p_off)
     OR (SELECT array_agg(g -> 'keys' -> 'p2' ->> 'sb' ORDER BY o) FROM jsonb_array_elements(p_on -> 'groups') WITH ORDINALITY t(g, o))
        IS DISTINCT FROM (SELECT array_agg(g -> 'keys' -> 'p2' ->> 'sb' ORDER BY o) FROM jsonb_array_elements(p_off -> 'groups') WITH ORDINALITY t(g, o)) THEN
    RAISE EXCEPTION 'FAIL 09: P3 changed a membership or a blind';
  END IF;
  SELECT count(*) INTO v_diff FROM jsonb_array_elements(p_on -> 'groups') WITH ORDINALITY a(g, o)
    JOIN jsonb_array_elements(p_off -> 'groups') WITH ORDINALITY b(g, o) USING (o)
   WHERE a.g -> 'players' IS DISTINCT FROM b.g -> 'players';
  IF v_diff = 0 THEN
    RAISE EXCEPTION 'FAIL 09: P3 on and off ordered every group identically, so the comparison proves nothing';
  END IF;
  -- The button is a non-blind member with the fewest buttons, and the barrier deals it so.
  FOR grp IN SELECT x FROM jsonb_array_elements(p_on -> 'groups') x WHERE jsonb_array_length(x -> 'players') > 2 LOOP
    IF (SELECT coalesce(bl.btn_count, 0) FROM public.lightning_blind_ledger bl WHERE bl.cluster_id = v_d AND bl.player_id = (grp -> 'keys' -> 'p3' ->> 'btn')::uuid)
       > (SELECT min(coalesce(bl.btn_count, 0)) FROM jsonb_array_elements_text(grp -> 'keys' -> 'p3' -> 'order') m
            LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id = v_d AND bl.player_id = m::uuid) THEN
      RAISE EXCEPTION 'FAIL 09: the planned button is not a fewest-buttons member: %', grp -> 'keys' -> 'p3';
    END IF;
  END LOOP;
  grp := p_on -> 'groups' -> 0;
  v_pl := ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(grp -> 'players') WITH ORDINALITY t(e, o) ORDER BY o);
  r := public.fn_lightning_form_hand(v_d, v_pl, cardinality(v_pl)::smallint, 6::smallint, (grp ->> 'bb')::uuid,
                                     p_matcher_version => 'fx6', p_request_id => gen_random_uuid());
  IF (r ->> 'btn') IS DISTINCT FROM (grp -> 'keys' -> 'p3' ->> 'btn') THEN
    RAISE EXCEPTION 'FAIL 09: the barrier dealt the button to % rather than the planned %', r ->> 'btn', grp -> 'keys' -> 'p3' ->> 'btn';
  END IF;
  PERFORM public.fx6_complete_all(v_d);
  INSERT INTO harness.m6 (k, n) VALUES ('p3_diff', v_diff);
END $$;
SELECT n AS p3_diff FROM harness.m6 WHERE k = 'p3_diff' \gset
\echo '  ok  09 P3 POSITION FAIRNESS  on and off, the plan has the same member sets, big blinds and small blinds; only the order of the non-blind seats moves (in' :p3_diff 'of nine groups); every planned button is a member with the fewest buttons, and the barrier deals the button to it'

-- 10 DETERMINISM ------------------------------------------------------------------------
DO $$
DECLARE v_d uuid; v_t timestamptz := clock_timestamp(); a text; b text; c text;
BEGIN
  SELECT game INTO v_d FROM harness.m6 WHERE k = 'D';
  a := public.fn_lightning_match(v_d, v_t, NULL, NULL)::text;
  b := public.fn_lightning_match(v_d, v_t, NULL, NULL)::text;
  c := public.fxr_other_ask(format('SELECT public.fn_lightning_match(%L, %L, NULL, NULL)::text', v_d, v_t));
  IF a IS DISTINCT FROM b OR a IS DISTINCT FROM c
     OR a IS DISTINCT FROM public.fn_lightning_match_plan(v_d, v_t, NULL, NULL, NULL)::text THEN
    RAISE EXCEPTION 'FAIL 10: the same snapshot planned twice, or from another backend, differs';
  END IF;
  IF (a::jsonb ->> 'generated_at')::timestamptz IS DISTINCT FROM v_t
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a::jsonb) k)
        IS DISTINCT FROM ARRAY['diagnosis', 'generated_at', 'groups', 'legal_count', 'matcher_version', 'pool_diversity_score'] THEN
    RAISE EXCEPTION 'FAIL 10: the output is not exactly the contract''s six keys stamped with p_now: %', (SELECT array_agg(k) FROM jsonb_object_keys(a::jsonb) k);
  END IF;
  IF (public.fn_lightning_match(v_d, v_t, NULL, 'm9') ->> 'matcher_version') IS DISTINCT FROM 'm9'
     OR (a::jsonb ->> 'matcher_version') IS DISTINCT FROM 'm1' THEN
    RAISE EXCEPTION 'FAIL 10: the matcher version is not the one asked for, or the configured one when none is';
  END IF;
END $$;
\echo '  ok  10 DETERMINISM  the same snapshot planned twice in this backend and once in another gives byte-identical jsonb, equal to the planner with the configured capacity; the output is exactly the six contract keys, stamped with p_now; the matcher version is the one asked for, else the configured one'

-- 11 THE WRITER -------------------------------------------------------------------------
DO $$
DECLARE v_w uuid; v_w2 uuid; v_f uuid; v_q uuid := gen_random_uuid(); r jsonb; r2 jsonb; v_n bigint; v_i bigint; v_e bigint;
BEGIN
  v_w := public.fx6_cluster('W', 6, 16, 2);
  -- DARK BY DEFAULT: off and shadow form nothing.
  v_i := (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = v_w);
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'reason', r ->> 'worker_mode') IS DISTINCT FROM ('worker_mode_is_not_form', 'off') THEN
    RAISE EXCEPTION 'FAIL 11: worker_mode off was not refused: %', r;
  END IF;
  PERFORM public.fx6_set(v_w, '{"worker_mode": "shadow"}');
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'reason') IS DISTINCT FROM 'worker_mode_is_not_form'
     OR jsonb_array_length(public.fn_lightning_match(v_w, clock_timestamp(), NULL, NULL) -> 'groups') <> 3
     OR (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = v_w) IS DISTINCT FROM v_i THEN
    RAISE EXCEPTION 'FAIL 11: shadow formed something, or cannot plan: %', r;
  END IF;
  -- FORM: three hands of six, the events, the pass record.
  PERFORM public.fx6_set(v_w, '{"worker_mode": "form"}');
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, v_q);
  IF (r ->> 'formed')::integer IS DISTINCT FROM 3 OR (r ->> 'replayed')::boolean IS DISTINCT FROM false
     OR (r -> 'states' ->> 'MATCHED')::integer IS DISTINCT FROM 18 OR (r ->> 'stopped_reason') IS DISTINCT FROM 'plan_exhausted'
     OR (SELECT count(*) FROM public.lightning_hand WHERE cluster_id = v_w AND player_count = 6) IS DISTINCT FROM 3::bigint THEN
    RAISE EXCEPTION 'FAIL 11: the pass did not form three hands of six: %', r;
  END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_w AND e.kind = 'matcher_assignment'
        AND e.payload ->> 'matcher_version' = 'm1' AND (e.payload ->> 'pass_request_id')::uuid = v_q
        AND e.request_id = (e.payload ->> 'request_id')::uuid) IS DISTINCT FROM 3::bigint
     OR (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_w AND e.kind = 'matcher_pass'
           AND e.request_id = v_q AND e.payload ->> 'matcher_version' = 'm1' AND (e.payload -> 'states' ->> 'MATCHED')::integer = 18) IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_w AND e.kind = 'matcher_pass') IS DISTINCT FROM 1::bigint
     OR (SELECT hands_formed FROM public.cash_cluster_matcher_pass WHERE request_id = v_q) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 11: not one matcher_assignment per hand and one matcher_pass per pass, with version and request id';
  END IF;
  -- The group request ids are derived from the pass's.
  IF (SELECT array_agg(h.request_id ORDER BY h.request_id) FROM public.lightning_hand h WHERE h.cluster_id = v_w)
     IS DISTINCT FROM (SELECT array_agg(md5(v_q::text || '/matcher_group/' || i)::uuid ORDER BY md5(v_q::text || '/matcher_group/' || i)::uuid)
                         FROM generate_series(1, 3) i) THEN
    RAISE EXCEPTION 'FAIL 11: the hands do not carry request ids derived from the pass''s';
  END IF;
  -- IDEMPOTENT ON THE REQUEST ID: the retry answers with the same hands and forms nothing.
  v_n := (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = v_w);
  v_e := (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_w);
  r2 := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, v_q);
  IF (r2 ->> 'replayed')::boolean IS DISTINCT FROM true OR (r2 - 'replayed') IS DISTINCT FROM (r - 'replayed')
     OR (SELECT count(*) FROM public.lightning_instance WHERE cluster_id = v_w) IS DISTINCT FROM v_n
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_w) IS DISTINCT FROM v_e THEN
    RAISE EXCEPTION 'FAIL 11: a retried request id was not answered with the recorded pass: %', r2;
  END IF;
  v_w2 := public.fx6_cluster('W2', 6, 16, 2);
  PERFORM public.fx6_set(v_w2, '{"worker_mode": "form"}');
  IF (public.fn_lightning_match_and_form(v_w2, clock_timestamp(), NULL, NULL, v_q) ->> 'reason') IS DISTINCT FROM 'request_id_belongs_to_another_cluster' THEN
    RAISE EXCEPTION 'FAIL 11: another Cluster''s request id was accepted';
  END IF;
  -- P6: three new instances, and the hands in them hold exactly their groups.
  IF (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id = v_w AND li.state = 'reserved') IS DISTINCT FROM 3::bigint
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'hands') h
                 WHERE (SELECT string_agg(hp.player_id::text, ',' ORDER BY hp.player_id::text) FROM public.lightning_hand_player hp
                         WHERE hp.hand_id = (h ->> 'hand_id')::uuid)
                       IS DISTINCT FROM (SELECT string_agg(x, ',' ORDER BY x) FROM jsonb_array_elements_text(h -> 'players') x)) THEN
    RAISE EXCEPTION 'FAIL 11: a hand does not hold exactly its planned group in its own new instance';
  END IF;
  PERFORM public.fx6_complete_all(v_w);
  -- BOUNDED BY p_max_hands.
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, 1, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 1 OR (r ->> 'stopped_reason') IS DISTINCT FROM 'max_hands'
     OR (r -> 'states' ->> 'WAITING_FOR_FORMATION')::integer IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL 11: p_max_hands 1 did not form one hand and hold twelve: %', r;
  END IF;
  PERFORM public.fx6_complete_all(v_w);
  INSERT INTO harness.m6 (k, game) VALUES ('W', v_w);
END $$;
-- A RACE IS RE-PLANNED; AN IMPOSSIBLE STATE STOPS THE PASS AND LEAVES IT FROZEN.
CREATE TRIGGER zz_fx6_raise BEFORE INSERT ON public.lightning_hand_player FOR EACH ROW EXECUTE FUNCTION public.fx6_raise();
CREATE TRIGGER zz_fx6_slow BEFORE INSERT ON public.lightning_hand FOR EACH ROW EXECUTE FUNCTION public.fx6_slow();
DO $$
DECLARE v_w uuid; v_f uuid; r jsonb;
BEGIN
  SELECT game INTO v_w FROM harness.m6 WHERE k = 'W';
  PERFORM public.fx6_arm('23505', 'lightning_reservation_one_active_per_player', 1);
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 3 OR (r ->> 'replans')::integer IS DISTINCT FROM 1
     OR jsonb_array_length(r -> 'retries') <> 1 OR (r -> 'retries' -> 0 ->> 'reason') IS DISTINCT FROM 'formation_refused'
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v_w) IS DISTINCT FROM 'lightning' THEN
    RAISE EXCEPTION 'FAIL 11: a race was not re-planned into three hands: %', r;
  END IF;
  PERFORM public.fx6_complete_all(v_w);
  -- max_replans 0: the same race stops the pass after the hands already formed.
  PERFORM public.fx6_set(v_w, '{"max_replans": 0}');
  PERFORM public.fx6_arm('23505', 'lightning_reservation_one_active_per_player', 1);
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 0 OR (r ->> 'stopped_reason') IS DISTINCT FROM 'max_replans' THEN
    RAISE EXCEPTION 'FAIL 11: max_replans 0 did not stop the pass at the first race: %', r;
  END IF;
  PERFORM public.fx6_set(v_w, '{"max_replans": 3}');
  -- THE TIME BUDGET: a hundred milliseconds, and a formation that takes 150.
  PERFORM public.fx6_set(v_w, '{"pass_time_budget_ms": 100}');
  PERFORM set_config('fx6.slow_ms', '150', true);
  r := public.fn_lightning_match_and_form(v_w, clock_timestamp(), NULL, NULL, gen_random_uuid());
  PERFORM set_config('fx6.slow_ms', '', true);
  IF (r ->> 'formed')::integer IS DISTINCT FROM 1 OR (r ->> 'stopped_reason') IS DISTINCT FROM 'time_budget' THEN
    RAISE EXCEPTION 'FAIL 11: the time budget did not stop the pass after one slow formation: %', r;
  END IF;
  PERFORM public.fx6_set(v_w, '{"pass_time_budget_ms": 750}');
  PERFORM public.fx6_complete_all(v_w);
  -- THE FREEZE: a check violation inside the barrier freezes the Cluster; the
  -- pass stops at once and says so, and the freeze is committed with it.
  v_f := public.fx6_cluster('WF', 6, 16, 2);
  PERFORM public.fx6_set(v_f, '{"worker_mode": "form"}');
  PERFORM public.fx6_arm('23514', NULL, 1);
  r := public.fn_lightning_match_and_form(v_f, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'frozen')::boolean IS DISTINCT FROM true OR (r ->> 'formed')::integer IS DISTINCT FROM 0
     OR (r ->> 'stopped_reason') IS DISTINCT FROM 'frozen' OR jsonb_array_length(r -> 'retries') <> 1
     OR (r -> 'retries' -> 0 ->> 'reason') IS DISTINCT FROM 'formation_invariant_failed' THEN
    RAISE EXCEPTION 'FAIL 11: an impossible state did not stop the pass as frozen: %', r;
  END IF;
  INSERT INTO harness.m6 (k, game) VALUES ('WF', v_f);
END $$;
DO $$
DECLARE v_f uuid; r jsonb;
BEGIN
  SELECT game INTO v_f FROM harness.m6 WHERE k = 'WF';
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_f) IS DISTINCT FROM 'frozen'
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_f AND kind = 'stack_invariant_failed')
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events WHERE game_id = v_f AND kind = 'matcher_pass' AND (payload ->> 'frozen')::boolean) THEN
    RAISE EXCEPTION 'FAIL 11: the freeze or its pass record was not committed';
  END IF;
  -- And the next pass on the frozen Cluster forms nothing: every player is BLOCKED CLUSTER_FROZEN.
  r := public.fn_lightning_match_and_form(v_f, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 0 OR (r -> 'reasons' ->> 'CLUSTER_FROZEN')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 11: a frozen Cluster was formed or not diagnosed: %', r;
  END IF;
END $$;
DROP TRIGGER zz_fx6_raise ON public.lightning_hand_player;
DROP TRIGGER zz_fx6_slow ON public.lightning_hand;
\echo '  ok  11 THE WRITER  off and shadow form nothing (shadow still plans); form makes three hands of six in three new instances holding exactly their groups, with one matcher_assignment per hand and one matcher_pass per pass carrying matcher_version and request id, the pass recorded, and hand request ids derived from the pass''s; the same request id is answered with the recorded pass and writes nothing, and is refused for another Cluster; p_max_hands bounds the pass; a race is re-planned into all three hands, max_replans 0 stops at the first; the time budget stops after one slow formation; an impossible state stops the pass at once as frozen, and the freeze and its pass record commit, after which the Cluster forms nothing and every player is BLOCKED CLUSTER_FROZEN'

-- 12 CONCURRENCY: A SECOND PASS WAITS FOR NOTHING AND RESERVES NOBODY TWICE -----------------
DO $$
DECLARE v_c uuid; r jsonb; v_t timestamptz; v_other text;
BEGIN
  v_c := public.fx6_cluster('C', 6, 16, 2);
  PERFORM public.fx6_set(v_c, '{"worker_mode": "form"}');
  INSERT INTO harness.m6 (k, game) VALUES ('C', v_c);
END $$;
DO $$
DECLARE v_c uuid; r jsonb; v_t timestamptz; v_other text;
BEGIN
  SELECT game INTO v_c FROM harness.m6 WHERE k = 'C';
  -- The other backend runs a pass and holds its transaction open.
  PERFORM public.fxr_other('BEGIN');
  v_other := public.fxr_other_ask(format('SELECT public.fn_lightning_match_and_form(%L, clock_timestamp(), NULL, NULL, gen_random_uuid()) ->> %L', v_c, 'formed'));
  IF v_other IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'FAIL 12: the other backend''s pass did not form three hands: %', v_other;
  END IF;
  v_t := clock_timestamp();
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'reason') IS DISTINCT FROM 'pass_in_progress' OR (r ->> 'formed')::integer IS DISTINCT FROM 0
     OR (r ->> 'recorded')::boolean IS DISTINCT FROM true OR clock_timestamp() - v_t > interval '1 second' THEN
    RAISE EXCEPTION 'FAIL 12: a pass during another pass did not answer pass_in_progress at once, recorded as news: % after %', r, clock_timestamp() - v_t;
  END IF;
  -- The same skip again is not news, and is not recorded.
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'reason') IS DISTINCT FROM 'pass_in_progress' OR (r ->> 'recorded')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 12: a repeated pass_in_progress was recorded again: %', r;
  END IF;
  PERFORM public.fxr_other('COMMIT');
  -- A ROW LOCK THAT IS NOT A PASS - the tick, a conversion - is waited for
  -- briefly and answered cluster_row_busy, never pass_in_progress.
  PERFORM public.fxr_other('BEGIN');
  IF public.fxr_other_ask(format('SELECT id::text FROM public.cash_games WHERE id = %L FOR UPDATE', v_c)) IS DISTINCT FROM v_c::text THEN
    RAISE EXCEPTION 'FAIL 12: the other backend could not hold the Cluster row';
  END IF;
  v_t := clock_timestamp();
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'reason') IS DISTINCT FROM 'cluster_row_busy' OR (r ->> 'formed')::integer IS DISTINCT FROM 0
     OR (r ->> 'recorded')::boolean IS DISTINCT FROM true
     OR clock_timestamp() - v_t < interval '150 milliseconds' OR clock_timestamp() - v_t > interval '1 second' THEN
    RAISE EXCEPTION 'FAIL 12: a held Cluster row did not answer cluster_row_busy after the short wait: % after %', r, clock_timestamp() - v_t;
  END IF;
  INSERT INTO harness.m6 (k, t) VALUES ('busy_ms', round(extract(epoch FROM clock_timestamp() - v_t) * 1000)::text);
  PERFORM public.fxr_other('ROLLBACK');
  -- After it commits, a pass sees everyone in hand and forms nothing.
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 0 OR (r -> 'reasons' ->> 'IN_HAND')::integer IS DISTINCT FROM 18 THEN
    RAISE EXCEPTION 'FAIL 12: after the other pass committed, a pass formed or misdiagnosed: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_reservation WHERE cluster_id = v_c AND state IN ('pending', 'committed')
              GROUP BY player_id HAVING count(*) > 1)
     OR (SELECT count(*) FROM public.lightning_reservation WHERE cluster_id = v_c AND state = 'committed') IS DISTINCT FROM 18::bigint THEN
    RAISE EXCEPTION 'FAIL 12: a player holds two reservations, or not everyone holds one';
  END IF;
  PERFORM public.fx6_complete_all(v_c);
  -- THE RACE CLUSTER for the two real psql processes that follow.
  INSERT INTO harness.m6 (k, game) VALUES ('RACE', public.fx6_cluster('RACE', 6, 28, 2));
  PERFORM public.fx6_set((SELECT game FROM harness.m6 WHERE k = 'RACE'), '{"worker_mode": "form"}');
END $$;
SELECT t AS busy_ms FROM harness.m6 WHERE k = 'busy_ms' \gset
\echo '  ok  12a CONCURRENCY IN ONE PROCESS  a pass while another backend''s pass holds the Cluster''s advisory lock answers pass_in_progress at once and forms nothing, recorded once as news and not again; a Cluster row held by something that is not a pass answers cluster_row_busy after' :busy_ms 'ms; once the other pass commits the next sees all eighteen IN_HAND; nobody holds two reservations'

-- 13 LAW 10.5: A HORSE IS MATCHED EXACTLY AS A HUMAN ---------------------------------------
DO $$
DECLARE v_l uuid; v_x uuid; v_h uuid; v_t timestamptz := clock_timestamp(); v_a text; v_b text;
BEGIN
  SELECT game, a, b INTO v_l, v_x, v_h FROM harness.m6 WHERE k = 'L';
  v_a := public.fn_lightning_match(v_l, v_t, NULL, NULL)::text;
  -- Swap who is a horse: the human gets a horse_id, the horse loses its own.
  v_b := public.fx6_after(format('UPDATE public.table_seats SET horse_id = gen_random_uuid() WHERE id = %L; UPDATE public.table_seats SET horse_id = NULL WHERE id = %L',
                               harness.who(v_l, v_x) ->> 'seat', harness.who(v_l, v_h) ->> 'seat'),
                        format('SELECT public.fn_lightning_match(%L, %L, NULL, NULL)::text', v_l, v_t));
  IF v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'FAIL 13: swapping who is a horse changed the plan';
  END IF;
  IF NOT (v_h = ANY (harness.grouped(v_a::jsonb))) THEN
    RAISE EXCEPTION 'FAIL 13: the horse was not matched';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname ~ '^fn_lightning_(config|player_legality|group_sizes|match|pool_slot_idle|reservation_end)'
                AND (pg_get_functiondef(p.oid) ~ 'is_horse' OR pg_get_functiondef(p.oid) ~ 'horse_id')) THEN
    RAISE EXCEPTION 'FAIL 13: a body of the file mentions a horse';
  END IF;
END $$;
\echo '  ok  13 LAW 10.5, A HORSE IS A PLAYER  swapping which of two players is a horse leaves the plan byte-identical, the horse is matched, section 03 proved every P0 reason on a horse exactly as on a human, and no body of the file mentions is_horse or horse_id'

-- 14 SPEC PHASE 4 ACCEPTANCE, THEN ONE PASS ---------------------------------------------------
DO $$
DECLARE v17 uuid; v18 uuid; v26 uuid; v27 uuid; r jsonb;
BEGIN
  v17 := public.fx9_cluster('A17', 6, 40, true);
  PERFORM public.fx9_seat(v17, 15, 1, false); PERFORM public.fx9_seat(v17, 2, 16, true);
  r := public.fn_cash_cluster_begin_pending_on(v17, gen_random_uuid());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false OR (r ->> 'reason') IS DISTINCT FROM 'threshold_not_reached'
     OR (SELECT cluster_mode FROM public.cash_games WHERE id = v17) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 14: 6-max 17 did not remain must-move: %', r;
  END IF;
  v18 := public.fx6_cluster('A18', 6, 16, 2);
  PERFORM public.fx6_set(v18, '{"worker_mode": "form"}');
  r := public.fn_lightning_match_and_form(v18, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 3
     OR (SELECT array_agg(player_count ORDER BY player_count) FROM public.lightning_hand WHERE cluster_id = v18) IS DISTINCT FROM ARRAY[6,6,6]::smallint[] THEN
    RAISE EXCEPTION 'FAIL 14: 6-max 18 converted but one pass did not form 3 hands of 6: %', r;
  END IF;
  v26 := public.fx9_cluster('A26', 9, 40, true);
  PERFORM public.fx9_seat(v26, 24, 1, false); PERFORM public.fx9_seat(v26, 2, 25, true);
  r := public.fn_cash_cluster_begin_pending_on(v26, gen_random_uuid());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false OR (SELECT cluster_mode FROM public.cash_games WHERE id = v26) IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'FAIL 14: 9-max 26 did not remain must-move: %', r;
  END IF;
  v27 := public.fx6_cluster('A27', 9, 25, 2);
  PERFORM public.fx6_set(v27, '{"worker_mode": "form"}');
  r := public.fn_lightning_match_and_form(v27, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer IS DISTINCT FROM 3
     OR (SELECT array_agg(player_count ORDER BY player_count) FROM public.lightning_hand WHERE cluster_id = v27) IS DISTINCT FROM ARRAY[9,9,9]::smallint[] THEN
    RAISE EXCEPTION 'FAIL 14: 9-max 27 converted but one pass did not form 3 hands of 9: %', r;
  END IF;
END $$;
\echo '  ok  14 SPEC PHASE 4 ACCEPTANCE  6-max 17 remains must-move and 18 converts, after which one matcher pass forms three hands of six; 9-max 26 remains must-move and 27 converts, after which one pass forms three hands of nine'

-- 19 IDLE_SINCE: ONLY A HAND THAT WAS DEALT MOVES A PLAYER'S QUEUE PLACE ---------------
DO $$
DECLARE v_i uuid; v_r jsonb; v_players uuid[]; v_before text; v_after text; v_inst uuid; w jsonb; v_p uuid;
BEGIN
  v_i := public.fx6_cluster('IDLE', 6, 16, 2);
  -- A formation abandoned before it is dealt: released, idle_since unchanged.
  v_players := public.fx9_candidates(v_i, 6);
  SELECT string_agg(sl.idle_since::text, ',' ORDER BY sl.player_id) INTO v_before
    FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_i AND sl.closed_at IS NULL AND sl.player_id = ANY (v_players);
  v_r := public.fxr_form(v_i, v_players);
  PERFORM pg_sleep(0.01);
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'fx6: never dealt');
  SELECT string_agg(sl.idle_since::text, ',' ORDER BY sl.player_id) INTO v_after
    FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_i AND sl.closed_at IS NULL AND sl.player_id = ANY (v_players);
  IF v_after IS DISTINCT FROM v_before
     OR (SELECT count(*) FROM public.lightning_reservation WHERE lightning_instance_id = (v_r ->> 'instance_id')::uuid AND state = 'released') <> 6 THEN
    RAISE EXCEPTION 'FAIL 19: a formation abandoned before dealing moved its players'' queue place, or released nobody';
  END IF;
  -- A pending claim the reaper expires: unchanged.
  v_p := v_players[1];
  w := harness.who(v_i, v_p);
  v_before := (SELECT idle_since::text FROM public.lightning_pool_slot WHERE id = (w ->> 'slot')::uuid);
  v_inst := (public.fn_lightning_instance_open(v_i) ->> 'instance_id')::uuid;
  INSERT INTO public.lightning_reservation (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, seat_number, state, created_at, expires_at)
  VALUES (v_i, (w ->> 'epoch')::integer, v_p, (w ->> 'slot')::uuid, v_inst, 1, 'pending', clock_timestamp() - interval '1 minute', clock_timestamp() - interval '1 second');
  PERFORM public.fn_lightning_reap_formations(clock_timestamp());
  IF (SELECT state FROM public.lightning_reservation WHERE lightning_instance_id = v_inst AND player_id = v_p) IS DISTINCT FROM 'expired'
     OR (SELECT idle_since::text FROM public.lightning_pool_slot WHERE id = (w ->> 'slot')::uuid) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL 19: an expired claim moved the player''s queue place, or did not expire';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'fx6: the empty instance');
  -- THE TWINS: dealt then abandoned mid-hand, and dealt then completed - both move it forward.
  v_r := public.fxr_form(v_i, v_players);
  PERFORM public.fn_lightning_instance_begin_dealing((v_r ->> 'instance_id')::uuid);
  PERFORM pg_sleep(0.01);
  PERFORM public.fn_lightning_instance_abandon((v_r ->> 'instance_id')::uuid, 'fx6: voided mid-hand');
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
              WHERE sl.cluster_id = v_i AND sl.closed_at IS NULL AND sl.player_id = ANY (v_players)
                AND sl.idle_since IS DISTINCT FROM (SELECT r.resolved_at FROM public.lightning_reservation r
                                                     WHERE r.lightning_instance_id = (v_r ->> 'instance_id')::uuid AND r.player_id = sl.player_id)) THEN
    RAISE EXCEPTION 'FAIL 19: a hand abandoned after it was dealt did not move its players to the back of the queue';
  END IF;
  v_r := public.fxr_form(v_i, v_players);
  PERFORM pg_sleep(0.01);
  PERFORM public.fx6_complete((v_r ->> 'instance_id')::uuid);
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
              WHERE sl.cluster_id = v_i AND sl.closed_at IS NULL AND sl.player_id = ANY (v_players)
                AND sl.idle_since IS DISTINCT FROM (SELECT r.resolved_at FROM public.lightning_reservation r
                                                     WHERE r.lightning_instance_id = (v_r ->> 'instance_id')::uuid AND r.player_id = sl.player_id)) THEN
    RAISE EXCEPTION 'FAIL 19: a completed hand did not move its players to the back of the queue';
  END IF;
END $$;
\echo '  ok  19 IDLE_SINCE KEEPS THE PLACE OF A HAND NEVER DEALT  a formation abandoned before dealing releases its six and leaves every idle_since where it was, as does a pending claim the reaper expires; the same six dealt and then voided, and dealt and then completed, each go to the back of the queue at their release'

-- 20 A PASS IS RECORDED ONLY WHEN SOMETHING HAPPENED; THE RECORD IS PRUNED ----------------
DO $$
DECLARE v_q uuid; v_x uuid; r jsonb; v_req uuid; v_rows bigint; v_events bigint; v_w uuid; v_left bigint; v_err text; v_oldest uuid[];
BEGIN
  v_q := public.fx6_cluster('REC', 6, 16, 2);
  PERFORM public.fx6_set(v_q, '{"worker_mode": "form"}');
  SELECT ps.player_id INTO v_x FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_q AND ps.exited_at IS NULL ORDER BY ps.player_id LIMIT 1;
  -- A pass that forms: recorded.
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer <> 3 OR (r ->> 'recorded')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 20: a forming pass was not recorded: %', r;
  END IF;
  -- Everyone now in hand: a new diagnosis, recorded although nothing formed.
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'formed')::integer <> 0 OR (r ->> 'recorded')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 20: a changed diagnosis was not recorded: %', r;
  END IF;
  v_rows := (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q);
  v_events := (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_q AND kind = 'matcher_pass');
  -- The same again: not news, nothing written - and its request id is not
  -- remembered, so the same request simply runs again.
  v_req := gen_random_uuid();
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), NULL, NULL, v_req);
  IF (r ->> 'recorded')::boolean IS DISTINCT FROM false OR (r ->> 'formed')::integer <> 0
     OR (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q) <> v_rows
     OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id = v_q AND kind = 'matcher_pass') <> v_events THEN
    RAISE EXCEPTION 'FAIL 20: an unchanged empty pass wrote a record or an event: %', r;
  END IF;
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), NULL, NULL, v_req);
  IF (r ->> 'replayed')::boolean IS DISTINCT FROM false OR (r ->> 'recorded')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 20: an unrecorded pass''s request id was replayed rather than run: %', r;
  END IF;
  -- One player reported disconnected: the counts change, so it is news.
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), ARRAY[v_x], NULL, gen_random_uuid());
  IF (r ->> 'recorded')::boolean IS DISTINCT FROM true OR (r -> 'reasons' ->> 'DISCONNECTED')::integer IS DISTINCT FROM 1
     OR (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q) <> v_rows + 1 THEN
    RAISE EXCEPTION 'FAIL 20: a changed diagnosis with nothing formed was not recorded: %', r;
  END IF;
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), ARRAY[v_x], NULL, gen_random_uuid());
  IF (r ->> 'recorded')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 20: the same disconnected diagnosis was recorded twice';
  END IF;
  -- RETENTION: five of this Cluster's records and one of another's aged past
  -- a one-hour retention; each recorded pass prunes at most two of this
  -- Cluster's, oldest first, and never another Cluster's.
  SELECT game INTO v_w FROM harness.m6 WHERE k = 'W';
  PERFORM public.fx6_set(v_q, '{"pass_record_retention_hours": 1, "pass_record_prune_batch": 2}');
  INSERT INTO public.cash_cluster_matcher_pass (request_id, cluster_id, cluster_epoch, matcher_version, started_at, finished_at, hands_formed, result)
  SELECT gen_random_uuid(), c, 1, 'm1', clock_timestamp() - interval '2 hours' - (i * interval '1 minute'),
         clock_timestamp() - interval '2 hours' - (i * interval '1 minute'), 0, '{"fx6": "aged"}'::jsonb
    FROM (SELECT v_q AS c, i FROM generate_series(1, 5) i UNION ALL SELECT v_w, 1) z;
  v_oldest := ARRAY(SELECT request_id FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q AND result ->> 'fx6' = 'aged'
                     ORDER BY started_at, request_id LIMIT 2);
  r := public.fn_lightning_match_and_form(v_q, clock_timestamp(), NULL, NULL, gen_random_uuid());
  v_left := (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q AND result ->> 'fx6' = 'aged');
  IF (r ->> 'recorded')::boolean IS DISTINCT FROM true OR (r ->> 'pruned')::integer IS DISTINCT FROM 2 OR v_left <> 3
     OR (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_w AND result ->> 'fx6' = 'aged') <> 1
     OR EXISTS (SELECT 1 FROM public.cash_cluster_matcher_pass WHERE request_id = ANY (v_oldest)) THEN
    RAISE EXCEPTION 'FAIL 20: a recorded pass did not prune exactly the two oldest aged records of its own Cluster: % left %', r, v_left;
  END IF;
  -- service_role may not delete a record itself; only the prune can.
  SET LOCAL ROLE service_role;
  BEGIN
    DELETE FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q;
    v_err := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_err := SQLSTATE;
  END;
  RESET ROLE;
  IF v_err IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FAIL 20: service_role deleted pass records directly: %', v_err;
  END IF;
  INSERT INTO harness.m6 (k, n) VALUES ('rec_rows', (SELECT count(*) FROM public.cash_cluster_matcher_pass WHERE cluster_id = v_q));
END $$;
\echo '  ok  20 A PASS IS RECORDED ONLY WHEN SOMETHING HAPPENED  a forming pass and a pass whose diagnosis changed are recorded (event and row); the same empty pass again writes nothing and its request id simply runs again; a disconnect that changes the counts is recorded once and not twice; with a one-hour retention and a batch of two, a recorded pass prunes exactly the two oldest aged records of its own Cluster and none of another; service_role cannot delete a record except through the prune'
ASSERT

# ===========================================================================
# 12b THE RACE: two real psql processes, started together, each running
# twenty matcher passes on the same Cluster and completing its own hands.
# ===========================================================================
cat > "$fixture/race.sql" <<'ASSERT'
DO $$
DECLARE v_g uuid; r jsonb; h jsonb; i integer;
BEGIN
  SELECT game INTO v_g FROM harness.m6 WHERE k = 'RACE';
  FOR i IN 1 .. 20 LOOP
    r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, NULL, gen_random_uuid());
    -- BEFORE THIS PASS COMMITS, with the other process's committed work in
    -- view: nobody in the Cluster holds two live reservations.
    IF EXISTS (SELECT 1 FROM public.lightning_reservation WHERE cluster_id = v_g AND state IN ('pending', 'committed')
                GROUP BY player_id HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'FAIL 12: a player holds two live reservations after pass % of backend %', i, pg_backend_pid();
    END IF;
    INSERT INTO harness.m6 (k, game, n, j) VALUES ('race:' || pg_backend_pid() || ':' || i, v_g, (r ->> 'formed')::integer, r - 'hands');
    COMMIT;
    FOR h IN SELECT x FROM jsonb_array_elements(r -> 'hands') x LOOP
      PERFORM public.fx6_complete((h ->> 'instance_id')::uuid);
    END LOOP;
    COMMIT;
  END LOOP;
END $$;
ASSERT
cat > "$fixture/race-check.sql" <<'ASSERT'
DO $$
DECLARE v_g uuid; v_passes bigint; v_formed bigint; v_skipped bigint; v_pids bigint;
BEGIN
  SELECT game INTO v_g FROM harness.m6 WHERE k = 'RACE';
  SELECT count(*), sum(n), count(*) FILTER (WHERE j ->> 'reason' = 'pass_in_progress'),
         count(DISTINCT split_part(k, ':', 2))
    INTO v_passes, v_formed, v_skipped, v_pids
    FROM harness.m6 WHERE k LIKE 'race:%';
  IF v_passes <> 40 OR v_pids <> 2 THEN
    RAISE EXCEPTION 'FAIL 12: the two processes did not both run twenty passes (% passes from % backends)', v_passes, v_pids;
  END IF;
  -- EVERY HAND FORMED IS ACCOUNTED FOR BY A PASS, AND NO PLAYER WAS EVER IN
  -- TWO LIVE HANDS: no two committed reservations of one player overlap.
  IF v_formed IS DISTINCT FROM (SELECT count(*) FROM public.lightning_hand WHERE cluster_id = v_g) OR v_formed < 20 THEN
    RAISE EXCEPTION 'FAIL 12: the passes formed % hands and the Cluster holds %', v_formed, (SELECT count(*) FROM public.lightning_hand WHERE cluster_id = v_g);
  END IF;
  -- EVERY HAND'S PLAYERS were each reserved once for it, committed, and released.
  IF EXISTS (SELECT 1 FROM public.lightning_hand h
              WHERE h.cluster_id = v_g
                AND (SELECT count(*) FROM public.lightning_reservation r
                      WHERE r.lightning_instance_id = h.lightning_instance_id AND r.state = 'released')
                    IS DISTINCT FROM h.player_count::bigint) THEN
    RAISE EXCEPTION 'FAIL 12: a hand''s reservations are not exactly its players, released';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_reservation WHERE cluster_id = v_g AND state IN ('pending', 'committed')) THEN
    RAISE EXCEPTION 'FAIL 12: a reservation was left live after both processes completed their hands';
  END IF;
  INSERT INTO harness.m6 (k, n, t) VALUES ('race_summary', v_formed, v_skipped::text);
END $$;
SELECT n AS race_hands, t AS race_skipped FROM harness.m6 WHERE k = 'race_summary' \gset
\echo '  ok  12b CONCURRENCY ACROSS TWO PROCESSES  two psql processes started together ran forty passes on one Cluster:' :race_hands 'hands formed, every one accounted for by a pass and reserved, committed and released exactly once per player,' :race_skipped 'passes answered pass_in_progress, no pass ever committed with a player holding two live reservations, and nothing was left reserved'
ASSERT

# ===========================================================================
# 15 THE FAIRNESS SIMULATION (spec Phase 7).
# ===========================================================================
cat > "$fixture/sim.sql" <<ASSERT
CREATE TABLE harness.sim_hand (pop text, round integer, hand_id uuid PRIMARY KEY, groups integer, legal integer);
CREATE TABLE harness.sim_legal (pop text, round integer, player_id uuid, groups integer, legal integer);
DO \$\$
DECLARE v_g uuid; pop record; r jsonb; h jsonb; i integer; v_disc uuid[]; v_players uuid[];
BEGIN
  FOR pop IN SELECT * FROM (VALUES ('S18', 16, 2, false), ('S25', 24, 1, false), ('S50', 48, 2, false), ('C25', 23, 2, true)) q(k, humans, horses, churn) LOOP
    v_g := public.fx6_cluster(pop.k, 6, pop.humans, pop.horses);
    PERFORM public.fx6_set(v_g, '{"worker_mode": "form"}');
    INSERT INTO harness.m6 (k, game) VALUES ('sim:' || pop.k, v_g);
    v_players := public.fx6_players(v_g);
    COMMIT;
    FOR i IN 1 .. CASE WHEN pop.churn THEN GREATEST(${rounds} / 3, 30) ELSE ${rounds} END LOOP
      -- THE CHURN RUN: about one player in nine is reported disconnected each
      -- round, a different one each time.
      v_disc := CASE WHEN pop.churn THEN ARRAY(SELECT v_players[k] FROM generate_subscripts(v_players, 1) k WHERE (i + k) % 9 = 0) ELSE NULL END;
      r := public.fn_lightning_match_and_form(v_g, clock_timestamp(), v_disc, NULL, gen_random_uuid());
      IF (r ->> 'formed')::integer IS DISTINCT FROM (r ->> 'planned_groups')::integer
         OR (r -> 'states' ->> 'MATCHED')::integer IS DISTINCT FROM (r ->> 'legal_count')::integer THEN
        RAISE EXCEPTION 'FAIL 15: round % of % did not seat every legal player: %', i, pop.k, r - 'hands';
      END IF;
      INSERT INTO harness.sim_hand SELECT pop.k, i, (x ->> 'hand_id')::uuid, (r ->> 'formed')::integer, (r ->> 'legal_count')::integer
        FROM jsonb_array_elements(r -> 'hands') x;
      IF pop.churn THEN
        INSERT INTO harness.sim_legal SELECT pop.k, i, p, (r ->> 'formed')::integer, (r ->> 'legal_count')::integer
          FROM unnest(v_players) p WHERE NOT (p = ANY (v_disc));
      END IF;
      FOR h IN SELECT x FROM jsonb_array_elements(r -> 'hands') x LOOP
        PERFORM public.fx6_complete((h ->> 'instance_id')::uuid);
      END LOOP;
      COMMIT;
    END LOOP;
  END LOOP;
END \$\$;
ASSERT
cat >> "$fixture/sim.sql" <<'ASSERT'
-- THE METRICS. Per player, from lightning_hand_player of the simulated hands.
CREATE TABLE harness.sim_metrics AS
WITH hp AS (
  SELECT s.pop, s.round, s.groups, s.legal, hp.player_id, hp.blind_role, hp."position",
         (ts.horse_id IS NOT NULL) AS horse
    FROM harness.sim_hand s
    JOIN public.lightning_hand_player hp ON hp.hand_id = s.hand_id
    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
    JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
), per AS (
  SELECT pop, player_id, bool_or(horse) AS horse, count(*) AS hands,
         count(*) FILTER (WHERE blind_role = 'bb') AS bb, count(*) FILTER (WHERE blind_role = 'sb') AS sb,
         count(*) FILTER (WHERE "position" = 'btn') AS btn, count(*) FILTER (WHERE "position" = 'co') AS co,
         count(*) FILTER (WHERE "position" = 'hj') AS hj, count(*) FILTER (WHERE "position" = 'utg') AS utg
    FROM hp GROUP BY pop, player_id
), gaps AS (
  SELECT pop, player_id, round - lag(round) OVER (PARTITION BY pop, player_id ORDER BY round) AS gap
    FROM hp WHERE blind_role = 'bb'
)
SELECT per.*, (SELECT max(g.gap) FROM gaps g WHERE g.pop = per.pop AND g.player_id = per.player_id) AS max_gap,
       (SELECT min(g.gap) FROM gaps g WHERE g.pop = per.pop AND g.player_id = per.player_id) AS min_gap
  FROM per;
CREATE TABLE harness.sim_summary AS
SELECT m.pop, count(*) AS players, count(*) FILTER (WHERE m.horse) AS horses,
       (SELECT count(DISTINCT round) FROM harness.sim_hand s WHERE s.pop = m.pop) AS rounds,
       (SELECT count(*) FROM harness.sim_hand s WHERE s.pop = m.pop) AS hands,
       (SELECT max(groups) FROM harness.sim_hand s WHERE s.pop = m.pop) AS k,
       min(m.bb) AS bb_min, max(m.bb) AS bb_max, round(stddev_pop(m.bb), 3) AS bb_sd,
       min(m.sb) AS sb_min, max(m.sb) AS sb_max, round(stddev_pop(m.sb), 3) AS sb_sd,
       min(m.btn) AS btn_min, max(m.btn) AS btn_max, round(stddev_pop(m.btn), 3) AS btn_sd,
       min(m.co) AS co_min, max(m.co) AS co_max, min(m.hj) AS hj_min, max(m.hj) AS hj_max,
       min(m.utg) AS utg_min, max(m.utg) AS utg_max,
       max(m.max_gap) AS bb_gap_max, min(m.min_gap) AS bb_gap_min,
       min(m.bb) FILTER (WHERE m.horse) AS horse_bb_min, max(m.bb) FILTER (WHERE m.horse) AS horse_bb_max
  FROM harness.sim_metrics m GROUP BY m.pop;
-- The repeat-opponent rate: of each player's consecutive hands, the share of
-- opponents in the next hand who were also in the previous one.
CREATE TABLE harness.sim_repeat AS
WITH hp AS (
  SELECT s.pop, s.round, hp.hand_id, hp.player_id FROM harness.sim_hand s JOIN public.lightning_hand_player hp ON hp.hand_id = s.hand_id
), seq AS (
  SELECT pop, player_id, hand_id, lag(hand_id) OVER (PARTITION BY pop, player_id ORDER BY round) AS prev FROM hp
)
SELECT q.pop, round(avg(q.rep), 4) AS repeat_opponent_rate FROM (
  SELECT seq.pop, (SELECT count(*) FROM public.lightning_hand_player a JOIN public.lightning_hand_player b
                     ON b.hand_id = seq.prev AND b.player_id = a.player_id
                    WHERE a.hand_id = seq.hand_id AND a.player_id <> seq.player_id)::numeric
                  / NULLIF((SELECT count(*) FROM public.lightning_hand_player a WHERE a.hand_id = seq.hand_id AND a.player_id <> seq.player_id), 0) AS rep
    FROM seq WHERE seq.prev IS NOT NULL) q GROUP BY q.pop;

DO $$
DECLARE s record; v_dev numeric;
BEGIN
  FOR s IN SELECT * FROM harness.sim_summary WHERE pop IN ('S18', 'S25', 'S50') LOOP
    -- EVERY ROUND FORMED ceil(n/6) HANDS: nobody idle.
    IF s.hands IS DISTINCT FROM s.rounds * ceil(s.players::numeric / 6)::bigint OR s.horses < 1 THEN
      RAISE EXCEPTION 'FAIL 15: % formed % hands in % rounds of % players (% horses)', s.pop, s.hands, s.rounds, s.players, s.horses;
    END IF;
    -- BB BURDEN: the k oldest big blinds each round is a strict rotation, so
    -- no two players' counts differ by more than one, horses included.
    IF s.bb_max - s.bb_min > 1 THEN
      RAISE EXCEPTION 'FAIL 15: % big-blind counts range % to %', s.pop, s.bb_min, s.bb_max;
    END IF;
    -- THE BB GAP, in rounds, is floor(n/k) or ceil(n/k).
    IF s.bb_gap_max > ceil(s.players::numeric / s.k) OR s.bb_gap_min < floor(s.players::numeric / s.k) THEN
      RAISE EXCEPTION 'FAIL 15: % big-blind gaps range % to % rounds against n/k = %', s.pop, s.bb_gap_min, s.bb_gap_max, s.players::numeric / s.k;
    END IF;
    -- THE SMALL BLIND is the second of the same queue, and the button P3's
    -- advisory choice: both converge too.
    IF s.sb_max - s.sb_min > 1 OR s.btn_max - s.btn_min > 2 THEN
      RAISE EXCEPTION 'FAIL 15: % small blinds range % to %, buttons % to %', s.pop, s.sb_min, s.sb_max, s.btn_min, s.btn_max;
    END IF;
  END LOOP;
  -- THE CHURN RUN: each player's big blinds against the burden they were
  -- legal for (the sum over their legal rounds of hands / legal players).
  SELECT max(abs(coalesce(m.bb, 0) - e.expected)) INTO v_dev
    FROM (SELECT player_id, sum(groups::numeric / legal) AS expected FROM harness.sim_legal WHERE pop = 'C25' GROUP BY player_id) e
    LEFT JOIN harness.sim_metrics m ON m.pop = 'C25' AND m.player_id = e.player_id;
  IF v_dev IS NULL OR v_dev > 2 THEN
    RAISE EXCEPTION 'FAIL 15: under churn a player''s big blinds are % from the burden they were legal for', v_dev;
  END IF;
  INSERT INTO harness.m6 (k, t) VALUES ('churn_dev', round(v_dev, 3)::text);
END $$;
\echo '  ok  15 THE FAIRNESS SIMULATION (spec Phase 7)'
\pset format unaligned
\pset tuples_only on
SELECT '      ' || s.pop || ': ' || s.players || ' players (' || s.horses || ' horses), ' || s.rounds || ' rounds, ' || s.hands || ' hands; '
       || 'BB per player ' || s.bb_min || '-' || s.bb_max || ' (sd ' || s.bb_sd || '), BB gap ' || s.bb_gap_min || '-' || s.bb_gap_max || ' rounds, '
       || 'horses BB ' || coalesce(s.horse_bb_min::text, '-') || '-' || coalesce(s.horse_bb_max::text, '-') || '; '
       || 'SB ' || s.sb_min || '-' || s.sb_max || ' (sd ' || s.sb_sd || '), BTN ' || s.btn_min || '-' || s.btn_max || ' (sd ' || s.btn_sd || '), '
       || 'CO ' || s.co_min || '-' || s.co_max || ', HJ ' || s.hj_min || '-' || s.hj_max || ', UTG ' || s.utg_min || '-' || s.utg_max
       || '; repeat-opponent rate ' || coalesce(r.repeat_opponent_rate::text, '-')
  FROM harness.sim_summary s LEFT JOIN harness.sim_repeat r USING (pop) ORDER BY s.pop;
SELECT '      C25 churn: largest distance between a player''s big blinds and the burden they were legal for: ' || t FROM harness.m6 WHERE k = 'churn_dev';
\pset format aligned
\pset tuples_only off
ASSERT

# ===========================================================================
# 16 EVERY LIVE PROOF of the file, over the final estate; 17 the grants and
# the definer rule, both ways; 18 the file applied a second time.
# ===========================================================================
{
  printf '%s\n' 'CREATE TABLE harness.lpm (phase text, src text, n integer, lineno integer, ok boolean);'
  gen_proofs mine mine "$mine" | sed 's/INSERT INTO harness.lp6/INSERT INTO harness.lpm/'
} > "$fixture/live-proofs.sql"
mine_n=$(grep -c -- '^-- @live-proof: ' "$mine")
if [ "$mine_n" -lt 12 ]; then
  echo "FAIL 16: only $mine_n @live-proof lines in the file under test"
  exit 1
fi
cat >> "$fixture/live-proofs.sql" <<ASSERT
DO \$lp\$
DECLARE v_bad text;
BEGIN
  SELECT string_agg('#' || n || ' (line ' || lineno || ')', ', ' ORDER BY n) INTO v_bad FROM harness.lpm WHERE ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL OR (SELECT count(*) FROM harness.lpm) IS DISTINCT FROM ${mine_n}::bigint THEN
    RAISE EXCEPTION 'FAIL 16: a proof of the file under test is not true: %', v_bad;
  END IF;
END \$lp\$;
\echo '  ok  16 EVERY LIVE PROOF  all ${mine_n} @live-proof expressions of the file under test are true, evaluated as code over the final estate'
ASSERT
cat >> "$fixture/live-proofs.sql" <<'ASSERT'
-- 17 SERVICE ROLE ONLY, NO DEFINER, AND IT RUNS AS service_role ---------------------------
DO $$
DECLARE f text; v_d uuid;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_lightning_config(uuid)', 'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])',
                           'public.fn_lightning_group_sizes(integer,integer,integer,integer)',
                           'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)',
                           'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)',
                           'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)',
                           'public.fn_lightning_config_number(jsonb,text,numeric,numeric,numeric,boolean)',
                           'public.fn_lightning_pool_slot_idle_since_starts_at_open()',
                           'public.fn_lightning_reservation_end_marks_the_slot_idle()',
                           'public.fn_lightning_diversity_assign(jsonb,uuid[],integer[],jsonb,jsonb,numeric)'] LOOP
    IF NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'FAIL 17: % is not executable by service_role alone, or is a definer', f;
    END IF;
  END LOOP;
  -- THE ONE DEFINER: the pass-record prune, service_role only.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_cash_cluster_matcher_pass_prune(uuid,timestamp with time zone,integer)'::regprocedure)
     OR NOT has_function_privilege('service_role', 'public.fn_cash_cluster_matcher_pass_prune(uuid,timestamp with time zone,integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_cash_cluster_matcher_pass_prune(uuid,timestamp with time zone,integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_cash_cluster_matcher_pass_prune(uuid,timestamp with time zone,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 17: the prune is not a definer executable by service_role alone';
  END IF;
  IF has_table_privilege('authenticated', 'public.cash_cluster_matcher_pass', 'SELECT')
     OR has_table_privilege('service_role', 'public.cash_cluster_matcher_pass', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.cash_cluster_matcher_pass', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL 17: the pass record''s grants are wrong';
  END IF;
END $$;
DO $$
DECLARE v_g uuid; v_n integer; v_refused text;
BEGIN
  SELECT game INTO v_g FROM harness.m6 WHERE k = 'RACE';
  SET LOCAL ROLE service_role;
  v_n := jsonb_array_length(public.fn_lightning_match(v_g, clock_timestamp(), NULL, NULL) -> 'groups');
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.fn_lightning_match(v_g, clock_timestamp(), NULL, NULL);
    v_refused := 'no error';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := SQLSTATE;
  END;
  RESET ROLE;
  IF v_n IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'FAIL 17: service_role could not plan the thirty-player Cluster into five hands: %', v_n;
  END IF;
  IF v_refused IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FAIL 17: authenticated was not refused: %', v_refused;
  END IF;
END $$;
\echo '  ok  17 SERVICE ROLE ONLY  every function of the file is executable by service_role and by no browser role, none is SECURITY DEFINER but the pass-record prune, the pass record is readable and insertable by service_role only and never deletable; service_role plans as itself, and authenticated is refused with 42501'
ASSERT
cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.cap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname ~ '^fn_lightning_' OR p.proname = 'fn_cash_cluster_matcher_pass_prune')
UNION ALL
SELECT 'trg:' || t.tgrelid::regclass || '.' || t.tgname, md5(pg_get_triggerdef(t.oid) || t.tgenabled::text)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.lightning_pool_slot'::regclass, 'public.lightning_reservation'::regclass,
                                                               'public.lightning_instance'::regclass, 'public.lightning_hand'::regclass)
UNION ALL
SELECT 'idx:' || i.indexrelid::regclass, md5(pg_get_indexdef(i.indexrelid))
  FROM pg_index i WHERE i.indrelid IN ('public.lightning_pool_slot'::regclass, 'public.lightning_reservation'::regclass, 'public.cash_cluster_matcher_pass'::regclass)
UNION ALL
SELECT 'con:' || c.conrelid::regclass || '.' || c.conname, md5(pg_get_constraintdef(c.oid) || c.convalidated)
  FROM pg_constraint c WHERE c.conrelid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass)
UNION ALL
SELECT 'col:' || a.attrelid::regclass || '.' || a.attname, md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull || coalesce(col_description(a.attrelid, a.attnum), ''))
  FROM pg_attribute a WHERE a.attrelid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'acl:' || c.oid::regclass, md5(coalesce(c.relacl::text, '') || c.relrowsecurity || coalesce(obj_description(c.oid, 'pg_class'), ''))
  FROM pg_class c WHERE c.oid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass, 'public.lightning_reservation'::regclass)
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_pool_slot', 'lightning_reservation', 'lightning_hand', 'cash_cluster_matcher_pass', 'cash_cluster_events']) x(t)
UNION ALL
SELECT 'idle', md5(string_agg(id::text || ':' || idle_since::text, '|' ORDER BY id)) FROM public.lightning_pool_slot;
ASSERT
cat > "$fixture/reapply.sql" <<'ASSERT'
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.cap a FULL JOIN (
      SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND (p.proname ~ '^fn_lightning_' OR p.proname = 'fn_cash_cluster_matcher_pass_prune')
      UNION ALL
      SELECT 'trg:' || t.tgrelid::regclass || '.' || t.tgname, md5(pg_get_triggerdef(t.oid) || t.tgenabled::text)
        FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.lightning_pool_slot'::regclass, 'public.lightning_reservation'::regclass,
                                                                     'public.lightning_instance'::regclass, 'public.lightning_hand'::regclass)
      UNION ALL
      SELECT 'idx:' || i.indexrelid::regclass, md5(pg_get_indexdef(i.indexrelid))
        FROM pg_index i WHERE i.indrelid IN ('public.lightning_pool_slot'::regclass, 'public.lightning_reservation'::regclass, 'public.cash_cluster_matcher_pass'::regclass)
      UNION ALL
      SELECT 'con:' || c.conrelid::regclass || '.' || c.conname, md5(pg_get_constraintdef(c.oid) || c.convalidated)
        FROM pg_constraint c WHERE c.conrelid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass)
      UNION ALL
      SELECT 'col:' || a.attrelid::regclass || '.' || a.attname, md5(format_type(a.atttypid, a.atttypmod) || a.attnotnull || coalesce(col_description(a.attrelid, a.attnum), ''))
        FROM pg_attribute a WHERE a.attrelid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'acl:' || c.oid::regclass, md5(coalesce(c.relacl::text, '') || c.relrowsecurity || coalesce(obj_description(c.oid, 'pg_class'), ''))
        FROM pg_class c WHERE c.oid IN ('public.lightning_pool_slot'::regclass, 'public.cash_cluster_matcher_pass'::regclass, 'public.lightning_reservation'::regclass)
      UNION ALL
      SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
        FROM unnest(ARRAY['lightning_pool_slot', 'lightning_reservation', 'lightning_hand', 'cash_cluster_matcher_pass', 'cash_cluster_events']) x(t)
      UNION ALL
      SELECT 'idle', md5(string_agg(id::text || ':' || idle_since::text, '|' ORDER BY id)) FROM public.lightning_pool_slot
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 18: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.cap) < 60 THEN
    RAISE EXCEPTION 'FAIL 18: the capture is too small to prove anything (%)', (SELECT count(*) FROM harness.cap);
  END IF;
END $$;
\echo '  ok  18 THE FILE IS RE-APPLIABLE  applied a second time over every hand, pass and slot above, it leaves every fn_lightning_ body, acl and comment, the triggers of four lightning tables, the indexes, constraints, columns, acls and comments it touched, five row counts and every idle_since exactly as they were'
ASSERT

# ===========================================================================
# THE RUN. One psql session for the chain, the ground, the file and the
# assertions; then the race in two processes; then the simulation, the proofs,
# the grants and the second application in one more.
# ===========================================================================
set +e
"${PSQL[@]}" \
  -f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture" \
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r" \
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture" \
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

set +e
"${PSQL[@]}" -f "$fixture/race.sql" > "$fixture/race-a.out" 2>&1 &
pid_a=$!
"${PSQL[@]}" -f "$fixture/race.sql" > "$fixture/race-b.out" 2>&1 &
pid_b=$!
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e
if [ "$status_a" != 0 ] || [ "$status_b" != 0 ]; then
  echo "FAIL 12: a racing process failed:"; cat "$fixture/race-a.out" "$fixture/race-b.out"
  exit 1
fi

set +e
"${PSQL[@]}" \
  -f "$fixture/race-check.sql" \
  -f "$fixture/sim.sql" \
  -f "$fixture/live-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | tee -a "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# TWENTY-TWO SECTIONS REPORTED, counted rather than eyeballed: a section deleted
# during a refactor would not make psql fail, and the PASS line would still print.
oks=$(grep -c -E '^  ok  [0-9]{2}[ab]? ' "$fixture/psql.out" || true)
if [ "$oks" != 22 ]; then
  echo "FAIL: $oks of the 22 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phases 6 and 7, 22 sections: every predecessor proof evaluates exactly as before the file except the two superseded exact lists of freeze readers, whose intent holds as containment, and the idle_since backfill read the released reservations; the configuration defaults, honours overrides and reports and replaces bad values, with bands from the population's own thresholds; every P0 reason is one fact from legal for a human and a horse alike, reusing the platform's restriction, responsible-gaming, anchor, stack, in-hand and freeze checks; every open-pool player is diagnosed exactly once in every state; group sizes seat everyone from 2 to 60 at 6-max and 9-max in the fewest instances; the barrier forms every planned group with the planned blinds; P4 queues by idle_since, entry, join and id; P5 cuts repeated pairs and repeated full tables in a large pool, reports the diversity measures and changes nothing in a thin one; P3 moves only the non-blind order, each seat to whoever held it least; the plan is deterministic; the writer is dark by default, idempotent on its request id, re-plans a race, stops frozen at once and is bounded; a concurrent pass is pass_in_progress and a row held by anything else is cluster_row_busy; no two passes reserve anybody twice, in one process or two; only a hand that was dealt moves a queue place; a pass is recorded only when something happened and the record is pruned to its retention; horses are matched identically; Phase 4 acceptance forms 3 hands of 6 and of 9; ${rounds} rounds each of 18, 25 and 50 players keep every big-blind and small-blind count within one, every button within two and every big-blind gap within ceil(n/k), and under churn every player's big blinds stay within two of the burden they were legal for; every @live-proof holds, service_role alone may call it, and the file is re-appliable"
