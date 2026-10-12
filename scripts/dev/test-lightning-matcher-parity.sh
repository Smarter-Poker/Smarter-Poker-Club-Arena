#!/usr/bin/env bash
# Lightning Phase 11 remediation: the TypeScript matcher port is the SQL plan.
#
# Proves, on Postgres 17, socket only, on port 55563 (LIGHTNING_PARITY_PORT
# overrides it), that the engine's TypeScript port of the live matcher
# (server/src/lightning/LightningMatcherModel.ts, registered as `m1-port`
# and `m1`) decides EXACTLY what the real fn_lightning_match_plan decides on
# the same snapshot: the same groups in the same order, every group's
# players in the same seat order, the same big blind, small blind and
# button, the same legal count and the same pool diversity score. The shadow
# comparison is only meaningful if this holds (Phase 11 review finding 4).
#
# THE CHAIN IS THE REAL ONE: every Lightning migration from 20260920172736
# through Phase 11 (20261008161509), the Phase 12 files 20261009143757,
# 20261009144343 and 20261009151825 (production carries all of them), in
# order, on the ground the earlier harnesses already prove (read from them,
# so the three can never drift): the Phase 11 harness's ground (production's
# default function privileges and its live trg_autorevoke_privileged_anon
# event trigger, the reload door stand-in, the Cluster builder), the Phase 12
# operator harness's ground (production's operator gate and the managed cron
# API), and the Phase 12 load harness's rig (lc.build, lc.arrive). Every
# Cluster is converted ON by the real drive; every history hand is formed by
# the real fn_lightning_match_and_form (each group stamped its own
# microsecond) or the real barrier, dealt by the real begin_dealing,
# numbered by the real bind and settled by the real settlement. The rows the
# harness writes itself are fixture boundaries only, each named where it is
# written: arrivals at the seat, the engine's lease, and time travel on the
# queue keys (idle_since, pool entry, the slot's opening, the Cluster join,
# last_bb_at) and on blind debt, to force the ties each fixture is about.
#
# THE FIXTURES: ties on idle_since and pool entry (the Cluster join and the
# slot's opening decide), blind debt with tied debt ages, several groups per
# pass, the thin, medium and large diversity bands with real history, the
# big_blind first-entry rule with newcomers, nine-handed tables, two hands
# formed at one instant (the window's hand_id tie-break), and a reverted and
# reconverted Cluster (the window's epoch filter). For each one, in ONE
# statement, the harness records the snapshot fn_lightning_match_plan reads
# (fn_lightning_player_legality's own answer and the raw queue keys) and the
# plan itself; server/src/lightning/__tests__/lightningMatcherParity.ts then
# runs the TypeScript port on that snapshot and compares.
#
# LAW 10.5. Horses sit beside humans in every Cluster (the fixtures' mix,
# and every second arrival is a horse); nothing here reads is_horse or
# horse_id, and neither does the port.
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
port=${LIGHTNING_PARITY_PORT:-55563}
M=$root/supabase/migrations
F=$root/scripts/dev/fixtures
p11_harness=$root/scripts/dev/test-lightning-phase11-integrity-shadow.sh
ops_harness=$root/scripts/dev/test-lightning-phase12-operator-alerts.sh
load_harness=$root/scripts/dev/test-lightning-phase12-load-chaos.sh
parity_ts=$root/server/src/lightning/__tests__/lightningMatcherParity.ts
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
for f in "$base_fixture" "$pop_fixture" "$p5_fixture" "$p9_fixture" "$r2_fixture" "$p6_fixture" "$s6_fixture" \
         "$phase2" "$phase2r" "$phase3" "$phase3r" "$phase4" "$phase4r" \
         "$phase5" "$phase5r" "$phase9" "$phase9r" "$r2a" "$r2b" "$r2c" "$r2d" "$p6" "$s6" "$s6r" "$p7" \
         "$phase8" "$p7r" "$fix" "$p9d" "$p10" "$p9r2" "$p11" "$p12rg" "$p12ops" "$p12lc" \
         "$p11_harness" "$ops_harness" "$load_harness" "$parity_ts"; do
  [ -f "$f" ] || { echo "FAIL: missing input $f"; exit 1; }
done
[ -x "$root/server/node_modules/.bin/tsx" ] || [ -d "$root/server/node_modules/tsx" ] \
  || { echo "FAIL: server/node_modules/tsx is missing (npm ci in server/)"; exit 1; }
fixture=$(mktemp -d "${TMPDIR:-/tmp}/lightning-parity.XXXXXX")
sock=$fixture/s
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true; fi
  if [ -n "${LIGHTNING_PARITY_KEEP:-}" ]; then echo "kept $fixture"; else rm -rf "$fixture"; fi
}
trap cleanup EXIT
mkdir "$sock"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w \
  -o "-k $sock -p $port -h '' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_locks_per_transaction=256 -c log_min_messages=fatal" start >/dev/null
started=1
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$sock" -p "$port" -d postgres)
Q() { "${PSQL[@]}" -At -c "$1"; }

# THE GROUNDS, read from the harnesses that prove them: everything between
# each ground heredoc's opening line and its closing ASSERT.
heredoc() { # harness file-name
  awk -v name="$2" '$0 == "cat > \"$fixture/" name "\" <<'"'"'ASSERT'"'"'" {f=1; next} f && /^ASSERT$/ {exit} f' "$1"
}
heredoc "$p11_harness" ground.sql > "$fixture/p11-ground.sql"
# (Its section 00 asserts that file's own absence; the Phase 11 ground's
# section 00 already proved the creation environment, so it is cut.)
heredoc "$ops_harness" ground12.sql | sed '/^-- 00 THE GROUND, THE FILE IS ABSENT/,$d' > "$fixture/ops-ground.sql"
heredoc "$load_harness" ground.sql > "$fixture/lc-ground.sql"
grep -q 'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon' "$fixture/p11-ground.sql" \
  && grep -q 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role' "$fixture/p11-ground.sql" \
  && grep -q 'CREATE FUNCTION harness.c8' "$fixture/p11-ground.sql" \
  && grep -q 'CREATE FUNCTION harness.settle' "$fixture/p11-ground.sql" \
  || { echo "FAIL: the Phase 11 harness's ground could not be read"; exit 1; }
grep -q 'CREATE OR REPLACE FUNCTION cron.schedule' "$fixture/ops-ground.sql" \
  && grep -q 'CREATE OR REPLACE FUNCTION public.fn_ca_can_review_integrity' "$fixture/ops-ground.sql" \
  || { echo "FAIL: the Phase 12 operator harness's ground could not be read"; exit 1; }
grep -q 'CREATE FUNCTION lc.build' "$fixture/lc-ground.sql" \
  && grep -q 'CREATE FUNCTION lc.arrive' "$fixture/lc-ground.sql" \
  || { echo "FAIL: the Phase 12 load harness's rig could not be read"; exit 1; }

cat > "$fixture/parity.sql" <<'ASSERT'
-- ===========================================================================
-- THE PARITY RIG. Schema pp. Every economic action goes through the
-- production door; the writes here are fixture boundaries (named).
-- ===========================================================================
CREATE SCHEMA pp;
CREATE TABLE pp.out (n serial PRIMARY KEY, name text UNIQUE NOT NULL, discriminates boolean NOT NULL, doc jsonb NOT NULL);
CREATE TABLE pp.cl (k text PRIMARY KEY, game uuid NOT NULL);

-- A timestamp in epoch microseconds, exactly.
CREATE FUNCTION pp.us(t timestamptz) RETURNS bigint LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE (extract(epoch FROM t) * 1000000)::bigint END;
$f$;

-- THE TERMINAL PATH of one formed hand: the real begin_dealing and bind,
-- then the real settlement (nobody wins or loses a chip).
CREATE FUNCTION pp.finish(p_game uuid, p_inst uuid, p_hand uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  PERFORM harness.deal(p_inst);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  v := harness.settle(p_hand, gen_random_uuid(), harness.results(p_hand, '{}'::jsonb), 0, 0,
         jsonb_build_object('pot_size', 0, 'actions', '[]'::jsonb, 'game_variant', 'nlh', 'winners', '[]'::jsonb));
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the settlement refused hand %: %', p_hand, v;
  END IF;
END $f$;

-- ONE REAL MATCHER PASS and the real terminal path for every hand it formed.
CREATE FUNCTION pp.cycle(p_game uuid) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE r jsonb; h jsonb; n integer := 0;
BEGIN
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(p_game), true);
  r := public.fn_lightning_match_and_form(p_game, clock_timestamp(), NULL, NULL, gen_random_uuid());
  IF (r ->> 'ok')::boolean IS DISTINCT FROM true OR coalesce((r ->> 'formed')::integer, 0) = 0 THEN
    RAISE EXCEPTION 'FIXTURE: the pass formed nothing: %', r;
  END IF;
  FOR h IN SELECT x FROM jsonb_array_elements(r -> 'hands') x LOOP
    PERFORM pp.finish(p_game, (h ->> 'instance_id')::uuid, (h ->> 'hand_id')::uuid);
    n := n + 1;
  END LOOP;
  RETURN n;
END $f$;

-- A HAND FORMED BY THE REAL BARRIER at a stated instant (two engine nodes
-- forming at one microsecond), then finished.
CREATE FUNCTION pp.form_at(p_game uuid, p_players uuid[], p_at timestamptz) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := public.fn_lightning_form_hand(p_game, p_players,
         p_target_size => cardinality(p_players)::smallint, p_max_size => cardinality(p_players)::smallint,
         p_now => p_at, p_matcher_version => 'm1', p_request_id => gen_random_uuid());
  IF (v ->> 'formed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: the barrier did not form % players: %', cardinality(p_players), v;
  END IF;
  PERFORM pp.finish(p_game, (v ->> 'instance_id')::uuid, (v ->> 'hand_id')::uuid);
  RETURN (v ->> 'hand_id')::uuid;
END $f$;

-- A CLUSTER of humans and horses at the population, history from p_cycles
-- real passes. The lc rig's builder; its scenario names it.
CREATE FUNCTION pp.cluster(p_k text, p_handed integer, p_pop integer, p_cycles integer, p_cfg jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_g uuid; i integer;
BEGIN
  v_g := lc.build('parity', p_k, p_handed, p_pop, 1, 'nlh', p_cfg);
  FOR i IN 1 .. p_cycles LOOP PERFORM pp.cycle(v_g); END LOOP;
  INSERT INTO pp.cl (k, game) VALUES (p_k, v_g);
  RETURN v_g;
END $f$;
CREATE FUNCTION pp.g(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT game FROM pp.cl WHERE k = p_k; $f$;

-- THE SNAPSHOT AND THE PLAN, IN ONE STATEMENT (one snapshot of the data):
-- every open-pool player as fn_lightning_player_legality answers, with the
-- raw keys the plan reads (the slot's idle_since, opening and last_bb_at,
-- the pool session's entry, the cash session's opening, the blind ledger's
-- obligations, debt age and position counts), every hand of the Cluster
-- (every epoch) with its players, the config row, the epoch, the plan's now
-- and the real plan. Returns the plan.
CREATE FUNCTION pp.capture(p_name text, p_game uuid, p_discriminates boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_now timestamptz := clock_timestamp(); v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'name', p_name,
    'config', public.fn_lightning_config(p_game),
    'now_us', pp.us(v_now),
    'epoch', (SELECT cg.cluster_epoch FROM public.cash_games cg WHERE cg.id = p_game),
    'players', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'player_id', l.player_id, 'legal', l.legal, 'reason_code', l.reason_code,
        'idle_since_us', pp.us(sl.idle_since), 'entered_at_us', pp.us(ps.entered_at),
        'joined_at_us', pp.us(cps.opened_at), 'slot_opened_us', pp.us(sl.opened_at),
        'last_bb_at_us', pp.us(sl.last_bb_at),
        'bb_unresolved', coalesce(bl.missed_bb_debt, 0) > 0 OR coalesce(bl.bb_owed, 0) > 0,
        'debt_since_us', pp.us(coalesce(bl.debt_since, sl.opened_at)),
        'hands_since_bb', sl.hands_since_bb, 'newcomer', bl.player_id IS NULL,
        'btn', coalesce(bl.btn_count, 0), 'co', coalesce(bl.co_count, 0),
        'hj', coalesce(bl.hj_count, 0), 'utg', coalesce(bl.utg_count, 0)) ORDER BY l.player_id), '[]'::jsonb)
        FROM public.fn_lightning_player_legality(p_game, v_now, NULL, NULL) l
        JOIN public.lightning_pool_session ps ON ps.id = l.pool_session_id
        LEFT JOIN public.lightning_pool_slot sl ON sl.id = l.pool_slot_id
        LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
        LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id = p_game AND bl.player_id = l.player_id),
    -- Every hand, largest id first: an order the plan's window must not depend on.
    'hands', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'hand_id', h.hand_id, 'formed_at_us', pp.us(h.formed_at), 'epoch', h.cluster_epoch,
        'players', (SELECT jsonb_agg(hp.player_id ORDER BY hp.seat) FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id))
        ORDER BY h.hand_id DESC), '[]'::jsonb)
        FROM public.lightning_hand h WHERE h.cluster_id = p_game),
    'plan', public.fn_lightning_match_plan(p_game, v_now, NULL, NULL, NULL, NULL))
    INTO v;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'players') p
              WHERE (p ->> 'legal')::boolean AND (p ->> 'idle_since_us' IS NULL OR p ->> 'slot_opened_us' IS NULL)) THEN
    RAISE EXCEPTION 'FIXTURE %: a legal player without a slot key', p_name;
  END IF;
  IF jsonb_array_length(v -> 'plan' -> 'groups') = 0 THEN
    RAISE EXCEPTION 'FIXTURE %: the plan formed nothing, so parity would be vacuous', p_name;
  END IF;
  INSERT INTO pp.out (name, discriminates, doc) VALUES (p_name, p_discriminates, v);
  RETURN v -> 'plan';
END $f$;

-- Facts of a plan.
CREATE FUNCTION pp.band(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT p -> 'groups' -> 0 -> 'keys' -> 'p5' ->> 'band'; $f$;
CREATE FUNCTION pp.moved(p jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(sum((g -> 'keys' -> 'p5' ->> 'moved_here')::integer), 0)::integer FROM jsonb_array_elements(p -> 'groups') g;
$f$;
CREATE FUNCTION pp.ngroups(p jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT jsonb_array_length(p -> 'groups'); $f$;
CREATE FUNCTION pp.horses(p_game uuid) RETURNS integer LANGUAGE sql STABLE AS $f$
  SELECT count(*)::integer FROM public.lightning_pool_session ps JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
   WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL AND ts.horse_id IS NOT NULL;
$f$;
CREATE FUNCTION pp.open_players(p_game uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT coalesce(array_agg(ps.player_id ORDER BY ps.player_id), ARRAY[]::uuid[])
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL;
$f$;
\echo '  ok  01 THE RIG  snapshot capture, real passes, the real barrier at a stated instant'

-- 02 TIES: idle_since and pool entry tied, the Cluster join and the slot's
-- opening decide P4 and P2 (thin band: P4 alone places every seat).
DO $$
DECLARE v_g uuid; v_t timestamptz; p jsonb;
BEGIN
  v_g := pp.cluster('TIES', 6, 16, 2);
  v_t := clock_timestamp() - interval '1 minute';
  -- TIME TRAVEL (fixture boundary): one idle_since, one pool entry; the
  -- Cluster join against the id order; the slot's opening against it too;
  -- one last_bb_at for everyone; four players owing a big blind since one
  -- instant, so the slot's opening (P2's fourth key) orders them.
  UPDATE public.cash_player_session c SET opened_at = v_t - interval '2 hours' + (r.rk * interval '1 millisecond')
    FROM (SELECT ps.cash_player_session_id AS id, row_number() OVER (ORDER BY ps.player_id DESC) AS rk
            FROM public.lightning_pool_session ps WHERE ps.cluster_id = v_g AND ps.exited_at IS NULL) r
   WHERE c.id = r.id;
  UPDATE public.lightning_pool_session SET entered_at = v_t - interval '1 hour' WHERE cluster_id = v_g AND exited_at IS NULL;
  UPDATE public.lightning_pool_slot sl
     SET opened_at = v_t - interval '50 minutes' + (r.rk * interval '1 microsecond'),
         idle_since = v_t, last_bb_at = v_t - interval '30 seconds'
    FROM (SELECT id, row_number() OVER (ORDER BY player_id DESC) AS rk FROM public.lightning_pool_slot
           WHERE cluster_id = v_g AND closed_at IS NULL) r
   WHERE sl.id = r.id;
  UPDATE public.lightning_blind_ledger SET missed_bb_debt = 1, debt_since = v_t - interval '40 minutes'
   WHERE cluster_id = v_g AND player_id IN (SELECT player_id FROM public.lightning_pool_slot
                                             WHERE cluster_id = v_g AND closed_at IS NULL ORDER BY player_id LIMIT 4);
  p := pp.capture('ties on idle_since and pool entry, the join and the slot decide (thin band, 6-max, 16)', v_g, true);
  IF pp.band(p) IS DISTINCT FROM 'thin' OR pp.ngroups(p) < 3 OR pp.horses(v_g) = 0 THEN
    RAISE EXCEPTION 'FAIL 02: the fixture is not a thin multi-group pool of humans and horses: % groups, band %', pp.ngroups(p), pp.band(p);
  END IF;
END $$;
\echo '  ok  02 TIES  idle_since and pool entry tied for every player; the Cluster join and the slot''s opening ordered against the id order; four debtors with one debt age; the plan captured'

-- 03 DEBT: unresolved obligations of different ages, medium band, history.
DO $$
DECLARE v_g uuid; p jsonb; v_t timestamptz := clock_timestamp();
BEGIN
  v_g := pp.cluster('DEBT', 6, 30, 3);
  UPDATE public.lightning_blind_ledger bl SET missed_bb_debt = 1, debt_since = v_t - (r.rk * interval '7 seconds')
    FROM (SELECT player_id, row_number() OVER (ORDER BY player_id) AS rk FROM public.lightning_blind_ledger
           WHERE cluster_id = v_g ORDER BY player_id LIMIT 3) r
   WHERE bl.cluster_id = v_g AND bl.player_id = r.player_id;
  UPDATE public.lightning_blind_ledger SET bb_owed = 1
   WHERE cluster_id = v_g AND player_id = (SELECT player_id FROM public.lightning_blind_ledger WHERE cluster_id = v_g
                                            ORDER BY player_id DESC LIMIT 1);
  p := pp.capture('blind debt of four ages, medium band (6-max, 30, three passes of history)', v_g);
  IF pp.band(p) IS DISTINCT FROM 'medium' OR pp.ngroups(p) < 5 THEN
    RAISE EXCEPTION 'FAIL 03: not a medium pool of five or more groups: % %', pp.band(p), pp.ngroups(p);
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p -> 'groups') g WHERE (g -> 'keys' -> 'p2' ->> 'bb_unresolved')::boolean) < 4 THEN
    RAISE EXCEPTION 'FAIL 03: the debtors are not the first big blinds';
  END IF;
END $$;
\echo '  ok  03 DEBT  three missed big blinds of three ages and one owed big blind lead P2; medium band, history from three real passes'

-- 04 LARGE: many groups, the large band with real history, P5 moving seats.
DO $$
DECLARE v_g uuid; p jsonb;
BEGIN
  v_g := pp.cluster('LARGE', 6, 60, 4);
  p := pp.capture('large band with real history: P5 moves seats (6-max, 60, four passes)', v_g);
  IF pp.band(p) IS DISTINCT FROM 'large' OR pp.ngroups(p) < 10 OR pp.moved(p) = 0 THEN
    RAISE EXCEPTION 'FAIL 04: P5 is not exercised: band % groups % moved %', pp.band(p), pp.ngroups(p), pp.moved(p);
  END IF;
END $$;
\echo '  ok  04 LARGE  ten or more groups in one pass, the large band, and P5 moving players away from repeated pairs'

-- 05 NINE-HANDED, medium band.
DO $$
DECLARE v_g uuid; p jsonb;
BEGIN
  v_g := pp.cluster('NINE', 9, 40, 3);
  p := pp.capture('nine-handed, medium band (9-max, 40, three passes)', v_g);
  IF pp.ngroups(p) < 4 THEN RAISE EXCEPTION 'FAIL 05: % groups', pp.ngroups(p); END IF;
END $$;
\echo '  ok  05 NINE  nine-handed sizing, seats 3 to 9 by P3'

-- 06 FIRST ENTRY: the big_blind rule, newcomers held for the big blind.
DO $$
DECLARE v_g uuid; p jsonb; i integer;
BEGIN
  -- Six passes of history: every one of the twenty has paid a big blind, so
  -- the newcomers (never paid one) lead P2.
  v_g := pp.cluster('FIRST', 6, 20, 6, '{"first_entry_rule": "big_blind"}'::jsonb);
  -- ARRIVALS (fixture boundary): ten newcomers, every second a horse - more
  -- than the pass has big blinds, and holding the rest costs no hand.
  SET CONSTRAINTS ALL DEFERRED;
  FOR i IN 1 .. 10 LOOP PERFORM lc.arrive(v_g, i % 2 = 0); END LOOP;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM public.fx9_pool(v_g);
  p := pp.capture('first-entry rule big_blind with ten newcomers (6-max, 30)', v_g);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'diagnosis') d WHERE d ->> 'reason_code' = 'FIRST_ENTRY_WAITS_FOR_BB') THEN
    RAISE EXCEPTION 'FAIL 06: no newcomer was held for the big blind, so the rule is not exercised: %', p -> 'diagnosis';
  END IF;
END $$;
\echo '  ok  06 FIRST ENTRY  newcomers not yet in the ledger wait for the big blind while holding them costs the pass no hand'

-- 07 THIN: a pool thinned after conversion, above the off threshold.
DO $$
DECLARE v_g uuid; p jsonb;
BEGIN
  v_g := pp.cluster('THIN', 6, 14, 3);
  p := pp.capture('thin band below the on threshold (6-max, 14, three passes)', v_g);
  IF pp.band(p) IS DISTINCT FROM 'thin' THEN RAISE EXCEPTION 'FAIL 07: band %', pp.band(p); END IF;
END $$;
\echo '  ok  07 THIN  a thin pool between the off and on thresholds, P5 off'

-- 08 ONE INSTANT, TWO HANDS: the window's hand_id tie-break decides which is
-- remembered (the window holds one hand; the large band reads it).
DO $$
DECLARE v_g uuid; p jsonb; v_t timestamptz; v_pl uuid[]; v_a uuid; v_b uuid;
BEGIN
  v_g := pp.cluster('INSTANT', 6, 60, 2, '{"recent_opponent_window_hands": 1}'::jsonb);
  v_pl := public.fx9_candidates(v_g);
  v_t := clock_timestamp();
  v_a := pp.form_at(v_g, v_pl[1:6], v_t);
  v_b := pp.form_at(v_g, v_pl[7:12], v_t);
  IF (SELECT count(DISTINCT formed_at) FROM public.lightning_hand WHERE hand_id IN (v_a, v_b)) <> 1 THEN
    RAISE EXCEPTION 'FAIL 08: the two hands were not formed at one instant';
  END IF;
  p := pp.capture('two hands formed at one instant, a one-hand window (6-max, 60)', v_g, true);
  IF pp.band(p) IS DISTINCT FROM 'large' THEN RAISE EXCEPTION 'FAIL 08: band %', pp.band(p); END IF;
END $$;
\echo '  ok  08 ONE INSTANT  two hands formed by the real barrier at one microsecond; the window''s hand_id order decides which it holds'

-- 09 A NEW EPOCH: the Cluster reverted to must move and converted again, so
-- every remembered hand is of the old epoch and outside P5's window.
DO $$
DECLARE v_g uuid; p jsonb; v_req uuid := gen_random_uuid(); v jsonb; v_e integer;
BEGIN
  v_g := pp.cluster('EPOCH', 6, 60, 3);
  v_e := (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g);
  -- DEPARTURES (fixture boundary): the pool drains below the off threshold,
  -- the real reversion runs, the players come back and the real drive
  -- converts the Cluster again.
  PERFORM harness.leave(v_g, 49);
  v := public.fn_cash_cluster_begin_pending_off(v_g, v_req, 'parity: a new epoch');
  IF v ->> 'reason' = 'off_condition_dwell' THEN
    -- TIME TRAVEL (fixture boundary): the off condition has held its dwell.
    UPDATE public.cash_games SET lightning_off_condition_since = clock_timestamp() - interval '1 hour' WHERE id = v_g;
    v := public.fn_cash_cluster_begin_pending_off(v_g, v_req, 'parity: a new epoch');
  END IF;
  IF (v ->> 'ok')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: pending_off refused: %', v; END IF;
  v := public.fn_cash_cluster_commit_must_move(v_g, v_req);
  IF (v ->> 'reverted')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FIXTURE: the reversion refused: %', v; END IF;
  PERFORM lc.arrive_many(v_g, 49);
  PERFORM harness.drive(v_g);
  -- THE ENGINE ACKNOWLEDGES THE HALT (fixture boundary: each table's engine
  -- does this in production), then the drive commits.
  UPDATE public.tables tb SET dealing_halt_observed_at = clock_timestamp()
   WHERE tb.cluster_id = v_g AND tb.dealing_halted_at IS NOT NULL
     AND (tb.dealing_halt_observed_at IS NULL OR tb.dealing_halt_observed_at < tb.dealing_halted_at);
  PERFORM harness.drive(v_g);
  IF harness.mode(v_g) IS DISTINCT FROM 'lightning' THEN RAISE EXCEPTION 'FIXTURE: EPOCH did not convert again'; END IF;
  PERFORM public.fx9_pool(v_g);
  PERFORM public.fxr_lease(public.fn_cash_cluster_front_table(v_g), true);
  IF (SELECT cluster_epoch FROM public.cash_games WHERE id = v_g) <= v_e
     OR NOT EXISTS (SELECT 1 FROM public.lightning_hand WHERE cluster_id = v_g AND cluster_epoch = v_e) THEN
    RAISE EXCEPTION 'FIXTURE: no hand of an earlier epoch to filter';
  END IF;
  p := pp.capture('drained, reverted and reconverted: every remembered hand is of the old epoch (6-max, 60)', v_g);
  IF pp.band(p) IS DISTINCT FROM 'large' OR pp.moved(p) <> 0 THEN
    RAISE EXCEPTION 'FAIL 09: the old epoch''s hands reached P5 (moved %)', pp.moved(p);
  END IF;
END $$;
\echo '  ok  09 A NEW EPOCH  a real reversion and reconversion; the old epoch''s hands are outside P5''s window'
ASSERT

chain=(-f "$base_fixture" -f "$pop_fixture" -f "$p5_fixture"
  -f "$phase2" -f "$phase2r" -f "$phase3" -f "$phase3r" -f "$phase4" -f "$phase4r" -f "$phase5" -f "$phase5r"
  -f "$p9_fixture" -f "$phase9" -f "$phase9r" -f "$r2_fixture"
  -f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture" -f "$p6" -f "$s6_fixture" -f "$s6" -f "$s6r" -f "$p7"
  -f "$phase8" -f "$p7r" -f "$fix" -f "$p9d" -f "$p10" -f "$p9r2"
  -f "$fixture/p11-ground.sql" -f "$p11" -f "$p12rg" -f "$fixture/ops-ground.sql" -f "$p12ops" -f "$p12lc"
  -f "$fixture/lc-ground.sql" -f "$fixture/parity.sql")
set +e
"${PSQL[@]}" "${chain[@]}" > "$fixture/build.out" 2>&1
status=$?
set -e
grep -E '^  ok  ' "$fixture/build.out" | grep -v -E '^  ok  00 ' || true
if [ "$status" != 0 ]; then
  grep -v -E 'NOTICE|^ *$' "$fixture/build.out" | tail -20
  echo "FAIL: the chain or a fixture did not build (psql exited $status)"
  exit 1
fi
oks=$(grep -c -E '^  ok  0[1-9] ' "$fixture/build.out" || true)
[ "$oks" = 9 ] || { echo "FAIL: $oks of the 9 sections reported"; exit 1; }
n=$(Q "SELECT count(*) FROM pp.out")
Q "SELECT jsonb_build_object('fixtures', jsonb_agg(doc || jsonb_build_object('discriminates', discriminates) ORDER BY n)) FROM pp.out" > "$fixture/fixtures.json"
groups=$(Q "SELECT sum(jsonb_array_length(doc -> 'plan' -> 'groups')) FROM pp.out")
players=$(Q "SELECT sum(jsonb_array_length(doc -> 'players')) FROM pp.out")
horses=$(Q "SELECT sum(pp.horses(game)) FROM pp.cl")

# THE TYPESCRIPT PORT ON THE SAME SNAPSHOTS.
set +e
(cd "$root/server" && node --import tsx src/lightning/__tests__/lightningMatcherParity.ts "$fixture/fixtures.json") > "$fixture/parity.out" 2>&1
status=$?
set -e
cat "$fixture/parity.out"
if [ "$status" != 0 ]; then
  echo "FAIL: the TypeScript port and fn_lightning_match_plan disagree (exit $status)"
  exit 1
fi
grep -q "^PARITY $n fixtures $groups groups identical" "$fixture/parity.out" \
  || { echo "FAIL: the parity check did not cover every fixture and group ($n fixtures, $groups groups)"; exit 1; }
grep -q '^DISCRIMINATES ' "$fixture/parity.out" \
  || { echo "FAIL: the pre-remediation port was not shown to differ on the tie fixtures"; exit 1; }
echo "PASS: the TypeScript matcher port (m1-port and m1) decides exactly what the real fn_lightning_match_plan decides, on PostgreSQL 17 over the real Lightning chain through 20261009151825 under production's default ACLs and autorevoke trigger: $n fixtures ($players open-pool players, $horses of them horses at capture), $groups groups, every group's seats, big blind, small blind and button identical, the same legal count and pool diversity score - ties on idle_since and pool entry, blind debt, several groups per pass, the thin, medium and large bands, the first-entry rule, nine-handed tables, two hands at one instant and a new epoch; and the port without the remediation's keys (the Cluster join, the slot's opening, the hand ids) is shown to differ on the two tie fixtures"
