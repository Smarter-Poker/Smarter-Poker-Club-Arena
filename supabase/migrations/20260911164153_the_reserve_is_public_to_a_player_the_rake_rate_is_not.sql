-- ═══════════════════════════════════════════════════════════════════════════
--  THE RESERVE IS THE JACKPOT; THE RAKE RATE IS THE BUSINESS
--  BBJ programme phase 3 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE ONLY FILE THAT DECLARES `fn_bbj_mini_for_club` in phase 3. The runway
-- arrived in 20260911162600, its window was corrected in 20260911162733, and
-- the actor gate in 20260911164031; all three ran, and all three are
-- superseded here. They are declared once, in this file, because
-- `check-definer-authorization` judges each migration FILE on its own body -
-- rightly, since nothing guarantees a later file exists - and because a replay
-- should not install and discard the same function three times.
--
-- WHAT THE GUARD CAUGHT, and it was right. This function is SECURITY DEFINER
-- and was granted to `anon`, and it never asked who was calling. Phase 2
-- shipped it that way to serve the felt and the lobby. Phase 3 then added the
-- RUNWAY - `in_per_day` is, in plain terms, a club's daily Bad Beat Jackpot
-- rake income - so a read of jackpot figures became a read of a club's
-- revenue, available to anybody with no account at all.
--
--   * PRE-LOGIN ROLES ARE REVOKED. `PUBLIC` is named as well as `anon`,
--     because anon inherits whatever PUBLIC holds and revoking anon alone
--     reads as a fix while doing nothing. Verified first that this function
--     backs no RLS policy - a policy expression evaluates as the QUERYING
--     role, so revoking a policy helper would deny every SELECT on the tables
--     whose policies call it. Zero rows in pg_policy mention it.
--
--   * THE FUNCTION NAMES ITS OWN ACTOR, via auth.uid(), rather than deriving
--     it a call down - the same correction phase 2 made to the mini switch.
--
-- WHERE THE LINE FALLS, and why it is not further out. 20260911164031 also
-- hid the RESERVE (backup_balance, reserve_floor, parked, available) from
-- non-staff. That was too much: two player-facing surfaces have shown the
-- reserve floor since phase 2 - `BBJRulesPanel` ("Reserve Floor: N Chips Stay
-- In The Backup Pool") and `BadBeatJackpotPage` ("... - N Floor") - and would
-- have started reading it as zero. The reserve is part of what the jackpot IS
-- and players are already told about it. The RATES are what is new and not
-- public.
--
--   visible to a signed-in player - pool, enabled, tiers (amount + payable),
--                                   backup_balance, reserve_floor, parked,
--                                   available, the 30-day history
--   club staff only (is_operator) - in_per_day, out_per_day, net_per_day,
--                                   days_to_floor, floor_minimum, window_days
--
-- NULL, never zero, for the gated half: a rate withheld and a rate of zero are
-- different facts, and `lib/bbjMiniFeed` keeps the NULL rather than flattening
-- it through `num()`.
--
-- Read path only: no balance, floor, tier amount or payout changes.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_bbj_mini_for_club(uuid);

CREATE FUNCTION public.fn_bbj_mini_for_club(p_club_id uuid)
RETURNS TABLE(
  pool_id uuid, enabled boolean, backup_balance numeric, reserve_floor numeric,
  parked numeric, available numeric, tiers jsonb, hits_30d bigint, paid_30d numeric,
  last_hit_at timestamp with time zone, club_switch boolean, can_toggle boolean,
  is_union_pool boolean,
  in_per_day numeric, out_per_day numeric, net_per_day numeric,
  days_to_floor numeric, floor_minimum numeric, window_days numeric,
  is_operator boolean
)
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
      FROM public.bbj_winners w JOIN pool ON w.pool_id = pool.pool_id
     WHERE w.kind = 'mini' AND w.awarded_at > now() - interval '30 days'
  ),
  /* THE WINDOW. Seven days, or however long the mini has existed, whichever is
     SHORTER - and never below half a day, so a brand-new mini cannot divide by
     something near zero and report an absurd rate. Applied to both sides: two
     windows are not a rate, they are two numbers divided by each other. */
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
                WHERE x.created_at > now() - (win.days * interval '1 day')), 0)
        / win.days AS in_day,
      COALESCE((SELECT sum(w.total_payout) FROM public.bbj_winners w
                 JOIN pool ON w.pool_id = pool.pool_id
                WHERE w.kind = 'mini'
                  AND w.awarded_at > now() - (win.days * interval '1 day')), 0)
        / win.days AS out_day,
      win.days
      FROM win
  ),
  /* A reserve may be small, but never too small to cover one more payout. */
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
           WHERE w.pool_id = pool.pool_id AND w.kind = 'mini') AS last_hit_at,
         pool_row.mini_enabled AS club_switch,
         (club.union_id IS NULL AND COALESCE(pool.is_union_pool, false) IS NOT TRUE) AS can_toggle,
         COALESCE(pool.is_union_pool, false) AS is_union_pool,
         /* THE RATES ARE THE BUSINESS. in_per_day is a club's daily jackpot
            rake income. NULL, never zero, for anyone who may not see it. */
         CASE WHEN caller.is_operator THEN ROUND(flow.in_day, 2) END  AS in_per_day,
         CASE WHEN caller.is_operator THEN ROUND(flow.out_day, 2) END AS out_per_day,
         CASE WHEN caller.is_operator THEN ROUND(flow.in_day - flow.out_day, 2) END AS net_per_day,
         /* NULL is the honest answer for a pool that is not draining - not a
            huge number, and not zero. A surface must be able to tell "never, at
            this rate" from "tomorrow". */
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

COMMENT ON FUNCTION public.fn_bbj_mini_for_club(uuid) IS
  'The mini jackpot for one club. A signed-in player sees whether it is on, '
  'what it pays at each stake, whether each tier can pay right now, the '
  'reserve and its floor, and the 30-day history. The RATES - in_per_day, '
  'out_per_day, net_per_day, days_to_floor, floor_minimum, window_days - are '
  'NULL unless the caller is staff of that club (is_operator), because '
  'in_per_day is a club''s daily jackpot rake income. Pre-login roles are '
  'revoked outright. The runway measures income and spend over ONE window, '
  'seven days or the mini''s age, whichever is shorter. `payable` on each tier '
  'inverts fn_bbj_mini_payout''s refusal term for term, so a shown mini is a '
  'payable mini.';

REVOKE ALL ON FUNCTION public.fn_bbj_mini_for_club(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_for_club(uuid) TO authenticated, service_role;

DO $$
DECLARE v_anon boolean; v_asks boolean;
BEGIN
  SELECT has_function_privilege('anon', p.oid, 'EXECUTE') INTO v_anon
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_mini_for_club';
  IF v_anon THEN RAISE EXCEPTION 'anon can still execute fn_bbj_mini_for_club'; END IF;

  SELECT pg_get_functiondef(p.oid) LIKE '%auth.uid()%' INTO v_asks
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_mini_for_club';
  IF NOT v_asks THEN RAISE EXCEPTION 'fn_bbj_mini_for_club must name its own actor'; END IF;
END $$;

COMMIT;
