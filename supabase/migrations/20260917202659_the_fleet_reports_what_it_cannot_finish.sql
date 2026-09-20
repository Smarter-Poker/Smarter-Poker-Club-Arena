-- 20260917202659_the_fleet_reports_what_it_cannot_finish.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE FLEET REPORTS WHAT IT CANNOT FINISH.
-- Phase 3 of the horse programme, 2026-09-17.
--
-- WHAT WAS WRONG (measured on production 2026-09-17, 20:20 UTC)
--
-- 835 tournaments were RUNNING. 547 of them were decided: one player left
-- 'playing', the cards done, the finish refused or never asked for; the
-- oldest had been decided for nine days. 547 horses sat in those games
-- waiting to be paid. 560 could not finish because their entry fee had no
-- captured accounting batch, so fn_accounting_tournament_fee_net_plan refused
-- every attempt with tournament_fee_sources_require_reconciliation (864
-- refusals for 529 tournaments in one hour of engine log). Earlier the same
-- afternoon a lock-order change produced 1,393 deadlocks in fourteen minutes.
-- /metrics carried poker_tournaments_running and poker_tournaments_owned and
-- nothing that said how many running tournaments were already over, nothing
-- about advisory lane waiters, nothing about deadlocks. Every number above was
-- found by a person typing SQL.
--
-- WHAT THIS CHANGES
--
-- One read-only RPC, fn_ca_horse_fleet_metrics(p_decided_minutes), for the
-- engine's HorseFleetMetrics collector (server/src/services/HorseFleetMetrics.ts),
-- on the same footing as fn_tournament_metrics: the database is the only
-- thing that knows what should exist. It returns, in one row: RUNNING
-- tournaments; decided ones; decided for longer than p_decided_minutes; the
-- age of the oldest; seated horses; horses at tables of decided tournaments;
-- RUNNING tournaments whose positive fee has no captured batch; backends
-- waiting on the G, F and B settlement lanes right now and the longest such
-- wait; and pg_stat_database.deadlocks for this database.
--
-- Cost: 110 ms warm, 3.1 s on a cold cache, measured 2026-09-17 20:23 UTC in
-- a rolled-back transaction. The collector reads it once a minute through
-- PostgREST as service_role, under that role's 8 s statement timeout.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITION. Nothing by this name exists yet.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_fleet_metrics') THEN
    RAISE EXCEPTION 'precondition: fn_ca_horse_fleet_metrics already exists; read it before replacing it';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE READ.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_horse_fleet_metrics(p_decided_minutes integer DEFAULT 10)
 RETURNS TABLE(
   running integer,
   decided integer,
   decided_over_minutes integer,
   oldest_decided_minutes integer,
   horses_seated integer,
   horses_in_decided integer,
   unbatched_fee_running integer,
   lane_g_waiters integer,
   lane_f_waiters integer,
   lane_b_waiters integer,
   lane_waiters_oldest_ms integer,
   deadlocks_total bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_minutes integer := LEAST(1440, GREATEST(1, COALESCE(p_decided_minutes, 10)));
BEGIN
  RETURN QUERY
  WITH decided AS (
    -- A RUNNING tournament with at most one player still 'playing' has been
    -- decided by the cards; everything after that is settlement, and a horse
    -- seated there is committed to a game nothing can happen in.
    SELECT t.id, t.updated_at
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.status = 'playing') <= 1
  ),
  lanes AS (
    SELECT l.classid, l.objid, l.pid
      FROM pg_catalog.pg_locks l
     WHERE l.locktype = 'advisory' AND NOT l.granted
       AND ((l.classid = 4265093629 AND l.objid = 1253463894)   -- G ca:tournament-terminal-settlement:v1
         OR (l.classid = 1162513398 AND l.objid = 3172327781)   -- F ca:tournament-finish-lane:v1
         OR (l.classid = 880566413 AND l.objid = 1926503905))   -- B ca:hand-settlement-barrier:v1
  )
  SELECT
    (SELECT count(*) FROM public.tournaments t WHERE t.status = 'RUNNING')::int,
    (SELECT count(*) FROM decided)::int,
    (SELECT count(*) FROM decided d WHERE d.updated_at < statement_timestamp() - make_interval(mins => v_minutes))::int,
    COALESCE((SELECT floor(extract(epoch FROM (statement_timestamp() - min(d.updated_at))) / 60) FROM decided d), 0)::int,
    (SELECT count(*) FROM public.table_seats s WHERE s.left_at IS NULL AND s.horse_id IS NOT NULL)::int,
    (SELECT count(*) FROM public.table_seats s
       JOIN public.tables tb ON tb.id = s.table_id
      WHERE s.left_at IS NULL AND s.horse_id IS NOT NULL
        AND tb.tournament_id IN (SELECT d.id FROM decided d))::int,
    -- A RUNNING tournament holding a positive tournament fee with no captured
    -- accounting batch cannot finish: fn_accounting_tournament_fee_net_plan
    -- refuses it with tournament_fee_sources_require_reconciliation.
    (SELECT count(DISTINCT rr.tournament_id)
       FROM public.rake_records rr
       JOIN public.tournaments t ON t.id = rr.tournament_id AND t.status = 'RUNNING'
       LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id = rr.id
      WHERE rr.is_tournament AND rr.rake_amount > 0
        AND b.status IS DISTINCT FROM 'captured')::int,
    (SELECT count(*) FROM lanes l WHERE l.classid = 4265093629)::int,
    (SELECT count(*) FROM lanes l WHERE l.classid = 1162513398)::int,
    (SELECT count(*) FROM lanes l WHERE l.classid = 880566413)::int,
    COALESCE((SELECT max(floor(extract(epoch FROM (clock_timestamp() - a.query_start)) * 1000))
                FROM lanes l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid), 0)::int,
    (SELECT d.deadlocks FROM pg_catalog.pg_stat_database d WHERE d.datname = current_database());
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_horse_fleet_metrics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_fleet_metrics(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. POSTCONDITIONS. It answers one complete row, and only the engine role
--    may ask.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.fn_ca_horse_fleet_metrics(10);
  IF r IS NULL OR r.running IS NULL OR r.decided IS NULL OR r.decided_over_minutes IS NULL
     OR r.oldest_decided_minutes IS NULL OR r.horses_seated IS NULL OR r.horses_in_decided IS NULL
     OR r.unbatched_fee_running IS NULL OR r.lane_g_waiters IS NULL OR r.lane_f_waiters IS NULL
     OR r.lane_b_waiters IS NULL OR r.lane_waiters_oldest_ms IS NULL OR r.deadlocks_total IS NULL THEN
    RAISE EXCEPTION 'postcondition: fn_ca_horse_fleet_metrics returned an incomplete row';
  END IF;
  IF r.decided > r.running OR r.decided_over_minutes > r.decided OR r.horses_in_decided > r.horses_seated THEN
    RAISE EXCEPTION 'postcondition: fn_ca_horse_fleet_metrics counts are inconsistent (%)', r;
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_horse_fleet_metrics(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_horse_fleet_metrics(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondition: browser roles can execute fn_ca_horse_fleet_metrics';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_horse_fleet_metrics(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondition: service_role cannot execute fn_ca_horse_fleet_metrics';
  END IF;
END
$post$;

COMMIT;
