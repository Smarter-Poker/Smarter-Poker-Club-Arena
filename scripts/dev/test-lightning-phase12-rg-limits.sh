#!/usr/bin/env bash
# Lightning Phase 12 carry-forward (the database side): responsible gaming
# limits at the Lightning door, and the auto-rebuy status line.
#
# Proves 20261009143757 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55560 (LIGHTNING_P12_RG_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 11 (20261008161509), in order, exactly as
# test-lightning-phase11-integrity-shadow.sh builds them, then the migration
# under test, twice. Every Cluster is converted ON by the real drive, every
# pool session opened by the real pool door, every hand formed by the real
# barrier, dealt by the real begin_dealing and settled by the real
# settlement; every exit goes through the real widened reaper, every status
# read through the real browser door as the caller PostgREST would name. The
# rows the harness writes itself are fixture boundaries only:
# responsible_gaming_limits rows (the player's own self-exclusion, cooling-off
# and limits, as fn_rg_self_exclude / fn_rg_set_limits write them), club
# wallet funding, the Cluster's own ruleset_snapshot lightning object, the
# engine's pending-addon delivery, and backdated disconnect stamps (time
# travel).
#
# LAW 10.5. Humans and horses sit in every Cluster; a horse that self-excludes
# or cools off is held and exited exactly as a human, and reads its own
# auto-rebuy status exactly as a human. The migration reads neither is_horse
# nor horse_id.
#
# LIGHTNING_P12_RG_MIGRATION overrides the file under test, so mutation
# testing never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function
# privileges and its trg_autorevoke_privileged_anon event trigger (the
# Phase 8 through 11 harness ground, verbatim) before Phase 11 and the file
# under test run.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P12_RG_PORT:-55560}
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
mine=${LIGHTNING_P12_RG_MIGRATION:-$M/20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p12rg-test.XXXXXX")
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
# THE GROUND: the Phase 8 through 11 harness ground, verbatim (its helpers,
# production's function-creation environment, Phase 10's reload door and
# Phase 11's integrity ground), so Phase 11 applies here as it did there.
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
# 00, RUN AFTER PHASE 11 AND BEFORE THE FILE: the ground holds, the file's
# changes are absent, and THE GAP IS WITNESSED: a player whose self-exclusion
# begins mid-session is refused RG_EXCLUDED by the matcher and then left in
# the pool, open, by the reaper.
# ===========================================================================
cat > "$fixture/pre.sql" <<'ASSERT'
-- 00 THE GROUND, AND THE GAP BEFORE THE FILE -------------------------------------------
DO $$
DECLARE v_g uuid; h uuid; v jsonb;
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) ~ 'rg_limit'
     OR pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure) ~ 'auto_rebuy' THEN
    RAISE EXCEPTION 'FAIL 00: a change of the migration under test exists before it is applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger
                  WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d
                     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f') THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACL + autorevoke) is not installed';
  END IF;
  CREATE TABLE harness.acl0 AS
  SELECT f, r, has_function_privilege(r, f::regprocedure, 'EXECUTE') AS can
    FROM unnest(ARRAY['public.fn_lightning_config(uuid)',
                      'public.fn_lightning_pool_status(uuid)',
                      'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
                      'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
                      'public.fn_lightning_pool_enter(uuid,timestamp with time zone)',
                      'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)',
                      'public.fn_lightning_stop_playing(uuid)',
                      'public.fn_lightning_reconnect_state(uuid)']) f,
         unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
  -- THE GAP: an idle human self-excludes mid-session.
  v_g := harness.lc('gap');
  h := (harness.idle(v_g, false, 1))[1];
  PERFORM harness.exclude(h, now() + interval '30 days');
  IF harness.reason(v_g, h, NULL::jsonb) IS DISTINCT FROM 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 00: the matcher does not refuse the excluded player before the file';
  END IF;
  v := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (harness.psrow(v_g, h)).exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 00: the reaper already ends a responsible-gaming refusal before the file: %', v;
  END IF;
  PERFORM harness.as_user(h);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF v IS NULL OR v ? 'auto_rebuy' OR NOT (v ? 'joinable') THEN
    RAISE EXCEPTION 'FAIL 00: pool status before the file is not the four-key answer: %', v;
  END IF;
  INSERT INTO harness.p8 (k, game, a) VALUES ('g:gap', v_g, h);
END $$;
\echo '  ok  00 THE GROUND AND THE GAP  the catcher catches; production''s default ACL and autorevoke trigger are live; before the file the reaper carries no rg_limit and pool status no auto_rebuy; a human who self-excludes mid-session is refused RG_EXCLUDED by the matcher and then left open in the pool by the reaper'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 01 NOTHING BEFORE IT IS FALSIFIED, AND THE DOORS KEEP WHO MAY CALL THEM ---------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ' ORDER BY b.src, b.n) INTO v_bad
    FROM harness.lp8 b JOIN harness.lp8 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: the file falsified earlier live proofs: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'before' AND ok IS TRUE) < 100 THEN
    RAISE EXCEPTION 'FAIL 01: too few predecessor proofs held before the file for this check to mean anything';
  END IF;
  -- PHASE 10, THE PHASE 9 REMEDIATION AND PHASE 11 HOLD IN FULL after the file.
  SELECT string_agg(a.src || '#' || a.n || '=' || coalesce(a.ok::text, 'error'), ', ' ORDER BY a.src, a.n) INTO v_bad
    FROM harness.lp8 a WHERE a.phase = 'after' AND a.src IN ('p10', 'p9r2', 'p11') AND a.ok IS NOT TRUE;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: a Phase 10, 9 remediation or 11 proof does not hold after the file: %', v_bad;
  END IF;
  SELECT string_agg(a.f || ' ' || a.r, ', ') INTO v_bad FROM harness.acl0 a
   WHERE has_function_privilege(a.r, a.f::regprocedure, 'EXECUTE') IS DISTINCT FROM a.can;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 01: a door changed who may execute it: %', v_bad;
  END IF;
END $$;
\echo '  ok  01 NOTHING FALSIFIED  every predecessor live proof that held before the file still holds after it (more than a hundred held), every Phase 10, Phase 9 remediation and Phase 11 proof holds in full, and config, pool status, the reaper, legality, the pool door, auto-rebuy, stop and reconnect keep exactly who may execute them, role by role'

-- 02 THE CASH PARITY PROOF HOLDS AND BITES ----------------------------------------------
DO $$
DECLARE v_e text := (SELECT t.e FROM harness.ptext t WHERE t.n = 3); v_err text;
BEGIN
  IF v_e IS NULL OR v_e !~ 'fn_cash_game_join' THEN
    RAISE EXCEPTION 'FIXTURE: the parity proof is not proof #3';
  END IF;
  IF public.fxr_eval(v_e) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL 02: the parity proof does not hold on the fixture';
  END IF;
  -- A CASH JOIN THAT CONSULTED A LIMIT HELPER THE POOL DOOR DOES NOT: false.
  BEGIN
    EXECUTE $x$CREATE FUNCTION public.fn_cash_game_join(p_game uuid, p_bite integer) RETURNS jsonb
      LANGUAGE plpgsql AS $f$ BEGIN RETURN public.fn_rg_check_deposit(p_game, 1); END $f$ $x$;
    RAISE EXCEPTION 'bite:%', coalesce(public.fxr_eval(v_e)::text, 'error');
  EXCEPTION WHEN raise_exception THEN
    v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'bite:false' THEN
    RAISE EXCEPTION 'FAIL 02: a cash limit helper Lightning does not call did not turn the proof false: %', v_err;
  END IF;
  -- A CASH REBUY THAT CONSULTS THE HELPER THE AUTO-REBUY DOOR ALREADY CALLS: true.
  BEGIN
    EXECUTE $x$CREATE FUNCTION public.atomic_table_rebuy_before_maintenance_announcement_gate(p_user_id uuid, p_bite integer) RETURNS numeric
      LANGUAGE plpgsql AS $f$ BEGIN PERFORM public.fn_rg_require_not_excluded(p_user_id); RETURN 0; END $f$ $x$;
    RAISE EXCEPTION 'bite:%', coalesce(public.fxr_eval(v_e)::text, 'error');
  EXCEPTION WHEN raise_exception THEN
    v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'bite:true' THEN
    RAISE EXCEPTION 'FAIL 02: a cash rebuy helper the auto-rebuy door already calls turned the proof false: %', v_err;
  END IF;
  IF to_regprocedure('public.fn_cash_game_join(uuid,integer)') IS NOT NULL
     OR to_regprocedure('public.atomic_table_rebuy_before_maintenance_announcement_gate(uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'FIXTURE: a bite survived its rollback';
  END IF;
END $$;
\echo '  ok  02 CASH PARITY  the proof that every fn_rg_ helper the cash join, buy-in and rebuy path consults is consulted by the Lightning pool door or auto-rebuy door holds; a cash join that consulted a deposit-limit helper the pool door does not turns it false; a cash rebuy consulting fn_rg_require_not_excluded keeps it true'

-- 03 AN IDLE PLAYER WHOSE LIMIT BEGINS MID-SESSION IS STOPPED, NEVER CASHED OUT ----------
DO $$
DECLARE v_g uuid; h uuid; z uuid; o uuid; r jsonb; ph public.lightning_pool_session; pz public.lightning_pool_session;
        n_left integer; n_exp integer; v_hs numeric; v_zs numeric;
BEGIN
  SELECT game, a INTO v_g, h FROM harness.p8 WHERE k = 'g:gap';
  z := (harness.idle(v_g, true, 1))[1];
  o := (harness.idle(v_g, false, 1, ARRAY[h]))[1];
  -- THE HORSE STARTS A COOLING-OFF; the human's self-exclusion stands from 00.
  PERFORM harness.cooloff(z, now() + interval '1 day');
  IF harness.reason(v_g, z, NULL::jsonb) IS DISTINCT FROM 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 03: the matcher does not refuse the cooling-off horse';
  END IF;
  v_hs := harness.seat_stack(v_g, h); v_zs := harness.seat_stack(v_g, z);
  n_left := harness.evn(v_g, 'pool_player_left'); n_exp := harness.evn(v_g, 'player_expired');
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 2 OR jsonb_array_length(r -> 'errors') <> 0
     OR (SELECT count(*) FROM jsonb_array_elements(r -> 'rows') x
          WHERE (x ->> 'rg_limit')::boolean AND NOT (x ->> 'stopped')::boolean
            AND (x ->> 'player_id')::uuid IN (h, z)) <> 2 THEN
    RAISE EXCEPTION 'FAIL 03: the reaper did not finish both refused sessions as rg_limit: %', r;
  END IF;
  ph := harness.psrow(v_g, h); pz := harness.psrow(v_g, z);
  IF ph.exited_at IS NULL OR ph.exit_reason IS DISTINCT FROM 'rg_limit' OR ph.state IS DISTINCT FROM 'closed'
     OR ph.ending_stack IS DISTINCT FROM v_hs
     OR pz.exited_at IS NULL OR pz.exit_reason IS DISTINCT FROM 'rg_limit' OR pz.state IS DISTINCT FROM 'closed'
     OR pz.ending_stack IS DISTINCT FROM v_zs THEN
    RAISE EXCEPTION 'FAIL 03: the exits are not rg_limit with the seat stack: % %', to_jsonb(ph), to_jsonb(pz);
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl WHERE sl.pool_session_id IN (ph.id, pz.id) AND sl.closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 03: a slot of an exited session is still open';
  END IF;
  -- NEVER CASHED OUT: the anchor seats stand with the same chips, the cash
  -- sessions stay open, exactly as a Stop Playing exit leaves them.
  IF EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.id IN (ph.anchor_seat_id, pz.anchor_seat_id) AND ts.left_at IS NOT NULL)
     OR harness.seat_stack(v_g, h) IS DISTINCT FROM v_hs OR harness.seat_stack(v_g, z) IS DISTINCT FROM v_zs
     OR EXISTS (SELECT 1 FROM public.cash_player_session c
                 WHERE c.id IN (ph.cash_player_session_id, pz.cash_player_session_id) AND c.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 03: the responsible-gaming exit moved a seat, a chip or a cash session';
  END IF;
  IF harness.evn(v_g, 'pool_player_left') IS DISTINCT FROM n_left + 2
     OR harness.evn(v_g, 'player_expired') IS DISTINCT FROM n_exp
     OR (SELECT count(*) FROM public.cash_cluster_events e
          WHERE e.game_id = v_g AND e.kind = 'pool_player_left' AND e.payload ->> 'reason' = 'rg_limit'
            AND (e.payload ->> 'player_id')::uuid IN (h, z)
            AND e.payload ?& ARRAY['cluster_id', 'cluster_epoch', 'pool_session_id', 'anchor_seat_id', 'ending_stack', 'at']) <> 2 THEN
    RAISE EXCEPTION 'FAIL 03: the events are not two pool_player_left rg_limit and no player_expired';
  END IF;
  IF (harness.psrow(v_g, o)).exited_at IS NOT NULL OR harness.reason(v_g, o, NULL::jsonb) = 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 03: a player with no limit was touched';
  END IF;
  -- THE CLIENT'S ENDING: the reconnect door and the summary say rg_limit,
  -- with the seat pointer still the player's (VIEW GAME, tap-only).
  PERFORM harness.as_user(h);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r ->> 'state' IS DISTINCT FROM 'ended' OR r ->> 'exit_reason' IS DISTINCT FROM 'rg_limit'
     OR r ->> 'seat_table_id' IS NULL OR r ->> 'pool_session_id' IS DISTINCT FROM ph.id::text THEN
    PERFORM harness.as_user(NULL, NULL);
    RAISE EXCEPTION 'FAIL 03: the human''s reconnect answer is not the rg_limit ending: %', r;
  END IF;
  r := public.fn_lightning_session_summary(ph.id);
  IF (r ->> 'ended')::boolean IS DISTINCT FROM true OR r ->> 'exit_reason' IS DISTINCT FROM 'rg_limit' THEN
    PERFORM harness.as_user(NULL, NULL);
    RAISE EXCEPTION 'FAIL 03: the summary does not say rg_limit: %', r;
  END IF;
  PERFORM harness.as_user(z);
  r := public.fn_lightning_reconnect_state(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF r ->> 'state' IS DISTINCT FROM 'ended' OR r ->> 'exit_reason' IS DISTINCT FROM 'rg_limit' THEN
    RAISE EXCEPTION 'FAIL 03: the horse''s reconnect answer differs from the human''s: %', r;
  END IF;
  -- THE POOL DOOR KEEPS THEM OUT, and a second pass exits nothing more.
  IF public.fn_lightning_pool_enter(ph.anchor_seat_id) IS NOT NULL OR public.fn_lightning_pool_enter(pz.anchor_seat_id) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: the pool door let a refused player back in';
  END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 03: a second pass exited again: %', r;
  END IF;
END $$;
\echo '  ok  03 STOPPED, NEVER CASHED OUT  the self-excluded human and the cooling-off horse are exited by the reaper with exit_reason rg_limit, state closed, slot closed, ending stack equal to the seat; seats, chips and cash sessions untouched; two pool_player_left rg_limit, no player_expired; reconnect and summary answer the rg_limit ending with the seat pointer; the pool door keeps them out; a player without a limit is untouched; a second pass exits nothing'

-- 04 A LIMIT THAT BEGINS MID-HAND FINISHES THE HAND FIRST ---------------------------------
DO $$
DECLARE v_g uuid; h uuid; z uuid; o uuid; r jsonb; v_inst uuid; v_hand uuid;
        ph public.lightning_pool_session; pz public.lightning_pool_session; v_h0 numeric; v_z0 numeric;
BEGIN
  v_g := harness.lc('inhand');
  h := (harness.idle(v_g, false, 1))[1];
  z := (harness.idle(v_g, true, 1))[1];
  o := (harness.idle(v_g, false, 1, ARRAY[h]))[1];
  v_h0 := harness.seat_stack(v_g, h); v_z0 := harness.seat_stack(v_g, z);
  r := harness.form(v_g, ARRAY[h, z, o]);
  v_inst := (r ->> 'instance_id')::uuid; v_hand := (r ->> 'hand_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  PERFORM harness.exclude(h, now() + interval '30 days');
  PERFORM harness.cooloff(z, now() + interval '1 day');
  IF harness.reason(v_g, h, NULL::jsonb) IS DISTINCT FROM 'RG_EXCLUDED'
     OR harness.reason(v_g, z, NULL::jsonb) IS DISTINCT FROM 'RG_EXCLUDED'
     OR harness.reason(v_g, o, NULL::jsonb) IS DISTINCT FROM 'IN_HAND'
     OR harness.detail(v_g, h, NULL::jsonb) -> 'responsible_gaming' ->> 'error' IS DISTINCT FROM 'self_excluded'
     OR harness.detail(v_g, z, NULL::jsonb) -> 'responsible_gaming' ->> 'error' IS DISTINCT FROM 'cooling_off' THEN
    RAISE EXCEPTION 'FAIL 04: the matcher would deal a limited player another hand';
  END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 0
     OR (SELECT count(*) FROM jsonb_array_elements(r -> 'skipped') x
          WHERE (x ->> 'player_id')::uuid IN (h, z) AND x ->> 'reason' = 'in_hand_or_reserved') <> 2
     OR (harness.psrow(v_g, h)).exited_at IS NOT NULL OR (harness.psrow(v_g, z)).exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 04: the reaper cut a live hand short: %', r;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := harness.settle(v_hand, gen_random_uuid(),
         harness.results(v_hand, jsonb_build_object(
           h::text, jsonb_build_object('d', -2, 'c', 2),
           z::text, jsonb_build_object('d', 4, 'c', 2, 's', true),
           o::text, jsonb_build_object('d', -2, 'c', 2))), 0, 0,
         jsonb_build_object('pot_size', 6, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', z, 'amount', 6, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the settlement refused: %', r;
  END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  ph := harness.psrow(v_g, h); pz := harness.psrow(v_g, z);
  IF ph.exit_reason IS DISTINCT FROM 'rg_limit' OR pz.exit_reason IS DISTINCT FROM 'rg_limit'
     OR harness.seat_stack(v_g, h) IS DISTINCT FROM v_h0 - 2 OR harness.seat_stack(v_g, z) IS DISTINCT FROM v_z0 + 4
     OR ph.ending_stack IS DISTINCT FROM v_h0 - 2 OR pz.ending_stack IS DISTINCT FROM v_z0 + 4
     OR (harness.psrow(v_g, o)).exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 04: after the hand the limited players are not exited rg_limit on their settled stacks: % % %', r, to_jsonb(ph), to_jsonb(pz);
  END IF;
END $$;
\echo '  ok  04 THE HAND FINISHES FIRST  a human self-excludes and a horse cools off inside a dealt hand: the matcher answers RG_EXCLUDED (self_excluded, cooling_off) so no new hand is dealt, the reaper skips both as in_hand_or_reserved, the hand settles through the real door, and the next pass exits both with rg_limit on their settled stacks (-2 and +4); the unlimited third player stays'

-- 05 PRECEDENCE, AND THE LIMITS NORMAL CASH DOES NOT ENFORCE -----------------------------
DO $$
DECLARE v_g uuid; s uuid; q uuid; d uuid; e uuid; xp uuid; l uuid; r jsonb; v_inst uuid; v_hand uuid;
        n_exp integer; v_last jsonb;
BEGIN
  v_g := harness.lc('prec');
  s := (harness.idle(v_g, false, 1))[1];
  q := (harness.idle(v_g, true, 1))[1];
  d := (harness.idle(v_g, false, 1, ARRAY[s]))[1];
  e := (harness.idle(v_g, true, 1, ARRAY[q]))[1];
  xp := (harness.idle(v_g, false, 1, ARRAY[s, d]))[1];
  l := (harness.idle(v_g, true, 1, ARRAY[q, e]))[1];
  -- (a) A STOPPER IN A HAND WHO THEN SELF-EXCLUDES: the player chose first.
  r := harness.form(v_g, ARRAY[s, q]);
  v_inst := (r ->> 'instance_id')::uuid; v_hand := (r ->> 'hand_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  PERFORM harness.as_user(s);
  r := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (r ->> 'exited')::boolean IS TRUE THEN
    RAISE EXCEPTION 'FIXTURE: a stopper in a live hand exited at once: %', r;
  END IF;
  PERFORM harness.exclude(s, now() + interval '30 days');
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := harness.settle(v_hand, gen_random_uuid(),
         harness.results(v_hand, jsonb_build_object(s::text, jsonb_build_object('d', -2, 'c', 2),
                                                    q::text, jsonb_build_object('d', 2, 'c', 2, 's', true))), 0, 0,
         jsonb_build_object('pot_size', 4, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', q, 'amount', 4, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the settlement refused: %', r;
  END IF;
  -- (b) A DISCONNECT PAST ITS TIMEOUT WHOSE PLAYER ALSO COOLS OFF, and (c) A
  -- PLAIN EXPIRED DISCONNECT beside it.
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[d, e], NULL);
  -- TIME TRAVEL (fixture boundary): the stamps age past the 180s default.
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE cluster_id = v_g AND player_id IN (d, e) AND exited_at IS NULL;
  PERFORM harness.cooloff(d, now() + interval '2 hours');
  -- (d) A SELF-EXCLUSION THAT HAS ALREADY ENDED, and (e) EVERY LIMIT NORMAL
  -- CASH DOES NOT ENFORCE: loss, session time, deposits, reality check.
  PERFORM harness.exclude(xp, now() - interval '1 minute');
  INSERT INTO public.responsible_gaming_limits
    (user_id, daily_loss_limit, session_time_limit_minutes, daily_deposit_limit, weekly_deposit_limit,
     monthly_deposit_limit, reality_check_interval_minutes)
  VALUES (l, 1, 15, 1, 1, 1, 5);
  n_exp := harness.evn(v_g, 'player_expired');
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (harness.psrow(v_g, s)).exit_reason IS DISTINCT FROM 'stop_playing'
     OR (harness.psrow(v_g, d)).exit_reason IS DISTINCT FROM 'rg_limit'
     OR (harness.psrow(v_g, e)).exit_reason IS DISTINCT FROM 'disconnect_expired' THEN
    RAISE EXCEPTION 'FAIL 05: the exit reasons are not stop_playing, rg_limit, disconnect_expired: %', r;
  END IF;
  v_last := harness.evlast(v_g, 'player_expired');
  IF harness.evn(v_g, 'player_expired') IS DISTINCT FROM n_exp + 1
     OR (SELECT array_agg((x ->> 'player_id')::uuid) FROM jsonb_array_elements(v_last -> 'players') x) IS DISTINCT FROM ARRAY[e]
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_last -> 'players') x WHERE x ? 'rg_limit' OR x ? 'stopped') THEN
    RAISE EXCEPTION 'FAIL 05: player_expired is not exactly the plain expired disconnect in its own shape: %', v_last;
  END IF;
  IF (harness.psrow(v_g, xp)).exited_at IS NOT NULL OR (harness.psrow(v_g, l)).exited_at IS NOT NULL
     OR harness.reason(v_g, xp, NULL::jsonb) = 'RG_EXCLUDED' OR harness.reason(v_g, l, NULL::jsonb) = 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 05: an ended exclusion or a limit normal cash does not enforce stopped a player';
  END IF;
END $$;
\echo '  ok  05 PRECEDENCE AND PARITY  a stopper who self-excludes mid-hand exits stop_playing; an expired disconnect that is also cooling off exits rg_limit and is never in player_expired, which carries only the plain expired disconnect in its own shape; an ended self-exclusion and a player carrying loss, session-time, deposit and reality-check limits (enforced by no normal cash door) play on, exactly as at a cash table'

-- 06 THE AUTO-REBUY STATUS LINE: THE CALLER'S OWN, HUMANS AND HORSES ALIKE ---------------
DO $$
DECLARE v_g uuid; h uuid; z uuid; u uuid := gen_random_uuid(); v jsonb; v2 jsonb; c jsonb; r jsonb;
        v_amount numeric; k text;
BEGIN
  v_g := harness.lc('status');
  h := (harness.idle(v_g, false, 1))[1];
  z := (harness.idle(v_g, true, 1))[1];
  PERFORM harness.as_user(h);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(z);
  v2 := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF NOT (v ?& ARRAY['players', 'status', 'joinable', 'multi_table_limit', 'auto_rebuy']) OR v ? 'cluster_mode'
     OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 5
     OR v -> 'auto_rebuy' IS DISTINCT FROM '{"enabled": false, "trigger": "zero", "threshold_bb": 1, "threshold_pct": 25, "target": "initial", "max_count": 3, "session_cap": 0, "used_count": 0, "used_total": 0}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: the default answer is not the five-key contract with auto_rebuy off: %', v;
  END IF;
  IF v2 -> 'auto_rebuy' IS DISTINCT FROM v -> 'auto_rebuy' OR (v2 - 'auto_rebuy') IS DISTINCT FROM (v - 'auto_rebuy') THEN
    RAISE EXCEPTION 'FAIL 06: the horse reads differently from the human: % %', v, v2;
  END IF;
  -- A CALLER WITH NO SESSION HERE, AND THE ENGINE: settings, no usage.
  PERFORM harness.as_user(u);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, 'service_role');
  v2 := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF v -> 'auto_rebuy' -> 'used_count' IS DISTINCT FROM 'null'::jsonb OR v -> 'auto_rebuy' -> 'used_total' IS DISTINCT FROM 'null'::jsonb
     OR (v -> 'auto_rebuy' ->> 'max_count')::integer IS DISTINCT FROM 3
     OR v2 -> 'auto_rebuy' -> 'used_count' IS DISTINCT FROM 'null'::jsonb OR (v2 -> 'auto_rebuy' ->> 'enabled')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 06: a caller without a session or the engine read usage: % %', v, v2;
  END IF;
  IF public.fn_lightning_pool_status(v_g) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: nobody got an answer';
  END IF;
  -- THE SETTINGS ARE fn_lightning_config'S, its clamps included.
  PERFORM harness.cfg(v_g, '{"auto_rebuy_enabled": true, "auto_rebuy_trigger": "below_bb", "auto_rebuy_threshold_bb": 500, "auto_rebuy_target": "max", "auto_rebuy_max_count": 3, "auto_rebuy_session_cap": 100000}'::jsonb);
  c := public.fn_lightning_config(v_g);
  PERFORM harness.as_user(h);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  FOREACH k IN ARRAY ARRAY['enabled', 'trigger', 'threshold_bb', 'threshold_pct', 'target', 'max_count', 'session_cap'] LOOP
    IF v -> 'auto_rebuy' -> k IS DISTINCT FROM c -> ('auto_rebuy_' || k) THEN
      RAISE EXCEPTION 'FAIL 06: % differs from fn_lightning_config: % %', k, v -> 'auto_rebuy', c;
    END IF;
  END LOOP;
  IF (v -> 'auto_rebuy' ->> 'threshold_bb')::numeric IS DISTINCT FROM 100 OR (v -> 'auto_rebuy' ->> 'enabled')::boolean IS NOT TRUE
     OR v -> 'auto_rebuy' ->> 'target' IS DISTINCT FROM 'max' THEN
    RAISE EXCEPTION 'FAIL 06: the clamp did not carry: %', v;
  END IF;
  PERFORM harness.cfg(v_g, '{"auto_rebuy_threshold_bb": 20}'::jsonb);
  -- A REAL AUTO-REBUY SHOWS AS USED: the human busts to the horse, the
  -- reload door tops up, the engine delivers.
  v_amount := harness.seat_stack(v_g, h);
  PERFORM harness.play(v_g, ARRAY[h, z],
    jsonb_build_object(h::text, jsonb_build_object('d', -v_amount, 'c', v_amount),
                       z::text, jsonb_build_object('d', v_amount, 'c', v_amount, 's', true)),
    2 * v_amount, ARRAY[z]);
  PERFORM harness.fund(v_g, h, 100000);
  r := public.fn_lightning_auto_rebuy(v_g, h);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the human''s auto-rebuy refused: %', r;
  END IF;
  PERFORM harness.deliver(v_g, h);
  PERFORM harness.as_user(h);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(z);
  v2 := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v -> 'auto_rebuy' ->> 'used_count')::integer IS DISTINCT FROM 1
     OR (v -> 'auto_rebuy' ->> 'used_total')::numeric IS DISTINCT FROM (harness.psrow(v_g, h)).auto_rebuy_total
     OR (harness.psrow(v_g, h)).auto_rebuy_total <= 0
     OR (v2 -> 'auto_rebuy' ->> 'used_count')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 06: the used count is not the caller''s own: % %', v, v2;
  END IF;
  -- THE HORSE REBUYS AND READS EXACTLY AS THE HUMAN.
  v_amount := harness.seat_stack(v_g, z);
  PERFORM harness.play(v_g, ARRAY[h, z],
    jsonb_build_object(z::text, jsonb_build_object('d', -v_amount, 'c', v_amount),
                       h::text, jsonb_build_object('d', v_amount, 'c', v_amount, 's', true)),
    2 * v_amount, ARRAY[h]);
  PERFORM harness.fund(v_g, z, 100000);
  r := public.fn_lightning_auto_rebuy(v_g, z);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the horse''s auto-rebuy refused: %', r;
  END IF;
  PERFORM harness.deliver(v_g, z);
  PERFORM harness.as_user(z);
  v2 := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v2 -> 'auto_rebuy' ->> 'used_count')::integer IS DISTINCT FROM 1
     OR (v2 -> 'auto_rebuy' ->> 'used_total')::numeric IS DISTINCT FROM (harness.psrow(v_g, z)).auto_rebuy_total THEN
    RAISE EXCEPTION 'FAIL 06: the horse''s status differs from the human''s: %', v2;
  END IF;
  -- STOPPED, THE CALLER HAS NO OPEN SESSION: settings, no usage.
  PERFORM harness.stop(v_g, h);
  PERFORM harness.as_user(h);
  v := public.fn_lightning_pool_status(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF v -> 'auto_rebuy' -> 'used_count' IS DISTINCT FROM 'null'::jsonb OR (v -> 'auto_rebuy' ->> 'max_count')::integer IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 06: an exited caller still reads usage: %', v;
  END IF;
END $$;
\echo '  ok  06 THE AUTO-REBUY STATUS  pool status answers exactly players, status, joinable, multi_table_limit and auto_rebuy (never cluster_mode); off by default {enabled false, zero, 1, 25, initial, 3, 0, used 0 and 0}; a horse reads exactly as a human; a caller without a session, the engine and an exited caller read settings with null usage, nobody reads nothing; every setting is fn_lightning_config''s own including the 500 → 100 clamp; after a real auto-rebuy through the reload door the caller (human, then horse) reads used_count 1 and its own used_total'

-- 07 WHO MAY CALL -----------------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_err text;
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'g:gap';
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_config(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN
    RAISE EXCEPTION 'FAIL 07: authenticated reads the configuration: %', v_err;
  END IF;
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_reap_expired_disconnects(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN
    RAISE EXCEPTION 'FAIL 07: authenticated reaches the reaper: %', v_err;
  END IF;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_pool_status(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN
    RAISE EXCEPTION 'FAIL 07: anon reaches pool status: %', v_err;
  END IF;
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_pool_status(%L)', v_g));
  RESET ROLE;
  IF v_err IS DISTINCT FROM 'no error' THEN
    RAISE EXCEPTION 'FAIL 07: authenticated cannot read pool status: %', v_err;
  END IF;
END $$;
\echo '  ok  07 WHO MAY CALL  authenticated is refused fn_lightning_config (still the service''s alone) and the reaper; anon is refused pool status; authenticated reads pool status'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 08 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 8
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 08: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  08 THE LIVE PROOFS  all eight @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%' OR p.proname LIKE 'fn_rg_%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_pool_session', 'lightning_pool_slot', 'cash_cluster_events', 'responsible_gaming_limits']) x(t)
UNION ALL
SELECT 'sessions', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_pool_session s;
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 09 RE-APPLIABLE ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  CREATE TEMP TABLE rcap2 AS
  SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%' OR p.proname LIKE 'fn_rg_%')
  UNION ALL
  SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
    FROM unnest(ARRAY['lightning_hand', 'lightning_pool_session', 'lightning_pool_slot', 'cash_cluster_events', 'responsible_gaming_limits']) x(t)
  UNION ALL
  SELECT 'sessions', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_pool_session s;
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a FULL JOIN rcap2 b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 09: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 09: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  09 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_, fn_cash_cluster and fn_rg_ body, ACL and comment, every pool session row, and the hand, slot, event and limits counts exactly as they were'
ASSERT

# The file's own proof texts, for section 02's bite (quoted exactly as the
# evaluator quotes them, never through the shell).
gen_texts() {
  local n=0 line expr
  printf '%s\n' "CREATE TABLE harness.ptext (n integer PRIMARY KEY, e text NOT NULL);"
  while IFS= read -r line; do
    n=$((n + 1))
    expr=${line#-- @live-proof: }
    printf '%s\n' "INSERT INTO harness.ptext VALUES ($n, \$lpq\$${expr}\$lpq\$);"
  done < <(grep -- '^-- @live-proof: ' "$mine")
}

{ predecessor_proofs before; } > "$fixture/proofs-before.sql"
{ predecessor_proofs after; } > "$fixture/proofs-after.sql"
{ gen_texts; } > "$fixture/own-texts.sql"
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
  -f "$fixture/pre.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/own-texts.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^ lp10_rewrite|^ lp9r2_rewrite|^ lp11_rewrite|^ lp12_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# TEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 10 ]; then
  echo "FAIL: $oks of the 10 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 12 RG limits and auto-rebuy status (DB), 10 sections, under production's default function ACLs and its live autorevoke event trigger, over the real chain through Phase 11 (20261008161509): before the file a mid-session self-exclusion leaves the player open in the pool; after it no predecessor proof is falsified and Phases 10, 9r and 11 hold in full; the cash parity proof holds and bites; an idle self-excluded human and cooling-off horse are exited rg_limit without a seat, chip or cash session moving; a limit that begins mid-hand finishes the hand first; stop_playing outranks rg_limit, rg_limit never counts as an expired disconnect, and the limits normal cash does not enforce stop nobody; pool status answers the caller's own auto-rebuy status from fn_lightning_config for humans and horses alike; fn_lightning_config stays the service's alone; every @live-proof holds and the file is re-appliable"
