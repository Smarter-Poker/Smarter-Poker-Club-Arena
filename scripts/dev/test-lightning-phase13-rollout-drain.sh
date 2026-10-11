#!/usr/bin/env bash
# Lightning Phase 13 (the database side): rollout, drain and rollback.
#
# Proves 20261009235505 on Postgres 17, socket only, on port 55564
# (LIGHTNING_P13_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920235343
# through 20261009181945 (the Phase 11 remediation, the latest Lightning file
# production carries), in order, on the Phase 12 operator harness's own
# ground (read from it, so the two can never drift: its helpers, production's
# default function, table and sequence privileges, its live
# trg_autorevoke_privileged_anon event trigger, the gate ground and the
# managed cron API), then the file under test, twice.
#
# EVERY CONVERSION, REVERSION, FORMATION, DEAL, FOLD AND SETTLEMENT IS THE
# REAL ONE: Clusters convert ON by the real drive, hands form through the
# real barrier, deal through the real begin_dealing, fold through the real
# fold door and settle through the real settlement; every operator action is
# the real door called as PostgREST would call it (the claims and the role).
# The rows the harness writes itself are fixture boundaries only, each named
# where it is written: production's control gate verbatim
# (fn_ca_is_club_control), a supabase_migrations.schema_migrations stand-in,
# backdated stamps (time travel: a drain's deadline, a joins-closed stamp),
# an out-of-band config write (a live matcher version nobody may set through
# the door) and a grant flipped and restored (the readiness door's
# adversary).
#
# LAW 10.5. Humans and horses sit at every table; every drain releases both,
# the joins door refuses and later admits both, and the file reads neither
# is_horse nor horse_id (the harness does, to prove horses are among them).
#
# LIGHTNING_P13_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P13_PORT:-55564}
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
p11r=$M/20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an.sql
mine=${LIGHTNING_P13_MIGRATION:-$M/20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$p12rg" "$p12ops" "$p12lc" "$p11r" "$p12_harness" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p13-test.XXXXXX")
started=0
cleanup() {
  local pids
  pids=$(jobs -p 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true; fi
  if [ -n "${LIGHTNING_P13_KEEP:-}" ]; then echo "kept $fixture"; else rm -rf "$fixture"; fi
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w \
  -o "-k $fixture/socket -p $port -h '' -c max_connections=40 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
started=1
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres)
Q() { "${PSQL[@]}" -At -c "$1"; }

# THE PHASE 12 OPERATOR HARNESS'S GROUND, read from it.
awk '/^cat > "\$fixture\/ground.sql" <<.ASSERT.$/{f=1;next} f&&/^ASSERT$/{exit} f' "$p12_harness" > "$fixture/ground.sql"
awk '/^cat > "\$fixture\/ground12.sql" <<.ASSERT.$/{f=1;next} f&&/^ASSERT$/{exit} f' "$p12_harness" > "$fixture/ground12.sql"
grep -q 'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon' "$fixture/ground.sql" \
  && grep -q 'CREATE FUNCTION harness.lc' "$fixture/ground.sql" \
  && grep -q 'CREATE FUNCTION harness.arrive' "$fixture/ground.sql" \
  && grep -q 'CREATE OR REPLACE FUNCTION cron.schedule' "$fixture/ground12.sql" \
  && grep -q 'CREATE FUNCTION harness.door' "$fixture/ground12.sql" \
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
  gen_proofs "$phase" p11r "$p11r"
}

# ===========================================================================
# THIS HARNESS'S GROUND.
# ===========================================================================
cat > "$fixture/p13ground.sql" <<'ASSERT'
-- PRODUCTION'S CONTROL GATE (fixture boundary), verbatim from
-- pg_get_functiondef on PokerIQ-Production 2026-10-09, and the column it reads.
ALTER TABLE public.club_members ADD COLUMN IF NOT EXISTS is_active boolean;
CREATE OR REPLACE FUNCTION public.fn_ca_is_club_control(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.club_members m
      WHERE m.club_id = p_club_id
        AND m.user_id = p_user_id
        AND COALESCE(m.is_active, true)
        AND COALESCE(m.status, 'active') IN ('active', 'approved')
        AND m.role IN ('owner', 'co_owner', 'admin')
    )
    OR EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = p_user_id)
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_ca_is_club_control(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_club_control(uuid, uuid) TO authenticated, service_role;
-- A co-owner, beside the Phase 12 harness's owner, admin, platform admin,
-- member, banned admin and the other club's owner.
INSERT INTO harness.who VALUES ('coowner', gen_random_uuid());
INSERT INTO public.profiles (id, username) SELECT id, k FROM harness.who WHERE k = 'coowner';
INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance, joined_at, updated_at)
SELECT 'cb000000-0000-0000-0000-000000000001', id, 'co_owner', 'active', 0, now(), now() FROM harness.who WHERE k = 'coowner';
-- PRODUCTION'S MIGRATION LEDGER (fixture boundary): the schema and table the
-- readiness door reads, holding every Lightning version this chain applied.
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text);
INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT v, 'lightning' FROM unnest(ARRAY[
  '20260920172736', '20260920234647', '20260920235343', '20260921025504', '20260921025523',
  '20260921044045', '20260921064717', '20260921142954', '20260921151618', '20260925204249',
  '20260925215731', '20260926023047', '20260926072527', '20260926072551', '20260926072615',
  '20260926072638', '20260926080332', '20261001154813', '20261001201216', '20261001222856',
  '20261007212735', '20261007222717', '20261008043021', '20261008050805', '20261008111425',
  '20261008142857', '20261008161509', '20261009143757', '20261009144343', '20261009151825',
  '20261009181945', '20261009235505']) v
ON CONFLICT DO NOTHING;
CREATE TABLE harness.p13 (k text PRIMARY KEY, game uuid, a uuid, b uuid, c uuid, j jsonb);
CREATE TABLE harness.p13_fn (fn text PRIMARY KEY, md5 text NOT NULL);
-- THE CONTROL DOOR AS A NAMED CALLER (harness.door: the claims PostgREST
-- sets and the role it runs as); a fresh request id unless one is given.
CREATE FUNCTION harness.ctl(p_k text, p_game uuid, p_action text, p_args jsonb DEFAULT '{}'::jsonb,
                            p_reason text DEFAULT 'harness operator test', p_rid uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN harness.door(p_k, format('SELECT public.fn_lightning_operator_control(%L::uuid, %L, %L, %L::jsonb)',
    p_game, p_action, p_reason,
    coalesce(p_args, '{}'::jsonb) || jsonb_build_object('request_id', coalesce(p_rid, gen_random_uuid()))));
END $f$;
-- AN ANSWER THAT MUST BE ok.
CREATE FUNCTION harness.must(p jsonb, p_label text) RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  IF (p ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL %: the door refused: %', p_label, p;
  END IF;
  RETURN p;
END $f$;
-- AN ANSWER THAT MUST BE THIS REFUSAL.
CREATE FUNCTION harness.refused(p jsonb, p_code text, p_label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF (p ->> 'ok')::boolean IS DISTINCT FROM false OR p ->> 'code' IS DISTINCT FROM p_code THEN
    RAISE EXCEPTION 'FAIL %: expected % and got %', p_label, p_code, p;
  END IF;
END $f$;
CREATE FUNCTION harness.already(p jsonb, p_label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF (p ->> 'ok')::boolean IS DISTINCT FROM true OR p ->> 'code' IS DISTINCT FROM 'ALREADY'
     OR (p ->> 'idempotent')::boolean IS DISTINCT FROM true OR p -> 'event_id' <> 'null'::jsonb
     OR p -> 'before' IS DISTINCT FROM p -> 'after' THEN
    RAISE EXCEPTION 'FAIL %: expected ALREADY and got %', p_label, p;
  END IF;
END $f$;
-- A HAND FORMED AND DEALT (dealing), or formed and left (reserved).
CREATE FUNCTION harness.dealt(p_game uuid, p_players uuid[]) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE r jsonb;
BEGIN
  r := harness.form(p_game, p_players);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  PERFORM harness.deal((r ->> 'instance_id')::uuid);
  RETURN (r ->> 'hand_id')::uuid;
END $f$;
CREATE FUNCTION harness.formed(p_game uuid, p_players uuid[]) RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (harness.form(p_game, p_players) ->> 'instance_id')::uuid;
END $f$;
-- A DEALT HAND SETTLED: p_winner takes 2 from every other player.
-- p_folder (optional) made a LIGHTNING FOLD with nothing committed.
CREATE FUNCTION harness.finish(p_game uuid, p_hand uuid, p_winner uuid, p_folder uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_spec jsonb := '{}'::jsonb; p record; n integer; r jsonb;
BEGIN
  SELECT count(*)::integer INTO n FROM public.lightning_hand_player hp
   WHERE hp.hand_id = p_hand AND hp.player_id IS DISTINCT FROM p_folder;
  FOR p IN SELECT hp.player_id FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand LOOP
    v_spec := v_spec || jsonb_build_object(p.player_id::text, CASE
      WHEN p.player_id = p_folder THEN jsonb_build_object('d', 0, 'c', 0, 'f', 'fast')
      WHEN p.player_id = p_winner THEN jsonb_build_object('d', 2 * (n - 1), 'c', 2, 's', true)
      ELSE jsonb_build_object('d', -2, 'c', 2) END);
  END LOOP;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  r := harness.settle(p_hand, gen_random_uuid(), harness.results(p_hand, v_spec), 0, 0,
         jsonb_build_object('pot_size', 2 * n, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', p_winner, 'amount', 1, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the settlement refused: %', r; END IF;
  RETURN r;
END $f$;
-- The players of a hand, and the state of an instance.
CREATE FUNCTION harness.hand_players(p_hand uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT array_agg(hp.player_id ORDER BY hp.seat) FROM public.lightning_hand_player hp WHERE hp.hand_id = p_hand;
$f$;
CREATE FUNCTION harness.istate(p_instance uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT state FROM public.lightning_instance WHERE id = p_instance;
$f$;
CREATE FUNCTION harness.hstate(p_hand uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT i.state FROM public.lightning_instance i JOIN public.lightning_hand h ON h.lightning_instance_id = i.id
   WHERE h.hand_id = p_hand;
$f$;
-- Every live seat's stack of a Cluster, by seat id.
CREATE FUNCTION harness.stacks(p_game uuid) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT coalesce(jsonb_object_agg(ts.id::text, ts.stack), '{}'::jsonb)
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = p_game AND ts.left_at IS NULL;
$f$;
-- The open pool sessions of a Cluster, humans and horses.
CREATE FUNCTION harness.open_sessions(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL;
$f$;
-- The drain steps a Cluster recorded for one drain.
CREATE FUNCTION harness.steps(p_game uuid, p_drain uuid) RETURNS integer[] LANGUAGE sql STABLE AS $f$
  SELECT coalesce(array_agg((e.payload ->> 'step')::integer ORDER BY (e.payload ->> 'step')::integer), ARRAY[]::integer[])
    FROM public.cash_cluster_events e
   WHERE e.game_id = p_game AND e.kind = 'lightning_drain_step' AND e.payload ->> 'drain_id' = p_drain::text;
$f$;
-- PL/pgSQL, because the table it reads does not exist until the file runs.
CREATE FUNCTION harness.drain_row(p_game uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN (SELECT to_jsonb(d) FROM public.lightning_cluster_drain d WHERE d.cluster_id = p_game ORDER BY d.requested_at DESC LIMIT 1);
END $f$;
-- THE MONEY OF A CLUSTER: every seat (stack and departure), every cash
-- session (baseline and close) and the blind ledger's debts - fx9's rows
-- without the pool sessions, whose exit stamps a reversion is supposed to write.
CREATE FUNCTION harness.money(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT md5(coalesce(string_agg(r, '|' ORDER BY r), '')) FROM public.fx9_money_rows(p_game) r WHERE r NOT LIKE 'lps:%';
$f$;
-- A shadow metric window, every component measured.
CREATE FUNCTION harness.p13_metrics() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('passes', 10, 'formation_success_rate', 1, 'failure_rate', 0,
                            'wait_ms', jsonb_build_object('n', 5, 'p50', 100, 'p95', 200),
                            'bb_fairness', jsonb_build_object('n', 10, 'order_violations', 0),
                            'opponent_diversity', jsonb_build_object('repeat_pair_rate', 0.1),
                            'instance_occupancy', jsonb_build_object('utilization', 0.9));
$f$;
-- The legality code of every open pool player of a Cluster, as a set.
CREATE FUNCTION harness.codes(p_game uuid) RETURNS text[] LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (SELECT array_agg(DISTINCT coalesce(l.reason_code, 'LEGAL') ORDER BY coalesce(l.reason_code, 'LEGAL'))
            FROM public.fn_lightning_player_legality(p_game, clock_timestamp(), NULL::uuid[], NULL) l);
END $f$;
\echo '  ok  P00 THE GROUND  production''s control gate (fn_ca_is_club_control) verbatim, a co-owner beside the Phase 12 callers, the migration ledger stand-in and the harness readers are installed over the real chain through 20261009181945'
ASSERT

cat > "$fixture/before.sql" <<'ASSERT'
-- P01 THE FILE IS ABSENT, AND THE BODIES IT SUBSTITUTES ARE CAPTURED ---------
DO $$
BEGIN
  IF to_regclass('public.lightning_cluster_drain') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_operator_control(uuid,text,text,jsonb)') IS NOT NULL
     OR public.fn_lightning_config(NULL) ? 'drain_timeout_ms' THEN
    RAISE EXCEPTION 'FAIL P01: an object of the file exists before it is applied';
  END IF;
  IF to_regclass('public.lightning_integrity_engine_window') IS NULL THEN
    RAISE EXCEPTION 'FAIL P01: 20261009181945 is not installed under it';
  END IF;
  INSERT INTO harness.p13_fn
  SELECT p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.oid IN (
      'public.fn_lightning_config(uuid)'::regprocedure,
      'public.fn_cash_cluster_lightning_state(uuid)'::regprocedure,
      'public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure,
      'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure,
      'public.fn_lightning_pool_status(uuid)'::regprocedure,
      'public.fn_lightning_reconnect_state(uuid)'::regprocedure,
      'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure,
      'public.fn_cash_cluster_commit_must_move(uuid,uuid)'::regprocedure,
      'public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure,
      'public.fn_cash_clusters_tick_all(jsonb)'::regprocedure,
      'public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone)'::regprocedure,
      'public.fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
      'public.fn_lightning_operator_session_trail(uuid,uuid)'::regprocedure);
  IF (SELECT count(*) FROM harness.p13_fn) <> 13 THEN
    RAISE EXCEPTION 'FAIL P01: not every substituted body was captured';
  END IF;
END $$;
\echo '  ok  P01 THE FILE IS ABSENT  no table, door or config key of the file exists before it; the thirteen bodies it substitutes are captured'
ASSERT

cat > "$fixture/after.sql" <<'ASSERT'
-- P02 NOTHING FALSIFIED ----------------------------------------------------------------------
DO $$
DECLARE v_fallen text;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ') INTO v_fallen
    FROM harness.lp8 b JOIN harness.lp8 a ON a.phase = 'after' AND a.src = b.src AND a.n = b.n
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  IF v_fallen IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P02: the file falsified predecessor proofs: %', v_fallen;
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND ok) < 150 THEN
    RAISE EXCEPTION 'FAIL P02: too few predecessor proofs held to prove anything';
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'after' AND ok AND src = 'p11r' AND n IN (10, 11)) <> 2 THEN
    RAISE EXCEPTION 'FAIL P02: the anti-manipulation pin and the telemetry-store proof of 20261009181945 do not hold after the file';
  END IF;
END $$;
\echo '  ok  P02 NOTHING FALSIFIED  every predecessor live proof (Phases 2 → 12 and the Phase 11 remediation, the anti-manipulation pin and the telemetry-store proof among them) that held before the file still holds after it'

-- P03 GRANTS, DEFINERS AND CLOSED TABLES -------------------------------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  IF NOT (SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                          AND array_to_string(p.proconfig, ',') ~ 'search_path=')
            FROM pg_proc p WHERE p.oid IN ('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure,
                                           'public.fn_lightning_rollout_readiness(uuid)'::regprocedure)) THEN
    RAISE EXCEPTION 'FAIL P03: a browser door is not definer + authenticated + service_role and never anon';
  END IF;
  r := harness.door('anon', format('SELECT public.fn_lightning_operator_control(%L::uuid, %L, %L, %L::jsonb)',
         gen_random_uuid(), 'pause', 'anon trying', jsonb_build_object('request_id', gen_random_uuid())));
  IF r ->> 'error' IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'FAIL P03: anon reached the control door: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['lightning_operator_request', 'lightning_cluster_control', 'lightning_cluster_drain']) t
              CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) ro
              CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) pr
             WHERE has_table_privilege(ro, ('public.' || t)::regclass, pr))
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.lightning_operator_request'::regclass,
                  'public.lightning_cluster_control'::regclass, 'public.lightning_cluster_drain'::regclass) AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'FAIL P03: a new table is open to a role or has RLS off';
  END IF;
  IF (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
       AND table_name LIKE 'lightning\_%' AND grantee = 'service_role' AND privilege_type = 'SELECT') <> 7 THEN
    RAISE EXCEPTION 'FAIL P03: the Phase 2 census of seven Lightning tables granted to the service moved';
  END IF;
  BEGIN
    TRUNCATE public.lightning_cluster_drain;
    RAISE EXCEPTION 'FAIL P03: TRUNCATE of the drain ledger was not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
\echo '  ok  P03 GRANTS  the control and readiness doors are SECURITY DEFINER, search_path pinned, authenticated and service_role, never anon (anon is refused 42501); the three new tables are RLS on with no privilege for any role, the seven-tables census holds, the drain ledger refuses TRUNCATE'

-- P04 THE GATE AND THE REFUSALS --------------------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; k text;
BEGIN
  PERFORM setseed(0.131);
  v_g := harness.lc('P13 gate');
  INSERT INTO harness.p13 (k, game) VALUES ('gate', v_g);
  FOREACH k IN ARRAY ARRAY['stranger', 'member', 'banned', 'other'] LOOP
    PERFORM harness.refused(harness.ctl(k, v_g, 'resume'), 'NOT_AUTHORIZED', 'P04 ' || k);
  END LOOP;
  PERFORM harness.refused(harness.ctl('stranger', gen_random_uuid(), 'resume'), 'NOT_AUTHORIZED', 'P04 unknown as stranger');
  PERFORM harness.refused(harness.ctl('service', gen_random_uuid(), 'resume'), 'CLUSTER_NOT_FOUND', 'P04 unknown as service');
  FOREACH k IN ARRAY ARRAY['owner', 'coowner', 'admin', 'padmin', 'service'] LOOP
    PERFORM harness.already(harness.ctl(k, v_g, 'resume'), 'P04 ' || k || ' resume (not paused)');
  END LOOP;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'explode'), 'INVALID_ACTION', 'P04 invalid action');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'pause', '{}', ''), 'REASON_REQUIRED', 'P04 empty reason');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'pause', '{}', 'ab'), 'REASON_REQUIRED', 'P04 short reason');
  r := harness.door('admin', format('SELECT public.fn_lightning_operator_control(%L::uuid, %L, %L, %L::jsonb)',
         v_g, 'pause', 'no request id', '{}'));
  PERFORM harness.refused(r, 'INVALID_ARGS', 'P04 no request id');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'unfreeze'), 'NOT_AUTHORIZED', 'P04 unfreeze by club control');
  PERFORM harness.refused(harness.ctl('owner', v_g, 'unfreeze'), 'NOT_AUTHORIZED', 'P04 unfreeze by the owner');
  IF harness.evn(v_g, 'operator_resume') <> 0 THEN
    RAISE EXCEPTION 'FAIL P04: a no-op wrote an operator event';
  END IF;
END $$;
\echo '  ok  P04 THE GATE  a stranger, a member, a banned admin and another club''s owner are NOT_AUTHORIZED (and learn nothing of an unknown Cluster); the owner, a co-owner, an admin, a platform admin and the service pass; INVALID_ACTION, REASON_REQUIRED, INVALID_ARGS without a request id; unfreeze is the platform''s alone; a no-op is ALREADY and writes no event'

-- P05 IDEMPOTENCY ----------------------------------------------------------------------------
DO $$
DECLARE v_g uuid := (SELECT game FROM harness.p13 WHERE k = 'gate'); v_rid uuid := gen_random_uuid(); a jsonb; b jsonb; n integer;
BEGIN
  a := harness.must(harness.ctl('admin', v_g, 'disable_joins', '{}', 'idempotency first', v_rid), 'P05 first');
  n := harness.evn(v_g, 'operator_disable_joins');
  b := harness.must(harness.ctl('owner', v_g, 'disable_joins', '{}', 'idempotency again', v_rid), 'P05 again');
  IF (b ->> 'idempotent')::boolean IS DISTINCT FROM true OR (b ->> 'replayed')::boolean IS DISTINCT FROM true
     OR b -> 'event_id' IS DISTINCT FROM a -> 'event_id' OR b -> 'after' IS DISTINCT FROM a -> 'after'
     OR harness.evn(v_g, 'operator_disable_joins') <> n OR n <> 1 THEN
    RAISE EXCEPTION 'FAIL P05: a repeated request was not the first answer: % / %', a, b;
  END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'enable_joins', '{}', 'same id other action', v_rid), 'INVALID_ARGS', 'P05 reused id');
  PERFORM harness.already(harness.ctl('admin', v_g, 'disable_joins'), 'P05 disable again (fresh id)');
  PERFORM harness.must(harness.ctl('admin', v_g, 'enable_joins'), 'P05 enable');
  IF (SELECT count(*) FROM public.lightning_operator_request r WHERE r.cluster_id = v_g) < 3 THEN
    RAISE EXCEPTION 'FAIL P05: answers after the lock were not kept';
  END IF;
END $$;
\echo '  ok  P05 IDEMPOTENCY  the same request id answers the first answer (idempotent, replayed, the same event id) and writes nothing, even from another operator; reused for another action it is INVALID_ARGS; a fresh request for a state already in place is ALREADY'

-- P06 JOINS DISABLED: NEWCOMERS ARE REFUSED, SEATED PLAYERS PLAY ON --------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_h uuid := gen_random_uuid(); v_z uuid := gen_random_uuid(); v_idle uuid[]; v_hand uuid;
        v_ps record; v_open integer;
BEGIN
  PERFORM setseed(0.132);
  v_g := harness.lc('P13 joins');
  r := harness.must(harness.ctl('admin', v_g, 'disable_joins', '{}', 'closing the pool for a test'), 'P06 disable');
  IF (r #>> '{before,joins_enabled}')::boolean IS DISTINCT FROM true OR (r #>> '{after,joins_enabled}')::boolean IS DISTINCT FROM false
     OR (harness.evlast(v_g, 'operator_disable_joins') ->> 'reason') <> 'closing the pool for a test' THEN
    RAISE EXCEPTION 'FAIL P06: the answer or the event does not carry the change: %', r;
  END IF;
  IF (public.fn_lightning_config(v_g) ->> 'lightning_joins_enabled')::boolean IS DISTINCT FROM false
     OR public.fn_lightning_config(v_g) -> 'lightning_joins_disabled_at' = 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL P06: the configuration does not say joins are closed';
  END IF;
  r := harness.door('member', format('SELECT public.fn_lightning_pool_status(%L::uuid)', v_g));
  IF (r ->> 'joinable')::boolean IS DISTINCT FROM false OR (r ->> 'joins_enabled')::boolean IS DISTINCT FROM false
     OR (r ->> 'draining')::boolean IS DISTINCT FROM false OR r ? 'cluster_mode' THEN
    RAISE EXCEPTION 'FAIL P06: pool status does not say closed: %', r;
  END IF;
  IF (public.fn_cash_cluster_lightning_state(v_g) ->> 'joins_enabled')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL P06: the lobby''s lightning key does not say closed';
  END IF;
  v_open := harness.open_sessions(v_g);
  -- A HUMAN AND A HORSE ARRIVE AT THE FEEDER: the seat is theirs, the pool is not.
  PERFORM harness.arrive(v_g, v_h, false);
  PERFORM harness.arrive(v_g, v_z, true);
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id IN (v_h, v_z))
     OR harness.open_sessions(v_g) <> v_open THEN
    RAISE EXCEPTION 'FAIL P06: a newcomer entered a closed pool';
  END IF;
  -- THE SEATED PLAY ON: a whole hand of idle players, humans and horses.
  v_idle := harness.idle(v_g, false, 4) || harness.idle(v_g, true, 2);
  IF harness.codes(v_g) IS DISTINCT FROM ARRAY['LEGAL'] THEN
    RAISE EXCEPTION 'FAIL P06: a seated player is held while joins are closed: %', harness.codes(v_g);
  END IF;
  v_hand := harness.dealt(v_g, v_idle);
  PERFORM harness.finish(v_g, v_hand, v_idle[1]);
  -- A SESSION THAT ENTERED AFTER THE CLOSE IS HELD (time travel: the close is
  -- stamped before one idle player's entry).
  v_idle := harness.idle(v_g, true, 1);
  SELECT * INTO v_ps FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_idle[1] AND ps.exited_at IS NULL;
  PERFORM harness.cfg(v_g, jsonb_build_object('lightning_joins_disabled_at', to_jsonb(v_ps.entered_at - interval '1 second')));
  IF harness.reason(v_g, v_idle[1], NULL) IS DISTINCT FROM 'LIGHTNING_JOINS_DISABLED'
     OR harness.detail(v_g, v_idle[1], NULL) ->> 'joins_disabled_at' IS NULL THEN
    RAISE EXCEPTION 'FAIL P06: a session that entered after the close is not held: %', harness.reason(v_g, v_idle[1], NULL);
  END IF;
  -- ENABLED AGAIN: the human and the horse who sat down are in the pool now.
  r := harness.must(harness.ctl('owner', v_g, 'enable_joins', '{}', 'opening the pool again'), 'P06 enable');
  IF (r #>> '{detail,pool_sessions_entered}')::integer <> 2
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_h AND ps.exited_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_z AND ps.exited_at IS NULL)
     OR public.fn_lightning_config(v_g) -> 'lightning_joins_disabled_at' <> 'null'::jsonb
     OR harness.reason(v_g, v_idle[1], NULL) <> 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL P06: enable_joins did not admit the newcomers: %', r;
  END IF;
  r := harness.door('member', format('SELECT public.fn_lightning_pool_status(%L::uuid)', v_g));
  IF (r ->> 'joinable')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL P06: not joinable again: %', r; END IF;
END $$;
\echo '  ok  P06 JOINS  disable_joins closes the pool: the configuration, pool status (joinable false, joins_enabled false), the lobby''s lightning key; a human and a horse who sit down get no pool session; the seated (humans and horses) stay legal and play a whole hand; a session entering after the close is LIGHTNING_JOINS_DISABLED; enable_joins enters the human and the horse and the pool is joinable again'

-- P07 PAUSE AND RESUME FROM LIGHTNING ------------------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_a uuid[]; v_b uuid[]; v_hand uuid; v_inst uuid; v_epoch integer; v_new uuid := gen_random_uuid();
        v_md5 text;
BEGIN
  PERFORM setseed(0.133);
  v_g := harness.lc('P13 pause');
  v_epoch := harness.epoch(v_g);
  v_a := harness.idle(v_g, false, 4) || harness.idle(v_g, true, 2);
  v_hand := harness.dealt(v_g, v_a);
  v_b := harness.idle(v_g, false, 3, v_a) || harness.idle(v_g, true, 1, v_a);
  v_inst := harness.formed(v_g, v_b);
  r := harness.must(harness.ctl('coowner', v_g, 'pause', '{}', 'pausing for maintenance'), 'P07 pause');
  IF harness.mode(v_g) <> 'paused' OR (r #>> '{detail,instances_voided}')::integer <> 1
     OR (r #>> '{detail,paused_from}') <> 'lightning' OR (r #>> '{after,paused}')::boolean IS DISTINCT FROM true
     OR (r #>> '{after,paused_from}') <> 'lightning' OR harness.istate(v_inst) <> 'abandoned'
     OR harness.hstate(v_hand) <> 'dealing' THEN
    RAISE EXCEPTION 'FAIL P07: pause did not hold new hands and keep the live one: % / % / %', r, harness.istate(v_inst), harness.hstate(v_hand);
  END IF;
  v_md5 := harness.money(v_g);
  IF harness.codes(v_g) IS DISTINCT FROM ARRAY['CLUSTER_FROZEN'] THEN
    RAISE EXCEPTION 'FAIL P07: a paused pool still matches: %', harness.codes(v_g);
  END IF;
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF r ->> 'action' <> 'mode_not_driven' OR EXISTS (SELECT 1 FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g AND c.status = 'pending') THEN
    RAISE EXCEPTION 'FAIL P07: the drive converted a paused Cluster: %', r;
  END IF;
  IF public.fxr_try(format('SELECT harness.formed(%L::uuid, %L::uuid[])', v_g, v_b)) IS NULL THEN
    RAISE EXCEPTION 'FAIL P07: a hand formed in a paused pool';
  END IF;
  IF harness.money(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL P07: money moved while paused';
  END IF;
  PERFORM harness.arrive(v_g, v_new, false);
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_new) THEN
    RAISE EXCEPTION 'FAIL P07: a newcomer entered a paused pool';
  END IF;
  -- THE LIVE HAND PLAYS OUT AND SETTLES.
  PERFORM harness.finish(v_g, v_hand, v_a[2]);
  IF harness.hstate(v_hand) <> 'complete' THEN RAISE EXCEPTION 'FAIL P07: the live hand did not settle in a pause'; END IF;
  PERFORM harness.already(harness.ctl('admin', v_g, 'pause'), 'P07 pause again');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'drain', '{}', 'x'), 'REASON_REQUIRED', 'P07 drain needs a reason');
  v_md5 := harness.money(v_g);
  r := harness.must(harness.ctl('admin', v_g, 'resume', '{}', 'maintenance finished'), 'P07 resume');
  IF harness.mode(v_g) <> 'lightning' OR harness.epoch(v_g) <> v_epoch OR r #>> '{detail,resumed_to}' <> 'lightning'
     OR (r #>> '{detail,pool_sessions_entered}')::integer <> 1
     OR NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_new AND ps.exited_at IS NULL)
     OR harness.codes(v_g) IS DISTINCT FROM ARRAY['LEGAL'] OR harness.money(v_g) IS DISTINCT FROM v_md5 THEN
    RAISE EXCEPTION 'FAIL P07: resume did not return exactly to lightning: % / %', r, harness.codes(v_g);
  END IF;
  IF harness.evn(v_g, 'operator_pause') <> 1 OR harness.evn(v_g, 'operator_resume') <> 1 THEN
    RAISE EXCEPTION 'FAIL P07: the pause and resume events';
  END IF;
  PERFORM harness.finish(v_g, harness.dealt(v_g, v_b), v_b[1]);
END $$;
\echo '  ok  P07 PAUSE FROM LIGHTNING  pause voids the formation not yet dealt and keeps the dealing hand, holds every player (CLUSTER_FROZEN), converts nothing, forms nothing, admits no newcomer and moves no chip; the live hand settles; resume returns to lightning at the same epoch, enters the newcomer, and the pool deals again'

-- P08 PAUSE FROM MUST-MOVE HOLDS THE CONVERSION; BUSY WHILE CONVERTING ----------------------------
DO $$
DECLARE v_g uuid; v_p uuid; r jsonb;
BEGIN
  PERFORM setseed(0.134);
  v_g := harness.c8('P13 mm pause', 6, 5, 1, 5, 1);
  r := harness.must(harness.ctl('admin', v_g, 'pause', '{}', 'hold the conversion'), 'P08 pause must_move');
  IF harness.mode(v_g) <> 'paused' OR r #>> '{detail,paused_from}' <> 'must_move' THEN
    RAISE EXCEPTION 'FAIL P08: %', r;
  END IF;
  PERFORM harness.to(v_g, 18);
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'paused' THEN RAISE EXCEPTION 'FAIL P08: a paused must-move Cluster converted'; END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'freeze', '{}', 'freeze must-move'), 'INVALID_ACTION', 'P08 freeze a must-move pause');
  r := harness.must(harness.ctl('admin', v_g, 'resume', '{}', 'let it convert'), 'P08 resume');
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL P08: resume to must_move: %', r; END IF;
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'pending_on' THEN RAISE EXCEPTION 'FAIL P08: the held conversion did not begin after resume: %', harness.mode(v_g); END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'pause', '{}', 'race the conversion'), 'CLUSTER_BUSY', 'P08 pause pending_on');
  INSERT INTO harness.p13 (k, game) VALUES ('pending_on', v_g);
END $$;
\echo '  ok  P08 PAUSE FROM MUST-MOVE  a paused must-move Cluster at its ON population does not convert; it cannot be frozen (not a Lightning mode); resume returns to must_move and the conversion begins; pause during pending_on is CLUSTER_BUSY'

-- P09 THE EMERGENCY DRAIN FROM LIGHTNING, HANDS MID-DEAL -------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_a uuid[]; v_b uuid[]; v_hand uuid; v_inst uuid; v_epoch integer; v_drain uuid;
        v_before jsonb; v_after jsonb; v_settled_md5 text; v_open integer; v_horses integer; v_humans integer; k text; v_bad integer;
BEGIN
  PERFORM setseed(0.135);
  v_g := harness.lc('P13 drain');
  v_epoch := harness.epoch(v_g);
  v_a := harness.idle(v_g, false, 4) || harness.idle(v_g, true, 2);
  v_hand := harness.dealt(v_g, v_a);
  -- A LIGHTNING FOLD in the live hand, through the real fold door.
  r := public.fn_lightning_fast_fold(v_hand, v_a[3], gen_random_uuid(), 'fast', 0);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the fold refused: %', r; END IF;
  v_b := harness.idle(v_g, false, 3, v_a) || harness.idle(v_g, true, 1, v_a);
  v_inst := harness.formed(v_g, v_b);
  v_open := harness.open_sessions(v_g);
  v_before := harness.stacks(v_g);
  r := harness.must(harness.ctl('admin', v_g, 'drain', '{}', 'emergency drain test'), 'P09 drain');
  v_drain := (r #>> '{detail,drain_id}')::uuid;
  IF harness.mode(v_g) <> 'draining' OR (r #>> '{after,lightning_enabled}')::boolean IS DISTINCT FROM false
     OR r #>> '{after,drain,phase}' <> 'finishing' OR (r #>> '{detail,hands_in_flight}')::integer <> 1
     OR (r #>> '{detail,instances_awaiting_deal}')::integer <> 1 OR harness.steps(v_g, v_drain) <> ARRAY[1, 2, 3]
     OR harness.evn(v_g, 'operator_drain') <> 1 THEN
    RAISE EXCEPTION 'FAIL P09: the drain did not begin as specified: % / %', r, harness.steps(v_g, v_drain);
  END IF;
  r := harness.door('member', format('SELECT public.fn_lightning_pool_status(%L::uuid)', v_g));
  IF (r ->> 'joinable')::boolean OR (r ->> 'draining')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P09: pool status during the drain: %', r;
  END IF;
  IF (public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{drain,hands_remaining}')::integer <> 1
     OR (public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{drain,instances_remaining}')::integer <> 1
     OR (public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{drain,sessions_remaining}')::integer <> v_open THEN
    RAISE EXCEPTION 'FAIL P09: the dashboard row does not show the drain''s progress: %', public.fn_lightning_operator_cluster_row(v_g, now()) -> 'drain';
  END IF;
  -- WAITING: the dealing hand and the formation not yet dealt.
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF (r #>> '{drain,waiting}')::boolean IS DISTINCT FROM true OR (r #>> '{drain,hands_remaining}')::integer <> 1 THEN
    RAISE EXCEPTION 'FAIL P09: the drain did not wait: %', r;
  END IF;
  -- STEP 2: NO NEW HAND. The formation that never dealt is void at begin_dealing.
  r := public.fn_lightning_instance_begin_dealing(v_inst);
  IF (r ->> 'dealing')::boolean OR r ->> 'reason' <> 'cluster_is_not_lightning' OR harness.istate(v_inst) <> 'abandoned' THEN
    RAISE EXCEPTION 'FAIL P09: a formation began dealing in a drain: %', r;
  END IF;
  IF public.fxr_try(format('SELECT harness.formed(%L::uuid, %L::uuid[])', v_g, v_b)) IS NULL THEN
    RAISE EXCEPTION 'FAIL P09: a hand formed in a drain';
  END IF;
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'draining' OR harness.hstate(v_hand) <> 'dealing' THEN
    RAISE EXCEPTION 'FAIL P09: the drain cut the dealing hand or moved on: % / %', r, harness.hstate(v_hand);
  END IF;
  -- STEPS 3 AND 4: THE HAND FINISHES AND SETTLES.
  PERFORM harness.finish(v_g, v_hand, v_a[1], v_a[3]);
  v_settled_md5 := harness.money(v_g);
  v_after := harness.stacks(v_g);
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR r #>> '{drain,outcome}' <> 'drained' THEN
    RAISE EXCEPTION 'FAIL P09: the drain did not end through the reversion: %', r;
  END IF;
  -- STEP 7: EVERY STACK TO THE CENT. The hand settled during the drain moved
  -- exactly its nets; the reversion moved nothing.
  SELECT count(*) INTO v_bad FROM jsonb_each_text(v_before) b
   WHERE (v_after ->> b.key)::numeric IS DISTINCT FROM b.value::numeric
         + coalesce((SELECT hp.net_result FROM public.lightning_hand_player hp
                      JOIN public.lightning_pool_session ps ON ps.player_id = hp.player_id AND ps.cluster_id = v_g
                     WHERE hp.hand_id = v_hand AND ps.anchor_seat_id::text = b.key LIMIT 1), 0);
  IF v_bad <> 0 OR harness.money(v_g) IS DISTINCT FROM v_settled_md5
     OR harness.stacks(v_g) IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'FAIL P09: a stack moved other than by the settled hand (% seats)', v_bad;
  END IF;
  -- STEP 5: EVERY PLAYER RELEASED TO THE SEAT THEY NEVER LEFT.
  SELECT count(*) FILTER (WHERE ts.horse_id IS NOT NULL), count(*) FILTER (WHERE ts.horse_id IS NULL)
    INTO v_horses, v_humans
    FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = v_g AND ps.exit_reason = 'lightning_drained' AND ts.left_at IS NULL AND ts.user_id = ps.player_id;
  IF harness.open_sessions(v_g) <> 0 OR v_horses + v_humans <> v_open OR v_horses = 0 OR v_humans = 0
     OR harness.evlast(v_g, 'pool_player_left') ->> 'reason' <> 'lightning_drained' THEN
    RAISE EXCEPTION 'FAIL P09: not every player was released to their seat: % horses, % humans of %', v_horses, v_humans, v_open;
  END IF;
  -- STEP 6: MUST-MOVE REBUILT AT A NEW EPOCH, THE HALTS LIFTED, THE FLAG OFF.
  IF harness.epoch(v_g) <> v_epoch + 1
     OR EXISTS (SELECT 1 FROM public.tables tb WHERE tb.cluster_id = v_g AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on'))
     OR (SELECT lightning_enabled FROM public.cash_games WHERE id = v_g)
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g AND c.status = 'committed'
                     AND c.from_mode = 'draining' AND c.to_mode = 'must_move')
     OR (harness.evlast(v_g, 'lightning_off') ->> 'drained')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P09: MUST-MOVE was not rebuilt through the reversion';
  END IF;
  -- STEP 8: THE AUDIT TRAIL, one event per step, all eight.
  IF harness.steps(v_g, v_drain) <> ARRAY[1, 2, 3, 4, 5, 6, 7, 8]
     OR (SELECT (e.payload ->> 'digest_asserted')::boolean FROM public.cash_cluster_events e
          WHERE e.game_id = v_g AND e.kind = 'lightning_drain_step' AND (e.payload ->> 'step')::integer = 7) IS DISTINCT FROM true
     OR (SELECT (e.payload ->> 'pool_sessions_drained')::integer FROM public.cash_cluster_events e
          WHERE e.game_id = v_g AND e.kind = 'lightning_drain_step' AND (e.payload ->> 'step')::integer = 5) <> v_open
     OR (SELECT (e.payload ->> 'hands_settled')::integer FROM public.cash_cluster_events e
          WHERE e.game_id = v_g AND e.kind = 'lightning_drain_step' AND (e.payload ->> 'step')::integer = 4) <> 1
     OR (SELECT (e.payload ->> 'hands_void_never_dealt')::integer FROM public.cash_cluster_events e
          WHERE e.game_id = v_g AND e.kind = 'lightning_drain_step' AND (e.payload ->> 'step')::integer = 4) <> 1
     OR harness.drain_row(v_g) ->> 'outcome' <> 'drained' OR harness.drain_row(v_g) ->> 'phase' <> 'complete' THEN
    RAISE EXCEPTION 'FAIL P09: the audit trail: % / %', harness.steps(v_g, v_drain), harness.drain_row(v_g);
  END IF;
  -- THE OPERATOR REPLAYS IT: transitions and the session trail carry it.
  r := harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L::uuid, NULL, NULL)', v_g));
  IF (SELECT count(*) FROM jsonb_array_elements(r -> 'transitions') t(v) WHERE t.v ->> 'kind' = 'operator') < 1
     OR (SELECT count(*) FROM jsonb_array_elements(r -> 'transitions') t(v) WHERE t.v ->> 'kind' = 'drain') < 8
     OR harness.card_keys(r) <> 0 THEN
    RAISE EXCEPTION 'FAIL P09: the operator''s transitions do not carry the drain';
  END IF;
  r := harness.door('admin', format('SELECT public.fn_lightning_operator_session_trail(%L::uuid, %L::uuid)', v_g,
         harness.session(v_g, v_a[1])));
  IF (SELECT count(*) FROM jsonb_array_elements(r -> 'transitions') t(v) WHERE t.v ->> 'kind' IN ('operator', 'drain')) < 9 THEN
    RAISE EXCEPTION 'FAIL P09: the session trail does not carry the drain: %', r -> 'transitions';
  END IF;
  -- A DRAINED CLUSTER STAYS MUST-MOVE until an operator enables it again.
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FAIL P09: a drained Cluster re-converted on its own'; END IF;
  PERFORM harness.already(harness.ctl('admin', v_g, 'drain'), 'P09 drain a drained Cluster');
  PERFORM harness.must(harness.ctl('admin', v_g, 'enable_lightning', '{}', 'bring it back'), 'P09 enable again');
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) NOT IN ('pending_on', 'lightning') THEN RAISE EXCEPTION 'FAIL P09: the enabled Cluster did not begin to convert again: %', harness.mode(v_g); END IF;
END $$;
\echo '  ok  P09 EMERGENCY DRAIN  from lightning with a hand mid-deal (a LIGHTNING FOLD in it) and a formation never dealt: joins and formation stop at once (begin_dealing voids the formation, the barrier refuses), the drive waits while the hand deals and never cuts it, the hand settles, then the reversion runs (conversion draining → must_move committed): every human and horse exits lightning_drained to the seat they never left, stacks move by exactly the settled nets to the cent, the md5 holds, MUST-MOVE is rebuilt at a new epoch with the halts lifted and the flag off, all eight steps are events, the operator''s transitions and the session trail carry them; it stays must_move until enabled again, and then converts again'

-- P10 THE DRAIN'S DEADLINE ABANDONS ONLY WHAT NEVER DEALT -------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_a uuid[]; v_b uuid[]; v_hand uuid; v_inst uuid;
BEGIN
  PERFORM setseed(0.136);
  v_g := harness.lc('P13 timeout');
  v_a := harness.idle(v_g, false, 4) || harness.idle(v_g, true, 2);
  v_hand := harness.dealt(v_g, v_a);
  v_b := harness.idle(v_g, false, 3, v_a) || harness.idle(v_g, true, 1, v_a);
  v_inst := harness.formed(v_g, v_b);
  PERFORM harness.must(harness.ctl('admin', v_g, 'drain', '{}', 'deadline test'), 'P10 drain');
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF (r #>> '{drain,instances_remaining}')::integer <> 1 OR harness.istate(v_inst) <> 'reserved' THEN
    RAISE EXCEPTION 'FAIL P10: the drain abandoned before its deadline: %', r;
  END IF;
  -- TIME TRAVEL: the deadline has passed.
  UPDATE public.lightning_cluster_drain SET deadline_at = clock_timestamp() - interval '1 second'
   WHERE cluster_id = v_g AND completed_at IS NULL;
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.istate(v_inst) <> 'abandoned' OR harness.hstate(v_hand) <> 'dealing'
     OR (harness.evlast(v_g, 'lightning_drain_timeout') ->> 'instances_abandoned')::integer <> 1
     OR (r #>> '{drain,hands_remaining}')::integer <> 1 OR (r #>> '{drain,overdue}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P10: past the deadline: % / % / %', r, harness.istate(v_inst), harness.hstate(v_hand);
  END IF;
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.hstate(v_hand) <> 'dealing' OR harness.mode(v_g) <> 'draining' THEN
    RAISE EXCEPTION 'FAIL P10: a dealing hand was cut past the deadline';
  END IF;
  PERFORM harness.finish(v_g, v_hand, v_a[1]);
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR harness.hstate(v_hand) <> 'complete' OR r #>> '{drain,outcome}' <> 'drained' THEN
    RAISE EXCEPTION 'FAIL P10: the overdue drain did not end after the hand: %', r;
  END IF;
END $$;
\echo '  ok  P10 THE DEADLINE  before drain_timeout_ms the formation that never dealt is left; past it, it alone is abandoned (lightning_drain_timeout), the dealing hand is never cut and is waited for while overdue, settles, and the drain ends drained'

-- P11 THE DRAIN DURING PENDING_OFF AND PENDING_ON ----------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_a uuid[]; v_hand uuid; v_open integer; v_drain uuid; i integer;
BEGIN
  PERFORM setseed(0.137);
  v_g := harness.lc('P13 pending_off');
  PERFORM harness.cfg(v_g, '{"pending_off_dwell_ms": 0}');
  v_a := harness.idle(v_g, false, 4) || harness.idle(v_g, true, 2);
  v_hand := harness.dealt(v_g, v_a);
  PERFORM harness.to(v_g, 12);
  FOR i IN 1 .. 3 LOOP
    EXIT WHEN harness.mode(v_g) = 'pending_off';
    PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  END LOOP;
  IF harness.mode(v_g) <> 'pending_off' THEN RAISE EXCEPTION 'FIXTURE: % is not pending_off', harness.mode(v_g); END IF;
  v_open := harness.open_sessions(v_g);
  r := harness.must(harness.ctl('admin', v_g, 'drain', '{}', 'drain during the reversion'), 'P11 drain pending_off');
  v_drain := (r #>> '{detail,drain_id}')::uuid;
  IF r #>> '{detail,phase}' <> 'reverting' OR r #>> '{detail,conversion_id}' IS NULL OR harness.mode(v_g) <> 'pending_off' THEN
    RAISE EXCEPTION 'FAIL P11: %', r;
  END IF;
  PERFORM harness.to(v_g, 18);
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' THEN RAISE EXCEPTION 'FAIL P11: a disabled reversion aborted back to lightning: %', r; END IF;
  PERFORM harness.finish(v_g, v_hand, v_a[1]);
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR r #>> '{drain,outcome}' <> 'drained'
     OR (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exit_reason = 'lightning_drained') < v_open
     OR harness.steps(v_g, v_drain) <> ARRAY[1, 2, 3, 4, 5, 6, 7, 8] THEN
    RAISE EXCEPTION 'FAIL P11: the reversion in flight did not finish as the drain: % / %', r, harness.steps(v_g, v_drain);
  END IF;

  -- PENDING_ON: the conversion in flight is aborted through the existing abort.
  v_g := (SELECT game FROM harness.p13 WHERE k = 'pending_on');
  r := harness.must(harness.ctl('admin', v_g, 'drain', '{}', 'drain during the conversion'), 'P11 drain pending_on');
  v_drain := (r #>> '{detail,drain_id}')::uuid;
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF harness.mode(v_g) <> 'must_move' OR r #>> '{drain,outcome}' <> 'aborted_pending_on'
     OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g AND c.status = 'aborted' AND c.abort_reason = 'lightning_disabled')
     OR harness.steps(v_g, v_drain) <> ARRAY[1, 2, 3, 4, 5, 6, 7, 8] OR harness.open_sessions(v_g) <> 0
     OR EXISTS (SELECT 1 FROM public.tables tb WHERE tb.cluster_id = v_g AND tb.dealing_halted_reason IN ('lightning', 'lightning_pending_on')) THEN
    RAISE EXCEPTION 'FAIL P11: pending_on drain: % / %', r, harness.steps(v_g, v_drain);
  END IF;
END $$;
\echo '  ok  P11 PENDING_OFF AND PENDING_ON  a drain during pending_off keeps the reversion in flight (it can no longer abort, even back above OFF), waits for the dealing hand and ends drained with every session lightning_drained; during pending_on the conversion is aborted through the existing abort (lightning_disabled), the halts lift and the drain ends aborted_pending_on; all eight steps recorded for both'

-- P12 FREEZE AND UNFREEZE ------------------------------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; v_epoch integer; v_alert record; v_m uuid;
BEGIN
  PERFORM setseed(0.138);
  v_g := harness.lc('P13 freeze');
  v_epoch := harness.epoch(v_g);
  r := harness.must(harness.ctl('admin', v_g, 'freeze', '{}', 'suspected chip delta'), 'P12 freeze');
  SELECT * INTO v_alert FROM public.financial_alerts fa
   WHERE fa.source = 'lightning_alerts' AND fa.context ->> 'dedupe_key' = 'lightning_cluster_frozen:' || v_g AND NOT fa.resolved;
  IF harness.mode(v_g) <> 'frozen' OR v_alert.id IS NULL OR v_alert.severity <> 'critical'
     OR v_alert.message NOT LIKE 'LIGHTNING_CLUSTER_FROZEN:%'
     OR harness.evlast(v_g, 'cluster_frozen') ->> 'reason' <> 'operator_freeze'
     OR public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{frozen,reason}' <> 'operator_freeze'
     OR (public.fn_lightning_operator_cluster_row(v_g, now()) ->> 'open_alerts')::integer < 1 THEN
    RAISE EXCEPTION 'FAIL P12: the manual freeze did not take the freeze path: %', r;
  END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'pause'), 'CLUSTER_FROZEN', 'P12 pause frozen');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'disable_joins'), 'CLUSTER_FROZEN', 'P12 joins frozen');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m1"}'), 'CLUSTER_FROZEN', 'P12 matcher frozen');
  PERFORM harness.already(harness.ctl('admin', v_g, 'freeze'), 'P12 freeze again');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'unfreeze'), 'NOT_AUTHORIZED', 'P12 unfreeze by club control');
  PERFORM harness.refused(harness.ctl('service', v_g, 'unfreeze'), 'INVALID_ARGS', 'P12 unfreeze by the service without an operator');
  r := harness.must(harness.ctl('padmin', v_g, 'unfreeze', '{}', 'investigated, no delta'), 'P12 unfreeze');
  IF harness.mode(v_g) <> 'must_move' OR harness.epoch(v_g) <> v_epoch + 1 OR harness.open_sessions(v_g) <> 0
     OR harness.evn(v_g, 'cluster_unfrozen') <> 1 OR harness.evn(v_g, 'operator_unfreeze') <> 1
     OR (r #>> '{detail,unfreeze,unfrozen}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P12: unfreeze: %', r;
  END IF;
  PERFORM harness.already(harness.ctl('padmin', v_g, 'unfreeze'), 'P12 unfreeze again');
  -- A FREEZE ENDS A DRAIN IN FLIGHT.
  v_m := harness.lc('P13 freeze drain');
  PERFORM harness.dealt(v_m, harness.idle(v_m, false, 4) || harness.idle(v_m, true, 2));
  PERFORM harness.must(harness.ctl('admin', v_m, 'drain', '{}', 'drain then freeze'), 'P12 drain');
  r := harness.must(harness.ctl('owner', v_m, 'freeze', '{}', 'freeze in the drain'), 'P12 freeze the drain');
  IF harness.mode(v_m) <> 'frozen' OR harness.drain_row(v_m) ->> 'outcome' <> 'ended_by_frozen'
     OR harness.evn(v_m, 'lightning_drain_ended') <> 1 THEN
    RAISE EXCEPTION 'FAIL P12: the freeze did not end the drain: %', harness.drain_row(v_m);
  END IF;
END $$;
\echo '  ok  P12 FREEZE  a manual freeze takes the existing path (frozen, one critical LIGHTNING_CLUSTER_FROZEN page keyed lightning_cluster_frozen:<cluster>, cluster_frozen operator_freeze, the dashboard shows it); everything but freeze/unfreeze is CLUSTER_FROZEN; club control cannot unfreeze, the service needs an operator; a platform admin unfreezes through fn_cash_cluster_unfreeze (must_move, new epoch); a freeze ends a drain in flight'

-- P13 ENABLE, DISABLE AND THE SPECIFICATION FLAGS -------------------------------------------------------
DO $$
DECLARE v_g uuid; v_l uuid; r jsonb; f text;
BEGIN
  PERFORM setseed(0.139);
  v_g := harness.c8('P13 flags', 6, 4, 1, 4, 1);
  r := harness.must(harness.ctl('admin', v_g, 'disable_lightning', '{}', 'switch off'), 'P13 disable on must_move');
  IF (SELECT lightning_enabled FROM public.cash_games WHERE id = v_g) OR harness.mode(v_g) <> 'must_move'
     OR r #> '{detail,drain}' <> 'null'::jsonb THEN RAISE EXCEPTION 'FAIL P13: %', r; END IF;
  PERFORM harness.already(harness.ctl('admin', v_g, 'disable_lightning'), 'P13 disable again');
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_v1", "value": true}', 'flag on'), 'P13 v1 on');
  IF NOT (SELECT lightning_enabled FROM public.cash_games WHERE id = v_g) OR harness.evn(v_g, 'operator_set_flag') <> 1 THEN
    RAISE EXCEPTION 'FAIL P13: lightning_v1 did not set lightning_enabled';
  END IF;
  FOREACH f IN ARRAY ARRAY['lightning_fast_fold', 'lightning_fold_watch'] LOOP
    PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', jsonb_build_object('flag', f, 'value', false), 'kill switch'), 'P13 ' || f);
    IF (public.fn_lightning_config(v_g) ->> f)::boolean IS DISTINCT FROM false
       OR (public.fn_lightning_operator_cluster_row(v_g, now()) #>> ARRAY['flags', f])::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'FAIL P13: % off is not in the config and the row', f;
    END IF;
    PERFORM harness.already(harness.ctl('admin', v_g, 'set_flag', jsonb_build_object('flag', f, 'value', false)), 'P13 ' || f || ' again');
  END LOOP;
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_shadow_matcher", "value": true}', 'shadow on'), 'P13 shadow');
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_auto_rebuy", "value": true}', 'rebuy on'), 'P13 rebuy');
  IF (public.fn_lightning_config(v_g) ->> 'lightning_shadow_matcher')::boolean IS DISTINCT FROM true
     OR (public.fn_lightning_config(v_g) ->> 'auto_rebuy_enabled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P13: the shadow or rebuy flag did not map onto its key';
  END IF;
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_multi_table", "value": false}', 'one table'), 'P13 multi off');
  IF public.fn_lightning_config(v_g) -> 'multi_table_limit' <> '{"desktop": 1, "tablet": 1, "mobile": 1}'::jsonb
     OR (public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{flags,lightning_multi_table}')::boolean THEN
    RAISE EXCEPTION 'FAIL P13: multi-table off: %', public.fn_lightning_config(v_g) -> 'multi_table_limit';
  END IF;
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_multi_table", "value": true}', 'back to defaults'), 'P13 multi on');
  IF public.fn_lightning_config(v_g) -> 'multi_table_limit' <> '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb THEN
    RAISE EXCEPTION 'FAIL P13: multi-table on did not restore the defaults';
  END IF;
  FOREACH f IN ARRAY ARRAY['lightning_pool_health', 'lightning_repeat_suppression', 'lightning_session_stats', 'lightning_adaptive_liquidity'] LOOP
    PERFORM harness.refused(harness.ctl('admin', v_g, 'set_flag', jsonb_build_object('flag', f, 'value', false)), 'FLAG_NOT_SUPPORTED', 'P13 ' || f);
  END LOOP;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_turbo_mode", "value": false}'), 'INVALID_ARGS', 'P13 unknown flag');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_flag', '{"flag": "lightning_fast_fold", "value": "no"}'), 'INVALID_ARGS', 'P13 non-boolean');
  IF (SELECT count(*) FROM jsonb_object_keys(public.fn_lightning_operator_cluster_row(v_g, now()) -> 'flags')) <> 14 THEN
    RAISE EXCEPTION 'FAIL P13: the row''s flags are not the four Phase 12 keys and the ten specification flags';
  END IF;
  -- OFF ON A LIVE CLUSTER IS THE DRAIN.
  v_l := harness.lc('P13 v1 off');
  r := harness.must(harness.ctl('admin', v_l, 'set_flag', '{"flag": "lightning_v1", "value": false}', 'flag off live'), 'P13 v1 off live');
  IF harness.mode(v_l) <> 'draining' OR r #>> '{detail,performed}' <> 'disable_lightning' OR harness.evn(v_l, 'lightning_drain_step') <> 3 THEN
    RAISE EXCEPTION 'FAIL P13: lightning_v1 off on a live Cluster did not drain: %', r;
  END IF;
  PERFORM harness.refused(harness.ctl('admin', v_l, 'enable_lightning'), 'CLUSTER_BUSY', 'P13 enable during the drain');
  PERFORM harness.already(harness.ctl('admin', v_l, 'disable_lightning'), 'P13 disable during the drain');
  r := public.fn_cash_cluster_lightning_drive(v_l);
  IF harness.mode(v_l) <> 'must_move' OR r #>> '{drain,outcome}' <> 'drained' THEN
    RAISE EXCEPTION 'FAIL P13: an idle drain did not end in one pass: %', r;
  END IF;
END $$;
\echo '  ok  P13 ENABLE, DISABLE AND FLAGS  disable_lightning on must_move clears the flag (no drain); lightning_v1 maps onto lightning_enabled; lightning_fast_fold and lightning_fold_watch are new keys defaulting on, reported in the config and the row; shadow and auto-rebuy map onto their keys; multi-table off is one table on every platform and on restores 4 / 3 / 2; pool health, repeat suppression, session stats and adaptive liquidity are FLAG_NOT_SUPPORTED; unknown flags and non-booleans are INVALID_ARGS; lightning_v1 off on a live Cluster is the drain (enable during it CLUSTER_BUSY), and an idle drain ends in one pass'

-- P14 MATCHER VERSIONS: SET, DISABLE, ENABLE, ROLL BACK, AND THE CLAMP -----------------------------------
DO $$
DECLARE v_g uuid := (SELECT game FROM harness.p13 WHERE k = 'gate'); r jsonb; c jsonb;
BEGIN
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m2"}'), 'NOT_SQL_MATCHER', 'P14 live m2');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m9"}'), 'UNKNOWN_VERSION', 'P14 unknown');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{}'), 'INVALID_ARGS', 'P14 no version');
  PERFORM harness.already(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m1"}'), 'P14 live m1');
  PERFORM harness.must(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m1-port", "role": "shadow"}', 'A/A first'), 'P14 shadow m1-port');
  IF public.fn_lightning_config(v_g) ->> 'shadow_matcher_version' <> 'm1-port' THEN RAISE EXCEPTION 'FAIL P14: shadow version'; END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m1", "role": "shadow"}'), 'INVALID_ARGS', 'P14 shadow = live');
  r := harness.must(harness.ctl('admin', v_g, 'disable_matcher_version', '{"version": "m2"}', 'candidate misbehaves'), 'P14 disable m2');
  IF public.fn_lightning_config(v_g) -> 'matcher_versions_disabled' <> '["m2"]'::jsonb
     OR (public.fn_lightning_config(v_g) ->> 'shadow_matcher_disabled')::boolean THEN RAISE EXCEPTION 'FAIL P14: disable m2: %', r; END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_matcher_version', '{"version": "m2", "role": "shadow"}'), 'VERSION_DISABLED', 'P14 shadow m2 disabled');
  r := harness.must(harness.ctl('admin', v_g, 'disable_matcher_version', '{"version": "m1-port"}', 'stop the shadow'), 'P14 disable the shadow');
  IF (r #>> '{detail,shadow_stops}')::boolean IS DISTINCT FROM true
     OR (public.fn_lightning_config(v_g) ->> 'shadow_matcher_disabled')::boolean IS DISTINCT FROM true
     OR (public.fn_lightning_operator_cluster_row(v_g, now()) #>> '{matcher,shadow_disabled}')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL P14: a disabled shadow version is not reported: %', r;
  END IF;
  PERFORM harness.must(harness.ctl('admin', v_g, 'enable_matcher_version', '{"version": "m1-port"}', 'shadow back'), 'P14 enable m1-port');
  PERFORM harness.already(harness.ctl('admin', v_g, 'enable_matcher_version', '{"version": "m1-port"}'), 'P14 enable again');
  PERFORM harness.refused(harness.ctl('admin', v_g, 'disable_matcher_version', '{"version": "m1"}'), 'INVALID_ARGS', 'P14 disable the only SQL matcher');
  PERFORM harness.already(harness.ctl('admin', v_g, 'rollback_matcher_version'), 'P14 rollback with nothing to roll back');
  -- AN OUT-OF-BAND LIVE VERSION (fixture boundary: a hand-written config):
  -- the configuration clamps it to m1 and says so; the rollback cleans it.
  PERFORM harness.cfg(v_g, '{"matcher_version": "m2"}');
  c := public.fn_lightning_config(v_g);
  IF c ->> 'matcher_version' <> 'm1' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x(v)
       WHERE x.v ->> 'key' = 'matcher_version' AND x.v ->> 'reason' = 'not_a_sql_matcher') THEN
    RAISE EXCEPTION 'FAIL P14: the clamp: %', c;
  END IF;
  r := harness.must(harness.ctl('admin', v_g, 'rollback_matcher_version', '{}', 'roll back the bad live version'), 'P14 rollback');
  c := public.fn_lightning_config(v_g);
  IF r #>> '{detail,from}' <> 'm2' OR r #>> '{detail,to}' <> 'm1' OR c ->> 'matcher_version_previous' <> 'm2'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x(v) WHERE x.v ->> 'key' = 'matcher_version') THEN
    RAISE EXCEPTION 'FAIL P14: rollback: % / %', r, c;
  END IF;
  -- DISABLING THE LIVE VERSION FORCES THE ROLLBACK.
  PERFORM harness.cfg(v_g, '{"matcher_version": "m1-port", "matcher_version_previous": "m1"}');
  r := harness.must(harness.ctl('admin', v_g, 'disable_matcher_version', '{"version": "m1-port"}', 'disable the live port'), 'P14 disable live');
  IF r #>> '{detail,forced_rollback,to}' <> 'm1' OR (SELECT ruleset_snapshot #>> '{lightning,matcher_version}' FROM public.cash_games WHERE id = v_g) <> 'm1' THEN
    RAISE EXCEPTION 'FAIL P14: disabling the live version did not roll back: %', r;
  END IF;
  -- THE CLAMPS, by hand-written values.
  PERFORM harness.cfg(v_g, '{"matcher_versions_disabled": ["m1", "zz", 3], "matcher_version_previous": "zz", "drain_timeout_ms": 5, "lightning_joins_enabled": "no"}');
  c := public.fn_lightning_config(v_g);
  IF c ->> 'matcher_version' <> 'm1' OR c -> 'matcher_versions_disabled' <> '["m1"]'::jsonb OR c ->> 'matcher_version_previous' <> 'm1'
     OR (c ->> 'drain_timeout_ms')::integer <> 10000 OR (c ->> 'lightning_joins_enabled')::boolean IS DISTINCT FROM true
     OR (SELECT count(*) FROM jsonb_array_elements(c -> 'invalid') x(v)
          WHERE x.v ->> 'key' IN ('matcher_version', 'matcher_versions_disabled', 'matcher_version_previous', 'drain_timeout_ms', 'lightning_joins_enabled')) <> 5 THEN
    RAISE EXCEPTION 'FAIL P14: the clamps: %', c;
  END IF;
  PERFORM harness.cfg(v_g, '{"matcher_versions_disabled": [], "matcher_version_previous": "m1", "drain_timeout_ms": 120000, "lightning_joins_enabled": true, "matcher_version": "m1"}');
END $$;
\echo '  ok  P14 MATCHER VERSIONS  the live matcher is only a version the SQL matcher implements (m2 NOT_SQL_MATCHER, m9 UNKNOWN_VERSION); the shadow is set, disabled (shadow_matcher_disabled, the engine records nothing) and enabled; a disabled candidate is VERSION_DISABLED; the only SQL matcher cannot be disabled; an out-of-band live m2 is clamped to m1 and reported, and rolled back (previous m2); disabling the live version forces the rollback; every new key clamps and reports'

-- P15 THE ROLLOUT READINESS VERDICT ------------------------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb; i integer; v_t timestamptz := date_trunc('minute', clock_timestamp()) - interval '40 minutes';
BEGIN
  PERFORM setseed(0.140);
  v_g := harness.c8('P13 ready', 6, 4, 1, 4, 1);
  PERFORM harness.refused(harness.door('stranger', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g)), 'NOT_AUTHORIZED', 'P15 stranger');
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'no_go' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'reasons') x(v) WHERE x.v ->> 'code' = 'WORKER_OFF')
     OR (r #>> '{evidence,invariants,seven_tables}')::boolean IS DISTINCT FROM true
     OR (r #>> '{evidence,invariants,anti_manipulation}')::boolean IS DISTINCT FROM true
     OR (r #>> '{evidence,invariants,law_10_5}')::boolean IS DISTINCT FROM true
     OR (r #>> '{evidence,invariants,no_anon_door}')::boolean IS DISTINCT FROM true
     OR (r #>> '{evidence,migrations,applied}')::integer <> 32 OR harness.card_keys(r) <> 0 THEN
    RAISE EXCEPTION 'FAIL P15: worker off: %', r;
  END IF;
  PERFORM harness.refused(harness.ctl('admin', v_g, 'set_worker_mode', '{"mode": "fast"}'), 'INVALID_ARGS', 'P15 bad worker mode');
  r := harness.must(harness.ctl('admin', v_g, 'set_worker_mode', '{"mode": "form"}', 'the pilot forms'), 'P15 worker form');
  IF public.fn_lightning_config(v_g) ->> 'worker_mode' <> 'form' OR r #>> '{detail,was}' <> 'off' THEN
    RAISE EXCEPTION 'FAIL P15: set_worker_mode: %', r;
  END IF;
  PERFORM harness.already(harness.ctl('admin', v_g, 'set_worker_mode', '{"mode": "form"}'), 'P15 worker form again');
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'insufficient_evidence'
     OR (SELECT array_agg(x.v ->> 'code' ORDER BY x.v ->> 'code') FROM jsonb_array_elements(r -> 'reasons') x(v)) <> ARRAY['NO_AA_CALIBRATION', 'NO_LATENCY_EVIDENCE'] THEN
    RAISE EXCEPTION 'FAIL P15: no evidence yet: %', r;
  END IF;
  -- THE EVIDENCE, through the engine's own doors: thirty A/A windows of the
  -- live matcher against its port, scored alike, and latency windows under
  -- every ceiling.
  FOR i IN 1 .. 30 LOOP
    r := public.fn_lightning_shadow_record(v_g, 'm1', 'm1-port', v_t + (i - 1) * interval '1 minute', v_t + i * interval '1 minute',
                                           harness.p13_metrics(), harness.p13_metrics());
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: shadow record: %', r; END IF;
  END LOOP;
  FOR i IN 1 .. 3 LOOP
    r := public.fn_lightning_latency_report(v_g, date_trunc('minute', clock_timestamp()) - (4 - i) * interval '1 minute',
                                            date_trunc('minute', clock_timestamp()) - (3 - i) * interval '1 minute',
                                            '{"fold_ack": {"n": 50, "p50": 20, "p95": 40, "p99": 60}}'::jsonb);
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: latency report: %', r; END IF;
  END LOOP;
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'go' OR jsonb_array_length(r -> 'reasons') <> 0 OR r #>> '{evidence,shadow,aa_calibration,verdict}' <> 'calibrated'
     OR r #>> '{evidence,shadow,scope}' <> 'cluster' THEN
    RAISE EXCEPTION 'FAIL P15: with the evidence: %', r;
  END IF;
  -- A LATENCY REGRESSION, AN OPEN PAGE, A MISSING MIGRATION, A BROKEN
  -- INVARIANT, A FROZEN CLUSTER: each is a blocking reason.
  FOR i IN 1 .. 3 LOOP
    r := public.fn_lightning_latency_report(v_g, v_t + interval '40 minutes' + (i - 1) * interval '1 minute' + interval '1 second',
                                            v_t + interval '40 minutes' + i * interval '1 minute',
                                            '{"fold_ack": {"n": 50, "p50": 400, "p95": 900, "p99": 950}}'::jsonb);
    IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: latency report: %', r; END IF;
  END LOOP;
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'no_go' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'reasons') x(v) WHERE x.v ->> 'code' = 'LATENCY_ABOVE_CEILING') THEN
    RAISE EXCEPTION 'FAIL P15: a latency regression is not a no_go: %', r;
  END IF;
  DELETE FROM public.lightning_latency_window WHERE cluster_id = v_g AND (legs #>> '{fold_ack,p95}')::numeric > 500;
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009151825';
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'no_go' OR r #> '{evidence,migrations,missing}' <> '["20261009151825"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL P15: a missing migration: %', r;
  END IF;
  INSERT INTO supabase_migrations.schema_migrations VALUES ('20261009151825', 'lightning');
  GRANT SELECT ON public.lightning_cluster_drain TO service_role;
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  REVOKE SELECT ON public.lightning_cluster_drain FROM service_role;
  IF r ->> 'verdict' <> 'no_go' OR (r #>> '{evidence,invariants,seven_tables}')::boolean THEN
    RAISE EXCEPTION 'FAIL P15: a broken census: %', r;
  END IF;
  PERFORM public.fn_raise_server_financial_alert('warning', 'lightning_alerts', 'P13 test page',
            jsonb_build_object('check', 'drive_error', 'cluster_id', v_g), 'p13-ready:' || v_g, v_g::text);
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'no_go' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'reasons') x(v) WHERE x.v ->> 'code' = 'OPEN_ALERTS') THEN
    RAISE EXCEPTION 'FAIL P15: an open page: %', r;
  END IF;
  UPDATE public.financial_alerts SET resolved = true, resolved_at = now() WHERE context ->> 'cluster_id' = v_g::text;
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', v_g));
  IF r ->> 'verdict' <> 'go' THEN RAISE EXCEPTION 'FAIL P15: back to go: %', r; END IF;
  -- THE ESTATE'S A/A EVIDENCE COUNTS FOR A CLUSTER THAT HAS NONE OF ITS OWN.
  r := harness.door('admin', format('SELECT public.fn_lightning_rollout_readiness(%L::uuid)', (SELECT game FROM harness.p13 WHERE k = 'gate')));
  IF r #>> '{evidence,shadow,scope}' <> 'estate' OR r #>> '{evidence,shadow,aa_calibration,verdict}' <> 'calibrated' THEN
    RAISE EXCEPTION 'FAIL P15: estate evidence: %', r -> 'evidence' -> 'shadow';
  END IF;
END $$;
\echo '  ok  P15 READINESS  a stranger is NOT_AUTHORIZED; worker off is no_go; set_worker_mode (off, shadow or form, anything else INVALID_ARGS) sets the worker forming, and and no evidence it is insufficient_evidence (NO_AA_CALIBRATION, NO_LATENCY_EVIDENCE); with thirty calibrated A/A windows and latency under the ceilings it is go; a latency regression, a missing Lightning migration, a broken seven-tables census and an open page are each no_go; the estate''s A/A evidence is used for a Cluster with none of its own; never a card'

-- P16 THE DRIVE AND THE TICK STILL DRIVE THE ESTATE, AND NOTHING IS STRANDED ---------------------------------
DO $$
DECLARE r jsonb;
BEGIN
  r := public.fn_cash_clusters_tick_all('{}'::jsonb);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL P16: the tick: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.kind = 'lightning_drive_error') THEN
    RAISE EXCEPTION 'FAIL P16: a drive error was recorded: %', (SELECT e.payload FROM public.cash_cluster_events e WHERE e.kind = 'lightning_drive_error' LIMIT 1);
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_cluster_drain d JOIN public.cash_games cg ON cg.id = d.cluster_id
              WHERE d.completed_at IS NULL AND cg.cluster_mode NOT IN ('draining', 'pending_on', 'pending_off', 'must_move', 'frozen')) THEN
    RAISE EXCEPTION 'FAIL P16: an open drain sits on a Cluster that cannot finish it';
  END IF;
END $$;
\echo '  ok  P16 THE TICK  a whole tick pass over every Cluster the harness built drives without a single lightning_drive_error, and no open drain sits on a Cluster that cannot finish it'
ASSERT

# THE RACES: a drain against the drive's own reversion, and two operators.
cat > "$fixture/race-prep.sql" <<'ASSERT'
DO $$
DECLARE v_g uuid; v_h uuid;
BEGIN
  PERFORM setseed(0.141);
  v_g := harness.lc('P13 race tick');
  INSERT INTO harness.p13 (k, game) VALUES ('race_tick', v_g);
  v_h := harness.lc('P13 race ops');
  INSERT INTO harness.p13 (k, game, a) VALUES ('race_ops', v_h, gen_random_uuid());
END $$;
ASSERT

cat > "$fixture/race-after.sql" <<'ASSERT'
-- P17 THE RACES ------------------------------------------------------------------------------------
DO $$
DECLARE v_g uuid := (SELECT game FROM harness.p13 WHERE k = 'race_tick'); v_h uuid := (SELECT game FROM harness.p13 WHERE k = 'race_ops');
BEGIN
  IF harness.mode(v_g) <> 'draining' OR (SELECT count(*) FROM public.lightning_cluster_drain WHERE cluster_id = v_g) <> 1
     OR EXISTS (SELECT 1 FROM public.cash_cluster_conversion c WHERE c.cluster_id = v_g AND c.status = 'pending')
     OR harness.drain_row(v_g) ->> 'phase' <> 'finishing' THEN
    RAISE EXCEPTION 'FAIL P17: the drive''s reversion raced into the drain: % / %', harness.mode(v_g), harness.drain_row(v_g);
  END IF;
  IF (SELECT count(*) FROM public.lightning_cluster_drain WHERE cluster_id = v_h) <> 1
     OR harness.evn(v_h, 'operator_drain') <> 1 OR harness.evn(v_h, 'lightning_drain_step') <> 3 THEN
    RAISE EXCEPTION 'FAIL P17: two operators draining at once drained twice';
  END IF;
  PERFORM public.fn_cash_cluster_lightning_drive(v_g);
  PERFORM public.fn_cash_cluster_lightning_drive(v_h);
  IF harness.mode(v_g) <> 'must_move' OR harness.mode(v_h) <> 'must_move' THEN
    RAISE EXCEPTION 'FAIL P17: the raced drains did not end';
  END IF;
END $$;
\echo '  ok  P17 THE RACES  on two backends, a drive pass that read lightning just before an operator''s drain is answered wrong_state under the lock and opens no reversion under the drain; two operators draining at once (and one repeating its request id) make one drain, one operator_drain and one set of steps; both drains end'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- P18 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 16
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL P18: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  P18 THE LIVE PROOFS  all sixteen @live-proof claims of the file evaluate true against this catalogue after the estate above ran through it'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
 WHERE c.oid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_control'::regclass, 'public.lightning_cluster_drain'::regclass)
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['public.lightning_operator_request', 'public.lightning_cluster_control', 'public.lightning_cluster_drain',
                    'public.cash_cluster_events']) x(t)
UNION ALL
SELECT 'triggers', string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t
 WHERE t.tgrelid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_drain'::regclass) AND NOT t.tgisinternal
UNION ALL
SELECT 'config', md5(public.fn_lightning_config(NULL)::text);
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- P19 RE-APPLIABLE ------------------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  CREATE TEMP TABLE rcap2 AS
  SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
  UNION ALL
  SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
   WHERE c.oid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_control'::regclass, 'public.lightning_cluster_drain'::regclass)
  UNION ALL
  SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
    FROM unnest(ARRAY['public.lightning_operator_request', 'public.lightning_cluster_control', 'public.lightning_cluster_drain',
                      'public.cash_cluster_events']) x(t)
  UNION ALL
  SELECT 'triggers', string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t
   WHERE t.tgrelid IN ('public.lightning_operator_request'::regclass, 'public.lightning_cluster_drain'::regclass) AND NOT t.tgisinternal
  UNION ALL
  SELECT 'config', md5(public.fn_lightning_config(NULL)::text);
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a FULL JOIN rcap2 b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P19: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 100 THEN
    RAISE EXCEPTION 'FAIL P19: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  P19 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body and ACL, the three tables'' ACLs and rows, their triggers, the event ledger and the configuration answer exactly as they were'
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
  "$fixture/ground.sql" "$p11" "$p12rg" "$fixture/ground12.sql" "$p12ops" "$p12lc" "$p11r" \
  "$fixture/p13ground.sql"
run before "$fixture/before.sql"
echo "  the thirteen substituted bodies as the chain carries them (compare with production's pg_get_functiondef md5):"
Q "SELECT '    ' || fn || ' ' || md5 FROM harness.p13_fn ORDER BY fn"
run apply "$fixture/proofs-before.sql" "$mine" "$fixture/proofs-after.sql"
run after "$fixture/after.sql" "$fixture/race-prep.sql"

# P17: TWO BACKENDS. (a) The operator drains, holding its transaction open;
# the other backend is a drive pass that already chose the reversion (it read
# lightning a moment before) and asks fn_cash_cluster_begin_pending_off with
# the drive's own reason. (b) Two operators drain one Cluster at once, and a
# third repeats the first one's request id.
g1=$(Q "SELECT game FROM harness.p13 WHERE k = 'race_tick'")
g2=$(Q "SELECT game FROM harness.p13 WHERE k = 'race_ops'")
rid=$(Q "SELECT a FROM harness.p13 WHERE k = 'race_ops'")
ctl_sql() { # caller game reason rid sleep
  printf "BEGIN; SELECT harness.ctl('%s', '%s'::uuid, 'drain', '{}'::jsonb, '%s', %s); SELECT pg_sleep(%s); COMMIT;\n" "$1" "$2" "$3" "$4" "$5"
}
ctl_sql admin "$g1" "race the drive" NULL 1.5 > "$fixture/race-a.sql"
printf "SELECT pg_sleep(0.4); SELECT 'TICK ' || public.fn_cash_cluster_begin_pending_off('%s'::uuid, gen_random_uuid(), 'fn_cash_cluster_lightning_drive')::text;\n" "$g1" > "$fixture/race-b.sql"
ctl_sql admin "$g2" "first operator" "'$rid'::uuid" 1.5 > "$fixture/race-c.sql"
printf "SELECT pg_sleep(0.4); SELECT 'SECOND ' || harness.ctl('owner', '%s'::uuid, 'drain', '{}'::jsonb, 'second operator')::text;\n" "$g2" > "$fixture/race-d.sql"
printf "SELECT pg_sleep(0.6); SELECT 'REPEAT ' || harness.ctl('coowner', '%s'::uuid, 'drain', '{}'::jsonb, 'repeat', '%s'::uuid)::text;\n" "$g2" "$rid" > "$fixture/race-e.sql"
for x in a b c d e; do
  ( "${PSQL[@]}" -At -f "$fixture/race-$x.sql" > "$fixture/race-$x.out" 2>&1; echo "rc=$?" >> "$fixture/race-$x.out" ) &
done
wait
for x in a b c d e; do
  grep -q 'rc=0' "$fixture/race-$x.out" || { cat "$fixture/race-$x.out"; echo "FAIL: race backend $x failed"; exit 1; }
done
grep -q '^TICK .*"reason": "wrong_state"' "$fixture/race-b.out" \
  || { cat "$fixture/race-b.out"; echo "FAIL P17: the raced reversion was not answered wrong_state"; exit 1; }
grep -q '^SECOND .*"code": "ALREADY"' "$fixture/race-d.out" \
  || { cat "$fixture/race-d.out"; echo "FAIL P17: the second operator was not answered ALREADY"; exit 1; }
grep -q '^REPEAT .*"replayed": true' "$fixture/race-e.out" \
  || { cat "$fixture/race-e.out"; echo "FAIL P17: the repeated request id was not replayed"; exit 1; }

run after2 "$fixture/race-after.sql" "$fixture/own-proofs-eval.sql" "$fixture/own-proofs.sql" \
  "$fixture/precapture.sql" "$mine" "$fixture/reapply.sql"

# TWENTY SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  P[0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 20 ]; then
  echo "FAIL: $oks of the 20 sections reported, so this run proved less than this file claims"
  exit 1
fi
Q "SELECT 'own live proofs: ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM harness.lp8 WHERE phase = 'own'"
Q "SELECT 'predecessor live proofs true before and after: ' || count(*) FILTER (WHERE ok) FROM harness.lp8 WHERE phase = 'after'"
echo "PASS: Lightning Phase 13 (DB), 20 sections, over the real chain through 20261009181945 under production's default ACLs and live autorevoke trigger, humans and horses at every table: the control door's gate, refusals and idempotency; joins closed and reopened; pause and resume from lightning and must-move; the emergency drain from lightning with hands mid-deal (every step an event, stacks to the cent, MUST-MOVE rebuilt through the reversion), its deadline, during pending_off and pending_on; the manual freeze and the platform's unfreeze; the flags and the matcher versions with the configuration's clamps; the readiness verdict; the tick; the races on two backends; no predecessor proof falsified; every own proof true; re-appliable"
