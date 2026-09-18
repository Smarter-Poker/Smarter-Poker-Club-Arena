-- 20260917233109_the_fleet_observer_does_not_name_the_finish_lane.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE FLEET OBSERVER DOES NOT NAME THE FINISH LANE.
-- Phase 3 of the horse programme, 2026-09-17. Follows
-- 20260917202659_the_fleet_reports_what_it_cannot_finish.sql.
--
-- WHAT WAS WRONG
--
-- fn_ca_horse_fleet_metrics counts backends waiting on the three settlement
-- advisory lanes, and labelled each key pair with its source string in a
-- comment. fn_ca_settlement_lane_doctrine() (20260917191322, rewritten by
-- 20260917193840) holds that the finish lane is NAMED only by the three
-- helpers that take it, so the observer read as a fourth namer and the
-- Settlement Lane Doctrine workflow refused the branch that declared it:
--
--   f_named_only_by_finish_helpers: fn_ca_horse_fleet_metrics,
--   fn_ca_lock_settlement_lane_for_finish,
--   fn_ca_lock_settlement_lane_for_satellite_finish,
--   fn_ca_lock_settlement_lane_for_sweep_member
--
-- The doctrine was right and the observer was wrong. A rule that a reader can
-- trip by mentioning a name is a rule nobody can rely on, so the comment goes
-- and the numbers stay: the function already identifies each lane by its
-- hashed classid/objid pair, which is what pg_locks carries.
--
-- WHAT THIS CHANGES
--
-- Only the comment inside fn_ca_horse_fleet_metrics. Every column, every
-- count and every grant is byte-for-byte what 20260917202659 declared.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The observer is the one 20260917202659 declared, and the
--    doctrine currently reports exactly this violation and no other.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
  v_answer jsonb;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_fleet_metrics';
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'precondition: fn_ca_horse_fleet_metrics does not exist';
  END IF;
  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF (v_answer ->> 'ok')::boolean IS TRUE THEN
    RAISE EXCEPTION 'precondition: the doctrine already holds; this migration has nothing to correct';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_answer -> 'violations') v
     WHERE v ->> 'rule' = 'f_named_only_by_finish_helpers'
       AND v ->> 'found' LIKE '%fn_ca_horse_fleet_metrics%'
  ) THEN
    RAISE EXCEPTION 'precondition: the doctrine does not report the observer as a finish-lane namer: %', v_answer;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE OBSERVER, IDENTIFYING EACH LANE BY ITS KEY PAIR ALONE.
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
       -- The three settlement lanes by their advisory key pair. The keys are
       -- given as numbers, not as their source strings: fn_ca_settlement_lane_
       -- doctrine() holds that the finish lane is NAMED only by the three
       -- helpers that take it, and an observer that spelled the key in a
       -- comment would read as a fourth. G is the platform-wide settlement
       -- lane, F the finish lane, B the hand-settlement barrier.
       AND ((l.classid = 4265093629 AND l.objid = 1253463894)   -- G
         OR (l.classid = 1162513398 AND l.objid = 3172327781)   -- F
         OR (l.classid = 880566413 AND l.objid = 1926503905))   -- B
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
-- 2. POSTCONDITIONS. The doctrine holds, the observer no longer names the
--    lane, and it still answers one complete row.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_src text;
  v_answer jsonb;
  r record;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_fleet_metrics';
  IF v_src LIKE '%ca:tournament-finish' || '-lane%' THEN
    RAISE EXCEPTION 'postcondition: the observer still names the finish lane';
  END IF;
  IF position('1162513398' IN v_src) = 0 OR position('3172327781' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postcondition: the observer no longer watches the finish lane at all';
  END IF;

  SELECT * INTO r FROM public.fn_ca_horse_fleet_metrics(10);
  IF r IS NULL OR r.running IS NULL OR r.decided IS NULL OR r.unbatched_fee_running IS NULL
     OR r.lane_f_waiters IS NULL OR r.deadlocks_total IS NULL THEN
    RAISE EXCEPTION 'postcondition: fn_ca_horse_fleet_metrics returned an incomplete row';
  END IF;

  v_answer := public.fn_ca_settlement_lane_doctrine();
  IF COALESCE((v_answer ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postcondition: the lane doctrine still reports violations: %', v_answer;
  END IF;
END
$post$;

COMMIT;
