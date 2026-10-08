#!/usr/bin/env bash
# Lightning Phase 9 remediation (the database side): the ended session
# answers, the reaper clamps and skips the frozen, and presence self-heals.
#
# Proves 20261008142857 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55558 (LIGHTNING_P9R2_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 9's disconnect file (20261008050805) AND Phase 10
# (20261008111425), in order, exactly as test-lightning-phase10-rg-rebuy.sh
# builds them, then the migration under test, twice. Every Cluster is
# converted ON by the real drive, every hand formed by the real barrier,
# dealt by the real begin_dealing, folded through the real fold door and
# settled by the real settlement; every disconnect goes through the real
# presence door, every stop through the real stop door, every expiry through
# the real reaper, and every freeze through the real settlement freeze. The
# rows the harness writes itself are fixture boundaries only: backdated
# disconnected_at stamps (time travel), a forming instance with a committed
# reservation (the pre-barrier formation state the engine can leave
# mid-build), and one cluster_mode restore after a freeze (the real
# fn_cash_cluster_unfreeze exits every session itself and reverts to
# must_move, so proving that the reaper's frozen-cluster guard LIFTS needs
# the pre-freeze mode put back as the thaw the guard waits for).
#
# LAW 10.5. Horses sit beside humans in every Cluster: they are reaped,
# answered, healed and frozen out exactly as humans. The migration reads
# neither is_horse nor horse_id.
#
# LIGHTNING_P9R2_MIGRATION overrides the file under test, so mutation
# testing never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function
# privileges and its trg_autorevoke_privileged_anon event trigger (the
# Phase 8/9/10 harness ground, verbatim) before the file runs.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P9R2_PORT:-55558}
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
mine=${LIGHTNING_P9R2_MIGRATION:-$M/20261008142857_lightning_phase_9_remediation_the_ended_session_answers_the_.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p9r2-test.XXXXXX")
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
}

# ===========================================================================
# THE GROUND: the Phase 8/9 harness's ground, verbatim (its helpers and
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

-- 00 THE CATCHERS CATCH, THE FILE IS ABSENT ----------------------------------------
DO $$
DECLARE s1 text; s2 text; s3 text; s4 text;
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  s1 := pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure);
  s2 := pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure);
  s3 := pg_get_functiondef('public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)'::regprocedure);
  s4 := pg_get_functiondef('public.fn_lightning_stop_playing(uuid)'::regprocedure);
  IF s1 ~ '''exit_reason''' OR s1 ~ '''ended''' OR s1 ~ 'v_hand_id'
     OR s2 ~ 'LIMIT LEAST' OR s2 ~ 'cluster_mode = ''frozen'''
     OR s3 ~ '''player_reconnected''' OR s4 ~ '''player_reconnected''' OR s4 ~ 'v_frozen' THEN
    RAISE EXCEPTION 'FAIL 00: an edit of the migration under test exists before it is applied';
  END IF;
  -- THE GROUND IS AS HOSTILE AS PRODUCTION: the autorevoke event trigger is
  -- live, the default ACL is installed, and a function created now is born
  -- executable by anon and authenticated, which is the state the file's
  -- substitutions have to survive.
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger
                  WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d
                     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f') THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACL + autorevoke) is not installed';
  END IF;
  -- The pre-file grants the substitutions must carry: one browser snapshot
  -- door and stop door, one service fold door and reaper.
  IF NOT (has_function_privilege('authenticated', 'public.fn_lightning_reconnect_state(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.fn_lightning_reconnect_state(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.fn_lightning_stop_playing(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'FAIL 00: the chain''s grants are not the expected ground';
  END IF;
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; no edit of the file under test (the ended answer, the hand_id scoping, the clamp, the frozen guard, the heals) exists before it is applied; production''s default ACL and autorevoke event trigger are live and the chain''s grants are the expected ground'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
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
END $$;
\echo '  ok  01 NOTHING FALSIFIED  every predecessor live proof (Phases 1 through 10) that held before the file still holds after it, and more than a hundred of them held before'

-- 02 THE ENDED ANSWER FOR A REAPED PLAYER, HUMAN AND HORSE ---------------------------
DO $$
DECLARE v_g uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid();
        r jsonb; v_seat record; v_ps record;
BEGIN
  v_g := harness.lc('END1');
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.seat(v_g, v_h, true);
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);
  -- TIME TRAVEL (fixture boundary): the stamp ages past the 180s default.
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE cluster_id = v_g AND player_id IN (v_p, v_h) AND exited_at IS NULL;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 02: the reaper did not expire both: %', r;
  END IF;

  v_ps := harness.psrow(v_g, v_p);
  SELECT ts.table_id, ts.seat_number INTO v_seat FROM public.table_seats ts WHERE ts.id = v_ps.anchor_seat_id;
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM
        ARRAY['disconnected_at', 'exit_reason', 'hand_id', 'in_hand', 'joinable', 'pool_session_id',
              'seat_number', 'seat_table_id', 'stack', 'state', 'stop_requested']
     OR (r ->> 'pool_session_id')::uuid IS DISTINCT FROM v_ps.id
     OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR (r ->> 'in_hand')::boolean IS DISTINCT FROM false
     OR r -> 'hand_id' <> 'null'::jsonb
     OR r -> 'disconnected_at' = 'null'::jsonb
     OR (r ->> 'stop_requested')::boolean IS DISTINCT FROM false
     OR (r ->> 'seat_table_id')::uuid IS DISTINCT FROM v_seat.table_id
     OR (r ->> 'seat_number')::integer IS DISTINCT FROM v_seat.seat_number
     OR (r ->> 'stack')::numeric IS DISTINCT FROM v_ps.ending_stack
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM (public.fn_lightning_pool_status(v_g) ->> 'joinable')::boolean
     OR r ->> 'exit_reason' IS DISTINCT FROM 'disconnect_expired' THEN
    RAISE EXCEPTION 'FAIL 02: the reaped human''s ending does not answer: %', r;
  END IF;

  -- THE HORSE, identically.
  v_ps := harness.psrow(v_g, v_h);
  SELECT ts.table_id, ts.seat_number INTO v_seat FROM public.table_seats ts WHERE ts.id = v_ps.anchor_seat_id;
  PERFORM harness.as_user(v_h);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR r ->> 'exit_reason' IS DISTINCT FROM 'disconnect_expired'
     OR (r ->> 'pool_session_id')::uuid IS DISTINCT FROM v_ps.id
     OR (r ->> 'seat_table_id')::uuid IS DISTINCT FROM v_seat.table_id
     OR (r ->> 'seat_number')::integer IS DISTINCT FROM v_seat.seat_number
     OR (r ->> 'stack')::numeric IS DISTINCT FROM v_ps.ending_stack THEN
    RAISE EXCEPTION 'FAIL 02: the reaped horse''s ending does not answer: %', r;
  END IF;

  -- STILL THE CALLER'S OWN: a stranger and no caller read nothing.
  PERFORM harness.as_user(gen_random_uuid());
  IF public.fn_lightning_reconnect_state(v_g) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 02: a stranger read an ended session';
  END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_reconnect_state(v_g) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 02: no caller read an ended session';
  END IF;
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9r2:end1', v_g, v_p, v_h);
END $$;
\echo '  ok  02 THE REAPED ENDING  a timed-out human and a timed-out horse each read their own ended session: exactly eleven keys, state ended, exit_reason disconnect_expired, the stamp, the still-held anchor seat pointer, the ending stack and pool status''s joinable; a stranger and no caller still read NULL'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 03 THE ENDED ANSWER FOR A STOPPED PLAYER, AND THE MOST RECENT WINS ------------------
DO $$
DECLARE v_g uuid; v_p uuid := gen_random_uuid(); r jsonb; v_first uuid; v_second uuid;
BEGIN
  v_g := harness.lc('END2');
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_stop_playing(v_g);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'exited')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 03: the idle stop did not exit at once: %', r;
  END IF;
  v_first := (r ->> 'pool_session_id')::uuid;
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR r ->> 'exit_reason' IS DISTINCT FROM 'stop_playing'
     OR (r ->> 'stop_requested')::boolean IS DISTINCT FROM true
     OR r -> 'disconnected_at' <> 'null'::jsonb
     OR (r ->> 'pool_session_id')::uuid IS DISTINCT FROM v_first
     OR r -> 'seat_table_id' = 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 03: the stopped ending does not answer: %', r;
  END IF;
  PERFORM harness.as_user(NULL, NULL);

  -- THE MOST RECENT EXITED SESSION WINS: the player returns through the real
  -- doors (old seat stood up, a fresh arrival), times out, and the answer
  -- names the NEW session and ITS reason.
  UPDATE public.table_seats SET left_at = clock_timestamp()
   WHERE id = (SELECT anchor_seat_id FROM public.lightning_pool_session WHERE id = v_first);
  -- The cash session is the seat door's to open once per cluster; a left seat
  -- closes it (fixture boundary, the cash-out the engine does on departure)
  -- so the fresh arrival opens a new one.
  UPDATE public.cash_player_session SET closed_at = clock_timestamp(), closed_reason = 'fixture_departure'
   WHERE player_id = v_p AND scope_type = 'cluster' AND scope_id = v_g AND closed_at IS NULL;
  PERFORM harness.seat(v_g, v_p, false);
  v_second := harness.session(v_g, v_p);
  IF v_second IS NOT DISTINCT FROM v_first OR (harness.psrow(v_g, v_p)).exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: the return did not open a fresh session';
  END IF;
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE id = v_second AND exited_at IS NULL;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'pool_session_id')::uuid IS DISTINCT FROM v_second
     OR r ->> 'exit_reason' IS DISTINCT FROM 'disconnect_expired'
     OR (r ->> 'stop_requested')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 03: the most recent exited session did not win: %', r;
  END IF;
  PERFORM harness.as_user(NULL, NULL);
  INSERT INTO harness.p8 (k, game, a, b, c) VALUES ('p9r2:end2', v_g, v_p, v_first, v_second);
END $$;
\echo '  ok  03 THE STOPPED ENDING  an idle Stop Playing exits at once and the ended answer says stop_playing with stop_requested true and the seat pointer; after a fresh arrival and a timeout, the MOST RECENT exited session answers with ITS id and ITS reason'

-- 04 THE SEAT POINTER ASKS WHO OWNS THE CHAIR -----------------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; r jsonb; v_seat uuid; v_usurper uuid := gen_random_uuid();
BEGIN
  SELECT game, a, b INTO v_g, v_p, v_h FROM harness.p8 WHERE k = 'p9r2:end1';

  -- STOOD UP: the human's reaped anchor seat leaves; the pointer goes NULL
  -- and the rest of the ending still answers.
  v_seat := (harness.psrow(v_g, v_p)).anchor_seat_id;
  UPDATE public.table_seats SET left_at = clock_timestamp() WHERE id = v_seat;
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR r ->> 'exit_reason' IS DISTINCT FROM 'disconnect_expired'
     OR r -> 'seat_table_id' <> 'null'::jsonb OR r -> 'seat_number' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 04: a stood-up seat still answered a pointer: %', r;
  END IF;

  -- RE-OWNED: the horse's reaped anchor seat is handed to another player;
  -- the horse's ending never points at somebody else's chair.
  v_seat := (harness.psrow(v_g, v_h)).anchor_seat_id;
  UPDATE public.table_seats SET user_id = v_usurper WHERE id = v_seat;
  PERFORM harness.as_user(v_h);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR r -> 'seat_table_id' <> 'null'::jsonb OR r -> 'seat_number' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 04: a re-owned seat was answered as the horse''s own: %', r;
  END IF;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  04 THE SEAT POINTER  the ended answer carries the anchor seat only while the caller still owns it: stood up it is NULL, re-owned by another player it is NULL, and the rest of the ending still answers'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 05 THE OPEN ANSWER KEEPS ITS SHAPE, PLUS exit_reason NULL ---------------------------
DO $$
DECLARE v_g uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid();
        r jsonb; r2 jsonb; f jsonb; v_hand uuid; v_err text;
BEGIN
  v_g := harness.lc('OPEN');
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.seat(v_g, v_h, true);
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r IS NULL
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM
        ARRAY['disconnected_at', 'exit_reason', 'hand_id', 'in_hand', 'joinable', 'pool_session_id',
              'seat_number', 'seat_table_id', 'stack', 'state', 'stop_requested']
     OR (r ->> 'pool_session_id')::uuid IS DISTINCT FROM harness.session(v_g, v_p)
     OR r ->> 'state' IS DISTINCT FROM 'active'
     OR r -> 'exit_reason' <> 'null'::jsonb
     OR (r ->> 'in_hand')::boolean IS DISTINCT FROM false
     OR r -> 'hand_id' <> 'null'::jsonb
     OR (r ->> 'stack')::numeric IS DISTINCT FROM public.fn_lightning_pool_stack(harness.session(v_g, v_p))
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the open answer changed shape: %', r;
  END IF;

  -- DISCONNECTED BUT OPEN: state says so, exit_reason stays NULL.
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r ->> 'state' IS DISTINCT FROM 'disconnected' OR r -> 'disconnected_at' = 'null'::jsonb
     OR r -> 'exit_reason' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 05: the disconnected open answer is wrong: %', r;
  END IF;
  PERFORM public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p]);

  -- IN A DEALT HAND: the caller's own hand id, the horse identically.
  f := harness.form(v_g, ARRAY[v_p, v_h]);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal((f ->> 'instance_id')::uuid);
  v_hand := (f ->> 'hand_id')::uuid;
  r := public.fn_lightning_reconnect_state(v_g);
  PERFORM harness.as_user(v_h);
  r2 := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'in_hand')::boolean IS DISTINCT FROM true OR (r ->> 'hand_id')::uuid IS DISTINCT FROM v_hand
     OR (r2 ->> 'in_hand')::boolean IS DISTINCT FROM true OR (r2 ->> 'hand_id')::uuid IS DISTINCT FROM v_hand
     OR r -> 'exit_reason' <> 'null'::jsonb OR r2 -> 'exit_reason' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 05: the in-hand answer is wrong: % / %', r, r2;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  f := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand,
         jsonb_build_object(v_p::text, jsonb_build_object('d', 1, 'c', 1, 's', true),
                            v_h::text, jsonb_build_object('d', -1, 'c', 1, 's', true))), 0, 0,
         jsonb_build_object('pot_size', 2, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', v_p, 'amount', 2, 'potIndex', 0))));
  IF (f ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 05: the settlement refused: %', f; END IF;

  -- THE ROLES: authenticated may ask, anon is refused.
  PERFORM harness.as_user(v_p);
  SET ROLE authenticated;
  IF public.fn_lightning_reconnect_state(v_g) IS NULL THEN RESET ROLE; RAISE EXCEPTION 'FAIL 05: authenticated cannot ask'; END IF;
  RESET ROLE;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_reconnect_state(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 05: anon asked: %', v_err; END IF;
  PERFORM harness.as_user(NULL, NULL);
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9r2:open', v_g, v_p, v_h);
END $$;
\echo '  ok  05 THE OPEN ANSWER  an open session answers its exact prior shape plus exit_reason null: eleven keys, the session, the pool stack, pool status''s joinable; disconnected it says so with exit_reason still null; in a dealt hand it names the caller''s own hand, the horse identically; authenticated may ask and anon is refused 42501'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 06 A FORMING INSTANCE NEVER LEAKS ITS ID AS hand_id ---------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_i uuid; v_slot uuid; v_e integer; r jsonb;
BEGIN
  SELECT game, a, b INTO v_g, v_p, v_h FROM harness.p8 WHERE k = 'p9r2:open';
  SELECT cluster_epoch INTO v_e FROM public.cash_games WHERE id = v_g;
  v_i := (public.fn_lightning_instance_open(v_g) ->> 'instance_id')::uuid;
  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = v_g AND sl.player_id = v_p AND sl.closed_at IS NULL;
  -- THE PRE-BARRIER STATE the engine can leave mid-build (fixture boundary):
  -- a committed reservation bound to a still-forming instance, no hand yet.
  -- Born pending (a claim anybody could race for), then committed onto the
  -- forming instance, as the real matcher does it: the discipline trigger
  -- refuses a reservation inserted already committed.
  INSERT INTO public.lightning_reservation
    (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id, expires_at)
  VALUES (v_g, v_e, v_p, v_slot, v_i, clock_timestamp() + interval '60 seconds');
  UPDATE public.lightning_reservation
     SET state = 'committed', resolved_at = clock_timestamp()
   WHERE cluster_id = v_g AND player_id = v_p AND state = 'pending';
  IF (SELECT li.state FROM public.lightning_instance li WHERE li.id = v_i) IS DISTINCT FROM 'forming'
     OR (SELECT li.hand_id FROM public.lightning_instance li WHERE li.id = v_i) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: the forming fixture is not forming';
  END IF;
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'in_hand')::boolean IS DISTINCT FROM true
     OR r -> 'hand_id' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: a forming instance leaked into the snapshot: %', r;
  END IF;
  -- The shared reader still vouches for the engagement (its other callers'
  -- contract), so this was reconnect_state''s scoping, not a silence.
  IF public.fn_lightning_player_live_hand(v_p, v_g) IS NULL THEN
    RAISE EXCEPTION 'FAIL 06: the shared live-hand reader no longer vouches for a forming commitment';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_i, 'fixture_abandon');
  r := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'in_hand')::boolean IS DISTINCT FROM false OR r -> 'hand_id' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: the abandoned instance still answers: %', r;
  END IF;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  06 THE FORMING SNAPSHOT  a committed reservation on a still-forming instance answers in_hand true with hand_id null (never the instance id), while the shared live-hand reader keeps vouching for the engagement its other callers depend on; abandoned, the snapshot goes quiet'

-- 07 THE REAPER'S LIMITS: BOUNDED BELOW AND ABOVE -------------------------------------
DO $$
DECLARE v_g uuid; v_a uuid := gen_random_uuid(); v_b uuid := gen_random_uuid(); r jsonb;
BEGIN
  v_g := harness.lc('LIM');
  PERFORM harness.seat(v_g, v_a, false);
  PERFORM harness.seat(v_g, v_b, true);
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_a, v_b], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE cluster_id = v_g AND player_id IN (v_a, v_b) AND exited_at IS NULL;
  -- p_limit 0 clamps up to one: one expiry per pass, no more.
  r := public.fn_lightning_reap_expired_disconnects(v_g, clock_timestamp(), 0);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 07: p_limit 0 did not clamp up to exactly one: %', r;
  END IF;
  -- An absurd p_limit is accepted and clamped (the 2000 ceiling is pinned by
  -- the live proof on the body; behaviour here proves the call survives it).
  r := public.fn_lightning_reap_expired_disconnects(v_g, clock_timestamp(), 2147483647);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 07: the second expiry did not land under a huge p_limit: %', r;
  END IF;
  IF LEAST(GREATEST(1, coalesce(2147483647, 200)), 2000) <> 2000
     OR LEAST(GREATEST(1, coalesce(NULL::integer, 200)), 2000) <> 200
     OR LEAST(GREATEST(1, coalesce(0, 200)), 2000) <> 1 THEN
    RAISE EXCEPTION 'FAIL 07: the clamp arithmetic is not the one the body carries';
  END IF;
END $$;
\echo '  ok  07 THE REAPER CLAMPS  p_limit 0 clamps up to one expiry per pass, an absurd p_limit is accepted and bounded (the 2000 ceiling pinned on the body by its live proof), and the defaulted call keeps its 200'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 08 A FROZEN CLUSTER IS EVIDENCE -----------------------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; v_d uuid; v_p uuid := gen_random_uuid(); v_q uuid := gen_random_uuid();
        v_r uuid := gen_random_uuid(); v_s uuid := gen_random_uuid(); v_op uuid := gen_random_uuid();
        r jsonb; v_left integer; v_mode text;
BEGIN
  v_a := harness.lc('FRZA'); v_b := harness.lc('FRZB');
  PERFORM harness.seat(v_a, v_p, false);
  PERFORM harness.seat(v_a, v_q, true);
  PERFORM harness.seat(v_b, v_r, false);
  PERFORM public.fn_lightning_presence_report(v_a, ARRAY[v_p], NULL);
  PERFORM public.fn_lightning_presence_report(v_b, ARRAY[v_r], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE player_id IN (v_p, v_r) AND exited_at IS NULL;
  SELECT cluster_mode INTO v_mode FROM public.cash_games WHERE id = v_a;
  r := public.fn_lightning_settlement_freeze(v_a, (SELECT cluster_epoch FROM public.cash_games WHERE id = v_a),
         gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'P9R2: frozen for forensics', '{}'::jsonb);
  IF (SELECT cluster_mode FROM public.cash_games WHERE id = v_a) IS DISTINCT FROM 'frozen' THEN
    RAISE EXCEPTION 'FAIL 08: the real freeze did not freeze: %', r;
  END IF;

  -- THE IDLE STOP WAITS OUT THE FREEZE: the mark is recorded, the session is
  -- not exited, and no pool_player_left is written for it.
  v_left := harness.evn(v_a, 'pool_player_left');
  PERFORM harness.as_user(v_q);
  r := public.fn_lightning_stop_playing(v_a);
  PERFORM harness.as_user(NULL, NULL);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'exited')::boolean IS DISTINCT FROM false
     OR (r ->> 'in_hand')::boolean IS DISTINCT FROM false
     OR (harness.psrow(v_a, v_q)).stop_requested_at IS NULL
     OR (harness.psrow(v_a, v_q)).exited_at IS NOT NULL
     OR harness.evn(v_a, 'pool_player_left') <> v_left THEN
    RAISE EXCEPTION 'FAIL 08: the idle stop did not wait out the freeze: % / %', r, to_jsonb(harness.psrow(v_a, v_q));
  END IF;

  -- THE REAPER SKIPS THE FROZEN CLUSTER, asked directly or across the estate,
  -- and still reaps the thawed control.
  r := public.fn_lightning_reap_expired_disconnects(v_a);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 0 OR jsonb_array_length(r -> 'rows') <> 0
     OR (harness.psrow(v_a, v_p)).exited_at IS NOT NULL
     OR (harness.psrow(v_a, v_p)).disconnected_at IS NULL THEN
    RAISE EXCEPTION 'FAIL 08: the reaper touched a frozen cluster: %', r;
  END IF;
  r := public.fn_lightning_reap_expired_disconnects();
  IF (harness.psrow(v_a, v_p)).exited_at IS NOT NULL OR (harness.psrow(v_a, v_q)).exited_at IS NOT NULL
     OR (harness.psrow(v_b, v_r)).exited_at IS NULL
     OR (harness.psrow(v_b, v_r)).exit_reason IS DISTINCT FROM 'disconnect_expired' THEN
    RAISE EXCEPTION 'FAIL 08: the estate pass mixed the frozen and the thawed: %', r;
  END IF;

  -- THE THAW LIFTS THE GUARD. fn_cash_cluster_unfreeze exits every session
  -- itself ('cluster_unfrozen') and reverts to must_move, so proving the
  -- REAPER finishes what stood its time needs the pre-freeze mode put back
  -- (fixture boundary, the thaw the guard waits for).
  UPDATE public.cash_games SET cluster_mode = v_mode WHERE id = v_a;
  r := public.fn_lightning_reap_expired_disconnects(v_a);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 2
     OR (harness.psrow(v_a, v_p)).exit_reason IS DISTINCT FROM 'disconnect_expired'
     OR (harness.psrow(v_a, v_q)).exit_reason IS DISTINCT FROM 'stop_playing'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(harness.evlast(v_a, 'player_expired') -> 'players') x
                 WHERE (x ->> 'pool_session_id')::uuid = (harness.psrow(v_a, v_q)).id) THEN
    RAISE EXCEPTION 'FAIL 08: the thawed pass did not finish both exits rightly: %', r;
  END IF;

  -- THE REAL UNFREEZE OWNS THE FROZEN RECOVERY, and the ended answer carries
  -- its reason verbatim.
  v_d := harness.lc('FRZD');
  PERFORM harness.seat(v_d, v_s, false);
  r := public.fn_lightning_settlement_freeze(v_d, (SELECT cluster_epoch FROM public.cash_games WHERE id = v_d),
         gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'P9R2: frozen then unfrozen', '{}'::jsonb);
  r := public.fn_cash_cluster_unfreeze(v_d, v_op, 'P9R2: the operator unfreezes');
  IF (r ->> 'unfrozen')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the real unfreeze refused: %', r;
  END IF;
  PERFORM harness.as_user(v_s);
  r := public.fn_lightning_reconnect_state(v_d);
  PERFORM harness.as_user(NULL, NULL);
  IF r IS NULL OR r ->> 'state' IS DISTINCT FROM 'ended'
     OR r ->> 'exit_reason' IS DISTINCT FROM 'cluster_unfrozen'
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 08: the unfrozen ending does not answer verbatim: %', r;
  END IF;
END $$;
\echo '  ok  08 THE FROZEN CLUSTER  frozen by the real settlement freeze its pool-session rows are untouched: the idle stop records its mark but waits, the reaper skips it asked directly and across the estate while still reaping the control; thawed, one pass exits the timeout as disconnect_expired and the stopper as stop_playing with no player_expired record for the stop; the real unfreeze owns the frozen recovery and the ended answer says cluster_unfrozen verbatim'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 09 THE FOLD DOOR SELF-HEALS THE FOLDER ----------------------------------------------
DO $$
DECLARE v_g uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid();
        f jsonb; v_hand uuid; r jsonb; v_recon integer; v_t0 timestamptz;
BEGIN
  v_g := harness.lc('HEAL');
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.seat(v_g, v_h, true);
  -- BOTH DISCONNECTED while a hand is dealt to them (a lost presence report).
  f := harness.form(v_g, ARRAY[v_p, v_h]);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal((f ->> 'instance_id')::uuid);
  v_hand := (f ->> 'hand_id')::uuid;
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);
  IF (harness.psrow(v_g, v_p)).state <> 'disconnected' OR (harness.psrow(v_g, v_h)).state <> 'disconnected' THEN
    RAISE EXCEPTION 'FAIL 09: the disconnect fixture did not stamp both';
  END IF;
  v_recon := harness.evn(v_g, 'player_reconnected');

  -- THE HUMAN FOLDS: the fold is recorded, and the player's own stamp clears
  -- with one player_reconnected event; the horse stays disconnected (only
  -- the actor heals).
  r := public.fn_lightning_fast_fold(v_hand, v_p, gen_random_uuid(), 'fast', 1);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 09: the fold refused: %', r; END IF;
  IF (harness.psrow(v_g, v_p)).state <> 'active' OR (harness.psrow(v_g, v_p)).disconnected_at IS NOT NULL
     OR (harness.psrow(v_g, v_h)).state <> 'disconnected'
     OR harness.evn(v_g, 'player_reconnected') <> v_recon + 1 THEN
    RAISE EXCEPTION 'FAIL 09: the fold did not heal only the folder: p=% h=% ev=%',
      (harness.psrow(v_g, v_p)).state, (harness.psrow(v_g, v_h)).state, harness.evn(v_g, 'player_reconnected');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(harness.evlast(v_g, 'player_reconnected') -> 'players') x
                  WHERE (x ->> 'player_id')::uuid = v_p AND (x ->> 'pool_session_id')::uuid = harness.session(v_g, v_p)) THEN
    RAISE EXCEPTION 'FAIL 09: the player_reconnected event is not in the presence door''s shape';
  END IF;

  -- A SECOND FOLD-TYPE ANSWER ON AN ALREADY-CONNECTED FOLDER IS EVENT-LIGHT:
  -- the horse folds normally once (it was disconnected, heals), and folding
  -- again when already active (idempotent replay) emits no new heal event.
  r := public.fn_lightning_fast_fold(v_hand, v_h, gen_random_uuid(), 'fast', 1);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (harness.psrow(v_g, v_h)).state <> 'active'
     OR harness.evn(v_g, 'player_reconnected') <> v_recon + 2 THEN
    RAISE EXCEPTION 'FAIL 09: the horse fold did not heal once: %', r;
  END IF;
  v_recon := harness.evn(v_g, 'player_reconnected');
  r := public.fn_lightning_fast_fold(v_hand, v_h, gen_random_uuid(), 'fast', 1);
  IF (r ->> 'replay')::boolean IS DISTINCT FROM true OR harness.evn(v_g, 'player_reconnected') <> v_recon THEN
    RAISE EXCEPTION 'FAIL 09: a replay fold on a connected player emitted a heal event: %', r;
  END IF;
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9r2:heal', v_g, v_p, v_h);
END $$;
\echo '  ok  09 THE FOLD HEARTBEAT  a disconnected player who folds is healed to active, their own stamp cleared, with one player_reconnected event in the presence door''s shape; only the folder heals, not their tablemate; a replay fold on an already-connected player emits no new heal; the horse heals exactly as the human'

-- 10 THE STOP DOOR IS A HEARTBEAT TOO -------------------------------------------------
DO $$
DECLARE v_g uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid();
        f jsonb; v_hand uuid; r jsonb; v_recon integer;
BEGIN
  v_g := harness.lc('SHRT');
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.seat(v_g, v_h, true);
  -- A hand is dealt, then the player disconnects: the stop must stand aside
  -- for the live hand, but pressing it proves the player is back.
  f := harness.form(v_g, ARRAY[v_p, v_h]);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal((f ->> 'instance_id')::uuid);
  v_hand := (f ->> 'hand_id')::uuid;
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL);
  v_recon := harness.evn(v_g, 'player_reconnected');
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'exited')::boolean IS DISTINCT FROM false
     OR (r ->> 'in_hand')::boolean IS DISTINCT FROM true
     OR (harness.psrow(v_g, v_p)).stop_requested_at IS NULL
     OR (harness.psrow(v_g, v_p)).state <> 'active' OR (harness.psrow(v_g, v_p)).disconnected_at IS NOT NULL
     OR harness.evn(v_g, 'player_reconnected') <> v_recon + 1 THEN
    RAISE EXCEPTION 'FAIL 10: the in-hand stop did not stand aside and heal: % / %', r, to_jsonb(harness.psrow(v_g, v_p));
  END IF;
  -- The hand settles; the next reaper pass exits the standing stop.
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  f := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand,
         jsonb_build_object(v_p::text, jsonb_build_object('d', -1, 'c', 1, 'f', 'fast'),
                            v_h::text, jsonb_build_object('d', 1, 'c', 1, 's', true))), 0, 0,
         jsonb_build_object('pot_size', 2, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', v_h, 'amount', 2, 'potIndex', 0))));
  IF (f ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 10: settle refused: %', f; END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (harness.psrow(v_g, v_p)).exit_reason IS DISTINCT FROM 'stop_playing' THEN
    RAISE EXCEPTION 'FAIL 10: the standing stop was not finished by the reaper: %', r;
  END IF;
END $$;
\echo '  ok  10 THE STOP HEARTBEAT  an in-hand Stop stands aside for the live hand (exited false, in_hand true), records its mark AND heals the caller''s stale stamp with one player_reconnected event, then is finished by the post-hand reaper as stop_playing'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 11 NON-LIGHTNING PLAY IS UNTOUCHED --------------------------------------------------
DO $$
DECLARE v_g uuid; v_u uuid := gen_random_uuid(); r jsonb; v_seat integer;
BEGIN
  -- A must-move cluster (never converted): no pool session, so the ended
  -- answer, the fold heal and the reaper have nothing to touch, and a cash
  -- chair is taken exactly as before.
  v_g := harness.c8('plain', 6, 4, 1, 3, 1);
  SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat
    FROM public.table_seats ts WHERE ts.table_id = harness.feeder(v_g);
  PERFORM public.fxr_join(v_g, harness.feeder(v_g), v_seat, 200.00, false, true, v_u);
  IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                  WHERE ts.table_id = harness.feeder(v_g) AND ts.user_id = v_u AND ts.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g) THEN
    RAISE EXCEPTION 'FAIL 11: a must-move cluster gained a pool session or lost its chair';
  END IF;
  PERFORM harness.as_user(v_u);
  IF public.fn_lightning_reconnect_state(v_g) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 11: a must-move cluster answered a reconnect snapshot';
  END IF;
  PERFORM harness.as_user(NULL, NULL);
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 11: the reaper expired a non-Lightning session: %', r;
  END IF;
END $$;
\echo '  ok  11 NON-LIGHTNING UNTOUCHED  on a must-move cluster no pool session exists, a cash chair is taken exactly as before, the reconnect snapshot answers NULL and the reaper expires nothing'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 12 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 10
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 12: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  12 THE LIVE PROOFS  all ten @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%' OR p.proname = 'atomic_table_rebuy')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history', 'cash_cluster_events', 'table_pending_addons', 'club_members', 'responsible_gaming_limits']) x(t)
UNION ALL
SELECT 'ps', md5(string_agg(to_jsonb(ps)::text, '|' ORDER BY ps.id)) FROM public.lightning_pool_session ps
UNION ALL
SELECT 'events', md5(string_agg(to_jsonb(e)::text, '|' ORDER BY e.id)) FROM public.cash_cluster_events e
UNION ALL
SELECT 'wallets', md5(string_agg(m.user_id::text || ':' || m.chip_balance::text, '|' ORDER BY m.user_id)) FROM public.club_members m WHERE m.chip_balance IS NOT NULL
UNION ALL
SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_pool_session'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass;
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 13 RE-APPLIABLE ---------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a
    FULL JOIN (
      SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%' OR p.proname = 'atomic_table_rebuy')
      UNION ALL
      SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
        FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history', 'cash_cluster_events', 'table_pending_addons', 'club_members', 'responsible_gaming_limits']) x(t)
      UNION ALL
      SELECT 'ps', md5(string_agg(to_jsonb(ps)::text, '|' ORDER BY ps.id)) FROM public.lightning_pool_session ps
      UNION ALL
      SELECT 'events', md5(string_agg(to_jsonb(e)::text, '|' ORDER BY e.id)) FROM public.cash_cluster_events e
      UNION ALL
      SELECT 'wallets', md5(string_agg(m.user_id::text || ':' || m.chip_balance::text, '|' ORDER BY m.user_id)) FROM public.club_members m WHERE m.chip_balance IS NOT NULL
      UNION ALL
      SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_pool_session'::regclass AND NOT t.tgisinternal
      UNION ALL
      SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 13: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 13: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  13 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, the hand, participant, pool session, instance, history, event, addon, wallet and limits row counts, every pool session row, every event row, every funded wallet, and the pool session table''s triggers and constraints exactly as they were'
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
  -f "$phase8" -f "$p7r" -f "$fix" -f "$p9d" -f "$p10" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^ lp10_rewrite|^ lp9r2_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
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
echo "PASS: Lightning Phase 9 remediation (DB), 14 sections, under production's default function ACLs and its live autorevoke event trigger, over the real chain through Phase 10 (20261008111425): before the file none of its edits exist; after it no predecessor proof is falsified; a reaped human and horse each read their own ended session (exit_reason disconnect_expired, the still-held seat pointer, the ending stack); an idle stopper reads stop_playing and the most recent exited session wins; the seat pointer is NULL once the chair is stood up or re-owned; the open answer keeps its exact shape plus exit_reason null; a forming instance answers hand_id null while the shared reader keeps vouching for its other callers; the reaper clamps 0 up to one and an absurd limit down to the 2000 the body carries; a frozen cluster's rows are never mutated (idle stop waits, reaper skips) and the thaw lets the exits finish with no player_expired for the stop; the fold and stop doors self-heal the caller's own stale stamp with one player_reconnected event; non-Lightning play is untouched; every @live-proof holds and the file is re-appliable"
