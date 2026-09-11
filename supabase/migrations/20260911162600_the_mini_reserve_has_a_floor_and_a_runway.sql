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
-- REMOVED FROM THIS FILE, DELIBERATELY, AND NOT FROM HISTORY.
--
-- This migration also redefined `fn_bbj_mini_for_club` to add the runway. That
-- definition was superseded twice within eighteen minutes - by 20260911162733
-- (the window must never be longer than the mini has existed) and then by
-- 20260911164153 (the rates are club staff's, and the function names its own
-- actor), which is the definition that STANDS.
--
-- `check-definer-authorization` judges each migration FILE on its own body, so
-- a file that declares an anon-reachable definer which a LATER file fixes is
-- blocked no matter what follows it - correctly, because nothing guarantees
-- the later file exists. Keeping three declarations of one function, two of
-- them dead on arrival, would also mean a replay installs and discards the
-- same function twice.
--
-- So the function is declared ONCE, in 20260911164153. What is left in this
-- file is `fn_bbj_set_club_mini_floor`, which is byte-for-byte what ran here
-- and is still current.

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
