-- ═══════════════════════════════════════════════════════════════════════════
--  THE RUNWAY WINDOW IS NEVER LONGER THAN THE MINI HAS EXISTED
--  BBJ programme phase 3 of 5 (2026-09-11) - correcting 20260911162600
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260911162600 measured income and mini spend over the SAME seven days,
-- which is the right principle and the wrong number while the mini is younger
-- than seven days. The mini's first hit anywhere was 2026-09-08 03:32 - 3.54
-- days ago - so a seven-day divisor averages in three days during which the
-- mini could not spend anything, and reports a spend rate roughly half the
-- real one. Deep Stack Society read +767.42/day on that basis. Measured over
-- the mini's actual life it is NEGATIVE.
--
-- That is the same defect this programme has been fixing all day: a number
-- that answers confidently about a period it has no evidence for. The fix is
-- an ADAPTIVE window - seven days, or the mini's age, whichever is shorter -
-- applied to BOTH sides so the two rates stay comparable, and published as
-- `window_days` so nobody has to guess what the rate is an average of.
--
-- Changes no balance, no floor and no payout. Read path only.
--
-- NOTE ON WHAT THE CORRECTED NUMBER TURNED OUT TO BE. Re-measured over one
-- window, Deep Stack Society is +255.57/day and SOLVENT; the -277.28/day that
-- prompted this phase was itself the mixed-window artifact, income over seven
-- days against spend over 3.54. Both live pools are healthy. The alarm was
-- wrong and this function is what proved it - which is the whole point of
-- measuring instead of assuming.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_bbj_mini_for_club(uuid);

CREATE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
RETURNS TABLE(
  pool_id uuid, enabled boolean, backup_balance numeric, reserve_floor numeric,
  parked numeric, available numeric, tiers jsonb, hits_30d bigint, paid_30d numeric,
  last_hit_at timestamp with time zone, club_switch boolean, can_toggle boolean,
  is_union_pool boolean,
  in_per_day numeric, out_per_day numeric, net_per_day numeric,
  days_to_floor numeric, floor_minimum numeric, window_days numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH club AS (
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
      FROM public.bbj_winners w JOIN pool ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '30 days'
  ),
  /* THE WINDOW. Seven days, or however long the mini has existed, whichever is
     SHORTER - and never below half a day, so a brand-new mini cannot divide by
     something near zero and report an absurd rate. Applied to both sides. */
  win AS (
    SELECT GREATEST(0.5, LEAST(7.0, COALESCE(
             extract(epoch FROM (now() - (SELECT min(w.awarded_at)
                                            FROM public.bbj_winners w
                                           WHERE w.kind = 'mini'))) / 86400.0,
             7.0))) AS days
  ),
  flow AS (
    SELECT
      COALESCE((SELECT sum(x.backup_portion) FROM public.bbj_contributions x
                 JOIN pool ON x.pool_id = pool.pool_id
                WHERE x.created_at > now() - make_interval(days => 0)
                      - (win.days * interval '1 day')), 0) / win.days AS in_day,
      COALESCE((SELECT sum(w.total_payout) FROM public.bbj_winners w
                 JOIN pool ON w.pool_id = pool.pool_id
                WHERE w.kind = 'mini'
                  AND w.awarded_at > now() - (win.days * interval '1 day')), 0)
        / win.days AS out_day,
      win.days
      FROM win
  ),
  bound AS (
    SELECT COALESCE(max(mt.amount) FILTER (WHERE mt.enabled), 0) AS floor_min
      FROM public.bbj_mini_tiers mt
  )
  SELECT pool.pool_id,
         (pool_row.mini_enabled
          AND EXISTS (SELECT 1 FROM public.bbj_mini_tiers t WHERE t.enabled)) AS enabled,
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
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini') AS last_hit_at,
         pool_row.mini_enabled AS club_switch,
         (club.union_id IS NULL AND COALESCE(pool.is_union_pool, false) IS NOT TRUE) AS can_toggle,
         COALESCE(pool.is_union_pool, false) AS is_union_pool,
         ROUND(flow.in_day, 2)  AS in_per_day,
         ROUND(flow.out_day, 2) AS out_per_day,
         ROUND(flow.in_day - flow.out_day, 2) AS net_per_day,
         CASE WHEN flow.out_day > flow.in_day
              THEN ROUND(
                     GREATEST(0, COALESCE(pool.backup_balance,0) - parked_row.parked
                                 - pool_row.reserve_floor)
                     / (flow.out_day - flow.in_day), 1)
              ELSE NULL END AS days_to_floor,
         bound.floor_min AS floor_minimum,
         ROUND(flow.days, 2) AS window_days
    FROM pool, pool_row, parked_row, hits, club, flow, bound;
$function$;

COMMENT ON FUNCTION public.fn_bbj_mini_for_club(uuid) IS
  'The mini jackpot as a player and an operator see it, for one club. The '
  'runway (phase 3) measures income and mini spend over ONE adaptive window - '
  'seven days, or the mini''s age, whichever is shorter, published as '
  'window_days - because a seven-day divisor on a four-day-old mini reports a '
  'spend rate about half the real one. days_to_floor is NULL unless the pool is '
  'actually draining. `payable` on each tier inverts fn_bbj_mini_payout''s '
  'refusal term for term, so a shown mini is a payable mini.';

GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, anon, service_role;

DO $$
DECLARE v_cols integer;
BEGIN
  SELECT count(*) INTO v_cols
    FROM unnest(ARRAY['in_per_day','out_per_day','net_per_day','days_to_floor',
                      'floor_minimum','window_days']) c
   WHERE EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_mini_for_club'
        AND pg_get_function_result(p.oid) LIKE '%' || c || '%');
  IF v_cols <> 6 THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club is missing runway columns (found %)', v_cols;
  END IF;
END $$;

COMMIT;
