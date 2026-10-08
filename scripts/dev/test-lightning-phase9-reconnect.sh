#!/usr/bin/env bash
# Lightning Phase 9 (specification Phases 14 and 15, the database side):
# disconnect / reconnect across every Lightning stage, and the event ledger,
# audit and forensics.
#
# Proves 20261008050805 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55556 (LIGHTNING_P9_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The Lightning fixtures and every Lightning
# migration from 20260920235343 through Phase 8 (20261007212735), the Phase 7
# remediation (20261007222717) and the Phase 7/8 review fixes (20261008043021)
# in order, exactly as test-lightning-phase8-session.sh builds them, then the
# migration under test, twice. Every Cluster is converted ON by the real
# drive, every pool slot comes from the real slot sync, every hand is formed
# by the real barrier, dealt by the real begin_dealing and settled by the real
# fn_lightning_settle_hand through the physical door; every disconnect goes
# through the real presence door and every expiry through the real reaper.
# The only rows the harness writes itself are backdated disconnected_at
# stamps (so a 30-second-floor timeout can expire inside a test run), one
# state flip to sit_out and one to frozen (to reach those paths), engine
# stand-ups (left_at, as production's engine writes them), and the tampered
# copies section 10 then restores.
#
# LAW 10.5. Horses sit beside humans in every Cluster: they disconnect,
# reconnect, expire, and are audited exactly as humans. The migration reads
# neither is_horse nor horse_id.
#
# LIGHTNING_P9_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function
# privileges and its trg_autorevoke_privileged_anon event trigger (the
# Phase 8 harness's ground, verbatim) before the file runs.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P9_PORT:-55556}
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
mine=${LIGHTNING_P9_MIGRATION:-$M/20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p9-test.XXXXXX")
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
}

# ===========================================================================
# THE GROUND: the Phase 8 harness's ground, verbatim (its helpers and
# production's function-creation environment), then this phase's section 00.
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


-- 00 THE CATCHERS CATCH, THE FILE IS ABSENT ----------------------------------------
DO $$
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF to_regprocedure('public.fn_lightning_presence_report(uuid,uuid[],uuid[],timestamp with time zone)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_reconnect_state(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_cluster_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_hand_replay_check(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_pool_session'::regclass AND attname = 'disconnected_at' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_pool_session'::regclass AND conname = 'lightning_pool_session_disconnect_is_dated')
     OR (public.fn_lightning_config(NULL) ? 'disconnect_timeout_ms')
     OR pg_get_functiondef('public.fn_cash_clusters_tick_all(jsonb)'::regprocedure) ~ 'fn_lightning_reap_expired_disconnects'
     OR pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) ~ '''pool_player_left''' THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  -- THE GROUND IS AS HOSTILE AS PRODUCTION: the autorevoke event trigger is
  -- live, the default ACL is installed, and a function created now is born
  -- executable by anon and authenticated, which is the state the file's
  -- REVOKEs have to survive.
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger
                  WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d
                     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f') THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACL + autorevoke) is not installed';
  END IF;
  EXECUTE 'CREATE FUNCTION public.fx9_born_open() RETURNS integer LANGUAGE sql AS $q$ SELECT 1 $q$';
  IF NOT has_function_privilege('anon', 'public.fx9_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fx9_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fx9_born_open()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 00: the default ACL does not hand a new function to anon, authenticated and service_role';
  END IF;
  EXECUTE 'DROP FUNCTION public.fx9_born_open()';
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; none of the five doors, the stamp column, its constraint, the configuration key, the tick wiring or the unfreeze event exists before the file; production''s default ACL and autorevoke event trigger are live, and a function created now is born executable by anon, authenticated and service_role'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- Small readers for this phase: event counts, the latest payload of a kind,
-- and the player's newest pool session row.
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

-- 01 NOTHING BEFORE IT IS FALSIFIED BUT THE RESTATED TICK READING ----------------
DO $$
DECLARE v_bad text; v_n integer;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ' ORDER BY b.src, b.n) INTO v_bad
    FROM harness.lp8 b JOIN harness.lp8 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  -- EXACTLY the one proof that counts the tick at four EXCEPTION sub-blocks
  -- (20260926023047 #27): the file adds a fifth, isolated the same way, and
  -- restates that reading at five with the reap order extended by one step.
  IF v_bad IS DISTINCT FROM 'p9r#27' THEN
    RAISE EXCEPTION 'FAIL 01: predecessor proofs falsified by the file: %', coalesce(v_bad, '(none)');
  END IF;
  SELECT count(*) INTO v_n FROM harness.lp8 WHERE phase = 'after' AND ok IS TRUE;
  IF v_n < 150 OR (SELECT count(*) FROM harness.lp8 WHERE phase = 'before') <> (SELECT count(*) FROM harness.lp8 WHERE phase = 'after') THEN
    RAISE EXCEPTION 'FAIL 01: only % predecessor proofs were read true, so this proves too little', v_n;
  END IF;
END $$;
\echo '  ok  01 NOTHING BEFORE IT IS FALSIFIED  every @live-proof of every Lightning file from Phase 1 through 20261008043021 that held before the file holds after it, except exactly the one that counts the tick at four EXCEPTION sub-blocks, which the file restates at five'

-- 02 THE CONFIGURATION ---------------------------------------------------------------
DO $$
DECLARE v uuid; c jsonb;
BEGIN
  v := public.fx9_cluster('P9 CFG', 6, 40, true);
  c := public.fn_lightning_config(v);
  IF (c ->> 'disconnect_timeout_ms')::integer <> 180000 OR c -> 'invalid' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: the default is not 180000 clean: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"disconnect_timeout_ms": 60000}');
  c := public.fn_lightning_config(v);
  IF (c ->> 'disconnect_timeout_ms')::integer <> 60000 OR c -> 'invalid' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: a configured 60000 was not honoured: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"disconnect_timeout_ms": 1000}');
  c := public.fn_lightning_config(v);
  IF (c ->> 'disconnect_timeout_ms')::integer <> 30000
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason')) FROM jsonb_array_elements(c -> 'invalid') x)
        IS DISTINCT FROM ARRAY['disconnect_timeout_ms:out_of_range_clamped'] THEN
    RAISE EXCEPTION 'FAIL 02: 1000 was not clamped to the 30 second floor and reported: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"disconnect_timeout_ms": 7200000}');
  c := public.fn_lightning_config(v);
  IF (c ->> 'disconnect_timeout_ms')::integer <> 1800000
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason')) FROM jsonb_array_elements(c -> 'invalid') x)
        IS DISTINCT FROM ARRAY['disconnect_timeout_ms:out_of_range_clamped'] THEN
    RAISE EXCEPTION 'FAIL 02: two hours was not clamped to the 30 minute cap and reported: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"disconnect_timeout_ms": "soon"}');
  c := public.fn_lightning_config(v);
  IF (c ->> 'disconnect_timeout_ms')::integer <> 180000
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason')) FROM jsonb_array_elements(c -> 'invalid') x)
        IS DISTINCT FROM ARRAY['disconnect_timeout_ms:wrong_type'] THEN
    RAISE EXCEPTION 'FAIL 02: a string did not fall back to the default and report: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{}');
  IF (public.fn_lightning_config(NULL) ->> 'disconnect_timeout_ms')::integer <> 180000 THEN
    RAISE EXCEPTION 'FAIL 02: an unknown Cluster does not answer the default';
  END IF;
END $$;
\echo '  ok  02 THE CONFIGURATION  disconnect_timeout_ms defaults to 180000; 60000 is honoured; 1000 clamps to the 30 second floor and 7200000 to the 30 minute cap, each reported in invalid; a string falls back to the default and reports; an unknown Cluster answers the default'

-- 03 THE PRESENCE DOOR IS IDEMPOTENT AND EVENT-LIGHT ----------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_s uuid; r jsonb; v_t0 timestamptz; p jsonb; v_epoch integer;
BEGIN
  v_g := harness.lc('PRES');
  v_p := (harness.idle(v_g, false, 1))[1];
  v_h := (harness.idle(v_g, true, 1))[1];
  v_s := (harness.idle(v_g, false, 1, ARRAY[v_p]))[1];
  SELECT cluster_epoch INTO v_epoch FROM public.cash_games WHERE id = v_g;
  IF harness.evn(v_g, 'player_disconnected') <> 0 OR harness.evn(v_g, 'player_reconnected') <> 0 THEN
    RAISE EXCEPTION 'FAIL 03: presence events exist before any report';
  END IF;

  r := public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR jsonb_array_length(r -> 'disconnected') <> 2
     OR r -> 'reconnected' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 03: the report did not stamp the two: %', r;
  END IF;
  IF (SELECT count(*) FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND ps.exited_at IS NULL
         AND ps.state = 'disconnected' AND ps.disconnected_at IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'FAIL 03: the sessions are not disconnected and dated';
  END IF;
  v_t0 := (harness.psrow(v_g, v_p)).disconnected_at;
  IF harness.evn(v_g, 'player_disconnected') <> 1 THEN RAISE EXCEPTION 'FAIL 03: not exactly one event for two players'; END IF;
  p := harness.evlast(v_g, 'player_disconnected');
  IF jsonb_array_length(p -> 'players') <> 2 OR (p ->> 'cluster_epoch')::integer <> v_epoch
     OR (SELECT e.event_version FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'player_disconnected' ORDER BY e.id DESC LIMIT 1) <> 1 THEN
    RAISE EXCEPTION 'FAIL 03: the event does not carry the list, the epoch and version 1: %', p;
  END IF;

  -- IDEMPOTENT: the same report again moves nothing and writes nothing.
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);
  IF r -> 'disconnected' <> '[]'::jsonb OR harness.evn(v_g, 'player_disconnected') <> 1
     OR (harness.psrow(v_g, v_p)).disconnected_at IS DISTINCT FROM v_t0 THEN
    RAISE EXCEPTION 'FAIL 03: a repeated report moved the stamp or wrote an event: %', r;
  END IF;

  -- A RECONNECT of somebody never reported changes nothing.
  r := public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_s, gen_random_uuid()]);
  IF r -> 'reconnected' <> '[]'::jsonb OR harness.evn(v_g, 'player_reconnected') <> 0 THEN
    RAISE EXCEPTION 'FAIL 03: a vacuous reconnect wrote something: %', r;
  END IF;

  -- THE RECONNECT clears the player and says so once.
  r := public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p]);
  IF jsonb_array_length(r -> 'reconnected') <> 1
     OR (harness.psrow(v_g, v_p)).state <> 'active' OR (harness.psrow(v_g, v_p)).disconnected_at IS NOT NULL
     OR (harness.psrow(v_g, v_h)).state <> 'disconnected'
     OR harness.evn(v_g, 'player_reconnected') <> 1 THEN
    RAISE EXCEPTION 'FAIL 03: the reconnect did not clear exactly the one: %', r;
  END IF;
  r := public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p]);
  IF r -> 'reconnected' <> '[]'::jsonb OR harness.evn(v_g, 'player_reconnected') <> 1 THEN
    RAISE EXCEPTION 'FAIL 03: a repeated reconnect wrote an event';
  END IF;

  -- BOTH LISTS: the reconnect wins; said once for a stamped player, never
  -- for a clear one.
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_h], ARRAY[v_h]);
  IF (harness.psrow(v_g, v_h)).state <> 'active' OR (harness.psrow(v_g, v_h)).disconnected_at IS NOT NULL
     OR harness.evn(v_g, 'player_reconnected') <> 2 OR harness.evn(v_g, 'player_disconnected') <> 1 THEN
    RAISE EXCEPTION 'FAIL 03: both lists did not end connected, once: %', r;
  END IF;
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_h], ARRAY[v_h]);
  IF harness.evn(v_g, 'player_reconnected') <> 2 OR harness.evn(v_g, 'player_disconnected') <> 1 THEN
    RAISE EXCEPTION 'FAIL 03: both lists on a connected player wrote something';
  END IF;

  -- A FUTURE CLOCK IS CLAMPED: the stamp can never be born aged.
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL, clock_timestamp() + interval '1 hour');
  IF (harness.psrow(v_g, v_p)).disconnected_at > clock_timestamp() THEN
    RAISE EXCEPTION 'FAIL 03: a future p_now stamped the future';
  END IF;
  PERFORM public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p]);

  -- A sit_out SESSION keeps its state and only carries the stamp.
  UPDATE public.lightning_pool_session SET state = 'sit_out' WHERE id = harness.session(v_g, v_s);
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_s], NULL);
  IF (harness.psrow(v_g, v_s)).state <> 'sit_out' OR (harness.psrow(v_g, v_s)).disconnected_at IS NULL THEN
    RAISE EXCEPTION 'FAIL 03: a sit_out session was flipped or left undated';
  END IF;
  PERFORM public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_s]);
  IF (harness.psrow(v_g, v_s)).state <> 'sit_out' OR (harness.psrow(v_g, v_s)).disconnected_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 03: a sit_out reconnect flipped the state or kept the stamp';
  END IF;
  UPDATE public.lightning_pool_session SET state = 'active' WHERE id = harness.session(v_g, v_s);

  -- AN UNKNOWN CLUSTER is refused, not invented.
  r := public.fn_lightning_presence_report(gen_random_uuid(), ARRAY[v_p], NULL);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false OR r ->> 'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'FAIL 03: an unknown Cluster answered: %', r;
  END IF;
  INSERT INTO harness.p8 (k, game, a, b, c) VALUES ('p9pres', v_g, v_p, v_h, v_s);
END $$;
\echo '  ok  03 THE PRESENCE DOOR  one report stamps a human and a horse disconnected and dated with ONE player_disconnected event carrying both, the epoch and version 1; repeating it moves no stamp and writes nothing; a vacuous reconnect writes nothing; the reconnect clears exactly the named player with ONE event and repeats silently; a player in both lists ends connected; a future clock is clamped; a sit_out session keeps its state both ways; an unknown Cluster answers not_found'

-- 04 THE MATCHER WITHHOLDS, DIAGNOSES WAITING_FOR_RECONNECT, AND A RECONNECT MATCHES AGAIN --
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_q uuid; r jsonb; d jsonb;
BEGIN
  v_g := harness.lc('MATCH');
  v_p := (harness.idle(v_g, false, 1))[1];
  v_h := (harness.idle(v_g, true, 1))[1];
  v_q := (harness.idle(v_g, false, 1, ARRAY[v_p]))[1];
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);

  IF harness.reason(v_g, v_p, NULL) <> 'DISCONNECTED' OR harness.reason(v_g, v_h, NULL) <> 'DISCONNECTED' THEN
    RAISE EXCEPTION 'FAIL 04: P0 does not refuse the durably disconnected';
  END IF;
  -- THE ENGINE-REPORTED PATH still works beside the durable one, and says so.
  IF (SELECT l.reason_code FROM public.fn_lightning_player_legality(v_g, clock_timestamp(), ARRAY[v_q], NULL) l
       WHERE l.player_id = v_q) <> 'DISCONNECTED'
     OR (SELECT (l.detail ->> 'reported_disconnected')::boolean FROM public.fn_lightning_player_legality(v_g, clock_timestamp(), ARRAY[v_q], NULL) l
          WHERE l.player_id = v_q) IS DISTINCT FROM true
     OR (SELECT (l.detail ->> 'reported_disconnected')::boolean FROM public.fn_lightning_player_legality(v_g, clock_timestamp(), NULL, NULL) l
          WHERE l.player_id = v_p) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 04: the p_disconnected path does not say who reported it';
  END IF;

  r := public.fn_lightning_match(v_g, clock_timestamp(), NULL, 'm1', NULL);
  SELECT x INTO d FROM jsonb_array_elements(r -> 'diagnosis') x WHERE x ->> 'player_id' = v_p::text;
  IF d ->> 'state' <> 'WAITING_FOR_RECONNECT' OR d ->> 'reason_code' <> 'DISCONNECTED' THEN
    RAISE EXCEPTION 'FAIL 04: the human is not diagnosed WAITING_FOR_RECONNECT: %', d;
  END IF;
  SELECT x INTO d FROM jsonb_array_elements(r -> 'diagnosis') x WHERE x ->> 'player_id' = v_h::text;
  IF d ->> 'state' <> 'WAITING_FOR_RECONNECT' OR d ->> 'reason_code' <> 'DISCONNECTED' THEN
    RAISE EXCEPTION 'FAIL 04: the horse is not diagnosed WAITING_FOR_RECONNECT: %', d;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'groups') gr WHERE gr -> 'players' ? v_p::text OR gr -> 'players' ? v_h::text) THEN
    RAISE EXCEPTION 'FAIL 04: a disconnected player was planned into a hand';
  END IF;

  -- THE RECONNECT puts them straight back on the market: the real pass deals
  -- them and the settlement completes server-side.
  PERFORM public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p, v_h]);
  IF harness.reason(v_g, v_p, NULL) <> 'LEGAL' OR harness.reason(v_g, v_h, NULL) <> 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 04: the reconnected are not legal again';
  END IF;
  PERFORM harness.play(v_g, ARRAY[v_p, v_h],
    jsonb_build_object(v_p::text, jsonb_build_object('d', 2, 'c', 2, 's', true),
                       v_h::text, jsonb_build_object('d', -2, 'c', 2, 's', true)), 4, ARRAY[v_p]);
  IF NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                   JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
                  WHERE lh.cluster_id = v_g AND hp.player_id = v_p AND lh.settled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 04: the reconnected player did not play a settled hand';
  END IF;
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9match', v_g, v_p, v_h);
END $$;
\echo '  ok  04 THE MATCHER WITHHOLDS  a durably disconnected human and horse are refused by P0 as DISCONNECTED and diagnosed WAITING_FOR_RECONNECT by the real matcher, which plans neither; the engine''s p_disconnected array still refuses beside the durable state and the detail says who reported it; after the reconnect both are LEGAL and a real hand forms, deals and settles with them'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 05 EXPIRY IN THE IDLE POOL, THE POPULATION, AND PENDING_OFF CAN FOLLOW ---------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; r jsonb; v_stack numeric; v_n integer; v_a uuid; v_b uuid; i integer;
BEGIN
  v_g := harness.lc('EXPIRE');
  v_p := (harness.idle(v_g, false, 1))[1];
  v_h := (harness.idle(v_g, true, 1))[1];
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p, v_h], NULL);

  -- BEFORE ITS TIME, NOTHING: the timeout floor is 30 seconds and the clock
  -- guard refuses a future now, so a fresh disconnect cannot be reaped.
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 0 OR r -> 'rows' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 05: a fresh disconnect was reaped: %', r;
  END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g, clock_timestamp() + interval '1 hour');
  IF (r ->> 'expired')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL 05: a future clock reaped: %', r;
  END IF;

  -- THE HARNESS AGES THE STAMPS (the one liberty it takes), past the 180s
  -- default.
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '200 seconds'
   WHERE cluster_id = v_g AND player_id IN (v_p, v_h) AND exited_at IS NULL;

  -- STILL SEATED, STILL COUNTED, and the engine's subtraction answers the
  -- live number while the disconnect stands.
  IF harness.live(v_g) <> 18 OR public.fn_cash_cluster_live_eligible(v_g, clock_timestamp(), 2) <> 16 THEN
    RAISE EXCEPTION 'FAIL 05: the population moved before the expiry: % / %', harness.live(v_g), public.fn_cash_cluster_live_eligible(v_g, clock_timestamp(), 2);
  END IF;

  SELECT ts.stack INTO v_stack FROM public.table_seats ts WHERE ts.id = (harness.psrow(v_g, v_p)).anchor_seat_id;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 2 OR r -> 'skipped' <> '[]'::jsonb OR r -> 'errors' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 05: the reap did not expire exactly the two: %', r;
  END IF;
  IF (SELECT count(*) FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h)
         AND ps.exited_at IS NOT NULL AND ps.exit_reason = 'disconnect_expired' AND ps.state = 'closed'
         AND ps.disconnected_at IS NOT NULL AND ps.ending_stack IS NOT NULL) <> 2
     OR (harness.psrow(v_g, v_p)).ending_stack IS DISTINCT FROM v_stack THEN
    RAISE EXCEPTION 'FAIL 05: the sessions are not exited disconnect_expired with the seat stack and the stamp kept';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
              JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
             WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND sl.closed_at IS NULL)
     OR (SELECT count(*) FROM public.lightning_pool_slot sl
          JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
         WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND sl.close_reason = 'pool_session_exited') < 2 THEN
    RAISE EXCEPTION 'FAIL 05: a slot outlived its expired session';
  END IF;
  -- THE LEDGER: one pool_player_left per session, one player_expired for the
  -- Cluster carrying both, with the timeout that judged them.
  IF (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'pool_player_left'
       AND e.payload ->> 'reason' = 'disconnect_expired') <> 2
     OR harness.evn(v_g, 'player_expired') <> 1
     OR jsonb_array_length(harness.evlast(v_g, 'player_expired') -> 'players') <> 2
     OR (SELECT bool_and((x ->> 'timeout_ms')::integer = 180000)
           FROM jsonb_array_elements(harness.evlast(v_g, 'player_expired') -> 'players') x) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the expiry ledger is not two pool_player_left and one player_expired';
  END IF;
  -- IDEMPOTENT: nothing left to reap, nothing written.
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 0 OR harness.evn(v_g, 'player_expired') <> 1 THEN
    RAISE EXCEPTION 'FAIL 05: a second reap moved something';
  END IF;

  -- THE POOL HALF NO LONGER COUNTS THEM (exited), the seat half does until
  -- the engine stands the seat up, and the subtraction bridges the gap.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
              WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND ps.exited_at IS NULL)
     OR harness.live(v_g) <> 18 OR public.fn_cash_cluster_live_eligible(v_g, clock_timestamp(), 2) <> 16 THEN
    RAISE EXCEPTION 'FAIL 05: the expired still hold open sessions, or the subtraction fails';
  END IF;
  -- THE EXPIRY IS NOT DOUBLED: exactly one disconnect_expired exit per
  -- player, and exactly one pool_player_left carrying that reason per player.
  IF (SELECT count(*) FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND ps.exit_reason = 'disconnect_expired') <> 2
     OR (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'pool_player_left'
          AND e.payload ->> 'reason' = 'disconnect_expired' AND e.payload ->> 'player_id' IN (v_p::text, v_h::text)) <> 2 THEN
    RAISE EXCEPTION 'FAIL 05: the expiry is not exactly one disconnect_expired per player';
  END IF;
  -- THE ENGINE STANDS THEM UP (as its timeout flow does): the seats leave,
  -- the live count drops to 16 with no subtraction, and the reaper finds no
  -- further disconnect to expire for them.
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE public.table_seats ts SET left_at = clock_timestamp()
   WHERE ts.id IN (SELECT ps.anchor_seat_id FROM public.lightning_pool_session ps
                    WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND ps.exit_reason = 'disconnect_expired');
  IF harness.live(v_g) <> 16
     OR (SELECT count(*) FROM public.lightning_pool_session ps
          WHERE ps.cluster_id = v_g AND ps.player_id IN (v_p, v_h) AND ps.exit_reason = 'disconnect_expired') <> 2
     OR (public.fn_lightning_reap_expired_disconnects(v_g) ->> 'expired')::integer <> 0 THEN
    RAISE EXCEPTION 'FAIL 05: the stand-up moved the count wrongly or the reaper found more to expire: live=%', harness.live(v_g);
  END IF;

  -- POPULATION-DRIVEN PENDING_OFF CAN FOLLOW: two more expiries and their
  -- stand-ups take the Cluster under the OFF threshold, and the real drive
  -- walks it down.
  PERFORM harness.to(v_g, 13);
  v_a := (harness.idle(v_g, false, 1))[1];
  v_b := (harness.idle(v_g, false, 1, ARRAY[v_a]))[1];
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_a, v_b], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '200 seconds'
   WHERE cluster_id = v_g AND player_id IN (v_a, v_b) AND exited_at IS NULL;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 2 THEN RAISE EXCEPTION 'FAIL 05: the second expiry did not take two: %', r; END IF;
  UPDATE public.table_seats ts SET left_at = clock_timestamp()
   WHERE ts.id IN (SELECT ps.anchor_seat_id FROM public.lightning_pool_session ps
                    WHERE ps.cluster_id = v_g AND ps.player_id IN (v_a, v_b));
  IF harness.live(v_g) <> 11 THEN RAISE EXCEPTION 'FAIL 05: the Cluster is not at 11'; END IF;
  PERFORM public.fx6_set(v_g, '{"pending_off_dwell_ms": 0}');
  FOR i IN 1 .. 4 LOOP
    EXIT WHEN harness.mode(v_g) = 'must_move';
    PERFORM harness.drive(v_g);
  END LOOP;
  IF harness.mode(v_g) <> 'must_move' THEN
    RAISE EXCEPTION 'FAIL 05: 11 live eligible did not revert the Cluster: %', harness.mode(v_g);
  END IF;
  -- THE RECORD KEEPS EACH EXIT'S OWN REASON: the expired stay
  -- disconnect_expired; everyone still in at the drain exits lightning_off.
  IF (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exit_reason = 'disconnect_expired') <> 4
     OR (SELECT count(*) FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exit_reason = 'lightning_off') < 11
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 05: the reversion rewrote an expiry or left a session open';
  END IF;
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9expire', v_g, v_p, v_h);
END $$;
\echo '  ok  05 EXPIRY IN THE IDLE POOL  a fresh disconnect and a future clock reap nothing; past the 180s default a disconnected human and horse exit the pool with exit_reason disconnect_expired, the seat stack as ending_stack, the stamp kept for forensics, slots closed, two pool_player_left and one player_expired naming both and the 180000 that judged them; a second reap is silent; the exited pair still count seated (minus the engine''s subtraction) until the engine stands the seats up with no double exit; two more expiries at 13 take the Cluster to 11 and the real drive opens PENDING_OFF and reverts, each exit keeping its own reason'

-- 06 A PLAYER IN A LIVE HAND IS NEVER EXPIRED --------------------------------------------
DO $$
DECLARE v_g uuid; v_ps uuid[]; r jsonb; v_inst uuid; v_hand uuid; v_spec jsonb; v_q uuid; v_inst2 uuid;
BEGIN
  v_g := harness.lc('INHAND');
  v_ps := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  r := harness.form(v_g, v_ps);
  v_inst := (r ->> 'instance_id')::uuid; v_hand := (r ->> 'hand_id')::uuid;

  -- DISCONNECT DURING THE HAND (a human and the horse), aged past expiry.
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_ps[1], v_ps[3]], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE cluster_id = v_g AND player_id IN (v_ps[1], v_ps[3]) AND exited_at IS NULL;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 0
     OR (SELECT count(*) FROM jsonb_array_elements(r -> 'skipped') x WHERE x ->> 'reason' = 'in_hand_or_reserved') <> 2
     OR (SELECT count(*) FROM public.lightning_pool_session ps
          WHERE ps.cluster_id = v_g AND ps.player_id IN (v_ps[1], v_ps[3]) AND ps.exited_at IS NULL) <> 2 THEN
    RAISE EXCEPTION 'FAIL 06: a player in a reserved formation was expired: %', r;
  END IF;

  -- THE HAND IS DEALT AND SETTLES SERVER-SIDE though the client is gone.
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 0 THEN RAISE EXCEPTION 'FAIL 06: a dealt-in player was expired: %', r; END IF;
  v_spec := jsonb_build_object(v_ps[1]::text, jsonb_build_object('d', 4, 'c', 4, 's', true),
                               v_ps[2]::text, jsonb_build_object('d', -4, 'c', 4, 's', true),
                               v_ps[3]::text, jsonb_build_object('d', 0, 'c', 0));
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0, 0,
         jsonb_build_object('pot_size', 8, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', v_ps[1], 'amount', 8, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 06: the settlement refused: %', r; END IF;

  -- EXPIRY AFTER SETTLE: the hand let go, so the next pass exits exactly the
  -- two whose disconnects stood too long.
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 2
     OR (SELECT count(*) FROM public.lightning_pool_session ps
          WHERE ps.cluster_id = v_g AND ps.player_id IN (v_ps[1], v_ps[3])
            AND ps.exit_reason = 'disconnect_expired') <> 2
     OR (SELECT ps.exited_at FROM public.lightning_pool_session ps
          WHERE ps.cluster_id = v_g AND ps.player_id = v_ps[2] ORDER BY ps.entered_at DESC LIMIT 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: the post-settle reap did not exit exactly the two: %', r;
  END IF;

  -- DISCONNECT DURING A RESERVATION THAT NEVER DEALS: withheld from the
  -- reap while the formation lives, taken once it is abandoned.
  v_q := (harness.idle(v_g, false, 1))[1];
  r := harness.form(v_g, ARRAY[v_q] || harness.idle(v_g, false, 1, ARRAY[v_q]));
  v_inst2 := (r ->> 'instance_id')::uuid;
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_q], NULL);
  UPDATE public.lightning_pool_session SET disconnected_at = disconnected_at - interval '400 seconds'
   WHERE cluster_id = v_g AND player_id = v_q AND exited_at IS NULL;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 0 OR jsonb_array_length(r -> 'skipped') <> 1 THEN
    RAISE EXCEPTION 'FAIL 06: a reserved player was expired: %', r;
  END IF;
  r := public.fn_lightning_instance_abandon(v_inst2, 'p9_harness', clock_timestamp());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 06: the abandon refused: %', r; END IF;
  r := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (r ->> 'expired')::integer <> 1
     OR (SELECT ps.exit_reason FROM public.lightning_pool_session ps
          WHERE ps.cluster_id = v_g AND ps.player_id = v_q ORDER BY ps.entered_at DESC LIMIT 1) <> 'disconnect_expired' THEN
    RAISE EXCEPTION 'FAIL 06: the released player was not expired: %', r;
  END IF;
  INSERT INTO harness.p8 (k, game, a, j) VALUES ('p9hand', v_g, v_ps[1], jsonb_build_object('hand', v_hand));
END $$;
\echo '  ok  06 NEVER IN A LIVE HAND  a human and the horse disconnect inside a reserved formation and age past expiry: the reap skips both (in_hand_or_reserved), through dealing too; the hand settles server-side with the client gone; the next pass exits exactly those two; a player reserved in a formation that never deals is skipped while it lives and expired once the abandon hands them back'

-- 07 ACROSS THE MODES: MUST_MOVE, PENDING_OFF, AND BOTH CONVERSIONS ------------------------
DO $$
DECLARE v_g uuid; v_u uuid; v_p uuid; v_q uuid; r jsonb; i integer;
BEGIN
  v_g := harness.c8('MODES', 6, 7, 2, 6, 2);
  SELECT ts.user_id INTO v_u FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = v_g AND ts.left_at IS NULL LIMIT 1;
  -- IN MUST_MOVE there is no pool session to stamp, and the door says so
  -- without inventing one.
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_u], NULL);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR r -> 'disconnected' <> '[]'::jsonb
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g) THEN
    RAISE EXCEPTION 'FAIL 07: a must-move report stamped or invented a session: %', r;
  END IF;

  -- CONVERSION ON: every fresh pool session is born connected.
  PERFORM harness.join(v_g, 1);
  PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning'
     OR EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                 WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL AND ps.disconnected_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 07: a session was born disconnected';
  END IF;

  -- DISCONNECT, THEN THE DRAIN: Lightning switched off opens PENDING_OFF at
  -- once; a disconnect reported DURING the drain still lands; the commit
  -- exits every open session as lightning_off, the stamp kept for the record.
  v_p := (harness.idle(v_g, false, 1))[1];
  v_q := (harness.idle(v_g, true, 1))[1];
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL);
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'pending_off' THEN RAISE EXCEPTION 'FAIL 07: the disabled Cluster is not draining: %', harness.mode(v_g); END IF;
  r := public.fn_lightning_presence_report(v_g, ARRAY[v_q], NULL);
  IF jsonb_array_length(r -> 'disconnected') <> 1 OR (harness.psrow(v_g, v_q)).state <> 'disconnected' THEN
    RAISE EXCEPTION 'FAIL 07: a disconnect during PENDING_OFF did not land: %', r;
  END IF;
  FOR i IN 1 .. 3 LOOP
    EXIT WHEN harness.mode(v_g) = 'must_move';
    PERFORM harness.drive(v_g);
  END LOOP;
  IF harness.mode(v_g) <> 'must_move'
     OR (SELECT ps.exit_reason FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_p ORDER BY ps.entered_at DESC LIMIT 1) <> 'lightning_off'
     OR (SELECT ps.disconnected_at FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.player_id = v_p ORDER BY ps.entered_at DESC LIMIT 1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 07: the reversion lost the exit reason or the stamp';
  END IF;

  -- RECONNECT AFTER THE MODE CONVERSION: the next Lightning life starts
  -- clean - a new session, no stamp, legal at once.
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_g;
  PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FAIL 07: the Cluster did not convert again'; END IF;
  PERFORM public.fx9_pool(v_g);
  IF (harness.psrow(v_g, v_p)).exited_at IS NOT NULL OR (harness.psrow(v_g, v_p)).disconnected_at IS NOT NULL
     OR (harness.psrow(v_g, v_p)).state <> 'active'
     OR harness.reason(v_g, v_p, NULL) <> 'LEGAL' OR harness.reason(v_g, v_q, NULL) <> 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 07: the re-conversion did not hand back a clean session: p=% q=% psrow=%',
      harness.reason(v_g, v_p, NULL), harness.reason(v_g, v_q, NULL),
      to_jsonb((harness.psrow(v_g, v_p)));
  END IF;
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('p9modes', v_g, v_p, v_q);
END $$;
\echo '  ok  07 ACROSS THE MODES  a must-move presence report stamps nothing and invents nothing; conversion ON births every session connected; with a player disconnected the switch-off drains, a disconnect reported during PENDING_OFF still lands (the horse''s), the commit exits every session lightning_off keeping the stamps for the record; re-conversion hands the same players clean sessions, legal at once'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 08 THE RECONNECT SNAPSHOT: THE CALLER'S OWN, EXACT KEYS, CONSISTENT JOINABLE ----------
DO $$
DECLARE v_g uuid; v_m uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid(); r jsonb; r2 jsonb;
        v_seat record; v_hand uuid; f jsonb; v_err text;
BEGIN
  v_g := harness.lc('SNAP');
  v_m := harness.c8('SNAPMM', 6, 7, 2, 6, 2);
  PERFORM harness.seat(v_g, v_p, false);
  PERFORM harness.seat(v_g, v_h, true);

  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_reconnect_state(v_g);
  SELECT ts.table_id, ts.seat_number, ts.stack INTO v_seat
    FROM public.table_seats ts WHERE ts.id = (harness.psrow(v_g, v_p)).anchor_seat_id;
  IF r IS NULL
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM
        ARRAY['disconnected_at', 'hand_id', 'in_hand', 'joinable', 'pool_session_id', 'seat_number',
              'seat_table_id', 'stack', 'state']
     OR (r ->> 'pool_session_id')::uuid IS DISTINCT FROM harness.session(v_g, v_p)
     OR r ->> 'state' <> 'active' OR (r ->> 'in_hand')::boolean IS DISTINCT FROM false
     OR r -> 'hand_id' <> 'null'::jsonb OR r -> 'disconnected_at' <> 'null'::jsonb
     OR (r ->> 'seat_table_id')::uuid IS DISTINCT FROM v_seat.table_id
     OR (r ->> 'seat_number')::integer IS DISTINCT FROM v_seat.seat_number
     OR (r ->> 'stack')::numeric IS DISTINCT FROM public.fn_lightning_pool_stack(harness.session(v_g, v_p))
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: the snapshot is not the caller''s own nine keys: %', r;
  END IF;
  IF (r ->> 'joinable')::boolean IS DISTINCT FROM (public.fn_lightning_pool_status(v_g) ->> 'joinable')::boolean THEN
    RAISE EXCEPTION 'FAIL 08: joinable disagrees with pool status';
  END IF;

  -- DISCONNECTED, the snapshot says so and when.
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_p], NULL);
  r := public.fn_lightning_reconnect_state(v_g);
  IF r ->> 'state' <> 'disconnected' OR r -> 'disconnected_at' = 'null'::jsonb
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 08: a disconnected snapshot is wrong: %', r;
  END IF;
  PERFORM public.fn_lightning_presence_report(v_g, NULL, ARRAY[v_p]);

  -- IN A LIVE HAND: in_hand true, the caller's own hand id, never an
  -- instance id; the horse reads its own the same way.
  f := harness.form(v_g, ARRAY[v_p, v_h]);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal((f ->> 'instance_id')::uuid);
  v_hand := (f ->> 'hand_id')::uuid;
  r := public.fn_lightning_reconnect_state(v_g);
  PERFORM harness.as_user(v_h);
  r2 := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'in_hand')::boolean IS DISTINCT FROM true OR (r ->> 'hand_id')::uuid IS DISTINCT FROM v_hand
     OR (r ? 'instance_id') OR (r ? 'lightning_instance_id')
     OR (r2 ->> 'in_hand')::boolean IS DISTINCT FROM true OR (r2 ->> 'hand_id')::uuid IS DISTINCT FROM v_hand
     OR (r2 ->> 'pool_session_id')::uuid IS DISTINCT FROM harness.session(v_g, v_h) THEN
    RAISE EXCEPTION 'FAIL 08: the in-hand snapshot is wrong: % / %', r, r2;
  END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  f := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand,
         jsonb_build_object(v_p::text, jsonb_build_object('d', 1, 'c', 1, 's', true),
                            v_h::text, jsonb_build_object('d', -1, 'c', 1, 's', true))), 0, 0,
         jsonb_build_object('pot_size', 2, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', v_p, 'amount', 2, 'potIndex', 0))));
  IF (f ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 08: the settlement refused: %', f; END IF;

  -- NOBODY ELSE'S: a stranger, no caller, an unknown Cluster, a Cluster the
  -- caller has no session in.
  PERFORM harness.as_user(gen_random_uuid());
  IF public.fn_lightning_reconnect_state(v_g) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 08: a stranger read a snapshot'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_reconnect_state(v_g) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 08: no caller read a snapshot'; END IF;
  PERFORM harness.as_user(v_p);
  IF public.fn_lightning_reconnect_state(gen_random_uuid()) IS NOT NULL
     OR public.fn_lightning_reconnect_state(v_m) IS NOT NULL
     OR public.fn_lightning_reconnect_state(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 08: a Cluster without the caller''s session answered';
  END IF;

  -- JOINABLE follows the pool status formula when the switch goes off.
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  r := public.fn_lightning_reconnect_state(v_g);
  IF (r ->> 'joinable')::boolean IS DISTINCT FROM false
     OR (r ->> 'joinable')::boolean IS DISTINCT FROM (public.fn_lightning_pool_status(v_g) ->> 'joinable')::boolean THEN
    RAISE EXCEPTION 'FAIL 08: joinable does not follow the switch: %', r;
  END IF;
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_g;

  -- THE ROLES: authenticated may ask, anon may not.
  SET ROLE authenticated;
  IF public.fn_lightning_reconnect_state(v_g) IS NULL THEN RESET ROLE; RAISE EXCEPTION 'FAIL 08: authenticated cannot ask'; END IF;
  RESET ROLE;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_reconnect_state(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 08: anon asked: %', v_err; END IF;
  PERFORM harness.as_user(NULL, NULL);
  INSERT INTO harness.p8 (k, game, a, b, c) VALUES ('p9snap', v_g, v_p, v_h, v_m);
END $$;
\echo '  ok  08 THE RECONNECT SNAPSHOT  the caller''s own nine keys exactly, matching the session, the anchor seat, the pool stack and pool status''s joinable; disconnected it says so and when; in a live hand it names the caller''s own hand and never an instance, the horse identically; a stranger, no caller, an unknown Cluster and a Cluster without the caller''s session answer NULL; joinable follows the switch; authenticated may ask and anon is refused 42501'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 09 THE FORENSIC WINDOW: ORDERED, BOUNDED, READ-ONLY, OPERATORS ONLY ------------------
DO $$
DECLARE v_g uuid; r jsonb; v_census text; v_err text; c jsonb;
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'p9expire';
  -- One real matcher pass, so the window carries one.
  PERFORM public.fx6_set(v_g, '{"worker_mode": "form"}');
  UPDATE public.cash_games SET lightning_enabled = true WHERE id = v_g;
  PERFORM harness.to(v_g, 18);
  PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'lightning' THEN RAISE EXCEPTION 'FIXTURE 09: the Cluster did not convert back'; END IF;
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fn_lightning_match_and_form(v_g, clock_timestamp(), NULL, 2, gen_random_uuid());

  v_census := (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT to_jsonb(e)::text AS x FROM public.cash_cluster_events e WHERE e.game_id = v_g
      UNION ALL SELECT to_jsonb(lh)::text FROM public.lightning_hand lh WHERE lh.cluster_id = v_g) q);
  r := public.fn_lightning_cluster_forensics(v_g, clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour', 500);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'limit')::integer <> 500
     OR jsonb_array_length(r -> 'events') < 10
     OR jsonb_array_length(r -> 'conversions') < 2
     OR jsonb_array_length(r -> 'matcher_passes') < 1
     OR jsonb_array_length(r -> 'instances') < 1
     OR jsonb_array_length(r -> 'hands') < 1 THEN
    RAISE EXCEPTION 'FAIL 09: the window is not the Cluster''s whole record: %', jsonb_build_object(
      'events', jsonb_array_length(r -> 'events'), 'conversions', jsonb_array_length(r -> 'conversions'),
      'passes', jsonb_array_length(r -> 'matcher_passes'), 'instances', jsonb_array_length(r -> 'instances'),
      'hands', jsonb_array_length(r -> 'hands'));
  END IF;
  -- IN ORDER, and carrying the disconnect story this Cluster lived.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'events') WITH ORDINALITY a(x, i)
              JOIN jsonb_array_elements(r -> 'events') WITH ORDINALITY b(y, j) ON j = i + 1
             WHERE (a.x ->> 'at')::timestamptz > (b.y ->> 'at')::timestamptz) THEN
    RAISE EXCEPTION 'FAIL 09: the events are not in time order';
  END IF;
  IF NOT (SELECT coalesce(array_agg(DISTINCT x ->> 'kind'), ARRAY[]::text[]) @>
            ARRAY['player_disconnected', 'player_expired', 'pool_player_left', 'lightning_on', 'lightning_off']
            FROM jsonb_array_elements(r -> 'events') x) THEN
    RAISE EXCEPTION 'FAIL 09: the window does not carry the disconnect story';
  END IF;
  -- THE CONVERSION RECORD CARRIES ITS VERSIONS (spec VERSIONING).
  SELECT x INTO c FROM jsonb_array_elements(r -> 'conversions') x
   WHERE x ->> 'from_mode' = 'must_move' AND x ->> 'to_mode' = 'lightning' LIMIT 1;
  IF c IS NULL OR (c ->> 'trigger_population')::integer < 18
     OR (c ->> 'on_threshold')::integer <> 18 OR (c ->> 'off_threshold')::integer <> 12
     OR (c ->> 'epoch_after')::integer <> (c ->> 'epoch_before')::integer + 1
     OR c ->> 'conversion_request_id' IS NULL OR c ->> 'status' IS NULL THEN
    RAISE EXCEPTION 'FAIL 09: the conversion record is incomplete: %', c;
  END IF;
  -- BOUNDED: the limit clamps both ways and cuts every list.
  IF (public.fn_lightning_cluster_forensics(v_g, NULL, NULL, 100000) ->> 'limit')::integer <> 2000
     OR (public.fn_lightning_cluster_forensics(v_g, NULL, NULL, -5) ->> 'limit')::integer <> 1
     OR jsonb_array_length(public.fn_lightning_cluster_forensics(v_g, NULL, NULL, 1) -> 'events') <> 1
     OR (public.fn_lightning_cluster_forensics(v_g, NULL, NULL, NULL) ->> 'limit')::integer <> 500 THEN
    RAISE EXCEPTION 'FAIL 09: the limit does not clamp';
  END IF;
  -- THE WINDOW IS A WINDOW: an empty interval holds nothing.
  r := public.fn_lightning_cluster_forensics(v_g, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 hour', 500);
  IF r -> 'events' <> '[]'::jsonb OR r -> 'conversions' <> '[]'::jsonb OR r -> 'matcher_passes' <> '[]'::jsonb
     OR r -> 'instances' <> '[]'::jsonb OR r -> 'hands' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 09: an empty window answered rows';
  END IF;
  IF (public.fn_lightning_cluster_forensics(gen_random_uuid(), NULL, NULL, 500) ->> 'ok')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 09: an unknown Cluster answered';
  END IF;
  -- READ-ONLY: asking wrote nothing.
  IF v_census IS DISTINCT FROM (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT to_jsonb(e)::text AS x FROM public.cash_cluster_events e WHERE e.game_id = v_g
      UNION ALL SELECT to_jsonb(lh)::text FROM public.lightning_hand lh WHERE lh.cluster_id = v_g) q) THEN
    RAISE EXCEPTION 'FAIL 09: the reader wrote a row';
  END IF;
  -- OPERATORS ONLY.
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_cluster_forensics(%L, NULL, NULL, 10)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 09: authenticated read the window: %', v_err; END IF;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_cluster_forensics(%L, NULL, NULL, 10)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 09: anon read the window: %', v_err; END IF;
END $$;
\echo '  ok  09 THE FORENSIC WINDOW  one call answers the EXPIRE Cluster''s events in time order carrying player_disconnected, player_expired, pool_player_left, lightning_on and lightning_off, both conversions with population, thresholds, epochs, request id and status, a real matcher pass, instances and hands; the limit clamps to 1..2000 and cuts the lists; an empty window and an unknown Cluster answer nothing; the reader writes no row; authenticated and anon are refused 42501'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 10 THE REPLAY CHECK: SAME INPUTS, SAME VERDICT; A TAMPERED COPY FAILS ----------------
DO $$
DECLARE v_g uuid; v_ps uuid[]; f jsonb; v_hand uuid; v_inst uuid; r jsonb; r2 jsonb; v_spec jsonb;
        v_void uuid; v_inst2 uuid; v_ev public.cash_cluster_events; v_net numeric; v_after numeric;
BEGIN
  v_g := harness.lc('AUDIT');
  v_ps := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  f := harness.form(v_g, v_ps);
  v_hand := (f ->> 'hand_id')::uuid; v_inst := (f ->> 'instance_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  -- A RAKED HAND: the deltas sum to minus the rake, so conservation is
  -- non-vacuous. +4, -3, -2 against a rake of 1.
  v_spec := jsonb_build_object(v_ps[1]::text, jsonb_build_object('d', 4, 'c', 4, 's', true),
                               v_ps[2]::text, jsonb_build_object('d', -3, 'c', 3, 's', true),
                               v_ps[3]::text, jsonb_build_object('d', -2, 'c', 2, 's', true));
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 1, 0,
         jsonb_build_object('pot_size', 9, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', v_ps[1], 'amount', 8, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL 10: the settlement refused: %', r; END IF;

  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR r -> 'defects' <> '[]'::jsonb
     OR (r ->> 'settled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: a true settled hand did not pass: %', r;
  END IF;
  -- DETERMINISTIC: the same persisted inputs, the same verdict.
  IF public.fn_lightning_hand_replay_check(v_hand) IS DISTINCT FROM r THEN
    RAISE EXCEPTION 'FAIL 10: two readings of the same hand disagree';
  END IF;
  IF (public.fn_lightning_hand_replay_check(gen_random_uuid()) -> 'defects' -> 0 ->> 'code') <> 'hand_not_found' THEN
    RAISE EXCEPTION 'FAIL 10: a hand that does not exist did not say so';
  END IF;

  -- A LIVE FORMATION IS NOT AUDITABLE; ABANDONED AND CLEAN, IT PASSES.
  f := harness.form(v_g, ARRAY[v_ps[1], v_ps[2]]);
  v_void := (f ->> 'hand_id')::uuid; v_inst2 := (f ->> 'instance_id')::uuid;
  IF (public.fn_lightning_hand_replay_check(v_void) -> 'defects' -> 0 ->> 'code') <> 'hand_not_terminal' THEN
    RAISE EXCEPTION 'FAIL 10: a live formation was audited';
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst2, 'p9_harness', clock_timestamp());
  r := public.fn_lightning_hand_replay_check(v_void);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR (r ->> 'settled')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 10: a cleanly abandoned hand did not pass: %', r;
  END IF;

  -- TAMPERED COPIES (temp-estate mutations, each restored): the finality
  -- triggers are stood down for the write, as only an attacker with DDL
  -- could; the check must still convict from the record alone.
  ALTER TABLE public.lightning_hand_player DISABLE TRIGGER USER;
  SELECT hp.stack_after INTO v_after FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand AND hp.player_id = v_ps[1];
  UPDATE public.lightning_hand_player SET stack_after = stack_after + 5 WHERE hand_id = v_hand AND player_id = v_ps[1];
  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'defects') x
                     WHERE x ->> 'code' = 'stack_arithmetic' AND (x ->> 'player_id')::uuid = v_ps[1]) THEN
    RAISE EXCEPTION 'FAIL 10: a moved stack_after was not convicted: %', r;
  END IF;
  UPDATE public.lightning_hand_player SET stack_after = v_after WHERE hand_id = v_hand AND player_id = v_ps[1];

  SELECT hp.net_result INTO v_net FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand AND hp.player_id = v_ps[2];
  UPDATE public.lightning_hand_player SET net_result = net_result + 5 WHERE hand_id = v_hand AND player_id = v_ps[2];
  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false
     OR NOT (SELECT coalesce(array_agg(DISTINCT x ->> 'code'), ARRAY[]::text[]) @>
               ARRAY['stack_arithmetic', 'conservation', 'receipt_disagrees']
               FROM jsonb_array_elements(r -> 'defects') x) THEN
    RAISE EXCEPTION 'FAIL 10: a moved net was not convicted three ways: %', r;
  END IF;
  UPDATE public.lightning_hand_player SET net_result = v_net WHERE hand_id = v_hand AND player_id = v_ps[2];
  ALTER TABLE public.lightning_hand_player ENABLE TRIGGER USER;

  -- A REWRITTEN RECEIPT: the recorded rake no longer explains the deltas.
  ALTER TABLE public.lightning_hand DISABLE TRIGGER USER;
  UPDATE public.lightning_hand SET settle_receipt = jsonb_set(settle_receipt, '{rake}', '3') WHERE hand_id = v_hand;
  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'defects') x WHERE x ->> 'code' = 'conservation') THEN
    RAISE EXCEPTION 'FAIL 10: a rewritten rake was not convicted: %', r;
  END IF;
  UPDATE public.lightning_hand SET settle_receipt = jsonb_set(settle_receipt, '{rake}', '1') WHERE hand_id = v_hand;
  ALTER TABLE public.lightning_hand ENABLE TRIGGER USER;

  -- A VANISHED LEDGER ROW: the settlement event is deleted and the check
  -- names the missing kind; restored, the verdict returns to clean.
  SELECT e.* INTO v_ev FROM public.cash_cluster_events e
   WHERE e.game_id = v_g AND e.kind = 'hand_settled' AND e.payload ->> 'hand_id' = v_hand::text
   ORDER BY e.id DESC LIMIT 1;
  DELETE FROM public.cash_cluster_events WHERE id = v_ev.id;
  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM false
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'defects') x
                     WHERE x ->> 'code' = 'event_missing' AND x ->> 'kind' = 'hand_settled') THEN
    RAISE EXCEPTION 'FAIL 10: a vanished hand_settled event was not convicted: %', r;
  END IF;
  INSERT INTO public.cash_cluster_events (id, game_id, table_id, kind, payload, at, cluster_epoch, event_version, request_id)
  VALUES (v_ev.id, v_ev.game_id, v_ev.table_id, v_ev.kind, v_ev.payload, v_ev.at, v_ev.cluster_epoch, v_ev.event_version, v_ev.request_id);
  r := public.fn_lightning_hand_replay_check(v_hand);
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 10: the restored record does not pass again: %', r;
  END IF;
  INSERT INTO harness.p8 (k, game, j) VALUES ('p9audit', v_g, jsonb_build_object('hand', v_hand));
END $$;
\echo '  ok  10 THE REPLAY CHECK  a real settled raked hand (a horse in it) passes with no defects, twice identically; an unknown hand says hand_not_found, a live formation hand_not_terminal, a cleanly abandoned hand passes; with finality stood down a moved stack_after is convicted as stack_arithmetic, a moved net three ways (stack_arithmetic, conservation, receipt_disagrees), a rewritten receipt rake as conservation, and a deleted hand_settled event as event_missing; every copy restored, the verdict is clean again'
ASSERT

cat >> "$fixture/assertions.sql" <<'ASSERT'
-- 11 EVERY EXIT PATH SAYS pool_player_left, EXACTLY ONCE ------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_f uuid; r jsonb; v_n integer; v_bad integer;
BEGIN
  -- THE CASHOUT (anchor seat departure) was walked in earlier sections; walk
  -- one more explicitly here on the SNAP Cluster.
  SELECT game, a INTO v_g, v_p FROM harness.p8 WHERE k = 'p9snap';
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE public.table_seats ts SET left_at = clock_timestamp()
   WHERE ts.id = (SELECT ps.anchor_seat_id FROM public.lightning_pool_session ps
                   WHERE ps.cluster_id = v_g AND ps.player_id = v_p AND ps.exited_at IS NULL);
  IF (SELECT ps.exit_reason FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_g AND ps.player_id = v_p ORDER BY ps.entered_at DESC LIMIT 1) <> 'anchor_seat_left'
     OR (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_g AND e.kind = 'pool_player_left'
          AND e.payload ->> 'player_id' = v_p::text AND e.payload ->> 'reason' = 'anchor_seat_left') <> 1 THEN
    RAISE EXCEPTION 'FAIL 11: the cashout path did not say pool_player_left once';
  END IF;

  -- THE UNFREEZE: the one writer that exited sessions silently now records
  -- one per session it exits.
  v_f := harness.lc('FROZEN');
  UPDATE public.cash_games SET cluster_mode = 'frozen' WHERE id = v_f;
  r := public.fn_cash_cluster_unfreeze(v_f, gen_random_uuid(), 'phase 9 harness: the ledger must say every exit');
  v_n := (r ->> 'pool_sessions_exited')::integer;
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR v_n < 18 THEN
    RAISE EXCEPTION 'FAIL 11: the unfreeze did not exit the pool: %', r;
  END IF;
  IF (SELECT count(*) FROM public.cash_cluster_events e WHERE e.game_id = v_f AND e.kind = 'pool_player_left'
       AND e.payload ->> 'reason' = 'cluster_unfrozen') <> v_n
     OR EXISTS (SELECT 1 FROM public.cash_cluster_events e WHERE e.game_id = v_f AND e.kind = 'pool_player_left'
                 AND e.payload ->> 'reason' = 'cluster_unfrozen'
                 AND (e.payload ->> 'pool_session_id' IS NULL OR e.payload ->> 'ending_stack' IS NULL
                      OR e.payload ->> 'anchor_seat_id' IS NULL OR (e.payload ->> 'cluster_epoch') IS NULL)) THEN
    RAISE EXCEPTION 'FAIL 11: the unfreeze did not record one complete pool_player_left per session';
  END IF;

  -- THE WHOLE ESTATE, ONE RULE: every exited pool session anywhere has
  -- exactly one pool_player_left naming it, and all four reasons were walked.
  SELECT count(*) INTO v_bad
    FROM public.lightning_pool_session ps
    LEFT JOIN LATERAL (SELECT count(*) AS n FROM public.cash_cluster_events e
                        WHERE e.game_id = ps.cluster_id AND e.kind = 'pool_player_left'
                          AND e.payload ->> 'pool_session_id' = ps.id::text) ev ON true
   WHERE ps.exited_at IS NOT NULL AND ev.n <> 1;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'FAIL 11: % exited sessions are not named by exactly one pool_player_left', v_bad;
  END IF;
  IF (SELECT count(DISTINCT e.payload ->> 'reason') FROM public.cash_cluster_events e
       WHERE e.kind = 'pool_player_left'
         AND e.payload ->> 'reason' IN ('anchor_seat_left', 'lightning_off', 'disconnect_expired', 'cluster_unfrozen')) <> 4 THEN
    RAISE EXCEPTION 'FAIL 11: not all four exit reasons were walked';
  END IF;
END $$;
\echo '  ok  11 EVERY EXIT PATH  the cashout (anchor seat departure), the Phase 7 reversion, the disconnect expiry and now the unfreeze each record pool_player_left; the unfreeze records one complete event per session it exits; across the whole estate every exited pool session is named by exactly one pool_player_left and all four reasons were walked'

-- 12 WHO MAY CALL ----------------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_err text;
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'p9match';
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_presence_report(%L, NULL, NULL)', v_g));
  IF v_err IS NULL OR v_err !~ '^42501' THEN RESET ROLE; RAISE EXCEPTION 'FAIL 12: authenticated reported presence: %', v_err; END IF;
  v_err := public.fxr_try('SELECT public.fn_lightning_reap_expired_disconnects()');
  IF v_err IS NULL OR v_err !~ '^42501' THEN RESET ROLE; RAISE EXCEPTION 'FAIL 12: authenticated reaped: %', v_err; END IF;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_hand_replay_check(%L)', gen_random_uuid()));
  IF v_err IS NULL OR v_err !~ '^42501' THEN RESET ROLE; RAISE EXCEPTION 'FAIL 12: authenticated audited: %', v_err; END IF;
  RESET ROLE;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_presence_report(%L, NULL, NULL)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 12: anon reported presence: %', v_err; END IF;
  IF NOT (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'))
            FROM unnest(ARRAY['public.fn_lightning_presence_report(uuid,uuid[],uuid[],timestamp with time zone)',
                              'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
                              'public.fn_lightning_cluster_forensics(uuid,timestamp with time zone,timestamp with time zone,integer)',
                              'public.fn_lightning_hand_replay_check(uuid)']) f)
     OR NOT (has_function_privilege('authenticated', 'public.fn_lightning_reconnect_state(uuid)', 'EXECUTE')
             AND has_function_privilege('service_role', 'public.fn_lightning_reconnect_state(uuid)', 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.fn_lightning_reconnect_state(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'FAIL 12: the grants are not one browser door and four service doors';
  END IF;
END $$;
\echo '  ok  12 WHO MAY CALL  as the authenticated role the presence door, the reaper and the replay check refuse 42501, as does anon everywhere; the grants are exactly one browser door (reconnect state: authenticated and service_role) and four service doors (presence, reaper, forensics, replay check: service_role alone)'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 13 EVERY @live-proof OF THE FILE HOLDS -------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 13
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 13: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  13 THE LIVE PROOFS  all thirteen @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history', 'cash_cluster_events']) x(t)
UNION ALL
SELECT 'ps', md5(string_agg(to_jsonb(ps)::text, '|' ORDER BY ps.id)) FROM public.lightning_pool_session ps
UNION ALL
SELECT 'events', md5(string_agg(to_jsonb(e)::text, '|' ORDER BY e.id)) FROM public.cash_cluster_events e
UNION ALL
SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_pool_session'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass;
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 14 RE-APPLIABLE -----------------------------------------------------------------------
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(coalesce(a.what, b.what), ', ') INTO v_bad
    FROM harness.rcap a
    FULL JOIN (
      SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
      UNION ALL
      SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
        FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history', 'cash_cluster_events']) x(t)
      UNION ALL
      SELECT 'ps', md5(string_agg(to_jsonb(ps)::text, '|' ORDER BY ps.id)) FROM public.lightning_pool_session ps
      UNION ALL
      SELECT 'events', md5(string_agg(to_jsonb(e)::text, '|' ORDER BY e.id)) FROM public.cash_cluster_events e
      UNION ALL
      SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_pool_session'::regclass AND NOT t.tgisinternal
      UNION ALL
      SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_pool_session'::regclass
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 14: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 14: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  14 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, the hand, participant, pool session, instance, history and event row counts, every pool session row, every event row, and the pool session table''s triggers and constraints exactly as they were'
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
  -f "$phase8" -f "$p7r" -f "$fix" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
status=${PIPESTATUS[0]}
set -e
if [ "$status" != 0 ]; then
  echo "FAIL: psql exited $status"
  exit 1
fi

# FIFTEEN SECTIONS REPORTED, counted rather than eyeballed.
oks=$(grep -c -E '^  ok  [0-9]{2} ' "$fixture/psql.out" || true)
if [ "$oks" != 15 ]; then
  echo "FAIL: $oks of the 15 sections reported, so this run proved less than this file claims"
  exit 1
fi
echo "PASS: Lightning Phase 9 (spec Phases 14 and 15), 15 sections, under production's default function ACLs and its live autorevoke event trigger: before the file none of it exists; after it no earlier proof is falsified but the restated tick reading; disconnect_timeout_ms defaults to 180000 and clamps to 30s..30min; the presence door stamps and clears durably, idempotently, one event per call; P0 refuses DISCONNECTED and the matcher diagnoses WAITING_FOR_RECONNECT until the reconnect, after which a real hand settles; expiry exits only idle pool sessions past the timeout (never a live hand or reservation), says pool_player_left and player_expired, and the population walks the Cluster into PENDING_OFF and back to must_move; presence works across must_move, PENDING_OFF and both conversions, and a re-conversion starts clean; the reconnect snapshot is the caller's own nine keys with pool status's joinable; the forensic window is ordered, bounded, read-only and operators-only with the conversion versioning record; the replay check passes real settled and cleanly abandoned hands and convicts every tampered copy; every exited pool session everywhere is named by exactly one pool_player_left across all four exit paths; the grants are one browser door and four service doors; every @live-proof holds and the file is re-appliable"
