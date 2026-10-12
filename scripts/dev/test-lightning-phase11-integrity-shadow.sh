#!/usr/bin/env bash
# Lightning Phase 11 (the database side): integrity telemetry and the shadow
# matcher ledger.
#
# Proves 20261008161509 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55559 (LIGHTNING_P11_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 10 (20261008111425) and the Phase 9 remediation
# (20261008142857), in order, exactly as test-lightning-phase9r-remediation.sh
# builds them, then the migration under test, twice. Every Cluster is
# converted ON by the real drive, every hand formed by the real barrier,
# dealt by the real begin_dealing and settled by the real settlement, so the
# scan reads exactly the rows production writes. The rows the harness writes
# itself are fixture boundaries only: production's integrity ground (profiles
# with referred_by, user_sessions, ca_collusion_signals and a stand-in for
# fn_ca_is_cert_account, column for column as PokerIQ-Production carries
# them on 2026-10-08), a shared IP address and a referral planted on the
# platform's own tables, and backdated pool session stamps (time travel).
#
# LAW 10.5. Horses sit beside humans in every Cluster; the planted pairing
# concentration is a human and a horse and is found exactly as any pair. The
# migration reads neither is_horse nor horse_id.
#
# LIGHTNING_P11_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function
# privileges and its trg_autorevoke_privileged_anon event trigger (the
# Phase 8/9/10 harness ground, verbatim) before the file runs.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P11_PORT:-55559}
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
mine=${LIGHTNING_P11_MIGRATION:-$M/20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p11-test.XXXXXX")
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
}

# ===========================================================================
# THE GROUND: the Phase 8/9/10 harness's ground, verbatim (its helpers and
# production's function-creation environment), then this phase's own fixture
# boundaries and section 00.
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

-- 00 THE CATCHERS CATCH, THE FILE IS ABSENT ----------------------------------------
DO $$
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF to_regclass('public.lightning_integrity_signal') IS NOT NULL
     OR to_regclass('public.lightning_matcher_shadow_comparison') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_integrity_scan(uuid,timestamptz,timestamptz)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_shadow_record(uuid,text,text,timestamptz,timestamptz,jsonb,jsonb)') IS NOT NULL
     OR public.fn_lightning_config(NULL) ? 'quality_weights' THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger
                  WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d
                     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f') THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACL + autorevoke) is not installed';
  END IF;
  CREATE TABLE harness.cfg_acl AS
  SELECT r, has_function_privilege(r, 'public.fn_lightning_config(uuid)', 'EXECUTE') AS can
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; neither new table, no new door and no quality_weights key exists before the file; production''s default ACL and autorevoke event trigger are live'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- The newest signal of a pattern and subject (created now that its type exists).
CREATE FUNCTION harness.sig(p_game uuid, p_pattern text, p_a uuid, p_b uuid)
RETURNS public.lightning_integrity_signal LANGUAGE plpgsql STABLE AS $f$
DECLARE r public.lightning_integrity_signal;
BEGIN
  SELECT s.* INTO r FROM public.lightning_integrity_signal s
   WHERE s.cluster_id = p_game AND s.pattern_type = p_pattern
     AND s.player_a = CASE WHEN p_b IS NULL THEN p_a ELSE LEAST(p_a, p_b) END
     AND s.player_b IS NOT DISTINCT FROM CASE WHEN p_b IS NULL THEN NULL ELSE GREATEST(p_a, p_b) END
   ORDER BY s.id DESC LIMIT 1;
  RETURN r;
END $f$;
-- 01 NOTHING BEFORE IT IS FALSIFIED --------------------------------------------------
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
  -- The substitution kept who may execute the configuration reader.
  IF EXISTS (SELECT 1 FROM harness.cfg_acl a
              WHERE has_function_privilege(a.r, 'public.fn_lightning_config(uuid)', 'EXECUTE') IS DISTINCT FROM a.can) THEN
    RAISE EXCEPTION 'FAIL 01: fn_lightning_config changed who may execute it';
  END IF;
END $$;
\echo '  ok  01 NOTHING FALSIFIED  every predecessor live proof (Phases 1 through 10 and the Phase 9 remediation) that held before the file still holds after it, more than a hundred held before, and fn_lightning_config kept exactly who may execute it'

-- 02 THE SCAN FINDS THE PLANTED PAIRS, A HUMAN-HORSE PAIR AMONG THEM -------------------
DO $$
DECLARE v_g uuid; v_h uuid[]; v_hz uuid[]; x uuid; y uuid; c uuid; d uuid; v_others uuid[];
        v_t0 timestamptz := clock_timestamp() - interval '1 hour'; v_t1 timestamptz;
        r jsonb; s public.lightning_integrity_signal; k integer; v_p uuid[];
        v_cs record;
BEGIN
  PERFORM setseed(0.11);
  v_g := harness.lc('A');
  v_h := harness.idle(v_g, false, 14);
  v_hz := harness.idle(v_g, true, 4);
  IF cardinality(v_h) <> 14 OR cardinality(v_hz) <> 4 THEN
    RAISE EXCEPTION 'FIXTURE: cluster A has % humans and % horses in its pool', cardinality(v_h), cardinality(v_hz);
  END IF;
  x := v_h[1]; y := v_hz[1]; c := v_h[2]; d := v_h[3];
  v_others := v_h[4:14] || v_hz[2:4];
  -- The platform's own tables: X and Y share an address and Y was referred
  -- by X; X and C share another address but never share a hand; C was
  -- referred by a player C barely meets.
  INSERT INTO public.profiles (id, username, referred_by) VALUES (x, 'x', NULL), (y, 'y', x), (c, 'c', v_others[1]);
  INSERT INTO public.user_sessions (user_id, device_name, ip_address) VALUES
    (x, 'Mac', '10.1.2.3'), (y, 'iPhone', '10.1.2.3'), (x, 'iPad', '10.9.9.9'), (c, 'Pixel', '10.9.9.9');

  -- 40 hands where the human X and the horse Y always sit together.
  FOR k IN 1 .. 40 LOOP
    v_p := ARRAY[x, y] || harness.pick(v_others, 2);
    PERFORM harness.win(v_g, v_p, v_p[1 + floor(random() * 4)::integer]);
  END LOOP;
  -- 25 hands where C hands D four chips every time.
  FOR k IN 1 .. 25 LOOP
    v_p := ARRAY[c, d] || harness.pick(v_others, 1);
    PERFORM harness.play(v_g, v_p,
      jsonb_build_object(c::text, jsonb_build_object('d', -4, 'c', 4),
                         d::text, jsonb_build_object('d', 4, 'c', 4, 's', true),
                         v_p[3]::text, jsonb_build_object('d', 0, 'c', 0, 'f', 'fast')),
      8, ARRAY[d]);
  END LOOP;
  -- 60 hands of a random population with random winners.
  FOR k IN 1 .. 60 LOOP
    v_p := harness.pick(v_others, 4);
    PERFORM harness.win(v_g, v_p, v_p[1 + floor(random() * 4)::integer]);
  END LOOP;
  v_t1 := clock_timestamp();
  INSERT INTO harness.p8 (k, game, a, b, c, j) VALUES ('p11:A', v_g, x, y, c,
    jsonb_build_object('from', v_t0, 'to', v_t1, 'd', d));

  r := public.fn_lightning_integrity_scan(v_g, v_t0, v_t1);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'clusters_scanned')::integer <> 1
     OR (r ->> 'hands_scanned')::integer <> 125 OR (r ->> 'budget_hit')::boolean
     OR r -> 'written' <> jsonb_build_object('PAIRING_CONCENTRATION', 1, 'CHIP_FLOW', 1, 'DEVICE_OVERLAP', 1, 'ACCOUNT_RELATIONSHIP', 1)
     OR (r ->> 'chip_flow_mirrored')::integer <> 1 THEN
    RAISE EXCEPTION 'FAIL 02: the scan did not answer the planted population: %', r;
  END IF;

  s := harness.sig(v_g, 'PAIRING_CONCENTRATION', x, y);
  IF s.id IS NULL OR s.source <> 'scan' OR (s.evidence ->> 'hands_together')::integer <> 40
     OR (s.evidence ->> 'hands_a')::integer <> 40 OR (s.evidence ->> 'hands_in_window')::integer <> 125
     OR (s.evidence ->> 'expected_together')::numeric <> 12.80 OR s.suspicion_score <> 66 OR s.severity <> 'medium'
     OR s.status <> 'open' OR s.window_start <> v_t0 OR s.window_end <> v_t1 THEN
    RAISE EXCEPTION 'FAIL 02: the human-horse pairing concentration is not what was planted: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'CHIP_FLOW', c, d);
  IF s.id IS NULL OR (s.evidence ->> 'receiver')::uuid <> d OR (s.evidence ->> 'sender')::uuid <> c
     OR (s.evidence ->> 'opposed_hands')::integer <> 25 OR (s.evidence ->> 'gross_flow')::numeric <> 100
     OR (s.evidence ->> 'net_flow')::numeric <> 100 OR (s.evidence ->> 'direction_ratio')::numeric <> 1
     OR s.suspicion_score <> 80 OR s.severity <> 'high' THEN
    RAISE EXCEPTION 'FAIL 02: the chip flow is not what was planted: %', to_jsonb(s);
  END IF;
  -- THE RANDOM POPULATION IS NOT FLAGGED: exactly one row per pattern.
  IF harness.sign(v_g, 'PAIRING_CONCENTRATION') <> 1 OR harness.sign(v_g, 'CHIP_FLOW') <> 1
     OR harness.sign(v_g, 'DEVICE_OVERLAP') <> 1 OR harness.sign(v_g, 'ACCOUNT_RELATIONSHIP') <> 1
     OR harness.sign(v_g, 'COORDINATED_JOIN_LEAVE') <> 0 OR harness.sign(v_g, 'SESSION_LENGTH') <> 0 THEN
    RAISE EXCEPTION 'FAIL 02: the random population was flagged: %',
      (SELECT jsonb_agg(jsonb_build_object('p', s2.pattern_type, 'a', s2.player_a, 'b', s2.player_b, 'e', s2.evidence))
         FROM public.lightning_integrity_signal s2 WHERE s2.cluster_id = v_g);
  END IF;
  s := harness.sig(v_g, 'DEVICE_OVERLAP', x, y);
  IF s.id IS NULL OR (s.evidence ->> 'shared_ip_addresses')::integer <> 1 OR s.evidence::text ~ '10\.1\.2\.3' THEN
    RAISE EXCEPTION 'FAIL 02: the shared address is not a count-only finding: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'ACCOUNT_RELATIONSHIP', x, y);
  IF s.id IS NULL OR (s.evidence ->> 'referrer')::uuid <> x OR (s.evidence ->> 'referred')::uuid <> y THEN
    RAISE EXCEPTION 'FAIL 02: the referral is not found: %', to_jsonb(s);
  END IF;
  -- THE EXISTING PAIR STORE carries the chip flow once, in its own meaning.
  SELECT * INTO v_cs FROM public.ca_collusion_signals cs WHERE cs.detail ->> 'signal' = 'lightning_chip_flow';
  IF (SELECT count(*) FROM public.ca_collusion_signals) <> 1
     OR v_cs.user_a <> d OR v_cs.user_b <> c OR v_cs.hands_together <> 25 OR v_cs.gross_flow <> 100
     OR v_cs.net_flow <> 100 OR v_cs.direction_ratio <> 1 OR v_cs.both_cert OR v_cs.window_days <> 1
     OR (v_cs.detail ->> 'lightning_signal_id')::bigint <> (harness.sig(v_g, 'CHIP_FLOW', c, d)).id
     OR (v_cs.detail ->> 'cluster_id')::uuid <> v_g THEN
    RAISE EXCEPTION 'FAIL 02: the chip flow did not reach ca_collusion_signals in its meaning: %', to_jsonb(v_cs);
  END IF;
  -- NO CARD IN ANY EVIDENCE.
  IF EXISTS (SELECT 1 FROM public.lightning_integrity_signal s2
              WHERE s2.evidence::text ~* '"[^"]*(card|hole|deck|seed)[^"]*"\s*:') THEN
    RAISE EXCEPTION 'FAIL 02: an evidence object names a card';
  END IF;
END $$;
\echo '  ok  02 THE SCAN FINDS WHAT WAS PLANTED  125 real hands: the human-horse pair seated together 40 times against 12.8 expected is PAIRING_CONCENTRATION 66 medium; the 25 one-way hands are CHIP_FLOW 80 high (receiver, sender, 100 of 100 net) and land once in ca_collusion_signals as user_a receiver with detail.signal lightning_chip_flow; the shared address is a count-only DEVICE_OVERLAP and the referral an ACCOUNT_RELATIONSHIP; the random population raises nothing; no evidence names a card'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 03 A POOL THAT ALWAYS PLAYS TOGETHER IS NOT SUSPICIOUS; RESCANS CHANGE NOTHING ------
DO $$
DECLARE v_g uuid; v_b uuid; v_p uuid[]; k integer; r jsonb; w jsonb; v_hash text; v_cs integer;
        v_t0 timestamptz := clock_timestamp() - interval '1 hour'; v_t1 timestamptz; v_id bigint;
BEGIN
  PERFORM setseed(0.23);
  SELECT game, j INTO v_g, w FROM harness.p8 hp8 WHERE hp8.k = 'p11:A';
  -- Four players (two humans, two horses) who are the whole of every hand:
  -- 35 hands together each, exactly the 35 expected, so not concentrated.
  v_b := harness.lc('B');
  v_p := harness.idle(v_b, false, 2) || harness.idle(v_b, true, 2);
  FOR k IN 1 .. 35 LOOP
    PERFORM harness.win(v_b, v_p, v_p[1 + floor(random() * 4)::integer]);
  END LOOP;
  v_t1 := clock_timestamp();
  r := public.fn_lightning_integrity_scan(v_b, v_t0, v_t1);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'hands_scanned')::integer <> 35
     OR r -> 'written' <> '{}'::jsonb OR EXISTS (SELECT 1 FROM public.lightning_integrity_signal s WHERE s.cluster_id = v_b) THEN
    RAISE EXCEPTION 'FAIL 03: a pool that always plays together was flagged: %', r;
  END IF;

  -- THE SAME WINDOW AGAIN: nothing written, nothing changed, no second mirror.
  v_hash := harness.sig_hash(v_g);
  v_cs := (SELECT count(*) FROM public.ca_collusion_signals);
  r := public.fn_lightning_integrity_scan(v_g, (w ->> 'from')::timestamptz, (w ->> 'to')::timestamptz);
  IF r -> 'written' <> '{}'::jsonb OR (r ->> 'chip_flow_mirrored')::integer <> 0
     OR harness.sig_hash(v_g) <> v_hash OR (SELECT count(*) FROM public.ca_collusion_signals) <> v_cs THEN
    RAISE EXCEPTION 'FAIL 03: a rescan of the same window changed something: %', r;
  END IF;
  -- AN OPERATOR'S CLEARING STANDS through a rescan.
  v_id := (harness.sig(v_g, 'PAIRING_CONCENTRATION', (SELECT a FROM harness.p8 hp8 WHERE hp8.k = 'p11:A'),
                                                    (SELECT b FROM harness.p8 hp8 WHERE hp8.k = 'p11:A'))).id;
  UPDATE public.lightning_integrity_signal SET status = 'cleared', reviewed_by = gen_random_uuid(),
         reviewed_at = clock_timestamp(), notes = 'friends' WHERE id = v_id;
  v_hash := harness.sig_hash(v_g);
  PERFORM public.fn_lightning_integrity_scan(v_g, (w ->> 'from')::timestamptz, (w ->> 'to')::timestamptz);
  IF (SELECT status FROM public.lightning_integrity_signal WHERE id = v_id) <> 'cleared' OR harness.sig_hash(v_g) <> v_hash THEN
    RAISE EXCEPTION 'FAIL 03: a rescan touched the operator''s clearing';
  END IF;
  -- EVERY CLUSTER over A's window finds A alone (B's hands came later) and
  -- writes nothing new.
  r := public.fn_lightning_integrity_scan(NULL, (w ->> 'from')::timestamptz, (w ->> 'to')::timestamptz);
  IF (r ->> 'clusters_scanned')::integer <> 1 OR (r ->> 'hands_scanned')::integer <> 125 OR r -> 'written' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 03: the all-Cluster scan did not find A alone, quietly: %', r;
  END IF;
  -- THE DEFAULT WINDOW is the 24 hours before the current hour; an inverted
  -- window refuses; a window past seven days is clamped and says so.
  r := public.fn_lightning_integrity_scan(gen_random_uuid());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true
     OR (r ->> 'window_to')::timestamptz <> date_trunc('hour', (r ->> 'window_to')::timestamptz)
     OR (r ->> 'window_to')::timestamptz - (r ->> 'window_from')::timestamptz <> interval '24 hours'
     OR (r ->> 'window_to')::timestamptz > clock_timestamp() THEN
    RAISE EXCEPTION 'FAIL 03: the default window is not the day before the hour: %', r;
  END IF;
  r := public.fn_lightning_integrity_scan(gen_random_uuid(), clock_timestamp(), clock_timestamp() - interval '1 hour');
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false OR r ->> 'reason' <> 'INVALID_WINDOW' THEN
    RAISE EXCEPTION 'FAIL 03: an inverted window was not refused: %', r;
  END IF;
  r := public.fn_lightning_integrity_scan(gen_random_uuid(), clock_timestamp() - interval '30 days', clock_timestamp());
  IF (r ->> 'window_clamped')::boolean IS DISTINCT FROM true
     OR (r ->> 'window_to')::timestamptz - (r ->> 'window_from')::timestamptz <> interval '7 days' THEN
    RAISE EXCEPTION 'FAIL 03: a 30-day window was not clamped to seven: %', r;
  END IF;
END $$;
\echo '  ok  03 NO FALSE ALARM, NO DOUBLE WRITE  four players who are every hand (35 together against 35 expected) raise nothing; the same window again writes nothing, changes no row and mirrors nothing twice; an operator''s cleared status survives a rescan; the all-Cluster scan over A''s window finds A alone, quietly; the default window is the 24 hours before the hour, an inverted window refuses and a 30-day window is clamped to seven'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 04 COORDINATED JOINS AND LEAVES, AND THE MARATHON SESSION ---------------------------
DO $$
DECLARE v_g uuid; v_h uuid[]; v_hz uuid[]; p uuid; q uuid; rr uuid; m uuid; mh uuid; i integer;
        v_t0 timestamptz := clock_timestamp() - interval '1 hour'; v_t1 timestamptz; r jsonb;
        s public.lightning_integrity_signal; v_base timestamptz := clock_timestamp() - interval '50 minutes';
BEGIN
  v_g := harness.lc('C');
  v_h := harness.idle(v_g, false, 14);
  v_hz := harness.idle(v_g, true, 4);
  p := v_h[1]; q := v_hz[1]; rr := v_h[2]; m := v_h[3]; mh := v_hz[2];
  -- Every player of a fresh Cluster entered within the same instant; spread
  -- them an hour apart first (TIME TRAVEL, fixture boundary) so only the
  -- planted timing remains.
  UPDATE public.lightning_pool_session ps SET entered_at = v_base - (row_number * interval '61 seconds')
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS row_number FROM public.lightning_pool_session
           WHERE cluster_id = v_g) z
   WHERE ps.id = z.id;
  -- P (human) and Q (horse) enter and leave within seconds of each other
  -- three times; R joins with P once.
  FOR i IN 1 .. 3 LOOP
    PERFORM harness.stop(v_g, p);
    PERFORM harness.stop(v_g, q);
    IF i < 3 THEN
      -- The next session of each, through the real doors.
      PERFORM harness.again(v_g, p, false);
      PERFORM harness.again(v_g, q, true);
    END IF;
  END LOOP;
  PERFORM harness.stop(v_g, rr);
  -- Each session of P and Q: entered and exited together, spaced apart.
  UPDATE public.lightning_pool_session ps
     SET entered_at = v_base + (z.n * interval '5 minutes') + CASE WHEN ps.player_id = q THEN interval '3 seconds' ELSE interval '0' END,
         exited_at = v_base + (z.n * interval '5 minutes') + interval '2 minutes'
                     + CASE WHEN ps.player_id = q THEN interval '4 seconds' ELSE interval '0' END
    FROM (SELECT id, row_number() OVER (PARTITION BY player_id ORDER BY entered_at, id) AS n
            FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id IN (p, q)) z
   WHERE ps.id = z.id;
  UPDATE public.lightning_pool_session SET entered_at = v_base + interval '5 minutes' + interval '1 second',
         exited_at = v_base + interval '7 minutes' + interval '2 seconds'
   WHERE cluster_id = v_g AND player_id = rr;
  -- (A horse's return can pass through one extra anchor-seat exit on the
  -- way; its sessions are spaced like the others and the extra one meets
  -- nobody.)
  IF (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = p) <> 3
     OR (SELECT count(*) FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id = q) NOT IN (3, 4)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id IN (p, q, rr) AND exited_at IS NULL) THEN
    RAISE EXCEPTION 'FIXTURE: P and Q do not hold three exited sessions each: %', (SELECT jsonb_agg(jsonb_build_object('p', player_id = p, 'in', entered_at, 'out', exited_at, 'why', exit_reason)) FROM public.lightning_pool_session WHERE cluster_id = v_g AND player_id IN (p, q, rr));
  END IF;
  -- A HUMAN AND A HORSE in the pool for thirteen hours (time travel).
  UPDATE public.lightning_pool_session SET entered_at = clock_timestamp() - interval '13 hours'
   WHERE cluster_id = v_g AND player_id IN (m, mh) AND exited_at IS NULL;
  v_t1 := clock_timestamp();
  r := public.fn_lightning_integrity_scan(v_g, v_t0 - interval '13 hours', v_t1);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true
     OR r -> 'written' <> jsonb_build_object('COORDINATED_JOIN_LEAVE', 1, 'SESSION_LENGTH', 2) THEN
    RAISE EXCEPTION 'FAIL 04: the session patterns were not found: % / %', r,
      (SELECT jsonb_agg(jsonb_build_object('p', s2.pattern_type, 'a', s2.player_a, 'b', s2.player_b, 'e', s2.evidence))
         FROM public.lightning_integrity_signal s2 WHERE s2.cluster_id = v_g);
  END IF;
  s := harness.sig(v_g, 'COORDINATED_JOIN_LEAVE', p, q);
  IF s.id IS NULL OR (s.evidence ->> 'joint_sessions')::integer <> 3 OR s.suspicion_score <> 70 OR s.severity <> 'high' THEN
    RAISE EXCEPTION 'FAIL 04: the coordinated pair is not three joint sessions: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'SESSION_LENGTH', m, NULL);
  IF s.id IS NULL OR s.player_b IS NOT NULL OR (s.evidence ->> 'still_open')::boolean IS DISTINCT FROM true
     OR s.suspicion_score <> 53 OR (harness.sig(v_g, 'SESSION_LENGTH', mh, NULL)).suspicion_score <> 53 THEN
    RAISE EXCEPTION 'FAIL 04: the human and the horse marathons do not score alike: %', to_jsonb(s);
  END IF;
  -- Rescan: unchanged.
  IF public.fn_lightning_integrity_scan(v_g, v_t0 - interval '13 hours', v_t1) -> 'written' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 04: the session rescan wrote again';
  END IF;
END $$;
\echo '  ok  04 SESSION PATTERNS  a human and a horse who entered and left within seconds three times are COORDINATED_JOIN_LEAVE 70 high while the once-coordinated third player is not; a thirteen-hour human and a thirteen-hour horse are each SESSION_LENGTH 53; the rescan writes nothing'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 05 THE ENGINE'S INGEST DOOR: VALIDATES, CLAMPS, DECIDES, IS IDEMPOTENT ---------------
DO $$
DECLARE v_g uuid; x uuid; y uuid; c uuid; d uuid; w jsonb; r jsonb; v_sig jsonb; v_hash text;
        v_from text := to_char(date_trunc('minute', clock_timestamp()) - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SSOF');
        v_to text := to_char(date_trunc('minute', clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SSOF');
        s public.lightning_integrity_signal; v_big jsonb;
BEGIN
  SELECT hp8.game, hp8.a, hp8.b, hp8.c, hp8.j INTO v_g, x, y, c, w FROM harness.p8 hp8 WHERE hp8.k = 'p11:A';
  d := (w ->> 'd')::uuid;
  IF public.fn_lightning_integrity_report(gen_random_uuid(), '{}'::jsonb) ->> 'reason' <> 'CLUSTER_NOT_FOUND'
     OR public.fn_lightning_integrity_report(v_g, '[]'::jsonb) ->> 'reason' <> 'INVALID_SIGNALS'
     OR public.fn_lightning_integrity_report(v_g, jsonb_build_object('window_from', v_to, 'window_to', v_from)) ->> 'reason' <> 'INVALID_WINDOW'
     OR public.fn_lightning_integrity_report(v_g, jsonb_build_object('window_from', 'yesterday-ish', 'window_to', v_to)) ->> 'reason' <> 'INVALID_WINDOW'
     OR public.fn_lightning_integrity_report(v_g, jsonb_build_object('window_from', v_from, 'window_to', v_to,
          'players', jsonb_build_array(jsonb_build_object('player_id', x, 'decisions', 60, 'hole_cards', 'AsKs')))) ->> 'reason' <> 'evidence_carries_cards'
     OR public.fn_lightning_integrity_report(v_g, jsonb_build_object('window_from', v_from, 'window_to', v_to, 'players', 5)) ->> 'reason' <> 'INVALID_SIGNALS' THEN
    RAISE EXCEPTION 'FAIL 05: a malformed report was not refused whole';
  END IF;

  v_sig := jsonb_build_object('window_from', v_from, 'window_to', v_to, 'hands', 200, 'decisions', 900, 'fast_ms', 500,
    'dropped_players', 0, 'dropped_pairs', 0,
    'players', jsonb_build_array(
      -- 0: robotic consistency (the horse): flagged.
      jsonb_build_object('player_id', y, 'decisions', 120, 'timeouts', 0, 'p50_ms', 900, 'p95_ms', 1000, 'mean_ms', 910, 'stddev_ms', 45, 'cv', 0.05, 'fast_share', 0.1),
      -- 1: mostly instant actions, fast_share clamped from 1.4 (the human): flagged.
      jsonb_build_object('player_id', x, 'decisions', 80, 'timeouts', 2, 'p50_ms', 300, 'p95_ms', 2000, 'mean_ms', 600, 'stddev_ms', 700, 'cv', 1.1, 'fast_share', 1.4),
      -- 2: an ordinary human: not flagged.
      jsonb_build_object('player_id', c, 'decisions', 90, 'p50_ms', 2500, 'p95_ms', 9000, 'cv', 0.8, 'fast_share', 0.1),
      -- 3: too few decisions to judge: not flagged.
      jsonb_build_object('player_id', d, 'decisions', 10, 'cv', 0.01, 'fast_share', 1),
      -- 4..7: refused alone.
      jsonb_build_object('player_id', gen_random_uuid(), 'decisions', 100, 'cv', 0.01),
      jsonb_build_object('player_id', 'not-a-uuid', 'decisions', 100),
      jsonb_build_object('player_id', c, 'decisions', 'many'),
      '7'::jsonb),
    'pairs', jsonb_build_array(
      -- 0: correlated timing, given in reverse order: flagged, canonicalized.
      jsonb_build_object('player_a', GREATEST(x, y), 'player_b', LEAST(x, y), 'hands_together', 40, 'sequential_actions', 60, 'fast_follows', 12, 'latency_corr', 0.9),
      -- 1: fast follows on most sequential actions: flagged.
      jsonb_build_object('player_a', c, 'player_b', d, 'hands_together', 25, 'sequential_actions', 40, 'fast_follows', 30, 'latency_corr', 0.1),
      -- 2: too few hands together: not flagged.
      jsonb_build_object('player_a', x, 'player_b', c, 'hands_together', 5, 'sequential_actions', 40, 'latency_corr', 0.99),
      -- 3: the same player twice: refused.
      jsonb_build_object('player_a', x, 'player_b', x, 'hands_together', 40, 'sequential_actions', 60, 'latency_corr', 0.9)));
  r := public.fn_lightning_integrity_report(v_g, v_sig);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'players_read')::integer <> 8 OR (r ->> 'pairs_read')::integer <> 4
     OR r -> 'flagged' <> '{"DECISION_LATENCY": 2, "TIMING_CORRELATION": 2}'::jsonb
     OR (r ->> 'inserted')::integer <> 4 OR (r ->> 'updated')::integer <> 0 OR (r ->> 'unchanged')::integer <> 0
     OR jsonb_array_length(r -> 'rejected') <> 5
     OR (SELECT array_agg(e ->> 'reason' ORDER BY e ->> 'list', (e ->> 'index')::integer) FROM jsonb_array_elements(r -> 'rejected') e)
        <> ARRAY['invalid_player', 'unknown_player', 'invalid_player', 'not_a_number', 'not_an_object']
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'clamped') e WHERE e ->> 'key' = 'fast_share' AND (e ->> 'used')::numeric = 1)
     OR r -> 'truncated' <> '{"players": 0, "pairs": 0}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 05: the report did not validate, clamp and decide: %', r;
  END IF;
  s := harness.sig(v_g, 'DECISION_LATENCY', y, NULL);
  IF s.id IS NULL OR s.source <> 'engine' OR s.suspicion_score <> 77 OR s.severity <> 'high'
     OR (s.evidence ->> 'cv')::numeric <> 0.05 OR (s.evidence ->> 'window_hands')::numeric <> 200 THEN
    RAISE EXCEPTION 'FAIL 05: the horse''s robotic timing is not recorded as any player''s: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'DECISION_LATENCY', x, NULL);
  IF s.id IS NULL OR s.suspicion_score <> 90 OR (s.evidence ->> 'fast_share')::numeric <> 1 THEN
    RAISE EXCEPTION 'FAIL 05: the fast human is not recorded with the clamped share: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'TIMING_CORRELATION', x, y);
  IF s.id IS NULL OR s.player_a <> LEAST(x, y) OR s.player_b <> GREATEST(x, y) OR s.suspicion_score <> 85 THEN
    RAISE EXCEPTION 'FAIL 05: the correlated pair is not canonical: %', to_jsonb(s);
  END IF;
  s := harness.sig(v_g, 'TIMING_CORRELATION', c, d);
  IF s.id IS NULL OR s.suspicion_score <> 78 OR (s.evidence ->> 'follow_share')::numeric <> 0.75 THEN
    RAISE EXCEPTION 'FAIL 05: the fast-follow pair is not scored on its follow share: %', to_jsonb(s);
  END IF;
  -- THE SAME REPORT AGAIN: nothing changes.
  v_hash := harness.sig_hash(v_g);
  r := public.fn_lightning_integrity_report(v_g, v_sig);
  IF (r ->> 'inserted')::integer <> 0 OR (r ->> 'updated')::integer <> 0 OR (r ->> 'unchanged')::integer <> 4
     OR harness.sig_hash(v_g) <> v_hash THEN
    RAISE EXCEPTION 'FAIL 05: the same report changed something: %', r;
  END IF;
  -- NEW NUMBERS for one subject update that row alone.
  r := public.fn_lightning_integrity_report(v_g, jsonb_set(v_sig, '{players,0,cv}', '0.0'::jsonb));
  IF (r ->> 'updated')::integer <> 1 OR (r ->> 'unchanged')::integer <> 3
     OR (harness.sig(v_g, 'DECISION_LATENCY', y, NULL)).suspicion_score <> 90 THEN
    RAISE EXCEPTION 'FAIL 05: new numbers did not update their own row: %', r;
  END IF;
  -- THE CAPS: 600 players and 250 pairs read as 500 and 200.
  SELECT jsonb_build_object('window_from', v_from, 'window_to', v_to,
           'players', (SELECT jsonb_agg(jsonb_build_object('player_id', c, 'decisions', 1)) FROM generate_series(1, 600)),
           'pairs', (SELECT jsonb_agg(jsonb_build_object('player_a', c, 'player_b', d, 'hands_together', 1)) FROM generate_series(1, 250)))
    INTO v_big;
  r := public.fn_lightning_integrity_report(v_g, v_big);
  IF (r ->> 'players_read')::integer <> 500 OR (r ->> 'pairs_read')::integer <> 200
     OR r -> 'truncated' <> '{"players": 100, "pairs": 50}'::jsonb OR (r ->> 'inserted')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL 05: the caps did not hold: %', r - 'rejected' - 'clamped';
  END IF;
END $$;
\echo '  ok  05 THE INGEST DOOR  malformed reports (unknown Cluster, not an object, inverted or unreadable window, a hole_cards key, a non-array list) are refused whole; of eight players and four pairs the database itself flags the robotic horse (cv 0.05, score 77), the instant human (fast_share clamped 1.4 to 1, 90), the correlated pair given in reverse (canonical, 85) and the fast-follow pair (0.75, 78), passes the ordinary and the under-sampled, and refuses five entries alone; the same report changes nothing, new numbers update their own row, and 600 players and 250 pairs are read as 500 and 200'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 06 THE QUALITY SCORE AND ITS WEIGHTS -------------------------------------------------
DO $$
DECLARE v_g uuid; m jsonb; cfg jsonb; v_inv jsonb;
BEGIN
  m := '{"passes":40,"quorum_passes":38,"formation_success_rate":0.9,"failed_passes":4,"failure_rate":0.1,"groups":30,"seated":120,
         "wait_ms":{"n":120,"p50":3000,"p95":9000,"avg":3500},
         "bb_fairness":{"n":10,"avg_hands_since_bb":5.5,"p95_hands_since_bb":8,"max_hands_since_bb":9,"order_violations":2},
         "position_fairness":{"btn_n":30,"btn_avg_count_before":5.8},
         "opponent_diversity":{"pairs":200,"repeat_pairs":80,"repeat_pair_rate":0.4},
         "instance_occupancy":{"avg_size":5.2,"utilization":0.5},"matcher_version":"m1"}'::jsonb;
  IF public.fn_lightning_quality_components(m) <> '{"next_hand_speed":0.885,"formation_success":0.9,"bb_fairness":0.8,"opponent_diversity":0.6,"instance_utilization":0.5,"reliability":0.9}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: the components are not read from the engine''s shape: %', public.fn_lightning_quality_components(m);
  END IF;
  IF public.fn_lightning_quality_score(m) <> 79.63
     OR public.fn_lightning_quality_score(m, '{"reliability":1}'::jsonb) <> 90.00
     OR public.fn_lightning_quality_score(m - 'bb_fairness') <> 79.56
     OR public.fn_lightning_quality_score(m, '{"reliability":"1","bogus":2}'::jsonb) IS NOT NULL
     OR public.fn_lightning_quality_score('{"passes":0}'::jsonb) IS NOT NULL
     OR public.fn_lightning_quality_score('[]'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: the score arithmetic is wrong: % % %', public.fn_lightning_quality_score(m),
      public.fn_lightning_quality_score(m, '{"reliability":1}'::jsonb), public.fn_lightning_quality_score(m - 'bb_fairness');
  END IF;

  -- THE CONFIGURATION: defaults, off; a set summing to one is used as given;
  -- others are normalized, clamped, ignored or refused, each reported.
  v_g := (SELECT game FROM harness.p8 hp8 WHERE hp8.k = 'p11:A');
  cfg := public.fn_lightning_config(v_g);
  IF (cfg ->> 'lightning_shadow_matcher')::boolean OR (cfg ->> 'integrity_telemetry')::boolean
     OR cfg ->> 'shadow_matcher_version' <> 'm2' OR (cfg ->> 'shadow_window_ms')::integer <> 300000
     OR (cfg ->> 'shadow_max_players')::integer <> 500 OR (cfg ->> 'shadow_pass_budget_ms')::integer <> 50
     OR jsonb_array_length(cfg -> 'invalid') <> 0
     OR (SELECT sum(value::numeric) FROM jsonb_each_text(cfg -> 'quality_weights')) <> 1 THEN
    RAISE EXCEPTION 'FAIL 06: the defaults are not off and whole: %', cfg;
  END IF;
  PERFORM harness.cfg(v_g, '{"lightning_shadow_matcher": true, "integrity_telemetry": true, "shadow_matcher_version": "m3-beta", "shadow_window_ms": 120000, "quality_weights": {"next_hand_speed": 0.5, "reliability": 0.5, "formation_success": 0, "bb_fairness": 0, "opponent_diversity": 0, "instance_utilization": 0}}'::jsonb);
  cfg := public.fn_lightning_config(v_g);
  IF NOT (cfg ->> 'lightning_shadow_matcher')::boolean OR NOT (cfg ->> 'integrity_telemetry')::boolean
     OR cfg ->> 'shadow_matcher_version' <> 'm3-beta' OR (cfg ->> 'shadow_window_ms')::integer <> 120000
     OR (cfg #>> '{quality_weights,reliability}')::numeric <> 0.5 OR jsonb_array_length(cfg -> 'invalid') <> 0 THEN
    RAISE EXCEPTION 'FAIL 06: a whole valid configuration was not used as given: %', cfg;
  END IF;
  PERFORM harness.cfg(v_g, '{"lightning_shadow_matcher": "yes", "shadow_matcher_version": "bad version!", "shadow_window_ms": 5, "shadow_max_players": 99999, "quality_weights": {"reliability": 2, "bogus": 1}}'::jsonb);
  cfg := public.fn_lightning_config(v_g);
  SELECT jsonb_agg(e ->> 'key' || ':' || (e ->> 'reason') ORDER BY e ->> 'key', e ->> 'reason') INTO v_inv FROM jsonb_array_elements(cfg -> 'invalid') e;
  IF (cfg ->> 'lightning_shadow_matcher')::boolean OR cfg ->> 'shadow_matcher_version' <> 'm2'
     OR (cfg ->> 'shadow_window_ms')::integer <> 60000 OR (cfg ->> 'shadow_max_players')::integer <> 5000
     OR abs((SELECT sum(value::numeric) FROM jsonb_each_text(cfg -> 'quality_weights')) - 1) > 0.00001
     OR (cfg #>> '{quality_weights,reliability}')::numeric <> round(1 / 1.85, 6)
     OR v_inv <> '["lightning_shadow_matcher:wrong_type", "quality_weights:normalized_to_sum_one", "quality_weights:unknown_weight", "quality_weights.reliability:out_of_range_clamped", "shadow_matcher_version:not_a_version_name", "shadow_max_players:out_of_range_clamped", "shadow_window_ms:out_of_range_clamped"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: the bad configuration was not clamped and reported: % %', cfg, v_inv;
  END IF;
  PERFORM harness.cfg(v_g, '{"quality_weights": {"next_hand_speed": 0, "formation_success": 0, "bb_fairness": 0, "opponent_diversity": 0, "instance_utilization": 0, "reliability": 0}}'::jsonb);
  cfg := public.fn_lightning_config(v_g);
  IF (cfg #>> '{quality_weights,next_hand_speed}')::numeric <> 0.25
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cfg -> 'invalid') e WHERE e ->> 'reason' = 'weights_sum_to_zero') THEN
    RAISE EXCEPTION 'FAIL 06: an all-zero set did not fall back to the defaults: %', cfg;
  END IF;
  PERFORM harness.cfg(v_g, '{"quality_weights": 5}'::jsonb);
  cfg := public.fn_lightning_config(v_g);
  IF (cfg #>> '{quality_weights,next_hand_speed}')::numeric <> 0.25
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cfg -> 'invalid') e WHERE e ->> 'key' = 'quality_weights' AND e ->> 'reason' = 'wrong_type') THEN
    RAISE EXCEPTION 'FAIL 06: a scalar weight set was not refused: %', cfg;
  END IF;
  -- Back to the defaults for what follows.
  UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot #- '{lightning,quality_weights}' #- '{lightning,lightning_shadow_matcher}'
         #- '{lightning,integrity_telemetry}' #- '{lightning,shadow_matcher_version}' #- '{lightning,shadow_window_ms}'
         #- '{lightning,shadow_max_players}' WHERE id = v_g;
  IF jsonb_array_length(public.fn_lightning_config(v_g) -> 'invalid') <> 0 THEN
    RAISE EXCEPTION 'FAIL 06: the configuration did not return to clean';
  END IF;
END $$;
\echo '  ok  06 THE QUALITY SCORE  the six components read from the engine''s window object (speed 0.885, formation 0.9, BB 0.8, diversity 0.6, utilization 0.5, reliability 0.9) score 79.63 under the defaults, 90 under reliability alone and 79.56 with BB fairness absent; no usable weight or component answers NULL; the Phase 11 keys default off (shadow m2, 300000 ms, 500 players, 50 ms), a valid set is used as given, a bad one is clamped, normalized and reported key by key, an all-zero or scalar weight set falls back to the defaults'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 07 THE SHADOW LEDGER AND THE PROMOTION REPORT ----------------------------------------
DO $$
DECLARE v_g uuid; v_b uuid; live jsonb; sh jsonb; r jsonb; k integer; v_t timestamptz := date_trunc('minute', clock_timestamp());
        v_id bigint; v_pair jsonb;
BEGIN
  SELECT game INTO v_g FROM harness.p8 hp8 WHERE hp8.k = 'p11:A';
  v_b := harness.lc('D');
  live := '{"passes":40,"quorum_passes":38,"formation_success_rate":0.9,"failed_passes":4,"failure_rate":0.1,"groups":30,"seated":120,
            "wait_ms":{"n":120,"p50":3000,"p95":9000,"avg":3500},
            "bb_fairness":{"n":10,"avg_hands_since_bb":5.5,"p95_hands_since_bb":8,"max_hands_since_bb":9,"order_violations":2},
            "position_fairness":{"btn_n":30,"btn_avg_count_before":5.8},
            "opponent_diversity":{"pairs":200,"repeat_pairs":80,"repeat_pair_rate":0.4},
            "instance_occupancy":{"avg_size":5.2,"utilization":0.5},"matcher_version":"m1",
            "latency_ms":{"fold_ack":{"n":5,"p50":40,"p95":90}},"first_render_measured":false}'::jsonb;
  sh := jsonb_set(jsonb_set(live - 'latency_ms' - 'first_render_measured', '{wait_ms,p50}', '1500'), '{matcher_version}', '"m2"')
        || '{"skipped":{"size_cap":0,"overrun":1,"unknown_version":0},"avg_pass_ms":4.2,"dropped_windows":0}'::jsonb;

  -- REFUSALS, each changing nothing.
  IF public.fn_lightning_shadow_record(gen_random_uuid(), 'm1', 'm2', v_t - interval '5 minutes', v_t, live, sh) ->> 'reason' <> 'CLUSTER_NOT_FOUND'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm1', v_t - interval '5 minutes', v_t, live, sh) ->> 'reason' <> 'SAME_VERSION'
     OR public.fn_lightning_shadow_record(v_g, 'm 1', 'm2', v_t - interval '5 minutes', v_t, live, sh) ->> 'reason' <> 'INVALID_VERSION'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t, v_t - interval '5 minutes', live, sh) ->> 'reason' <> 'INVALID_WINDOW'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '8 days', v_t, live, sh) ->> 'reason' <> 'INVALID_WINDOW'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live - 'passes', sh) ->> 'reason' <> 'INVALID_METRICS'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live, jsonb_set(sh, '{failure_rate}', '1.5')) -> 'errors' -> 0 ->> 'key' <> 'failure_rate'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, jsonb_set(live, '{instance_occupancy,utilization}', '2'), sh) -> 'errors' -> 0 ->> 'key' <> 'instance_occupancy.utilization'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, jsonb_set(live, '{wait_ms}', '"fast"'), sh) -> 'errors' -> 0 ->> 'reason' <> 'not_an_object'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live || '{"deck":[1]}'::jsonb, sh) -> 'errors' -> 0 ->> 'reason' <> 'carries_cards'
     OR public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live, '[]'::jsonb) ->> 'side' <> 'shadow'
     OR EXISTS (SELECT 1 FROM public.lightning_matcher_shadow_comparison) THEN
    RAISE EXCEPTION 'FAIL 07: a bad comparison was not refused, or a refusal wrote';
  END IF;

  -- ONE COMPARISON: both scores, both components, the weights; a NULL live
  -- version is the side's own matcher_version.
  r := public.fn_lightning_shadow_record(v_g, NULL, 'm2', v_t - interval '5 minutes', v_t, live, sh);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'idempotent')::boolean
     OR r ->> 'live_matcher_version' <> 'm1' OR (r ->> 'live_quality_score')::numeric <> 79.63
     OR (r ->> 'shadow_quality_score')::numeric <> 80.50 OR (r ->> 'quality_delta')::numeric <> 0.87
     OR (r #>> '{components,shadow,next_hand_speed}')::numeric <> 0.92 THEN
    RAISE EXCEPTION 'FAIL 07: the comparison is not scored: %', r;
  END IF;
  v_id := (r ->> 'id')::bigint;
  IF (SELECT live_metrics FROM public.lightning_matcher_shadow_comparison WHERE id = v_id) <> live THEN
    RAISE EXCEPTION 'FAIL 07: the live side was not kept as sent';
  END IF;
  r := public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live, sh);
  IF (r ->> 'idempotent')::boolean IS DISTINCT FROM true OR (r ->> 'id')::bigint <> v_id THEN
    RAISE EXCEPTION 'FAIL 07: the same comparison again is not idempotent: %', r;
  END IF;
  r := public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - interval '5 minutes', v_t, live, jsonb_set(sh, '{passes}', '41'));
  IF r ->> 'reason' <> 'IDEMPOTENCY_CONFLICT' OR (SELECT count(*) FROM public.lightning_matcher_shadow_comparison) <> 1 THEN
    RAISE EXCEPTION 'FAIL 07: different numbers for a recorded key were not refused: %', r;
  END IF;
  -- THE CLUSTER'S WEIGHTS score its comparisons.
  PERFORM harness.cfg(v_b, '{"quality_weights": {"next_hand_speed": 0, "formation_success": 0, "bb_fairness": 0, "opponent_diversity": 0, "instance_utilization": 0, "reliability": 1}}'::jsonb);
  r := public.fn_lightning_shadow_record(v_b, 'm1', 'm2', v_t - interval '5 minutes', v_t, live, sh);
  IF (r ->> 'live_quality_score')::numeric <> 90 OR (r #>> '{quality_weights,reliability}')::numeric <> 1 THEN
    RAISE EXCEPTION 'FAIL 07: the Cluster''s own weights did not score its comparison: %', r;
  END IF;

  -- THIRTY-ONE WINDOWS of m1 against m2 on A (the shadow faster), three of
  -- m1 against m3 (the shadow slower): one verdict each.
  FOR k IN 1 .. 30 LOOP
    PERFORM public.fn_lightning_shadow_record(v_g, 'm1', 'm2', v_t - (k + 1) * interval '5 minutes', v_t - k * interval '5 minutes', live, sh);
  END LOOP;
  FOR k IN 1 .. 3 LOOP
    PERFORM public.fn_lightning_shadow_record(v_g, 'm1', 'm3', v_t - (k + 1) * interval '5 minutes', v_t - k * interval '5 minutes',
                                              live, jsonb_set(sh, '{wait_ms,p50}', '20000'));
  END LOOP;
  r := public.fn_lightning_shadow_report(v_g);
  SELECT e INTO v_pair FROM jsonb_array_elements(r -> 'version_pairs') e WHERE e ->> 'shadow_matcher_version' = 'm2';
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR jsonb_array_length(r -> 'version_pairs') <> 2
     OR (v_pair ->> 'comparisons')::integer <> 31 OR (v_pair ->> 'clusters')::integer <> 1
     OR (v_pair ->> 'quality_delta_mean')::numeric <> 0.87 OR (v_pair ->> 'shadow_better_share')::numeric <> 1
     OR v_pair ->> 'verdict' <> 'shadow_leads'
     OR (v_pair #>> '{metrics,wait_ms.p50,delta}')::numeric <> -1500
     OR (v_pair #>> '{metrics,component.next_hand_speed,delta}')::numeric <> 0.035 THEN
    RAISE EXCEPTION 'FAIL 07: the m2 promotion read is wrong: %', v_pair;
  END IF;
  SELECT e INTO v_pair FROM jsonb_array_elements(r -> 'version_pairs') e WHERE e ->> 'shadow_matcher_version' = 'm3';
  IF (v_pair ->> 'comparisons')::integer <> 3 OR v_pair ->> 'verdict' <> 'insufficient_evidence'
     OR (v_pair ->> 'quality_delta_mean')::numeric >= 0 THEN
    RAISE EXCEPTION 'FAIL 07: the m3 read is wrong: %', v_pair;
  END IF;
  -- Every Cluster: B's comparison joins m1/m2 as a second Cluster; a window
  -- that ends before every comparison reads nothing.
  r := public.fn_lightning_shadow_report();
  IF (SELECT (e ->> 'clusters')::integer FROM jsonb_array_elements(r -> 'version_pairs') e WHERE e ->> 'shadow_matcher_version' = 'm2') <> 2
     OR public.fn_lightning_shadow_report(NULL, v_t - interval '10 days', v_t - interval '9 days') -> 'version_pairs' <> '[]'::jsonb
     OR public.fn_lightning_shadow_report(NULL, now(), now() - interval '1 day') ->> 'reason' <> 'INVALID_WINDOW' THEN
    RAISE EXCEPTION 'FAIL 07: the all-Cluster or windowed read is wrong: %', r;
  END IF;
END $$;
\echo '  ok  07 THE SHADOW LEDGER  eleven bad comparisons (unknown Cluster, same or malformed version, inverted or eight-day window, missing passes, a rate over one, utilization two, a non-object wait, a deck key, a non-object side) are refused and write nothing; one window keeps the live side as sent, takes the live version from its matcher_version, scores 79.63 against 80.50 (delta 0.87), is idempotent, and refuses different numbers; a Cluster''s own weights score its comparisons; over 31 windows m2 leads (shadow better every time, p50 1500 ms faster) while three m3 windows are insufficient evidence; the all-Cluster and windowed reads hold'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 08 NO SEATING DECISION READS A SIGNAL OR THE LEDGER --------------------------------
DO $$
DECLARE v_g uuid; x uuid; y uuid; v_before jsonb; v_after jsonb; r jsonb; v_p uuid[];
BEGIN
  SELECT game, a, b INTO v_g, x, y FROM harness.p8 hp8 WHERE hp8.k = 'p11:A';
  SELECT jsonb_agg(jsonb_build_object('p', l.player_id, 'r', coalesce(l.reason_code, 'LEGAL')) ORDER BY l.player_id) INTO v_before
    FROM public.fn_lightning_player_legality(v_g, clock_timestamp(), NULL::uuid[], NULL::jsonb) l;
  -- Every signal of the Cluster at its worst, and more of them.
  UPDATE public.lightning_integrity_signal SET suspicion_score = 100, severity = 'high', status = 'open'
   WHERE cluster_id = v_g;
  INSERT INTO public.lightning_integrity_signal (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end,
                                                 suspicion_score, severity)
  SELECT v_g, 'SESSION_LENGTH', 'scan', ps.player_id, NULL, now() - interval '1 day', now(), 100, 'high'
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g
  ON CONFLICT DO NOTHING;
  SELECT jsonb_agg(jsonb_build_object('p', l.player_id, 'r', coalesce(l.reason_code, 'LEGAL')) ORDER BY l.player_id) INTO v_after
    FROM public.fn_lightning_player_legality(v_g, clock_timestamp(), NULL::uuid[], NULL::jsonb) l;
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'FAIL 08: the legality chain answered differently once signals stood: % vs %', v_before, v_after;
  END IF;
  -- The flagged human-horse pair still forms a hand through the real barrier.
  v_p := ARRAY[x, y] || harness.idle(v_g, false, 2, ARRAY[x, y]);
  r := harness.form(v_g, v_p);
  IF (r ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a flagged pair was not seated: %', r;
  END IF;
  -- Nothing in the seating path names the signal store, the mirror, the
  -- ledger or the score.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prokind = 'f'
                AND (p.proname LIKE 'fn\_lightning\_%' OR p.proname LIKE 'fn\_cash\_cluster%')
                AND p.proname NOT IN ('fn_lightning_integrity_scan', 'fn_lightning_integrity_report', 'fn_lightning_quality_score',
                                      'fn_lightning_quality_components', 'fn_lightning_shadow_record', 'fn_lightning_shadow_report',
                                      'fn_lightning_config')
                AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
                    ~ 'lightning_integrity_signal|lightning_matcher_shadow_comparison|ca_collusion_signals|quality_') THEN
    RAISE EXCEPTION 'FAIL 08: a seating-path body reads Phase 11 state';
  END IF;
END $$;
\echo '  ok  08 NO MATCHMAKING MANIPULATION  with every signal of the Cluster at score 100 and a marathon flag on every player, fn_lightning_player_legality answers every player exactly as before and the flagged human-horse pair forms a hand through the real barrier; no seating-path body names the store, the mirror, the ledger or the score'

-- 09 THE DOORS AND THE TABLES ARE THE SERVICE'S ALONE -------------------------------
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.fn_lightning_integrity_scan(uuid,timestamptz,timestamptz)',
                           'public.fn_lightning_integrity_report(uuid,jsonb,timestamptz)',
                           'public.fn_lightning_quality_components(jsonb)',
                           'public.fn_lightning_quality_score(jsonb,jsonb)',
                           'public.fn_lightning_shadow_record(uuid,text,text,timestamptz,timestamptz,jsonb,jsonb)',
                           'public.fn_lightning_shadow_report(uuid,timestamptz,timestamptz)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL 09: % is not the service''s alone', f;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.lightning_integrity_signal', 'SELECT')
     OR has_table_privilege('anon', 'public.lightning_matcher_shadow_comparison', 'SELECT')
     OR has_table_privilege('authenticated', 'public.lightning_matcher_shadow_comparison', 'INSERT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lightning_integrity_signal'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lightning_matcher_shadow_comparison'::regclass) THEN
    RAISE EXCEPTION 'FAIL 09: a player can reach a Phase 11 table';
  END IF;
  -- THE STORE'S OWN SHAPE RULES refuse a malformed row.
  IF public.fxr_try($q$INSERT INTO public.lightning_integrity_signal (cluster_id, pattern_type, source, player_a, player_b, window_start, window_end, suspicion_score, severity)
                     VALUES (gen_random_uuid(), 'CHIP_FLOW', 'scan', 'ffffffff-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001', now() - interval '1 hour', now(), 50, 'medium')$q$) !~ '^23514'
     OR public.fxr_try($q$INSERT INTO public.lightning_integrity_signal (cluster_id, pattern_type, source, player_a, window_start, window_end, suspicion_score, severity)
                     VALUES (gen_random_uuid(), 'DECISION_LATENCY', 'scan', gen_random_uuid(), now() - interval '1 hour', now(), 50, 'medium')$q$) !~ '^23514'
     OR public.fxr_try($q$INSERT INTO public.lightning_integrity_signal (cluster_id, pattern_type, source, player_a, window_start, window_end, suspicion_score, severity)
                     VALUES (gen_random_uuid(), 'SESSION_LENGTH', 'scan', gen_random_uuid(), now() - interval '1 hour', now(), 101, 'high')$q$) !~ '^23514' THEN
    RAISE EXCEPTION 'FAIL 09: the store accepted a malformed row';
  END IF;
END $$;
\echo '  ok  09 SERVICE ONLY  all six doors execute for service_role alone, both tables have RLS on and no player privilege, and the store refuses a non-canonical pair, a scan-sourced engine pattern and a score over 100'

-- 10 NON-LIGHTNING PLAY IS UNTOUCHED -------------------------------------------------
DO $$
DECLARE v_g uuid; r jsonb;
BEGIN
  v_g := harness.c8('plain', 6, 4, 1, 3, 1);
  r := public.fn_lightning_integrity_scan(v_g, now() - interval '1 day', now());
  IF (r ->> 'hands_scanned')::integer <> 0 OR r -> 'written' <> '{}'::jsonb
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g)
     OR (public.fn_lightning_config(v_g) ->> 'lightning_shadow_matcher')::boolean
     OR (public.fn_lightning_config(v_g) ->> 'integrity_telemetry')::boolean THEN
    RAISE EXCEPTION 'FAIL 10: a must-move cluster was touched: %', r;
  END IF;
END $$;
\echo '  ok  10 NON-LIGHTNING UNTOUCHED  a must-move Cluster has no pool session, the scan finds nothing in it and writes nothing, and both engine switches read off'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 11 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 15
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 11: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  11 THE LIVE PROOFS  all fifteen @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_integrity_signal', 'lightning_matcher_shadow_comparison', 'ca_collusion_signals', 'cash_cluster_events']) x(t)
UNION ALL
SELECT 'signals', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_integrity_signal s
UNION ALL
SELECT 'ledger', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_matcher_shadow_comparison s
UNION ALL
SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
 WHERE c.oid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass)
UNION ALL
SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
 WHERE i.indrelid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass,
                      'public.lightning_hand'::regclass, 'public.lightning_pool_session'::regclass)
UNION ALL
SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c
 WHERE c.conrelid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass);
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 12 RE-APPLIABLE ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  CREATE TEMP TABLE rcap2 AS
  SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
  UNION ALL
  SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
    FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_integrity_signal', 'lightning_matcher_shadow_comparison', 'ca_collusion_signals', 'cash_cluster_events']) x(t)
  UNION ALL
  SELECT 'signals', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_integrity_signal s
  UNION ALL
  SELECT 'ledger', md5(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id)) FROM public.lightning_matcher_shadow_comparison s
  UNION ALL
  SELECT 'acl:' || c.relname, coalesce(c.relacl::text, '') || c.relrowsecurity::text FROM pg_class c
   WHERE c.oid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass)
  UNION ALL
  SELECT 'indexes', string_agg(i.indexrelid::regclass::text, ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i
   WHERE i.indrelid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass,
                        'public.lightning_hand'::regclass, 'public.lightning_pool_session'::regclass)
  UNION ALL
  SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c
   WHERE c.conrelid IN ('public.lightning_integrity_signal'::regclass, 'public.lightning_matcher_shadow_comparison'::regclass);
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a FULL JOIN rcap2 b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 12: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  12 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, every signal and ledger row, the hand, pool, event and mirror counts, both tables'' ACLs and RLS, and every index and constraint exactly as they were'
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
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^ lp10_rewrite|^ lp9r2_rewrite|^ lp11_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# THIRTEEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 13 ]; then
  echo "FAIL: $oks of the 13 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 11 (DB), 13 sections, under production's default function ACLs and its live autorevoke event trigger, over the real chain through Phase 10 and the Phase 9 remediation (20261008142857): before the file nothing of it exists; after it no predecessor proof is falsified; over 125 real hands the scan finds the planted human-horse pairing concentration, the one-way chip flow (mirrored once into ca_collusion_signals), the shared address and the referral and nothing in the random population; a pool that always plays together is not suspicious, rescans change nothing and an operator's clearing stands; coordinated joins and leaves and thirteen-hour sessions are found for humans and horses alike; the engine's timing aggregates are validated, clamped, judged by the database and idempotent; the quality score and its weights compute as documented; the shadow ledger refuses bad comparisons, scores, is idempotent and reports a promotion verdict; no seating decision changes when every signal stands; the doors and tables are the service's alone; non-Lightning play is untouched; every @live-proof holds and the file is re-appliable"
