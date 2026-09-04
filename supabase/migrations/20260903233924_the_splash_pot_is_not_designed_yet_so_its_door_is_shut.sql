-- THE SPLASH POT IS NOT DESIGNED YET, SO ITS DOOR IS SHUT.
--
-- 2026-09-03, Dan (binding): "WE'VE NEVER BUILT THE SPLASH POT YET, OR DESIGNED
-- RULES FOR IT, ITS SUPPOSED TO BE ADDED LATER, ONCE WE WORK ALL THE BUGS OUT."
--
-- I read fn_bbj_promo_rain as an existing feature that was broken and fixed it
-- an hour ago (20260903231637, 20260903231744). That was the wrong call. The
-- function exists, it is granted to authenticated, and an owner could press it -
-- but no rules were ever written for it: who qualifies, how much, how often,
-- what stops one owner emptying a union's promo float across 413 seats in a
-- single click. Before tonight it was harmless because three separate faults
-- meant it could never pay. My fixes removed all three, which turned an
-- undesigned money path into a working one. That is worse, not better.
--
-- So the door is shut at the top, and only at the top:
--
--   * fn_bbj_promo_rain refuses every call with a message that says why, and
--     loses its authenticated grant, so no browser can reach it at all;
--   * fn_bbj_promo_payout_atomic keeps the corrections underneath - it draws on
--     the float the sweep actually fills, credits ordinary cashable chips per
--     ruling 4B, declares its counterparty, and refuses a short float. When the
--     splash pot is designed, the accounting beneath it is already right and the
--     design work is rules, not plumbing.
--
-- Nothing is lost by shutting it: zero rains have ever been paid, so there is
-- no behaviour and no player expectation to preserve. The BBJService button will
-- receive an explicit refusal instead of a silent 'Unauthorized', which is the
-- honest answer to pressing a feature that does not exist yet.

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_rain(
  p_pool_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  /* Dan, 2026-09-03: the splash pot has never been built or specified and is
     to be added later, once the accounting work is finished. Until its rules
     exist - eligibility, size, frequency, and what stops a single click
     emptying a union's promo float - this moves no chips.

     The disbursement path that IS ruled on and built is fn_promo_disburse:
     a union owner sends promo to a member club or to a player in one, and an
     unaffiliated club owner sends it to a player in that club. Leaderboards
     remain the one automatic promo payout. */
  RETURN jsonb_build_object(
    'success', false,
    'error', 'not_built_yet',
    'detail', 'The splash pot has not been designed. Promo is disbursed by owners through '
              || 'fn_promo_disburse, and leaderboards are the only automatic promo payout.',
    'pool_id', p_pool_id,
    'requested', p_amount,
    'reason', p_reason);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_promo_rain(uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_rain(uuid, numeric, text) TO service_role;

COMMENT ON FUNCTION public.fn_bbj_promo_rain(uuid, numeric, text) IS
  'CLOSED 2026-09-03 by Dan''s ruling: the splash pot has never been designed and is to be '
  'added later. Refuses every call. The accounting beneath it (fn_bbj_promo_payout_atomic) '
  'is correct and ready for when the rules are written.';

-- Self-check: the door refuses, and no browser role can reach it.
DO $selfcheck$
DECLARE
  v_res jsonb;
BEGIN
  SELECT public.fn_bbj_promo_rain('00000000-0000-0000-0000-000000000000'::uuid, 100, 'self-check')
    INTO v_res;
  IF COALESCE((v_res ->> 'success')::boolean, true) IS NOT FALSE
     OR v_res ->> 'error' <> 'not_built_yet' THEN
    RAISE EXCEPTION 'SPLASH_POT_SELFCHECK: the rain did not refuse: %', v_res;
  END IF;

  IF has_function_privilege('authenticated', 'public.fn_bbj_promo_rain(uuid, numeric, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_bbj_promo_rain(uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SPLASH_POT_SELFCHECK: a browser role can still reach the rain';
  END IF;

  RAISE NOTICE 'SPLASH_POT_SELFCHECK_OK: the splash pot refuses and is unreachable from a browser';
END
$selfcheck$;