-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINI'S RESERVE HAS A FLOOR A CLUB OWNS, AND A RUNWAY ANYONE CAN READ
--  BBJ programme phase 3 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The mini's PRICE is global - a flat amount per stakes tier from
-- `bbj_mini_tiers` - but its FUNDING is per pool: 25% of each pool's own BBJ
-- rake lands in `backup_balance`. Nothing has ever compared the two, so a pool
-- whose mini pays out faster than its backup fills drifts down to
-- `mini_reserve_floor` and the mini stops there, permanently and silently. The
-- only symptom is `payable` turning false on every tier, which reads to a
-- player exactly like a reserve that is briefly low.
--
-- It is not hypothetical. Measured on production 2026-09-11, over a 7-day
-- window, with the mini four days old:
--
--   pool                 backup     in/day    out/day    net/day
--   union pool         43,614.00   2,326.91   1,174.24  +1,152.67
--   Deep Stack Society 13,743.21   1,830.69   2,107.97    -277.28
--
-- Deep Stack Society is running a deficit. With 8,743.21 of headroom above its
-- 5,000 floor it reaches that floor in about 31 days, after which its mini
-- never pays again until somebody funds the reserve. Nothing on the platform
-- would have said so.
--
-- This migration adds the two things that were missing, and deliberately does
-- NOT change what anything currently pays:
--
--   1. RUNWAY on `fn_bbj_mini_for_club` - income, spend, net and days-to-floor,
--      all measured from the pool's own rows over the same 7-day window, so an
--      operator can see the deficit coming instead of discovering it.
--   2. `fn_bbj_set_club_mini_floor` - the floor is already a per-pool column;
--      until now nothing could set it and every pool carried the same 5,000.
--      A club that owns its pool can now raise or lower its own floor, through
--      the same authorization as the mini switch.
--
-- THE FLOOR HAS A LOWER BOUND, and the bound is derived, not chosen: the
-- largest ENABLED mini tier. A reserve is allowed to be small, but it may not
-- be set so low that it cannot cover one more mini payout - that would be a
-- club configuring its own jackpot into a state where the felt shows an amount
-- the engine must refuse. Today the largest enabled tier is 1,500 and every
-- floor is 5,000, so this migration changes no pool's behaviour.
--
-- What is NOT decided here: the floor's DEFAULT value, the tier amounts, and
-- the min-players threshold all set what players are owed in future events and
-- are Dan's (CLAUDE.md 10.9). This builds the mechanism and leaves 5,000 in
-- place; it does not retune anything.

BEGIN;

-- ── 1. THE READ PATH GAINS ITS RUNWAY ──────────────────────────────────────
-- DROP + CREATE, not CREATE OR REPLACE: the return type grows, and Postgres
-- refuses to replace a function whose OUT columns changed (42P13).
DROP FUNCTION IF EXISTS public.fn_bbj_mini_for_club(uuid);

CREATE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
RETURNS TABLE(
  pool_id uuid, enabled boolean, backup_balance numeric, reserve_floor numeric,
  parked numeric, available numeric, tiers jsonb, hits_30d bigint, paid_30d numeric,
  last_hit_at timestamp with time zone, club_switch boolean, can_toggle boolean,
  is_union_pool boolean,
  -- the runway, all over the SAME 7-day window so the two rates are comparable
  in_per_day numeric, out_per_day numeric, net_per_day numeric,
  days_to_floor numeric, floor_minimum numeric
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
  /* THE RUNWAY. Both sides of the rate come from the SAME seven days: money
     into this pool's backup bank, and money out of it as minis. A shorter
     window on one side and a longer one on the other produces a ratio that
     looks authoritative and means nothing. */
  flow AS (
    SELECT
      COALESCE((SELECT sum(x.backup_portion) FROM public.bbj_contributions x
                 JOIN pool ON x.pool_id = pool.pool_id
                WHERE x.created_at > now() - interval '7 days'), 0) / 7.0 AS in_day,
      COALESCE((SELECT sum(w.total_payout) FROM public.bbj_winners w
                 JOIN pool ON w.pool_id = pool.pool_id
                WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '7 days'), 0) / 7.0 AS out_day
  ),
  /* A reserve may be small, but never too small to cover one more payout. */
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
         /* NULL is the honest answer for a pool that is not draining - not a
            huge number, and not zero. A surface must be able to tell "never, at
            this rate" from "tomorrow". */
         CASE WHEN flow.out_day > flow.in_day
              THEN ROUND(
                     GREATEST(0, COALESCE(pool.backup_balance,0) - parked_row.parked
                                 - pool_row.reserve_floor)
                     / (flow.out_day - flow.in_day), 1)
              ELSE NULL END AS days_to_floor,
         bound.floor_min AS floor_minimum
    FROM pool, pool_row, parked_row, hits, club, flow, bound;
$function$;

COMMENT ON FUNCTION public.fn_bbj_mini_for_club(uuid) IS
  'The mini jackpot as a player and an operator see it, for one club. Adds the '
  'runway (phase 3): in_per_day, out_per_day and net_per_day are measured over '
  'the SAME seven days, and days_to_floor is NULL unless the pool is actually '
  'draining. `payable` on each tier inverts fn_bbj_mini_payout''s refusal term '
  'for term, so a shown mini is a payable mini.';

GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, anon, service_role;

-- ── 2. THE FLOOR IS A CONTROL, NOT A CONSTANT ──────────────────────────────
-- Same authorization shape as fn_bbj_set_club_mini_enabled, and in the same
-- order: name the actor, then authorize, THEN explain. A stranger must not be
-- able to learn a club's union shape from a refusal.
CREATE OR REPLACE FUNCTION public.fn_bbj_set_club_mini_floor(
  p_club_id uuid,
  p_floor numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_union uuid;
  v_pool  uuid;
  v_is_union_pool boolean;
  v_min   numeric;
BEGIN
  IF p_club_id IS NULL OR p_floor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_and_floor_required');
  END IF;

  /* The function names its own actor. Derived one call down it would answer a
     service_role caller - which has no auth.uid() - with the misleading
     'not_a_club_admin'. */
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  IF NOT public.fn_is_club_admin_uid(p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_club_admin');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = p_club_id;
  IF v_union IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_club_follows_the_union');
  END IF;

  SELECT p.pool_id, p.is_union_pool INTO v_pool, v_is_union_pool
    FROM public.fn_bbj_pool_for_club(p_club_id) p;
  IF v_pool IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;
  IF COALESCE(v_is_union_pool, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_club_follows_the_union');
  END IF;

  IF p_floor < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'floor_cannot_be_negative');
  END IF;

  /* DERIVED, not chosen: a reserve may be small, but not so small that it
     cannot cover one more payout at the largest enabled tier. Below that the
     felt would show an amount the payout RPC must refuse. */
  SELECT COALESCE(max(mt.amount) FILTER (WHERE mt.enabled), 0) INTO v_min
    FROM public.bbj_mini_tiers mt;
  IF p_floor < v_min THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'floor_below_one_payout',
                              'minimum', v_min);
  END IF;

  UPDATE public.bbj_pools SET mini_reserve_floor = p_floor, updated_at = now()
   WHERE id = v_pool;

  RETURN jsonb_build_object('ok', true, 'mini_reserve_floor', p_floor, 'minimum', v_min);
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_set_club_mini_floor(uuid, numeric) IS
  'Sets the mini reserve floor for a club that owns its own pool (owner, '
  'co_owner, admin or manager with an active membership, via '
  'fn_is_club_admin_uid). A club inside a union shares the union reserve and is '
  'refused by name. The floor may not go below the largest enabled mini tier: '
  'a reserve that cannot cover one more payout would make the felt promise what '
  'the engine must refuse. Phase 3, migration 20260911162600.';

REVOKE ALL ON FUNCTION public.fn_bbj_set_club_mini_floor(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_bbj_set_club_mini_floor(uuid, numeric)
  TO authenticated, service_role;

-- ── 3. ASSERT, OR ABORT ────────────────────────────────────────────────────
DO $$
DECLARE v_cols integer; v_floor_fn integer; v_pools integer; v_changed integer;
BEGIN
  -- the read path must publish every runway column
  SELECT count(*) INTO v_cols
    FROM unnest(ARRAY['in_per_day','out_per_day','net_per_day','days_to_floor','floor_minimum']) c
   WHERE EXISTS (
     SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_mini_for_club'
        AND pg_get_function_result(p.oid) LIKE '%' || c || '%');
  IF v_cols <> 5 THEN
    RAISE EXCEPTION 'fn_bbj_mini_for_club is missing runway columns (found %)', v_cols;
  END IF;

  SELECT count(*) INTO v_floor_fn FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_set_club_mini_floor';
  IF v_floor_fn <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_bbj_set_club_mini_floor, found %', v_floor_fn;
  END IF;

  -- NOTHING may have been retuned by this migration
  SELECT count(*) INTO v_pools FROM public.bbj_pools;
  SELECT count(*) INTO v_changed FROM public.bbj_pools
   WHERE COALESCE(mini_reserve_floor, 0) <> 5000;
  IF v_changed <> 0 THEN
    RAISE EXCEPTION
      'this migration must not change any pool floor, but % of % differ from 5000',
      v_changed, v_pools;
  END IF;
END $$;

COMMIT;
