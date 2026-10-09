#!/usr/bin/env bash
# Lightning Phase 12 (the database side): the operator dashboard, its alerts,
# the latency ledger and a caller for the integrity scan.
#
# Proves 20261009144343 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55560 (LIGHTNING_P12_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 11 (20261008161509), in order, exactly as
# test-lightning-phase11-integrity-shadow.sh builds them, then the migration
# under test, twice. Every Cluster is converted ON by the real drive, every
# hand formed by the real barrier, dealt by the real begin_dealing and
# settled by the real settlement, every freeze is the real settlement
# freeze, every alert goes through fn_raise_server_financial_alert verbatim.
# The rows the harness writes itself are fixture boundaries only, each named
# where it is written: production's gate ground (profiles.role,
# clubs.owner_id, club_members roles and fn_is_platform_admin /
# fn_ca_can_review_integrity verbatim from PokerIQ-Production on
# 2026-10-09), a pg_cron stand-in with the managed API's signatures, a
# ledger event carrying card keys (the redaction's adversary), backdated
# conversion and window stamps (time travel), an operator closing a page,
# and fault injection (a body temporarily replaced to raise, then restored
# from its own pg_get_functiondef).
#
# LAW 10.5. Horses sit beside humans in every Cluster; they are counted,
# reconciled, replayed, timed and alerted on exactly as humans. The
# migration reads neither is_horse nor horse_id (the harness does, to prove
# horses are among what the doors return).
#
# LIGHTNING_P12_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function,
# table and sequence privileges and its trg_autorevoke_privileged_anon event
# trigger before the Phase 11 file and the file under test run.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P12_PORT:-55560}
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
p7=$M/20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql
phase8=$M/20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql
p7r=$M/20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql
fix=$M/20261008043021_lightning_phase_7_and_8_review_fixes_the_dwell_is_a_duration.sql
p9d=$M/20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql
p10=$M/20261008111425_lightning_phase_10_responsible_gaming_stop_playing_auto_rebu.sql
p9r2=$M/20261008142857_lightning_phase_9_remediation_the_ended_session_answers_the_.sql
p11=$M/20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql
mine=${LIGHTNING_P12_MIGRATION:-$M/20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p12-test.XXXXXX")
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
    printf '%s\n' "INSERT INTO harness.lp8 VALUES ('$phase', '$src', $n, $lineno, public.fxr_eval(\$lpq\$${expr}\$lpq\$));"
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
  gen_proofs "$phase" p7 "$p7"
  gen_proofs "$phase" p8 "$phase8"; gen_proofs "$phase" p7r "$p7r"; gen_proofs "$phase" fix "$fix"
  gen_proofs "$phase" p9d "$p9d"
  gen_proofs "$phase" p10 "$p10"
  gen_proofs "$phase" p9r2 "$p9r2"
  gen_proofs "$phase" p11 "$p11"
}

# ===========================================================================
# THE GROUND: the Phase 11 harness's ground, verbatim (its helpers,
# production's function-creation environment and the integrity ground the
# Phase 11 file reads), applied before the Phase 11 file; then this phase's
# own fixture boundaries and section 00 (ground12.sql).
# ===========================================================================
cat > "$fixture/ground.sql" <<'ASSERT'
CREATE TABLE harness.p8 (k text PRIMARY KEY, game uuid, a uuid, b uuid, c uuid, j jsonb);
CREATE TABLE harness.lp8 (phase text, src text, n integer, lineno integer, ok boolean);

-- PRODUCTION'S auth.role(): the role claim of the request, NULL without one.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '');
$f$;
-- PRODUCTION'S PER-HAND PER-PLAYER FACTS (the columns the statistics read),
-- keyed as production keys them: hand_history id and user.
CREATE TABLE IF NOT EXISTS public.ca_hand_facts (
  hand_id uuid NOT NULL, user_id uuid NOT NULL, club_id uuid, table_id uuid, played_at timestamptz,
  position text, net numeric, vpip boolean, pfr boolean, went_to_showdown boolean,
  PRIMARY KEY (hand_id, user_id));
-- PRODUCTION'S LOBBY RULE, verbatim from pg_policies.
DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_games' AND policyname = 'cash_games_read') THEN
    CREATE POLICY cash_games_read ON public.cash_games FOR SELECT TO authenticated
      USING ((NOT COALESCE((((ruleset_snapshot -> 'options'::text) ->> 'is_private'::text))::boolean, false))
             OR (EXISTS (SELECT 1 FROM public.club_members cm
                          WHERE ((cm.club_id = cash_games.club_id) AND (cm.user_id = (SELECT auth.uid() AS uid))))));
  END IF;
END $p$;
-- PRODUCTION'S GRANTS the policy runs under.
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT SELECT ON public.cash_games, public.club_members TO authenticated;

-- A CLUSTER WITH A FRONT TABLE AND A FEEDER, humans and horses at both.
CREATE FUNCTION harness.c8(p_key text, p_handed integer, p_main integer, p_main_horses integer,
                           p_feed integer, p_feed_horses integer) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; v_f uuid; i integer;
BEGIN
  v_g := public.fx9_cluster('P8 ' || p_key, p_handed, 40, true);
  PERFORM public.fx9_seat(v_g, p_main, 1, false);
  IF p_main_horses > 0 THEN PERFORM public.fx9_seat(v_g, p_main_horses, p_main + 1, true); END IF;
  v_f := public.fx9_table(v_g, 'P8 ' || p_key || ' feeder', 'feeder', NULL, 40);
  FOR i IN 1 .. p_feed + p_feed_horses LOOP
    PERFORM public.fxr_join(v_g, v_f, i, 200.00 + 10 * i, i > p_feed);
  END LOOP;
  INSERT INTO harness.p8 (k, game, a) VALUES ('feeder:' || v_g, v_g, v_f);
  RETURN v_g;
END $f$;
CREATE FUNCTION harness.feeder(p_game uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT a FROM harness.p8 WHERE k = 'feeder:' || p_game;
$f$;
CREATE FUNCTION harness.live(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT public.fn_cash_cluster_live_eligible(p_game);
$f$;
CREATE FUNCTION harness.mode(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT cluster_mode FROM public.cash_games WHERE id = p_game;
$f$;
CREATE FUNCTION harness.drive(p_game uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  EXECUTE 'SELECT public.fn_cash_cluster_lightning_drive($1)' INTO v USING p_game;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the drive did not answer: %', v; END IF;
  RETURN v;
END $f$;
-- A LIGHTNING CLUSTER AT 18 (six-max), converted by two real drive passes,
-- its slots opened by the real sync.
CREATE FUNCTION harness.lc(p_key text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid;
BEGIN
  v_g := harness.c8(p_key, 6, 7, 2, 7, 2);
  PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
  IF harness.mode(v_g) IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FIXTURE: % did not convert', p_key; END IF;
  PERFORM public.fx9_pool(v_g);
  RETURN v_g;
END $f$;
-- A REAL ARRIVAL OF A NAMED PLAYER: a seat at the feeder and an open Cluster
-- cash session; the pool follows the seat through the real deferred trigger.
CREATE FUNCTION harness.seat(p_game uuid, p_user uuid, p_horse boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_seat integer;
BEGIN
  -- The pool trigger is deferred: the seat is written before its cash
  -- session, so the trigger waits for both, as it does in production.
  SET CONSTRAINTS ALL DEFERRED;
  SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat FROM public.table_seats ts WHERE ts.table_id = harness.feeder(p_game);
  PERFORM public.fxr_join(p_game, harness.feeder(p_game), v_seat, 250.00 + v_seat, p_horse, true, p_user);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM public.fx9_pool(p_game);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game AND ps.player_id = p_user AND ps.exited_at IS NULL) THEN
    RAISE EXCEPTION 'FIXTURE: % did not enter the pool of %', p_user, p_game;
  END IF;
END $f$;
CREATE FUNCTION harness.join(p_game uuid, p_n integer, p_horse boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE i integer; v_seat integer;
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  FOR i IN 1 .. p_n LOOP
    SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat FROM public.table_seats ts WHERE ts.table_id = harness.feeder(p_game);
    PERFORM public.fxr_join(p_game, harness.feeder(p_game), v_seat, 300.00 + v_seat, p_horse);
  END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
END $f$;
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
CREATE FUNCTION harness.to(p_game uuid, p_n integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v integer := harness.live(p_game);
BEGIN
  IF v < p_n THEN PERFORM harness.join(p_game, p_n - v); ELSIF v > p_n THEN PERFORM harness.leave(p_game, v - p_n); END IF;
  IF harness.live(p_game) IS DISTINCT FROM p_n THEN
    RAISE EXCEPTION 'FIXTURE: % is at % after moving to %', p_game, harness.live(p_game), p_n;
  END IF;
END $f$;
-- Open-pool players of a Cluster holding no reservation, humans or horses,
-- never one of p_not.
CREATE FUNCTION harness.idle(p_game uuid, p_horse boolean, p_n integer, p_not uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT coalesce(array_agg(x.player_id ORDER BY x.player_id), ARRAY[]::uuid[]) FROM (
    SELECT ps.player_id FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
     WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL AND (ts.horse_id IS NOT NULL) = p_horse
       AND NOT (ps.player_id = ANY (p_not))
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r WHERE r.cluster_id = p_game
                        AND r.player_id = ps.player_id AND r.state IN ('pending', 'committed'))
     ORDER BY ps.player_id LIMIT p_n) x;
$f$;
CREATE FUNCTION harness.session(p_game uuid, p_player uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT ps.id FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game AND ps.player_id = p_player
   ORDER BY ps.entered_at DESC LIMIT 1;
$f$;
CREATE FUNCTION harness.form(p_game uuid, p_players uuid[]) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := public.fn_lightning_form_hand(p_game, p_players,
         p_target_size => cardinality(p_players)::smallint, p_max_size => cardinality(p_players)::smallint,
         p_now => clock_timestamp(), p_matcher_version => 'p8-matcher', p_request_id => gen_random_uuid());
  IF (v ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the barrier did not form % players: %', cardinality(p_players), v;
  END IF;
  RETURN v;
END $f$;
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
-- ONE WHOLE HAND: formed, dealt, folded through the real fold door, settled
-- through the real settlement with the engine's winners on the history row.
-- p_spec keys are player ids; a player with 'f' folds with 'c' committed.
CREATE FUNCTION harness.play(p_game uuid, p_players uuid[], p_spec jsonb, p_pot numeric, p_winners uuid[])
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE r jsonb; v_inst uuid; v_hand uuid; p uuid;
BEGIN
  r := harness.form(p_game, p_players);
  v_inst := (r ->> 'instance_id')::uuid; v_hand := (r ->> 'hand_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  PERFORM harness.deal(v_inst);
  FOREACH p IN ARRAY p_players LOOP
    IF p_spec -> p::text ? 'f' THEN
      r := public.fn_lightning_fast_fold(v_hand, p, gen_random_uuid(), p_spec -> p::text ->> 'f',
                                         coalesce((p_spec -> p::text ->> 'c')::numeric, 0));
      IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the fold refused: %', r; END IF;
    END IF;
  END LOOP;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  r := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, p_spec), 0, 0,
         jsonb_build_object('pot_size', p_pot, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', (SELECT coalesce(jsonb_agg(jsonb_build_object('userId', w, 'amount', 1, 'potIndex', 0)), '[]'::jsonb)
                                          FROM unnest(p_winners) w)));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the settlement refused: %', r; END IF;
  RETURN v_hand;
END $f$;
-- THE CALLER, as PostgREST names it.
CREATE FUNCTION harness.as_user(p_user uuid, p_role text DEFAULT 'authenticated') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
  PERFORM set_config('request.jwt.claim.role', coalesce(p_role, ''), false);
END $f$;
-- P0'S ANSWER FOR ONE PLAYER, with a platform map. PL/pgSQL, because it is
-- created before the signature it calls.
CREATE FUNCTION harness.reason(p_game uuid, p_player uuid, p_platforms jsonb) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (SELECT coalesce(l.reason_code, 'LEGAL')
            FROM public.fn_lightning_player_legality(p_game, clock_timestamp(), NULL::uuid[], p_platforms) l
           WHERE l.player_id = p_player);
END $f$;
CREATE FUNCTION harness.detail(p_game uuid, p_player uuid, p_platforms jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (SELECT l.detail FROM public.fn_lightning_player_legality(p_game, clock_timestamp(), NULL::uuid[], p_platforms) l
           WHERE l.player_id = p_player);
END $f$;

-- ===========================================================================
-- PRODUCTION'S FUNCTION-CREATION ENVIRONMENT, reproduced verbatim, because
-- the file under test recreates functions inside it. In production every new
-- function in public is born executable by anon, authenticated and
-- service_role (pg_default_acl), and trg_autorevoke_privileged_anon rewrites
-- ACLs after CREATE FUNCTION, ALTER FUNCTION and GRANT. The first apply of
-- 20261007212735 was refused by its own ACL read-back exactly because this
-- fixture had neither (2026-10-07), so both are ground now. Installed AFTER
-- the chain and the helpers, which matches production: every earlier
-- Lightning migration revoked its own grants explicitly, so the chain's ACLs
-- here equal the chain's ACLs there.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.privileged_function_lock (
  function_signature text PRIMARY KEY,
  security_definer   boolean NOT NULL DEFAULT false,
  reason             text NOT NULL,
  locked_at          timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.fn_autorevoke_privileged_anon()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  obj          record;
  lk           record;
  v_name       text;
  v_sig        text;
  v_secdef     boolean;
  v_src        text;
  v_behaves    boolean;
  v_named      boolean;
  v_saw_grant  boolean := false;
BEGIN
  IF COALESCE(current_setting('app.allow_privileged_anon_grant', true), 'off') = 'on' THEN
    RETURN;
  END IF;

  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP

    -- GRANT rows carry no objid/object_identity at all (probe-verified):
    --   [tag=GRANT | object_type=FUNCTION | objid=NULL | ident=NULL]
    -- so the granted function cannot be identified here. Flag a lock sweep.
    IF obj.command_tag = 'GRANT' THEN
      IF upper(COALESCE(obj.object_type, '')) = 'FUNCTION' THEN
        v_saw_grant := true;
      END IF;
      CONTINUE;
    END IF;

    IF lower(COALESCE(obj.object_type, '')) <> 'function' THEN
      CONTINUE;
    END IF;

    SELECT p.proname,
           format('public.%I(%s)', p.proname,
                  COALESCE((SELECT string_agg(format_type(t.typ, NULL), ', ' ORDER BY t.ord)
                              FROM unnest(p.proargtypes) WITH ORDINALITY AS t(typ, ord)), '')),
           p.prosecdef,
           p.prosrc
      INTO v_name, v_sig, v_secdef, v_src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.oid = obj.objid
       AND n.nspname = 'public';

    IF v_name IS NULL
       OR v_name IN ('fn_autorevoke_privileged_anon', 'fn_audit_privileged_grants') THEN
      CONTINUE;
    END IF;

    -- ARM 1 - NAME. Unchanged except the prefix arm now tolerates an `fn_`
    -- prefix: `fn_credit_stalled_seat_first_stacks` defeated the anchored
    -- version on 2026-08-23 despite crediting stacks.
    v_named := v_name !~ '^st_' AND (
         v_name ~* '(mint_|_mint|chip|wallet|promo|cashout|diamond|rake|bounty|settle|payout|clawback|purchase|treasury|jackpot|bbj)'
      OR v_name ~* '^(fn_)?(credit|debit|transfer|distribute|deduct|atomic|admin)_'
      OR v_name ~* '(promote_member|transfer_club_ownership|remove_player)'
    );

    -- ARM 2 - BEHAVIOUR. The rule economy_invariants() actually asserts:
    -- SECURITY DEFINER (so RLS does not apply) + writes + never consults
    -- auth.uid() (so it cannot tell who is asking). Such a function must not
    -- be reachable without a session, whatever it is called. This is the arm
    -- that would have caught all six of today's.
    v_behaves := COALESCE(v_secdef, false)
             AND v_src ~* '\m(insert|update|delete)\M'
             AND v_src !~* 'auth\.uid\(\)';

    IF v_named OR v_behaves THEN
      BEGIN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', obj.object_identity);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   obj.object_identity);

        INSERT INTO public.privileged_function_lock (function_signature, security_definer, reason)
        VALUES (v_sig,
                COALESCE(v_secdef, false),
                'Auto-locked by trg_autorevoke_privileged_anon on ' || obj.command_tag
                 || CASE WHEN v_behaves AND NOT v_named
                         THEN ' (behavioural: definer + writes + no auth.uid())'
                         WHEN v_behaves THEN ' (name + behavioural)'
                         ELSE ' (name)' END || '.')
        ON CONFLICT (function_signature) DO NOTHING;

        RAISE NOTICE '[autorevoke] stripped PUBLIC/anon EXECUTE from % (tag %, named=%, behaviour=%)',
          obj.object_identity, obj.command_tag, v_named, v_behaves;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[autorevoke] could not revoke on %: %', obj.object_identity, SQLERRM;
      END;
    END IF;
  END LOOP;

  IF v_saw_grant THEN
    FOR lk IN
      SELECT l.function_signature, to_regprocedure(l.function_signature) AS rp
        FROM public.privileged_function_lock l
       WHERE to_regprocedure(l.function_signature) IS NOT NULL
         AND ( has_function_privilege('anon',   to_regprocedure(l.function_signature)::oid, 'EXECUTE')
            OR has_function_privilege('public', to_regprocedure(l.function_signature)::oid, 'EXECUTE') )
    LOOP
      BEGIN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', lk.function_signature);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   lk.function_signature);
        RAISE NOTICE '[autorevoke] GRANT sweep re-revoked anon/PUBLIC on %', lk.function_signature;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '[autorevoke] GRANT sweep could not revoke on %: %', lk.function_signature, SQLERRM;
      END;
    END LOOP;
  END IF;
END;
$function$;
CREATE EVENT TRIGGER trg_autorevoke_privileged_anon ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION', 'GRANT')
  EXECUTE FUNCTION public.fn_autorevoke_privileged_anon();
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ===========================================================================
-- PHASE 10'S OWN FIXTURE BOUNDARIES.
--
-- THE RELOAD DOOR, production-parity: public.atomic_table_rebuy with the
-- real signature and the real refusals (purchase key required, positive
-- whole cents, the seat locked and present, the club wallet debited only
-- with sufficient chips, one table_pending_addons row the engine resolves,
-- idempotent by key - a replayed key returns the recorded balance and debits
-- nothing). The real body's receipt/freeze stack is proven by its own
-- suites; this harness proves fn_lightning_auto_rebuy goes THROUGH this door
-- and never moves a chip itself.
-- ===========================================================================
CREATE TABLE harness.rebuy_receipts (
  key uuid PRIMARY KEY, user_id uuid, table_id uuid, amount numeric, balance numeric,
  at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid,
                                                     p_amount numeric, p_idempotency_key uuid DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  v_seat    uuid;
  v_club    uuid;
  v_balance numeric;
  r         harness.rebuy_receipts%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Rebuy requires a player, table and purchase key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Rebuy amount must be positive whole cents' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM harness.rebuy_receipts WHERE key = p_idempotency_key;
  IF FOUND THEN
    RETURN r.balance;
  END IF;
  SELECT ts.id INTO v_seat FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   ORDER BY ts.joined_at, ts.id LIMIT 1
     FOR UPDATE;
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;
  SELECT cg.club_id INTO v_club
    FROM public.tables tb JOIN public.cash_games cg ON cg.id = tb.cluster_id
   WHERE tb.id = p_table_id;
  UPDATE public.club_members m
     SET chip_balance = m.chip_balance - p_amount, updated_at = now()
   WHERE m.user_id = p_user_id AND m.club_id = v_club AND m.chip_balance >= p_amount
  RETURNING m.chip_balance INTO v_balance;
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_club;
  END IF;
  INSERT INTO public.table_pending_addons (table_id, user_id, amount, kind)
  VALUES (p_table_id, p_user_id, p_amount, 'rebuy');
  INSERT INTO harness.rebuy_receipts (key, user_id, table_id, amount, balance)
  VALUES (p_idempotency_key, p_user_id, p_table_id, p_amount, v_balance);
  RETURN v_balance;
END $f$;

-- THE CASHIER: the club wallet a rebuy debits.
CREATE FUNCTION harness.fund(p_game uuid, p_user uuid, p_amount numeric) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_club uuid;
BEGIN
  SELECT cg.club_id INTO v_club FROM public.cash_games cg WHERE cg.id = p_game;
  UPDATE public.club_members m SET chip_balance = p_amount, updated_at = now()
   WHERE m.user_id = p_user AND m.club_id = v_club;
  IF NOT FOUND THEN
    INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance, joined_at, updated_at)
    VALUES (v_club, p_user, 'member', 'active', p_amount, now(), now());
  END IF;
END $f$;
CREATE FUNCTION harness.chips(p_game uuid, p_user uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT m.chip_balance FROM public.club_members m
   WHERE m.user_id = p_user AND m.club_id = (SELECT cg.club_id FROM public.cash_games cg WHERE cg.id = p_game);
$f$;
-- THE ENGINE'S ADDON DELIVERY, as production's engine resolves a pending
-- addon between hands: the chips land on the live seat and the row is marked.
CREATE FUNCTION harness.deliver(p_game uuid, p_user uuid) RETURNS numeric LANGUAGE plpgsql AS $f$
DECLARE a record; v_total numeric := 0;
BEGIN
  FOR a IN
    SELECT pa.id, pa.table_id, pa.amount
      FROM public.table_pending_addons pa
      JOIN public.tables tb ON tb.id = pa.table_id
     WHERE tb.cluster_id = p_game AND pa.user_id = p_user AND pa.resolved_at IS NULL
     ORDER BY pa.created_at, pa.id
       FOR UPDATE OF pa
  LOOP
    UPDATE public.table_seats ts SET stack = coalesce(ts.stack, 0) + a.amount
     WHERE ts.table_id = a.table_id AND ts.user_id = p_user AND ts.left_at IS NULL;
    UPDATE public.table_pending_addons pa
       SET resolved_at = clock_timestamp(), applied_to_stack = a.amount
     WHERE pa.id = a.id;
    v_total := v_total + a.amount;
  END LOOP;
  RETURN v_total;
END $f$;
-- Unresolved pending addons of one player in one Cluster.
CREATE FUNCTION harness.pending(p_game uuid, p_user uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.table_pending_addons pa
    JOIN public.tables tb ON tb.id = pa.table_id
   WHERE tb.cluster_id = p_game AND pa.user_id = p_user AND pa.resolved_at IS NULL;
$f$;
-- THE OPERATOR'S CONFIG WRITE: merge keys into the Cluster's lightning object.
CREATE FUNCTION harness.cfg(p_game uuid, p_patch jsonb) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.cash_games cg
     SET ruleset_snapshot = jsonb_set(coalesce(cg.ruleset_snapshot, '{}'::jsonb), '{lightning}',
                                      coalesce(cg.ruleset_snapshot -> 'lightning', '{}'::jsonb) || p_patch)
   WHERE cg.id = p_game;
$f$;
-- Small readers: event counts, the latest payload of a kind, the player's
-- newest pool session row, and the anchor seat's stack.
CREATE FUNCTION harness.evn(p_game uuid, p_kind text) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.cash_cluster_events e WHERE e.game_id = p_game AND e.kind = p_kind;
$f$;
CREATE FUNCTION harness.evlast(p_game uuid, p_kind text) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT e.payload FROM public.cash_cluster_events e WHERE e.game_id = p_game AND e.kind = p_kind
   ORDER BY e.id DESC LIMIT 1;
$f$;
CREATE FUNCTION harness.psrow(p_game uuid, p_player uuid) RETURNS public.lightning_pool_session LANGUAGE sql STABLE AS $f$
  SELECT ps.* FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = p_game AND ps.player_id = p_player
   ORDER BY ps.entered_at DESC, ps.id LIMIT 1;
$f$;
CREATE FUNCTION harness.seat_stack(p_game uuid, p_player uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT ts.stack FROM public.table_seats ts WHERE ts.id = (harness.psrow(p_game, p_player)).anchor_seat_id;
$f$;
-- A NAMED ARRIVAL THAT MAY BE REFUSED: the seat is real, the cash session is
-- real, and whether a pool session opened is the assertion's to make
-- (harness.seat raises when the pool does not follow, which is exactly the
-- wrong tool for a door that is supposed to refuse).
CREATE FUNCTION harness.arrive(p_game uuid, p_user uuid, p_horse boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_seat integer;
BEGIN
  SET CONSTRAINTS ALL DEFERRED;
  SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat
    FROM public.table_seats ts WHERE ts.table_id = harness.feeder(p_game);
  PERFORM public.fxr_join(p_game, harness.feeder(p_game), v_seat, 250.00 + v_seat, p_horse, true, p_user);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM public.fx9_pool(p_game);
END $f$;
-- THE PLAYER'S OWN SELF-EXCLUSION, as fn_rg_self_exclude records it.
CREATE FUNCTION harness.exclude(p_user uuid, p_until timestamptz) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.responsible_gaming_limits (user_id, self_excluded_until)
  VALUES (p_user, p_until)
  ON CONFLICT (user_id) DO UPDATE SET self_excluded_until = EXCLUDED.self_excluded_until, updated_at = now();
$f$;
CREATE FUNCTION harness.cooloff(p_user uuid, p_until timestamptz) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.responsible_gaming_limits (user_id, cooling_off_until)
  VALUES (p_user, p_until)
  ON CONFLICT (user_id) DO UPDATE SET cooling_off_until = EXCLUDED.cooling_off_until, updated_at = now();
$f$;

-- ===========================================================================
-- PRODUCTION'S INTEGRITY GROUND (fixture boundary), column for column as
-- PokerIQ-Production carries the parts the file reads and writes on
-- 2026-10-08. fn_ca_is_cert_account stands in for production's (which also
-- reads ca_cert_accounts and auth.users and keeps every horse out of the
-- certification set); here no planted player is a certification account.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY, username text, display_name text, is_horse boolean DEFAULT false);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS referred_by uuid;
CREATE TABLE IF NOT EXISTS public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, device_name text, ip_address inet,
  user_agent text, last_active timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, device_name, ip_address));
CREATE TABLE IF NOT EXISTS public.ca_collusion_signals (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  detected_at timestamptz NOT NULL DEFAULT now(), window_days integer NOT NULL,
  user_a uuid NOT NULL, user_b uuid NOT NULL, hands_together integer NOT NULL,
  gross_flow numeric NOT NULL, net_flow numeric NOT NULL, direction_ratio numeric NOT NULL,
  both_cert boolean NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT p_user_id IS NOT NULL AND p_user_id::text LIKE '00000000-0000-0000-0000-%';
$f$;
GRANT SELECT, INSERT, UPDATE ON public.profiles, public.user_sessions, public.ca_collusion_signals TO service_role;

-- A HAND WITH ONE WINNER: everyone puts in 2, the winner takes the pot.
CREATE FUNCTION harness.win(p_game uuid, p_players uuid[], p_winner uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_spec jsonb := '{}'::jsonb; p uuid; n integer := cardinality(p_players);
BEGIN
  FOREACH p IN ARRAY p_players LOOP
    v_spec := v_spec || jsonb_build_object(p::text, CASE WHEN p = p_winner
      THEN jsonb_build_object('d', 2 * (n - 1), 'c', 2, 's', true)
      ELSE jsonb_build_object('d', -2, 'c', 2) END);
  END LOOP;
  RETURN harness.play(p_game, p_players, v_spec, 2 * n, ARRAY[p_winner]);
END $f$;
-- k DISTINCT random members of a set (the session's seeded random()).
CREATE FUNCTION harness.pick(p_from uuid[], p_k integer) RETURNS uuid[] LANGUAGE sql VOLATILE AS $f$
  SELECT array_agg(x ORDER BY r) FROM (
    SELECT x, random() AS r FROM unnest(p_from) x ORDER BY r LIMIT p_k) q;
$f$;
-- The Lightning signal rows of a Cluster, as one comparable value.
-- PL/pgSQL, because the tables they read do not exist until the file runs.
CREATE FUNCTION harness.sig_hash(p_game uuid) RETURNS text LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN (SELECT md5(coalesce(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), ''))
            FROM public.lightning_integrity_signal s WHERE s.cluster_id = p_game);
END $f$;
CREATE FUNCTION harness.sign(p_game uuid, p_pattern text) RETURNS integer LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN (SELECT count(*)::integer FROM public.lightning_integrity_signal s
           WHERE s.cluster_id = p_game AND s.pattern_type = p_pattern);
END $f$;
CREATE FUNCTION harness.metrics(p_form numeric, p_p50 numeric, p_p95 numeric, p_bb numeric, p_pos numeric,
                                p_div numeric, p_occ numeric, p_fail numeric) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('formation_success', p_form, 'wait_ms_p50', p_p50, 'wait_ms_p95', p_p95,
                            'bb_fairness', p_bb, 'position_fairness', p_pos, 'opponent_diversity', p_div,
                            'occupancy', p_occ, 'failure_rate', p_fail);
$f$;

-- A REAL STOP and A REAL RETURN: Stop Playing as the player; then the old
-- chair stood up, the cash session closed (the engine's cash-out on
-- departure, a fixture boundary as in the Phase 9 remediation harness) and a
-- fresh arrival through the seat door.
CREATE FUNCTION harness.stop(p_game uuid, p_user uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb;
BEGIN
  PERFORM harness.as_user(p_user);
  r := public.fn_lightning_stop_playing(p_game);
  PERFORM harness.as_user(NULL, NULL);
  IF (r ->> 'exited')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: % did not stop at once: %', p_user, r;
  END IF;
END $f$;
CREATE FUNCTION harness.again(p_game uuid, p_user uuid, p_horse boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = (harness.psrow(p_game, p_user)).anchor_seat_id AND left_at IS NULL;
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'fixture_departure'
   WHERE player_id = p_user AND scope_type = 'cluster' AND scope_id = p_game AND closed_at IS NULL;
  PERFORM harness.seat(p_game, p_user, p_horse);
END $f$;

ASSERT

# ===========================================================================
# THIS PHASE'S GROUND, applied after the Phase 11 file and before the file
# under test: production's operator gate, the managed cron API, the table
# and sequence default privileges, and the harness's readers.
# ===========================================================================
cat > "$fixture/ground12.sql" <<'ASSERT'
-- PRODUCTION'S TABLE AND SEQUENCE DEFAULTS (pg_default_acl for postgres in
-- public, read 2026-10-09): every new table and sequence is born granted to
-- anon, authenticated and service_role. The file must take them back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO anon, authenticated, service_role;

-- PRODUCTION'S GATE GROUND, column for column as PokerIQ-Production carries
-- the parts the gate reads (2026-10-09): profiles.role, clubs.owner_id and
-- clubs.status, club_members.role and status; and the two gate functions
-- verbatim from pg_get_functiondef.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS status text;
-- cash_games.closed_at, a production column (closed games) the earlier fixtures never needed.
ALTER TABLE public.cash_games ADD COLUMN IF NOT EXISTS closed_at timestamptz;
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_can_review_integrity(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_club_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND (
       coalesce(fn_is_platform_admin(), false)
       OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())
       OR EXISTS (
         SELECT 1 FROM club_members cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'co_owner', 'admin')
            AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
       )
     );
$function$;
REVOKE EXECUTE ON FUNCTION public.fn_is_platform_admin(), public.fn_ca_can_review_integrity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin(), public.fn_ca_can_review_integrity(uuid) TO authenticated, service_role;

-- THE MANAGED CRON API (pg_cron 1.6.4's signatures): cron.job is read, and
-- written through cron.schedule, cron.alter_job and cron.unschedule.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (
  jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost', nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(), username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true, jobname text UNIQUE);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $c$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$c$;
CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
                                          database text DEFAULT NULL, username text DEFAULT NULL,
                                          active boolean DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $c$
BEGIN
  UPDATE cron.job j SET schedule = coalesce(alter_job.schedule, j.schedule),
                        command = coalesce(alter_job.command, j.command),
                        database = coalesce(alter_job.database, j.database),
                        username = coalesce(alter_job.username, j.username),
                        active = coalesce(alter_job.active, j.active)
   WHERE j.jobid = job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job % does not exist or you don''t own it', job_id; END IF;
END $c$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $c$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $c$;

-- THE OPERATORS AND THE OTHERS. Club 1 is every fixture Cluster's club; club
-- 2 is somebody else's.
INSERT INTO public.clubs (id, name, union_id, asset)
VALUES ('cb000000-0000-0000-0000-000000000002', 'P12 Other Club', 'c0000000-0000-0000-0000-0000000000f1', 'chips')
ON CONFLICT (id) DO NOTHING;
CREATE TABLE harness.who (k text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO harness.who VALUES
  ('owner', gen_random_uuid()), ('admin', gen_random_uuid()), ('padmin', gen_random_uuid()),
  ('stranger', gen_random_uuid()), ('member', gen_random_uuid()), ('other', gen_random_uuid()),
  ('banned', gen_random_uuid());
UPDATE public.clubs SET owner_id = (SELECT id FROM harness.who WHERE k = 'owner') WHERE id = 'cb000000-0000-0000-0000-000000000001';
UPDATE public.clubs SET owner_id = (SELECT id FROM harness.who WHERE k = 'other') WHERE id = 'cb000000-0000-0000-0000-000000000002';
INSERT INTO public.profiles (id, username, role) SELECT id, k, CASE WHEN k = 'padmin' THEN 'admin' END FROM harness.who;
INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance, joined_at, updated_at)
SELECT 'cb000000-0000-0000-0000-000000000001', id,
       CASE k WHEN 'admin' THEN 'admin' WHEN 'banned' THEN 'admin' ELSE 'member' END,
       CASE k WHEN 'banned' THEN 'banned' ELSE 'active' END, 0, now(), now()
  FROM harness.who WHERE k IN ('admin', 'member', 'banned');
CREATE FUNCTION harness.uid(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT id FROM harness.who WHERE k = p_k;
$f$;
-- AS A NAMED CALLER, as PostgREST names one.
CREATE FUNCTION harness.as_k(p_k text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_k = 'service' THEN PERFORM harness.as_user(NULL, 'service_role');
  ELSIF p_k IS NULL THEN PERFORM harness.as_user(NULL, NULL);
  ELSE PERFORM harness.as_user(harness.uid(p_k), 'authenticated');
  END IF;
END $f$;
-- EVERY KEY AT ANY DEPTH THAT NAMES A CARD, A HOLE, A DECK, A SEED OR A SHUFFLE.
CREATE FUNCTION harness.card_keys(p jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $f$
  SELECT count(*)::integer FROM jsonb_path_query(coalesce(p, 'null'::jsonb), 'strict $.**') q(v)
   CROSS JOIN LATERAL (SELECT jsonb_object_keys(q.v) AS k WHERE jsonb_typeof(q.v) = 'object') kk
   WHERE kk.k ~* '(card|hole|deck|seed|shuffle)';
$f$;
-- THE SET OF KEYS OF AN OBJECT, sorted.
CREATE FUNCTION harness.keys(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(p) k;
$f$;
-- A BODY TEMPORARILY REPLACED (fault injection), and put back from its own
-- pg_get_functiondef.
CREATE TABLE harness.saved (fn text PRIMARY KEY, def text NOT NULL);
CREATE FUNCTION harness.break_fn(p_fn text, p_body text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO harness.saved VALUES (p_fn, pg_get_functiondef(p_fn::regprocedure))
  ON CONFLICT (fn) DO NOTHING;
  EXECUTE p_body;
END $f$;
CREATE FUNCTION harness.restore_fn(p_fn text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  SELECT def INTO STRICT v FROM harness.saved WHERE fn = p_fn;
  EXECUTE v;
  DELETE FROM harness.saved WHERE fn = p_fn;
  IF pg_get_functiondef(p_fn::regprocedure) IS DISTINCT FROM v THEN
    RAISE EXCEPTION 'FIXTURE: % did not come back as it was', p_fn;
  END IF;
END $f$;
-- THE LIGHTNING PAGES OF A KEY, open or not.
CREATE FUNCTION harness.pages(p_key text, p_open boolean DEFAULT NULL) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.financial_alerts fa
   WHERE fa.source = 'lightning_alerts' AND fa.context ->> 'dedupe_key' = p_key
     AND (p_open IS NULL OR fa.resolved IS DISTINCT FROM p_open);
$f$;
-- A CLUSTER'S STATE, every row the sweep must never write, as one value.
CREATE FUNCTION harness.state_hash(p_game uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT md5(concat_ws('|',
    (SELECT to_jsonb(cg)::text FROM public.cash_games cg WHERE cg.id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.lightning_pool_session x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.lightning_pool_slot x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.lightning_reservation x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.lightning_instance x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.hand_id) FROM public.lightning_hand x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.player_id) FROM public.lightning_blind_ledger x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.id) FROM public.cash_cluster_conversion x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(x)::text, ',' ORDER BY x.epoch) FROM public.cash_cluster_epoch x WHERE x.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(ts)::text, ',' ORDER BY ts.id) FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id WHERE tb.cluster_id = p_game),
    (SELECT string_agg(to_jsonb(cs)::text, ',' ORDER BY cs.id) FROM public.cash_player_session cs WHERE cs.scope_type = 'cluster' AND cs.scope_id = p_game)));
$f$;
CREATE TABLE harness.timing (what text, ms numeric);
-- A DOOR AS A NAMED CALLER: the claims PostgREST would set and the role it
-- would run as (anon, authenticated or service_role). An error is answered
-- as {error: sqlstate}, never raised.
CREATE FUNCTION harness.door(p_k text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; v_state text; v_msg text;
BEGIN
  IF p_k = 'anon' THEN PERFORM harness.as_user(NULL, 'anon'); ELSE PERFORM harness.as_k(p_k); END IF;
  EXECUTE 'SET ROLE ' || CASE WHEN p_k = 'service' THEN 'service_role' WHEN p_k = 'anon' THEN 'anon' ELSE 'authenticated' END;
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v := jsonb_build_object('error', v_state, 'message', v_msg);
  END;
  RESET ROLE;
  PERFORM harness.as_user(NULL, NULL);
  RETURN v;
END $f$;
-- THE SWEEP, as cron runs it (the owner, no claims).
CREATE FUNCTION harness.sweep() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM harness.as_user(NULL, NULL);
  EXECUTE 'SELECT public.fn_lightning_alert_sweep(now())' INTO v;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the sweep did not answer: %', v; END IF;
  RETURN v;
END $f$;
-- A FAULT: the function's body replaced by one that raises, same signature.
CREATE FUNCTION harness.break_raise(p_fn text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE o oid := p_fn::regprocedure;
BEGIN
  PERFORM harness.break_fn(p_fn, format(
    'CREATE OR REPLACE FUNCTION %s(%s) RETURNS %s LANGUAGE plpgsql AS $x$BEGIN RAISE EXCEPTION %L; END$x$',
    o::regproc::text, pg_get_function_arguments(o), pg_get_function_result(o), 'HARNESS: injected failure in ' || p_fn));
END $f$;
CREATE FUNCTION harness.epoch(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT cluster_epoch FROM public.cash_games WHERE id = p_game;
$f$;
CREATE FUNCTION harness.club() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT 'cb000000-0000-0000-0000-000000000001'::uuid;
$f$;
CREATE FUNCTION harness.row_of(p_overview jsonb, p_game uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT r FROM jsonb_array_elements(p_overview -> 'clusters') r WHERE r ->> 'cluster_id' = p_game::text;
$f$;

-- 00 THE GROUND, THE FILE IS ABSENT ---------------------------------------------------
DO $$
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF to_regclass('public.lightning_latency_window') IS NOT NULL
     OR to_regclass('public.lightning_alert_sweep_state') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_operator_overview(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_alert_sweep(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_latency_report(uuid,timestamptz,timestamptz,jsonb)') IS NOT NULL
     OR public.fn_lightning_config(NULL) ? 'latency_window_ms'
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lightning-alert-sweep-1m') THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  IF to_regclass('public.lightning_integrity_signal') IS NULL
     OR NOT (public.fn_lightning_config(NULL) ? 'quality_weights') THEN
    RAISE EXCEPTION 'FAIL 00: the Phase 11 file is not installed under it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR (SELECT count(*) FROM pg_default_acl d WHERE d.defaclnamespace = 'public'::regnamespace) < 3 THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACLs + autorevoke) is not installed';
  END IF;
  CREATE TABLE harness.cfg_acl AS
  SELECT r, has_function_privilege(r, 'public.fn_lightning_config(uuid)', 'EXECUTE') AS can
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; no table, door, config key or cron job of the file exists before it; the Phase 11 file is installed; production''s function, table and sequence default ACLs and its autorevoke event trigger are live'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 01 NOTHING BEFORE IT IS FALSIFIED, ONE PROOF SUPERSEDED AND RESTATED -------------
DO $$
DECLARE v_bad text;
BEGIN
  -- p11 #10 said no fn_lightning_ body outside the Phase 11 doors names the
  -- signal store, the shadow ledger or the quality score. The operator doors
  -- and the sweep read them by design; the file restates that proof with
  -- them excluded (its own @live-proof, section 16).
  SELECT string_agg(b.src || '#' || b.n, ', ' ORDER BY b.src, b.n) INTO v_bad
    FROM harness.lp8 b JOIN harness.lp8 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE
     AND NOT (b.src = 'p11' AND b.n = 10);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: the file falsified earlier live proofs: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND ok IS TRUE) < 100
     OR (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND src = 'p11' AND ok IS TRUE) <> 15 THEN
    RAISE EXCEPTION 'FAIL 01: too few predecessor proofs held before the file for this check to mean anything';
  END IF;
  IF (SELECT ok FROM harness.lp8 WHERE phase = 'after' AND src = 'p11' AND n = 10) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL 01: the superseded Phase 11 proof is not the one this file supersedes';
  END IF;
  IF EXISTS (SELECT 1 FROM harness.cfg_acl a
              WHERE has_function_privilege(a.r, 'public.fn_lightning_config(uuid)', 'EXECUTE') IS DISTINCT FROM a.can) THEN
    RAISE EXCEPTION 'FAIL 01: fn_lightning_config changed who may execute it';
  END IF;
END $$;
\echo '  ok  01 NOTHING FALSIFIED  every predecessor live proof (Phases 1 through 11) that held before the file still holds after it except Phase 11''s #10, superseded by design and restated by this file; fn_lightning_config kept exactly who may execute it'

-- 02 WHO MAY OPEN THE DOORS ------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_g2 uuid; v jsonb; k text; d text; v_bad text := '';
        v_doors text[];
BEGIN
  v_g := harness.lc('G');
  -- A Cluster of club 2, for its own owner.
  v_g2 := harness.c8('G2', 6, 2, 1, 1, 1);
  UPDATE public.cash_games SET club_id = 'cb000000-0000-0000-0000-000000000002' WHERE id = v_g2;
  INSERT INTO harness.p8 (k, game, b) VALUES ('g:gate', v_g, v_g2);
  v_doors := ARRAY[
    format('SELECT public.fn_lightning_operator_overview(%L)', harness.club()),
    format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g),
    format('SELECT public.fn_lightning_operator_hand_replay(%L, %L)', v_g, gen_random_uuid()),
    format('SELECT public.fn_lightning_operator_session_trail(%L, %L)', v_g, gen_random_uuid()),
    format('SELECT public.fn_lightning_operator_forensics(%L, NULL, NULL, 10)', v_g),
    format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', 999999999, 'reviewed')];
  -- ANON: no door at all.
  FOREACH d IN ARRAY v_doors || ARRAY[
      format('SELECT public.fn_lightning_latency_report(%L, now() - interval ''1 minute'', now(), ''{}''::jsonb)', v_g),
      'SELECT public.fn_lightning_alert_sweep(now())'] LOOP
    v := harness.door('anon', d);
    IF v ->> 'error' IS DISTINCT FROM '42501' THEN v_bad := v_bad || ' anon:' || d || '=' || coalesce(v::text, 'null'); END IF;
  END LOOP;
  -- AUTHENTICATED CALLERS WHO ARE NOT OPERATORS OF CLUB 1: a stranger, a
  -- plain member, a banned admin, and the owner of another club.
  FOREACH k IN ARRAY ARRAY['stranger', 'member', 'banned', 'other'] LOOP
    FOREACH d IN ARRAY v_doors LOOP
      v := harness.door(k, d);
      IF v ->> 'code' IS DISTINCT FROM 'NOT_AUTHORIZED' OR (v ->> 'ok')::boolean IS DISTINCT FROM false
         OR v ->> 'reason' IS DISTINCT FROM 'NOT_AUTHORIZED' THEN
        v_bad := v_bad || ' ' || k || ':' || d || '=' || coalesce(v::text, 'null');
      END IF;
    END LOOP;
  END LOOP;
  -- THE SERVICE DOORS ARE NOT A BROWSER'S, operator or not.
  FOREACH k IN ARRAY ARRAY['admin', 'padmin'] LOOP
    v := harness.door(k, format('SELECT public.fn_lightning_latency_report(%L, now() - interval ''1 minute'', now(), ''{}''::jsonb)', v_g));
    IF v ->> 'error' IS DISTINCT FROM '42501' THEN v_bad := v_bad || ' ' || k || ':latency=' || v::text; END IF;
    v := harness.door(k, 'SELECT public.fn_lightning_alert_sweep(now())');
    IF v ->> 'error' IS DISTINCT FROM '42501' THEN v_bad := v_bad || ' ' || k || ':sweep=' || v::text; END IF;
  END LOOP;
  -- THE OPERATORS OF CLUB 1: its owner, its admin, a platform admin, the
  -- service. A Cluster that does not exist is NOT_FOUND only to someone who
  -- could have seen it anywhere (a platform admin, the service).
  FOREACH k IN ARRAY ARRAY['owner', 'admin', 'padmin', 'service'] LOOP
    v := harness.door(k, v_doors[1]);
    IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR jsonb_typeof(v -> 'clusters') <> 'array' THEN
      v_bad := v_bad || ' ' || k || ':overview=' || coalesce(v::text, 'null');
    END IF;
    v := harness.door(k, v_doors[2]);
    IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN v_bad := v_bad || ' ' || k || ':cluster=' || coalesce(v::text, 'null'); END IF;
    v := harness.door(k, v_doors[5]);
    IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN v_bad := v_bad || ' ' || k || ':forensics=' || coalesce(v::text, 'null'); END IF;
    v := harness.door(k, format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', gen_random_uuid()));
    IF v ->> 'code' IS DISTINCT FROM (CASE WHEN k IN ('padmin', 'service') THEN 'NOT_FOUND' ELSE 'NOT_AUTHORIZED' END) THEN
      v_bad := v_bad || ' ' || k || ':unknown=' || coalesce(v::text, 'null');
    END IF;
  END LOOP;
  -- THE OTHER CLUB'S OWNER reads only the other club.
  v := harness.door('other', format('SELECT public.fn_lightning_operator_overview(%L)', 'cb000000-0000-0000-0000-000000000002'));
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR jsonb_array_length(v -> 'clusters') <> 1
     OR harness.row_of(v, v_g2) IS NULL THEN
    v_bad := v_bad || ' other:own=' || coalesce(v::text, 'null');
  END IF;
  v := harness.door('other', format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g2));
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN v_bad := v_bad || ' other:own_cluster=' || coalesce(v::text, 'null'); END IF;
  -- A NULL club is refused to everyone, after the gate.
  IF harness.door('stranger', 'SELECT public.fn_lightning_operator_overview(NULL)') ->> 'code' IS DISTINCT FROM 'NOT_AUTHORIZED'
     OR harness.door('service', 'SELECT public.fn_lightning_operator_overview(NULL)') ->> 'code' IS DISTINCT FROM 'INVALID_ARGUMENT' THEN
    v_bad := v_bad || ' null_club';
  END IF;
  -- THE GRANTS, per role, on every new function.
  SELECT v_bad || coalesce(string_agg(' grant:' || p.oid::regprocedure::text, ''), '') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'fn\_lightning\_operator\_%' OR p.proname IN ('fn_lightning_latency_report', 'fn_lightning_latency_regression',
                                                                     'fn_lightning_alert_sweep', 'fn_lightning_alert_raise'))
     AND NOT (has_function_privilege('service_role', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  = (p.proname IN ('fn_lightning_operator_overview', 'fn_lightning_operator_cluster', 'fn_lightning_operator_hand_replay',
                                   'fn_lightning_operator_session_trail', 'fn_lightning_operator_forensics', 'fn_lightning_operator_signal_review'))
              AND array_to_string(p.proconfig, ',') ~ 'search_path=');
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'fn\_lightning\_operator\_%'
             OR p.proname IN ('fn_lightning_latency_report', 'fn_lightning_latency_regression', 'fn_lightning_alert_sweep', 'fn_lightning_alert_raise'))) <> 13 THEN
    v_bad := v_bad || ' function_count';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'FAIL 02: %', v_bad;
  END IF;
END $$;
\echo '  ok  02 WHO MAY OPEN THE DOORS  anon reaches none of the eight doors (42501); a stranger, a plain member, a banned admin and another club''s owner are answered NOT_AUTHORIZED by all six operator doors; no browser caller reaches the latency or sweep doors; club 1''s owner and admin, a platform admin and the service read; an unknown Cluster is NOT_FOUND only to a platform admin or the service; the other owner reads only its own club; grants per role and pinned search_path on all thirteen new functions'

-- 03 THE OVERVIEW AND THE DETAIL, HUMANS AND HORSES -----------------------------------
DO $$
DECLARE v_g uuid; v_h uuid[]; v_z uuid[]; v_hands uuid[] := ARRAY[]::uuid[]; r jsonb; v_inst uuid; v_hand uuid;
        v jsonb; d jsonb; v_row jsonb; v_bad text := ''; v_n integer; x jsonb; v_live uuid; v_folder uuid;
BEGIN
  v_g := harness.lc('S');
  v_h := harness.idle(v_g, false, 8);
  v_z := harness.idle(v_g, true, 4);
  IF cardinality(v_h) <> 8 OR cardinality(v_z) <> 4 THEN RAISE EXCEPTION 'FIXTURE: S has % humans and % horses', cardinality(v_h), cardinality(v_z); END IF;
  v_hands := v_hands || harness.win(v_g, ARRAY[v_h[1], v_h[2], v_z[1]], v_z[1]);
  v_hands := v_hands || harness.win(v_g, ARRAY[v_h[1], v_z[1], v_z[2]], v_h[1]);
  v_hands := v_hands || harness.win(v_g, ARRAY[v_h[1], v_h[2], v_z[2]], v_h[2]);
  -- A HAND STILL LIVE in which a human has fast-folded 2 chips: exposure.
  r := harness.form(v_g, ARRAY[v_h[3], v_h[4], v_z[3]]);
  v_inst := (r ->> 'instance_id')::uuid; v_live := (r ->> 'hand_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  v_folder := v_h[3];
  r := public.fn_lightning_fast_fold(v_live, v_folder, gen_random_uuid(), 'fast', 2);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the fold refused: %', r; END IF;
  -- A FORMATION NOT YET DEALT: committed reservations on a reserved instance.
  r := harness.form(v_g, ARRAY[v_h[5], v_z[4]]);
  INSERT INTO harness.p8 (k, game, a, b, c, j) VALUES ('g:S', v_g, v_folder, v_live, v_h[1],
    jsonb_build_object('hands', to_jsonb(v_hands), 'humans', to_jsonb(v_h), 'horses', to_jsonb(v_z)));

  v := harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club()));
  v_row := harness.row_of(v, v_g);
  IF harness.keys(v) <> 'as_of,club_id,clusters,ok,truncated' THEN v_bad := v_bad || ' overview_keys=' || harness.keys(v); END IF;
  IF harness.keys(v_row) <> 'bb,blind_obligations_open,cluster_epoch,cluster_id,cluster_mode,flags,frozen,handedness,instances,integrity_open_signals,latency,lightning_enabled,live_eligible,mode_since,name,off_threshold,on_threshold,open_alerts,orphan_reservations,pool,reservations,sb,shadow,stuck_conversion,variant,worker_mode' THEN
    v_bad := v_bad || ' row_keys=' || coalesce(harness.keys(v_row), 'none');
  END IF;
  IF harness.keys(v_row -> 'flags') <> 'auto_rebuy,integrity_telemetry,latency_telemetry,shadow_matcher'
     OR harness.keys(v_row -> 'pool') <> 'active,disconnected,eligibility_check,joining,leaving,sit_out'
     OR harness.keys(v_row -> 'reservations') <> 'committed,pending'
     OR harness.keys(v_row -> 'instances') <> 'dealing,forming,reserved,settling' THEN
    v_bad := v_bad || ' nested_keys';
  END IF;
  SELECT count(*) INTO v_n FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.state = 'active';
  IF (v_row -> 'pool' ->> 'active')::integer <> v_n OR v_n < 18 THEN v_bad := v_bad || ' pool_active=' || (v_row -> 'pool')::text || '/' || v_n; END IF;
  IF (v_row -> 'instances' ->> 'dealing')::integer <> 1
     OR (v_row -> 'instances' ->> 'forming')::integer + (v_row -> 'instances' ->> 'reserved')::integer <> 1 THEN
    v_bad := v_bad || ' instances=' || (v_row -> 'instances')::text;
  END IF;
  SELECT count(*) INTO v_n FROM public.lightning_reservation rv WHERE rv.cluster_id = v_g AND rv.state IN ('pending', 'committed');
  IF (v_row -> 'reservations' ->> 'pending')::integer + (v_row -> 'reservations' ->> 'committed')::integer <> v_n OR v_n < 2 THEN
    v_bad := v_bad || ' reservations=' || (v_row -> 'reservations')::text || '/' || v_n;
  END IF;
  IF (v_row ->> 'orphan_reservations')::integer <> 0 OR (v_row ->> 'open_alerts')::integer <> 0
     OR (v_row ->> 'integrity_open_signals')::integer <> 0 OR jsonb_typeof(v_row -> 'frozen') <> 'null'
     OR jsonb_typeof(v_row -> 'stuck_conversion') <> 'null' OR jsonb_typeof(v_row -> 'latency') <> 'null'
     OR jsonb_typeof(v_row -> 'shadow') <> 'null'
     OR v_row ->> 'cluster_mode' <> 'lightning' OR (v_row ->> 'lightning_enabled')::boolean IS NOT TRUE
     OR (v_row ->> 'live_eligible')::integer <> public.fn_cash_cluster_live_eligible(v_g)
     OR (v_row ->> 'on_threshold')::integer <> 18 OR (v_row ->> 'off_threshold')::integer <> 12
     OR (v_row -> 'flags' ->> 'latency_telemetry')::boolean IS NOT TRUE OR (v_row -> 'flags' ->> 'shadow_matcher')::boolean
     OR v_row ->> 'worker_mode' <> 'off'
     OR (v_row ->> 'mode_since')::timestamptz IS DISTINCT FROM
        (SELECT ce.started_at FROM public.cash_cluster_epoch ce WHERE ce.cluster_id = v_g AND ce.ended_at IS NULL) THEN
    v_bad := v_bad || ' row=' || v_row::text;
  END IF;
  -- COUNTS ONLY: no player, human or horse, is named anywhere in the overview.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND strpos(v::text, ps.player_id::text) > 0) THEN
    v_bad := v_bad || ' overview_names_a_player';
  END IF;

  d := harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g));
  IF harness.keys(d) <> 'alerts,blind_ledger,cluster,cluster_id,from,integrity_signals,latency_windows,matcher_passes,ok,quality,reconcile,reservations,shadow_report,to,transitions,window_clamped' THEN
    v_bad := v_bad || ' detail_keys=' || harness.keys(d);
  END IF;
  IF d -> 'cluster' IS DISTINCT FROM v_row THEN
    v_bad := v_bad || ' detail_row_differs';
  END IF;
  -- RECONCILE: one row per open pool session, humans and horses, every one ok,
  -- the folder's pool stack exactly its anchor stack less the 2 it committed.
  SELECT count(*) INTO v_n FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL;
  IF jsonb_array_length(d -> 'reconcile') <> v_n
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'reconcile') q WHERE (q ->> 'ok')::boolean IS NOT TRUE)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'reconcile') q
                     JOIN public.table_seats ts ON ts.id = (q ->> 'anchor_seat_id')::uuid WHERE ts.horse_id IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'reconcile') q
                     JOIN public.table_seats ts ON ts.id = (q ->> 'anchor_seat_id')::uuid WHERE ts.horse_id IS NULL) THEN
    v_bad := v_bad || ' reconcile=' || (d -> 'reconcile')::text;
  END IF;
  SELECT q INTO x FROM jsonb_array_elements(d -> 'reconcile') q WHERE q ->> 'player_id' = v_folder::text;
  IF (x ->> 'exposure')::numeric <> 2 OR (x ->> 'pool_stack')::numeric <> (x ->> 'anchor_stack')::numeric - 2
     OR (x ->> 'pool_stack')::numeric <> public.fn_lightning_pool_stack((x ->> 'pool_session_id')::uuid) THEN
    v_bad := v_bad || ' folder=' || coalesce(x::text, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'transitions') t
                  WHERE t ->> 'kind' = 'conversion' AND t ->> 'to_mode' = 'lightning' AND t ->> 'status' = 'committed') THEN
    v_bad := v_bad || ' transitions_conversion=' || (d -> 'transitions')::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'transitions') t WHERE t ->> 'kind' = 'epoch' AND t ->> 'mode' = 'lightning') THEN
    v_bad := v_bad || ' transitions_epoch=' || (d -> 'transitions')::text;
  END IF;
  IF jsonb_array_length(d -> 'reservations') <> (v_row -> 'reservations' ->> 'pending')::integer + (v_row -> 'reservations' ->> 'committed')::integer
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'reservations') q WHERE (q ->> 'orphan')::boolean) THEN
    v_bad := v_bad || ' reservations=' || (d -> 'reservations')::text;
  END IF;
  IF (d -> 'shadow_report' ->> 'ok')::boolean IS NOT TRUE
     OR jsonb_typeof(d -> 'blind_ledger') <> 'array' OR jsonb_typeof(d -> 'matcher_passes') <> 'array'
     OR jsonb_typeof(d -> 'quality') <> 'null' OR d -> 'latency_windows' <> '[]'::jsonb OR d -> 'alerts' <> '[]'::jsonb THEN
    v_bad := v_bad || ' detail_rest=' || (d - 'reconcile' - 'cluster')::text;
  END IF;
  -- A WINDOW THAT ENDS BEFORE IT BEGINS is refused; ninety days at most.
  IF harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, now(), now() - interval ''1 hour'')', v_g)) ->> 'code' <> 'INVALID_WINDOW'
     OR (harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, now() - interval ''400 days'', now())', v_g)) ->> 'window_clamped')::boolean IS NOT TRUE THEN
    v_bad := v_bad || ' window';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 03: %', v_bad; END IF;
END $$;
\echo '  ok  03 THE OVERVIEW AND THE DETAIL  over a Lightning Cluster of humans and horses with three settled hands, one live hand with a fast fold and one reserved formation, every documented key and no other; pool, reservation and instance counts equal the rows; no player is named in the overview; the detail carries the same v_row, transitions with the committed conversion and the lightning epoch, open reservations, the shadow report, and a reconcile row per open session (humans and horses) all ok, the folder''s pool stack exactly its anchor less the 2 it committed; a reversed window is refused and a long one clamped'

-- 04 REPLAY HAND AND FORENSICS: NO CARD KEY EVER LEAVES AN OPERATOR DOOR -------------
DO $$
DECLARE v_g uuid; v_hand uuid; v_h1 uuid; raw jsonb; f jsonb; rp jsonb; d jsonb; v_bad text := ''; v_at timestamptz;
        v_sig bigint; v_other uuid;
BEGIN
  SELECT game, c, (j -> 'hands' ->> 0)::uuid INTO v_g, v_h1, v_hand FROM harness.p8 WHERE k = 'g:S';
  SELECT lh.settled_at INTO v_at FROM public.lightning_hand lh WHERE lh.hand_id = v_hand;
  -- THE ADVERSARY (fixture boundary): a ledger event of the hand carrying a
  -- player's cards, the deck and the seed, at every depth.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, at)
  VALUES (v_g, 'harness_card_carrier', jsonb_build_object(
    'hand_id', v_hand, 'kept', 1,
    'hole_cards', jsonb_build_object(v_h1::text, jsonb_build_array('As', 'Kd')),
    'deck', jsonb_build_array('2c', '3d'), 'rng_seed', 'feedface',
    'nested', jsonb_build_object('cards', jsonb_build_array('7h'), 'kept_too', 2,
                                 'list', jsonb_build_array(jsonb_build_object('Shuffle_Order', 9, 'fine', 3)))), v_at);
  -- and a signal whose evidence carries one (fixture boundary: the store's
  -- shape rules accept any object).
  INSERT INTO public.lightning_integrity_signal (cluster_id, pattern_type, source, player_a, window_start, window_end,
                                                 suspicion_score, severity, evidence)
  VALUES (v_g, 'SESSION_LENGTH', 'scan', v_h1, now() - interval '2 hours', now() - interval '1 hour', 40, 'medium',
          '{"hours": 13, "hole_cards": ["Ah"]}'::jsonb)
  RETURNING id INTO v_sig;
  raw := public.fn_lightning_cluster_forensics(v_g, now() - interval '1 hour', now() + interval '1 minute', 2000);
  IF harness.card_keys(raw) < 5 THEN v_bad := v_bad || ' the_adversary_is_not_in_the_raw_reader'; END IF;
  f := harness.door('admin', format('SELECT public.fn_lightning_operator_forensics(%L, now() - interval ''1 hour'', now() + interval ''1 minute'', 2000)', v_g));
  IF (f ->> 'ok')::boolean IS NOT TRUE OR harness.card_keys(f) <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f -> 'events') e
                     WHERE e ->> 'kind' = 'harness_card_carrier' AND (e -> 'payload' ->> 'kept')::integer = 1
                       AND (e -> 'payload' -> 'nested' ->> 'kept_too')::integer = 2
                       AND (e -> 'payload' -> 'nested' -> 'list' -> 0 ->> 'fine')::integer = 3)
     OR jsonb_array_length(f -> 'events') <> jsonb_array_length(raw -> 'events')
     OR jsonb_array_length(f -> 'hands') <> jsonb_array_length(raw -> 'hands') THEN
    v_bad := v_bad || ' forensics=' || left(f::text, 400);
  END IF;
  rp := harness.door('admin', format('SELECT public.fn_lightning_operator_hand_replay(%L, %L)', v_g, v_hand));
  IF (rp ->> 'ok')::boolean IS NOT TRUE OR (rp -> 'replay' ->> 'ok')::boolean IS NOT TRUE
     OR harness.card_keys(rp) <> 0
     OR jsonb_array_length(rp -> 'players') <> 3
     OR harness.keys(rp) <> 'cluster_id,events,hand,hand_id,ok,players,replay'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rp -> 'events') e WHERE e ->> 'kind' = 'hand_created')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rp -> 'events') e WHERE e ->> 'kind' = 'hand_settled')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rp -> 'events') e WHERE e ->> 'kind' = 'harness_card_carrier')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rp -> 'players') q
                     WHERE (q ->> 'stack_before')::numeric + (q ->> 'net_result')::numeric = (q ->> 'stack_after')::numeric)
     OR (rp -> 'hand' ->> 'hand_number') IS NULL THEN
    v_bad := v_bad || ' replay=' || left(rp::text, 400);
  END IF;
  -- A HAND OF THIS CLUSTER ASKED THROUGH ANOTHER is not found; so is no hand.
  SELECT game INTO v_other FROM harness.p8 WHERE k = 'g:gate';
  IF harness.door('admin', format('SELECT public.fn_lightning_operator_hand_replay(%L, %L)', v_other, v_hand)) ->> 'code' <> 'NOT_FOUND'
     OR harness.door('admin', format('SELECT public.fn_lightning_operator_hand_replay(%L, %L)', v_g, gen_random_uuid())) ->> 'code' <> 'NOT_FOUND' THEN
    v_bad := v_bad || ' cross_cluster';
  END IF;
  d := harness.door('owner', format('SELECT public.fn_lightning_operator_cluster(%L, now() - interval ''3 hours'', now())', v_g));
  IF harness.card_keys(d) <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'integrity_signals') q
                     WHERE (q ->> 'id')::bigint = v_sig AND (q -> 'evidence' ->> 'hours')::integer = 13) THEN
    v_bad := v_bad || ' detail_signal=' || left((d -> 'integrity_signals')::text, 300);
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 04: %', v_bad; END IF;
END $$;
\echo '  ok  04 NO CARD LEAVES  a ledger event and a signal planted with cards, a deck, a seed and a shuffle at every depth are in the raw service readers; the operator forensics, hand replay and detail carry every other key and value of them and not one of those (the same counts of events and hands); the replay check of a real settled hand is ok with its three players'' arithmetic and its hand_created and hand_settled events; a hand asked through another Cluster, or no hand, is NOT_FOUND'

-- 05 REPLAY PLAYER SESSION AND MODE TRANSITION -----------------------------------------
DO $$
DECLARE v_g uuid; v_h1 uuid; v_z1 uuid; t jsonb; v_bad text := ''; v_n integer; v_s uuid; who uuid;
BEGIN
  SELECT game, c, (j -> 'horses' ->> 0)::uuid INTO v_g, v_h1, v_z1 FROM harness.p8 WHERE k = 'g:S';
  FOREACH who IN ARRAY ARRAY[v_h1, v_z1] LOOP
    v_s := harness.session(v_g, who);
    t := harness.door('admin', format('SELECT public.fn_lightning_operator_session_trail(%L, %L)', v_g, v_s));
    SELECT count(*) INTO v_n FROM public.lightning_hand_player hp
      JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id WHERE sl.pool_session_id = v_s;
    IF (t ->> 'ok')::boolean IS NOT TRUE OR harness.keys(t) <> 'cluster_id,ok,pool_session,trail,transitions'
       OR t -> 'pool_session' ->> 'player_id' <> who::text OR v_n < 2
       OR (SELECT count(*) FROM jsonb_array_elements(t -> 'trail') x WHERE x ->> 'source' = 'hand') <> v_n
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'trail') x WHERE x ->> 'kind' = 'slot_opened')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'trail') x WHERE x ->> 'source' = 'event')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'trail') x WHERE x ->> 'source' = 'reservation')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'trail') WITH ORDINALITY a(x, i)
                    JOIN jsonb_array_elements(t -> 'trail') WITH ORDINALITY b(y, k) ON k = i + 1
                   WHERE (a.x ->> 'at')::timestamptz > (b.y ->> 'at')::timestamptz)
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t -> 'transitions') x WHERE x ->> 'kind' = 'epoch' AND x ->> 'mode' = 'lightning')
       OR (t -> 'pool_session' ->> 'pool_stack')::numeric IS DISTINCT FROM public.fn_lightning_pool_stack(v_s)
       OR harness.card_keys(t) <> 0 THEN
      v_bad := v_bad || ' trail(' || who || ')=' || left(t::text, 600);
    END IF;
  END LOOP;
  -- A SESSION ASKED THROUGH ANOTHER CLUSTER is not found.
  IF harness.door('admin', format('SELECT public.fn_lightning_operator_session_trail(%L, %L)',
                                  (SELECT game FROM harness.p8 WHERE k = 'g:gate'), harness.session(v_g, v_h1))) ->> 'code' <> 'NOT_FOUND' THEN
    v_bad := v_bad || ' cross_cluster';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 05: %', v_bad; END IF;
END $$;
\echo '  ok  05 REPLAY PLAYER SESSION  a human''s and a horse''s pool sessions answer their row, their pool stack, an oldest-first trail of ledger events, the slot, reservations and exactly every hand they played, and the lightning epoch they played in, with no card key; a session asked through another Cluster is NOT_FOUND'

-- 06 A FROZEN CLUSTER IS ONE PAGE, AND IS NEVER TOUCHED -------------------------------
DO $$
DECLARE v_g uuid; v_g2 uuid; v_hand uuid; v_inst uuid; r jsonb; s jsonb; v_hash text; v_bad text := ''; i integer;
        v_key text; v_row jsonb; d jsonb; v_raised integer := 0;
BEGIN
  v_g := harness.lc('F');
  v_hand := harness.win(v_g, harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1), (harness.idle(v_g, true, 1))[1]);
  SELECT lightning_instance_id INTO v_inst FROM public.lightning_hand WHERE hand_id = v_hand;
  -- THE REAL FREEZE, with its own page from lightning_settlement.
  r := public.fn_lightning_settlement_freeze(v_g, harness.epoch(v_g), v_hand, v_inst, gen_random_uuid(),
                                             'harness_unexplained_chip_delta', '{"delta": 1}'::jsonb);
  IF (r ->> 'frozen')::boolean IS NOT TRUE OR (r ->> 'alerted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FIXTURE: the freeze did not freeze and page: %', r;
  END IF;
  v_key := 'lightning_cluster_frozen:' || v_g;
  s := harness.sweep();
  IF harness.pages(v_key) <> 0 OR (s -> 'open' ->> 'frozen')::integer < 1 THEN
    v_bad := v_bad || ' paged_over_an_open_freeze_page=' || s::text;
  END IF;
  -- AN OPERATOR CLOSES THE FREEZE PAGE WHILE THE CLUSTER STAYS FROZEN
  -- (fixture boundary: the Hub's resolve).
  UPDATE public.financial_alerts SET resolved = true, resolved_at = now(), resolution = 'harness: closed by an operator'
   WHERE source = 'lightning_settlement' AND context ->> 'cluster_id' = v_g::text AND NOT resolved;
  v_hash := harness.state_hash(v_g);
  FOR i IN 1 .. 3 LOOP
    s := harness.sweep();
    v_raised := v_raised + (s -> 'raised' ->> 'frozen')::integer;
  END LOOP;
  IF harness.pages(v_key) <> 1 OR harness.pages(v_key, true) <> 1 OR v_raised <> 1 THEN
    v_bad := v_bad || ' pages=' || harness.pages(v_key) || '/' || v_raised;
  END IF;
  IF harness.state_hash(v_g) IS DISTINCT FROM v_hash THEN v_bad := v_bad || ' the_sweep_touched_a_frozen_cluster'; END IF;
  IF (SELECT severity FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> 'critical'
     OR (SELECT message FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) !~ '^LIGHTNING_CLUSTER_FROZEN' THEN
    v_bad := v_bad || ' page_shape';
  END IF;
  v_row := harness.row_of(harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club())), v_g);
  IF v_row ->> 'cluster_mode' <> 'frozen' OR v_row -> 'frozen' ->> 'reason' <> 'stack_invariant_failed'
     OR v_row -> 'frozen' ->> 'invariant' <> 'harness_unexplained_chip_delta' OR (v_row -> 'frozen' ->> 'at') IS NULL
     OR (v_row ->> 'mode_since')::timestamptz IS DISTINCT FROM (v_row -> 'frozen' ->> 'at')::timestamptz
     OR (v_row ->> 'open_alerts')::integer <> 1 THEN
    v_bad := v_bad || ' row=' || v_row::text;
  END IF;
  d := harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g));
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'transitions') t WHERE t ->> 'kind' = 'freeze')
     OR jsonb_array_length(d -> 'alerts') <> 1 OR d -> 'alerts' -> 0 ->> 'check' <> 'frozen' THEN
    v_bad := v_bad || ' detail=' || left(d::text, 300);
  END IF;
  -- A SECOND FROZEN CLUSTER WHOSE OWN PAGE IS STILL OPEN gets no second one.
  v_g2 := harness.lc('F2');
  r := public.fn_lightning_settlement_freeze(v_g2, harness.epoch(v_g2), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                                             'harness_second', '{}'::jsonb);
  s := harness.sweep();
  IF harness.pages('lightning_cluster_frozen:' || v_g2) <> 0 THEN v_bad := v_bad || ' double_page'; END IF;
  -- RECOVERY: the operator's unfreeze; the next pass re-measures and closes
  -- the page.
  r := public.fn_cash_cluster_unfreeze(v_g, harness.uid('admin'), 'harness: recovered after reading the evidence');
  s := harness.sweep();
  IF (s -> 'resolved' ->> 'frozen')::integer <> 1 OR harness.pages(v_key, true) <> 0 OR harness.pages(v_key) <> 1 THEN
    v_bad := v_bad || ' resolve=' || s::text;
  END IF;
  INSERT INTO harness.p8 (k, game, b) VALUES ('g:F', v_g, v_g2);
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 06: %', v_bad; END IF;
END $$;
\echo '  ok  06 FROZEN IS ONE PAGE  a Cluster frozen by the real settlement freeze is not paged again while its own page is open; once an operator closes that page while it stays frozen, three passes raise exactly one critical LIGHTNING_CLUSTER_FROZEN page and change not one of its rows (Cluster, seats, cash sessions, pool, slots, reservations, instances, hands, blind ledger, conversions, epochs); the overview shows the freeze, its reason and invariant and one open alert; a second frozen Cluster with its page open gets none; after the unfreeze the next pass closes the page'

-- 07 A STUCK PENDING_ON AND A FAILED REAP -----------------------------------------------
DO $$
DECLARE v_g uuid; v_conv uuid; s jsonb; r jsonb; v_bad text := ''; v_stuck text; v_reap text; v_row jsonb;
BEGIN
  v_g := harness.c8('P', 6, 7, 2, 7, 2);
  PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_on' THEN RAISE EXCEPTION 'FIXTURE: P is % rather than pending_on', harness.mode(v_g); END IF;
  SELECT id INTO v_conv FROM public.cash_cluster_conversion WHERE cluster_id = v_g AND status = 'pending';
  v_stuck := 'lightning_stuck_conversion:' || v_conv;
  v_reap := 'lightning_reaper_failure:' || v_g;
  s := harness.sweep();
  IF harness.pages(v_stuck) <> 0 THEN v_bad := v_bad || ' paged_a_fresh_conversion'; END IF;
  -- TIME TRAVEL (fixture boundary): the conversion opened thirty minutes ago.
  UPDATE public.cash_cluster_conversion SET opened_at = opened_at - interval '30 minutes' WHERE id = v_conv;
  s := harness.sweep();
  IF (s -> 'raised' ->> 'stuck_conversion')::integer <> 1 THEN v_bad := v_bad || ' not_raised=' || s::text; END IF;
  s := harness.sweep();
  IF (s -> 'raised' ->> 'stuck_conversion')::integer <> 0 OR (s -> 'open' ->> 'stuck_conversion')::integer <> 1
     OR harness.pages(v_stuck) <> 1 THEN
    v_bad := v_bad || ' second_pass=' || s::text;
  END IF;
  v_row := harness.row_of(harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club())), v_g);
  IF v_row -> 'stuck_conversion' ->> 'conversion_id' <> v_conv::text OR v_row -> 'stuck_conversion' ->> 'to_mode' <> 'lightning'
     OR (v_row -> 'stuck_conversion' ->> 'age_ms')::bigint < 1790000
     OR (v_row ->> 'mode_since')::timestamptz <> (SELECT opened_at FROM public.cash_cluster_conversion WHERE id = v_conv) THEN
    v_bad := v_bad || ' row=' || v_row::text;
  END IF;
  -- FAULT: the reaper's abort fails; the reaper records its own failure.
  PERFORM harness.break_raise('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)');
  r := public.fn_cash_cluster_reap_stuck_conversions(interval '15 minutes', clock_timestamp(), 50);
  PERFORM harness.restore_fn('public.fn_cash_cluster_abort_pending_on(uuid,uuid,text)');
  IF harness.evn(v_g, 'lightning_pending_on_reap_failed') <> 1 THEN RAISE EXCEPTION 'FIXTURE: no reap failure was recorded: %', r; END IF;
  s := harness.sweep();
  IF (s -> 'raised' ->> 'reaper_failure')::integer <> 1 OR harness.pages(v_reap) <> 1
     OR (SELECT severity FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_reap) <> 'critical' THEN
    v_bad := v_bad || ' reaper=' || s::text;
  END IF;
  -- THE REAL REAP, now that abort works: the conversion closes and the stuck
  -- page resolves on the next pass; the reaper page is an event page and
  -- stays for a person.
  r := public.fn_cash_cluster_reap_stuck_conversions(interval '15 minutes', clock_timestamp(), 50);
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FIXTURE: the reap did not abort: %', r; END IF;
  s := harness.sweep();
  IF (s -> 'resolved' ->> 'stuck_conversion')::integer <> 1 OR harness.pages(v_stuck, true) <> 0
     OR harness.pages(v_reap, true) <> 1 OR (s -> 'open' ->> 'reaper_failure')::integer <> 1 THEN
    v_bad := v_bad || ' after_reap=' || s::text;
  END IF;
  -- AN OPERATOR CLOSES THE REAPER PAGE: the same failure does not page again.
  UPDATE public.financial_alerts SET resolved = true, resolved_at = clock_timestamp(), resolution = 'harness: read'
   WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_reap;
  s := harness.sweep();
  IF harness.pages(v_reap) <> 1 OR harness.pages(v_reap, true) <> 0 THEN v_bad := v_bad || ' repaged_old_failures'; END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 07: %', v_bad; END IF;
END $$;
\echo '  ok  07 STUCK AND REAPED  a fresh pending_on is not paged; thirty minutes old it raises one critical stuck-conversion page and the next pass keeps that one; the overview names the conversion, its age and its mode_since; a reap whose abort fails records its failure and the sweep raises one critical reaper page; the real reap closes the conversion and the stuck page resolves itself while the reaper page stays open; once an operator closes it the same failure never pages again'

-- 08 DRIVE ERRORS ------------------------------------------------------------------------
DO $$
DECLARE v_g uuid; s jsonb; r jsonb; v_bad text := ''; v_key text; i integer;
BEGIN
  v_g := harness.c8('D', 6, 4, 1, 3, 1);
  v_key := 'lightning_drive_error:' || v_g;
  -- FAULT: the drive's one reader raises; the drive's own sub-block turns
  -- each failure into a lightning_drive_error event and an ok:false answer.
  PERFORM harness.break_raise('public.fn_cash_cluster_lightning_state(uuid)');
  FOR i IN 1 .. 2 LOOP
    r := public.fn_cash_cluster_lightning_drive(v_g);
    IF (r ->> 'ok')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'FIXTURE: the drive did not fail: %', r; END IF;
  END LOOP;
  PERFORM harness.restore_fn('public.fn_cash_cluster_lightning_state(uuid)');
  s := harness.sweep();
  IF harness.pages(v_key) <> 0 THEN v_bad := v_bad || ' paged_under_threshold'; END IF;
  PERFORM harness.break_raise('public.fn_cash_cluster_lightning_state(uuid)');
  r := public.fn_cash_cluster_lightning_drive(v_g);
  PERFORM harness.restore_fn('public.fn_cash_cluster_lightning_state(uuid)');
  IF harness.evn(v_g, 'lightning_drive_error') <> 3 THEN RAISE EXCEPTION 'FIXTURE: % drive errors', harness.evn(v_g, 'lightning_drive_error'); END IF;
  s := harness.sweep();
  IF (s -> 'raised' ->> 'drive_error')::integer <> 1 OR harness.pages(v_key) <> 1
     OR (SELECT (context ->> 'errors')::integer FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> 3
     OR (SELECT jsonb_array_length(context -> 'latest') FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> 3 THEN
    v_bad := v_bad || ' raise=' || s::text;
  END IF;
  s := harness.sweep();
  IF (s -> 'open' ->> 'drive_error')::integer <> 1 OR harness.pages(v_key) <> 1 THEN v_bad := v_bad || ' second=' || s::text; END IF;
  -- The drive works again once its reader does.
  r := public.fn_cash_cluster_lightning_drive(v_g);
  IF (r ->> 'ok')::boolean IS NOT TRUE THEN v_bad := v_bad || ' drive_not_restored'; END IF;
  -- A THRESHOLD IS A CONFIG KEY, CLAMPED: 0 reads as 1 and is reported.
  PERFORM harness.cfg(v_g, '{"alert_drive_errors": 0}'::jsonb);
  IF (public.fn_lightning_config(v_g) ->> 'alert_drive_errors')::integer <> 1
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.fn_lightning_config(v_g) -> 'invalid') x
                     WHERE x ->> 'key' = 'alert_drive_errors' AND x ->> 'reason' = 'out_of_range_clamped') THEN
    v_bad := v_bad || ' clamp';
  END IF;
  PERFORM harness.cfg(v_g, '{"alert_drive_errors": 3}'::jsonb);
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 08: %', v_bad; END IF;
END $$;
\echo '  ok  08 DRIVE ERRORS  three real lightning_drive_error events from an injected reader failure (each an ok:false answer of the drive, never a raise) page once at the threshold of three and not at two; the page carries the count and the latest errors; the next pass keeps the one page; the threshold is a clamped, reported config key'

-- 09 THE INTEGRITY SCAN HAS A CALLER, AND A SPIKE IS PAGED ------------------------------
DO $$
DECLARE v_g uuid; v_p uuid[]; s jsonb; r jsonb; v_bad text := ''; v_key text; v_rep jsonb; v_row jsonb;
BEGIN
  v_g := harness.lc('I');
  PERFORM harness.win(v_g, harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1), (harness.idle(v_g, false, 1))[1]);
  -- Off: never scanned.
  s := harness.sweep();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'integrity_scans') x WHERE x ->> 'cluster_id' = v_g::text)
     OR EXISTS (SELECT 1 FROM public.lightning_alert_sweep_state WHERE key = 'integrity_scan:' || v_g) THEN
    v_bad := v_bad || ' scanned_while_off';
  END IF;
  PERFORM harness.cfg(v_g, '{"integrity_telemetry": true, "alert_integrity_high_signals": 6}'::jsonb);
  s := harness.sweep();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'integrity_scans') x
                  WHERE x ->> 'cluster_id' = v_g::text AND (x ->> 'ok')::boolean)
     OR (SELECT last_at FROM public.lightning_alert_sweep_state WHERE key = 'integrity_scan:' || v_g) IS DISTINCT FROM now() THEN
    v_bad := v_bad || ' not_scanned=' || s::text;
  END IF;
  s := harness.sweep();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'integrity_scans') x WHERE x ->> 'cluster_id' = v_g::text) THEN
    v_bad := v_bad || ' scanned_twice_in_an_hour';
  END IF;
  -- TIME TRAVEL (fixture boundary): the last scan was two hours ago.
  UPDATE public.lightning_alert_sweep_state SET last_at = now() - interval '2 hours' WHERE key = 'integrity_scan:' || v_g;
  s := harness.sweep();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'integrity_scans') x WHERE x ->> 'cluster_id' = v_g::text) THEN
    v_bad := v_bad || ' not_rescanned_next_hour';
  END IF;
  -- FIVE ROBOTIC TIMERS, three humans and two horses, through the engine's
  -- real door: five high DECISION_LATENCY signals.
  v_p := harness.idle(v_g, false, 3) || harness.idle(v_g, true, 2);
  v_rep := jsonb_build_object('window_from', now() - interval '10 minutes', 'window_to', now() - interval '1 minute',
    'players', (SELECT jsonb_agg(jsonb_build_object('player_id', p, 'decisions', 60, 'cv', 0.0, 'fast_share', 0.1)) FROM unnest(v_p) p));
  r := public.fn_lightning_integrity_report(v_g, v_rep, now());
  IF (SELECT count(*) FROM public.lightning_integrity_signal WHERE cluster_id = v_g AND severity = 'high'
        AND pattern_type = 'DECISION_LATENCY') <> 5 THEN
    RAISE EXCEPTION 'FIXTURE: the report wrote %', r;
  END IF;
  v_key := 'lightning_integrity_spike:' || v_g;
  s := harness.sweep();
  IF harness.pages(v_key) <> 0 THEN v_bad := v_bad || ' paged_under_threshold'; END IF;
  PERFORM harness.cfg(v_g, '{"alert_integrity_high_signals": 5}'::jsonb);
  s := harness.sweep();
  IF (s -> 'raised' ->> 'integrity_spike')::integer <> 1 OR harness.pages(v_key) <> 1
     OR (SELECT context -> 'by_pattern' ->> 'DECISION_LATENCY' FROM public.financial_alerts
          WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> '5' THEN
    v_bad := v_bad || ' spike=' || s::text;
  END IF;
  s := harness.sweep();
  IF (s -> 'open' ->> 'integrity_spike')::integer <> 1 OR harness.pages(v_key) <> 1 THEN v_bad := v_bad || ' second=' || s::text; END IF;
  v_row := harness.row_of(harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club())), v_g);
  IF (v_row ->> 'integrity_open_signals')::integer < 5 OR (v_row -> 'flags' ->> 'integrity_telemetry')::boolean IS NOT TRUE
     OR (v_row ->> 'open_alerts')::integer <> 1 THEN
    v_bad := v_bad || ' row=' || v_row::text;
  END IF;
  INSERT INTO harness.p8 (k, game, j) VALUES ('g:I', v_g, jsonb_build_object('report', v_rep, 'players', to_jsonb(v_p)));
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 09: %', v_bad; END IF;
END $$;
\echo '  ok  09 THE SCAN HAS A CALLER  with integrity_telemetry off the sweep never scans; on, it runs fn_lightning_integrity_scan once, records the hour, does not rescan in the same hour and does in the next; five high signals from the engine''s real report (three humans, two horses) page nothing under a threshold of six and one warning page at five, kept on the next pass; the overview counts the open signals and the page'

-- 10 THE LATENCY DOOR ------------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_f timestamptz; v_t timestamptz; v_legs jsonb; r jsonb; r2 jsonb; v_bad text := ''; v_row jsonb;
        q record;
BEGIN
  v_g := harness.lc('L');
  v_t := date_trunc('minute', now()); v_f := v_t - interval '1 minute';
  v_legs := '{"fold_ack": {"n": 40, "p50": 20, "p95": 60, "p99": 90},
              "fast_fold_to_next_hand": {"n": 40, "p50": 800, "p95": 1500, "p99": 2500},
              "hand_to_first_render": {"n": 0, "p50": null, "p95": null, "p99": null}}'::jsonb;
  r := harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', v_g, v_f, v_t, v_legs));
  IF (r ->> 'ok')::boolean IS NOT TRUE OR (r ->> 'idempotent')::boolean OR (r ->> 'legs')::integer <> 3 THEN v_bad := v_bad || ' first=' || r::text; END IF;
  r2 := harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', v_g, v_f, v_t, v_legs));
  IF (r2 ->> 'idempotent')::boolean IS NOT TRUE OR r2 ->> 'id' <> r ->> 'id' THEN v_bad := v_bad || ' replay=' || r2::text; END IF;
  FOR q IN SELECT * FROM (VALUES
      ('different legs', v_f, v_t, jsonb_set(v_legs, '{fold_ack,p95}', '61'), 'IDEMPOTENCY_CONFLICT'),
      ('different end', v_f, v_t + interval '1 second', v_legs, 'IDEMPOTENCY_CONFLICT'),
      ('unknown leg', v_t, v_t + interval '1 minute', '{"teleport_leg": {"n": 1}}'::jsonb, 'UNKNOWN_LEG'),
      ('a hole key', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 1, "hole_ms": 3}}'::jsonb, 'CARRIES_CARDS'),
      ('a deck leg', v_t, v_t + interval '1 minute', '{"deck_shuffle_ms": {"n": 1}}'::jsonb, 'CARRIES_CARDS'),
      ('a seed deep', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 1, "p50": 2, "x": {"rng_seed": 1}}}'::jsonb, 'CARRIES_CARDS'),
      ('an unknown member', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 1, "p75": 3}}'::jsonb, 'INVALID_LEG'),
      ('a fractional count', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 1.5}}'::jsonb, 'INVALID_LEG'),
      ('no count', v_t, v_t + interval '1 minute', '{"fold_ack": {"p50": 3}}'::jsonb, 'INVALID_LEG'),
      ('out of order', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 3, "p50": 9, "p95": 5}}'::jsonb, 'INVALID_LEG'),
      ('negative', v_t, v_t + interval '1 minute', '{"fold_ack": {"n": 3, "p50": -1}}'::jsonb, 'INVALID_LEG'),
      ('a leg not an object', v_t, v_t + interval '1 minute', '{"fold_ack": 5}'::jsonb, 'INVALID_LEG'),
      ('not an object', v_t, v_t + interval '1 minute', '[1]'::jsonb, 'INVALID_LEGS'),
      ('two hours', v_t - interval '2 hours', v_t, '{}'::jsonb, 'INVALID_WINDOW'),
      ('backwards', v_t, v_t - interval '1 minute', '{}'::jsonb, 'INVALID_WINDOW'),
      ('eight days ago', v_t - interval '8 days', v_t - interval '8 days' + interval '1 minute', '{}'::jsonb, 'INVALID_WINDOW'),
      ('an hour ahead', v_t + interval '1 hour', v_t + interval '61 minutes', '{}'::jsonb, 'INVALID_WINDOW')
    ) x(what, f, t, legs, code)
  LOOP
    r2 := harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', v_g, q.f, q.t, q.legs));
    IF r2 ->> 'code' IS DISTINCT FROM q.code OR (r2 ->> 'ok')::boolean IS DISTINCT FROM false THEN
      v_bad := v_bad || ' ' || q.what || '=' || coalesce(r2::text, 'null');
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.lightning_latency_window WHERE cluster_id = v_g) <> 1 THEN v_bad := v_bad || ' a_refusal_wrote'; END IF;
  IF harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', gen_random_uuid(), v_f, v_t, v_legs)) ->> 'code' <> 'CLUSTER_NOT_FOUND'
     OR harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, NULL, %L, %L)', v_g, v_t, v_legs)) ->> 'code' <> 'INVALID_ARGUMENT' THEN
    v_bad := v_bad || ' argument_refusals';
  END IF;
  PERFORM harness.cfg(v_g, '{"latency_telemetry": false}'::jsonb);
  IF harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', v_g, v_t, v_t + interval '1 minute', '{}')) ->> 'code' <> 'TELEMETRY_OFF' THEN
    v_bad := v_bad || ' telemetry_off';
  END IF;
  PERFORM harness.cfg(v_g, '{"latency_telemetry": true}'::jsonb);
  v_row := harness.row_of(harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club())), v_g);
  IF (v_row -> 'latency' ->> 'window_to')::timestamptz <> v_t OR v_row -> 'latency' -> 'legs' <> v_legs THEN
    v_bad := v_bad || ' row=' || v_row::text;
  END IF;
  IF jsonb_array_length(harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g)) -> 'latency_windows') <> 1 THEN
    v_bad := v_bad || ' detail_windows';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 10: %', v_bad; END IF;
END $$;
\echo '  ok  10 THE LATENCY DOOR  the service records a window once and answers the same body idempotent with the same id; a different body or end for the same window is IDEMPOTENCY_CONFLICT; an unknown leg, any card, hole, deck or seed key at any depth, an unknown member, a bad count, missing n, percentiles out of order, a negative, a non-object leg or body, and a window too long, backwards, too old or too far ahead are each refused with their code and write nothing; an unknown Cluster, a missing argument and telemetry switched off are refused; the overview and detail read the window'

-- 11 A LATENCY REGRESSION OVER CONSECUTIVE WINDOWS --------------------------------------
DO $$
DECLARE v_g uuid; v_t timestamptz := date_trunc('minute', now()); s jsonb; r jsonb; v_bad text := ''; v_key text; v_key2 text;
  i integer;
  slow constant jsonb := '{"fast_fold_to_next_hand": {"n": 40, "p50": 3000, "p95": 6000, "p99": 9000},
                           "normal_fold_to_next_hand": {"n": 5, "p50": 90000, "p95": 99000, "p99": 99000}}';
  fast constant jsonb := '{"fast_fold_to_next_hand": {"n": 40, "p50": 300, "p95": 900, "p99": 1200}}';
BEGIN
  v_g := harness.lc('R');
  v_key := 'lightning_latency_regression:' || v_g || ':fast_fold_to_next_hand';
  v_key2 := 'lightning_latency_regression:' || v_g || ':normal_fold_to_next_hand';
  FOR i IN 1 .. 2 LOOP
    r := public.fn_lightning_latency_report(v_g, v_t - make_interval(mins => 4 - i), v_t - make_interval(mins => 3 - i), slow);
    IF (r ->> 'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FIXTURE: %', r; END IF;
  END LOOP;
  s := harness.sweep();
  IF harness.pages(v_key) <> 0 THEN v_bad := v_bad || ' paged_on_two_windows'; END IF;
  r := public.fn_lightning_latency_report(v_g, v_t - interval '1 minute', v_t, slow);
  s := harness.sweep();
  IF (s -> 'raised' ->> 'latency_regression')::integer <> 1 OR harness.pages(v_key) <> 1 OR harness.pages(v_key2) <> 0 THEN
    v_bad := v_bad || ' third=' || s::text || ' thin_leg=' || harness.pages(v_key2);
  END IF;
  IF (SELECT jsonb_array_length(context -> 'windows') FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> 3
     OR (SELECT (context ->> 'ceiling_ms')::integer FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'dedupe_key' = v_key) <> 5000 THEN
    v_bad := v_bad || ' page_context';
  END IF;
  s := harness.sweep();
  IF (s -> 'open' ->> 'latency_regression')::integer <> 1 OR harness.pages(v_key) <> 1 THEN v_bad := v_bad || ' kept=' || s::text; END IF;
  -- A FAST WINDOW: the leg is no longer regressing; the page resolves itself.
  r := public.fn_lightning_latency_report(v_g, v_t, v_t + interval '1 minute', fast);
  s := harness.sweep();
  IF (s -> 'resolved' ->> 'latency_regression')::integer <> 1 OR harness.pages(v_key, true) <> 0 THEN
    v_bad := v_bad || ' resolve=' || s::text;
  END IF;
  -- A CEILING IS A CONFIG KEY: raised to 7000 the slow windows are fine.
  PERFORM harness.cfg(v_g, '{"alert_latency_p95_ms": {"fast_fold_to_next_hand": 7000}}'::jsonb);
  IF (public.fn_lightning_config(v_g) -> 'alert_latency_p95_ms' ->> 'fast_fold_to_next_hand')::integer <> 7000
     OR (public.fn_lightning_config(v_g) -> 'alert_latency_p95_ms' ->> 'fold_ack')::integer <> 500
     OR public.fn_lightning_latency_regression(v_g, 'fast_fold_to_next_hand', public.fn_lightning_config(v_g), v_t - interval '270 seconds') IS NOT NULL
     OR public.fn_lightning_latency_regression(v_g, 'fast_fold_to_next_hand', public.fn_lightning_config(NULL), v_t - interval '270 seconds') IS NULL THEN
    v_bad := v_bad || ' ceiling_config';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 11: %', v_bad; END IF;
END $$;
\echo '  ok  11 A LATENCY REGRESSION  two slow windows page nothing; the third consecutive one raises exactly one warning for fast_fold_to_next_hand, carrying its three windows and the 5000 ms ceiling, and none for a leg whose samples are under the minimum; the next pass keeps it; a fast window resolves it; the ceiling is a per-leg config key'

-- 12 THE SIGNAL REVIEW, AND A RESCAN NEVER UNDOES IT -----------------------------------
DO $$
DECLARE v_g uuid; v_rep jsonb; v_s1 bigint; v_s2 bigint; r jsonb; v_bad text := ''; v_k text; x record;
BEGIN
  SELECT game, j -> 'report' INTO v_g, v_rep FROM harness.p8 WHERE k = 'g:I';
  SELECT id INTO v_s1 FROM public.lightning_integrity_signal WHERE cluster_id = v_g AND pattern_type = 'DECISION_LATENCY' ORDER BY id LIMIT 1;
  SELECT id INTO v_s2 FROM public.lightning_integrity_signal WHERE cluster_id = v_g AND pattern_type = 'DECISION_LATENCY' ORDER BY id OFFSET 1 LIMIT 1;
  FOREACH v_k IN ARRAY ARRAY['stranger', 'member', 'banned', 'other'] LOOP
    IF harness.door(v_k, format('SELECT public.fn_lightning_operator_signal_review(%s, %L, %L)', v_s1, 'cleared', 'x')) ->> 'code' <> 'NOT_AUTHORIZED' THEN
      v_bad := v_bad || ' ' || v_k;
    END IF;
  END LOOP;
  IF harness.door('service', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', v_s1, 'reviewed')) ->> 'code' <> 'REVIEWER_REQUIRED'
     OR harness.door('admin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', v_s1, 'bogus')) ->> 'code' <> 'INVALID_STATUS'
     OR harness.door('admin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', v_s1, 'open')) ->> 'code' <> 'INVALID_STATUS'
     OR harness.door('admin', format('SELECT public.fn_lightning_operator_signal_review(%s, NULL, NULL)', v_s1)) ->> 'code' <> 'INVALID_STATUS'
     OR harness.door('padmin', 'SELECT public.fn_lightning_operator_signal_review(987654321, ''reviewed'', NULL)') ->> 'code' <> 'NOT_FOUND'
     OR harness.door('admin', 'SELECT public.fn_lightning_operator_signal_review(987654321, ''reviewed'', NULL)') ->> 'code' <> 'NOT_AUTHORIZED' THEN
    v_bad := v_bad || ' refusals';
  END IF;
  IF (SELECT status FROM public.lightning_integrity_signal WHERE id = v_s1) <> 'open' THEN v_bad := v_bad || ' a_refusal_wrote'; END IF;
  r := harness.door('admin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, %L)', v_s1, 'reviewed', '  Looked at the timing.  '));
  IF (r ->> 'ok')::boolean IS NOT TRUE OR (r ->> 'idempotent')::boolean OR r ->> 'status' <> 'reviewed' OR r ->> 'previous_status' <> 'open'
     OR r ->> 'reviewed_by' <> harness.uid('admin')::text OR r ->> 'notes' <> 'Looked at the timing.'
     OR harness.keys(r) <> 'cluster_id,idempotent,notes,ok,previous_status,reviewed_at,reviewed_by,signal_id,status' THEN
    v_bad := v_bad || ' reviewed=' || r::text;
  END IF;
  r := harness.door('admin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', v_s1, 'reviewed'));
  IF (r ->> 'idempotent')::boolean IS NOT TRUE THEN v_bad := v_bad || ' not_idempotent=' || r::text; END IF;
  r := harness.door('padmin', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, NULL)', v_s1, 'actioned'));
  IF r ->> 'status' <> 'actioned' OR r ->> 'notes' <> 'Looked at the timing.' OR r ->> 'reviewed_by' <> harness.uid('padmin')::text THEN
    v_bad := v_bad || ' actioned=' || r::text;
  END IF;
  r := harness.door('owner', format('SELECT public.fn_lightning_operator_signal_review(%s, %L, %L)', v_s2, 'cleared', 'Normal play.'));
  IF r ->> 'status' <> 'cleared' THEN v_bad := v_bad || ' cleared=' || r::text; END IF;
  -- THE AUDIT: one event per real change, none for the idempotent call.
  IF harness.evn(v_g, 'integrity_signal_reviewed') <> 3
     OR (SELECT string_agg((e.payload ->> 'from_status') || '>' || (e.payload ->> 'to_status'), ',' ORDER BY e.id)
           FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'integrity_signal_reviewed') <> 'open>reviewed,reviewed>actioned,open>cleared' THEN
    v_bad := v_bad || ' audit';
  END IF;
  -- A RESCAN AND A RESENT REPORT LEAVE THE OPERATOR'S STATUS ALONE.
  r := public.fn_lightning_integrity_report(v_g, v_rep, now());
  r := public.fn_lightning_integrity_scan(v_g, NULL, NULL);
  FOR x IN SELECT id, status, reviewed_by, notes FROM public.lightning_integrity_signal WHERE id IN (v_s1, v_s2) LOOP
    IF (x.id = v_s1 AND (x.status <> 'actioned' OR x.reviewed_by <> harness.uid('padmin') OR x.notes <> 'Looked at the timing.'))
       OR (x.id = v_s2 AND (x.status <> 'cleared' OR x.reviewed_by <> harness.uid('owner'))) THEN
      v_bad := v_bad || ' rescan_overwrote_' || x.id;
    END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 12: %', v_bad; END IF;
END $$;
\echo '  ok  12 THE SIGNAL REVIEW  non-operators are NOT_AUTHORIZED, the service without a reviewer is REVIEWER_REQUIRED, a bad or open status is INVALID_STATUS, an unknown signal is NOT_FOUND only to a platform admin, and none of them writes; open -> reviewed (note trimmed, reviewer recorded) -> actioned keeps the note, the same review again is idempotent, the owner clears another; three audit events in order; a resent engine report and a rescan leave every operator status, reviewer and note as they were'

-- 13 ONE CHECK'S FAILURE IS A LINE IN THE ANSWER, NOT A FAILED JOB --------------------
DO $$
DECLARE v_g uuid; s jsonb; v_bad text := ''; v_before jsonb; v_after jsonb; r jsonb;
BEGIN
  -- Every estate Cluster's state, before.
  SELECT jsonb_object_agg(cg.id, harness.state_hash(cg.id)) INTO v_before FROM public.cash_games cg
   WHERE cg.lightning_enabled OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'frozen', 'paused', 'draining');
  -- FAULT: the latency reader raises for every Cluster; a new freeze, with
  -- its own page closed, must still be paged in the same pass.
  v_g := harness.lc('F3');
  r := public.fn_lightning_settlement_freeze(v_g, harness.epoch(v_g), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                                             'harness_third', '{}'::jsonb);
  UPDATE public.financial_alerts SET resolved = true, resolved_at = now(), resolution = 'harness: closed'
   WHERE source = 'lightning_settlement' AND context ->> 'cluster_id' = v_g::text AND NOT resolved;
  SELECT jsonb_object_agg(cg.id, harness.state_hash(cg.id)) INTO v_before FROM public.cash_games cg
   WHERE cg.lightning_enabled OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'frozen', 'paused', 'draining');
  PERFORM harness.break_raise('public.fn_lightning_latency_regression(uuid,text,jsonb,timestamp with time zone)');
  s := harness.sweep();
  PERFORM harness.restore_fn('public.fn_lightning_latency_regression(uuid,text,jsonb,timestamp with time zone)');
  IF (s ->> 'ok')::boolean IS NOT TRUE
     OR (s ->> 'errors_total')::integer < (s ->> 'clusters_checked')::integer
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(s -> 'errors') e WHERE e ->> 'check' NOT IN ('latency_regression', 'resolve:latency_regression'))
     OR (s -> 'raised' ->> 'frozen')::integer <> 1 OR harness.pages('lightning_cluster_frozen:' || v_g) <> 1
     OR jsonb_array_length(s -> 'errors') > 50 THEN
    v_bad := v_bad || ' isolation=' || left(s::text, 600);
  END IF;
  -- NO CLUSTER'S STATE MOVED across that pass and the next.
  s := harness.sweep();
  SELECT jsonb_object_agg(cg.id, harness.state_hash(cg.id)) INTO v_after FROM public.cash_games cg
   WHERE cg.lightning_enabled OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'frozen', 'paused', 'draining');
  IF v_after IS DISTINCT FROM v_before THEN v_bad := v_bad || ' state_moved'; END IF;
  IF (s ->> 'errors_total')::integer <> 0 THEN v_bad := v_bad || ' errors_after_restore=' || (s -> 'errors')::text; END IF;
  IF harness.keys(s) <> 'as_of,clusters_checked,errors,errors_total,integrity_scans,ok,open,pruned,raised,rate_limited,resolved'
     OR harness.keys(s -> 'raised') <> 'drive_error,frozen,integrity_spike,latency_regression,reaper_failure,stuck_conversion' THEN
    v_bad := v_bad || ' shape=' || harness.keys(s);
  END IF;
  -- RETENTION: a 31-day-old window is pruned by the next pass, a fresh one kept.
  INSERT INTO public.lightning_latency_window (cluster_id, window_from, window_to, legs)
  VALUES (v_g, now() - interval '31 days', now() - interval '31 days' + interval '1 minute', '{}'::jsonb);
  s := harness.sweep();
  IF (s ->> 'pruned')::integer <> 1 OR EXISTS (SELECT 1 FROM public.lightning_latency_window WHERE window_to < now() - interval '30 days')
     OR NOT EXISTS (SELECT 1 FROM public.lightning_latency_window) THEN
    v_bad := v_bad || ' prune=' || s::text;
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 13: %', v_bad; END IF;
END $$;
\echo '  ok  13 ISOLATED AND HANDS OFF  with one reader raising for every Cluster the pass still answers ok, lists each failure (bounded), and pages a new freeze in the same pass; across passes no estate Cluster''s rows move; the answer has its documented shape; a window older than 30 days is pruned and the rest kept'

-- 14 THE SCHEDULE, THE CONFIG, AND NON-LIGHTNING PLAY ----------------------------------
DO $$
DECLARE c jsonb; v_g uuid; v_bad text := ''; s jsonb; v_row jsonb; v_n integer;
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'lightning-alert-sweep-1m' AND active AND schedule = '* * * * *'
        AND command = 'SET statement_timeout = ''50s''; SELECT public.fn_lightning_alert_sweep();') <> 1 THEN
    v_bad := v_bad || ' cron';
  END IF;
  INSERT INTO harness.p8 (k, j) SELECT 'cron', to_jsonb(j) FROM cron.job j WHERE jobname = 'lightning-alert-sweep-1m';
  c := public.fn_lightning_config(NULL);
  IF (c ->> 'latency_telemetry')::boolean IS NOT TRUE OR (c ->> 'latency_window_ms')::integer <> 60000
     OR (c ->> 'alert_window_ms')::integer <> 600000 OR (c ->> 'alert_stuck_conversion_ms')::integer <> 1200000
     OR (c ->> 'alert_drive_errors')::integer <> 3 OR (c ->> 'alert_reaper_failures')::integer <> 1
     OR (c ->> 'alert_integrity_high_signals')::integer <> 5 OR (c ->> 'alert_latency_windows')::integer <> 3
     OR (c ->> 'alert_latency_min_samples')::integer <> 20
     OR c -> 'alert_latency_p95_ms' <> '{"fold_ack": 500, "ack_to_idle": 500, "idle_to_match": 5000, "match_to_hand": 2000, "hand_to_first_render": 2000, "fast_fold_to_next_hand": 5000, "normal_fold_to_next_hand": 60000, "fold_watch_to_next_hand": 90000}'::jsonb
     OR NOT (c ? 'quality_weights' AND c ? 'integrity_telemetry' AND c ? 'multi_table_limit' AND c ? 'worker_mode' AND c ? 'invalid')
     OR (SELECT count(*) FROM jsonb_object_keys(c)) < 70 THEN
    v_bad := v_bad || ' defaults=' || c::text;
  END IF;
  -- CLAMPED AND REPORTED like every other key.
  v_g := harness.c8('cfg', 6, 2, 1, 1, 1);
  PERFORM harness.cfg(v_g, '{"latency_window_ms": 5, "latency_telemetry": "yes", "alert_latency_windows": 1,
                             "alert_stuck_conversion_ms": 99999999999, "alert_latency_p95_ms": {"fold_ack": 1, "warp": 3}}'::jsonb);
  c := public.fn_lightning_config(v_g);
  IF (c ->> 'latency_window_ms')::integer <> 10000 OR (c ->> 'latency_telemetry')::boolean IS NOT TRUE
     OR (c ->> 'alert_latency_windows')::integer <> 2 OR (c ->> 'alert_stuck_conversion_ms')::integer <> 1200000
     OR (c -> 'alert_latency_p95_ms' ->> 'fold_ack')::integer <> 10
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'latency_window_ms' AND x ->> 'reason' = 'out_of_range_clamped')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'latency_telemetry' AND x ->> 'reason' = 'wrong_type')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'alert_latency_windows')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'alert_stuck_conversion_ms' AND x ->> 'reason' = 'not_an_integer')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'alert_latency_p95_ms.fold_ack')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') x WHERE x ->> 'key' = 'alert_latency_p95_ms' AND x ->> 'reason' = 'unknown_leg') THEN
    v_bad := v_bad || ' clamps=' || (c -> 'invalid')::text;
  END IF;
  -- NON-LIGHTNING PLAY: a must-move game that is not Lightning-enabled is no
  -- part of the sweep's estate and reads zeros on the dashboard.
  v_g := public.fx9_cluster('plain', 6, 40, false);
  PERFORM public.fx9_seat(v_g, 3, 1, false);
  PERFORM public.fx9_seat(v_g, 1, 4, true);
  SELECT count(*) INTO v_n FROM public.cash_games cg
   WHERE cg.lightning_enabled OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'frozen', 'paused', 'draining');
  s := harness.sweep();
  v_row := harness.row_of(harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club())), v_g);
  IF (s ->> 'clusters_checked')::integer <> v_n
     OR v_row ->> 'cluster_mode' <> 'must_move' OR (v_row ->> 'lightning_enabled')::boolean
     OR (v_row -> 'pool' ->> 'active')::integer <> 0 OR (v_row ->> 'open_alerts')::integer <> 0
     OR (v_row ->> 'live_eligible')::integer <> 4 OR jsonb_typeof(v_row -> 'latency') <> 'null'
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g)
     OR EXISTS (SELECT 1 FROM public.financial_alerts WHERE source = 'lightning_alerts' AND context ->> 'cluster_id' = v_g::text) THEN
    v_bad := v_bad || ' plain=' || coalesce(v_row::text, 'missing') || ' checked=' || (s ->> 'clusters_checked') || '/' || v_n;
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 14: %', v_bad; END IF;
END $$;
\echo '  ok  14 THE SCHEDULE AND THE CONFIG  one active lightning-alert-sweep-1m job every minute with its statement timeout, through the managed cron API; every Phase 12 key at its documented default beside every earlier key; out-of-range, wrong-type, non-integer and unknown-leg values clamped or defaulted and reported in invalid; a must-move game without Lightning is outside the sweep and reads zeros'

-- 15 WHAT IT COSTS -----------------------------------------------------------------------
DO $$
DECLARE v_g uuid; i integer; t0 timestamptz; v jsonb; v_t timestamptz := date_trunc('minute', now()); v_bad text := '';
BEGIN
  -- Forty more ordinary Clusters in the club, so the overview reads more than
  -- sixty rows.
  FOR i IN 1 .. 40 LOOP
    v_g := public.fx9_cluster('bulk ' || i, 6, 40, i % 4 = 0);
    PERFORM public.fx9_seat(v_g, 2, 1, false);
    PERFORM public.fx9_seat(v_g, 1, 3, true);
  END LOOP;
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'g:S';
  FOR i IN 1 .. 40 LOOP
    t0 := clock_timestamp();
    v := harness.door('admin', format('SELECT public.fn_lightning_operator_overview(%L)', harness.club()));
    INSERT INTO harness.timing VALUES ('overview', extract(epoch FROM clock_timestamp() - t0) * 1000);
    IF (v ->> 'ok')::boolean IS NOT TRUE OR jsonb_array_length(v -> 'clusters') < 60 THEN v_bad := v_bad || ' overview'; EXIT; END IF;
    t0 := clock_timestamp();
    v := harness.door('admin', format('SELECT public.fn_lightning_operator_cluster(%L, NULL, NULL)', v_g));
    INSERT INTO harness.timing VALUES ('cluster', extract(epoch FROM clock_timestamp() - t0) * 1000);
    t0 := clock_timestamp();
    v := harness.door('service', format('SELECT public.fn_lightning_latency_report(%L, %L, %L, %L)', v_g,
           v_t - make_interval(mins => 100 - i), v_t - make_interval(mins => 99 - i),
           '{"fold_ack": {"n": 40, "p50": 20, "p95": 60, "p99": 90}, "idle_to_match": {"n": 40, "p50": 400, "p95": 900, "p99": 1500}}'));
    INSERT INTO harness.timing VALUES ('latency_report', extract(epoch FROM clock_timestamp() - t0) * 1000);
    IF i <= 20 THEN
      t0 := clock_timestamp();
      v := harness.sweep();
      INSERT INTO harness.timing VALUES ('sweep', extract(epoch FROM clock_timestamp() - t0) * 1000);
    END IF;
  END LOOP;
  IF (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY ms) FROM harness.timing WHERE what = 'overview') > 3000
     OR (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY ms) FROM harness.timing WHERE what = 'sweep') > 5000 THEN
    v_bad := v_bad || ' too_slow';
  END IF;
  IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL 15: %', v_bad; END IF;
END $$;
SELECT format('  perf %s n=%s p50=%sms p95=%sms p99=%sms', what, count(*),
              round(percentile_disc(0.50) WITHIN GROUP (ORDER BY ms), 2),
              round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms), 2),
              round(percentile_disc(0.99) WITHIN GROUP (ORDER BY ms), 2))
  FROM harness.timing GROUP BY what ORDER BY what;
\echo '  ok  15 WHAT IT COSTS  the overview of a club of more than sixty Clusters, the detail of a Lightning Cluster, the latency door and a whole sweep pass, timed above (p95 bounds 3 s and 5 s, far above what they measure)'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 16 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 14
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 16: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  16 THE LIVE PROOFS  all fourteen @live-proof claims of the file evaluate true against this catalogue, after the estate above ran through it'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['public.lightning_latency_window', 'public.lightning_alert_sweep_state', 'public.financial_alerts',
                    'public.lightning_integrity_signal', 'public.cash_cluster_events', 'cron.job']) x(t)
UNION ALL
SELECT 'cron', md5(string_agg(to_jsonb(j)::text, '|' ORDER BY j.jobid)) FROM cron.job j
UNION ALL
SELECT 'latency', md5(coalesce(string_agg(to_jsonb(w)::text, '|' ORDER BY w.id), '')) FROM public.lightning_latency_window w
UNION ALL
SELECT 'state', md5(coalesce(string_agg(to_jsonb(w)::text, '|' ORDER BY w.key), '')) FROM public.lightning_alert_sweep_state w
UNION ALL
SELECT 'config', md5(public.fn_lightning_config(NULL)::text)
UNION ALL
SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
 WHERE c.oid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass,
                 'public.lightning_latency_window_id_seq'::regclass)
UNION ALL
SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
 WHERE i.indrelid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass,
                      'public.lightning_integrity_signal'::regclass)
UNION ALL
SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c
 WHERE c.conrelid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass);
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 17 RE-APPLIABLE ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  CREATE TEMP TABLE rcap2 AS
  SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
  UNION ALL
  SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s', x.t), false, true, '')))[1]::text
    FROM unnest(ARRAY['public.lightning_latency_window', 'public.lightning_alert_sweep_state', 'public.financial_alerts',
                      'public.lightning_integrity_signal', 'public.cash_cluster_events', 'cron.job']) x(t)
  UNION ALL
  SELECT 'cron', md5(string_agg(to_jsonb(j)::text, '|' ORDER BY j.jobid)) FROM cron.job j
  UNION ALL
  SELECT 'latency', md5(coalesce(string_agg(to_jsonb(w)::text, '|' ORDER BY w.id), '')) FROM public.lightning_latency_window w
  UNION ALL
  SELECT 'state', md5(coalesce(string_agg(to_jsonb(w)::text, '|' ORDER BY w.key), '')) FROM public.lightning_alert_sweep_state w
  UNION ALL
  SELECT 'config', md5(public.fn_lightning_config(NULL)::text)
  UNION ALL
  SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
   WHERE c.oid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass,
                   'public.lightning_latency_window_id_seq'::regclass)
  UNION ALL
  SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
   WHERE i.indrelid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass,
                        'public.lightning_integrity_signal'::regclass)
  UNION ALL
  SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c
   WHERE c.conrelid IN ('public.lightning_latency_window'::regclass, 'public.lightning_alert_sweep_state'::regclass);
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a FULL JOIN rcap2 b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 17: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 70 THEN
    RAISE EXCEPTION 'FAIL 17: the capture is too small to prove anything';
  END IF;
  IF (SELECT j ->> 'jobid' FROM harness.p8 WHERE k = 'cron') IS DISTINCT FROM
     (SELECT jobid::text FROM cron.job WHERE jobname = 'lightning-alert-sweep-1m') THEN
    RAISE EXCEPTION 'FAIL 17: the cron job was replaced rather than kept';
  END IF;
END $$;
\echo '  ok  17 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, the configuration answer, the cron row and its jobid, both new tables'' rows, ACLs, RLS and constraints, every index and the alert, signal and event counts exactly as they were'
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
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" -f "$p6" -f "$s6_fixture" -f "$s6" -f "$s6r" -f "$p7" \
  -f "$phase8" -f "$p7r" -f "$fix" -f "$p9d" -f "$p10" -f "$p9r2" \
  -f "$fixture/ground.sql" \
  -f "$p11" \
  -f "$fixture/ground12.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^ lp10_rewrite|^ lp9r2_rewrite|^ lp11_rewrite|^ lp12_rewrite|^-+$|^ *$|^\([0-9]+ rows?\)$|^ +format *$' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# EIGHTEEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 18 ]; then
  echo "FAIL: $oks of the 18 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 12 (DB), 18 sections, under production's default function, table and sequence ACLs and its live autorevoke event trigger, over the real chain through Phase 11 (20261008161509): before the file nothing of it exists; after it no predecessor proof is falsified but the one it supersedes and restates; anon reaches no door and non-operators of the club are NOT_AUTHORIZED everywhere; the overview and detail of a Cluster of humans and horses carry exactly their documented keys and the reconcile stack is exact; no card, hole, deck, seed or shuffle key leaves the forensics, replay, trail or detail doors; a frozen Cluster is one page across passes and is never touched; a stuck pending_on, a failed reap, drive errors, an integrity spike and a latency regression over consecutive windows each page once and the state pages resolve themselves; the latency door is validated, idempotent and refuses cards; the signal review is gated, audited and survives rescans; one failing check never fails the pass; the cron job and the config keys are in place; every @live-proof holds and the file is re-appliable"
