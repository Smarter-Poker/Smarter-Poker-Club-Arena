-- 20261015042155_the_mini_jackpot_read_answers_players_in_milliseconds.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-14: "THE 'MINI' BBJ AMOUNT SHOULD BE DISPLAYED UNDER THE BBJ."
-- The client already draws a MINI BBJ row under the plate (BadBeatJackpot.tsx,
-- .bbj-mini-plate). It never appeared because its feed,
-- fn_bbj_mini_for_club, has failed for every player since 2026-10-12:
-- PostgREST returned HTTP 500 on every poll (seen live from the table page),
-- because one call took ~12 s against the 8 s statement timeout.
--
-- Root cause, measured: 20261012181905 introduced the reporting views
-- ca_launch_bbj_reporting_contributions / _winners as
--   WHERE created_at >= fn_ca_launch_bbj_reporting_start(pool_id)
-- i.e. a SECURITY DEFINER function call PER ROW (not inlinable). The mini's
-- 7-day flow window reads ~319,000 contribution rows for Midway Union's pool:
-- 3.8 s for that one sum, and the function reads it more than once.
--
-- Fix at the root, two parts, one transaction:
--   1. Both views compute each pool's reporting start ONCE (grouped from the
--      same two tables the function reads, same predicate, same '-infinity'
--      default) and join it. Same columns, same rows. The same 7-day sum
--      measured 174 ms with this shape (EXPLAIN ANALYZE, production).
--   2. fn_bbj_mini_for_club computes the rate window only for club staff.
--      Every other caller gets NULL rates already (is_operator gate on the
--      output); it no longer pays for numbers it is not allowed to see. That
--      is the read every seated player makes once a minute.
-- The function body is otherwise the production definition verbatim.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW public.ca_launch_bbj_reporting_contributions WITH (security_invoker = true) AS
 WITH starts AS (
   SELECT r.row_key, max(o.captured_at) AS s
     FROM public.ca_launch_reset_operations o
     JOIN public.ca_launch_reset_rows r ON r.operation_id = o.operation_id
    WHERE o.state = 'executed' AND r.relation_name = 'bbj_pools'
    GROUP BY r.row_key
 )
 SELECT c.*
   FROM public.bbj_contributions c
   LEFT JOIN starts st ON st.row_key = jsonb_build_object('id', c.pool_id)
  WHERE c.created_at >= COALESCE(st.s, '-infinity'::timestamptz);

CREATE OR REPLACE VIEW public.ca_launch_bbj_reporting_winners WITH (security_invoker = true) AS
 WITH starts AS (
   SELECT r.row_key, max(o.captured_at) AS s
     FROM public.ca_launch_reset_operations o
     JOIN public.ca_launch_reset_rows r ON r.operation_id = o.operation_id
    WHERE o.state = 'executed' AND r.relation_name = 'bbj_pools'
    GROUP BY r.row_key
 )
 SELECT w.*
   FROM public.bbj_winners w
   LEFT JOIN starts st ON st.row_key = jsonb_build_object('id', w.pool_id)
  WHERE w.awarded_at >= COALESCE(st.s, '-infinity'::timestamptz);

REVOKE ALL ON public.ca_launch_bbj_reporting_contributions, public.ca_launch_bbj_reporting_winners
  FROM PUBLIC, anon, authenticated, service_role;

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
    SELECT p.pool_id, p.backup_balance, p.is_union_pool
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
      FROM public.ca_launch_bbj_reporting_winners w JOIN pool ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '30 days'
  ),
  win AS (
    SELECT CASE WHEN public.fn_ca_launch_bbj_reporting_start(pool.pool_id)>'-infinity'::timestamptz THEN
      GREATEST(0.5,LEAST(7.0,extract(epoch FROM(now()-public.fn_ca_launch_bbj_reporting_start(pool.pool_id)))/86400.0))
      ELSE GREATEST(0.5,LEAST(7.0,COALESCE(extract(epoch FROM(now()-(SELECT min(w.awarded_at) FROM public.bbj_winners w WHERE w.kind='mini')))/86400.0,7.0))) END AS days FROM pool
  ),
  flow AS (
    /* Rates are staff-only (output gate below), so only staff pay for them. */
    SELECT
      CASE WHEN caller.is_operator THEN
        COALESCE((SELECT sum(x.backup_portion) FROM public.ca_launch_bbj_reporting_contributions x
                   JOIN pool ON x.pool_id = pool.pool_id
                  WHERE x.created_at > now() - (win.days * interval '1 day')), 0)
          / win.days
      END AS in_day,
      CASE WHEN caller.is_operator THEN
        COALESCE((SELECT sum(w.total_payout) FROM public.ca_launch_bbj_reporting_winners w
                   JOIN pool ON w.pool_id = pool.pool_id
                  WHERE w.kind = 'mini'
                    AND w.awarded_at > now() - (win.days * interval '1 day')), 0)
          / win.days
      END AS out_day,
      win.days
      FROM win CROSS JOIN caller
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
         (SELECT max(w.awarded_at) FROM public.ca_launch_bbj_reporting_winners w
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini') AS last_hit_at,
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

COMMIT;
