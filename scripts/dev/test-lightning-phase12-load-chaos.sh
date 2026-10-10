#!/usr/bin/env bash
# Lightning Phase 12 (the database side): load, stress and chaos.
#
# Proves that the real Lightning chain keeps money and identity exact under
# many real concurrent backends and injected faults, on Postgres 17, socket
# only, on port 55561 (LIGHTNING_P12_PORT overrides it). Spec Phase 20, LOAD /
# STRESS / CHAOS: NO duplicate money, NO lost money, NO duplicate player, NO
# duplicate hand, NO duplicate blind, NO orphan reservation, NO ambiguous
# settlement.
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 11 (20261008161509) and this phase's responsible-gaming
# file (20261009143757), in order, exactly as
# test-lightning-phase11-integrity-shadow.sh builds them, on that harness's
# own ground (read from it, so the two can never drift): its helpers,
# production's default function privileges and its live
# trg_autorevoke_privileged_anon event trigger, the production reload door
# stand-in atomic_table_rebuy, the cashier. Every Cluster is converted ON by
# the real drive; every hand is formed by the real matcher or the real
# barrier, dealt by the real begin_dealing, numbered by the real bind, folded
# through the real fold door and settled through the real settlement and the
# real physical commit; reloads go through the real auto-rebuy; presence,
# reapers, Stop Playing, the drive and the tick are the real ones. The rows
# the harness writes itself are fixture boundaries only: arrivals and
# departures at the seat (the buy-in and the cash-out), the engine's lease,
# its halt acknowledgement and its addon delivery, backdated stamps (time
# travel), and fault triggers armed per session by a GUC.
#
# CONCURRENCY IS REAL: every worker is its own psql backend (application name
# lcw-<kind>), many per Cluster, two matchers and a direct barrier caller on
# the same Cluster at once. The chaos is real: pg_cancel_backend,
# pg_terminate_backend, statement_timeout and lock_timeout land mid
# transaction, and a sleep armed inside the settlement, the barrier and the
# conversion gives them a window.
#
# AFTER EVERY SCENARIO the engine drains through the same doors, the
# production reapers run, and lc.check asserts with SQL: chip conservation
# (seats, wallets and unresolved reloads against the books before, less what
# arrivals brought), every seat reconciled to exactly the nets of the hands
# it settled and the reloads delivered to it, every hand conserving, every
# settled hand committed exactly once, idempotent replays, no duplicate
# player, hand or blind (the blind ledger against the kept formations), no
# orphan reservation, no ambiguous settlement, no unwarranted freeze,
# consistent Cluster modes, and no production door raising anything but a
# retryable class. P50/P95/P99 of match_and_form, form_hand, fast_fold and
# settle_hand (and the rest) are printed per population as a scoreboard.
#
# PROFILES. LIGHTNING_CHAOS_PROFILE=full (the default) loads 10, 50, 100,
# 500, 1,000, 5,000 and 10,000 eligible players per Cluster; ci loads 10,
# 50, 100 and 500 with short storms so the CI step stays under six minutes.
# LIGHTNING_P12_POPS overrides the population list.
#
# LAW 10.5. Horses sit beside humans in every Cluster (the fixture's mix,
# and every second arrival is a horse); nothing in this file reads is_horse
# or horse_id.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P12_PORT:-55561}
profile=${LIGHTNING_CHAOS_PROFILE:-full}
case "$profile" in
  full) pops_default="10 50 100 500 1000 5000 10000"; T_LOAD=12; T_BIG=20; T_STRESS=15; T_CHAOS=15; maxconn=400; W=1 ;;
  ci)   pops_default="10 50 100 500"; T_LOAD=6; T_BIG=6; T_STRESS=8; T_CHAOS=8; maxconn=200; W=0 ;;
  *) echo "FAIL: LIGHTNING_CHAOS_PROFILE must be full or ci, not $profile"; exit 1 ;;
esac
pops=${LIGHTNING_P12_POPS:-$pops_default}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
p11_harness=$root/scripts/dev/test-lightning-phase11-integrity-shadow.sh
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
# Any later Lightning file this phase ships (a fix found by this harness)
# is applied after the chain, twice; LIGHTNING_P12_EXTRA overrides the list.
extra=${LIGHTNING_P12_EXTRA-$(find "$M" -maxdepth 1 -name '*_lightning_phase_12_load_chaos_*.sql' | sort | tr '\n' ' ')}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$p12rg" "$p11_harness" $extra; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p12-test.XXXXXX")
sock=$fixture/s
started=0
cleanup() {
  local pids
  pids="$(jobs -p 2>/dev/null || true) $(cat "$fixture/pids" 2>/dev/null || true)"
  [ -n "${pids// /}" ] && kill $pids 2>/dev/null || true
  sleep 1
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true; fi
  if [ -n "${LIGHTNING_P12_KEEP:-}" ]; then echo "kept $fixture"; else rm -rf "$fixture"; fi
}
trap cleanup EXIT
mkdir "$sock" "$fixture/ops"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
# A throwaway cluster: durability off, room for every worker.
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w \
  -o "-k $sock -p $port -h '' -c max_connections=$maxconn -c shared_buffers=256MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_locks_per_transaction=256 -c deadlock_timeout=200ms -c log_min_messages=${LIGHTNING_P12_LOGLEVEL:-fatal}" start >/dev/null
started=1
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$sock" -p "$port" -d postgres)
Q() { "${PSQL[@]}" -At -c "$1"; }

# THE PHASE 11 HARNESS'S GROUND, read from it: everything between its
# ground heredoc's opening and closing lines.
awk '/^cat > "\$fixture\/ground.sql" <<.ASSERT.$/{f=1;next} f&&/^ASSERT$/{exit} f' "$p11_harness" > "$fixture/p11-ground.sql"
grep -q 'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon' "$fixture/p11-ground.sql" \
  && grep -q 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role' "$fixture/p11-ground.sql" \
  && grep -q 'CREATE OR REPLACE FUNCTION public.atomic_table_rebuy' "$fixture/p11-ground.sql" \
  && grep -q 'CREATE FUNCTION harness.c8' "$fixture/p11-ground.sql" \
  || { echo "FAIL: the Phase 11 harness's ground could not be read (production ACLs, autorevoke, reload door, Cluster builder)"; exit 1; }

cat > "$fixture/ground.sql" <<'ASSERT'
-- ===========================================================================
-- PHASE 12'S OWN GROUND: the load, stress and chaos rig. Everything here is a
-- fixture boundary (the engine's side of each call, the clock, the cashier)
-- or a reader; every economic action goes through the production door.
-- Schema lc. Nothing reads is_horse or horse_id: a horse is seated by the
-- Phase 3 fixture's horse_id column and never looked at again.
-- ===========================================================================
CREATE SCHEMA lc;
CREATE SEQUENCE lc.seat_numbers START 100000;

-- THE RUN'S BOOKS. Unlogged where they are write-hot.
CREATE UNLOGGED TABLE lc.lat (
  id bigserial PRIMARY KEY, scen text NOT NULL, pop integer, op text NOT NULL, ms numeric NOT NULL,
  outcome text, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE UNLOGGED TABLE lc.err (
  id bigserial PRIMARY KEY, scen text, op text, sqlstate text, msg text, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lc.violation (
  id bigserial PRIMARY KEY, scen text, what text NOT NULL, detail jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE lc.cl (id uuid PRIMARY KEY, scen text NOT NULL, pop integer NOT NULL, handed integer NOT NULL,
                    role text NOT NULL DEFAULT 'play', front uuid, stakes text, variant text);
CREATE TABLE lc.ctl (scen text PRIMARY KEY, until timestamptz NOT NULL, pop integer);
CREATE TABLE lc.minted (id bigserial PRIMARY KEY, scen text NOT NULL, cluster_id uuid, seat_id uuid NOT NULL, player_id uuid,
                        amount numeric NOT NULL);
CREATE TABLE lc.passes (request_id uuid PRIMARY KEY, scen text, cluster_id uuid, answer jsonb);
CREATE TABLE lc.forms (request_id uuid PRIMARY KEY, scen text, cluster_id uuid, players uuid[], answer jsonb);
CREATE TABLE lc.settles (id bigserial PRIMARY KEY, scen text, hand_id uuid, request_id uuid, args jsonb, answer jsonb);
CREATE TABLE lc.snap (scen text, seat_id uuid, player_id uuid, stack numeric, PRIMARY KEY (scen, seat_id));
CREATE TABLE lc.snap_hand (scen text, hand_id uuid, PRIMARY KEY (scen, hand_id));
CREATE TABLE lc.snap_addon (scen text, addon_id uuid, PRIMARY KEY (scen, addon_id));
CREATE TABLE lc.snap_meta (scen text PRIMARY KEY, at timestamptz, total numeric, seats numeric, wallets numeric, addons numeric);
CREATE TABLE lc.kills (id bigserial PRIMARY KEY, scen text, mode text, pid integer, app text, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE lc.verdict (id bigserial PRIMARY KEY, scen text, inv text, ok boolean, detail text);
CREATE TABLE lc.expect_frozen (scen text, cluster_id uuid);
-- Players a scenario holds out of the flapping and the fold bar (they stay gone).
CREATE TABLE lc.held (player_id uuid PRIMARY KEY);

CREATE FUNCTION lc.scen() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('lc.scen', true), ''), 'none');
$f$;
CREATE FUNCTION lc.live() RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT coalesce((SELECT clock_timestamp() < c.until FROM lc.ctl c WHERE c.scen = lc.scen()), false);
$f$;
CREATE FUNCTION lc.pop() RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT c.pop FROM lc.ctl c WHERE c.scen = lc.scen();
$f$;
CREATE FUNCTION lc.lat(p_op text, p_t0 timestamptz, p_outcome text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO lc.lat (scen, pop, op, ms, outcome)
  VALUES (lc.scen(), lc.pop(), p_op, round(extract(epoch FROM clock_timestamp() - p_t0) * 1000, 3), p_outcome);
$f$;
CREATE FUNCTION lc.fail(p_op text, p_state text, p_msg text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO lc.err (scen, op, sqlstate, msg) VALUES (lc.scen(), p_op, p_state, left(p_msg, 500));
$f$;
CREATE FUNCTION lc.violate(p_what text, p_detail jsonb) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO lc.violation (scen, what, detail) VALUES (lc.scen(), p_what, p_detail);
$f$;
-- THE ENGINE'S PACE, between transactions (a nap inside one would hold
-- its locks): a matcher passes every pass_interval_ms, jittered, so two
-- workers overlap as two engine nodes would rather than in lockstep (lc.pace
-- overrides the interval in milliseconds); the other workers that a real
-- engine drives off events rather than a loop nap briefly.
CREATE FUNCTION lc.nap(p_kind text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v numeric;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  v := CASE p_kind
         WHEN 'match' THEN coalesce(nullif(current_setting('lc.pace', true), '')::numeric, 1000) * (0.5 + random() * 0.5)
         WHEN 'form' THEN 200 * random()
         WHEN 'rebuy' THEN 50 + 100 * random()
         WHEN 'match_replay' THEN 100 + 200 * random()
         WHEN 'settle_replay' THEN 50 + 100 * random()
         WHEN 'presence' THEN coalesce(nullif(current_setting('lc.pace_presence', true), '')::numeric, 100) * random()
         WHEN 'tick' THEN 200 + 300 * random()
         WHEN 'drive' THEN 20 + 80 * random()
         WHEN 'ack' THEN 50
         WHEN 'join' THEN 50 + 100 * random()
         WHEN 'leave' THEN 50 + 100 * random()
         WHEN 'stop' THEN 50 + 100 * random()
         WHEN 'wave' THEN 100 + 300 * random()
         -- An engine deals, folds and settles on events, never by spinning:
         -- a few milliseconds between calls keeps idle workers off the CPU
         -- the matcher's pass needs.
         WHEN 'deal' THEN 2 + 6 * random()
         WHEN 'fold' THEN 2 + 6 * random()
         WHEN 'settle' THEN 2 + 6 * random()
         ELSE 0 END;
  IF v > 0 THEN PERFORM pg_sleep(v / 1000.0); END IF;
END $f$;
-- A Cluster of this scenario, at random (or a named role).
CREATE FUNCTION lc.pick(p_role text DEFAULT 'play') RETURNS uuid LANGUAGE sql VOLATILE AS $f$
  SELECT c.id FROM lc.cl c WHERE c.scen = lc.scen() AND c.role = p_role ORDER BY random() LIMIT 1;
$f$;

-- THE ENGINE'S LIVE LEASE on a table: a heartbeat the stale window cannot
-- catch during the run (fixture boundary; production's engine heartbeats).
CREATE FUNCTION lc.lease(p_table uuid) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.engine_table_leases (table_id, instance_id, heartbeat_at, protocol_version)
  VALUES (p_table, 'lc-engine', clock_timestamp() + interval '1 day', 2)
  ON CONFLICT (table_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at, instance_id = 'lc-engine';
$f$;

-- ONE ARRIVAL with the Cluster's own stakes: a seat on a feeder of the
-- Cluster and the cluster-scoped cash session, the order the live buy-in
-- uses. The pool follows through production's deferred seat trigger.
CREATE FUNCTION lc.arrive(p_game uuid, p_horse boolean, p_stack numeric DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE g record; v_tb uuid; v_u uuid := gen_random_uuid(); v_seat uuid;
        v_stack numeric := coalesce(p_stack, 150.00 + (nextval('lc.seat_numbers') % 97));
BEGIN
  SELECT cg.id, cg.sb, cg.bb, cg.variant INTO g FROM public.cash_games cg WHERE cg.id = p_game;
  SELECT tb.id INTO v_tb FROM public.tables tb
   WHERE tb.cluster_id = p_game AND tb.role = 'feeder' AND coalesce(tb.is_deleted, false) = false
   ORDER BY tb.created_at, tb.id LIMIT 1;
  IF v_tb IS NULL THEN v_tb := public.fxr_main(p_game); END IF;
  INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at, horse_id)
  VALUES (v_tb, v_u, nextval('lc.seat_numbers'), v_stack, false, false, clock_timestamp(),
          CASE WHEN p_horse THEN gen_random_uuid() ELSE NULL END)
  RETURNING id INTO v_seat;
  INSERT INTO public.cash_player_session
    (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
  VALUES (v_u, 'cb000000-0000-0000-0000-000000000001', 'cluster', p_game, v_tb,
          g.variant, g.sb, g.bb, v_stack, p_game, clock_timestamp());
  INSERT INTO lc.minted (scen, cluster_id, seat_id, player_id, amount) VALUES (lc.scen(), p_game, v_seat, v_u, v_stack);
  RETURN v_u;
END $f$;
CREATE FUNCTION lc.arrive_many(p_game uuid, p_n integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE i integer;
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  FOR i IN 1 .. p_n LOOP PERFORM lc.arrive(p_game, i % 2 = 0); END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
END $f$;

-- A CLUSTER FOR THE RUN: the Phase 8 fixture's Cluster (front table and
-- feeder, humans and horses at both), its stakes and variant set before it
-- converts, converted ON by two real drive passes, then filled (or thinned)
-- to the population, its slots synced by the real sync, the engine lease on
-- the front table, wallets funded for reloads.
CREATE FUNCTION lc.build(p_scen text, p_key text, p_handed integer, p_pop integer, p_sb numeric DEFAULT 1,
                         p_variant text DEFAULT 'nlh', p_cfg jsonb DEFAULT '{}'::jsonb, p_convert boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; v_on integer; v_base integer; r record;
BEGIN
  PERFORM set_config('lc.scen', p_scen, true);
  IF p_handed = 9 THEN v_g := harness.c8(p_scen || ' ' || p_key, 9, 11, 3, 10, 3);
  ELSE v_g := harness.c8(p_scen || ' ' || p_key, 6, 7, 2, 7, 2); END IF;
  UPDATE public.cash_games SET sb = p_sb, bb = 2 * p_sb, variant = p_variant WHERE id = v_g;
  UPDATE public.tables SET small_blind = p_sb, big_blind = 2 * p_sb, game_variant = p_variant WHERE cluster_id = v_g;
  UPDATE public.cash_player_session SET sb = p_sb, bb = 2 * p_sb, variant = p_variant WHERE cluster_id = v_g;
  PERFORM harness.cfg(v_g, jsonb_build_object('worker_mode', 'form') || p_cfg);
  -- The fixture's own seats are this scenario's money too.
  INSERT INTO lc.minted (scen, cluster_id, seat_id, player_id, amount)
  SELECT p_scen, v_g, ts.id, ts.user_id, ts.stack FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g;
  v_base := harness.live(v_g);
  IF p_convert THEN
    PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
    IF harness.mode(v_g) IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FIXTURE: % did not convert', p_key; END IF;
    PERFORM public.fx9_pool(v_g);
  END IF;
  IF p_pop > v_base THEN PERFORM lc.arrive_many(v_g, p_pop - v_base);
  ELSIF p_pop < v_base THEN PERFORM harness.leave(v_g, v_base - p_pop); END IF;
  IF p_convert THEN PERFORM public.fx9_pool(v_g); END IF;
  PERFORM lc.lease(public.fn_cash_cluster_front_table(v_g));
  -- Every player's club wallet, for the reload door.
  FOR r IN SELECT DISTINCT ts.user_id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
            WHERE tb.cluster_id = v_g AND ts.user_id IS NOT NULL LOOP
    INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance, joined_at, updated_at)
    VALUES ('cb000000-0000-0000-0000-000000000001', r.user_id, 'member', 'active', 5000, now(), now());
  END LOOP;
  INSERT INTO lc.cl (id, scen, pop, handed, front, stakes, variant)
  VALUES (v_g, p_scen, p_pop, p_handed, public.fn_cash_cluster_front_table(v_g), p_sb || '/' || 2 * p_sb, p_variant);
  RETURN v_g;
END $f$;

-- ===========================================================================
-- THE ENGINE'S CALLS. Each op is one transaction, as the engine makes them:
-- it picks its work, calls the production door, times it, and records what
-- the door answered. An exception a door raises is caught here only to be
-- recorded (the subtransaction rolls back exactly as the engine's would);
-- query_canceled and a terminated connection are not catchable and end the
-- statement, which is the point of the chaos.
-- ===========================================================================

-- THE MATCHER PASS (two workers race it on the same Cluster).
-- A budget stop before any attempt is starvation. A documented lock race
-- already attempted the barrier and must remain bounded by the same budget.
CREATE FUNCTION lc.pass_starved(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
 SELECT (r ->> 'stopped_reason') = 'time_budget'
    AND coalesce((r ->> 'formed')::integer, 0) = 0
    AND NOT (coalesce((r ->> 'replans')::integer, 0) > 0
      AND jsonb_array_length(coalesce(r -> 'retries', '[]'::jsonb)) > 0
      AND coalesce((SELECT bool_and(coalesce(x ->> 'reason' = 'formation_contended'
                            AND x ->> 'sqlstate' IN ('55P03', '40P01', '40001'), false))
                      FROM jsonb_array_elements(coalesce(r -> 'retries', '[]'::jsonb)) x), false));
$f$;

CREATE FUNCTION lc.op_match() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; t0 timestamptz; r jsonb; v_req uuid := gen_random_uuid();
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_match_and_form(c, clock_timestamp(), NULL, NULL, v_req, NULL);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('match_and_form', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('match_and_form', t0, coalesce(r ->> 'stopped_reason', r ->> 'reason'));
  IF (r ->> 'duration_ms') IS NOT NULL THEN
    INSERT INTO lc.lat (scen, pop, op, ms, outcome) VALUES (lc.scen(), lc.pop(), 'match_pass_inside', (r ->> 'duration_ms')::numeric, r ->> 'stopped_reason');
  END IF;
  IF coalesce((r ->> 'frozen')::boolean, false) THEN PERFORM lc.violate('matcher_froze', r); END IF;
  -- SURGE: a pass that ran out of budget having formed nothing starves the
  -- Cluster (it was the case from about 3,000 players before 20261009151825).
  IF lc.pass_starved(r) THEN
    PERFORM lc.violate('pass_starved_by_its_budget', r - 'hands' - 'states' - 'reasons');
  END IF;
  IF coalesce((r ->> 'formed')::integer, 0) > 0 THEN
    INSERT INTO lc.passes (request_id, scen, cluster_id, answer) VALUES (v_req, lc.scen(), c, r);
    INSERT INTO lc.lat (scen, pop, op, ms, outcome)
    VALUES (lc.scen(), lc.pop(), 'match_and_form_per_hand',
            round(extract(epoch FROM clock_timestamp() - t0) * 1000 / (r ->> 'formed')::integer, 3), 'formed');
  END IF;
END $f$;

-- A REPLAYED PASS: the same request id again must answer the recorded pass
-- and form nothing.
CREATE FUNCTION lc.op_match_replay() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p record; r jsonb; n0 bigint; n1 bigint;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  SELECT * INTO p FROM lc.passes WHERE scen = lc.scen() ORDER BY random() LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO n0 FROM public.lightning_hand lh WHERE lh.cluster_id = p.cluster_id;
  BEGIN
    r := public.fn_lightning_match_and_form(p.cluster_id, clock_timestamp(), NULL, NULL, p.request_id, NULL);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('match_replay', SQLSTATE, SQLERRM); RETURN;
  END;
  SELECT count(*) INTO n1 FROM public.lightning_hand lh WHERE lh.cluster_id = p.cluster_id
     AND lh.request_id IN (SELECT md5(p.request_id::text || '/matcher_group/' || g)::uuid FROM generate_series(1, 600) g);
  IF coalesce((r ->> 'replayed')::boolean, false) IS NOT TRUE OR (r -> 'hands') IS DISTINCT FROM (p.answer -> 'hands')
     OR n1 IS DISTINCT FROM (p.answer ->> 'formed')::bigint THEN
    PERFORM lc.violate('match_replay_not_identical', jsonb_build_object('request_id', p.request_id, 'answer', r - 'hands', 'hands_now', n1));
  END IF;
END $f$;

-- THE BARRIER CALLED DIRECTLY by a second worker that never took the
-- matcher's advisory lock: it offers a random idle set and the barrier alone
-- decides. One call in ten is replayed with its request id.
CREATE FUNCTION lc.op_form() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; t0 timestamptz; r jsonb; r2 jsonb; v_req uuid := gen_random_uuid(); v_p uuid[]; v_h integer;
        v_cfg jsonb; v_ttl interval; v_win interval;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT handed INTO v_h FROM lc.cl WHERE id = c;
  v_cfg := public.fn_lightning_config(c);
  v_ttl := make_interval(secs => (v_cfg ->> 'reservation_ttl_ms')::numeric / 1000);
  v_win := make_interval(secs => (v_cfg ->> 'form_window_ms')::numeric / 1000);
  SELECT array_agg(x.player_id) INTO v_p FROM (
    SELECT sl.player_id FROM public.lightning_pool_slot sl
     WHERE sl.cluster_id = c AND sl.closed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation rv WHERE rv.cluster_id = c AND rv.player_id = sl.player_id
                          AND rv.state IN ('pending', 'committed'))
     ORDER BY random() LIMIT v_h) x;
  IF coalesce(cardinality(v_p), 0) < 2 THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_form_hand(c, v_p, cardinality(v_p)::smallint, cardinality(v_p)::smallint, NULL,
           v_ttl, v_win, clock_timestamp(), 'lc-barrier', v_req, NULL);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('form_hand', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('form_hand', t0, CASE WHEN (r ->> 'formed')::boolean THEN 'formed' ELSE r ->> 'reason' END);
  IF coalesce((r ->> 'frozen')::boolean, false) OR (r ->> 'reason') = 'formation_invariant_failed' THEN
    PERFORM lc.violate('barrier_froze', r);
  END IF;
  IF coalesce((r ->> 'formed')::boolean, false) THEN
    INSERT INTO lc.forms (request_id, scen, cluster_id, players, answer) VALUES (v_req, lc.scen(), c, v_p, r);
    IF random() < 0.1 THEN
      r2 := public.fn_lightning_form_hand(c, v_p, cardinality(v_p)::smallint, cardinality(v_p)::smallint, NULL,
              v_ttl, v_win, clock_timestamp(), 'lc-barrier', v_req, NULL);
      IF coalesce((r2 ->> 'replayed')::boolean, false) IS NOT TRUE OR (r2 ->> 'hand_id') IS DISTINCT FROM (r ->> 'hand_id') THEN
        PERFORM lc.violate('barrier_replay_not_identical', jsonb_build_object('first', r, 'replay', r2));
      END IF;
    END IF;
  END IF;
END $f$;

-- THE DEALER: a reserved instance begins dealing and is bound to the next
-- hand number (the physical allocator's sequence). One bind in ten is
-- replayed, and one in twenty is offered a second number.
CREATE FUNCTION lc.op_deal() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_i uuid; t0 timestamptz; r jsonb; r2 jsonb; n bigint;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT li.id INTO v_i FROM public.lightning_instance li
   WHERE li.cluster_id = c AND li.state = 'reserved'
     AND li.cluster_epoch = (SELECT cg.cluster_epoch FROM public.cash_games cg WHERE cg.id = c)
   ORDER BY li.created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_i IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_instance_begin_dealing(v_i);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('begin_dealing', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('begin_dealing', t0, CASE WHEN (r ->> 'dealing')::boolean THEN 'dealing' ELSE r ->> 'reason' END);
  IF coalesce((r ->> 'dealing')::boolean, false) IS NOT TRUE THEN RETURN; END IF;
  n := nextval('harness.hand_numbers');
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_bind_hand_number(v_i, n);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('bind_hand_number', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('bind_hand_number', t0, CASE WHEN (r ->> 'ok')::boolean THEN 'bound' ELSE r ->> 'reason' END);
  IF random() < 0.1 THEN
    r2 := public.fn_lightning_bind_hand_number(v_i, n);
    IF coalesce((r2 ->> 'replay')::boolean, false) IS NOT TRUE THEN PERFORM lc.violate('bind_replay', r2); END IF;
  ELSIF random() < 0.05 THEN
    r2 := public.fn_lightning_bind_hand_number(v_i, nextval('harness.hand_numbers'));
    IF (r2 ->> 'reason') IS DISTINCT FROM 'hand_number_already_bound' THEN PERFORM lc.violate('bind_second_number', r2); END IF;
  END IF;
END $f$;

-- THE FOLD BAR: a random undecided non-blind participant of a dealing hand
-- folds (LIGHTNING FOLD, a normal fold, or FOLD & WATCH). Duplicates are
-- replayed: the same fold answers replay, a different one already_folded.
CREATE FUNCTION lc.op_fold() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; x record; t0 timestamptz; r jsonb; r2 jsonb; v_type text; v_q numeric := random();
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT hp.hand_id, hp.player_id, hp.stack_before INTO x
    FROM public.lightning_instance li JOIN public.lightning_hand_player hp ON hp.hand_id = li.hand_id
   WHERE li.cluster_id = c AND li.state = 'dealing' AND hp.folded_at IS NULL AND hp.blind_role = 'none'
     AND NOT EXISTS (SELECT 1 FROM lc.held h WHERE h.player_id = hp.player_id)
   ORDER BY random() LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  v_type := CASE WHEN v_q < 0.7 THEN 'fast' WHEN v_q < 0.9 THEN 'normal' ELSE 'fold_watch' END;
  t0 := clock_timestamp();
  BEGIN
    -- A normal fold may come after a call: it commits what it put in, which
    -- stays exposure until the hand settles.
    r := public.fn_lightning_fast_fold(x.hand_id, x.player_id, gen_random_uuid(), v_type,
           CASE WHEN v_type = 'normal' THEN LEAST(x.stack_before, (2 * (1 + floor(random() * 3)))::numeric) ELSE 0 END);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('fast_fold', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('fast_fold', t0, CASE WHEN (r ->> 'ok')::boolean THEN v_type ELSE r ->> 'reason' END);
  IF coalesce((r ->> 'ok')::boolean, false) AND random() < 0.15 THEN
    r2 := public.fn_lightning_fast_fold(x.hand_id, x.player_id, gen_random_uuid(), v_type, 0);
    IF coalesce((r2 ->> 'replay')::boolean, false) IS NOT TRUE THEN PERFORM lc.violate('fold_replay', r2); END IF;
    r2 := public.fn_lightning_fast_fold(x.hand_id, x.player_id, gen_random_uuid(),
            CASE v_type WHEN 'fast' THEN 'normal' ELSE 'fast' END, 0);
    IF (r2 ->> 'reason') IS DISTINCT FROM 'already_folded' THEN PERFORM lc.violate('fold_second_type', r2); END IF;
  END IF;
END $f$;

-- THE ENGINE'S RESULT for a hand: folders lose what they committed, every
-- live player puts in a deterministic amount (one in twenty is all in), the
-- lowest md5 of the live players takes the pot. The same hand in the same
-- fold state always produces the same payload, so two settlers racing one
-- hand send the same request.
CREATE FUNCTION lc.results(p_hand uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $f$
DECLARE v_live uuid[]; v_winner uuid; v_pot numeric := 0; v_out jsonb := '[]'::jsonb; x record; c numeric;
BEGIN
  SELECT array_agg(hp.player_id ORDER BY md5(p_hand::text || hp.player_id::text)) INTO v_live
    FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand AND hp.folded_at IS NULL;
  v_winner := v_live[1];
  FOR x IN SELECT hp.player_id, hp.stack_before, hp.fold_type, hp.folded_at, coalesce(hp.committed_at_fold, 0) AS cf
             FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand ORDER BY hp.player_id LOOP
    IF x.folded_at IS NOT NULL THEN
      v_pot := v_pot + x.cf;
    ELSIF x.player_id IS DISTINCT FROM v_winner THEN
      v_pot := v_pot + lc.stake(p_hand, x.player_id, x.stack_before);
    END IF;
  END LOOP;
  FOR x IN SELECT hp.player_id, hp.stack_before, hp.fold_type, hp.folded_at, coalesce(hp.committed_at_fold, 0) AS cf
             FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand ORDER BY hp.player_id LOOP
    IF x.folded_at IS NOT NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('player_id', x.player_id, 'stack_after', x.stack_before - x.cf,
                 'contributed', x.cf, 'won', 0, 'fold_type', x.fold_type, 'showed', false));
    ELSIF x.player_id = v_winner THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('player_id', x.player_id, 'stack_after', x.stack_before + v_pot,
                 'contributed', 0, 'won', v_pot, 'fold_type', 'none', 'showed', cardinality(v_live) > 1));
    ELSE
      c := lc.stake(p_hand, x.player_id, x.stack_before);
      v_out := v_out || jsonb_build_array(jsonb_build_object('player_id', x.player_id, 'stack_after', x.stack_before - c,
                 'contributed', c, 'won', 0, 'fold_type', 'none', 'showed', true));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('results', v_out, 'winner', v_winner, 'pot', v_pot);
END $f$;
-- What a live loser puts in: one in twenty is all in, the rest 2 to 10.
CREATE FUNCTION lc.stake(p_hand uuid, p_player uuid, p_stack numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN ('x' || substr(md5(p_hand::text || p_player::text), 1, 4))::bit(16)::integer % 20 = 0 THEN p_stack
              ELSE LEAST(p_stack, (2 * (1 + ('x' || substr(md5(p_player::text || p_hand::text), 1, 4))::bit(16)::integer % 5))::numeric) END;
$f$;
CREATE FUNCTION lc.settle_args(p_hand uuid, p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $f$
DECLARE v_host uuid; l record; rs jsonb;
BEGIN
  SELECT lh.host_table_id INTO v_host FROM public.lightning_hand lh WHERE lh.hand_id = p_hand;
  SELECT el.instance_id, el.lease_generation INTO l FROM public.engine_table_leases el WHERE el.table_id = v_host;
  rs := lc.results(p_hand);
  RETURN jsonb_build_object('hand', p_hand, 'request', p_request, 'host', v_host,
    'lease_instance', l.instance_id, 'lease_generation', l.lease_generation, 'results', rs -> 'results',
    'row', jsonb_build_object('pot_size', rs -> 'pot', 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                              'community_cards', ARRAY['As', 'Kd', '7h', '2c', '2d'],
                              'winners', jsonb_build_array(jsonb_build_object('userId', rs ->> 'winner', 'amount', rs -> 'pot', 'potIndex', 0))));
END $f$;
CREATE FUNCTION lc.settle_call(a jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.fn_lightning_settle_hand((a ->> 'hand')::uuid, (a ->> 'request')::uuid, (a ->> 'host')::uuid,
           a ->> 'lease_instance', (a ->> 'lease_generation')::uuid, a -> 'results', 0, 0, a -> 'row');
$f$;

-- THE SETTLER: a random bound dealing hand is settled, with the engine's
-- deterministic request id, or (one in ten) with a fresh one, as a second
-- engine or a reordered retry would. Several settlers race the same hands.
CREATE FUNCTION lc.op_settle() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_h uuid; t0 timestamptz; r jsonb; a jsonb; v_req uuid;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT lh.hand_id INTO v_h FROM public.lightning_instance li JOIN public.lightning_hand lh ON lh.hand_id = li.hand_id
   WHERE li.cluster_id = c AND li.state = 'dealing' AND lh.hand_number IS NOT NULL
     AND li.started_at < clock_timestamp() - interval '30 milliseconds'
   ORDER BY random() LIMIT 1;
  IF v_h IS NULL THEN RETURN; END IF;
  v_req := CASE WHEN random() < 0.1 THEN gen_random_uuid() ELSE md5(v_h::text || '/settle')::uuid END;
  a := lc.settle_args(v_h, v_req);
  t0 := clock_timestamp();
  BEGIN
    r := lc.settle_call(a);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('settle_hand', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('settle_hand', t0, CASE WHEN (r ->> 'ok')::boolean AND (r ->> 'replay')::boolean THEN 'replay'
                                         WHEN (r ->> 'ok')::boolean THEN 'settled' ELSE r ->> 'reason' END);
  IF coalesce((r ->> 'frozen')::boolean, false) THEN PERFORM lc.violate('settlement_froze', r); END IF;
  IF coalesce((r ->> 'ok')::boolean, false) AND coalesce((r ->> 'replay')::boolean, false) IS NOT TRUE THEN
    INSERT INTO lc.settles (scen, hand_id, request_id, args, answer) VALUES (lc.scen(), v_h, v_req, a, r);
  END IF;
END $f$;

-- SETTLE RETRIED: a recorded settlement sent again, byte for byte, must
-- answer its receipt (replay, same receipt hash) and move nothing; a fresh
-- request for the same hand must answer already_settled.
CREATE FUNCTION lc.op_settle_replay() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s record; r jsonb; r2 jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  SELECT * INTO s FROM lc.settles WHERE scen = lc.scen() ORDER BY random() LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  BEGIN
    r := lc.settle_call(s.args);
    r2 := lc.settle_call(jsonb_set(s.args, '{request}', to_jsonb(gen_random_uuid())));
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('settle_replay', SQLSTATE, SQLERRM); RETURN;
  END;
  IF coalesce((r ->> 'replay')::boolean, false) IS NOT TRUE OR (r ->> 'receipt_hash') IS DISTINCT FROM (s.answer ->> 'receipt_hash') THEN
    PERFORM lc.violate('settle_replay_not_identical', jsonb_build_object('hand', s.hand_id, 'first', s.answer, 'replay', r));
  END IF;
  IF (r2 ->> 'reason') IS DISTINCT FROM 'already_settled' THEN
    PERFORM lc.violate('settle_second_request_not_refused', jsonb_build_object('hand', s.hand_id, 'answer', r2));
  END IF;
END $f$;

-- PRESENCE FLAPPING: several engine nodes report the same players dropping
-- and returning, overlapping, out of order.
CREATE FUNCTION lc.op_presence() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_d uuid[]; v_r uuid[]; t0 timestamptz; r jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT array_agg(x.player_id) INTO v_d FROM (
    SELECT ps.player_id FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = c AND ps.exited_at IS NULL AND NOT EXISTS (SELECT 1 FROM lc.held h WHERE h.player_id = ps.player_id)
     ORDER BY random() LIMIT 1 + (random() * 4)::integer) x;
  SELECT array_agg(x.player_id) INTO v_r FROM (
    SELECT ps.player_id FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = c AND ps.exited_at IS NULL AND ps.disconnected_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lc.held h WHERE h.player_id = ps.player_id)
     ORDER BY random() LIMIT 1 + (random() * 5)::integer) x;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_presence_report(c, coalesce(v_d, ARRAY[]::uuid[]), coalesce(v_r, ARRAY[]::uuid[]), clock_timestamp());
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('presence_report', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('presence_report', t0, CASE WHEN (r ->> 'ok')::boolean THEN 'ok' ELSE r ->> 'reason' END);
END $f$;

-- AUTO-REBUY RACE: every rebuy worker goes for the same player (the
-- shortest stack below its target) and delivers what it bought through the
-- engine's addon delivery in the same transaction.
CREATE FUNCTION lc.op_rebuy() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_p uuid; t0 timestamptz; r jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT x.player_id INTO v_p FROM (
    SELECT ps.player_id, ts.stack FROM public.lightning_pool_session ps
      JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
     WHERE ps.cluster_id = c AND ps.exited_at IS NULL AND ps.state = 'active'
       AND ts.table_id IS DISTINCT FROM public.fn_cash_cluster_front_table(c)
       AND ts.stack < ps.starting_stack
     ORDER BY ts.stack, ps.player_id LIMIT 8) x
   WHERE NOT public.fn_lightning_player_in_hand(x.player_id, c)
   ORDER BY x.stack, x.player_id LIMIT 1;
  -- THE ENGINE DELIVERS A RELOAD BETWEEN HANDS: one player of this Cluster
  -- with an unresolved reload and no live hand (one folded out of a hand
  -- that is still live is not between hands; the anchor guard says so).
  PERFORM lc.deliver_one(c);
  IF v_p IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_lightning_auto_rebuy(c, v_p, clock_timestamp());
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('auto_rebuy', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('auto_rebuy', t0, CASE WHEN (r ->> 'ok')::boolean THEN 'reloaded' ELSE r ->> 'reason' END);
  IF coalesce((r ->> 'ok')::boolean, false) THEN PERFORM lc.deliver_to(c, v_p); END IF;
END $f$;
CREATE FUNCTION lc.deliver_to(p_game uuid, p_player uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  IF public.fn_lightning_player_live_hand(p_player, p_game) IS NOT NULL THEN RETURN false; END IF;
  BEGIN
    PERFORM harness.deliver(p_game, p_player);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'LIGHTNING_HAND_IN_PROGRESS%' THEN RETURN false; END IF;
    PERFORM lc.fail('deliver', SQLSTATE, SQLERRM); RETURN false;
  END;
  RETURN true;
END $f$;
CREATE FUNCTION lc.deliver_one(p_game uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE v_p uuid;
BEGIN
  SELECT pa.user_id INTO v_p FROM public.table_pending_addons pa JOIN public.tables tb ON tb.id = pa.table_id
   WHERE tb.cluster_id = p_game AND pa.resolved_at IS NULL ORDER BY random() LIMIT 1;
  IF v_p IS NULL THEN RETURN false; END IF;
  RETURN lc.deliver_to(p_game, v_p);
END $f$;

-- THE TICK, as the cron runs it: reapers, slot sync, drive.
CREATE FUNCTION lc.op_tick() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz := clock_timestamp(); r jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  BEGIN
    r := public.fn_cash_clusters_tick_all('{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('tick_all', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('tick_all', t0, CASE WHEN (r ->> 'ok')::boolean THEN 'ok' ELSE coalesce(r ->> 'reason', 'answered') END);
END $f$;
-- THE DRIVE of one Cluster, several workers at once.
CREATE FUNCTION lc.op_drive() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; t0 timestamptz; r jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    r := public.fn_cash_cluster_lightning_drive(c);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('drive', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('drive', t0, coalesce(r ->> 'action', r ->> 'reason', 'answered'));
END $f$;
-- THE ENGINE ACKNOWLEDGES A HALT it was asked to observe (each table's own
-- engine does this in production; here one worker plays all of them).
CREATE FUNCTION lc.op_ack() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  UPDATE public.tables tb SET dealing_halt_observed_at = clock_timestamp()
   WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = lc.scen())
     AND tb.dealing_halted_at IS NOT NULL
     AND (tb.dealing_halt_observed_at IS NULL OR tb.dealing_halt_observed_at < tb.dealing_halted_at);
EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('halt_ack', SQLSTATE, SQLERRM);
END $f$;

-- ARRIVALS AND DEPARTURES: a mass join storm, a mass leave storm (an idle
-- seat stands up; a seat that a formation took first is refused by the
-- production anchor guard, which is the correct answer), Stop Playing
-- storms (the same player asking twice, at once, in a hand or not).
CREATE FUNCTION lc.op_join() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; t0 timestamptz;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    PERFORM lc.arrive(c, random() < 0.5);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('arrive', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('arrive', t0, 'seated');
END $f$;
CREATE FUNCTION lc.op_leave() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_s uuid; t0 timestamptz;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT ts.id INTO v_s FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = c AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND public.fn_lightning_player_live_hand(ts.user_id, c) IS NULL
   ORDER BY random() LIMIT 1;
  IF v_s IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = v_s AND left_at IS NULL;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'LIGHTNING_HAND_IN_PROGRESS%' THEN PERFORM lc.lat('leave', t0, 'refused_in_hand'); RETURN; END IF;
    PERFORM lc.fail('leave', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('leave', t0, 'left');
END $f$;
CREATE FUNCTION lc.op_stop() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_p uuid; t0 timestamptz; r jsonb;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  SELECT ps.player_id INTO v_p FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = c AND ps.exited_at IS NULL ORDER BY ps.player_id
   OFFSET (random() * 3)::integer LIMIT 1;
  IF v_p IS NULL THEN RETURN; END IF;
  t0 := clock_timestamp();
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_p::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    r := public.fn_lightning_stop_playing(c);
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('stop_playing', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('stop_playing', t0, CASE WHEN (r ->> 'exited')::boolean THEN 'exited'
                                          WHEN r IS NULL THEN 'null' ELSE coalesce(r ->> 'reason', 'deferred') END);
END $f$;

-- A WAVE ACROSS A THRESHOLD: a Cluster at or above ON loses idle players
-- down to one below OFF; one at or below OFF gains arrivals up to ON. Two
-- wave workers and racing drives push Clusters back and forth across both
-- edges of the hysteresis band while they play.
CREATE FUNCTION lc.op_wave() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_live integer; th jsonb; v_on integer; v_off integer; i integer; s record; t0 timestamptz := clock_timestamp(); v_n integer := 0;
BEGIN
  IF NOT lc.live() THEN RETURN; END IF;
  c := lc.pick(); IF c IS NULL THEN RETURN; END IF;
  v_live := harness.live(c);
  th := public.fn_cash_cluster_lightning_thresholds(c);
  v_on := (th ->> 'on')::integer; v_off := (th ->> 'off')::integer;
  BEGIN
    IF v_live >= v_on THEN
      FOR s IN SELECT ts.id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                WHERE tb.cluster_id = c AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                  AND public.fn_lightning_player_live_hand(ts.user_id, c) IS NULL
                ORDER BY random() LIMIT v_live - v_off + 1 LOOP
        BEGIN
          UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = s.id AND left_at IS NULL;
          v_n := v_n - 1;
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM NOT LIKE 'LIGHTNING_HAND_IN_PROGRESS%' THEN RAISE; END IF;
        END;
      END LOOP;
    ELSIF v_live <= v_off THEN
      SET CONSTRAINTS ALL DEFERRED;
      FOR i IN 1 .. v_on - v_live LOOP PERFORM lc.arrive(c, i % 2 = 0); v_n := v_n + 1; END LOOP;
    END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN PERFORM lc.fail('wave', SQLSTATE, SQLERRM); RETURN;
  END;
  PERFORM lc.lat('wave', t0, CASE WHEN v_n > 0 THEN 'up' WHEN v_n < 0 THEN 'down' ELSE 'hold' END);
END $f$;

-- THE KILLER: cancel or terminate a random running worker of this scenario
-- (application_name lcw-<kind>), mid-transaction.
CREATE FUNCTION lc.kill(p_mode text, p_like text DEFAULT 'lcw-%') RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE a record; v_ok boolean;
BEGIN
  SELECT pid, application_name INTO a FROM pg_stat_activity
   WHERE application_name LIKE p_like AND state = 'active' AND pid <> pg_backend_pid()
     AND backend_type = 'client backend'
   ORDER BY random() LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_ok := CASE WHEN p_mode = 'terminate' THEN pg_terminate_backend(a.pid) ELSE pg_cancel_backend(a.pid) END;
  IF v_ok THEN INSERT INTO lc.kills (scen, mode, pid, app) VALUES (lc.scen(), p_mode, a.pid, a.application_name); END IF;
  RETURN CASE WHEN v_ok THEN 1 ELSE 0 END;
END $f$;

-- FAULT INJECTION (fixture boundary, armed per session by a GUC): a sleep
-- inside the settlement (after its marker row, before the commit), inside the
-- barrier (after its first reservation row), and a raise or a sleep inside a
-- conversion (on the conversion row), so a cancel, a terminate or a timeout
-- lands mid-transaction.
CREATE FUNCTION lc.fault() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v text := current_setting('lc.fault_' || TG_ARGV[0], true);
BEGIN
  IF v IS NULL OR v = '' OR v = 'off' THEN RETURN NULL; END IF;
  IF v = 'raise' AND random() < 0.5 THEN RAISE EXCEPTION 'LC_INJECTED_FAULT in %', TG_ARGV[0] USING ERRCODE = 'XX001'; END IF;
  IF v ~ '^[0-9.]+$' THEN PERFORM pg_sleep(v::numeric * random()); END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER lc_fault_settle AFTER INSERT ON public.lightning_settlement_marker
  FOR EACH ROW EXECUTE FUNCTION lc.fault('settle');
CREATE TRIGGER lc_fault_form AFTER INSERT ON public.lightning_reservation
  FOR EACH ROW EXECUTE FUNCTION lc.fault('form');
CREATE TRIGGER lc_fault_convert AFTER INSERT OR UPDATE ON public.cash_cluster_conversion
  FOR EACH ROW EXECUTE FUNCTION lc.fault('convert');

-- ===========================================================================
-- THE DRAIN: after a storm the engine finishes what it started, through the
-- same doors: a reserved formation is dealt, every dealing hand is bound and
-- settled (retrying exactly as an engine retries), a formation that can no
-- longer deal is abandoned. Then the production reaper runs. Nothing here
-- writes a Lightning row itself.
-- ===========================================================================
CREATE FUNCTION lc.drain(p_scen text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE x record; r jsonb; v_round integer := 0; v_settled integer := 0; v_abandoned integer := 0; v_left integer;
BEGIN
  PERFORM set_config('lc.scen', p_scen, true);
  LOOP
    v_round := v_round + 1;
    FOR x IN SELECT li.id, li.state, li.hand_id, lh.hand_number
               FROM public.lightning_instance li LEFT JOIN public.lightning_hand lh ON lh.hand_id = li.hand_id
              WHERE li.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen)
                AND li.state IN ('forming', 'reserved', 'dealing', 'settling')
              ORDER BY li.created_at LOOP
      IF x.state = 'reserved' THEN
        r := public.fn_lightning_instance_begin_dealing(x.id);
        IF coalesce((r ->> 'dealing')::boolean, false) IS NOT TRUE THEN
          r := public.fn_lightning_instance_abandon(x.id, 'lc_drain_' || coalesce(r ->> 'reason', 'refused'), clock_timestamp());
          v_abandoned := v_abandoned + 1; CONTINUE;
        END IF;
        x.state := 'dealing';
      END IF;
      IF x.state = 'forming' THEN
        PERFORM public.fn_lightning_instance_abandon(x.id, 'lc_drain_forming', clock_timestamp());
        v_abandoned := v_abandoned + 1; CONTINUE;
      END IF;
      IF x.hand_number IS NULL THEN
        r := public.fn_lightning_bind_hand_number(x.id, nextval('harness.hand_numbers'));
      END IF;
      r := lc.settle_call(lc.settle_args(x.hand_id, md5(x.hand_id::text || '/settle')::uuid));
      IF coalesce((r ->> 'ok')::boolean, false) IS NOT TRUE THEN
        r := lc.settle_call(lc.settle_args(x.hand_id, gen_random_uuid()));
      END IF;
      IF coalesce((r ->> 'ok')::boolean, false) THEN v_settled := v_settled + 1;
      ELSE PERFORM lc.violate('drain_could_not_settle', jsonb_build_object('hand', x.hand_id, 'answer', r)); END IF;
    END LOOP;
    SELECT count(*) INTO v_left FROM public.lightning_instance li
     WHERE li.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND li.state IN ('forming', 'reserved', 'dealing', 'settling');
    EXIT WHEN v_left = 0 OR v_round >= 5;
  END LOOP;
  PERFORM lc.deliver_to(pa.cluster_id, pa.user_id)
     FROM (SELECT DISTINCT tb.cluster_id, a.user_id FROM public.table_pending_addons a JOIN public.tables tb ON tb.id = a.table_id
            WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND a.resolved_at IS NULL) pa;
  RETURN jsonb_build_object('rounds', v_round, 'settled', v_settled, 'abandoned', v_abandoned, 'left', v_left);
END $f$;
-- THE REAPERS, as the tick runs them, over this scenario's Clusters.
CREATE FUNCTION lc.reap(p_scen text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE c uuid; v_f integer := 0; v_d integer := 0; r jsonb;
BEGIN
  FOR c IN SELECT id FROM lc.cl WHERE scen = p_scen LOOP
    r := public.fn_lightning_reap_formations(clock_timestamp(), 2000, c);
    v_f := v_f + coalesce((r ->> 'instances_abandoned')::integer, 0);
    r := public.fn_lightning_reap_expired_disconnects(c, clock_timestamp(), 2000);
    v_d := v_d + coalesce((r ->> 'expired')::integer, 0);
    PERFORM public.fn_lightning_pool_slots_sync(c);
  END LOOP;
  RETURN jsonb_build_object('formations_reaped', v_f, 'disconnects_reaped', v_d);
END $f$;

-- ===========================================================================
-- THE BOOKS BEFORE: every seat's stack, every wallet and every unresolved
-- reload of the scenario's Clusters, and the hands already settled.
-- ===========================================================================
CREATE FUNCTION lc.players(p_scen text) RETURNS TABLE (player_id uuid) LANGUAGE sql STABLE AS $f$
  SELECT DISTINCT ts.user_id FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND ts.user_id IS NOT NULL;
$f$;
CREATE FUNCTION lc.totals(p_scen text) RETURNS TABLE (seats numeric, wallets numeric, addons numeric) LANGUAGE sql STABLE AS $f$
  SELECT (SELECT coalesce(sum(ts.stack), 0) FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
           WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen)),
         (SELECT coalesce(sum(m.chip_balance), 0) FROM public.club_members m
           WHERE m.club_id = 'cb000000-0000-0000-0000-000000000001' AND m.user_id IN (SELECT player_id FROM lc.players(p_scen))),
         (SELECT coalesce(sum(pa.amount), 0) FROM public.table_pending_addons pa JOIN public.tables tb ON tb.id = pa.table_id
           WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND pa.resolved_at IS NULL);
$f$;
CREATE FUNCTION lc.snapshot(p_scen text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE t record;
BEGIN
  INSERT INTO lc.snap (scen, seat_id, player_id, stack)
  SELECT p_scen, ts.id, ts.user_id, ts.stack FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen);
  INSERT INTO lc.snap_hand (scen, hand_id)
  SELECT p_scen, lh.hand_id FROM public.lightning_hand lh
   WHERE lh.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND lh.settled_at IS NOT NULL;
  INSERT INTO lc.snap_addon (scen, addon_id)
  SELECT p_scen, pa.id FROM public.table_pending_addons pa JOIN public.tables tb ON tb.id = pa.table_id
   WHERE tb.cluster_id IN (SELECT id FROM lc.cl WHERE scen = p_scen) AND pa.resolved_at IS NOT NULL;
  SELECT * INTO t FROM lc.totals(p_scen);
  INSERT INTO lc.snap_meta (scen, at, total, seats, wallets, addons)
  VALUES (p_scen, clock_timestamp(), t.seats + t.wallets + t.addons, t.seats, t.wallets, t.addons);
  DELETE FROM lc.minted WHERE scen = p_scen;
END $f$;

-- ===========================================================================
-- THE INVARIANTS, one row each, PASS or FAIL with the evidence.
-- ===========================================================================
CREATE FUNCTION lc.check(p_scen text, p_allowed_states text[] DEFAULT ARRAY['40P01', '55P03', '40001'])
RETURNS TABLE (inv text, ok boolean, detail text) LANGUAGE plpgsql AS $f$
DECLARE t record; m record; v_n bigint; v_m bigint; v_txt text; v_amt numeric; v_cl uuid[];
BEGIN
  SELECT array_agg(id) INTO v_cl FROM lc.cl WHERE scen = p_scen;
  SELECT * INTO t FROM lc.totals(p_scen);
  SELECT * INTO m FROM lc.snap_meta WHERE scen = p_scen;

  -- 1 CHIP CONSERVATION: seats + wallets + unresolved reloads, less the
  -- chips arrivals brought, equals the books before.
  SELECT coalesce(sum(amount), 0) INTO v_amt FROM lc.minted WHERE scen = p_scen;
  inv := 'chip_conservation'; ok := round(t.seats + t.wallets + t.addons - v_amt, 2) = round(m.total, 2);
  detail := format('before %s, after %s (seats %s, wallets %s, reloads pending %s), arrivals brought %s',
                   m.total, t.seats + t.wallets + t.addons, t.seats, t.wallets, t.addons, v_amt);
  RETURN NEXT;

  -- 2 NO LOST MONEY, NO DUPLICATE MONEY, per seat: every seat's stack is
  -- its stack before plus exactly the nets of the hands it settled since,
  -- plus exactly the reloads delivered to it since.
  WITH s AS (
    SELECT sn.seat_id, sn.stack FROM lc.snap sn WHERE sn.scen = p_scen
    UNION ALL
    SELECT mi.seat_id, mi.amount FROM lc.minted mi WHERE mi.scen = p_scen),
  nets AS (
    SELECT ps.anchor_seat_id AS seat_id, sum(hp.net_result) AS net
      FROM public.lightning_hand lh
      JOIN public.lightning_hand_player hp ON hp.hand_id = lh.hand_id
      JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE lh.cluster_id = ANY (v_cl) AND lh.settled_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lc.snap_hand sh WHERE sh.scen = p_scen AND sh.hand_id = lh.hand_id)
     GROUP BY 1),
  reloads AS (
    SELECT ts.id AS seat_id, sum(pa.applied_to_stack) AS amt
      FROM public.table_pending_addons pa
      JOIN public.table_seats ts ON ts.table_id = pa.table_id AND ts.user_id = pa.user_id
     WHERE pa.resolved_at IS NOT NULL AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = ANY (v_cl))
       AND NOT EXISTS (SELECT 1 FROM lc.snap_addon sa WHERE sa.scen = p_scen AND sa.addon_id = pa.id)
     GROUP BY 1),
  bad AS (
    SELECT s.seat_id, s.stack AS before, coalesce(n.net, 0) AS net, coalesce(rl.amt, 0) AS reloads, ts.stack AS now
      FROM s JOIN public.table_seats ts ON ts.id = s.seat_id
      LEFT JOIN nets n ON n.seat_id = s.seat_id LEFT JOIN reloads rl ON rl.seat_id = s.seat_id
     WHERE round(s.stack + coalesce(n.net, 0) + coalesce(rl.amt, 0), 2) IS DISTINCT FROM round(ts.stack, 2))
  SELECT count(*), string_agg(format('%s: %s%+s%+s<>%s', b.seat_id, b.before, b.net, b.reloads, b.now), '; ')
    INTO v_n, v_txt FROM bad b;
  SELECT (SELECT count(*) FROM lc.snap WHERE scen = p_scen) + (SELECT count(*) FROM lc.minted WHERE scen = p_scen) INTO v_m;
  inv := 'no_lost_or_duplicate_money_per_seat'; ok := v_n = 0;
  detail := format('%s seats reconciled to the settled nets and delivered reloads; %s disagree %s', v_m, v_n, left(coalesce(v_txt, ''), 400));
  RETURN NEXT;

  -- 3 EVERY SETTLED HAND CONSERVES: before = after + rake + jackpot drop.
  SELECT count(*) INTO v_n FROM public.lightning_hand lh
   WHERE lh.cluster_id = ANY (v_cl) AND lh.settled_at IS NOT NULL
     AND (SELECT round(sum(hp.stack_before) - sum(hp.stack_after), 2) FROM public.lightning_hand_player hp WHERE hp.hand_id = lh.hand_id)
         IS DISTINCT FROM round(coalesce((lh.settle_receipt ->> 'rake')::numeric, 0) + coalesce((lh.settle_receipt ->> 'bbj')::numeric, 0), 2);
  SELECT count(*) INTO v_m FROM public.lightning_hand lh WHERE lh.cluster_id = ANY (v_cl) AND lh.settled_at IS NOT NULL;
  inv := 'every_hand_conserves'; ok := v_n = 0; detail := format('%s settled hands, %s do not conserve', v_m, v_n); RETURN NEXT;

  -- 4 SETTLED EXACTLY ONCE: one physical commit, one history row, one
  -- hand_settled event, one receipt per settled hand; no receipt, no history
  -- and no event for a hand that did not settle.
  SELECT count(*) INTO v_n FROM public.lightning_hand lh
   WHERE lh.cluster_id = ANY (v_cl) AND lh.settled_at IS NOT NULL
     AND ((SELECT count(*) FROM public.hand_history hh WHERE hh.id = lh.hand_history_id) <> 1
       OR (SELECT count(*) FROM public.hand_history hh WHERE hh.hand_number = lh.hand_number) <> 1
       OR (SELECT count(*) FROM public.hand_atomic_commits c WHERE c.hand_number = lh.hand_number) <> 1
       OR (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = lh.cluster_id AND e.kind = 'hand_settled'
                                                             AND e.payload ->> 'hand_id' = lh.hand_id::text) <> 1
       OR lh.settle_receipt IS NULL OR lh.settle_request_hash IS NULL);
  SELECT count(*) INTO v_m FROM public.lightning_hand lh
   WHERE lh.cluster_id = ANY (v_cl) AND lh.settled_at IS NULL
     AND (lh.settle_receipt IS NOT NULL OR lh.hand_history_id IS NOT NULL
       OR (lh.hand_number IS NOT NULL AND EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.hand_number = lh.hand_number))
       OR EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = lh.cluster_id AND e.kind = 'hand_settled'
                                                             AND e.payload ->> 'hand_id' = lh.hand_id::text));
  inv := 'no_duplicate_money_settled_once'; ok := v_n = 0 AND v_m = 0;
  detail := format('%s settled hands with other than one commit/history/event/receipt; %s unsettled hands carrying a settlement trace', v_n, v_m);
  RETURN NEXT;

  -- 5 THE REPLAYS AND RACES THE OPS CHECKED IN FLIGHT (identical replays of
  -- passes, barriers, binds, folds and settlements; a second request
  -- refused; no door froze a Cluster; the drain settled everything).
  SELECT count(*), string_agg(DISTINCT what, ', ') INTO v_n, v_txt FROM lc.violation WHERE scen = p_scen;
  inv := 'idempotent_replays_and_no_door_violation'; ok := v_n = 0;
  detail := format('%s in-flight violations %s; replays checked against %s passes, %s barrier formations, %s settlements', v_n, coalesce('(' || v_txt || ')', ''),
                   (SELECT count(*) FROM lc.passes WHERE scen = p_scen), (SELECT count(*) FROM lc.forms WHERE scen = p_scen),
                   (SELECT count(*) FROM lc.settles WHERE scen = p_scen));
  RETURN NEXT;

  -- 6 NO DUPLICATE PLAYER: one open pool session and one open slot per
  -- player per Cluster, one active reservation per player per Cluster, one
  -- open pool session per anchor seat, one live seat per player per
  -- Cluster, and no player held by two live hands except where a LIGHTNING
  -- FOLD or a normal fold released the first.
  SELECT (SELECT count(*) FROM (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = ANY (v_cl) AND ps.exited_at IS NULL
                                 GROUP BY ps.cluster_id, ps.player_id HAVING count(*) > 1) a)
       + (SELECT count(*) FROM (SELECT 1 FROM public.lightning_pool_slot sl WHERE sl.cluster_id = ANY (v_cl) AND sl.closed_at IS NULL
                                 GROUP BY sl.cluster_id, sl.player_id HAVING count(*) > 1) b)
       + (SELECT count(*) FROM (SELECT 1 FROM public.lightning_reservation rv WHERE rv.cluster_id = ANY (v_cl) AND rv.state IN ('pending', 'committed')
                                 GROUP BY rv.cluster_id, rv.player_id HAVING count(*) > 1) c)
       + (SELECT count(*) FROM (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = ANY (v_cl) AND ps.exited_at IS NULL
                                 GROUP BY ps.anchor_seat_id HAVING count(*) > 1) d)
       + (SELECT count(*) FROM (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                                 WHERE tb.cluster_id = ANY (v_cl) AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                                 GROUP BY tb.cluster_id, ts.user_id HAVING count(*) > 1) e)
    INTO v_n;
  SELECT count(*) INTO v_m FROM (
    SELECT hp.player_id FROM public.lightning_instance li JOIN public.lightning_hand_player hp ON hp.hand_id = li.hand_id
     WHERE li.cluster_id = ANY (v_cl) AND li.state IN ('forming', 'reserved', 'dealing', 'settling')
       AND hp.fold_type NOT IN ('fast', 'normal')
     GROUP BY hp.player_id HAVING count(*) > 1) z;
  inv := 'no_duplicate_player'; ok := v_n = 0 AND v_m = 0;
  detail := format('%s duplicate sessions/slots/reservations/anchors/live seats; %s players held by two live hands', v_n, v_m);
  RETURN NEXT;

  -- 6b NO GHOST IN THE POOL AND NOBODY LEFT BEHIND: no open pool session
  -- sits on an anchor seat that has left or changed hands (such a ghost can
  -- never be dealt and refuses every reversion), and in a LIGHTNING Cluster
  -- every seated player the population counts holds an open pool session.
  SELECT count(*) INTO v_n FROM public.lightning_pool_session ps
    LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = ANY (v_cl) AND ps.exited_at IS NULL
     AND (ts.id IS NULL OR ts.left_at IS NOT NULL OR ts.user_id IS DISTINCT FROM ps.player_id);
  SELECT count(*) INTO v_m FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
    JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE cg.id = ANY (v_cl) AND cg.cluster_mode = 'lightning' AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND public.fn_lightning_anchor_is_live_eligible(ts.id, cg.id, ts.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = cg.id AND ps.player_id = ts.user_id
                        AND ps.cluster_epoch = cg.cluster_epoch);
  inv := 'no_ghost_and_nobody_left_behind'; ok := v_n = 0 AND v_m = 0;
  detail := format('%s open pool sessions on a departed or reassigned anchor seat; %s eligible seated players a LIGHTNING Cluster never entered into its current epoch''s pool (a player who chose Stop Playing or expired keeps the seat by design)', v_n, v_m);
  RETURN NEXT;

  -- 7 NO DUPLICATE HAND: hand numbers, request ids, instance bindings and
  -- history numbers unique; every hand's participant rows agree with its
  -- locked count; every instance's hand points back at it.
  SELECT (SELECT count(*) FROM (SELECT 1 FROM public.lightning_hand WHERE hand_number IS NOT NULL GROUP BY hand_number HAVING count(*) > 1) a)
       + (SELECT count(*) FROM (SELECT 1 FROM public.lightning_hand GROUP BY request_id HAVING count(*) > 1) b)
       + (SELECT count(*) FROM (SELECT 1 FROM public.lightning_hand GROUP BY lightning_instance_id HAVING count(*) > 1) c)
       + (SELECT count(*) FROM (SELECT 1 FROM public.hand_history WHERE hand_number >= 1000000 GROUP BY hand_number HAVING count(*) > 1) d)
       + (SELECT count(*) FROM public.lightning_hand lh WHERE lh.cluster_id = ANY (v_cl)
           AND lh.player_count IS DISTINCT FROM (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = lh.hand_id))
       + (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id = ANY (v_cl) AND li.hand_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.lightning_hand lh WHERE lh.hand_id = li.hand_id AND lh.lightning_instance_id = li.id))
    INTO v_n;
  SELECT count(*) INTO v_m FROM public.lightning_hand lh WHERE lh.cluster_id = ANY (v_cl);
  inv := 'no_duplicate_hand'; ok := v_n = 0; detail := format('%s hands; %s duplicate numbers/requests/instances/history or count disagreements', v_m, v_n);
  RETURN NEXT;

  -- 8 NO DUPLICATE BLIND: exactly one big blind and one small blind in every
  -- hand, and the blind ledger counts exactly the blinds of the hands that
  -- were not voided before they dealt.
  SELECT count(*) INTO v_n FROM public.lightning_hand lh WHERE lh.cluster_id = ANY (v_cl)
     AND ((SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = lh.hand_id AND hp.blind_role = 'bb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = lh.hand_id AND hp.blind_role = 'sb') <> 1);
  WITH owed AS (
    SELECT lh.cluster_id, hp.player_id, count(*) FILTER (WHERE hp.blind_role = 'bb') AS bb, count(*) FILTER (WHERE hp.blind_role = 'sb') AS sb
      FROM public.lightning_hand lh JOIN public.lightning_hand_player hp ON hp.hand_id = lh.hand_id
      JOIN public.lightning_instance li ON li.id = lh.lightning_instance_id
     WHERE lh.cluster_id = ANY (v_cl) AND NOT (li.state = 'abandoned' AND li.started_at IS NULL)
     GROUP BY 1, 2)
  SELECT count(*) INTO v_m FROM (
    SELECT 1 FROM owed o
      FULL JOIN (SELECT * FROM public.lightning_blind_ledger WHERE cluster_id = ANY (v_cl)) bl
        ON bl.cluster_id = o.cluster_id AND bl.player_id = o.player_id
     WHERE coalesce(o.bb, 0) IS DISTINCT FROM coalesce(bl.bb_count, 0) OR coalesce(o.sb, 0) IS DISTINCT FROM coalesce(bl.sb_count, 0)) z;
  inv := 'no_duplicate_blind'; ok := v_n = 0 AND v_m = 0;
  detail := format('%s hands without exactly one BB and one SB; %s blind-ledger rows disagree with the dealt and kept formations (%s ledger rows)', v_n, v_m,
                   (SELECT count(*) FROM public.lightning_blind_ledger WHERE cluster_id = ANY (v_cl)));
  RETURN NEXT;

  -- 9 NO ORPHAN RESERVATION after the reapers: nothing live remains, no
  -- reservation is active, none belongs to a terminal instance, and no open
  -- session still carries exposure.
  SELECT (SELECT count(*) FROM public.lightning_reservation rv WHERE rv.cluster_id = ANY (v_cl) AND rv.state IN ('pending', 'committed'))
       + (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id = ANY (v_cl) AND li.state IN ('forming', 'reserved', 'dealing', 'settling'))
       + (SELECT count(*) FROM public.lightning_reservation rv JOIN public.lightning_instance li ON li.id = rv.lightning_instance_id
           WHERE rv.cluster_id = ANY (v_cl) AND rv.state IN ('pending', 'committed') AND li.state IN ('complete', 'abandoned'))
       + (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = ANY (v_cl) AND ps.exited_at IS NULL
           AND public.fn_lightning_pool_exposure(ps.player_id, ps.cluster_id) <> 0)
    INTO v_n;
  SELECT count(*) INTO v_m FROM public.lightning_reservation rv WHERE rv.cluster_id = ANY (v_cl);
  inv := 'no_orphan_reservation'; ok := v_n = 0;
  detail := format('%s reservations written; %s still active, live, owned by a terminal instance or lingering as exposure after the drain and the reapers', v_m, v_n);
  RETURN NEXT;

  -- 10 NO AMBIGUOUS SETTLEMENT: every instance is complete (settled, with
  -- its receipt, its history and every stack_after) or abandoned (no
  -- settlement trace, so its stacks stand where they were); none settling.
  SELECT count(*) INTO v_n FROM public.lightning_instance li LEFT JOIN public.lightning_hand lh ON lh.hand_id = li.hand_id
   WHERE li.cluster_id = ANY (v_cl)
     AND NOT ((li.state = 'complete' AND lh.settled_at IS NOT NULL AND lh.settle_receipt IS NOT NULL AND lh.hand_history_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp WHERE hp.hand_id = lh.hand_id AND hp.stack_after IS NULL))
           OR (li.state = 'abandoned' AND (lh.hand_id IS NULL OR (lh.settled_at IS NULL AND lh.settle_receipt IS NULL AND lh.hand_history_id IS NULL))));
  SELECT count(*) INTO v_m FROM public.lightning_instance li WHERE li.cluster_id = ANY (v_cl);
  inv := 'no_ambiguous_settlement'; ok := v_n = 0;
  detail := format('%s instances (%s complete, %s abandoned); %s neither cleanly settled nor cleanly void', v_m,
                   (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id = ANY (v_cl) AND li.state = 'complete'),
                   (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id = ANY (v_cl) AND li.state = 'abandoned'), v_n);
  RETURN NEXT;

  -- 11 NO FROZEN CLUSTER unless the scenario planted the fault that warrants
  -- it, and then the freeze carries its evidence.
  SELECT count(*), string_agg(cg.id::text, ',') INTO v_n, v_txt FROM public.cash_games cg
   WHERE cg.id = ANY (v_cl) AND cg.cluster_mode = 'frozen'
     AND NOT EXISTS (SELECT 1 FROM lc.expect_frozen ef WHERE ef.scen = p_scen AND ef.cluster_id = cg.id);
  SELECT count(*) INTO v_m FROM lc.expect_frozen ef JOIN public.cash_games cg ON cg.id = ef.cluster_id
   WHERE ef.scen = p_scen AND (cg.cluster_mode <> 'frozen'
      OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = cg.id AND e.kind IN ('cluster_frozen', 'stack_invariant_failed')));
  inv := 'no_unwarranted_freeze'; ok := v_n = 0 AND v_m = 0;
  detail := format('%s Clusters frozen without a planted fault %s; %s planted faults without a frozen, evidenced Cluster', v_n, coalesce(v_txt, ''), v_m);
  RETURN NEXT;

  -- 12 THE MODES ARE CONSISTENT: one open epoch per Cluster and it is the
  -- Cluster's epoch, at most one open conversion, a MUST MOVE Cluster holds
  -- no open pool session or slot, a LIGHTNING Cluster's open pool is all in
  -- its current epoch.
  SELECT (SELECT count(*) FROM public.cash_games cg WHERE cg.id = ANY (v_cl)
           AND (SELECT count(*) FROM public.cash_cluster_epoch e WHERE e.cluster_id = cg.id AND e.ended_at IS NULL) <> 1)
       + (SELECT count(*) FROM public.cash_games cg WHERE cg.id = ANY (v_cl)
           AND (SELECT count(*) FROM public.cash_cluster_conversion cv WHERE cv.cluster_id = cg.id AND cv.status = 'pending') > 1)
       + (SELECT count(*) FROM public.cash_games cg WHERE cg.id = ANY (v_cl) AND cg.cluster_mode = 'must_move'
           AND (EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = cg.id AND ps.exited_at IS NULL)
             OR EXISTS (SELECT 1 FROM public.lightning_pool_slot sl WHERE sl.cluster_id = cg.id AND sl.closed_at IS NULL)))
       + (SELECT count(*) FROM public.cash_games cg WHERE cg.id = ANY (v_cl) AND cg.cluster_mode = 'lightning'
           AND EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = cg.id AND ps.exited_at IS NULL
                         AND ps.cluster_epoch <> cg.cluster_epoch))
       + (SELECT count(*) FROM public.cash_games cg WHERE cg.id = ANY (v_cl)
           AND EXISTS (SELECT 1 FROM public.cash_cluster_epoch e WHERE e.cluster_id = cg.id AND e.ended_at IS NULL
                         AND e.epoch <> cg.cluster_epoch))
    INTO v_n;
  SELECT string_agg(x.cluster_mode || '=' || x.n, ' ') INTO v_txt FROM (
    SELECT cg.cluster_mode, count(*) AS n FROM public.cash_games cg WHERE cg.id = ANY (v_cl) GROUP BY 1 ORDER BY 1) x;
  inv := 'cluster_modes_consistent'; ok := v_n = 0; detail := format('modes %s; %s inconsistencies', v_txt, v_n); RETURN NEXT;

  -- 12b NO MONEY MOVED BY A MODE CHANGE: the conversion, reversion,
  -- unfreeze and formation guards (md5 over every live seat, open cash
  -- session and blind-ledger row before and after) never fired, not even
  -- where the drive swallowed an error into its evidence row.
  SELECT count(*) INTO v_n FROM public.cash_cluster_events e
   WHERE e.game_id = ANY (v_cl) AND e.payload::text ~ 'MOVED_MONEY';
  SELECT count(*) INTO v_m FROM public.cash_cluster_conversion cv WHERE cv.cluster_id = ANY (v_cl);
  inv := 'no_money_moved_by_a_mode_change'; ok := v_n = 0;
  detail := format('%s conversions; %s money-guard trips (LIGHTNING_*_MOVED_MONEY); %s drive errors recorded', v_m, v_n,
                   (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = ANY (v_cl) AND e.kind = 'lightning_drive_error'));
  RETURN NEXT;

  -- 13 NO UNEXPECTED ERROR from any production door: only the retryable
  -- classes (deadlock, lock timeout, serialization) are tolerated, and are
  -- reported.
  -- (The operating system interrupting a backend's file open while the
  -- killer signals it is the host's, not a door's, and is reported apart.)
  SELECT count(*) FILTER (WHERE NOT (e.sqlstate = ANY (p_allowed_states)) AND e.msg NOT LIKE '%Interrupted system call%'),
         string_agg(DISTINCT e.op || ':' || e.sqlstate || ':' || left(e.msg, 160), ' | ')
           FILTER (WHERE NOT (e.sqlstate = ANY (p_allowed_states)) AND e.msg NOT LIKE '%Interrupted system call%')
    INTO v_n, v_txt FROM lc.err e WHERE e.scen = p_scen;
  inv := 'no_unexpected_error'; ok := v_n = 0;
  detail := format('%s unexpected %s; tolerated: %s', v_n, left(coalesce(v_txt, ''), 600),
                   coalesce((SELECT string_agg(z.op || ':' || z.sqlstate || 'x' || z.n, ' ') FROM (
                     SELECT e.op, CASE WHEN e.msg LIKE '%Interrupted system call%' THEN 'EINTR' ELSE e.sqlstate END AS sqlstate, count(*) AS n
                       FROM lc.err e WHERE e.scen = p_scen AND (e.sqlstate = ANY (p_allowed_states) OR e.msg LIKE '%Interrupted system call%')
                      GROUP BY 1, 2 ORDER BY 1, 2) z), 'none'));
  RETURN NEXT;
END $f$;
ASSERT

# ===========================================================================
# THE BUILD: the chain, the Phase 11 ground, Phase 11 itself (production
# carries it), this phase's own files twice, then this harness's rig.
# ===========================================================================
chain=(-f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture"
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r"
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture"
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" -f "$p6" -f "$s6_fixture" -f "$s6" -f "$s6r" -f "$p7"
  -f "$phase8" -f "$p7r" -f "$fix" -f "$p9d" -f "$p10" -f "$p9r2"
  -f "$fixture/p11-ground.sql" -f "$p11" -f "$p12rg")
# EVERY @live-proof OF EVERY LIGHTNING FILE, evaluated as code by fxr_eval
# (NULL when it no longer evaluates, never false), before and after this
# phase's own files; theirs must all hold and no predecessor's may fall.
proofs() { # tag file...
  local tag=$1 f line n expr; shift
  for f in "$@"; do
    n=0
    while IFS= read -r line; do
      n=$((n + 1)); expr=${line#-- @live-proof: }
      case "$expr" in *'$lpq$'*) echo "FAIL: a proof carries the quoting tag"; exit 1 ;; esac
      printf '%s\n' "INSERT INTO lc_proofs VALUES ('$tag', '$(basename "$f")', $n, public.fxr_eval(\$lpq\$${expr}\$lpq\$));"
    done < <(grep -- '^-- @live-proof: ' "$f")
  done
}
lightning_files=("$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" "$phase5" "$phase5r" "$phase9" "$phase9r"
                 "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$p12rg")
{ echo "CREATE TABLE lc_proofs (tag text, file text, n integer, ok boolean);"; proofs before "${lightning_files[@]}"; } > "$fixture/proofs-before.sql"
proofs after "${lightning_files[@]}" > "$fixture/proofs-after.sql"
proofs own $extra > "$fixture/proofs-own.sql"
chain+=(-f "$fixture/proofs-before.sql")
for f in $extra; do chain+=(-f "$f" -f "$f"); done
chain+=(-f "$fixture/proofs-after.sql" -f "$fixture/proofs-own.sql" -f "$fixture/ground.sql")
set +e
"${PSQL[@]}" "${chain[@]}" > "$fixture/build.out" 2>&1
status=$?
set -e
if [ "$status" != 0 ]; then
  grep -v -E 'NOTICE|^ *$' "$fixture/build.out" | tail -20
  echo "FAIL: the chain did not build (psql exited $status)"
  exit 1
fi
grep -q '  ok  00 THE GROUND' "$fixture/build.out" || { echo "FAIL: the Phase 11 ground did not report"; exit 1; }
# A predecessor proof a later file supersedes by design (its header restates
# it) is named in LIGHTNING_P12_SUPERSEDED as file#n, space separated; every
# other fallen proof still fails the build.
superseded=${LIGHTNING_P12_SUPERSEDED-}
fallen=$(Q "SELECT coalesce(string_agg(a.file || '#' || a.n, ', '), '') FROM lc_proofs b JOIN lc_proofs a ON a.tag = 'after' AND a.file = b.file AND a.n = b.n
             WHERE b.tag = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE
               AND NOT ((a.file || '#' || a.n) = ANY (string_to_array('$superseded', ' ')))")
ownbad=$(Q "SELECT coalesce(string_agg(file || '#' || n || '=' || coalesce(ok::text, 'error'), ', '), '') FROM lc_proofs WHERE tag = 'own' AND ok IS NOT TRUE")
ownn=$(Q "SELECT count(*) FROM lc_proofs WHERE tag = 'own'")
predn=$(Q "SELECT count(*) FILTER (WHERE ok) FROM lc_proofs WHERE tag = 'before'")
[ -z "$fallen" ] || { echo "FAIL: this phase's files falsified predecessor proofs: $fallen"; exit 1; }
[ -z "$ownbad" ] || { echo "FAIL: this phase's own proofs do not hold: $ownbad"; exit 1; }
if [ -n "$extra" ] && [ "$ownn" = 0 ]; then echo "FAIL: this phase's files carry no @live-proof"; exit 1; fi
for op in match match_replay form deal fold settle settle_replay presence rebuy tick drive ack join leave stop wave; do
  for i in $(seq 1 40); do echo "SELECT lc.op_$op();"; echo "SELECT lc.nap('$op');"; done > "$fixture/ops/$op.sql"
done
echo "  ok  00 THE BUILD  the real Lightning chain through Phase 11 and 20261009143757 on the Phase 11 ground (production default ACLs and autorevoke live)${extra:+, the Phase 12 files applied twice ($ownn own live proofs true, none of the $predn true predecessor proofs falsified)}, the load rig installed; profile $profile, populations $pops"

# Deterministic budget countercases use the real matcher and retain its budget.
# Their plan/barrier fault wrappers and all synthetic rows are rolled back.
cat > "$fixture/budget-countercases.sql" <<'BUDGET_CASES'
BEGIN;
CREATE TEMP TABLE diag_budget_attempts(mode text);
DO $diag$
DECLARE p record; v_source text; v_injection text;
BEGIN
 FOR p IN SELECT oid,proname FROM pg_proc WHERE proname IN ('fn_lightning_match_plan','fn_lightning_form_hand') AND pronamespace='public'::regnamespace LOOP
  v_source := pg_get_functiondef(p.oid);
  IF p.proname='fn_lightning_match_plan' THEN
   v_injection := E'BEGIN\n  IF current_setting(''lc.diag_budget'', true)=''slow_plan'' THEN PERFORM pg_sleep(0.9); END IF;';
  ELSE
   v_injection := E'BEGIN\n  INSERT INTO pg_temp.diag_budget_attempts VALUES (current_setting(''lc.diag_budget'',true));\n  IF current_setting(''lc.diag_budget'', true)=''retry'' THEN PERFORM pg_sleep(0.9); RETURN jsonb_build_object(''ok'',false,''formed'',false,''retry'',true,''reason'',''formation_contended'',''sqlstate'',''55P03''); END IF;';
  END IF;
  v_source := overlay(v_source placing v_injection from strpos(v_source,E'BEGIN\n') for 5);
  EXECUTE v_source;
 END LOOP;
END $diag$;
DO $cases$
DECLARE c uuid; r jsonb; n integer;
BEGIN
 c:=lc.build('D1','slowplan',6,18);
 PERFORM set_config('lc.diag_budget','slow_plan',true);
 r:=public.fn_lightning_match_and_form(c,clock_timestamp(),NULL,1,gen_random_uuid(),NULL);
 SELECT count(*) INTO n FROM pg_temp.diag_budget_attempts WHERE mode='slow_plan';
 RAISE NOTICE 'SLOW_FIRST_PLAN response=% attempts=%',r,n;
 IF coalesce((r->>'formed')::integer,0)<>1 OR n<>1 OR jsonb_array_length(r->'retries')<>0 THEN RAISE EXCEPTION 'slow first plan failed'; END IF;
 c:=lc.build('D2','retry',6,18);
 PERFORM set_config('lc.diag_budget','retry',true);
 r:=public.fn_lightning_match_and_form(c,clock_timestamp(),NULL,1,gen_random_uuid(),NULL);
 SELECT count(*) INTO n FROM pg_temp.diag_budget_attempts WHERE mode='retry';
 RAISE NOTICE 'RETRY_BUDGET response=% attempts=%',r,n;
 IF lc.pass_starved(r) OR NOT lc.pass_starved(r || jsonb_build_object('retries',jsonb_build_array(jsonb_build_object('reason','unknown','sqlstate','55P03')))) OR NOT lc.pass_starved((r - 'retries' - 'replans') || jsonb_build_object('retries','[]'::jsonb,'replans',0)) OR r->>'stopped_reason'<>'time_budget' OR coalesce((r->>'formed')::integer,-1)<>0 OR n<>1 OR (r->>'replans')::integer<>1 OR jsonb_array_length(r->'retries')<>1 THEN RAISE EXCEPTION 'retry budget failed'; END IF;
END $cases$;
ROLLBACK;
BUDGET_CASES
"${PSQL[@]}" -f "$fixture/budget-countercases.sql"
echo "  ok  THE BUDGET COUNTERCASES  slow first plan forms; a documented retry remains bounded; zero-attempt starvation still fails"

# LIGHTNING_P12_ONLY (a space-separated list of scenario ids: L, S1, C2 ...)
# runs a subset while developing; a subset never prints PASS.
only=${LIGHTNING_P12_ONLY:-}
want() { [ -z "$only" ] && return 0; local x; for x in $only; do case "$1" in "$x"*) return 0 ;; esac; done; return 1; }

# ===========================================================================
# THE RUNNER: workers, the killer, the drain, the verdict.
# ===========================================================================
now_s() { date +%s; }
wloop() { # scen name op opts end
  local scen=$1 name=$2 op=$3 opts=$4 end=$5
  while [ "$(now_s)" -lt "$end" ]; do
    PGAPPNAME="lcw-$name" PGOPTIONS="-c lc.scen=$scen $opts" "$pgbin/psql" -X -q -h "$sock" -p "$port" -d postgres \
      -f "$fixture/ops/$op.sql" >/dev/null 2>>"$fixture/workers.err" || true
  done
}
kloop() { # scen mode like period end
  local scen=$1 mode=$2 like=$3 period=$4 end=$5
  while [ "$(now_s)" -lt "$end" ]; do
    PGAPPNAME=lck PGOPTIONS="-c lc.scen=$scen" "$pgbin/psql" -X -q -At -h "$sock" -p "$port" -d postgres \
      -c "SELECT lc.kill('$mode', '$like')" >/dev/null 2>&1 || true
    sleep "$period"
  done
}
# storm SCEN SECONDS SPEC... where SPEC is name|count|op|pgoptions, or
# kill|mode|like|period for a killer.
storm() {
  local scen=$1 secs=$2; shift 2
  local end=$(( $(now_s) + secs )) spec name n op opts i
  Q "INSERT INTO lc.ctl (scen, until, pop) VALUES ('$scen', clock_timestamp() + interval '$secs seconds', (SELECT coalesce(max(pop), 0) FROM lc.cl WHERE scen = '$scen'))
     ON CONFLICT (scen) DO UPDATE SET until = EXCLUDED.until" >/dev/null
  local pids=()
  for spec in "$@"; do
    IFS='|' read -r name n op opts <<< "$spec"
    if [ "$name" = kill ]; then
      kloop "$scen" "$n" "$op" "$opts" "$end" & pids+=($!)
    else
      for i in $(seq 1 "$n"); do wloop "$scen" "$name" "$op" "$opts" "$end" & pids+=($!); done
    fi
  done
  echo "${pids[@]}" >> "$fixture/pids"
  wait "${pids[@]}" 2>/dev/null || true
}
# The engine keeps going after a storm: fresh window for the drive loops.
reopen() { Q "INSERT INTO lc.ctl (scen, until) VALUES ('$1', clock_timestamp() + interval '1 day') ON CONFLICT (scen) DO UPDATE SET until = EXCLUDED.until" >/dev/null; }
shut() { Q "UPDATE lc.ctl SET until = clock_timestamp() WHERE scen = '$1'" >/dev/null; }
# Drive every Cluster of a scenario to rest, with the engine's halt
# acknowledgement and its drain between passes.
rest() {
  local scen=$1 i
  reopen "$scen"
  for i in 1 2 3 4 5 6; do
    Q "SELECT lc.drain('$scen')" >/dev/null
    PGOPTIONS="-c lc.scen=$scen" "$pgbin/psql" -X -q -At -h "$sock" -p "$port" -d postgres -c "SELECT lc.op_ack()" \
      -c "SELECT public.fn_cash_cluster_lightning_drive(id) FROM lc.cl WHERE scen = '$scen'" >/dev/null 2>&1 || true
  done
  shut "$scen"
}
verdict() { # scen title -> drain, reap, check, print
  local scen=$1 title=$2 drained reaped bad
  drained=$(Q "SELECT lc.drain('$scen')")
  reaped=$(Q "SELECT lc.reap('$scen')")
  Q "INSERT INTO lc.verdict (scen, inv, ok, detail) SELECT '$scen', c.inv, c.ok, c.detail FROM lc.check('$scen') c" >/dev/null
  bad=$(Q "SELECT count(*) FROM lc.verdict WHERE scen = '$scen' AND ok IS NOT TRUE")
  Q "SELECT format('      %s %-40s %s', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, inv, detail) FROM lc.verdict WHERE scen = '$scen' ORDER BY id"
  echo "      drain $drained reapers $reaped"
  if [ "$bad" = 0 ]; then echo "  ok  $scen $title"; else echo "  FAIL $scen $title ($bad invariants failed)"; fi
}
mode_rest_check() { # scen label: no Cluster at rest in a mode its population contradicts, no open conversion
  local scen=$1 label=$2 extra_ok=$3 extra_txt=$4
  Q "INSERT INTO lc.verdict (scen, inv, ok, detail)
     SELECT '$scen', '$label', count(*) FILTER (WHERE bad) = 0 AND $extra_ok,
            format('%s Clusters at rest (%s); %s in a mode their live population contradicts or holding an open conversion; conversions %s committed, %s aborted; $extra_txt',
                   count(*), string_agg(DISTINCT mode, ' '), count(*) FILTER (WHERE bad),
                   (SELECT count(*) FROM public.cash_cluster_conversion cv WHERE cv.cluster_id IN (SELECT id FROM lc.cl WHERE scen = '$scen') AND cv.status = 'committed'),
                   (SELECT count(*) FROM public.cash_cluster_conversion cv WHERE cv.cluster_id IN (SELECT id FROM lc.cl WHERE scen = '$scen') AND cv.status = 'aborted'))
       FROM (SELECT cg.id, cg.cluster_mode AS mode,
                    cg.cluster_mode NOT IN ('lightning', 'must_move')
                    OR EXISTS (SELECT 1 FROM public.cash_cluster_conversion cv WHERE cv.cluster_id = cg.id AND cv.status = 'pending')
                    OR (cg.cluster_mode = 'lightning' AND harness.live(cg.id) <= (public.fn_cash_cluster_lightning_thresholds(cg.id) ->> 'off')::integer)
                    OR (cg.cluster_mode = 'must_move' AND harness.live(cg.id) >= (public.fn_cash_cluster_lightning_thresholds(cg.id) ->> 'on')::integer) AS bad
               FROM public.cash_games cg WHERE cg.id IN (SELECT id FROM lc.cl WHERE scen = '$scen')) z" >/dev/null
}
snap() { Q "SELECT lc.snapshot('$1')" >/dev/null; Q "ANALYZE" >/dev/null; }
clamp() { local v=$1 lo=$2 hi=$3; [ "$v" -lt "$lo" ] && v=$lo; [ "$v" -gt "$hi" ] && v=$hi; echo "$v"; }
CFG='{"auto_rebuy_enabled": true, "auto_rebuy_trigger": "below_pct", "auto_rebuy_threshold_pct": 99, "auto_rebuy_target": "initial", "auto_rebuy_max_count": 100}'
ran=0

# ===========================================================================
# LOAD: one Cluster per population, the whole engine loop against it: two
# matchers racing the same Cluster, a direct barrier caller, dealers, fold
# bars, settlers racing the same hands, replays of passes and settlements,
# presence flapping and the auto-rebuy race.
# ===========================================================================
n=0
for pop in $pops; do
  n=$((n + 1)); scen=$(printf 'L%02d' "$n")
  want "$scen" || continue
  t0=$(now_s)
  Q "SELECT lc.build('$scen', 'load $pop', 6, $pop, 1, 'nlh', '$CFG')" >/dev/null
  built=$(( $(now_s) - t0 ))
  snap "$scen"
  secs=$T_LOAD; [ "$pop" -ge 5000 ] && secs=$T_BIG
  if [ "$W" = 1 ]; then d=$(clamp $((pop / 60)) 2 10); f=$(clamp $((pop / 40)) 2 14); else d=$(clamp $((pop / 100)) 1 3); f=$(clamp $((pop / 60)) 1 4); fi
  storm "$scen" "$secs" "match|2|match|" "form|1|form|" "deal|$d|deal|" "fold|$f|fold|" "settle|$d|settle|" \
        "replay|1|settle_replay|" "mreplay|1|match_replay|" "presence|1|presence|" "rebuy|2|rebuy|"
  verdict "$scen" "LOAD $pop  eligible players in one Cluster (built in ${built}s), $secs s of the whole engine loop on $((2 + 1 + d + f + d + 1 + 1 + 1 + 2)) concurrent backends"
  ran=$((ran + 1))
done

# ===========================================================================
# STRESS.
# ===========================================================================
# S1 MASS JOINS, MASS LEAVES, STOP PLAYING STORMS, all while the engine
# plays: a nine-max Cluster takes a join storm, a leave storm and duplicate
# Stop Playing requests (in a hand and out of one) at once.
if want S1; then
  Q "SELECT lc.build('S1', 'joins', 9, 120, 2, 'nlh', '$CFG')" >/dev/null
  snap S1
  storm S1 "$T_STRESS" "match|2|match|" "form|1|form|" "deal|3|deal|" "fold|4|fold|" "settle|3|settle|" \
        "join|8|join|" "leave|4|leave|" "stop|3|stop|" "tick|1|tick|"
  verdict S1 "STRESS MASS JOINS, LEAVES AND STOP PLAYING  join, leave and duplicate Stop Playing storms against a playing nine-max Cluster"
  ran=$((ran + 1))
fi

# S2 RECONNECT STORM: four presence reporters flapping the same players,
# folds healing stale stamps, the matcher withholding the disconnected,
# then half the disconnected backdated past the timeout and reaped while
# the storm goes on.
if want S2; then
  Q "SELECT lc.build('S2', 'presence', 6, 90, 1, 'nlh', '$CFG')" >/dev/null
  snap S2
  storm S2 "$T_STRESS" "match|2|match|" "deal|2|deal|" "fold|4|fold|" "settle|2|settle|" "presence|4|presence|" "tick|1|tick|" &
  spid=$!
  sleep $(( T_STRESS / 2 ))
  # Twelve players leave for good mid-storm: reported gone through the real
  # door, held out of the flapping, their stamps backdated past the timeout.
  Q "INSERT INTO lc.held SELECT ps.player_id FROM public.lightning_pool_session ps
      WHERE ps.cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'S2') AND ps.exited_at IS NULL ORDER BY random() LIMIT 12" >/dev/null
  Q "DO \$\$ DECLARE i integer; BEGIN FOR i IN 1 .. 20 LOOP BEGIN
       PERFORM public.fn_lightning_presence_report(c.id, ARRAY(SELECT player_id FROM lc.held), ARRAY[]::uuid[], clock_timestamp())
          FROM lc.cl c WHERE c.scen = 'S2';
       RETURN; EXCEPTION WHEN deadlock_detected THEN PERFORM pg_sleep(0.05); END; END LOOP;
       RAISE EXCEPTION 'FIXTURE: the held players could not be reported gone'; END \$\$" >/dev/null
  Q "DO \$\$ DECLARE i integer; BEGIN FOR i IN 1 .. 20 LOOP BEGIN
       UPDATE public.lightning_pool_session SET disconnected_at = clock_timestamp() - interval '1 hour'
        WHERE cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'S2') AND exited_at IS NULL AND player_id IN (SELECT player_id FROM lc.held);
       RETURN; EXCEPTION WHEN deadlock_detected THEN PERFORM pg_sleep(0.05); END; END LOOP;
       RAISE EXCEPTION 'FIXTURE: the held players could not be backdated'; END \$\$" >/dev/null
  Q "SELECT public.fn_cash_clusters_tick_all('{}'::jsonb) ->> 'disconnects_reaped'" >/dev/null
  wait $spid
  midstorm=$(Q "SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'S2') AND exit_reason = 'disconnect_expired'")
  stamped=$(Q "SELECT count(*) FROM public.cash_cluster_events WHERE game_id IN (SELECT id FROM lc.cl WHERE scen = 'S2') AND kind IN ('player_disconnected', 'player_reconnected')")
  Q "SELECT lc.drain('S2'), lc.reap('S2')" >/dev/null
  Q "INSERT INTO lc.verdict (scen, inv, ok, detail)
     SELECT 'S2', 'the_gone_expire_the_present_do_not', count(*) FILTER (WHERE ps.exit_reason = 'disconnect_expired' AND ps.player_id IN (SELECT player_id FROM lc.held)) = 12
                AND count(*) FILTER (WHERE ps.exit_reason = 'disconnect_expired' AND ps.player_id NOT IN (SELECT player_id FROM lc.held)) = 0,
            format('%s of the 12 players who left for good expired (%s mid-storm), %s players who kept reconnecting expired',
                   count(*) FILTER (WHERE ps.exit_reason = 'disconnect_expired' AND ps.player_id IN (SELECT player_id FROM lc.held)), $midstorm,
                   count(*) FILTER (WHERE ps.exit_reason = 'disconnect_expired' AND ps.player_id NOT IN (SELECT player_id FROM lc.held)))
       FROM public.lightning_pool_session ps WHERE ps.cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'S2')" >/dev/null
  verdict S2 "STRESS RECONNECT STORM  $stamped presence transitions from four flapping reporters, self-healing folds, 12 players gone for good expired by the reaper and nobody else"
  ran=$((ran + 1))
fi

# S3 CONVERSION STORM: ten Clusters of two sizes, four stakes and three
# variants oscillate across ON and OFF while several drives per Cluster
# race, two ticks race them, the engine acknowledges halts and plays every
# Cluster that is LIGHTNING.
if want S3; then
  for k in 1 2 3 4 5 6 7 8 9 10; do
    h=6; [ $((k % 3)) = 0 ] && h=9
    sb=$(( (k % 4) + 1 )); v=nlh; [ $((k % 3)) = 1 ] && v=plo; [ $((k % 5)) = 0 ] && v=short_deck
    on=18; [ "$h" = 9 ] && on=27
    Q "SELECT lc.build('S3', 'conv $k', $h, $on, $sb, '$v', '{\"pending_off_dwell_ms\": 0}'::jsonb || '$CFG'::jsonb)" >/dev/null
  done
  snap S3
  storm S3 "$T_STRESS" "drive|4|drive|" "tick|2|tick|" "ack|1|ack|" "wave|3|wave|" \
        "match|2|match|" "deal|2|deal|" "fold|3|fold|" "settle|2|settle|"
  rest S3
  mode_rest_check S3 mode_matches_population true ""
  verdict S3 "STRESS CONVERSION STORM  ten Clusters (six- and nine-max, four stakes, three variants) crossing ON and OFF under racing drives and ticks while they play"
  ran=$((ran + 1))
fi

# ===========================================================================
# CHAOS.
# ===========================================================================
# C1 TIMEOUTS, CANCELS AND TERMINATIONS on the whole loop: some workers run
# under a 40 ms statement_timeout and a 15 ms lock_timeout, a sleep is armed
# inside the barrier and the settlement, and killers cancel and terminate
# random workers mid transaction.
if want C1; then
  for k in 1 2 3; do Q "SELECT lc.build('C1', 'chaos $k', 6, 60, $k, 'nlh', '$CFG')" >/dev/null; done
  snap C1
  TO="-c statement_timeout=40 -c lock_timeout=15"
  SL="-c lc.fault_form=0.02 -c lc.fault_settle=0.03"
  storm C1 "$T_CHAOS" "match|2|match|$SL" "matcht|1|match|$TO" "form|1|form|$SL" "deal|2|deal|" "dealt|1|deal|$TO" \
        "fold|3|fold|" "foldt|1|fold|$TO" "settle|2|settle|$SL" "settlet|1|settle|$TO $SL" "replay|1|settle_replay|" \
        "presence|1|presence|$TO" "rebuy|2|rebuy|$TO" "tick|1|tick|$TO" \
        "kill|cancel|lcw-%|0.06" "kill|terminate|lcw-%|0.09"
  kills=$(Q "SELECT count(*) FILTER (WHERE mode = 'cancel') || ' cancels and ' || count(*) FILTER (WHERE mode = 'terminate') || ' terminations' FROM lc.kills WHERE scen = 'C1'")
  verdict C1 "CHAOS DB TIMEOUT AND CONNECTION LOSS  statement and lock timeouts, $kills mid transaction, faults armed inside the barrier and the settlement"
  ran=$((ran + 1))
fi

# C2 KILLED FORMATION, then the reaper: formations are killed inside the
# barrier (a sleep armed after the first reservation, then a termination);
# formations that committed are left undealt by an engine that died
# (form_window 5 s) and dealt hands lose their host (deadline backdated);
# then the tick's reaper alone recovers them.
if want C2; then
  Q "SELECT lc.build('C2', 'reap', 6, 72, 1, 'nlh', '{\"form_window_ms\": 5000}'::jsonb || '$CFG'::jsonb)" >/dev/null
  snap C2
  storm C2 "$T_CHAOS" "match|2|match|-c lc.fault_form=0.05" "form|2|form|-c lc.fault_form=0.05" "deal|1|deal|" "fold|2|fold|" \
        "kill|terminate|lcw-match%|0.07" "kill|terminate|lcw-form%|0.07"
  live_before=$(Q "SELECT count(*) FROM public.lightning_instance WHERE cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'C2') AND state IN ('forming','reserved','dealing')")
  Q "UPDATE public.lightning_instance SET deadline_at = greatest(created_at + interval '1 millisecond', clock_timestamp() - interval '1 second')
      WHERE cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'C2') AND state = 'dealing'" >/dev/null
  sleep 6
  tick=$(Q "SELECT public.fn_cash_clusters_tick_all('{}'::jsonb) ->> 'ok'")
  Q "INSERT INTO lc.verdict (scen, inv, ok, detail)
     SELECT 'C2', 'the_reaper_alone_recovers', count(*) = 0 AND $live_before > 0,
            format('%s live instances left by dead engines before the tick, %s after it (tick ok %s); %s abandoned by the reaper', $live_before, count(*), '$tick',
                   (SELECT count(*) FROM public.lightning_instance li WHERE li.cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'C2')
                       AND li.state = 'abandoned' AND li.abandon_reason NOT LIKE 'lc_drain%'))
       FROM public.lightning_instance WHERE cluster_id IN (SELECT id FROM lc.cl WHERE scen = 'C2') AND state IN ('forming','reserved','dealing','settling')" >/dev/null
  verdict C2 "CHAOS KILLED FORMATION AND DEAD ENGINES  barrier transactions terminated mid flight, $live_before formations and hands orphaned by dead engines, recovered by the reaper alone"
  ran=$((ran + 1))
fi

# C3 SETTLEMENT RETRY AFTER A TERMINATED CONNECTION: every settlement sleeps
# inside its transaction (after its anchors are marked, before its commit)
# and the killer terminates settlers there; settlers retry the same request
# until each hand is settled exactly once.
if want C3; then
  Q "SELECT lc.build('C3', 'settle', 6, 60, 1, 'nlh', '$CFG')" >/dev/null
  snap C3
  storm C3 "$T_CHAOS" "match|1|match|" "deal|2|deal|" "fold|2|fold|" "settle|5|settle|-c lc.fault_settle=0.04" "replay|1|settle_replay|" \
        "kill|terminate|lcw-settle%|0.05"
  kills=$(Q "SELECT count(*) FROM lc.kills WHERE scen = 'C3'")
  verdict C3 "CHAOS SETTLEMENT RETRY  $kills settlers terminated inside the settlement transaction, every hand retried to exactly one settlement"
  ran=$((ran + 1))
fi

# C4 CONVERSION FAILURE MID-DRIVE AND A SERVER RESTART: faults raise inside
# half the conversion writes of some drives and sleep inside the rest,
# drives and ticks are cancelled and terminated, and at the end every
# backend is terminated at once (a restart); then the stuck-conversion
# reaper runs once and the Clusters are driven back to rest.
if want C4; then
  for k in 1 2 3 4; do Q "SELECT lc.build('C4', 'convfail $k', 6, 18, 1, 'nlh', '{\"pending_off_dwell_ms\": 0}'::jsonb || '$CFG'::jsonb)" >/dev/null; done
  snap C4
  storm C4 "$T_CHAOS" "drive|3|drive|-c lc.fault_convert=raise" "drives|2|drive|-c lc.fault_convert=0.05" "tick|2|tick|-c lc.fault_convert=0.03" \
        "ack|1|ack|" "wave|2|wave|" "match|1|match|" "deal|1|deal|" "settle|1|settle|" \
        "kill|cancel|lcw-drive%|0.08" "kill|terminate|lcw-tick%|0.15" &
  spid=$!
  sleep $(( T_CHAOS - 2 ))
  restarted=$(Q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name LIKE 'lcw-%'")
  wait $spid
  Q "SELECT public.fn_cash_cluster_reap_stuck_conversions(interval '0 seconds', clock_timestamp(), 100)" >/dev/null
  rest C4
  errs=$(Q "SELECT count(*) FROM public.cash_cluster_events WHERE game_id IN (SELECT id FROM lc.cl WHERE scen = 'C4') AND kind = 'lightning_drive_error'")
  mode_rest_check C4 failed_conversions_leave_no_trace "$errs > 0" "$errs drive errors recorded as evidence, $restarted backends terminated at once"
  verdict C4 "CHAOS CONVERSION FAILURE AND SERVER RESTART  faults inside the conversion, drives and ticks killed, $restarted backends terminated at once, the Clusters driven back to rest"
  ran=$((ran + 1))
fi

# ===========================================================================
# THE SCOREBOARD.
# ===========================================================================
echo
echo "  LIGHTNING PHASE 12 LOAD SCOREBOARD (milliseconds, database side, real concurrent backends; profile $profile)"
Q "SELECT format('  %-6s %-24s %8s %9s %9s %9s %9s', 'pop', 'operation', 'calls', 'p50', 'p95', 'p99', 'max')"
Q "SELECT format('  %-6s %-24s %8s %9s %9s %9s %9s', l.pop, l.op, count(*),
                 round(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.ms)::numeric, 2),
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l.ms)::numeric, 2),
                 round(percentile_cont(0.99) WITHIN GROUP (ORDER BY l.ms)::numeric, 2), round(max(l.ms), 2))
     FROM lc.lat l WHERE l.scen LIKE 'L%'
      AND l.op IN ('match_and_form', 'match_pass_inside', 'match_and_form_per_hand', 'form_hand', 'fast_fold', 'settle_hand', 'begin_dealing', 'bind_hand_number', 'presence_report', 'auto_rebuy')
    GROUP BY l.pop, l.op ORDER BY l.pop, l.op"
echo
Q "SELECT format('  %-6s %s hands formed, %s settled (%s per second); %s passes, %s stopped at the time budget; %s LIGHTNING FOLDs',
                 c.pop, (SELECT count(*) FROM public.lightning_hand lh WHERE lh.cluster_id = c.id),
                 (SELECT count(*) FROM public.lightning_hand lh WHERE lh.cluster_id = c.id AND lh.settled_at IS NOT NULL),
                 round((SELECT count(*) FROM lc.lat WHERE scen = c.scen AND op = 'settle_hand' AND outcome = 'settled')
                       / greatest(extract(epoch FROM (SELECT ct.until FROM lc.ctl ct WHERE ct.scen = c.scen) - (SELECT sm.at FROM lc.snap_meta sm WHERE sm.scen = c.scen)), 1), 1),
                 (SELECT count(*) FROM lc.lat WHERE scen = c.scen AND op = 'match_and_form'),
                 (SELECT count(*) FROM lc.lat WHERE scen = c.scen AND op = 'match_and_form' AND outcome = 'time_budget'),
                 (SELECT count(*) FROM lc.lat WHERE scen = c.scen AND op = 'fast_fold' AND outcome = 'fast'))
     FROM lc.cl c WHERE c.scen LIKE 'L%' ORDER BY c.pop"
echo
total=$(Q "SELECT count(*) FROM lc.verdict")
failed=$(Q "SELECT count(*) FROM lc.verdict WHERE ok IS NOT TRUE")
sections=$(Q "SELECT count(DISTINCT scen) FROM lc.verdict")
expected=$(( $(echo $pops | wc -w) + 7 ))
if [ "$failed" != 0 ]; then
  # Preserve the authoritative response that caused an invariant failure.
  # Counts alone cannot distinguish first-attempt starvation from a bounded
  # retry race; this diagnostic never changes the assertion or its exit code.
  Q "SELECT jsonb_build_object('scenario', scen, 'violation', what,
                              'response', detail, 'observed_at', at)::text
       FROM lc.violation ORDER BY id" | tee "$fixture/violations.jsonl"
  Q "SELECT format('  FAIL %s %s: %s', scen, inv, detail) FROM lc.verdict WHERE ok IS NOT TRUE ORDER BY id"
  echo "FAIL: $failed of $total invariant checks failed"
  exit 1
fi
if [ -n "$only" ]; then echo "SUBSET: $ran scenarios ($only), $total invariant checks, all PASS; a subset proves less than the file, so no PASS line"; exit 0; fi
if [ "$sections" != "$expected" ] || [ "$ran" != "$expected" ]; then
  echo "FAIL: $sections of the $expected scenarios reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 12 (DB) load, stress and chaos, profile $profile: $sections scenarios, $total invariant checks, all PASS, over the real chain through Phase 11 and 20261009143757 under production's default function ACLs and its live autorevoke event trigger: populations $pops loaded with the whole engine loop on real concurrent backends; mass joins, leaves and Stop Playing, a reconnect storm and a conversion storm over ten Clusters of two sizes, four stakes and three variants; statement and lock timeouts, cancels and terminations mid transaction, killed formations recovered by the reaper alone, settlements retried after a terminated connection to exactly one settlement, failed conversions and a server restart; no duplicate money, no lost money, no duplicate player, hand or blind, no orphan reservation, no ambiguous settlement, no unwarranted freeze"
