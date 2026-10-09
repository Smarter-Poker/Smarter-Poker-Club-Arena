#!/usr/bin/env bash
# Lightning Phase 11 remediation (the database side): integrity signals are
# fair, a finding is one row that extends, and the shadow is scored like for
# like.
#
# Proves 20261009181945 on Postgres 17, socket only, on port 55562
# (LIGHTNING_P11R_PORT overrides it), and REPRODUCES every finding it closes
# on the production bodies BEFORE the file runs, then shows it gone after.
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920235343
# through Phase 11 (20261008161509) and the three Phase 12 files production
# carries (20261009143757, 20261009144343, 20261009151825), in order, on the
# Phase 12 operator harness's own ground (read from it, so the two can never
# drift: its helpers, production's default function, table and sequence
# privileges, its live trg_autorevoke_privileged_anon event trigger, the gate
# ground and the managed cron API), then the file under test, twice.
#
# THE ROWS THE HARNESS WRITES ITSELF are fixture boundaries only, each named
# where it is written: PLANTED HISTORY (pool sessions and settled hands of
# the past, written with session_replication_role = replica so a day of
# random seating costs seconds rather than hours; the scan reads only their
# Cluster, players, times and nets), backdated stamps (time travel), the
# engine's integrity windows (exactly the payload fn_lightning_integrity_report
# takes), and an operator's review through the real operator door. Every
# Lightning conversion and reversion is the real drive; every Stop Playing is
# the real door.
#
# EVERY FINDING IS REPRODUCED FIRST: the production body runs inside a
# subtransaction that is rolled back (harness.r_try), its answer is kept in
# harness.r_before, and the same data is judged again after the file.
#
# LAW 10.5. Humans and horses sit in every pool planted here (the colluding
# pair, the dumping pair, the marathon and the engine-timed players each
# include a horse). The migration reads neither is_horse nor horse_id.
#
# LIGHTNING_P11R_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P11R_PORT:-55562}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
p12_harness=$root/scripts/dev/test-lightning-phase12-operator-alerts.sh
base_fixture=$F/lightning-phase3-remediation-schema.sql
pop_fixture=$F/lightning-phase4-population-schema.sql
p5_fixture=$F/lightning-phase5-conversion-schema.sql
p9_fixture=$F/lightning-phase9-formation-fixture.sql
r2_fixture=$F/lightning-remediation-two-fixture.sql
p6_fixture=$F/lightning-phase6-matcher-fixture.sql
s6_fixture=$F/lightning-phase6-settlement-fixture.sql
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
p7=$M/20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql
phase8=$M/20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql
p7r=$M/20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql
fix=$M/20261008043021_lightning_phase_7_and_8_review_fixes_the_dwell_is_a_duration.sql
p9d=$M/20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql
p10=$M/20261008111425_lightning_phase_10_responsible_gaming_stop_playing_auto_rebu.sql
p9r2=$M/20261008142857_lightning_phase_9_remediation_the_ended_session_answers_the_.sql
p11=$M/20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql
p12rg=$M/20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql
p12ops=$M/20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql
p12lc=$M/20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql
mine=${LIGHTNING_P11R_MIGRATION:-$M/20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$p12rg" "$p12ops" "$p12lc" "$p12_harness" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p11r-test.XXXXXX")
started=0
cleanup() {
  local pids
  pids=$(jobs -p 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true; fi
  if [ -n "${LIGHTNING_P11R_KEEP:-}" ]; then echo "kept $fixture"; else rm -rf "$fixture"; fi
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w \
  -o "-k $fixture/socket -p $port -h '' -c max_connections=40 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
started=1
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres)
Q() { "${PSQL[@]}" -At -c "$1"; }

# THE PHASE 12 OPERATOR HARNESS'S GROUND, read from it: its ground (the
# Phase 11 ground plus its helpers) and its own Phase 12 ground (gate, cron).
awk '/^cat > "\$fixture\/ground.sql" <<.ASSERT.$/{f=1;next} f&&/^ASSERT$/{exit} f' "$p12_harness" > "$fixture/ground.sql"
awk '/^cat > "\$fixture\/ground12.sql" <<.ASSERT.$/{f=1;next} f&&/^ASSERT$/{exit} f' "$p12_harness" > "$fixture/ground12.sql"
grep -q 'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon' "$fixture/ground.sql" \
  && grep -q 'CREATE FUNCTION harness.lc' "$fixture/ground.sql" \
  && grep -q 'CREATE FUNCTION harness.again' "$fixture/ground.sql" \
  && grep -q 'CREATE OR REPLACE FUNCTION cron.schedule' "$fixture/ground12.sql" \
  && grep -q 'CREATE FUNCTION harness.door' "$fixture/ground12.sql" \
  && grep -q 'CREATE FUNCTION harness.sweep' "$fixture/ground12.sql" \
  || { echo "FAIL: the Phase 12 operator harness's ground could not be read"; exit 1; }

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
    printf '%s\n' "INSERT INTO harness.lp8 VALUES ('$phase', '$src', $n, $lineno, public.fxr_eval(\$lpq\$${expr}\$lpq\$));"
  done < <(grep -n -- '^-- @live-proof: ' "$file")
}
predecessor_proofs() {
  local phase=$1
  gen_proofs "$phase" p2 "$phase2"; gen_proofs "$phase" p2r "$phase2r"
  gen_proofs "$phase" p3 "$phase3"; gen_proofs "$phase" p3r "$phase3r"
  gen_proofs "$phase" p4 "$phase4"; gen_proofs "$phase" p4r "$phase4r"
  gen_proofs "$phase" p5 "$phase5"; gen_proofs "$phase" p5r "$phase5r"
  gen_proofs "$phase" p9 "$phase9"; gen_proofs "$phase" p9r "$phase9r"
  gen_proofs "$phase" r2a "$r2a"; gen_proofs "$phase" r2b "$r2b"
  gen_proofs "$phase" r2c "$r2c"; gen_proofs "$phase" r2d "$r2d"
  gen_proofs "$phase" p6 "$p6"; gen_proofs "$phase" s6 "$s6"; gen_proofs "$phase" s6r "$s6r"
  gen_proofs "$phase" p7 "$p7"
  gen_proofs "$phase" p8 "$phase8"; gen_proofs "$phase" p7r "$p7r"; gen_proofs "$phase" fix "$fix"
  gen_proofs "$phase" p9d "$p9d"
  gen_proofs "$phase" p10 "$p10"
  gen_proofs "$phase" p9r2 "$p9r2"
  gen_proofs "$phase" p11 "$p11"
  gen_proofs "$phase" p12rg "$p12rg"
  gen_proofs "$phase" p12ops "$p12ops"
  gen_proofs "$phase" p12lc "$p12lc"
}

# ===========================================================================
# THIS HARNESS'S GROUND: the planters, the catcher and the captures.
# ===========================================================================
cat > "$fixture/rground.sql" <<'ASSERT'
CREATE TABLE harness.r_before (k text PRIMARY KEY, j jsonb NOT NULL);
CREATE TABLE harness.r_box (k text PRIMARY KEY, game uuid, a uuid, b uuid, c uuid, d uuid, t0 timestamptz, j jsonb);
CREATE SEQUENCE harness.r_numbers START 1900000000;
-- THE CATCHER: runs a query returning jsonb inside a subtransaction that is
-- always rolled back, and answers what it returned. The production body runs
-- for real, and nothing it wrote survives.
CREATE FUNCTION harness.r_try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  BEGIN
    EXECUTE p_sql INTO v;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = coalesce(v, 'null'::jsonb)::text;
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    RETURN SQLERRM::jsonb;
  END;
END $f$;
-- PLANTED HISTORY (fixture boundary): one closed pool session of the past.
CREATE FUNCTION harness.r_session(p_game uuid, p_player uuid, p_in timestamptz, p_out timestamptz,
                                  p_reason text DEFAULT 'stop_playing') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, anchor_seat_id, state,
                                             entered_at, exited_at, exit_reason)
  SELECT p_game, cg.cluster_epoch, p_player, gen_random_uuid(), gen_random_uuid(), CASE WHEN p_out IS NULL THEN 'active' ELSE 'closed' END,
         p_in, p_out, CASE WHEN p_out IS NULL THEN NULL ELSE p_reason END
    FROM public.cash_games cg WHERE cg.id = p_game;
  PERFORM set_config('session_replication_role', 'origin', true);
END $f$;
-- PLANTED HISTORY: one settled hand of the past, players and nets given.
CREATE FUNCTION harness.r_hand(p_game uuid, p_at timestamptz, p_players uuid[], p_nets numeric[]) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v_h uuid := gen_random_uuid(); v_ep integer;
BEGIN
  SELECT cg.cluster_epoch INTO v_ep FROM public.cash_games cg WHERE cg.id = p_game;
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at, settled_at,
         rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version, request_id,
         hand_number, host_table_id, settle_request_id, settle_request_hash, hand_history_id, settle_receipt)
  VALUES (v_h, p_game, v_ep, gen_random_uuid(), p_at, p_at + interval '1 second', 'planted', 'planted', 'planted',
          'planted', 'planted', gen_random_uuid(), nextval('harness.r_numbers'), gen_random_uuid(), gen_random_uuid(),
          'planted', gen_random_uuid(), '{}'::jsonb);
  INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, net_result)
  SELECT v_h, p.p, gen_random_uuid(), p.i, p_game, v_ep, p_nets[p.i]
    FROM unnest(p_players) WITH ORDINALITY p(p, i);
  PERFORM set_config('session_replication_role', 'origin', true);
  RETURN v_h;
END $f$;
-- PLANTED HISTORY: a RANDOM-SEATING POOL. Every player holds one session of
-- p_min .. p_max placed at random inside [p_from, p_from + p_span); every
-- p_step every player then in the pool is dealt, in a random order, into
-- tables of p_size (a lone remainder sits the step out), one random winner
-- per table taking two from each other player. A colluding pair (p_pair)
-- shares one longest session and is always dealt first, so always together.
CREATE FUNCTION harness.r_pool(p_game uuid, p_players uuid[], p_from timestamptz, p_span interval, p_step interval,
                               p_min interval, p_max interval, p_size integer DEFAULT 6,
                               p_pair uuid[] DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE v_ep integer; v_n integer; v_s timestamptz;
BEGIN
  SELECT cg.cluster_epoch INTO v_ep FROM public.cash_games cg WHERE cg.id = p_game;
  DROP TABLE IF EXISTS pg_temp.r_sess, pg_temp.r_seat, pg_temp.r_h;
  CREATE TEMP TABLE r_sess (player_id uuid PRIMARY KEY, s timestamptz, e timestamptz);
  INSERT INTO r_sess
  SELECT x.p, y.st, y.st + x.d
    FROM (SELECT p, p_min + random() * (p_max - p_min) AS d FROM unnest(p_players) p) x
   CROSS JOIN LATERAL (SELECT p_from + random() * (p_span - x.d) AS st) y;
  IF p_pair IS NOT NULL THEN
    v_s := p_from + random() * (p_span - p_max);
    UPDATE r_sess SET s = v_s, e = v_s + p_max WHERE player_id = ANY (p_pair);
  END IF;
  CREATE TEMP TABLE r_seat AS
  WITH st AS (SELECT g AS t FROM generate_series(p_from, p_from + p_span - p_step, p_step) g),
  pr AS (SELECT st.t, r.player_id,
                row_number() OVER (PARTITION BY st.t
                                   ORDER BY (r.player_id = ANY (coalesce(p_pair, ARRAY[]::uuid[]))) DESC, random()) - 1 AS rn,
                count(*) OVER (PARTITION BY st.t) AS c
           FROM st JOIN r_sess r ON r.s <= st.t AND r.e > st.t)
  SELECT pr.t, pr.player_id, (pr.rn / p_size)::integer AS tbl, (pr.rn % p_size + 1)::integer AS seat
    FROM pr WHERE NOT (pr.c % p_size = 1 AND pr.rn = pr.c - 1);
  CREATE TEMP TABLE r_h AS
  SELECT q.t, q.tbl, q.n, gen_random_uuid() AS hid, 1 + floor(random() * q.n)::integer AS winner
    FROM (SELECT t, tbl, count(*)::integer AS n FROM r_seat GROUP BY t, tbl) q;
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO public.lightning_pool_session (cluster_id, cluster_epoch, player_id, cash_player_session_id, anchor_seat_id, state,
                                             entered_at, exited_at, exit_reason)
  SELECT p_game, v_ep, r.player_id, gen_random_uuid(), gen_random_uuid(), 'closed', r.s, r.e, 'stop_playing' FROM r_sess r;
  INSERT INTO public.lightning_hand (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at, settled_at,
         rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version, request_id,
         hand_number, host_table_id, settle_request_id, settle_request_hash, hand_history_id, settle_receipt)
  SELECT h.hid, p_game, v_ep, gen_random_uuid(), h.t + h.tbl * interval '1 millisecond',
         h.t + h.tbl * interval '1 millisecond' + interval '1 second', 'planted', 'planted', 'planted', 'planted',
         'planted', gen_random_uuid(), nextval('harness.r_numbers'), gen_random_uuid(), gen_random_uuid(), 'planted',
         gen_random_uuid(), '{}'::jsonb
    FROM r_h h;
  INSERT INTO public.lightning_hand_player (hand_id, player_id, pool_slot_id, seat, cluster_id, cluster_epoch, net_result)
  SELECT h.hid, s.player_id, gen_random_uuid(), s.seat, p_game, v_ep,
         CASE WHEN s.seat = h.winner THEN 2 * (h.n - 1) ELSE -2 END
    FROM r_seat s JOIN r_h h ON h.t = s.t AND h.tbl = s.tbl;
  PERFORM set_config('session_replication_role', 'origin', true);
  SELECT count(*)::integer INTO v_n FROM r_h;
  RETURN v_n;
END $f$;
-- PLANTED HISTORY: a heads-up hand in which p_b nets p_to_b from p_a.
CREATE FUNCTION harness.r_duel(p_game uuid, p_a uuid, p_b uuid, p_at timestamptz, p_to_b double precision) RETURNS uuid
LANGUAGE sql AS $f$
  SELECT harness.r_hand(p_game, p_at, ARRAY[p_a, p_b], ARRAY[-p_to_b::numeric, p_to_b::numeric]);
$f$;
-- Distinct synthetic players.
CREATE FUNCTION harness.r_people(p_n integer) RETURNS uuid[] LANGUAGE sql VOLATILE AS $f$
  SELECT coalesce(array_agg(gen_random_uuid()), ARRAY[]::uuid[]) FROM generate_series(1, p_n);
$f$;
-- Every pool member of a Cluster, humans and horses (the open sessions).
CREATE FUNCTION harness.r_members(p_game uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT array_agg(ps.player_id ORDER BY ps.player_id) FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL;
$f$;
-- A finding's rows for a subject; PL/pgSQL because it is created first.
-- VOLATILE on purpose: a reader called in the same statement after a scan
-- must see what the scan wrote (a STABLE one keeps the statement's snapshot).
CREATE FUNCTION harness.r_q(p_sql text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v;
END $f$;
CREATE FUNCTION harness.r_rows(p_game uuid, p_pattern text) RETURNS integer LANGUAGE plpgsql VOLATILE AS $f$
BEGIN
  RETURN (SELECT count(*)::integer FROM public.lightning_integrity_signal s
           WHERE s.cluster_id = p_game AND s.pattern_type = p_pattern);
END $f$;
CREATE FUNCTION harness.r_sig(p_game uuid, p_pattern text, p_a uuid, p_b uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $f$
BEGIN
  RETURN (SELECT to_jsonb(s) FROM public.lightning_integrity_signal s
           WHERE s.cluster_id = p_game AND s.pattern_type = p_pattern
             AND s.player_a = LEAST(p_a, coalesce(p_b, p_a)) AND s.player_b IS NOT DISTINCT FROM
                 CASE WHEN p_b IS NULL THEN NULL ELSE GREATEST(p_a, p_b) END
           ORDER BY s.id DESC LIMIT 1);
END $f$;
CREATE FUNCTION harness.r_mirrors(p_game uuid) RETURNS integer LANGUAGE plpgsql VOLATILE AS $f$
BEGIN
  RETURN (SELECT count(*)::integer FROM public.ca_collusion_signals cs
           WHERE cs.detail ->> 'signal' = 'lightning_chip_flow' AND cs.detail ->> 'cluster_id' = p_game::text);
END $f$;
-- A Cluster's mode transitions by the real drive, until it reaches p_mode.
CREATE FUNCTION harness.r_drive_to(p_game uuid, p_mode text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE i integer;
BEGIN
  FOR i IN 1 .. 6 LOOP
    EXIT WHEN harness.mode(p_game) = p_mode;
    PERFORM harness.drive(p_game);
  END LOOP;
  IF harness.mode(p_game) IS DISTINCT FROM p_mode THEN
    RAISE EXCEPTION 'FIXTURE: % is % after six drives, not %', p_game, harness.mode(p_game), p_mode;
  END IF;
END $f$;
-- The engine's window, as fn_lightning_integrity_report takes it.
CREATE FUNCTION harness.r_window(p_from timestamptz, p_players jsonb, p_pairs jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('window_from', p_from, 'window_to', p_from + interval '5 minutes',
                            'hands', 40, 'decisions', 200, 'players', p_players, 'pairs', p_pairs);
$f$;
-- A shadow metric window: every component 1 but bb_fairness as given.
CREATE FUNCTION harness.r_metrics(p_bb_n numeric, p_bb_viol numeric) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('passes', 10, 'formation_success_rate', 1, 'failure_rate', 0,
                            'wait_ms', jsonb_build_object('n', 5, 'p50', 0, 'p95', 0),
                            'bb_fairness', jsonb_build_object('n', p_bb_n, 'order_violations', p_bb_viol),
                            'opponent_diversity', jsonb_build_object('repeat_pair_rate', 0),
                            'instance_occupancy', jsonb_build_object('utilization', 1));
$f$;
\echo '  ok  R00 THE GROUND  the planters, the catcher and the captures are installed over the real chain through 20261009151825'
ASSERT

# ===========================================================================
# THE ESTATE AND THE REPRODUCTIONS, on the production bodies (before the file).
# ===========================================================================
cat > "$fixture/before.sql" <<'ASSERT'
-- R01 FINDING 1: A CLUSTER THAT FLIPS ON AND OFF THREE TIMES -----------------------------
DO $$
DECLARE v_g uuid; i integer; v_t0 timestamptz := clock_timestamp() - interval '1 minute';
BEGIN
  PERFORM setseed(0.101);
  v_g := harness.lc('R1');                               -- ON by the real drive (18 players, 4 horses)
  PERFORM harness.cfg(v_g, '{"pending_off_dwell_ms": 0}');
  FOR i IN 1 .. 3 LOOP
    IF i > 1 THEN
      PERFORM harness.to(v_g, 18);
      PERFORM harness.r_drive_to(v_g, 'lightning');
      PERFORM public.fx9_pool(v_g);
    END IF;
    PERFORM harness.to(v_g, 11);
    PERFORM harness.r_drive_to(v_g, 'must_move');
  END LOOP;
  INSERT INTO harness.r_box (k, game, t0) VALUES ('R1', v_g, v_t0);
  INSERT INTO harness.r_before VALUES ('R1', harness.r_try(format(
    $q$SELECT jsonb_build_object('scan', public.fn_lightning_integrity_scan(%L, %L, clock_timestamp()),
                                 'cjl', harness.r_rows(%L, 'COORDINATED_JOIN_LEAVE'),
                                 'horse_pairs', harness.r_q(format('SELECT to_jsonb(count(*)) FROM public.lightning_integrity_signal s
                                                  WHERE s.cluster_id = %%L AND s.pattern_type = ''COORDINATED_JOIN_LEAVE''
                                                    AND EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                                                                 WHERE tb.cluster_id = %%L AND ts.horse_id IS NOT NULL
                                                                   AND ts.user_id IN (s.player_a, s.player_b))', %L::uuid, %L::uuid)))$q$,
    v_g, v_t0, v_g, v_g, v_g)));
  IF ((SELECT j FROM harness.r_before WHERE k = 'R1') ->> 'cjl')::integer < 10
     OR ((SELECT j FROM harness.r_before WHERE k = 'R1') ->> 'horse_pairs')::integer < 1 THEN
    RAISE EXCEPTION 'FAIL R01: the production scan did not reproduce finding 1: %', (SELECT j FROM harness.r_before WHERE k = 'R1');
  END IF;
END $$;

-- R01b A GENUINELY COORDINATED HUMAN AND HORSE, AND TWO MARATHONS (finding 12) -------
DO $$
DECLARE v_g uuid; v_h uuid[]; v_hz uuid[]; p uuid; q uuid; m uuid; mh uuid; i integer;
        v_base timestamptz := clock_timestamp() - interval '50 minutes';
BEGIN
  v_g := harness.lc('R1b');
  v_h := harness.idle(v_g, false, 14);
  v_hz := harness.idle(v_g, true, 4);
  p := v_h[1]; q := v_hz[1]; m := v_h[3]; mh := v_hz[2];
  -- Spread every entry an hour apart (time travel), then P (human) and Q
  -- (horse) stop and return three times through the real doors.
  UPDATE public.lightning_pool_session ps SET entered_at = v_base - (z.rn * interval '61 seconds')
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM public.lightning_pool_session WHERE cluster_id = v_g) z
   WHERE ps.id = z.id;
  FOR i IN 1 .. 3 LOOP
    PERFORM harness.stop(v_g, p);
    PERFORM harness.stop(v_g, q);
    IF i < 3 THEN
      PERFORM harness.again(v_g, p, false);
      PERFORM harness.again(v_g, q, true);
    END IF;
  END LOOP;
  UPDATE public.lightning_pool_session ps
     SET entered_at = v_base + (z.n * interval '5 minutes') + CASE WHEN ps.player_id = q THEN interval '3 seconds' ELSE interval '0' END,
         exited_at = v_base + (z.n * interval '5 minutes') + interval '2 minutes'
                     + CASE WHEN ps.player_id = q THEN interval '4 seconds' ELSE interval '0' END
    FROM (SELECT id, row_number() OVER (PARTITION BY player_id ORDER BY entered_at, id) AS n
            FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id IN (p, q)) z
   WHERE ps.id = z.id;
  -- A HUMAN AND A HORSE thirty hours in the pool (time travel).
  UPDATE public.lightning_pool_session SET entered_at = clock_timestamp() - interval '30 hours'
   WHERE cluster_id = v_g AND player_id IN (m, mh) AND exited_at IS NULL;
  INSERT INTO harness.r_box (k, game, a, b, c, d, t0) VALUES ('R1b', v_g, p, q, m, mh, clock_timestamp() - interval '31 hours');
  INSERT INTO harness.r_before VALUES ('R1b', harness.r_try(format(
    $q$SELECT jsonb_build_object('scan', public.fn_lightning_integrity_scan(%L, %L, clock_timestamp()),
                                 'cjl', harness.r_sig(%L, 'COORDINATED_JOIN_LEAVE', %L, %L),
                                 'm', harness.r_sig(%L, 'SESSION_LENGTH', %L, NULL),
                                 'mh', harness.r_sig(%L, 'SESSION_LENGTH', %L, NULL))$q$,
    v_g, clock_timestamp() - interval '31 hours', v_g, p, q, v_g, m, v_g, mh)));
  IF (SELECT (j #>> '{m,suspicion_score}')::integer <> 90 OR j #>> '{m,severity}' <> 'high'
             OR (j #>> '{mh,suspicion_score}')::integer <> 90 OR j -> 'cjl' IS NULL OR j -> 'cjl' = 'null'::jsonb
        FROM harness.r_before WHERE k = 'R1b') THEN
    RAISE EXCEPTION 'FAIL R01b: the production scan did not reproduce the marathon at 90 high: %', (SELECT j FROM harness.r_before WHERE k = 'R1b');
  END IF;
END $$;
\echo '  ok  R01 REPRODUCED 1 AND 12  on the production scan a Cluster that flips ON and OFF three times through the real drive raises COORDINATED_JOIN_LEAVE for every pair that stayed (horses among them), and a thirty-hour human and a thirty-hour horse are each SESSION_LENGTH 90 high'

-- R02 FINDING 2: RANDOM-SEATING POOLS OF 18, 25 AND 50 ---------------------------------------
DO $$
DECLARE v_g uuid; v_n integer; v_k text; v_real uuid[]; v_pop uuid[]; v_pair uuid[]; v_hands integer;
        v_t0 timestamptz := date_trunc('minute', clock_timestamp()) - interval '7 hours';
BEGIN
  FOREACH v_n IN ARRAY ARRAY[18, 25, 50] LOOP
    PERFORM setseed(0.2 + v_n / 1000.0);
    v_k := 'R2:' || v_n;
    v_g := harness.lc(v_k);
    v_real := harness.r_members(v_g);                    -- 18 real players, 4 of them horses
    v_pop := v_real || harness.r_people(3 * v_n - cardinality(v_real));
    v_pair := CASE WHEN v_n = 25 THEN ARRAY[(harness.idle(v_g, false, 1))[1], (harness.idle(v_g, true, 1))[1]] END;
    v_hands := harness.r_pool(v_g, v_pop, v_t0, interval '6 hours', interval '15 seconds',
                              interval '1 hour', interval '3 hours', 6, v_pair);
    INSERT INTO harness.r_box (k, game, a, b, t0, j) VALUES (v_k, v_g, v_pair[1], v_pair[2], v_t0,
      jsonb_build_object('hands', v_hands, 'population', cardinality(v_pop)));
    INSERT INTO harness.r_before VALUES (v_k, harness.r_try(format(
      $q$SELECT jsonb_build_object('scan', public.fn_lightning_integrity_scan(%L, %L, %L),
                                   'pairing', harness.r_rows(%L, 'PAIRING_CONCENTRATION'))$q$,
      v_g, v_t0, v_t0 + interval '6 hours', v_g)));
    IF ((SELECT j FROM harness.r_before WHERE k = v_k) ->> 'pairing')::integer < 5 THEN
      RAISE EXCEPTION 'FAIL R02: the production scan did not reproduce finding 2 at %: %', v_n, (SELECT j FROM harness.r_before WHERE k = v_k);
    END IF;
  END LOOP;
END $$;
\echo '  ok  R02 REPRODUCED 2  on the production scan random-seating pools of 18, 25 and 50 (one 1 h → 3 h session per player over six hours, a hand every 15 s) raise PAIRING_CONCENTRATION for pairs that only shared a session'

-- R03 FINDING 5: NO-EDGE PAIRS AT 10 TO 15 OPPOSED HANDS, AND A DUMPING PAIR ---------------
DO $$
DECLARE v_g uuid; i integer; kk integer; v_n integer; a uuid; b uuid; c uuid; d uuid;
        v_t0 timestamptz := date_trunc('minute', clock_timestamp()) - interval '7 hours';
BEGIN
  PERFORM setseed(0.53);
  v_g := harness.lc('R5');
  FOR i IN 1 .. 300 LOOP
    a := gen_random_uuid(); b := gen_random_uuid();
    v_n := 10 + floor(random() * 6)::integer;
    FOR kk IN 1 .. v_n LOOP
      PERFORM harness.r_duel(v_g, a, b, v_t0 + random() * interval '6 hours',
                             CASE WHEN random() < 0.5 THEN 1 ELSE -1 END * (1 + floor(random() * 20)));
    END LOOP;
  END LOOP;
  -- THE DUMPING PAIR, a human sender and a horse receiver: 36 of 40 to the horse.
  c := (harness.idle(v_g, false, 1))[1]; d := (harness.idle(v_g, true, 1))[1];
  FOR kk IN 1 .. 40 LOOP
    PERFORM harness.r_duel(v_g, c, d, v_t0 + kk * interval '8 minutes',
                           CASE WHEN kk % 10 = 0 THEN -1 ELSE 5 + floor(random() * 16) END);
  END LOOP;
  INSERT INTO harness.r_box (k, game, c, d, t0) VALUES ('R5', v_g, c, d, v_t0);
  INSERT INTO harness.r_before VALUES ('R5', harness.r_try(format(
    $q$SELECT jsonb_build_object('scan', public.fn_lightning_integrity_scan(%L, %L, %L),
                                 'chip_flow', harness.r_rows(%L, 'CHIP_FLOW'),
                                 'dumper', harness.r_sig(%L, 'CHIP_FLOW', %L, %L),
                                 'mirrors', harness.r_mirrors(%L))$q$,
    v_g, v_t0, v_t0 + interval '6 hours', v_g, v_g, c, d, v_g)));
  IF (SELECT (j ->> 'chip_flow')::integer < 3 OR j -> 'dumper' = 'null'::jsonb OR (j ->> 'mirrors')::integer < 3
        FROM harness.r_before WHERE k = 'R5') THEN
    RAISE EXCEPTION 'FAIL R03: the production scan did not reproduce finding 5: %', (SELECT j - 'scan' FROM harness.r_before WHERE k = 'R5');
  END IF;
END $$;
\echo '  ok  R03 REPRODUCED 5  on the production scan 300 no-edge pairs at 10 → 15 opposed hands raise CHIP_FLOW (and mirror it) beside the planted dumping pair'

-- R04 FINDING 6: HOURLY ROLLING RESCANS ------------------------------------------------------
DO $$
DECLARE v_g uuid; v_pop uuid[]; a uuid; b uuid; c uuid; d uuid; kk integer;
        v_t0 timestamptz := date_trunc('hour', clock_timestamp()) - interval '7 hours';
BEGIN
  PERFORM setseed(0.61);
  v_g := harness.lc('R6');
  a := (harness.idle(v_g, false, 1))[1]; b := (harness.idle(v_g, true, 1))[1];
  c := (harness.idle(v_g, false, 2))[2]; d := (harness.idle(v_g, true, 2))[2];
  -- Twelve players present for thirty hours, a hand every five minutes; A
  -- (human) and B (horse) always seated together.
  v_pop := ARRAY[a, b] || harness.r_people(10);
  PERFORM harness.r_pool(v_g, v_pop, v_t0 - interval '24 hours', interval '30 hours', interval '5 minutes',
                         interval '30 hours', interval '30 hours', 6, ARRAY[a, b]);
  -- C (human) dumps to D (horse) every twenty minutes.
  FOR kk IN 0 .. 89 LOOP
    PERFORM harness.r_duel(v_g, c, d, v_t0 - interval '24 hours' + kk * interval '20 minutes', 4 + floor(random() * 17));
  END LOOP;
  INSERT INTO harness.r_box (k, game, a, b, c, d, t0) VALUES ('R6', v_g, a, b, c, d, v_t0);
  INSERT INTO harness.r_before VALUES ('R6', harness.r_try(format(
    $q$SELECT jsonb_build_object(
        'scans', (SELECT jsonb_agg(public.fn_lightning_integrity_scan(%L, %L::timestamptz + h * interval '1 hour' - interval '24 hours',
                                                                      %L::timestamptz + h * interval '1 hour') -> 'written' ORDER BY h)
                    FROM generate_series(0, 5) h),
        'pairing', harness.r_q(format('SELECT to_jsonb(count(*)) FROM public.lightning_integrity_signal s WHERE s.cluster_id = %%L
                      AND s.pattern_type = ''PAIRING_CONCENTRATION'' AND s.player_a = LEAST(%%L::uuid, %%L::uuid)', %L::uuid, %L::uuid, %L::uuid)),
        'chip_flow', harness.r_q(format('SELECT to_jsonb(count(*)) FROM public.lightning_integrity_signal s WHERE s.cluster_id = %%L
                      AND s.pattern_type = ''CHIP_FLOW'' AND s.player_a = LEAST(%%L::uuid, %%L::uuid)', %L::uuid, %L::uuid, %L::uuid)),
        'mirrors', harness.r_mirrors(%L))$q$,
    v_g, v_t0, v_t0, v_g, a, b, v_g, c, d, v_g)));
  IF (SELECT (j ->> 'pairing')::integer <> 6 OR (j ->> 'chip_flow')::integer <> 6 OR (j ->> 'mirrors')::integer <> 6
        FROM harness.r_before WHERE k = 'R6') THEN
    RAISE EXCEPTION 'FAIL R04: the production scan did not reproduce finding 6: %', (SELECT j FROM harness.r_before WHERE k = 'R6');
  END IF;
END $$;
\echo '  ok  R04 REPRODUCED 6  on the production scan six hourly rolling rescans write six PAIRING_CONCENTRATION rows and six CHIP_FLOW rows for the same two pairs and mirror the chip flow six times'

-- R05 FINDING 6 (THE CALLER): THE SWEEP'S WINDOW ---------------------------------------------
DO $$
DECLARE v_g uuid; v jsonb;
BEGIN
  v_g := harness.lc('R6s');
  PERFORM harness.cfg(v_g, '{"integrity_telemetry": true}');
  INSERT INTO harness.r_box (k, game) VALUES ('R6s', v_g);
  v := harness.r_try(format($q$SELECT (SELECT public.fn_lightning_alert_sweep(now()) -> 'integrity_scans')
                                      || jsonb_build_array(harness.r_q(format('SELECT st.detail FROM public.lightning_alert_sweep_state st
                                                             WHERE st.key = ''integrity_scan:'' || %%L', %L::text)))$q$, v_g));
  INSERT INTO harness.r_before VALUES ('R6s', v);
  IF (v -> -1 ->> 'window_to')::timestamptz IS DISTINCT FROM date_trunc('hour', now())
     OR (v -> -1 ->> 'window_from')::timestamptz IS DISTINCT FROM date_trunc('hour', now()) - interval '24 hours' THEN
    RAISE EXCEPTION 'FAIL R05: the production sweep did not scan the rolling day before the hour: %', v;
  END IF;
END $$;
\echo '  ok  R05 REPRODUCED 6 (THE CALLER)  the production sweep scans the rolling 24 hours before the current hour'

-- R06 FINDING 7: TWELVE FIVE-MINUTE ENGINE WINDOWS ------------------------------------------
DO $$
DECLARE v_g uuid; x uuid; y uuid; z uuid; w uuid; v_t0 timestamptz := date_trunc('minute', clock_timestamp()) - interval '70 minutes';
BEGIN
  v_g := harness.lc('R7');
  x := (harness.idle(v_g, false, 1))[1]; y := (harness.idle(v_g, true, 1))[1];
  z := (harness.idle(v_g, false, 2))[2]; w := (harness.idle(v_g, true, 2))[2];
  INSERT INTO harness.r_box (k, game, a, b, c, d, t0) VALUES ('R7', v_g, x, y, z, w, v_t0);
  INSERT INTO harness.r_before VALUES ('R7', harness.r_try(format(
    $q$SELECT jsonb_build_object(
        'reports', (SELECT jsonb_agg(public.fn_lightning_integrity_report(%L, harness.r_window(%L::timestamptz + i * interval '5 minutes',
                       jsonb_build_array(jsonb_build_object('player_id', %L, 'decisions', 5, 'cv', 0.1, 'mean_ms', 800, 'stddev_ms', 80, 'fast_share', 0.1),
                                         jsonb_build_object('player_id', %L, 'decisions', 5, 'cv', 0.1, 'mean_ms', 800, 'stddev_ms', 80, 'fast_share', 0.1)),
                       jsonb_build_array(jsonb_build_object('player_a', %L, 'player_b', %L, 'hands_together', 2,
                                                            'sequential_actions', 3, 'fast_follows', 1, 'latency_corr', 0.8)))) -> 'flagged' ORDER BY i)
                      FROM generate_series(0, 11) i),
        'signals', harness.r_q(format('SELECT to_jsonb(count(*)) FROM public.lightning_integrity_signal s WHERE s.cluster_id = %%L', %L::uuid)))$q$,
    v_g, v_t0, z, w, x, y, v_g)));
  IF ((SELECT j FROM harness.r_before WHERE k = 'R7') ->> 'signals')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL R06: the production report fired on one window: %', (SELECT j FROM harness.r_before WHERE k = 'R7');
  END IF;
END $$;
\echo '  ok  R06 REPRODUCED 7  on the production report twelve five-minute windows of a human-horse pair (2 hands, 3 sequential actions, corr 0.8 each) and two robotic players (5 decisions, cv 0.1 each) never raise a signal'

-- R07 FINDINGS 3 AND 10: THE SHADOW LEDGER ----------------------------------------------------
DO $$
DECLARE v_g uuid; i integer; r jsonb; v_t timestamptz := date_trunc('minute', clock_timestamp()) - interval '6 hours';
BEGIN
  v_g := harness.lc('R10');
  INSERT INTO harness.r_box (k, game, t0) VALUES ('R10', v_g, v_t);
  -- 31 windows neither side could score and 5 scored ones (live m1, shadow m2).
  FOR i IN 0 .. 35 LOOP
    r := public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t + i * interval '5 minutes', v_t + (i + 1) * interval '5 minutes',
           CASE WHEN i < 31 THEN '{"passes": 10}'::jsonb ELSE harness.r_metrics(5, 0) END,
           CASE WHEN i < 31 THEN '{"passes": 10}'::jsonb ELSE harness.r_metrics(5, 0) END);
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: shadow_record refused: %', r; END IF;
  END LOOP;
  INSERT INTO harness.r_before VALUES ('R10', public.fn_lightning_shadow_report(v_g, v_t - interval '1 hour', now()) -> 'version_pairs' -> 0);
  IF ((SELECT j FROM harness.r_before WHERE k = 'R10') ->> 'comparisons')::integer <> 36
     OR (SELECT j FROM harness.r_before WHERE k = 'R10') ->> 'verdict' = 'insufficient_evidence' THEN
    RAISE EXCEPTION 'FAIL R07: the production report did not reproduce finding 10: %', (SELECT j FROM harness.r_before WHERE k = 'R10');
  END IF;
  -- One-sided bb_fairness: the live side measured one order violation in 5,
  -- the shadow side measured nothing; every other component is perfect.
  INSERT INTO harness.r_before VALUES ('R3', harness.r_try(format(
    $q$SELECT public.fn_lightning_shadow_record(%L, 'm1', 'm2', %L::timestamptz - interval '10 minutes', %L::timestamptz - interval '5 minutes',
                                                harness.r_metrics(5, 1), harness.r_metrics(0, 0))$q$, v_g, v_t, v_t)));
  IF (SELECT (j ->> 'live_quality_score')::numeric = (j ->> 'shadow_quality_score')::numeric FROM harness.r_before WHERE k = 'R3') THEN
    RAISE EXCEPTION 'FAIL R07: the production record did not reproduce finding 3: %', (SELECT j FROM harness.r_before WHERE k = 'R3');
  END IF;
END $$;
\echo '  ok  R07 REPRODUCED 3 AND 10  the production report counts 31 unscored windows toward its 36 comparisons and gives a verdict; the production record scores a live side with one BB order violation in 5 at 97 against a shadow that measured none at 100'
ASSERT

# ===========================================================================
# THE ASSERTIONS (after the file).
# ===========================================================================
cat > "$fixture/after.sql" <<'ASSERT'
-- R08 NOTHING FALSIFIED --------------------------------------------------------------------
DO $$
DECLARE v_fallen text;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ') INTO v_fallen
    FROM harness.lp8 b JOIN harness.lp8 a ON a.phase = 'after' AND a.src = b.src AND a.n = b.n
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  IF v_fallen IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL R08: the file falsified predecessor proofs: %', v_fallen;
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND ok) < 150 THEN
    RAISE EXCEPTION 'FAIL R08: too few predecessor proofs held to prove anything';
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND ok AND src = 'p12ops' AND n IN (6, 7)) <> 2 THEN
    RAISE EXCEPTION 'FAIL R08: the anti-manipulation proofs of 20261009144343 did not hold before the file';
  END IF;
END $$;
\echo '  ok  R08 NOTHING FALSIFIED  every predecessor live proof (Phases 2 → 12, the anti-manipulation proofs 6 and 7 of 20261009144343 among them) that held before the file still holds after it'

-- R09 FINDING 1 IS GONE; A GENUINE PAIR IS STILL FOUND; THE MARATHON IS MEDIUM -----------------
DO $$
DECLARE b record; r jsonb; s jsonb;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R1';
  r := public.fn_lightning_integrity_scan(b.game, b.t0, clock_timestamp());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR harness.r_rows(b.game, 'COORDINATED_JOIN_LEAVE') <> 0 THEN
    RAISE EXCEPTION 'FAIL R09: three Lightning on/off cycles still raise COORDINATED_JOIN_LEAVE: %', r;
  END IF;
  IF (SELECT count(DISTINCT ps.cluster_epoch) FROM public.lightning_pool_session ps WHERE ps.cluster_id = b.game) < 3 THEN
    RAISE EXCEPTION 'FIXTURE R09: the Cluster did not run three Lightning epochs';
  END IF;
  SELECT * INTO b FROM harness.r_box WHERE k = 'R1b';
  r := public.fn_lightning_integrity_scan(b.game, b.t0, clock_timestamp());
  s := harness.r_sig(b.game, 'COORDINATED_JOIN_LEAVE', b.a, b.b);
  IF s IS NULL OR (s #>> '{evidence,joint_sessions}')::integer <> 3 OR (s #>> '{evidence,player_initiated_only}')::boolean IS NOT TRUE
     OR harness.r_rows(b.game, 'COORDINATED_JOIN_LEAVE') <> 1 THEN
    RAISE EXCEPTION 'FAIL R09: the human and horse who stopped and returned together three times are not found: % / %', s, r;
  END IF;
  IF (harness.r_sig(b.game, 'SESSION_LENGTH', b.c, NULL) ->> 'suspicion_score')::integer <> 69
     OR harness.r_sig(b.game, 'SESSION_LENGTH', b.c, NULL) ->> 'severity' <> 'medium'
     OR (harness.r_sig(b.game, 'SESSION_LENGTH', b.d, NULL) ->> 'suspicion_score')::integer <> 69
     OR harness.r_sig(b.game, 'SESSION_LENGTH', b.d, NULL) ->> 'severity' <> 'medium'
     OR (r -> 'thresholds' ->> 'long_session_max_score')::integer <> 69 THEN
    RAISE EXCEPTION 'FAIL R09: the marathons are not capped at medium: % / %',
      harness.r_sig(b.game, 'SESSION_LENGTH', b.c, NULL), harness.r_sig(b.game, 'SESSION_LENGTH', b.d, NULL);
  END IF;
END $$;
\echo '  ok  R09 FIXED 1 AND 12  the Cluster that flipped ON and OFF three times raises no COORDINATED_JOIN_LEAVE; the human and the horse who stopped and returned within seconds three times are still found (3 joint, player-initiated only); the thirty-hour human and horse are each SESSION_LENGTH 69 medium, alike'

-- R10 FINDING 2 IS GONE; THE COLLUDING PAIR IS STILL FOUND ------------------------------------
DO $$
DECLARE b record; r jsonb; s jsonb; v_n integer; v_ms numeric; v_t timestamptz;
BEGIN
  FOREACH v_n IN ARRAY ARRAY[18, 25, 50] LOOP
    SELECT * INTO b FROM harness.r_box WHERE k = 'R2:' || v_n;
    v_t := clock_timestamp();
    r := public.fn_lightning_integrity_scan(b.game, b.t0, b.t0 + interval '6 hours');
    v_ms := extract(epoch FROM clock_timestamp() - v_t) * 1000;
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'budget_hit')::boolean THEN
      RAISE EXCEPTION 'FAIL R10: the scan of the pool of % did not answer within budget: %', v_n, r;
    END IF;
    IF v_n <> 25 AND harness.r_rows(b.game, 'PAIRING_CONCENTRATION') <> 0 THEN
      RAISE EXCEPTION 'FAIL R10: the random pool of % still raises PAIRING_CONCENTRATION: %', v_n,
        (SELECT jsonb_agg(s2.evidence) FROM public.lightning_integrity_signal s2 WHERE s2.cluster_id = b.game AND s2.pattern_type = 'PAIRING_CONCENTRATION');
    END IF;
    IF v_n = 25 THEN
      s := harness.r_sig(b.game, 'PAIRING_CONCENTRATION', b.a, b.b);
      IF harness.r_rows(b.game, 'PAIRING_CONCENTRATION') <> 1 OR s IS NULL
         OR s #>> '{evidence,expectation}' <> 'co_presence'
         OR (s #>> '{evidence,concentration_ratio}')::numeric < 3 THEN
        RAISE EXCEPTION 'FAIL R10: the colluding human-horse pair is not the one finding of the pool of 25: % / %', s,
          (SELECT jsonb_agg(s2.evidence) FROM public.lightning_integrity_signal s2 WHERE s2.cluster_id = b.game AND s2.pattern_type = 'PAIRING_CONCENTRATION');
      END IF;
    END IF;
    INSERT INTO harness.timing VALUES ('scan of the random pool of ' || v_n || ' (' || (r ->> 'hands_scanned') || ' hands)', v_ms);
  END LOOP;
END $$;
\echo '  ok  R10 FIXED 2  against the co-presence expectation the random-seating pools of 18 and 50 raise no PAIRING_CONCENTRATION, and in the pool of 25 the planted human-horse pair is the one finding (at least three times its co-presence expectation)'

-- R11 FINDING 5 IS GONE; THE DUMPING PAIR IS STILL FOUND AND MIRRORED ONCE ----------------------
DO $$
DECLARE b record; r jsonb; s jsonb;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R5';
  r := public.fn_lightning_integrity_scan(b.game, b.t0, b.t0 + interval '6 hours');
  s := harness.r_sig(b.game, 'CHIP_FLOW', b.c, b.d);
  IF harness.r_rows(b.game, 'CHIP_FLOW') <> 1 OR s IS NULL OR (s #>> '{evidence,receiver}')::uuid <> b.d
     OR (s #>> '{evidence,win_z}')::numeric < 4 OR (s #>> '{evidence,gross_bb}')::numeric < 50
     OR (s #>> '{evidence,opposed_hands}')::integer <> 40 OR s ->> 'severity' <> 'high' THEN
    RAISE EXCEPTION 'FAIL R11: the chip flow is not the dumping pair alone: % / %', s,
      (SELECT jsonb_agg(s2.evidence) FROM public.lightning_integrity_signal s2 WHERE s2.cluster_id = b.game AND s2.pattern_type = 'CHIP_FLOW');
  END IF;
  IF harness.r_mirrors(b.game) <> 1
     OR (SELECT (cs.detail ->> 'lightning_signal_id')::bigint FROM public.ca_collusion_signals cs
          WHERE cs.detail ->> 'cluster_id' = b.game::text) <> (s ->> 'id')::bigint
     OR (SELECT cs.user_a FROM public.ca_collusion_signals cs WHERE cs.detail ->> 'cluster_id' = b.game::text) <> b.d THEN
    RAISE EXCEPTION 'FAIL R11: the dumping pair is not mirrored exactly once, keyed by its finding';
  END IF;
END $$;
\echo '  ok  R11 FIXED 5  the 300 no-edge pairs at 10 → 15 opposed hands raise no CHIP_FLOW; the human sending 36 of 40 hands to a horse is the one CHIP_FLOW (z >= 4, gross >= 50 BB, high) and lands in ca_collusion_signals once, keyed by its finding'

-- R12 FINDING 6 IS GONE: ONE FINDING PER PAIR, THE CLEARING CARRIES, ONE MIRROR ----------------
DO $$
DECLARE b record; r jsonb; h integer; s jsonb; v_cleared jsonb; v_id bigint;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R6';
  FOR h IN 0 .. 5 LOOP
    r := public.fn_lightning_integrity_scan(b.game, b.t0 + h * interval '1 hour' - interval '24 hours', b.t0 + h * interval '1 hour');
    IF h = 0 THEN
      -- AN OPERATOR CLEARS THE PAIRING after the first scan, through the real door.
      v_id := (harness.r_sig(b.game, 'PAIRING_CONCENTRATION', b.a, b.b) ->> 'id')::bigint;
      v_cleared := harness.door('padmin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, %L)', v_id, 'cleared', 'friends'));
      IF (v_cleared ->> 'ok')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'FIXTURE R12: the operator door refused the review: %', v_cleared;
      END IF;
    END IF;
  END LOOP;
  s := harness.r_sig(b.game, 'PAIRING_CONCENTRATION', b.a, b.b);
  IF (SELECT count(*) FROM public.lightning_integrity_signal x WHERE x.cluster_id = b.game AND x.pattern_type = 'PAIRING_CONCENTRATION'
         AND x.player_a = LEAST(b.a, b.b)) <> 1
     OR (s ->> 'id')::bigint <> v_id OR s ->> 'status' <> 'cleared' OR s ->> 'notes' <> 'friends' OR s ->> 'reviewed_by' IS NULL
     OR (s ->> 'window_start')::timestamptz <> b.t0 - interval '24 hours'
     OR (s ->> 'window_end')::timestamptz <> b.t0 + interval '5 hours'
     OR (s #>> '{evidence,latest_window_end}')::timestamptz <> b.t0 + interval '5 hours' THEN
    RAISE EXCEPTION 'FAIL R12: the pairing is not one cleared finding extended over every rescan: %', s;
  END IF;
  s := harness.r_sig(b.game, 'CHIP_FLOW', b.c, b.d);
  IF (SELECT count(*) FROM public.lightning_integrity_signal x WHERE x.cluster_id = b.game AND x.pattern_type = 'CHIP_FLOW') <> 1
     OR s ->> 'status' <> 'open' OR (s ->> 'window_end')::timestamptz <> b.t0 + interval '5 hours'
     OR harness.r_mirrors(b.game) <> 1 THEN
    RAISE EXCEPTION 'FAIL R12: the chip flow is not one finding mirrored once: % (mirrors %)', s, harness.r_mirrors(b.game);
  END IF;
  -- THE SAME WINDOW AGAIN changes nothing.
  r := public.fn_lightning_integrity_scan(b.game, b.t0 + interval '5 hours' - interval '24 hours', b.t0 + interval '5 hours');
  IF r -> 'written' <> '{}'::jsonb OR (r ->> 'chip_flow_mirrored')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL R12: a rescan of the same window wrote: %', r;
  END IF;
  -- THE MIRROR'S KEY refuses a second row for the finding.
  IF public.fxr_try(format($q$INSERT INTO public.ca_collusion_signals (window_days, user_a, user_b, hands_together, gross_flow, net_flow,
                                  direction_ratio, both_cert, detail)
                              VALUES (1, %L, %L, 1, 1, 1, 1, false, jsonb_build_object('signal', 'lightning_chip_flow', 'lightning_signal_id', %s))$q$,
                            b.d, b.c, s ->> 'id')) NOT LIKE '23505:%' THEN
    RAISE EXCEPTION 'FAIL R12: the mirror key does not refuse a second row';
  END IF;
  -- THE OPERATOR'S VIEW lists a finding detected before the view whose window
  -- reaches into it (time travel on detected_at).
  UPDATE public.lightning_integrity_signal SET detected_at = now() - interval '3 days' WHERE id = (s ->> 'id')::bigint;
  r := harness.door('service', format('SELECT public.fn_lightning_operator_cluster(%L, %L, %L)', b.game, now() - interval '3 hours', now()));
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'integrity_signals') e WHERE (e ->> 'id')::bigint = (s ->> 'id')::bigint) THEN
    RAISE EXCEPTION 'FAIL R12: the operator view does not list the extended finding: %', r -> 'integrity_signals';
  END IF;
END $$;
\echo '  ok  R12 FIXED 6  six hourly rolling rescans leave ONE PAIRING_CONCENTRATION row (the operator''s cleared, note and reviewer carried, its window extended from the first window to the last) and ONE CHIP_FLOW row mirrored ONCE; the same window again writes nothing; the mirror key refuses a second row; the operator view lists a finding whose window reaches the view'
ASSERT

# THE CONCURRENT RUNS happen between after.sql and after2.sql (bash, two backends).
cat > "$fixture/conc-prep.sql" <<'ASSERT'
DO $$
DECLARE v_g uuid; c uuid; d uuid; kk integer; v_t0 timestamptz := date_trunc('hour', clock_timestamp()) - interval '3 hours';
BEGIN
  PERFORM setseed(0.71);
  v_g := harness.lc('R6c');
  c := (harness.idle(v_g, false, 1))[1]; d := (harness.idle(v_g, true, 1))[1];
  FOR kk IN 0 .. 80 LOOP
    PERFORM harness.r_duel(v_g, c, d, v_t0 - interval '24 hours' + kk * interval '17 minutes', 4 + floor(random() * 17));
  END LOOP;
  INSERT INTO harness.r_box (k, game, c, d, t0) VALUES ('R6c', v_g, c, d, v_t0);
END $$;
ASSERT

cat > "$fixture/after2.sql" <<'ASSERT'
-- R13 OVERLAPPING RUNS DO NOT DOUBLE-INSERT ---------------------------------------------------
DO $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R6c';
  IF harness.r_rows(b.game, 'CHIP_FLOW') <> 1 OR harness.r_mirrors(b.game) <> 1 THEN
    RAISE EXCEPTION 'FAIL R13: two overlapping scans on two backends wrote % findings and % mirrors',
      harness.r_rows(b.game, 'CHIP_FLOW'), harness.r_mirrors(b.game);
  END IF;
END $$;
\echo '  ok  R13 OVERLAPPING RUNS  two scans of one Cluster over overlapping windows, on two backends at once, each holding its transaction open, leave one CHIP_FLOW finding and one mirror'

-- R14 FINDING 6 (THE CALLER): THE SWEEP PASSES THE PREVIOUS FULL UTC DAY ONCE A DAY ---------------
DO $$
DECLARE b record; v jsonb; v2 jsonb; v_day timestamptz := date_trunc('day', now(), 'UTC');
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R6s';
  v := harness.sweep();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'integrity_scans') e WHERE e ->> 'cluster_id' = b.game::text)
     OR (SELECT (st.detail ->> 'window_from')::timestamptz FROM public.lightning_alert_sweep_state st
          WHERE st.key = 'integrity_scan:' || b.game) <> v_day - interval '1 day'
     OR (SELECT (st.detail ->> 'window_to')::timestamptz FROM public.lightning_alert_sweep_state st
          WHERE st.key = 'integrity_scan:' || b.game) <> v_day THEN
    RAISE EXCEPTION 'FAIL R14: the sweep did not scan the previous full UTC day: % / %', v -> 'integrity_scans',
      (SELECT st.detail FROM public.lightning_alert_sweep_state st WHERE st.key = 'integrity_scan:' || b.game);
  END IF;
  v2 := harness.sweep();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v2 -> 'integrity_scans') e WHERE e ->> 'cluster_id' = b.game::text) THEN
    RAISE EXCEPTION 'FAIL R14: the sweep scanned the same Cluster twice in one UTC day: %', v2 -> 'integrity_scans';
  END IF;
END $$;
\echo '  ok  R14 FIXED 6 (THE CALLER)  the sweep scans a telemetry Cluster over the previous full UTC day, and not again the same day'

-- R15 FINDING 7 IS GONE: ENGINE EVIDENCE AGGREGATES OVER THE DAY -----------------------------
DO $$
DECLARE b record; i integer; r jsonb; s jsonb; v_win jsonb;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R7';
  FOR i IN 0 .. 11 LOOP
    v_win := harness.r_window(b.t0 + i * interval '5 minutes',
               jsonb_build_array(jsonb_build_object('player_id', b.c, 'decisions', 5, 'cv', 0.1, 'mean_ms', 800, 'stddev_ms', 80, 'fast_share', 0.1),
                                 jsonb_build_object('player_id', b.d, 'decisions', 5, 'cv', 0.1, 'mean_ms', 800, 'stddev_ms', 80, 'fast_share', 0.1)),
               jsonb_build_array(jsonb_build_object('player_a', b.a, 'player_b', b.b, 'hands_together', 2,
                                                    'sequential_actions', 3, 'fast_follows', 1, 'latency_corr', 0.8)));
    r := public.fn_lightning_integrity_report(b.game, v_win);
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'evidence_stored')::integer <> 3
       OR (r ->> 'aggregation_hours')::integer <> 24 THEN
      RAISE EXCEPTION 'FAIL R15: window % was not stored: %', i, r;
    END IF;
    IF i = 8 AND EXISTS (SELECT 1 FROM public.lightning_integrity_signal x WHERE x.cluster_id = b.game) THEN
      RAISE EXCEPTION 'FAIL R15: nine windows (45 decisions, 18 hands) already raised a signal';
    END IF;
    IF i = 9 AND (r -> 'flagged' <> jsonb_build_object('DECISION_LATENCY', 2, 'TIMING_CORRELATION', 1) OR (r ->> 'inserted')::integer <> 3) THEN
      RAISE EXCEPTION 'FAIL R15: the tenth window (50 decisions, 20 hands, 30 sequential actions) did not raise all three: %', r;
    END IF;
  END LOOP;
  s := harness.r_sig(b.game, 'TIMING_CORRELATION', b.a, b.b);
  IF s IS NULL OR (s #>> '{evidence,hands_together}')::numeric <> 24 OR (s #>> '{evidence,sequential_actions}')::numeric <> 36
     OR (s #>> '{evidence,windows}')::integer <> 12 OR (s ->> 'suspicion_score')::integer <> 80 OR s ->> 'source' <> 'engine'
     OR (s ->> 'window_start')::timestamptz <> b.t0 OR (s ->> 'window_end')::timestamptz <> b.t0 + interval '60 minutes'
     OR (SELECT count(*) FROM public.lightning_integrity_signal x WHERE x.cluster_id = b.game) <> 3 THEN
    RAISE EXCEPTION 'FAIL R15: the timing correlation is not one finding over the twelve windows: %', s;
  END IF;
  IF (harness.r_sig(b.game, 'DECISION_LATENCY', b.c, NULL) ->> 'suspicion_score')::integer <> 63
     OR (harness.r_sig(b.game, 'DECISION_LATENCY', b.d, NULL) ->> 'suspicion_score')::integer <> 63
     OR (harness.r_sig(b.game, 'DECISION_LATENCY', b.d, NULL) #>> '{evidence,decisions}')::numeric <> 60
     OR (harness.r_sig(b.game, 'DECISION_LATENCY', b.d, NULL) #>> '{evidence,cv}')::numeric <> 0.1 THEN
    RAISE EXCEPTION 'FAIL R15: the human and the horse are not timed alike over the day: % / %',
      harness.r_sig(b.game, 'DECISION_LATENCY', b.c, NULL), harness.r_sig(b.game, 'DECISION_LATENCY', b.d, NULL);
  END IF;
  -- THE LAST WINDOW AGAIN: idempotent, nothing grows.
  r := public.fn_lightning_integrity_report(b.game, v_win);
  IF (r ->> 'inserted')::integer <> 0 OR (r ->> 'updated')::integer <> 0 OR (r ->> 'unchanged')::integer <> 3
     OR (SELECT count(*) FROM public.lightning_integrity_engine_window w WHERE w.cluster_id = b.game) <> 36 THEN
    RAISE EXCEPTION 'FAIL R15: a resent window was not idempotent: %', r;
  END IF;
  -- A CARD KEY is still refused, and nothing is stored for it.
  r := public.fn_lightning_integrity_report(b.game, v_win || '{"players": [{"player_id": "00000000-0000-0000-0000-000000000001", "hole_cards": 1}]}'::jsonb);
  IF r ->> 'reason' <> 'evidence_carries_cards' THEN
    RAISE EXCEPTION 'FAIL R15: a card key was not refused: %', r;
  END IF;
END $$;
\echo '  ok  R15 FIXED 7  twelve five-minute engine windows aggregate over the rolling day: nothing at nine windows, at the tenth one TIMING_CORRELATION for the human-horse pair and DECISION_LATENCY for a human and a horse alike, and after twelve one finding each spanning the hour (24 hands, 36 sequential actions, 60 decisions, pooled cv 0.1); a resent window changes nothing; a card key is still refused'

-- R16 FINDINGS 3 AND 10 ARE GONE; A/A IS RECORDED -----------------------------------------------
DO $$
DECLARE b record; r jsonb; p jsonb; v_aa jsonb;
BEGIN
  SELECT * INTO b FROM harness.r_box WHERE k = 'R10';
  p := public.fn_lightning_shadow_report(b.game, b.t0 - interval '1 hour', now()) -> 'version_pairs' -> 0;
  IF (p ->> 'comparisons')::integer <> 5 OR (p ->> 'windows')::integer <> 36 OR p ->> 'verdict' <> 'insufficient_evidence'
     OR (p ->> 'aa_calibration')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL R16: the report still counts unscored windows: %', p;
  END IF;
  -- LIKE FOR LIKE: the same one-sided windows.
  r := public.fn_lightning_shadow_record(b.game, 'm1', 'm2', b.t0 - interval '10 minutes', b.t0 - interval '5 minutes',
                                         harness.r_metrics(5, 1), harness.r_metrics(0, 0));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'live_quality_score')::numeric <> 100
     OR (r ->> 'shadow_quality_score')::numeric <> 100 OR (r ->> 'quality_delta')::numeric <> 0
     OR r #> '{components,live,bb_fairness}' <> 'null'::jsonb OR r #> '{components,shadow,bb_fairness}' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL R16: a component one side could not measure still reweights the scores: %', r;
  END IF;
  -- Order violations null on both sides (the engine's choice): accepted, both null.
  r := public.fn_lightning_shadow_record(b.game, 'm1', 'm2', b.t0 - interval '20 minutes', b.t0 - interval '15 minutes',
                                         harness.r_metrics(5, NULL), harness.r_metrics(5, NULL));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'live_quality_score')::numeric <> 100 THEN
    RAISE EXCEPTION 'FAIL R16: null order violations on both sides were not recorded: %', r;
  END IF;
  -- THE SCORE IS fn_lightning_quality_score's OWN ARITHMETIC over shared components.
  r := public.fn_lightning_shadow_record(b.game, 'm1', 'm2', b.t0 - interval '30 minutes', b.t0 - interval '25 minutes',
                                         harness.r_metrics(5, 1), harness.r_metrics(5, 2));
  IF (r ->> 'live_quality_score')::numeric <> public.fn_lightning_quality_score(harness.r_metrics(5, 1))
     OR (r ->> 'shadow_quality_score')::numeric <> public.fn_lightning_quality_score(harness.r_metrics(5, 2)) THEN
    RAISE EXCEPTION 'FAIL R16: scores over full components differ from fn_lightning_quality_score: %', r;
  END IF;
  -- A/A CALIBRATION: live m1 against its port m1-port is recorded; identical versions are refused.
  v_aa := public.fn_lightning_shadow_record(b.game, 'm1', 'm1-port', b.t0 - interval '40 minutes', b.t0 - interval '35 minutes',
                                            harness.r_metrics(5, NULL), harness.r_metrics(5, NULL));
  IF (v_aa ->> 'ok')::boolean IS DISTINCT FROM true OR v_aa ->> 'shadow_matcher_version' <> 'm1-port' THEN
    RAISE EXCEPTION 'FAIL R16: A/A calibration was refused: %', v_aa;
  END IF;
  IF public.fn_lightning_shadow_record(b.game, 'm1', 'm1', b.t0 - interval '50 minutes', b.t0 - interval '45 minutes',
                                       harness.r_metrics(5, 0), harness.r_metrics(5, 0)) ->> 'reason' <> 'SAME_VERSION'
     OR public.fn_lightning_shadow_record(b.game, NULL, 'm1', b.t0 - interval '50 minutes', b.t0 - interval '45 minutes',
                                          harness.r_metrics(5, 0), harness.r_metrics(5, 0)) ->> 'reason' <> 'SAME_VERSION' THEN
    RAISE EXCEPTION 'FAIL R16: identical versions are no longer refused';
  END IF;
  p := public.fn_lightning_shadow_report(b.game, b.t0 - interval '2 hours', now());
  IF p -> 'version_pairs' -> 0 ->> 'shadow_matcher_version' <> 'm2'
     OR p -> 'version_pairs' -> 1 ->> 'shadow_matcher_version' <> 'm1-port'
     OR (p -> 'version_pairs' -> 1 ->> 'aa_calibration')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL R16: the A/A pair is not labelled and sorted after the candidate: %', p;
  END IF;
END $$;
\echo '  ok  R16 FIXED 3 AND 10  the report counts 5 comparisons of 36 windows and says insufficient_evidence; a component one side could not measure is null on both, so the one-sided window scores 100 against 100; null order violations on both sides are recorded; full components score exactly as fn_lightning_quality_score; live m1 against shadow m1-port is recorded as A/A and sorted after the candidate, identical versions still SAME_VERSION'

-- R17 THE NEW STORE IS CLOSED; NO SEATING PATH READS IT ----------------------------------------
DO $$
BEGIN
  IF has_table_privilege('service_role', 'public.lightning_integrity_engine_window', 'SELECT')
     OR has_table_privilege('authenticated', 'public.lightning_integrity_engine_window', 'SELECT')
     OR has_table_privilege('anon', 'public.lightning_integrity_engine_window', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lightning_integrity_engine_window'::regclass)
     OR (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name LIKE 'lightning\_%'
           AND grantee = 'service_role' AND privilege_type = 'SELECT') <> 7 THEN
    RAISE EXCEPTION 'FAIL R17: the engine evidence store is not closed, or the seven-table census moved';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (
       'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure,
       'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
       'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)'::regprocedure,
       'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
       'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
       'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure)
     AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'integrity|shadow_comparison|quality_|latency') THEN
    RAISE EXCEPTION 'FAIL R17: a seating body reads telemetry';
  END IF;
END $$;
\echo '  ok  R17 CLOSED AND UNREAD  lightning_integrity_engine_window has RLS on and no privilege for any role, seven Lightning tables are still granted to the service, and no seating body reads any telemetry'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- R18 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 12
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL R18: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  R18 THE LIVE PROOFS  all twelve @live-proof claims of the file evaluate true against this catalogue after the estate above ran through it'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['public.lightning_integrity_signal', 'public.lightning_integrity_engine_window', 'public.ca_collusion_signals',
                    'public.lightning_matcher_shadow_comparison']) x(t)
UNION ALL
SELECT 'signals', md5(coalesce(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), '')) FROM public.lightning_integrity_signal s
UNION ALL
SELECT 'acl', coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c WHERE c.oid = 'public.lightning_integrity_engine_window'::regclass
UNION ALL
SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
 WHERE i.indrelid IN ('public.lightning_integrity_engine_window'::regclass, 'public.lightning_integrity_signal'::regclass,
                      'public.ca_collusion_signals'::regclass)
UNION ALL
SELECT 'config', md5(public.fn_lightning_config(NULL)::text);
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- R19 RE-APPLIABLE ------------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  CREATE TEMP TABLE rcap2 AS
  SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
  UNION ALL
  SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
    FROM unnest(ARRAY['public.lightning_integrity_signal', 'public.lightning_integrity_engine_window', 'public.ca_collusion_signals',
                      'public.lightning_matcher_shadow_comparison']) x(t)
  UNION ALL
  SELECT 'signals', md5(coalesce(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), '')) FROM public.lightning_integrity_signal s
  UNION ALL
  SELECT 'acl', coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c WHERE c.oid = 'public.lightning_integrity_engine_window'::regclass
  UNION ALL
  SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
   WHERE i.indrelid IN ('public.lightning_integrity_engine_window'::regclass, 'public.lightning_integrity_signal'::regclass,
                        'public.ca_collusion_signals'::regclass)
  UNION ALL
  SELECT 'config', md5(public.fn_lightning_config(NULL)::text);
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a FULL JOIN rcap2 b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL R19: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 70 THEN
    RAISE EXCEPTION 'FAIL R19: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  R19 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body and ACL, the configuration answer, every signal, mirror, evidence and comparison row, the new store''s ACL and RLS and every index exactly as they were'
ASSERT

{ predecessor_proofs before; } > "$fixture/proofs-before.sql"
{ predecessor_proofs after; } > "$fixture/proofs-after.sql"
{ gen_proofs own mine "$mine"; } > "$fixture/own-proofs-eval.sql"

filter() { grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp[0-9a-z]*_rewrite|^-+$|^ *$|^\([0-9]+ rows?\)$|^ +format *$' ; }
run() { # label file...
  local label=$1; shift
  local args=() f
  for f in "$@"; do args+=(-f "$f"); done
  set +e
  "${PSQL[@]}" "${args[@]}" 2>&1 | filter | tee -a "$fixture/psql.out"
  local status=${PIPESTATUS[0]}
  set -e
  if [ "$status" != 0 ]; then echo "FAIL: psql exited $status during $label"; exit 1; fi
}

# ===========================================================================
# THE RUN.
# ===========================================================================
: > "$fixture/psql.out"
run chain \
  "$base_fixture" "$pop_fixture" "$p5_fixture" \
  "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" \
  "$p9_fixture" "$phase9" "$phase9r" "$r2_fixture" \
  "$r2a" "$r2b" "$r2c" "$r2d" "$p6_fixture" "$p6" "$s6_fixture" "$s6" "$s6r" "$p7" \
  "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" \
  "$fixture/ground.sql" "$p11" "$p12rg" "$fixture/ground12.sql" "$p12ops" "$p12lc" \
  "$fixture/rground.sql"
run before "$fixture/before.sql"
run apply "$fixture/proofs-before.sql" "$mine" "$fixture/proofs-after.sql"
run after "$fixture/after.sql" "$fixture/conc-prep.sql"

# R13: TWO BACKENDS, overlapping windows, each holding its transaction open.
conc_sql() { # hours offset
  local g t0
  g=$(Q "SELECT game FROM harness.r_box WHERE k = 'R6c'")
  t0=$(Q "SELECT t0 FROM harness.r_box WHERE k = 'R6c'")
  printf "BEGIN; SELECT public.fn_lightning_integrity_scan('%s', '%s'::timestamptz + interval '%s hours' - interval '24 hours', '%s'::timestamptz + interval '%s hours'); SELECT pg_sleep(1.5); COMMIT;\n" "$g" "$t0" "$1" "$t0" "$1"
}
conc_sql 0 > "$fixture/conc0.sql"; conc_sql 1 > "$fixture/conc1.sql"
( "${PSQL[@]}" -f "$fixture/conc0.sql" > "$fixture/conc0.out" 2>&1; echo "rc=$?" >> "$fixture/conc0.out" ) &
( "${PSQL[@]}" -f "$fixture/conc1.sql" > "$fixture/conc1.out" 2>&1; echo "rc=$?" >> "$fixture/conc1.out" ) &
wait
grep -q 'rc=0' "$fixture/conc0.out" && grep -q 'rc=0' "$fixture/conc1.out" \
  || { cat "$fixture/conc0.out" "$fixture/conc1.out"; echo "FAIL: a concurrent scan failed"; exit 1; }

run after2 "$fixture/after2.sql" "$fixture/own-proofs-eval.sql" "$fixture/own-proofs.sql" \
  "$fixture/precapture.sql" "$mine" "$fixture/reapply.sql"

# TWENTY SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  R[0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 20 ]; then
  echo "FAIL: $oks of the 20 sections reported, so this run proved less than this file claims"
  exit 1
fi
Q "SELECT what || ': ' || round(ms) || ' ms' FROM harness.timing WHERE what LIKE 'scan of%' ORDER BY what"
Q "SELECT 'reproduced on the production bodies: COORDINATED_JOIN_LEAVE ' || (SELECT j ->> 'cjl' FROM harness.r_before WHERE k = 'R1')
          || ' pairs over three on/off cycles; PAIRING_CONCENTRATION ' || (SELECT string_agg(substr(k, 4) || ':' || (j ->> 'pairing'), ' ' ORDER BY length(k), k) FROM harness.r_before WHERE k LIKE 'R2:%')
          || '; CHIP_FLOW ' || (SELECT j ->> 'chip_flow' FROM harness.r_before WHERE k = 'R5') || ' (' || (SELECT j ->> 'mirrors' FROM harness.r_before WHERE k = 'R5')
          || ' mirrored) of 300 no-edge pairs plus the dumper; six rescans wrote ' || (SELECT j ->> 'pairing' FROM harness.r_before WHERE k = 'R6') || ' + '
          || (SELECT j ->> 'chip_flow' FROM harness.r_before WHERE k = 'R6') || ' rows and ' || (SELECT j ->> 'mirrors' FROM harness.r_before WHERE k = 'R6') || ' mirrors'"
echo "PASS: Lightning Phase 11 remediation (DB), 20 sections, over the real chain through 20261009151825 under production's default ACLs and live autorevoke trigger, humans and horses in every pool: every finding reproduced on the production bodies first (a Cluster flipping ON and OFF three times, random-seating pools of 18, 25 and 50, no-edge pairs at 10 → 15 opposed hands, six hourly rolling rescans, the sweep's rolling window, twelve five-minute engine windows, unscored shadow windows and a one-sided component, a 90-high marathon) and gone after the file, while the planted colluders, the dumping pair, the coordinated pair and the engine-timed pair and players are still found; one finding per subject that extends with the operator's review carried, one mirror per finding under overlapping runs; no predecessor proof falsified; every own proof true; re-appliable"
