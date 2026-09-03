-- The purchase that confirmed itself and charged nothing.
--
-- DailyChallengeService.buyStreakFreeze() calls this RPC to spend 5,000
-- diamonds on a streak freeze. The function did not exist -- and the client's
-- catch block RECOGNISED that by name and returned success anyway:
--
--     if (err.message?.includes('buy_streak_freeze')) {
--       console.warn('buy_streak_freeze RPC not found. Mocking success for UX testing.');
--       return { success: true };
--     }
--
-- So in production a player pressed Buy, was told it worked, was charged
-- nothing, and received nothing. The streak then broke on the next missed day
-- exactly as if they had never bought protection. No error surfaced, no row was
-- written, and nothing anywhere went red. Of the 200 RPCs this codebase calls,
-- it was the only one missing from the live schema -- and it was the one
-- handling currency.
--
-- Written to match what already exists rather than inventing a second way:
--   * deduct_diamonds() is the house diamond-spend helper (see
--     fn_mint_chips_from_diamonds) -- it checks the balance and writes the
--     ledger row, so this never touches profiles.diamonds directly;
--   * MAX_FREEZES = 3 is get_challenge_streak's own constant.
--
-- TWO TRAPS, both found by reading get_challenge_streak:
--
--  1. It clamps: `freezes_available = LEAST(freezes_available + earned, 3)`.
--     Selling a 4th freeze would let that clamp DESTROY it on the next read --
--     paid for, then silently deleted. So a purchase at the cap is refused
--     BEFORE any diamond moves, and says so.
--
--  2. `freezes_earned` drives the earn formula
--     `LEAST(streak / 7, 3) - freezes_earned`. A purchase must NOT touch it:
--     doing so would permanently cancel a freeze the player later earns from
--     their streak. Only freezes_available moves here.
--
-- APPLIED TO PRODUCTION 2026-08-23 via Supabase MCP apply_migration before this
-- branch was pushed, per CHECK 17. Verified on apply that all three refusal
-- paths return success:false without moving any diamonds.
CREATE OR REPLACE FUNCTION public.buy_streak_freeze(p_user_id uuid, p_cost integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  MAX_FREEZES constant int := 3;   -- get_challenge_streak's cap
  v_uid       uuid := auth.uid();
  v_state     public.challenge_streak_state%ROWTYPE;
  v_deduct    jsonb;
  v_after     integer;
BEGIN
  IF v_uid IS NULL THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  -- A caller may only ever buy for themselves.
  IF p_user_id IS NOT NULL AND p_user_id <> v_uid AND auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot buy a freeze for another player');
  END IF;
  IF p_cost IS NULL OR p_cost <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'cost must be a positive whole number');
  END IF;

  INSERT INTO public.challenge_streak_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_state FROM public.challenge_streak_state
   WHERE user_id = v_uid FOR UPDATE;

  -- Trap 1: refuse at the cap, before any diamond moves.
  IF v_state.freezes_available >= MAX_FREEZES THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You already hold the maximum of ' || MAX_FREEZES || ' streak freezes',
      'freezesAvailable', v_state.freezes_available);
  END IF;

  v_deduct := deduct_diamonds(
    v_uid, p_cost,
    'Streak freeze', 'streak_freeze', 'streak_freeze',
    jsonb_build_object('freezes_before', v_state.freezes_available),
    NULL, 0);

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'));
  END IF;

  -- Trap 2: freezes_available only. Never freezes_earned.
  UPDATE public.challenge_streak_state
     SET freezes_available = freezes_available + 1,
         updated_at = now()
   WHERE user_id = v_uid
  RETURNING freezes_available INTO v_after;

  RETURN jsonb_build_object('success', true, 'freezesAvailable', v_after,
                            'diamondsSpent', p_cost);
END;
$function$;

REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.buy_streak_freeze(uuid, integer) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='buy_streak_freeze') THEN
    RAISE EXCEPTION 'buy_streak_freeze was not created';
  END IF;
END $$;

-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.buy_streak_freeze(uuid, integer);
