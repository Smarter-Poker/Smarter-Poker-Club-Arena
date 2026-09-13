-- ═══════════════════════════════════════════════════════════════════════════
--  THE UNION OWNS ITS OWN MINI
--  BBJ programme, the sweep after phase 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 3 gave the mini jackpot two controls - the switch and the reserve
-- floor - and a runway that says whether the reserve is draining. All three
-- are `fn_bbj_set_club_mini_*`, and all three refuse a club that belongs to a
-- union, deliberately: one club inside a union must not flip a switch that
-- decides what the whole union's tables pay.
--
-- The union itself was then given nothing. Measured on production today:
--
--   pool                    kind    main        backup      floor     mini
--   Midway Union            UNION   52,369.37   43,893.73   5,000.00  on
--   Deep Stack Society      club    19,418.68   13,556.93   5,000.00  on
--
-- The LARGER pool on this platform is a union pool, and `SELECT count(*) FROM
-- pg_proc WHERE proname LIKE 'fn_bbj_set_union%'` returned 0. So for Midway
-- Union nobody could turn the mini off, nobody could raise or lower its
-- reserve floor, and phase 3's whole control surface was unreachable for the
-- pool it matters most to. A club operator got a switch; the union operator
-- got the sentence `union_club_follows_the_union` and no union to follow it to.
--
-- ── WHAT THIS ADDS ────────────────────────────────────────────────────────
--
-- The same two controls, keyed on the union, authorized against the union.
-- `fn_is_union_operator` is the predicate (the union's owner, or a row in
-- `union_admins`) rather than the broader `fn_is_union_overseer`, which also
-- admits club-member admins of a union-shaped club: a control that changes
-- what every table under a union pays should answer to the union's own people.
--
-- Everything else is phase 3's, on purpose:
--
--   * THE ORDER IS NAME THE ACTOR, AUTHORIZE, THEN EXPLAIN. A refusal must
--     never tell a stranger something they could not already see - the reason
--     `pool_not_found` arrives only after the caller has proved they operate
--     this union.
--   * THE FUNCTION NAMES ITS OWN ACTOR with auth.uid(). Derived one call down
--     it would answer a service_role caller, which has no auth.uid(), with the
--     misleading 'not_a_union_operator'.
--   * THE FLOOR'S LOWER BOUND IS DERIVED, NOT CHOSEN: one payout at the
--     largest ENABLED tier. A reserve may be small, but not so small that the
--     felt shows an amount the payout RPC must refuse.
--   * PRE-LOGIN ROLES ARE REVOKED, PUBLIC named as well as anon.
--
-- No pool's switch or floor is changed by this migration. It creates the
-- controls; it does not use them.

BEGIN;

-- ── THE SWITCH ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_bbj_set_union_mini_enabled(
  p_union_id uuid,
  p_enabled  boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_pool  uuid;
BEGIN
  IF p_union_id IS NULL OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_and_enabled_required');
  END IF;

  /* The function names its own actor: derived one call down it would answer a
     service_role caller - which has no auth.uid() - with the misleading
     'not_a_union_operator'. */
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');
  END IF;

  IF NOT public.fn_is_union_operator(p_union_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_union_operator');
  END IF;

  /* AFTER authorization, deliberately: whether a union has banked a jackpot
     yet is not something a stranger gets to learn from a refusal.

     The predicate is the one `uq_bbj_pools_union_active` makes UNIQUE -
     (union_id) WHERE club_id IS NULL AND status = 'active'. A bare
     `WHERE union_id = ...` is not unique here (a member club's own vestigial
     row can carry a union_id, and retired rows keep theirs), and plpgsql's
     SELECT INTO does not raise on multiple rows - it silently takes one. That
     is a control writing to an arbitrary pool. */
  SELECT p.id INTO v_pool
    FROM public.bbj_pools p
   WHERE p.union_id = p_union_id AND p.club_id IS NULL AND p.status = 'active';
  IF v_pool IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;

  UPDATE public.bbj_pools
     SET mini_enabled = p_enabled, updated_at = now()
   WHERE id = v_pool;

  RETURN jsonb_build_object('ok', true, 'mini_enabled', p_enabled, 'pool_id', v_pool);
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_set_union_mini_enabled(uuid, boolean) IS
  'Turn the mini jackpot on or off for a UNION pool. The union''s owner or an '
  'entry in union_admins may call it; a member club may not (that is what '
  'fn_bbj_set_club_mini_enabled''s union_club_follows_the_union refers to). '
  'Authorizes before it explains, so a refusal tells a stranger nothing.';

-- ── THE RESERVE FLOOR ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_bbj_set_union_mini_floor(
  p_union_id uuid,
  p_floor    numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_pool  uuid;
  v_min   numeric;
BEGIN
  IF p_union_id IS NULL OR p_floor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_and_floor_required');
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');
  END IF;

  IF NOT public.fn_is_union_operator(p_union_id, v_actor) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_union_operator');
  END IF;

  /* The same unique predicate as the switch - see the note there. */
  SELECT p.id INTO v_pool
    FROM public.bbj_pools p
   WHERE p.union_id = p_union_id AND p.club_id IS NULL AND p.status = 'active';
  IF v_pool IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;

  IF p_floor < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'floor_cannot_be_negative');
  END IF;

  /* DERIVED, not chosen - identical to the club control's bound. A reserve may
     be small, but not so small that it cannot cover one more payout at the
     largest enabled tier; below that the felt would promise an amount the
     payout RPC must refuse. */
  SELECT COALESCE(max(mt.amount) FILTER (WHERE mt.enabled), 0) INTO v_min
    FROM public.bbj_mini_tiers mt;
  IF p_floor < v_min THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'floor_below_one_payout',
                              'minimum', v_min);
  END IF;

  UPDATE public.bbj_pools
     SET mini_reserve_floor = p_floor, updated_at = now()
   WHERE id = v_pool;

  RETURN jsonb_build_object('ok', true, 'mini_reserve_floor', p_floor,
                            'minimum', v_min, 'pool_id', v_pool);
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_set_union_mini_floor(uuid, numeric) IS
  'Set a UNION pool''s mini reserve floor. Same derived lower bound as the '
  'club control - one payout at the largest enabled tier - and the same '
  'authorize-before-explain order. A new pool''s starting floor is '
  'fn_bbj_default_mini_floor(); this is how it is changed afterwards.';

-- ── GRANTS ────────────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER writers a browser can reach, and both consult the
-- request through auth.uid(). PUBLIC is named as well as anon: a pre-login
-- role must hold no EXECUTE on a function that moves a jackpot's rules.

REVOKE ALL ON FUNCTION public.fn_bbj_set_union_mini_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_set_union_mini_enabled(uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_bbj_set_union_mini_floor(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_set_union_mini_floor(uuid, numeric) TO authenticated;

-- ── ASSERTIONS ────────────────────────────────────────────────────────────

DO $$
DECLARE v_union_pools integer;
BEGIN
  /* The gap this closes is real and measured, not assumed: at least one pool
     is owned by a union and had no way to be operated. Counted with the same
     predicate the controls resolve on, so the assertion and the function
     cannot disagree about what a union pool is. */
  SELECT count(*) INTO v_union_pools
    FROM public.bbj_pools
   WHERE union_id IS NOT NULL AND club_id IS NULL AND status = 'active';
  IF v_union_pools = 0 THEN
    RAISE EXCEPTION
      'no union pool exists - this migration is answering a problem that is not here';
  END IF;

  /* NOTE ON WHAT IS *NOT* ASSERTED HERE. The obvious next check is "no union
     pool's floor or switch has moved", and it would be wrong for the same
     reason phase 3's first cut was: this file ships the controls whose whole
     job is to change those values, so any replay after an operator had used
     one would abort on a number that operator was entitled to set. What the
     migration must not do is change them ITSELF, and it contains no such
     write - only CREATE FUNCTION, COMMENT and GRANT. */

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fn_is_union_operator'
  ) THEN
    RAISE EXCEPTION 'fn_is_union_operator is the authority here and it is missing';
  END IF;

  /* A pre-login role holding EXECUTE on either of these would let a signed-out
     visitor turn a union's jackpot off. */
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname IN ('fn_bbj_set_union_mini_enabled', 'fn_bbj_set_union_mini_floor')
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on a union mini control';
  END IF;
END $$;

COMMIT;
