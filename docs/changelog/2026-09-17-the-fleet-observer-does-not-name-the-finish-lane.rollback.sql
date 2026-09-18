BEGIN;
-- Rollback for 20260917233109_the_fleet_observer_does_not_name_the_finish_lane.sql
-- Restores the comment that names the finish lane key, which the lane doctrine
-- refuses: running this makes the Settlement Lane Doctrine workflow go red.
-- Byte for byte from 20260917202659.
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

COMMIT;
