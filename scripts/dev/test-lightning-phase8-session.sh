#!/usr/bin/env bash
# Lightning Phase 8 (specification Phases 11, 12 and 13, the database side):
# multi-table limits per platform, session statistics, pool status for
# players, the session summary and recent hands.
#
# Proves 20261007212735 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55555 (LIGHTNING_P8_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The Lightning fixtures and every Lightning
# migration from 20260920235343 through Phase 7 (20261001222856) in order,
# exactly as test-lightning-phase7-reversion.sh builds them, then the
# migration under test, twice. Every Cluster is converted ON by the real
# drive, every pool slot comes from the real slot sync, every hand is formed
# by the real barrier, dealt by the real begin_dealing, folded through the
# real fn_lightning_fast_fold and settled by the real fn_lightning_settle_hand
# through the physical door; the reversion is Phase 7's own. The only rows
# the harness writes itself are the ca_hand_facts rows the production
# projection writes after a hand commits (it is not in this chain) and one
# club_members row.
#
# LAW 10.5. Horses sit beside humans in every Cluster, play every hand kind,
# are held to the same multi-table limit and get the same statistics. The
# migration reads neither is_horse nor horse_id.
#
# LIGHTNING_P8_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
#
# PRODUCTION PARITY (2026-10-07): the fixture installs production's default
# function privileges and its trg_autorevoke_privileged_anon event trigger
# (body verbatim from PokerIQ-Production) before the file runs, because the
# first apply was refused by the file's own ACL read-back in an environment
# this fixture did not reproduce.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P8_PORT:-55555}
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
mine=${LIGHTNING_P8_MIGRATION:-$M/20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p8-test.XXXXXX")
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
}

# ===========================================================================
# THE GROUND: section 00, against the Phase 7 code, before the file.
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
  IF to_regprocedure('public.fn_lightning_session_stats(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_session_summary(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_my_sessions()') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_pool_status(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_recent_hands(integer,uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)') IS NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_hand_player'::regclass AND attname IN ('waited_ms', 'showed'))
     OR jsonb_typeof(public.fn_lightning_config(NULL) -> 'multi_table_limit') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'FAIL 00: an object of the migration under test exists before it is applied';
  END IF;
  -- THE GROUND IS AS HOSTILE AS PRODUCTION: the autorevoke event trigger is
  -- live, the default ACL is installed, and a function created now is born
  -- executable by anon and authenticated, which is the state the file's ACL
  -- carry-over has to survive.
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger
                  WHERE evtname = 'trg_autorevoke_privileged_anon' AND evtenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d
                     WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'f') THEN
    RAISE EXCEPTION 'FAIL 00: production''s creation environment (default ACL + autorevoke) is not installed';
  END IF;
  EXECUTE 'CREATE FUNCTION public.fx8_born_open() RETURNS integer LANGUAGE sql AS $q$ SELECT 1 $q$';
  IF NOT has_function_privilege('anon', 'public.fx8_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fx8_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fx8_born_open()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 00: the default ACL does not hand a new function to anon, authenticated and service_role';
  END IF;
  EXECUTE 'DROP FUNCTION public.fx8_born_open()';
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; none of the five doors, the platform argument, the wait or showdown column exists, and the limit is still one scalar; production''s default ACL and autorevoke event trigger are live, and a function created now is born executable by anon, authenticated and service_role'
ASSERT

# ===========================================================================
# THE ASSERTIONS.
# ===========================================================================
cat > "$fixture/assertions.sql" <<'ASSERT'
-- 01 NOTHING BEFORE IT IS FALSIFIED BUT THE SUPERSEDED SIGNATURES ----------------
DO $$
DECLARE v_bad text; v_n integer;
BEGIN
  SELECT string_agg(b.src || '#' || b.n, ', ' ORDER BY b.src, b.n) INTO v_bad
    FROM harness.lp8 b JOIN harness.lp8 a ON a.src = b.src AND a.n = b.n AND a.phase = 'after'
   WHERE b.phase = 'before' AND b.ok IS TRUE AND a.ok IS NOT TRUE;
  -- EXACTLY the seven proofs that name a signature the file replaces (the
  -- three matcher functions and P0 by their old argument lists). Their intent
  -- is restated against the new signatures by the file's own proofs 4 to 6.
  IF v_bad IS DISTINCT FROM 'p6#2, p6#4, p6#5, p6#6, s6r#4, s6r#5, s6r#6' THEN
    RAISE EXCEPTION 'FAIL 01: predecessor proofs falsified by the file: %', v_bad;
  END IF;
  SELECT count(*) INTO v_n FROM harness.lp8 WHERE phase = 'after' AND ok IS TRUE;
  IF v_n < 100 OR (SELECT count(*) FROM harness.lp8 WHERE phase = 'before') <> (SELECT count(*) FROM harness.lp8 WHERE phase = 'after') THEN
    RAISE EXCEPTION 'FAIL 01: only % predecessor proofs were read true, so this proves too little', v_n;
  END IF;
END $$;
\echo '  ok  01 NOTHING BEFORE IT IS FALSIFIED  every @live-proof of every Lightning file from Phase 1 to Phase 7 that held before the file holds after it, except exactly the seven that name the old argument lists of P0, the planner, fn_lightning_match and fn_lightning_match_and_form, whose intent the file restates against the new ones'

-- 02 THE CONFIGURATION ---------------------------------------------------------------
DO $$
DECLARE v uuid; c jsonb;
BEGIN
  v := public.fx9_cluster('P8 CFG', 6, 40, true);
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb OR c -> 'invalid' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: the defaults are not 4/3/2: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"multi_table_limit": 6}');
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 6, "tablet": 6, "mobile": 6}'::jsonb OR c -> 'invalid' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: the old scalar is not every platform''s limit: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"multi_table_limit": 12}');
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 8, "tablet": 8, "mobile": 8}'::jsonb
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason')) FROM jsonb_array_elements(c -> 'invalid') x) IS DISTINCT FROM ARRAY['multi_table_limit:out_of_range_clamped'] THEN
    RAISE EXCEPTION 'FAIL 02: a scalar of 12 was not clamped to 8 and reported: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"multi_table_limit": {"desktop": 8, "tablet": 5, "mobile": 1}}');
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 8, "tablet": 5, "mobile": 1}'::jsonb OR c -> 'invalid' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: the per-platform override was not honoured: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"multi_table_limit": {"desktop": 0, "mobile": "two", "watch": 3}}');
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 1, "tablet": 3, "mobile": 2}'::jsonb
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason') ORDER BY x ->> 'key', x ->> 'reason') FROM jsonb_array_elements(c -> 'invalid') x)
        IS DISTINCT FROM ARRAY['multi_table_limit:unknown_platform', 'multi_table_limit.desktop:out_of_range_clamped', 'multi_table_limit.mobile:wrong_type'] THEN
    RAISE EXCEPTION 'FAIL 02: the bad platform values were not replaced and reported: %', c;
  END IF;
  PERFORM public.fx6_reset(v, '{"multi_table_limit": "many"}');
  c := public.fn_lightning_config(v);
  IF c -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb
     OR (SELECT array_agg(x ->> 'key' || ':' || (x ->> 'reason')) FROM jsonb_array_elements(c -> 'invalid') x) IS DISTINCT FROM ARRAY['multi_table_limit:wrong_type'] THEN
    RAISE EXCEPTION 'FAIL 02: a string limit did not fall back to the defaults: %', c;
  END IF;
  IF public.fn_lightning_config(NULL) -> 'multi_table_limit' IS DISTINCT FROM '{"desktop": 4, "tablet": 3, "mobile": 2}'::jsonb THEN
    RAISE EXCEPTION 'FAIL 02: an unknown Cluster does not answer the defaults';
  END IF;
END $$;
\echo '  ok  02 THE CONFIGURATION  multi_table_limit is {desktop 4, tablet 3, mobile 2} by default; the old scalar 6 is every platform''s limit and 12 clamps to 8, reported; a per-platform object is honoured; 0 clamps to 1, a string falls back, an unknown platform is reported, each in invalid; an unknown Cluster answers the defaults'

-- 03 THE LIMIT IS THE PLATFORM'S, ACROSS THREE CLUSTERS ------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; v_c uuid; v_p uuid := gen_random_uuid(); v_h uuid := gen_random_uuid(); g uuid;
        r jsonb; v_ia uuid; v_ib uuid; d jsonb; v_plat jsonb; v_hm jsonb;
BEGIN
  v_a := harness.lc('MT A'); v_b := harness.lc('MT B'); v_c := harness.lc('MT C');
  FOREACH g IN ARRAY ARRAY[v_a, v_b, v_c] LOOP
    PERFORM harness.seat(g, v_p, false);
    PERFORM harness.seat(g, v_h, true);
  END LOOP;
  -- One live hand in A (reserved) and one in B (dealing), the human and the
  -- horse in both.
  r := harness.form(v_a, ARRAY[v_p, v_h] || harness.idle(v_a, false, 1, ARRAY[v_p]));
  v_ia := (r ->> 'instance_id')::uuid;
  r := harness.form(v_b, ARRAY[v_p, v_h] || harness.idle(v_b, false, 1, ARRAY[v_p]));
  v_ib := (r ->> 'instance_id')::uuid;
  PERFORM harness.deal(v_ib);
  v_plat := jsonb_build_object(v_p::text, 'mobile', v_h::text, 'mobile');
  IF harness.reason(v_c, v_p, NULL) <> 'LEGAL' OR harness.reason(v_c, v_p, '{}') <> 'LEGAL'
     OR harness.reason(v_c, v_p, v_plat) <> 'MULTI_TABLE_LIMIT'
     OR harness.reason(v_c, v_h, v_plat) <> 'MULTI_TABLE_LIMIT'
     OR harness.reason(v_c, v_p, jsonb_build_object(v_p::text, 'tablet')) <> 'LEGAL'
     OR harness.reason(v_c, v_p, jsonb_build_object(v_p::text, 'desktop')) <> 'LEGAL'
     OR harness.reason(v_c, v_p, jsonb_build_object(v_p::text, 'watch')) <> 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 03: with two live hands elsewhere the platform limits did not answer mobile refused, tablet and desktop legal';
  END IF;
  d := harness.detail(v_c, v_p, v_plat);
  IF (d ->> 'multi_table_limit')::integer <> 2 OR d ->> 'platform' <> 'mobile' OR (d ->> 'live_hands_elsewhere')::integer <> 2 THEN
    RAISE EXCEPTION 'FAIL 03: the refusal does not name the platform, its limit and the two hands: %', d;
  END IF;
  -- THE OLD CALLERS: P0 and the matcher by their old argument lists,
  -- positionally and by name, are desktop.
  IF (SELECT coalesce(l.reason_code, 'LEGAL') FROM public.fn_lightning_player_legality(v_c, clock_timestamp(), NULL) l WHERE l.player_id = v_p) <> 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 03: the old P0 call does not answer desktop';
  END IF;
  r := public.fn_lightning_match(v_c, clock_timestamp(), NULL, 'm1');
  IF (SELECT x ->> 'reason_code' FROM jsonb_array_elements(r -> 'diagnosis') x WHERE x ->> 'player_id' = v_p::text) IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'groups') gr WHERE gr -> 'players' ? v_p::text) THEN
    RAISE EXCEPTION 'FAIL 03: the old fn_lightning_match call did not plan the player as desktop: %', r -> 'diagnosis';
  END IF;
  r := public.fn_lightning_match(p_cluster_id => v_c, p_now => clock_timestamp(), p_disconnected => NULL::uuid[], p_matcher_version => 'm1');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'groups') gr WHERE gr -> 'players' ? v_p::text) THEN
    RAISE EXCEPTION 'FAIL 03: the engine''s named-argument call did not plan the player';
  END IF;
  r := public.fn_lightning_match(v_c, clock_timestamp(), NULL, 'm1', v_plat);
  IF (SELECT x ->> 'reason_code' FROM jsonb_array_elements(r -> 'diagnosis') x WHERE x ->> 'player_id' = v_p::text) <> 'MULTI_TABLE_LIMIT'
     OR (SELECT x ->> 'reason_code' FROM jsonb_array_elements(r -> 'diagnosis') x WHERE x ->> 'player_id' = v_h::text) <> 'MULTI_TABLE_LIMIT'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'groups') gr WHERE gr -> 'players' ? v_p::text OR gr -> 'players' ? v_h::text)
     OR jsonb_array_length(r -> 'groups') = 0 THEN
    RAISE EXCEPTION 'FAIL 03: the mobile plan placed a player at the limit, or placed nobody: %', r -> 'diagnosis';
  END IF;
  -- THE CLUSTER'S OWN CONFIGURATION decides the number.
  PERFORM public.fx6_set(v_c, '{"multi_table_limit": {"mobile": 3}}');
  IF harness.reason(v_c, v_p, v_plat) <> 'LEGAL' THEN RAISE EXCEPTION 'FAIL 03: a mobile limit of 3 still refused'; END IF;
  PERFORM public.fx6_reset(v_c, '{}');
  -- ONLY LIVE HANDS COUNT: the formation in A abandoned, one is left.
  r := public.fn_lightning_instance_abandon(v_ia, 'p8_harness', clock_timestamp());
  IF harness.reason(v_c, v_p, v_plat) <> 'LEGAL' OR (harness.detail(v_c, v_p, v_plat) ? 'live_hands_elsewhere') THEN
    RAISE EXCEPTION 'FAIL 03: an abandoned formation still counted: %', r;
  END IF;
  r := harness.form(v_a, ARRAY[v_p, v_h] || harness.idle(v_a, false, 1, ARRAY[v_p]));
  IF harness.reason(v_c, v_p, v_plat) <> 'MULTI_TABLE_LIMIT' THEN RAISE EXCEPTION 'FAIL 03: the second live hand did not count again'; END IF;
  -- THE WHOLE PASS: match_and_form with the platform map forms every hand it
  -- can and none with the two mobile players; the old argument list (desktop)
  -- then deals them in.
  PERFORM public.fx6_set(v_c, '{"worker_mode": "form"}');
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, 8, gen_random_uuid(), v_plat);
  IF (r ->> 'formed')::integer < 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'hands') x WHERE x -> 'players' ? v_p::text OR x -> 'players' ? v_h::text)
     OR public.fn_lightning_player_in_hand(v_p, v_c) THEN
    RAISE EXCEPTION 'FAIL 03: the mobile pass dealt a player at the limit, or nobody: %', r;
  END IF;
  r := public.fn_lightning_match_and_form(v_c, clock_timestamp(), NULL, 8, gen_random_uuid());
  IF NOT public.fn_lightning_player_in_hand(v_p, v_c) OR NOT public.fn_lightning_player_in_hand(v_h, v_c) THEN
    RAISE EXCEPTION 'FAIL 03: the old argument list (desktop, limit 4) did not deal the two in: %', r;
  END IF;
  -- Three live hands now: a desktop player (4) is still legal anywhere, a
  -- tablet player (3) is not.
  INSERT INTO harness.p8 (k, game, a, b, c, j) VALUES ('mt', v_a, v_b, v_c, v_p, jsonb_build_object('horse', v_h));
END $$;
\echo '  ok  03 THE PLATFORM LIMIT  a human and a horse in three Clusters with live hands in two: in the third mobile (2) is refused MULTI_TABLE_LIMIT naming the platform, its limit and the two hands, tablet (3), desktop and an unknown platform are legal; P0 and fn_lightning_match by their old argument lists, positional and named, answer desktop; the mobile plan places neither; the Cluster''s configuration moves the number; an abandoned formation stops counting; match_and_form with the map deals every other player and neither of them, and by the old argument list deals them both'

-- 04 THE WAIT AND THE SHOWDOWN ARE RECORDED, ONCE ---------------------------------------
DO $$
DECLARE v_g uuid; v_ps uuid[]; v_idle jsonb; r jsonb; v_hand uuid; v_inst uuid; v_bad integer; v_spec jsonb; v_err text;
BEGIN
  v_g := harness.lc('WAIT');
  v_ps := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  SELECT jsonb_object_agg(sl.player_id::text, sl.idle_since) INTO v_idle
    FROM public.lightning_pool_slot sl WHERE sl.cluster_id = v_g AND sl.closed_at IS NULL AND sl.player_id = ANY (v_ps);
  PERFORM pg_sleep(0.25);
  r := harness.form(v_g, v_ps);
  v_hand := (r ->> 'hand_id')::uuid; v_inst := (r ->> 'instance_id')::uuid;
  SELECT count(*) INTO v_bad FROM public.lightning_hand_player hp JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
   WHERE hp.hand_id = v_hand
     AND (hp.waited_ms IS DISTINCT FROM round(extract(epoch FROM (lh.formed_at - (v_idle ->> hp.player_id::text)::timestamptz)) * 1000)::integer
          OR hp.waited_ms < 250 OR hp.showed IS NOT NULL);
  IF v_bad <> 0 OR (SELECT count(*) FROM public.lightning_hand_player WHERE hand_id = v_hand) <> 3 THEN
    RAISE EXCEPTION 'FAIL 04: % participants do not carry formed_at minus their idle_since as their wait', v_bad;
  END IF;
  v_err := public.fxr_try(format('UPDATE public.lightning_hand_player SET waited_ms = 1 WHERE hand_id = %L', v_hand));
  IF v_err IS NULL OR v_err !~ 'LIGHTNING_WAIT_IS_FINAL' THEN RAISE EXCEPTION 'FAIL 04: a wait was rewritten: %', v_err; END IF;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  v_spec := jsonb_build_object(v_ps[1]::text, jsonb_build_object('d', 4, 'c', 4, 's', true),
                               v_ps[2]::text, jsonb_build_object('d', -4, 'c', 4, 's', true),
                               v_ps[3]::text, jsonb_build_object('d', 0, 'c', 0));
  r := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, v_spec), 0, 0, '{"pot_size": 8}');
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true
     OR (SELECT string_agg(coalesce(hp.showed::text, 'null'), ',' ORDER BY array_position(v_ps, hp.player_id))
           FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand) IS DISTINCT FROM 'true,true,false' THEN
    RAISE EXCEPTION 'FAIL 04: the settlement did not write the engine''s showdown: %', r;
  END IF;
  v_err := public.fxr_try(format('UPDATE public.lightning_hand_player SET showed = false WHERE hand_id = %L AND player_id = %L', v_hand, v_ps[1]));
  IF v_err IS NULL OR v_err !~ 'LIGHTNING_SHOWDOWN_IS_FINAL' THEN RAISE EXCEPTION 'FAIL 04: a settled showdown was rewritten: %', v_err; END IF;
END $$;
\echo '  ok  04 THE WAIT  every participant (a horse among them) carries formed_at minus the idle_since its slot had, at least the 250 ms slept, and no showdown until settlement; the wait cannot be rewritten; the settlement writes the engine''s showdown, which then cannot be rewritten'

-- 05 SESSION STATISTICS FROM REAL SETTLED HANDS ----------------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_o uuid; v_hands uuid[] := ARRAY[]::uuid[]; v_spec jsonb; i integer;
        v_ps uuid; s jsonb; w integer[]; n integer; v_ps_row record; v_x jsonb; v_hh uuid;
        v_specs jsonb := '[
          {"P": {"d": 6, "c": 6, "s": true}, "H": {"d": -3, "c": 3, "s": true}, "O": {"d": -3, "c": 3, "f": "fast"}, "pot": 12, "win": ["P"]},
          {"P": {"d": -1, "c": 1, "f": "fast"}, "H": {"d": 3, "c": 2, "s": true}, "O": {"d": -2, "c": 2, "s": true}, "pot": 5, "win": ["H"]},
          {"P": {"d": 1, "c": 2, "s": true}, "H": {"d": 1, "c": 2, "s": true}, "O": {"d": -2, "c": 2, "f": "fast"}, "pot": 6, "win": ["P", "H"]},
          {"P": {"d": -2, "c": 2, "f": "normal"}, "H": {"d": -3, "c": 3, "s": true}, "O": {"d": 5, "c": 3, "s": true}, "pot": 8, "win": ["O"]},
          {"P": {"d": -4, "c": 4, "s": true}, "H": {"d": 4, "c": 4, "s": true}, "O": {"d": 0, "c": 0, "f": "fast"}, "pot": 8, "win": ["H"]},
          {"P": {"d": -1, "c": 1, "f": "fold_watch"}, "H": {"d": -2, "c": 2, "s": true}, "O": {"d": 3, "c": 2, "s": true}, "pot": 5, "win": ["O"]}]';
        v_facts jsonb := '[[true, true], [false, false], [true, false], [true, false], [true, true], null]';
BEGIN
  v_g := harness.lc('STATS');
  v_p := (harness.idle(v_g, false, 1))[1];
  v_h := (harness.idle(v_g, true, 1))[1];
  v_o := (harness.idle(v_g, false, 1, ARRAY[v_p]))[1];
  FOR i IN 0 .. 5 LOOP
    v_spec := jsonb_build_object(v_p::text, v_specs -> i -> 'P', v_h::text, v_specs -> i -> 'H', v_o::text, v_specs -> i -> 'O');
    PERFORM pg_sleep(0.03 * (i + 1));
    v_hands := v_hands || harness.play(v_g, ARRAY[v_p, v_h, v_o], v_spec, (v_specs -> i ->> 'pot')::numeric,
      (SELECT array_agg(CASE x WHEN 'P' THEN v_p WHEN 'H' THEN v_h ELSE v_o END) FROM jsonb_array_elements_text(v_specs -> i -> 'win') x));
    -- THE PROJECTION'S ROW, as production writes it once the hand commits;
    -- the sixth hand's is not projected yet.
    IF jsonb_typeof(v_facts -> i) = 'array' THEN
      SELECT lh.hand_history_id INTO v_hh FROM public.lightning_hand lh WHERE lh.hand_id = v_hands[i + 1];
      INSERT INTO public.ca_hand_facts (hand_id, user_id, club_id, played_at, vpip, pfr)
      VALUES (v_hh, v_p, 'cb000000-0000-0000-0000-000000000001', clock_timestamp(),
              (v_facts -> i ->> 0)::boolean, (v_facts -> i ->> 1)::boolean);
    END IF;
  END LOOP;
  v_ps := harness.session(v_g, v_p);
  INSERT INTO harness.p8 (k, game, a, b, c, j) VALUES ('stats', v_g, v_p, v_h, v_o, jsonb_build_object('hands', to_jsonb(v_hands)));

  PERFORM harness.as_user(v_p);
  s := public.fn_lightning_session_stats(v_ps);
  SELECT * INTO v_ps_row FROM public.lightning_pool_session WHERE id = v_ps;
  SELECT array_agg(hp.waited_ms ORDER BY hp.waited_ms) INTO w
    FROM public.lightning_hand_player hp WHERE hp.hand_id = ANY (v_hands) AND hp.player_id = v_p;
  n := cardinality(w);
  IF s IS NULL
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(s) k) IS DISTINCT FROM ARRAY['avg_pot', 'avg_wait_ms', 'bb_per_100', 'cluster_id',
          'current_stack', 'duration_s', 'ended_at', 'fast_folds', 'fold_and_watch', 'hands', 'hands_per_hour', 'net', 'normal_folds',
          'p95_wait_ms', 'p99_wait_ms', 'pfr', 'pool_session_id', 'showdowns', 'started_at', 'starting_stack', 'vpip']
     OR (s ->> 'hands')::integer <> 6 OR (s ->> 'net')::numeric <> -1 OR (s ->> 'bb_per_100')::numeric <> -8.33
     OR (s ->> 'fast_folds')::integer <> 1 OR (s ->> 'normal_folds')::integer <> 1 OR (s ->> 'fold_and_watch')::integer <> 1
     OR (s ->> 'showdowns')::integer <> 3 OR (s ->> 'avg_pot')::numeric <> 7.33
     OR (s ->> 'vpip')::numeric <> 80.0 OR (s ->> 'pfr')::numeric <> 40.0
     OR (s ->> 'cluster_id')::uuid <> v_g OR (s ->> 'pool_session_id')::uuid <> v_ps
     OR (s ->> 'started_at')::timestamptz <> v_ps_row.entered_at OR s -> 'ended_at' <> 'null'::jsonb
     OR (s ->> 'starting_stack')::numeric <> v_ps_row.starting_stack
     OR (s ->> 'current_stack')::numeric <> public.fn_lightning_pool_stack(v_ps)
     OR (s ->> 'current_stack')::numeric <> v_ps_row.starting_stack - 1 THEN
    RAISE EXCEPTION 'FAIL 05: the statistics are not the six settled hands: %', s;
  END IF;
  -- ONE SOURCE OF TRUTH: the settlement's own counters agree.
  IF (v_ps_row.hands, v_ps_row.fast_folds, v_ps_row.normal_folds, v_ps_row.fold_and_watch, v_ps_row.showdowns, v_ps_row.net_result)
     IS DISTINCT FROM ((s ->> 'hands')::integer, (s ->> 'fast_folds')::integer, (s ->> 'normal_folds')::integer,
                       (s ->> 'fold_and_watch')::integer, (s ->> 'showdowns')::integer, (s ->> 'net')::numeric) THEN
    RAISE EXCEPTION 'FAIL 05: the statistics disagree with the settlement''s counters';
  END IF;
  -- THE WAITS ARE REAL AND THE PERCENTILES NEAREST-RANK, computed here.
  IF n <> 6 OR (SELECT count(DISTINCT x) FROM unnest(w) x) < 2
     OR (s ->> 'avg_wait_ms')::integer <> (SELECT round(avg(x))::integer FROM unnest(w) x)
     OR (s ->> 'p95_wait_ms')::integer <> w[ceil(0.95 * n)::integer]
     OR (s ->> 'p99_wait_ms')::integer <> w[ceil(0.99 * n)::integer]
     OR (s ->> 'p99_wait_ms')::integer <> w[n] THEN
    RAISE EXCEPTION 'FAIL 05: the waits % are not the averages and percentiles %', w, s;
  END IF;
  IF (s ->> 'duration_s')::bigint <> floor(extract(epoch FROM (clock_timestamp() - v_ps_row.entered_at)))::bigint
        AND (s ->> 'duration_s')::bigint <> floor(extract(epoch FROM (clock_timestamp() - v_ps_row.entered_at)))::bigint - 1
     OR ((s ->> 'duration_s')::bigint > 0 AND (s ->> 'hands_per_hour')::numeric <> round(6 * 3600.0 / (s ->> 'duration_s')::bigint, 2))
     OR ((s ->> 'duration_s')::bigint = 0 AND s -> 'hands_per_hour' <> 'null'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 05: duration or hands per hour is wrong: %', s;
  END IF;
  -- THE HORSE gets its own numbers exactly as a human does.
  PERFORM harness.as_user(v_h);
  v_x := public.fn_lightning_session_stats(harness.session(v_g, v_h));
  IF v_x IS NULL OR (v_x ->> 'hands')::integer <> 6 OR (v_x ->> 'net')::numeric <> 0 OR (v_x ->> 'showdowns')::integer <> 6
     OR v_x -> 'vpip' <> 'null'::jsonb OR (v_x ->> 'p99_wait_ms') IS NULL THEN
    RAISE EXCEPTION 'FAIL 05: the horse''s statistics are not its six hands (and no projected facts yet): %', v_x;
  END IF;
  -- NOBODY ELSE: another player, a stranger, no caller, a session that does
  -- not exist; the service role reads any.
  PERFORM harness.as_user(v_o);
  IF public.fn_lightning_session_stats(v_ps) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 05: another player read the session'; END IF;
  PERFORM harness.as_user(gen_random_uuid());
  IF public.fn_lightning_session_stats(v_ps) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 05: a stranger read the session'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_session_stats(v_ps) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 05: no caller read the session'; END IF;
  PERFORM harness.as_user(v_p);
  IF public.fn_lightning_session_stats(gen_random_uuid()) IS NOT NULL OR public.fn_lightning_session_stats(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: a session that does not exist answered';
  END IF;
  PERFORM harness.as_user(NULL, 'service_role');
  IF (public.fn_lightning_session_stats(v_ps) - 'duration_s' - 'hands_per_hour') IS DISTINCT FROM (s - 'duration_s' - 'hands_per_hour') THEN
    RAISE EXCEPTION 'FAIL 05: the service role did not read the same statistics';
  END IF;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  05 SESSION STATISTICS  six real settled hands (a horse in every one, fast, normal and fold-and-watch folds through the fold door, three showdowns): hands 6, net -1, BB/100 -8.33, average pot 7.33, the fold and showdown counts equal to the settlement''s own counters, VPIP 80.0 and PFR 40.0 from the five projected ca_hand_facts rows, the current stack the pool stack, average, P95 and P99 wait equal to a nearest-rank reading of the formation waits; the horse''s numbers are its own; another player, a stranger and no caller get NULL; the service role reads the same'

-- 06 RECENT HANDS ---------------------------------------------------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_hands uuid[]; r jsonb; v_g2 uuid; v_q uuid := gen_random_uuid(); v_h2 uuid;
        i integer; v_last uuid; v_one uuid; v_all uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT game, a, b, ARRAY(SELECT jsonb_array_elements_text(j -> 'hands')::uuid) INTO v_g, v_p, v_h, v_hands FROM harness.p8 WHERE k = 'stats';
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_recent_hands();
  IF jsonb_array_length(r) <> 6
     OR (SELECT array_agg((x ->> 'hand_id')::uuid ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY[v_hands[6], v_hands[5], v_hands[4], v_hands[3], v_hands[2], v_hands[1]]
     OR (SELECT array_agg(x ->> 'result' ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY['folded', 'lost', 'folded', 'split', 'folded', 'won']
     OR (SELECT array_agg(x ->> 'fold_type' ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY['fold_watch', 'none', 'normal', 'none', 'fast', 'none']
     OR (SELECT array_agg((x ->> 'showdown')::boolean ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY[false, true, false, true, false, true]
     OR (SELECT array_agg((x ->> 'net')::numeric ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY[-1, -4, -2, 1, -1, 6]::numeric[]
     OR (SELECT array_agg((x ->> 'pot')::numeric ORDER BY o) FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o))
        IS DISTINCT FROM ARRAY[5, 8, 8, 6, 5, 12]::numeric[]
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) WITH ORDINALITY t(x, o) JOIN jsonb_array_elements(r) WITH ORDINALITY u(y, p) ON p = o + 1
                 WHERE (x ->> 'played_at')::timestamptz < (y ->> 'played_at')::timestamptz) THEN
    RAISE EXCEPTION 'FAIL 06: the recent hands are not the six, newest first, with their results: %', r;
  END IF;
  -- EVERY ROW IS THE PLAYER'S OWN RECORD, and never names an instance.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r) x
              JOIN public.lightning_hand_player hp ON hp.hand_id = (x ->> 'hand_id')::uuid AND hp.player_id = v_p
              JOIN public.lightning_hand lh ON lh.hand_id = hp.hand_id
              JOIN public.hand_history hh ON hh.id = lh.hand_history_id
             WHERE (x ->> 'hand_history_id')::uuid IS DISTINCT FROM lh.hand_history_id
                OR (x ->> 'hand_number')::bigint IS DISTINCT FROM lh.hand_number
                OR (x ->> 'stack_before')::numeric IS DISTINCT FROM hp.stack_before
                OR (x ->> 'stack_after')::numeric IS DISTINCT FROM hp.stack_after
                OR x ->> 'position' IS DISTINCT FROM hp.position
                OR (x ->> 'cluster_id')::uuid IS DISTINCT FROM v_g
                OR (x ->> 'big_blind')::numeric IS DISTINCT FROM hh.big_blind
                OR (x ->> 'small_blind')::numeric IS DISTINCT FROM hh.small_blind
                OR (x ->> 'played_at')::timestamptz IS DISTINCT FROM lh.settled_at)
     OR (SELECT count(*) FROM jsonb_array_elements(r) x JOIN public.lightning_hand_player hp ON hp.hand_id = (x ->> 'hand_id')::uuid AND hp.player_id = v_p) <> 6
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x ? 'lightning_instance_id' OR x ? 'instance_id' OR x ? 'players')
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r -> 0) k) IS DISTINCT FROM ARRAY['big_blind', 'cluster_id', 'fold_type',
          'hand_history_id', 'hand_id', 'hand_number', 'net', 'played_at', 'position', 'pot', 'result', 'showdown', 'small_blind',
          'stack_after', 'stack_before'] THEN
    RAISE EXCEPTION 'FAIL 06: a recent hand row is not the player''s own record: %', r -> 0;
  END IF;
  IF jsonb_array_length(public.fn_lightning_recent_hands(2)) <> 2 OR (public.fn_lightning_recent_hands(2) -> 0 ->> 'hand_id')::uuid <> v_hands[6]
     OR public.fn_lightning_recent_hands(0) <> '[]'::jsonb OR jsonb_array_length(public.fn_lightning_recent_hands(NULL)) <> 6
     OR jsonb_array_length(public.fn_lightning_recent_hands(-5)) <> 0 THEN
    RAISE EXCEPTION 'FAIL 06: the limit is not honoured';
  END IF;
  -- THE HORSE reads its own six; a stranger and no caller read nothing.
  PERFORM harness.as_user(v_h);
  IF jsonb_array_length(public.fn_lightning_recent_hands()) <> 6 OR (public.fn_lightning_recent_hands() -> 3 ->> 'result') <> 'split' THEN
    RAISE EXCEPTION 'FAIL 06: the horse''s recent hands are not its own six';
  END IF;
  PERFORM harness.as_user(gen_random_uuid());
  IF public.fn_lightning_recent_hands() <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL 06: a stranger read hands'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_recent_hands() <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL 06: no caller read hands'; END IF;

  -- FIFTY-ONE HANDS IN ONE CLUSTER, ONE IN ANOTHER: the cap and the filter.
  v_g2 := harness.lc('RECENT');
  PERFORM harness.seat(v_g2, v_q, false);
  v_h2 := (harness.idle(v_g2, true, 1))[1];
  FOR i IN 1 .. 51 LOOP
    v_last := harness.play(v_g2, ARRAY[v_q, v_h2],
                jsonb_build_object(v_q::text, jsonb_build_object('d', CASE WHEN i % 2 = 0 THEN 1 ELSE -1 END, 'c', 1, 's', true),
                                   v_h2::text, jsonb_build_object('d', CASE WHEN i % 2 = 0 THEN -1 ELSE 1 END, 'c', 1, 's', true)),
                2, ARRAY[CASE WHEN i % 2 = 0 THEN v_q ELSE v_h2 END]);
    v_all := v_all || v_last;
  END LOOP;
  PERFORM harness.seat(v_g, v_q, false);
  v_one := harness.play(v_g, ARRAY[v_q, v_h], jsonb_build_object(v_q::text, jsonb_build_object('d', 2, 'c', 1, 's', true),
                                                                 v_h::text, jsonb_build_object('d', -2, 'c', 2, 's', true)), 3, ARRAY[v_q]);
  PERFORM harness.as_user(v_q);
  r := public.fn_lightning_recent_hands();
  IF jsonb_array_length(r) <> 50 OR (r -> 0 ->> 'hand_id')::uuid <> v_one OR (r -> 1 ->> 'hand_id')::uuid <> v_all[51]
     OR jsonb_array_length(public.fn_lightning_recent_hands(500)) <> 50 THEN
    RAISE EXCEPTION 'FAIL 06: fifty-two hands did not answer the newest fifty';
  END IF;
  r := public.fn_lightning_recent_hands(50, harness.session(v_g, v_q));
  IF jsonb_array_length(r) <> 1 OR (r -> 0 ->> 'hand_id')::uuid <> v_one OR (r -> 0 ->> 'result') <> 'won' THEN
    RAISE EXCEPTION 'FAIL 06: the session filter did not answer the one hand of that session: %', r;
  END IF;
  r := public.fn_lightning_recent_hands(50, harness.session(v_g2, v_q));
  IF jsonb_array_length(r) <> 50 OR (r -> 0 ->> 'hand_id')::uuid <> v_all[51] OR (r -> 49 ->> 'hand_id')::uuid <> v_all[2]
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE (x ->> 'cluster_id')::uuid <> v_g2) THEN
    RAISE EXCEPTION 'FAIL 06: the other session''s filter is not its newest fifty';
  END IF;
  IF public.fn_lightning_recent_hands(50, harness.session(v_g, v_p)) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 06: a filter on somebody else''s session answered';
  END IF;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  06 RECENT HANDS  the player''s six settled hands newest first with result folded, lost, folded, split, folded, won (the split from the engine''s winners), fold type, showdown, net, pot, stacks, position, blinds, hand number and history id exactly as recorded, no instance id; the limit is honoured and capped; the horse reads its own six, a stranger and no caller nothing; fifty-two hands answer the newest fifty, the session filter answers one session''s hands and nothing for somebody else''s session'

-- 07 POOL STATUS ----------------------------------------------------------------------
DO $$
DECLARE v_m uuid; v_t uuid; v_v uuid; v_member uuid := gen_random_uuid(); v_out uuid := gen_random_uuid(); s jsonb; v_trail text := '';
BEGIN
  v_m := harness.c8('MUST', 6, 7, 2, 6, 2);
  PERFORM harness.as_user(v_out);
  s := public.fn_lightning_pool_status(v_m);
  IF s IS DISTINCT FROM jsonb_build_object('cluster_mode', 'must_move', 'players', 17, 'status', 'BUILDING') THEN
    RAISE EXCEPTION 'FAIL 07: a must-move Cluster at 17 is not BUILDING: %', s;
  END IF;
  v_t := harness.lc('STATUS');
  s := public.fn_lightning_pool_status(v_t); v_trail := s ->> 'status';
  IF s IS DISTINCT FROM jsonb_build_object('cluster_mode', 'lightning', 'players', 18, 'status', 'ACTIVE') THEN
    RAISE EXCEPTION 'FAIL 07: Lightning at 18 is not ACTIVE: %', s;
  END IF;
  PERFORM harness.to(v_t, 35);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'status');
  PERFORM harness.join(v_t, 1, true);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'status');
  IF s IS DISTINCT FROM jsonb_build_object('cluster_mode', 'lightning', 'players', 36, 'status', 'HOT') THEN
    RAISE EXCEPTION 'FAIL 07: Lightning at 36 is not HOT: %', s;
  END IF;
  PERFORM harness.to(v_t, 17);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'status');
  PERFORM harness.to(v_t, 13);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'status');
  IF s IS DISTINCT FROM jsonb_build_object('cluster_mode', 'lightning', 'players', 13, 'status', 'THIN') THEN
    RAISE EXCEPTION 'FAIL 07: Lightning at 13 is not THIN: %', s;
  END IF;
  PERFORM harness.to(v_t, 12);
  PERFORM harness.drive(v_t);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'cluster_mode') || ':' || (s ->> 'status');
  PERFORM harness.drive(v_t);
  s := public.fn_lightning_pool_status(v_t); v_trail := v_trail || ',' || (s ->> 'cluster_mode') || ':' || (s ->> 'status');
  IF v_trail <> 'ACTIVE,ACTIVE,HOT,THIN,THIN,pending_off:THIN,must_move:BUILDING' THEN
    RAISE EXCEPTION 'FAIL 07: the status trail is %', v_trail;
  END IF;
  -- THE LOBBY'S RULE: a private Cluster to its club's members.
  v_v := harness.lc('PRIVATE');
  UPDATE public.cash_games SET ruleset_snapshot = ruleset_snapshot || '{"options": {"is_private": true}}' WHERE id = v_v;
  INSERT INTO public.club_members (club_id, user_id) VALUES ('cb000000-0000-0000-0000-000000000001', v_member);
  IF public.fn_lightning_pool_status(v_v) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 07: a non-member saw a private Cluster'; END IF;
  PERFORM harness.as_user(v_member);
  IF public.fn_lightning_pool_status(v_v) ->> 'status' IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'FAIL 07: a member did not see a private Cluster'; END IF;
  PERFORM harness.as_user(NULL, 'service_role');
  IF public.fn_lightning_pool_status(v_v) IS NULL THEN RAISE EXCEPTION 'FAIL 07: the service role did not see a private Cluster'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_pool_status(v_m) IS NOT NULL OR public.fn_lightning_pool_status(gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 07: no caller, or an unknown Cluster, answered';
  END IF;
  -- THE RULE IS THE POLICY'S: as the role, RLS shows exactly what the door does.
  PERFORM harness.as_user(v_out);
  ALTER TABLE public.cash_games ENABLE ROW LEVEL SECURITY;
  SET ROLE authenticated;
  IF (SELECT count(*) FROM public.cash_games WHERE id IN (v_v, v_m)) <> 1 THEN RESET ROLE; ALTER TABLE public.cash_games DISABLE ROW LEVEL SECURITY; RAISE EXCEPTION 'FAIL 07: the policy shows a non-member the private Cluster'; END IF;
  RESET ROLE;
  PERFORM harness.as_user(v_member);
  SET ROLE authenticated;
  IF (SELECT count(*) FROM public.cash_games WHERE id IN (v_v, v_m)) <> 2 THEN RESET ROLE; ALTER TABLE public.cash_games DISABLE ROW LEVEL SECURITY; RAISE EXCEPTION 'FAIL 07: the policy hides the private Cluster from a member'; END IF;
  RESET ROLE;
  ALTER TABLE public.cash_games DISABLE ROW LEVEL SECURITY;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  07 POOL STATUS  {cluster_mode, players, status} only: must-move at 17 BUILDING; Lightning at 18 and 35 ACTIVE, at 36 HOT, at 17 and 13 THIN, pending_off THIN, reverted must_move BUILDING; a private Cluster is shown to its club''s members and the service role, never to a non-member, exactly as the lobby policy cash_games_read shows it under row security; no caller and an unknown Cluster get NULL'

-- 08 MY SESSIONS ----------------------------------------------------------------------
DO $$
DECLARE v_a uuid; v_b uuid; v_c uuid; v_p uuid; v_h uuid; r jsonb;
BEGIN
  SELECT game, a, b, c, (j ->> 'horse')::uuid INTO v_a, v_b, v_c, v_p, v_h FROM harness.p8 WHERE k = 'mt';
  PERFORM harness.as_user(v_p);
  r := public.fn_lightning_my_sessions();
  IF jsonb_array_length(r) <> 3
     OR (SELECT array_agg((x ->> 'cluster_id')::uuid ORDER BY x ->> 'cluster_id') FROM jsonb_array_elements(r) x)
        IS DISTINCT FROM (SELECT array_agg(g ORDER BY g::text) FROM unnest(ARRAY[v_a, v_b, v_c]) g)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) x
                  JOIN public.cash_games cg ON cg.id = (x ->> 'cluster_id')::uuid
                 WHERE (x ->> 'pool_session_id')::uuid IS DISTINCT FROM harness.session(cg.id, v_p)
                    OR x ->> 'name' IS DISTINCT FROM cg.name OR x ->> 'variant' IS DISTINCT FROM cg.variant
                    OR x -> 'stakes' IS DISTINCT FROM jsonb_build_object('sb', cg.sb, 'bb', cg.bb)
                    OR (x ->> 'stack')::numeric IS DISTINCT FROM public.fn_lightning_pool_stack(harness.session(cg.id, v_p))
                    OR (x ->> 'in_hand')::boolean IS DISTINCT FROM public.fn_lightning_player_in_hand(v_p, cg.id)
                    OR (x ->> 'in_hand')::boolean IS NOT TRUE)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r) x WHERE x ? 'instance_id' OR x ? 'lightning_instance_id' OR x ? 'hand_id'
                   OR (SELECT count(*) FROM jsonb_object_keys(x)) <> 7) THEN
    RAISE EXCEPTION 'FAIL 08: my sessions is not the player''s three open sessions: %', r;
  END IF;
  PERFORM harness.as_user(v_h);
  IF jsonb_array_length(public.fn_lightning_my_sessions()) <> 3 THEN RAISE EXCEPTION 'FAIL 08: the horse does not see its three'; END IF;
  PERFORM harness.as_user(gen_random_uuid());
  IF public.fn_lightning_my_sessions() <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL 08: a stranger sees sessions'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_my_sessions() <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL 08: no caller sees sessions'; END IF;
END $$;
\echo '  ok  08 MY SESSIONS  the multi-tabling player''s three open sessions, each with its Cluster''s name, stakes and variant, its pool stack and in_hand true, seven keys and no instance or hand id; the horse sees its three; a stranger and no caller see none'

-- 09 THE SUMMARY, AND HISTORY OUTLIVES THE INSTANCE AND THE POOL ----------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_h uuid; v_hands uuid[]; v_ps uuid; s0 jsonb; s1 jsonb; r jsonb; v_void uuid; v_facts bigint; v_census text;
BEGIN
  SELECT game, a, b, ARRAY(SELECT jsonb_array_elements_text(j -> 'hands')::uuid) INTO v_g, v_p, v_h, v_hands FROM harness.p8 WHERE k = 'stats';
  v_ps := harness.session(v_g, v_p);
  PERFORM harness.as_user(v_p);
  s0 := public.fn_lightning_session_summary(v_ps);
  IF (s0 ->> 'ended')::boolean IS DISTINCT FROM false OR s0 -> 'exit_reason' <> 'null'::jsonb
     OR (s0 - 'ended' - 'exit_reason' - 'duration_s' - 'hands_per_hour') IS DISTINCT FROM
        (public.fn_lightning_session_stats(v_ps) - 'duration_s' - 'hands_per_hour') THEN
    RAISE EXCEPTION 'FAIL 09: the open summary is not the statistics with ended false: %', s0;
  END IF;
  -- THE READERS WRITE NOTHING: every row the statistics read, before and after
  -- every door is asked.
  v_census := (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT to_jsonb(hp)::text AS x FROM public.lightning_hand_player hp
      UNION ALL SELECT to_jsonb(ps)::text FROM public.lightning_pool_session ps
      UNION ALL SELECT to_jsonb(f)::text FROM public.ca_hand_facts f
      UNION ALL SELECT to_jsonb(lh)::text FROM public.lightning_hand lh) q);
  PERFORM public.fn_lightning_session_stats(v_ps), public.fn_lightning_session_summary(v_ps), public.fn_lightning_my_sessions(),
          public.fn_lightning_pool_status(v_g), public.fn_lightning_recent_hands(50, v_ps);
  IF v_census IS DISTINCT FROM (SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
      SELECT to_jsonb(hp)::text AS x FROM public.lightning_hand_player hp
      UNION ALL SELECT to_jsonb(ps)::text FROM public.lightning_pool_session ps
      UNION ALL SELECT to_jsonb(f)::text FROM public.ca_hand_facts f
      UNION ALL SELECT to_jsonb(lh)::text FROM public.lightning_hand lh) q) THEN
    RAISE EXCEPTION 'FAIL 09: a reader wrote a row';
  END IF;
  -- A FORMATION NOT YET DEALT, then Lightning switched off: Phase 7 voids the
  -- formation, drains and reverts, exiting every pool session.
  r := harness.form(v_g, ARRAY[v_p, v_h]);
  v_void := (r ->> 'hand_id')::uuid;
  SELECT count(*) INTO v_facts FROM public.ca_hand_facts WHERE user_id = v_p;
  UPDATE public.cash_games SET lightning_enabled = false WHERE id = v_g;
  PERFORM harness.drive(v_g); PERFORM harness.drive(v_g);
  IF harness.mode(v_g) <> 'must_move' THEN RAISE EXCEPTION 'FIXTURE: the Cluster did not revert'; END IF;
  s1 := public.fn_lightning_session_summary(v_ps);
  IF (s1 ->> 'ended')::boolean IS DISTINCT FROM true OR s1 ->> 'exit_reason' <> 'lightning_off' OR s1 -> 'ended_at' = 'null'::jsonb
     OR (s1 ->> 'hands')::integer <> 6 OR (s1 ->> 'net')::numeric <> -1 OR (s1 ->> 'vpip')::numeric <> 80.0
     OR (s1 ->> 'current_stack')::numeric <> (SELECT coalesce(ending_stack, starting_stack + net_result) FROM public.lightning_pool_session WHERE id = v_ps)
     OR (s1 ->> 'current_stack')::numeric <> (s0 ->> 'current_stack')::numeric THEN
    RAISE EXCEPTION 'FAIL 09: the exited summary is not ended lightning_off with the same hands: %', s1;
  END IF;
  -- THE HISTORY SURVIVES: every instance is terminal, every hand row and its
  -- hand_history row is there, the void formation is not a hand anyone played.
  IF EXISTS (SELECT 1 FROM public.lightning_instance WHERE cluster_id = v_g AND state NOT IN ('complete', 'abandoned'))
     OR (SELECT state FROM public.lightning_instance li JOIN public.lightning_hand lh ON lh.lightning_instance_id = li.id WHERE lh.hand_id = v_void) <> 'abandoned'
     OR (SELECT count(*) FROM public.lightning_hand lh JOIN public.hand_history hh ON hh.id = lh.hand_history_id WHERE lh.hand_id = ANY (v_hands)) <> 6
     OR jsonb_array_length(public.fn_lightning_recent_hands(50, v_ps)) <> 6
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(public.fn_lightning_recent_hands()) x WHERE (x ->> 'hand_id')::uuid = v_void)
     OR (SELECT count(*) FROM public.ca_hand_facts WHERE user_id = v_p) <> v_facts THEN
    RAISE EXCEPTION 'FAIL 09: the history did not outlive the instance and the pool';
  END IF;
  -- Another player gets no summary.
  PERFORM harness.as_user(v_h);
  IF public.fn_lightning_session_summary(v_ps) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 09: another player read the summary'; END IF;
  PERFORM harness.as_user(NULL, NULL);
  IF public.fn_lightning_session_summary(v_ps) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 09: no caller read the summary'; END IF;
END $$;
\echo '  ok  09 THE SUMMARY  open, it is the statistics with ended false; asking all five doors writes no row of the hands, the pool sessions, the facts or the hand table; Lightning switched off voids an undealt formation, drains and reverts, and the summary answers ended, lightning_off, the same six hands, net and VPIP; every instance is terminal, all six hand_history rows and the session''s recent hands remain, the void formation is no one''s hand, and no Cluster-level fact was removed; another player and no caller get nothing'

-- 10 WHO MAY CALL ----------------------------------------------------------------------
DO $$
DECLARE v_p uuid; v_err text;
BEGIN
  SELECT c INTO v_p FROM harness.p8 WHERE k = 'mt';
  PERFORM harness.as_user(v_p);
  SET ROLE authenticated;
  IF jsonb_array_length(public.fn_lightning_my_sessions()) <> 3 THEN RESET ROLE; RAISE EXCEPTION 'FAIL 10: authenticated cannot call my sessions'; END IF;
  v_err := public.fxr_try('SELECT public.fn_lightning_match(gen_random_uuid(), now(), NULL, ''m1'', NULL)');
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 10: authenticated ran the matcher: %', v_err; END IF;
  SET ROLE anon;
  v_err := public.fxr_try('SELECT public.fn_lightning_my_sessions()');
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN RAISE EXCEPTION 'FAIL 10: anon ran my sessions: %', v_err; END IF;
  IF NOT (SELECT bool_and(has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') AND has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'))
            FROM unnest(ARRAY['public.fn_lightning_session_stats(uuid)', 'public.fn_lightning_session_summary(uuid)', 'public.fn_lightning_my_sessions()',
                              'public.fn_lightning_pool_status(uuid)', 'public.fn_lightning_recent_hands(integer,uuid)']) f)
     OR NOT (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE'))
            FROM unnest(ARRAY['public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
                              'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)',
                              'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)',
                              'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)']) f)
     OR has_function_privilege('authenticated', 'public.fn_lightning_hand_player_records_its_wait()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 10: the grants are not the five browser doors and a service-role matcher';
  END IF;
  PERFORM harness.as_user(NULL, NULL);
END $$;
\echo '  ok  10 WHO MAY CALL  as the authenticated role the player reads their three sessions and is refused the matcher (42501); anon is refused every door; the five doors are authenticated and service_role, the recreated matcher and P0 service_role alone, as before'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 11 EVERY @live-proof OF THE FILE HOLDS -------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 9
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 11: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  11 THE LIVE PROOFS  all nine @live-proof claims of the file evaluate true against this catalogue'
ASSERT

cat > "$fixture/precapture.sql" <<'ASSERT'
CREATE TABLE harness.rcap AS
SELECT 'fn:' || p.oid::regprocedure::text AS what, md5(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || coalesce(obj_description(p.oid, 'pg_proc'), '')) AS v
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.proname LIKE 'fn_lightning_%' OR p.proname LIKE 'fn_cash_cluster%')
UNION ALL
SELECT 'rows:' || x.t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', x.t), false, true, '')))[1]::text
  FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history']) x(t)
UNION ALL
SELECT 'hp', md5(string_agg(to_jsonb(hp)::text, '|' ORDER BY hp.hand_id, hp.player_id)) FROM public.lightning_hand_player hp
UNION ALL
SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_hand_player'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_hand_player'::regclass;
ASSERT

cat > "$fixture/reapply.sql" <<'ASSERT'
-- 12 RE-APPLIABLE -----------------------------------------------------------------------
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
        FROM unnest(ARRAY['lightning_hand', 'lightning_hand_player', 'lightning_pool_session', 'lightning_instance', 'hand_history']) x(t)
      UNION ALL
      SELECT 'hp', md5(string_agg(to_jsonb(hp)::text, '|' ORDER BY hp.hand_id, hp.player_id)) FROM public.lightning_hand_player hp
      UNION ALL
      SELECT 'triggers', string_agg(t.tgname || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.lightning_hand_player'::regclass AND NOT t.tgisinternal
      UNION ALL
      SELECT 'constraints', string_agg(c.conname, ',' ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid = 'public.lightning_hand_player'::regclass
    ) b ON b.what = a.what
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 12: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 12: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  12 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, the hand, participant, pool session, instance and history row counts, every participant row, and the participant table''s triggers and constraints exactly as they were'
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
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp8_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
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
echo "PASS: Lightning Phase 8 (spec Phases 11, 12 and 13), 13 sections, under production's default function ACLs and its live autorevoke event trigger: before the file none of it exists; after it no earlier proof is falsified but the seven that name the replaced argument lists; the multi-table limit is {desktop 4, tablet 3, mobile 2}, the old scalar still read, bad values reported; across three Clusters a human and a horse with two live hands are refused on mobile and legal on tablet and desktop, the old matcher signatures answer desktop and match_and_form honours the map; each formation records the real wait and the settlement the showdown, both final; session statistics from six real settled hands equal the settlement's counters with VPIP and PFR from ca_hand_facts and nearest-rank wait percentiles; recent hands are the player's own newest fifty with results, filtered by session; pool status maps BUILDING, ACTIVE, HOT and THIN and follows the lobby policy; my sessions lists three Clusters; the summary survives the reversion with every hand_history row; only the owner (or service_role) reads anything; every @live-proof holds and the file is re-appliable"
