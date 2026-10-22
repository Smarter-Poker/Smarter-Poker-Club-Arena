-- 20261022041710_the_mini_jackpot_operator_rates_read_contributions_by_pool_i.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_bbj_mini_for_club was the second-longest PostgREST transaction holding
-- locks on public.clubs (and the jackpot tables) on 2026-10-22: present in
-- 40 of 150 200ms samples of live authenticator transactions older than
-- 200ms, up to 3.4 s each; pg_stat_statements: 51,774 calls, mean 897 ms.
--
-- Cause, measured on production with a club operator's claims: 3.2-3.6 s per
-- call for every Midway Union operator (0.02 s for a player). The operator
-- rate window summed the last 7 days of contributions THROUGH the view
-- ca_launch_bbj_reporting_contributions, whose launch-reset filter joins each
-- row to its pool's start by jsonb_build_object('id', pool_id). No index can
-- bound that, so every row of the window (~480,000 for the Midway pool) was
-- hashed and filtered, and when the planner merge-joined the pool CTE it
-- sorted them to disk first (1.4 s for the one sum, EXPLAIN ANALYZE).
--
-- Fix: the pool's reporting start is read once, in the pool CTE, with the
-- same function the reporting views are defined by
-- (fn_ca_launch_bbj_reporting_start, '-infinity' when the pool was never
-- reset), and every sum and count reads bbj_contributions / bbj_winners
-- directly with `created_at >= start_at` as an index bound. Same predicate,
-- same rows, same numbers: compared on production against the live function
-- for 40 clubs (operator claims) and 5 player calls, every field equal
-- except the live backup balance that moved between the two reads.
-- Operator call 3.2 s -> 0.3 s; player call unchanged (~10 ms).
--
-- Unchanged: signature, return columns, STABLE SECURITY DEFINER,
-- search_path, grants, the operator gate on every rate column, and the
-- reporting views themselves. CREATE OR REPLACE only, so this installs
-- during live play.
--
-- @live-proof: position('start_at' IN pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure))>0
-- @live-proof: position('ca_launch_bbj_reporting_contributions' IN pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure))=0

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE v text;
BEGIN
  v := md5(pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure));
  -- 83308728...: the live definition from 20261015042155 (read 2026-10-22).
  -- A definition that already bounds by start_at is this migration replayed.
  IF v <> '83308728ca2f8033dbf967a1f485f09b'
     AND position('start_at' IN pg_get_functiondef('public.fn_bbj_mini_for_club(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club preimage changed (md5 %)', v;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
 RETURNS TABLE(pool_id uuid, enabled boolean, backup_balance numeric, reserve_floor numeric, parked numeric, available numeric, tiers jsonb, hits_30d bigint, paid_30d numeric, last_hit_at timestamp with time zone, club_switch boolean, can_toggle boolean, is_union_pool boolean, in_per_day numeric, out_per_day numeric, net_per_day numeric, days_to_floor numeric, floor_minimum numeric, window_days numeric, is_operator boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH caller AS (
    /* The function names its own actor rather than deriving it a call down.
       auth.uid() IS NULL is a service-role or pre-login caller; neither is
       club staff, and neither sees the rates. */
    SELECT auth.uid() AS uid,
           (auth.uid() IS NOT NULL AND public.fn_is_club_admin_uid(p_club_id)) AS is_operator
  ),
  club AS (
    SELECT c.id, c.union_id FROM public.clubs c WHERE c.id = p_club_id
  ),
  pool AS (
    /* 2026-10-22: the pool's reporting start is read ONCE, here, and every
       sum below bounds its index range by it directly. Reading through the
       ca_launch_bbj_reporting_* views joined each contribution row to its
       pool's start by a jsonb key, which no index can bound: an operator's
       7-day rate read hashed and filtered ~480,000 Midway contribution rows
       (0.7-1.4 s, external sort when merge-joined) and held clubs, tables
       and the jackpot rows for 3-3.6 s per call. Same predicate as the view
       (created_at >= start, '-infinity' when the pool was never reset). */
    SELECT p.pool_id, p.backup_balance, p.is_union_pool,
           public.fn_ca_launch_bbj_reporting_start(p.pool_id) AS start_at
      FROM public.fn_bbj_pool_for_club(p_club_id) p
  ),
  pool_row AS (
    SELECT bp.id, COALESCE(bp.mini_reserve_floor, 0) AS reserve_floor,
           COALESCE(bp.mini_enabled, true) AS mini_enabled
      FROM public.bbj_pools bp JOIN pool ON pool.pool_id = bp.id
  ),
  parked_row AS (
    SELECT public.fn_bbj_parked_reserve(pool.pool_id, 'backup') AS parked FROM pool
  ),
  tier_rows AS (
    SELECT st.id AS tier_id, st.label, st.blind_range, st.min_bb, st.max_bb,
           mt.amount, mt.enabled,
           (pool_row.mini_enabled
            AND mt.enabled
            AND COALESCE(pool.backup_balance, 0) - parked_row.parked - mt.amount
                >= pool_row.reserve_floor) AS payable
      FROM public.bbj_stakes_tiers st
      JOIN public.bbj_mini_tiers mt ON mt.tier_id = st.id
      CROSS JOIN pool CROSS JOIN pool_row CROSS JOIN parked_row
  ),
  hits AS (
    SELECT count(*) AS n,
           COALESCE(sum(w.total_payout), 0) AS paid,
           max(w.awarded_at) AS last_at
      FROM pool JOIN public.bbj_winners w ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at >= pool.start_at
       AND w.awarded_at > now() - interval '30 days'
  ),
  win AS (
    SELECT CASE WHEN pool.start_at > '-infinity'::timestamptz THEN
      GREATEST(0.5,LEAST(7.0,extract(epoch FROM(now()-pool.start_at))/86400.0))
      ELSE GREATEST(0.5,LEAST(7.0,COALESCE(extract(epoch FROM(now()-(SELECT min(w.awarded_at) FROM public.bbj_winners w WHERE w.kind='mini')))/86400.0,7.0))) END AS days FROM pool
  ),
  flow AS (
    /* Rates are staff-only (output gate below), so only staff pay for them. */
    SELECT
      CASE WHEN caller.is_operator THEN
        COALESCE((SELECT sum(x.backup_portion) FROM public.bbj_contributions x
                  WHERE x.pool_id = pool.pool_id
                    AND x.created_at >= pool.start_at
                    AND x.created_at > now() - (win.days * interval '1 day')), 0)
          / win.days
      END AS in_day,
      CASE WHEN caller.is_operator THEN
        COALESCE((SELECT sum(w.total_payout) FROM public.bbj_winners w
                  WHERE w.pool_id = pool.pool_id
                    AND w.kind = 'mini'
                    AND w.awarded_at >= pool.start_at
                    AND w.awarded_at > now() - (win.days * interval '1 day')), 0)
          / win.days
      END AS out_day,
      win.days
      FROM pool CROSS JOIN win CROSS JOIN caller
  ),
  bound AS (
    SELECT COALESCE(max(mt.amount) FILTER (WHERE mt.enabled), 0) AS floor_min
      FROM public.bbj_mini_tiers mt
  )
  SELECT pool.pool_id,
         (pool_row.mini_enabled
          AND EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled)) AS enabled,
         /* The reserve is part of what the jackpot IS, and players are already
            told about it (BBJRulesPanel, BadBeatJackpotPage). */
         COALESCE(pool.backup_balance, 0) AS backup_balance,
         pool_row.reserve_floor,
         parked_row.parked,
         GREATEST(0, COALESCE(pool.backup_balance, 0) - parked_row.parked - pool_row.reserve_floor)
           AS available,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'tierId', tr.tier_id,
                     'label', tr.label,
                     'blindRange', tr.blind_range,
                     'minBB', tr.min_bb,
                     'maxBB', tr.max_bb,
                     'amount', tr.amount,
                     'enabled', tr.enabled,
                     'payable', tr.payable) ORDER BY tr.min_bb)
                   FROM tier_rows tr), '[]'::jsonb) AS tiers,
         hits.n AS hits_30d,
         hits.paid AS paid_30d,
         (SELECT max(w.awarded_at) FROM public.bbj_winners w
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini'
             AND w.awarded_at >= pool.start_at) AS last_hit_at,
         pool_row.mini_enabled AS club_switch,
         (club.union_id IS NULL AND COALESCE(pool.is_union_pool, false) IS NOT TRUE) AS can_toggle,
         COALESCE(pool.is_union_pool, false) AS is_union_pool,
         /* THE RATES ARE THE BUSINESS. in_per_day is a club's daily jackpot
            rake income. NULL, never zero, for anyone who may not see it. */
         CASE WHEN caller.is_operator THEN ROUND(flow.in_day, 2) END  AS in_per_day,
         CASE WHEN caller.is_operator THEN ROUND(flow.out_day, 2) END AS out_per_day,
         CASE WHEN caller.is_operator THEN ROUND(flow.in_day - flow.out_day, 2) END AS net_per_day,
         CASE WHEN caller.is_operator AND flow.out_day > flow.in_day
              THEN ROUND(
                     GREATEST(0, COALESCE(pool.backup_balance,0) - parked_row.parked
                                 - pool_row.reserve_floor)
                     / (flow.out_day - flow.in_day), 1)
              ELSE NULL END AS days_to_floor,
         CASE WHEN caller.is_operator THEN bound.floor_min END AS floor_minimum,
         CASE WHEN caller.is_operator THEN ROUND(flow.days, 2) END AS window_days,
         caller.is_operator
    FROM pool, pool_row, parked_row, hits, club, flow, bound, caller;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;

COMMIT;
