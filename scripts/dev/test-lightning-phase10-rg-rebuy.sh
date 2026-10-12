#!/usr/bin/env bash
# Lightning Phase 10 (specification Phases 16 and 17, the database side):
# responsible gaming / auto-rebuy integration, and the RNG / hidden
# information review's standing pins.
#
# Proves 20261008111425 against a running catalogue and a running estate, on
# Postgres 17, socket only, on port 55557 (LIGHTNING_P10_PORT overrides it).
#
# THE CHAIN IS THE REAL ONE. The Lightning fixtures and every Lightning
# migration from 20260920172736 through Phase 9's disconnect file
# (20261008050805), in order, exactly as test-lightning-phase9-reconnect.sh
# builds them, then the migration under test, twice. Every Cluster is
# converted ON by the real drive, every pool slot comes from the real slot
# sync, every hand is formed by the real barrier, dealt by the real
# begin_dealing and settled by the real fn_lightning_settle_hand through the
# physical door; every stop goes through the real stop door and every
# post-hand stop exit through the real widened reaper. The rows the harness
# writes itself are fixture boundaries only: responsible_gaming_limits rows
# (the player's own self-exclusion, as fn_rg_self_exclude writes them), club
# wallet funding (club_members.chip_balance, the cashier's job), the
# Cluster's own ruleset_snapshot lightning object (the operator's job), and
# the engine-side pending-addon delivery (table_seats.stack + resolved_at,
# exactly what the engine's addon resolution writes). The reload door itself,
# public.atomic_table_rebuy, is installed as a production-parity fixture
# (same signature, same refusals: purchase key required, positive whole
# cents, seat locked and present, club wallet debited only with sufficient
# chips, one table_pending_addons row, idempotent by key) because the real
# body's receipt/freeze stack is proven by its own suites; THIS file proves
# that fn_lightning_auto_rebuy goes through that door and never moves a chip
# itself.
#
# LAW 10.5. Horses sit beside humans in every Cluster: they are refused at
# the doors, stop playing and auto-rebuy exactly as humans. The migration
# reads neither is_horse nor horse_id.
#
# LIGHTNING_P10_MIGRATION overrides the file under test, so mutation testing
# never touches the repository.
#
# PRODUCTION PARITY: the fixture installs production's default function
# privileges and its trg_autorevoke_privileged_anon event trigger (the
# Phase 8/9 harness's ground, verbatim) before the file runs.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_P10_PORT:-55557}
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
mine=${LIGHTNING_P10_MIGRATION:-$M/20261008111425_lightning_phase_10_responsible_gaming_stop_playing_auto_rebu.sql}
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase1" "$phase1r" "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$mine"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-p10-test.XXXXXX")
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
BEGIN
  IF public.fxr_try('SELECT 1/0') IS DISTINCT FROM '22012: division by zero' THEN
    RAISE EXCEPTION 'FAIL 00: the catcher does not catch';
  END IF;
  IF to_regprocedure('public.fn_lightning_stop_playing(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.lightning_pool_session'::regclass
                  AND attname IN ('stop_requested_at', 'auto_rebuys', 'auto_rebuy_total') AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lightning_pool_session'::regclass
                  AND conname = 'lightning_pool_session_auto_rebuy_counters_are_sane')
     OR (public.fn_lightning_config(NULL) ? 'auto_rebuy_enabled')
     OR pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure) ~ 'STOP_REQUESTED'
     OR pg_get_functiondef('public.fn_lightning_pool_enter(uuid,timestamp with time zone)'::regprocedure) ~ 'fn_rg_require_not_excluded'
     OR pg_get_functiondef('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'::regprocedure) ~ 'stop_playing'
     OR pg_get_functiondef('public.fn_lightning_reconnect_state(uuid)'::regprocedure) ~ 'stop_requested' THEN
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
  EXECUTE 'CREATE FUNCTION public.fx10_born_open() RETURNS integer LANGUAGE sql AS $q$ SELECT 1 $q$';
  IF NOT has_function_privilege('anon', 'public.fx10_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fx10_born_open()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fx10_born_open()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 00: the default ACL does not hand a new function to anon, authenticated and service_role';
  END IF;
  EXECUTE 'DROP FUNCTION public.fx10_born_open()';
  -- The reload door the auto-rebuy must go through stands (the fixture's
  -- production-parity atomic_table_rebuy), and the autorevoke named it.
  IF to_regprocedure('public.atomic_table_rebuy(uuid,uuid,numeric,uuid)') IS NULL THEN
    RAISE EXCEPTION 'FAIL 00: the reload door fixture is absent';
  END IF;
END $$;
\echo '  ok  00 THE GROUND  the catcher catches; neither door, none of the three columns, the constraint, the configuration keys, the legality arm, the pool-door gate, the reaper widening or the reconnect key exists before the file; production''s default ACL and autorevoke event trigger are live, a function created now is born executable by anon, authenticated and service_role, and the production-parity reload door stands'
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
\echo '  ok  01 NOTHING FALSIFIED  every predecessor live proof that held before the file still holds after it, and more than a hundred of them held before'

-- 02 THE CONFIGURATION: DEFAULTS AND CLAMPS ------------------------------------------
DO $$
DECLARE v_g uuid; c jsonb;
BEGIN
  c := public.fn_lightning_config(NULL);
  IF (c ->> 'auto_rebuy_enabled')::boolean IS DISTINCT FROM false
     OR c ->> 'auto_rebuy_trigger' IS DISTINCT FROM 'zero'
     OR c ->> 'auto_rebuy_target' IS DISTINCT FROM 'initial'
     OR (c ->> 'auto_rebuy_threshold_bb')::numeric IS DISTINCT FROM 1
     OR (c ->> 'auto_rebuy_threshold_pct')::integer IS DISTINCT FROM 25
     OR (c ->> 'auto_rebuy_max_count')::integer IS DISTINCT FROM 3
     OR (c ->> 'auto_rebuy_session_cap')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 02: the defaults are not off/zero/initial/1/25/3/0: %', c;
  END IF;
  v_g := harness.lc('cfg');
  PERFORM harness.cfg(v_g, jsonb_build_object(
    'auto_rebuy_enabled', true, 'auto_rebuy_trigger', 'sideways',
    'auto_rebuy_threshold_pct', 250, 'auto_rebuy_max_count', 1000,
    'auto_rebuy_session_cap', -5, 'auto_rebuy_target', 42));
  c := public.fn_lightning_config(v_g);
  IF (c ->> 'auto_rebuy_enabled')::boolean IS DISTINCT FROM true
     OR c ->> 'auto_rebuy_trigger' IS DISTINCT FROM 'zero'
     OR c ->> 'auto_rebuy_target' IS DISTINCT FROM 'initial'
     OR (c ->> 'auto_rebuy_threshold_pct')::integer IS DISTINCT FROM 99
     OR (c ->> 'auto_rebuy_max_count')::integer IS DISTINCT FROM 100
     OR (c ->> 'auto_rebuy_session_cap')::numeric IS DISTINCT FROM 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') i
                     WHERE i ->> 'key' = 'auto_rebuy_trigger')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'invalid') i
                     WHERE i ->> 'key' = 'auto_rebuy_target') THEN
    RAISE EXCEPTION 'FAIL 02: the clamps and the invalid record do not hold: %', c;
  END IF;
  PERFORM harness.cfg(v_g, '{"auto_rebuy_trigger": "below_pct", "auto_rebuy_target": "max", "auto_rebuy_threshold_pct": 40}'::jsonb);
  c := public.fn_lightning_config(v_g);
  IF c ->> 'auto_rebuy_trigger' IS DISTINCT FROM 'below_pct'
     OR c ->> 'auto_rebuy_target' IS DISTINCT FROM 'max'
     OR (c ->> 'auto_rebuy_threshold_pct')::integer IS DISTINCT FROM 40 THEN
    RAISE EXCEPTION 'FAIL 02: legal values are not read back: %', c;
  END IF;
  INSERT INTO harness.p8 (k, game) VALUES ('g:cfg', v_g);
END $$;
\echo '  ok  02 THE CONFIGURATION  the seven auto-rebuy keys default to off, zero, initial, 1 bb, 25 percent, 3 rebuys and no cap; a bogus trigger or target falls back and is named in invalid; 250 percent clamps to 99, 1000 rebuys to 100, a negative cap to 0; legal values read back'

-- 03 RESPONSIBLE GAMING AT THE DOORS --------------------------------------------------
DO $$
DECLARE v_g uuid; v_x uuid := gen_random_uuid(); v_h uuid := gen_random_uuid();
        v_in uuid := gen_random_uuid(); v_seat uuid; r record;
BEGIN
  v_g := harness.lc('rg');
  -- A SELF-EXCLUDED HUMAN AND A COOLING-OFF HORSE ARRIVE: the seat is real,
  -- the cash session is real, and the pool door refuses both the same way.
  PERFORM harness.exclude(v_x, clock_timestamp() + interval '30 days');
  PERFORM harness.cooloff(v_h, clock_timestamp() + interval '1 day');
  PERFORM harness.arrive(v_g, v_x, false);
  PERFORM harness.arrive(v_g, v_h, true);
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
              WHERE ps.cluster_id = v_g AND ps.player_id IN (v_x, v_h)) THEN
    RAISE EXCEPTION 'FAIL 03: an excluded or cooling-off player entered the pool';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                  WHERE ts.table_id = harness.feeder(v_g) AND ts.user_id = v_x AND ts.left_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 03: the refusal unseated the player (the door must refuse the POOL, not the chair)';
  END IF;
  -- THE EXCLUSION ENDS: the same seat enters through the real door.
  PERFORM harness.exclude(v_x, clock_timestamp() - interval '1 second');
  SELECT ts.id INTO v_seat FROM public.table_seats ts
   WHERE ts.table_id = harness.feeder(v_g) AND ts.user_id = v_x AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC, ts.id DESC LIMIT 1;
  DECLARE v_ret uuid; v_exist boolean;
  BEGIN
    v_ret := public.fn_lightning_pool_enter(v_seat);
    v_exist := EXISTS (SELECT 1 FROM public.lightning_pool_session ps
                        WHERE ps.cluster_id = v_g AND ps.player_id = v_x AND ps.exited_at IS NULL);
    IF v_ret IS NULL OR NOT v_exist THEN
      RAISE EXCEPTION 'FAIL 03: a lapsed exclusion still bars the pool door';
    END IF;
  END;
  -- AN EXCLUSION THAT BEGINS MID-SESSION: the matcher refuses RG_EXCLUDED on
  -- the next pass and clears when the record clears.
  PERFORM harness.seat(v_g, v_in, false);
  PERFORM harness.exclude(v_in, clock_timestamp() + interval '7 days');
  IF harness.reason(v_g, v_in, NULL) IS DISTINCT FROM 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 03: a mid-session exclusion is not refused: %', harness.reason(v_g, v_in, NULL);
  END IF;
  DELETE FROM public.responsible_gaming_limits WHERE user_id = v_in;
  IF harness.reason(v_g, v_in, NULL) IS DISTINCT FROM 'LEGAL' THEN
    RAISE EXCEPTION 'FAIL 03: a cleared exclusion still refuses: %', harness.reason(v_g, v_in, NULL);
  END IF;
  INSERT INTO harness.p8 (k, game, a, b, c) VALUES ('g:rg', v_g, v_x, v_h, v_in);
END $$;
\echo '  ok  03 RESPONSIBLE GAMING  a self-excluded human and a cooling-off horse are seated but never enter the pool (the door refuses the pool, not the chair); a lapsed exclusion enters through the real door; an exclusion that begins mid-session is RG_EXCLUDED on the next pass and clears when the record clears'

-- 04 STOP PLAYING, IDLE: THE EXIT IS IMMEDIATE AND IDEMPOTENT -------------------------
DO $$
DECLARE v_g uuid; v_p uuid; v_hp uuid; v jsonb; ps public.lightning_pool_session;
        n_stop integer; n_left integer;
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'g:rg';
  v_p := (harness.idle(v_g, false, 1))[1];
  v_hp := (harness.idle(v_g, true, 1))[1];
  -- THE HUMAN STOPS from the browser.
  PERFORM harness.as_user(v_p);
  v := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'exited')::boolean IS DISTINCT FROM true
     OR (v ->> 'in_hand')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 04: the idle stop did not exit at once: %', v;
  END IF;
  ps := harness.psrow(v_g, v_p);
  IF ps.exited_at IS NULL OR ps.exit_reason IS DISTINCT FROM 'stop_playing'
     OR ps.state IS DISTINCT FROM 'closed' OR ps.stop_requested_at IS NULL
     OR ps.ending_stack IS NULL THEN
    RAISE EXCEPTION 'FAIL 04: the exited session does not say stop_playing: %', to_jsonb(ps);
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_slot sl
              WHERE sl.pool_session_id = ps.id AND sl.closed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 04: the stop left a slot open';
  END IF;
  IF (harness.evlast(v_g, 'pool_player_left') ->> 'reason') IS DISTINCT FROM 'stop_playing'
     OR (harness.evlast(v_g, 'stop_playing_requested') ->> 'player_id')::uuid IS DISTINCT FROM v_p THEN
    RAISE EXCEPTION 'FAIL 04: the ledger does not carry the stop';
  END IF;
  -- IDEMPOTENT: a second tap answers what stands and writes nothing.
  n_stop := harness.evn(v_g, 'stop_playing_requested'); n_left := harness.evn(v_g, 'pool_player_left');
  PERFORM harness.as_user(v_p);
  v := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'exited')::boolean IS DISTINCT FROM true
     OR harness.evn(v_g, 'stop_playing_requested') <> n_stop
     OR harness.evn(v_g, 'pool_player_left') <> n_left THEN
    RAISE EXCEPTION 'FAIL 04: the second tap wrote: %', v;
  END IF;
  -- A HORSE STOPS EXACTLY AS A HUMAN, from a disconnected state no less.
  PERFORM public.fn_lightning_presence_report(v_g, ARRAY[v_hp], NULL);
  PERFORM harness.as_user(v_hp);
  v := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  ps := harness.psrow(v_g, v_hp);
  IF (v ->> 'exited')::boolean IS DISTINCT FROM true OR ps.exit_reason IS DISTINCT FROM 'stop_playing' THEN
    RAISE EXCEPTION 'FAIL 04: the horse''s stop differs from the human''s: % %', v, to_jsonb(ps);
  END IF;
END $$;
\echo '  ok  04 STOP PLAYING, IDLE  not in a hand, the stop exits at once: exit_reason stop_playing, state closed, slot closed, one stop_playing_requested and one pool_player_left; a second tap answers what stands and writes nothing; a disconnected horse stops exactly as a human'

-- 05 STOP PLAYING, MID-HAND: THE MARK STANDS, THE HAND FINISHES, THE REAPER EXITS -----
DO $$
DECLARE v_g uuid; a uuid; b uuid; c uuid; r jsonb; v_inst uuid; v_hand uuid; v jsonb;
        ps public.lightning_pool_session; v_reap jsonb; n_exp integer; v_players uuid[];
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'g:rg';
  v_players := harness.idle(v_g, false, 2) || harness.idle(v_g, true, 1);
  a := v_players[1]; b := v_players[2]; c := v_players[3];
  r := harness.form(v_g, ARRAY[a, b, c]);
  v_inst := (r ->> 'instance_id')::uuid; v_hand := (r ->> 'hand_id')::uuid;
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  PERFORM harness.deal(v_inst);
  -- A STOPS IN THE MIDDLE OF THE HAND.
  PERFORM harness.as_user(a);
  v := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'exited')::boolean IS DISTINCT FROM false
     OR (v ->> 'in_hand')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the mid-hand stop did not stand aside for the hand: %', v;
  END IF;
  ps := harness.psrow(v_g, a);
  IF ps.stop_requested_at IS NULL OR ps.exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: the mid-hand stop mark is wrong: %', to_jsonb(ps);
  END IF;
  -- THE HAND'S OWN RULES HOLD: the reaper will not touch A while the hand
  -- lives, and the matcher's answer for A is the hand, not the stop.
  v_reap := public.fn_lightning_reap_expired_disconnects(v_g);
  IF (harness.psrow(v_g, a)).exited_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 05: the reaper cut a live hand short: %', v_reap;
  END IF;
  IF harness.reason(v_g, a, NULL) IS DISTINCT FROM 'IN_HAND' THEN
    RAISE EXCEPTION 'FAIL 05: the legality of a stopping player in a hand is %', harness.reason(v_g, a, NULL);
  END IF;
  -- THE HAND SETTLES THROUGH THE REAL DOOR; A PLAYED IT TO THE END.
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  r := harness.settle(v_hand, gen_random_uuid(), harness.results(v_hand, jsonb_build_object(
         a::text, '{"d": -2, "c": 2}'::jsonb,
         b::text, '{"d": 4, "c": 2, "s": true}'::jsonb,
         c::text, '{"d": -2, "c": 2, "f": "fast"}'::jsonb)), 0, 0,
         jsonb_build_object('pot_size', 6, 'actions', '[]'::jsonb, 'game_variant', 'nlh',
                            'community_cards', ARRAY['As','Kd','7h','2c','2d'],
                            'winners', jsonb_build_array(jsonb_build_object('userId', b, 'amount', 6, 'potIndex', 0))));
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 05: the settlement refused: %', r;
  END IF;
  -- AFTER THE HAND, THE MATCHER NAMES THE STOP, AND THE REAPER FINISHES IT.
  IF harness.reason(v_g, a, NULL) IS DISTINCT FROM 'STOP_REQUESTED' THEN
    RAISE EXCEPTION 'FAIL 05: the settled stopper is not STOP_REQUESTED: %', harness.reason(v_g, a, NULL);
  END IF;
  n_exp := harness.evn(v_g, 'player_expired');
  v_reap := public.fn_lightning_reap_expired_disconnects(v_g);
  ps := harness.psrow(v_g, a);
  IF ps.exited_at IS NULL OR ps.exit_reason IS DISTINCT FROM 'stop_playing'
     OR ps.hands IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 05: the reaper did not finish the stop after the hand: % %', to_jsonb(ps), v_reap;
  END IF;
  IF harness.evn(v_g, 'player_expired') <> n_exp THEN
    RAISE EXCEPTION 'FAIL 05: a stop was counted as an expired disconnect';
  END IF;
  IF (harness.evlast(v_g, 'pool_player_left') ->> 'reason') IS DISTINCT FROM 'stop_playing' THEN
    RAISE EXCEPTION 'FAIL 05: the post-hand exit does not say stop_playing';
  END IF;
  INSERT INTO harness.p8 (k, game, a, b, c) VALUES ('g:hand', v_g, a, b, c);
END $$;
\echo '  ok  05 STOP PLAYING, MID-HAND  the mark stands while the hand lives (ok, not exited, in hand); the reaper will not cut a live hand; the hand settles through the real door with the stopper playing to the end; after it the matcher says STOP_REQUESTED and the reaper exits with exit_reason stop_playing, no player_expired record, one pool_player_left'

-- 06 THE RECONNECT SNAPSHOT AND THE SESSION METRICS CARRY THE STOP --------------------
DO $$
DECLARE v_g uuid; v_p uuid; v jsonb; ps public.lightning_pool_session;
BEGIN
  SELECT game INTO v_g FROM harness.p8 WHERE k = 'g:rg';
  v_p := (harness.idle(v_g, false, 1))[1];
  PERFORM harness.as_user(v_p);
  v := public.fn_lightning_reconnect_state(v_g);
  IF (v ->> 'stop_requested')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 06: an unstopped session says stop_requested: %', v;
  END IF;
  PERFORM public.fn_lightning_stop_playing(v_g);
  v := public.fn_lightning_session_summary((harness.psrow(v_g, v_p)).id);
  PERFORM harness.as_user(NULL, NULL);
  ps := harness.psrow(v_g, v_p);
  IF (v ->> 'ended')::boolean IS DISTINCT FROM true OR v ->> 'exit_reason' IS DISTINCT FROM 'stop_playing'
     OR (v -> 'hands') IS NULL OR (v -> 'duration_s') IS NULL OR (v -> 'net') IS NULL
     OR v ? 'hands_per_hour' IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: the session summary does not answer the stop and the metrics: %', v;
  END IF;
  -- The exited stopper has no open session left to rebuild: silence.
  PERFORM harness.as_user(v_p);
  v := public.fn_lightning_reconnect_state(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 06: an exited session still answers the reconnect door: %', v;
  END IF;
  -- A MARKED, STILL-OPEN SESSION SAYS SO: mark one inside a hand and read.
  v_p := (harness.idle(v_g, true, 1))[1];
  PERFORM harness.form(v_g, ARRAY[v_p, (harness.idle(v_g, false, 1, ARRAY[v_p]))[1]]);
  PERFORM harness.as_user(v_p);
  PERFORM public.fn_lightning_stop_playing(v_g);
  v := public.fn_lightning_reconnect_state(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF (v ->> 'stop_requested')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL 06: the reconnect snapshot forgot the standing stop: %', v;
  END IF;
END $$;
\echo '  ok  06 THE SNAPSHOT AND THE METRICS  reconnect_state answers stop_requested false before the stop and true while a marked session stands; the session summary answers ended, exit_reason stop_playing, hands, duration_s, hands_per_hour and net; an exited session answers the reconnect door with silence'

-- 07 AUTO-REBUY: DISABLED, NOT TRIGGERED, THEN THROUGH THE RELOAD DOOR ----------------
DO $$
DECLARE v_g uuid; h uuid; w uuid; v jsonb; ps public.lightning_pool_session;
        v_start numeric; v_chips numeric; v_amount numeric; v_hand uuid;
BEGIN
  v_g := harness.lc('rebuy');
  h := (harness.idle(v_g, false, 1))[1];
  w := (harness.idle(v_g, true, 1, ARRAY[h]))[1];
  -- OFF BY DEFAULT: the engine's call answers DISABLED and writes nothing.
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'DISABLED' THEN
    RAISE EXCEPTION 'FAIL 07: auto-rebuy is not born disabled: %', v;
  END IF;
  PERFORM harness.cfg(v_g, '{"auto_rebuy_enabled": true}'::jsonb);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'NOT_TRIGGERED' THEN
    RAISE EXCEPTION 'FAIL 07: a healthy stack triggered: %', v;
  END IF;
  -- THE HUMAN BUSTS IN A REAL HAND, THE HORSE TAKES THE POT.
  v_start := (harness.psrow(v_g, h)).starting_stack;
  v_amount := harness.seat_stack(v_g, h);
  v_hand := harness.play(v_g, ARRAY[h, w],
    jsonb_build_object(h::text, jsonb_build_object('d', -v_amount, 'c', v_amount),
                       w::text, jsonb_build_object('d', v_amount, 'c', v_amount, 's', true)),
    2 * v_amount, ARRAY[w]);
  IF coalesce(public.fn_lightning_pool_stack((harness.psrow(v_g, h)).id), -1) <> 0 THEN
    RAISE EXCEPTION 'FAIL 07: the bust did not land on the seat';
  END IF;
  -- FUNDED, THE TOP-UP GOES THROUGH THE RELOAD DOOR: the club wallet pays,
  -- the pending addon carries the chips, the session counts it, one event.
  PERFORM harness.fund(v_g, h, 1000);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  ps := harness.psrow(v_g, h);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true
     OR (v ->> 'amount')::numeric IS DISTINCT FROM v_start
     OR (v ->> 'count')::integer IS DISTINCT FROM 1
     OR ps.auto_rebuys IS DISTINCT FROM 1
     OR ps.auto_rebuy_total IS DISTINCT FROM v_start
     OR harness.chips(v_g, h) IS DISTINCT FROM 1000 - v_start
     OR harness.pending(v_g, h) IS DISTINCT FROM 1
     OR (harness.evlast(v_g, 'auto_rebuy') ->> 'stack_before')::numeric IS DISTINCT FROM 0
     OR (harness.evlast(v_g, 'auto_rebuy') ->> 'stack_after_delivery')::numeric IS DISTINCT FROM v_start THEN
    RAISE EXCEPTION 'FAIL 07: the rebuy did not go through the door to the initial stack: % % wallet=%', v, to_jsonb(ps), harness.chips(v_g, h);
  END IF;
  -- ONE IN FLIGHT AT A TIME, THEN THE ENGINE DELIVERS AND THE TRIGGER RESTS.
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'PENDING_ADDON' THEN
    RAISE EXCEPTION 'FAIL 07: a second purchase rode over the pending addon: %', v;
  END IF;
  PERFORM harness.deliver(v_g, h);
  IF harness.seat_stack(v_g, h) IS DISTINCT FROM v_start THEN
    RAISE EXCEPTION 'FAIL 07: the delivery did not land the chips';
  END IF;
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'NOT_TRIGGERED' THEN
    RAISE EXCEPTION 'FAIL 07: a delivered stack still triggered: %', v;
  END IF;
  -- A HORSE AUTO-REBUYS EXACTLY AS A HUMAN.
  v_amount := harness.seat_stack(v_g, w);
  v_hand := harness.play(v_g, ARRAY[h, w],
    jsonb_build_object(w::text, jsonb_build_object('d', -v_amount, 'c', v_amount),
                       h::text, jsonb_build_object('d', v_amount, 'c', v_amount, 's', true)),
    2 * v_amount, ARRAY[h]);
  PERFORM harness.fund(v_g, w, 1000);
  v := public.fn_lightning_auto_rebuy(v_g, w);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true
     OR (harness.psrow(v_g, w)).auto_rebuys IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 07: the horse''s rebuy differs from the human''s: %', v;
  END IF;
  PERFORM harness.deliver(v_g, w);
  INSERT INTO harness.p8 (k, game, a, b) VALUES ('g:rebuy', v_g, h, w);
END $$;
\echo '  ok  07 AUTO-REBUY EXECUTES  born DISABLED; enabled, a healthy stack is NOT_TRIGGERED; a real bust at zero buys back to the starting stack through the reload door alone (club wallet debited, one pending addon, counted on the session, one auto_rebuy event with before and after); a second ask waits on the pending addon; delivered, the trigger rests; a horse rebuys exactly as a human'

-- 08 AUTO-REBUY: THE CAPS AND EVERY REFUSAL -------------------------------------------
DO $$
DECLARE v_g uuid; h uuid; w uuid; x uuid; v jsonb; v_amount numeric; v_hand uuid;
        ps public.lightning_pool_session; r jsonb; v_inst uuid; n_ev integer;
BEGIN
  SELECT game, a, b INTO v_g, h, w FROM harness.p8 WHERE k = 'g:rebuy';
  -- MAX_COUNT: one is the limit, the second ask is refused.
  PERFORM harness.cfg(v_g, '{"auto_rebuy_max_count": 1}'::jsonb);
  v_amount := harness.seat_stack(v_g, h);
  v_hand := harness.play(v_g, ARRAY[h, w],
    jsonb_build_object(h::text, jsonb_build_object('d', -v_amount, 'c', v_amount),
                       w::text, jsonb_build_object('d', v_amount, 'c', v_amount, 's', true)),
    2 * v_amount, ARRAY[w]);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'MAX_COUNT' THEN
    RAISE EXCEPTION 'FAIL 08: the count cap does not hold: %', v;
  END IF;
  PERFORM harness.cfg(v_g, '{"auto_rebuy_max_count": 5}'::jsonb);
  -- SESSION_CAP: the amount is clamped to what remains of the cap, and a
  -- spent cap refuses.
  ps := harness.psrow(v_g, h);
  PERFORM harness.cfg(v_g, jsonb_build_object('auto_rebuy_session_cap', ps.auto_rebuy_total + 40));
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true OR (v ->> 'amount')::numeric IS DISTINCT FROM 40 THEN
    RAISE EXCEPTION 'FAIL 08: the session cap did not clamp the amount to 40: %', v;
  END IF;
  PERFORM harness.deliver(v_g, h);
  -- The cap question needs a standing trigger: under below_pct 99 the
  -- delivered 40 still asks, and what remains of the cap is nothing.
  PERFORM harness.cfg(v_g, '{"auto_rebuy_trigger": "below_pct", "auto_rebuy_threshold_pct": 99}'::jsonb);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'SESSION_CAP' THEN
    RAISE EXCEPTION 'FAIL 08: a spent session cap still bought: %', v;
  END IF;
  PERFORM harness.cfg(v_g, '{"auto_rebuy_session_cap": 0}'::jsonb);
  -- RELOAD_REFUSED: an empty club wallet refuses INSIDE the door and nothing
  -- moves - no debit, no addon, no count, no event.
  PERFORM harness.fund(v_g, h, 1);
  n_ev := harness.evn(v_g, 'auto_rebuy');
  ps := harness.psrow(v_g, h);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'RELOAD_REFUSED'
     OR harness.chips(v_g, h) IS DISTINCT FROM 1
     OR harness.pending(v_g, h) IS DISTINCT FROM 0
     OR (harness.psrow(v_g, h)).auto_rebuys IS DISTINCT FROM ps.auto_rebuys
     OR harness.evn(v_g, 'auto_rebuy') <> n_ev THEN
    RAISE EXCEPTION 'FAIL 08: the wallet refusal moved something: % wallet=%', v, harness.chips(v_g, h);
  END IF;
  PERFORM harness.fund(v_g, h, 1000);
  PERFORM harness.cfg(v_g, '{"auto_rebuy_trigger": "zero"}'::jsonb);
  -- IN_HAND: between hands means between hands.
  r := harness.form(v_g, ARRAY[h, w]);
  v_inst := (r ->> 'instance_id')::uuid;
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'IN_HAND' THEN
    RAISE EXCEPTION 'FAIL 08: a player in a forming hand was topped up: %', v;
  END IF;
  PERFORM public.fn_lightning_instance_abandon(v_inst, 'fixture_abandon');
  -- RG_EXCLUDED: responsible gaming has the same last word here.
  PERFORM harness.exclude(h, clock_timestamp() + interval '1 day');
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'RG_EXCLUDED' THEN
    RAISE EXCEPTION 'FAIL 08: an excluded player was topped up: %', v;
  END IF;
  DELETE FROM public.responsible_gaming_limits WHERE user_id = h;
  -- STOP_REQUESTED: a stopping player is never topped up.
  PERFORM harness.as_user(h);
  PERFORM public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  v := public.fn_lightning_auto_rebuy(v_g, h);
  IF v ->> 'reason' IS DISTINCT FROM 'NO_SESSION' THEN
    RAISE EXCEPTION 'FAIL 08: a stopped (and so exited) session was topped up: %', v;
  END IF;
  -- STOP_REQUESTED while still open: mark a fresh player inside a hand, ask.
  x := (harness.idle(v_g, true, 1, ARRAY[w]))[1];
  r := harness.form(v_g, ARRAY[x, w]);
  PERFORM harness.as_user(x);
  PERFORM public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  v := public.fn_lightning_auto_rebuy(v_g, x);
  IF v ->> 'reason' NOT IN ('STOP_REQUESTED', 'IN_HAND') THEN
    RAISE EXCEPTION 'FAIL 08: a stop-requested session was topped up: %', v;
  END IF;
  PERFORM public.fn_lightning_instance_abandon((r ->> 'instance_id')::uuid, 'fixture_abandon');
  v := public.fn_lightning_auto_rebuy(v_g, x);
  IF v ->> 'reason' IS DISTINCT FROM 'STOP_REQUESTED' THEN
    RAISE EXCEPTION 'FAIL 08: a marked open session was topped up: %', v;
  END IF;
END $$;
\echo '  ok  08 THE CAPS AND REFUSALS  MAX_COUNT holds at the limit; the session cap clamps the amount to what remains and then refuses SESSION_CAP; an empty club wallet is RELOAD_REFUSED inside the door and nothing moves; IN_HAND between hands means between hands; RG_EXCLUDED and STOP_REQUESTED refuse; an exited stop is NO_SESSION'

-- 09 WHO MAY CALL ---------------------------------------------------------------------
DO $$
DECLARE v_g uuid; h uuid; v_err text; v jsonb; v_stranger uuid := gen_random_uuid();
BEGIN
  SELECT game, b INTO v_g, h FROM harness.p8 WHERE k = 'g:rebuy';
  SET ROLE authenticated;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_auto_rebuy(%L, %L)', v_g, h));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN
    RAISE EXCEPTION 'FAIL 09: authenticated bought chips for someone: %', v_err;
  END IF;
  SET ROLE anon;
  v_err := public.fxr_try(format('SELECT public.fn_lightning_stop_playing(%L)', v_g));
  RESET ROLE;
  IF v_err IS NULL OR v_err !~ '^42501' THEN
    RAISE EXCEPTION 'FAIL 09: anon reached the stop door: %', v_err;
  END IF;
  -- auth.uid() SCOPING: a stranger finds no session; no caller, no answer.
  PERFORM harness.as_user(v_stranger);
  v := public.fn_lightning_stop_playing(v_g);
  PERFORM harness.as_user(NULL, NULL);
  IF v ->> 'reason' IS DISTINCT FROM 'NO_SESSION' THEN
    RAISE EXCEPTION 'FAIL 09: a stranger''s stop touched a session: %', v;
  END IF;
  IF public.fn_lightning_stop_playing(v_g) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 09: a caller-less stop answered';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.fn_lightning_stop_playing(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.fn_lightning_stop_playing(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.fn_lightning_stop_playing(uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.fn_lightning_auto_rebuy(uuid,uuid,timestamp with time zone)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'FAIL 09: the grants are not one browser door and one service door';
  END IF;
END $$;
\echo '  ok  09 WHO MAY CALL  authenticated cannot reach the auto-rebuy door (42501) and anon cannot reach the stop door; a stranger''s stop is NO_SESSION and a caller-less stop is silence; the grants are one browser door (stop: authenticated and service_role) and one service door (auto-rebuy: service_role alone)'

-- 10 NON-LIGHTNING PLAY IS UNTOUCHED --------------------------------------------------
DO $$
DECLARE v_g uuid; v_u uuid := gen_random_uuid(); v jsonb; v_seat integer;
BEGIN
  -- A MUST-MOVE CLUSTER (never converted): an excluded player still takes a
  -- chair exactly as before - the pool door never runs outside Lightning -
  -- and the engine's auto-rebuy ask answers through the config, off.
  v_g := harness.c8('plain', 6, 4, 1, 3, 1);
  PERFORM harness.exclude(v_u, clock_timestamp() + interval '1 day');
  SELECT coalesce(max(ts.seat_number), 0) + 1 INTO v_seat
    FROM public.table_seats ts WHERE ts.table_id = harness.feeder(v_g);
  PERFORM public.fxr_join(v_g, harness.feeder(v_g), v_seat, 200.00, false, true, v_u);
  IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                  WHERE ts.table_id = harness.feeder(v_g) AND ts.user_id = v_u AND ts.left_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 10: the cash chair itself was refused (this file must not touch the seat door)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g) THEN
    RAISE EXCEPTION 'FAIL 10: a must-move cluster has pool sessions';
  END IF;
  v := public.fn_lightning_auto_rebuy(v_g, v_u);
  IF v ->> 'reason' IS DISTINCT FROM 'DISABLED' THEN
    RAISE EXCEPTION 'FAIL 10: auto-rebuy answered a must-move cluster with %', v;
  END IF;
  DELETE FROM public.responsible_gaming_limits WHERE user_id = v_u;
END $$;
\echo '  ok  10 NON-LIGHTNING UNTOUCHED  on a must-move cluster an excluded player still takes a cash chair exactly as before (the pool door never runs outside Lightning), no pool session exists, and the auto-rebuy ask is DISABLED'
ASSERT

cat > "$fixture/own-proofs.sql" <<'ASSERT'
-- 11 EVERY @live-proof OF THE FILE HOLDS ----------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM harness.lp8 WHERE phase = 'own') <> 18
     OR EXISTS (SELECT 1 FROM harness.lp8 WHERE phase = 'own' AND ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'FAIL 11: the file''s own proofs: %', (SELECT string_agg(n || '=' || coalesce(ok::text, 'error'), ', ') FROM harness.lp8 WHERE phase = 'own');
  END IF;
END $$;
\echo '  ok  11 THE LIVE PROOFS  all eighteen @live-proof claims of the file evaluate true against this catalogue'
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
-- 12 RE-APPLIABLE ---------------------------------------------------------------------
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
    RAISE EXCEPTION 'FAIL 12: the second application changed: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM harness.rcap WHERE what LIKE 'fn:%') < 60 THEN
    RAISE EXCEPTION 'FAIL 12: the capture is too small to prove anything';
  END IF;
END $$;
\echo '  ok  12 RE-APPLIABLE  applied a second time the file leaves every fn_lightning_ and fn_cash_cluster body, ACL and comment, the reload door, the hand, participant, pool session, instance, history, event, addon, wallet and limits row counts, every pool session row, every event row, every funded wallet, and the pool session table''s triggers and constraints exactly as they were'
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
  -f "$phase8" -f "$p7r" -f "$fix" -f "$p9d" \
  -f "$fixture/ground.sql" \
  -f "$fixture/proofs-before.sql" \
  -f "$mine" \
  -f "$fixture/proofs-after.sql" \
  -f "$fixture/assertions.sql" \
  -f "$fixture/own-proofs-eval.sql" \
  -f "$fixture/own-proofs.sql" \
  -f "$fixture/precapture.sql" \
  -f "$mine" \
  -f "$fixture/reapply.sql" 2>&1 | grep -v -E '^psql:.*: (NOTICE|WARNING):' | grep -v -E '^ lp7?8_rewrite|^ lp9_rewrite|^ lp10_rewrite|^-+$|^ *$|^\(1 row\)$' | tee "$fixture/psql.out"
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
echo "PASS: Lightning Phase 10 (spec Phases 16 and 17), 13 sections, under production's default function ACLs and its live autorevoke event trigger: before the file none of it exists; after it no predecessor proof is falsified; the seven auto-rebuy keys default off and clamp; a self-excluded human and a cooling-off horse are seated but never pooled, a lapsed exclusion enters, a mid-session exclusion is RG_EXCLUDED; the idle stop exits at once with exit_reason stop_playing and is idempotent; the mid-hand stop stands aside for the hand, is STOP_REQUESTED after it and is exited by the reaper with no player_expired record; the reconnect snapshot and session summary carry the stop and the metrics; auto-rebuy is born disabled and, enabled, buys a real bust back through the reload door alone with wallet, addon, count and event all agreeing, refusing PENDING_ADDON, MAX_COUNT, SESSION_CAP, RELOAD_REFUSED, IN_HAND, RG_EXCLUDED, STOP_REQUESTED and NO_SESSION each in its place; horses stop and rebuy exactly as humans; the grants are one browser door and one service door; non-Lightning play is untouched; every @live-proof holds and the file is re-appliable"
