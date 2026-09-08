-- ===========================================================================
--  THE PROFILE GUARD ADMITS THE DAILY BONUS CLAIM
-- ===========================================================================
--
-- fn_guard_profile_privileged_columns refuses any write to profiles.diamonds
-- that is not made in a service_role JWT context or from a call stack naming
-- a whitelisted money RPC. fn_ca_daily_bonus_claim runs under the PLAYER'S
-- JWT (it is the browser-callable claim) and pays through award_diamonds_v2,
-- so its first rolled-back probe died at line 680 of award_diamonds_v2:
--
--     42501: profiles.diamonds is server-managed and cannot be modified by
--            role postgres
--
-- This is exactly the path claim_daily_challenge / claim_daily_challenges
-- (Daily Missions) already take, and they are on the list for the same
-- reason. The claim is a SECURITY DEFINER function that derives its amount
-- from a snapshot the player cannot write and pays only through the ledgered
-- award function, which is the standard the guard exists to enforce.
--
-- The function body is otherwise byte-identical to the live definition.

CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN RETURN NEW; END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public\.)?deduct_diamonds\('
     OR v_stack ~ 'function (public\.)?fn_union_send_to_member\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenge\('
     OR v_stack ~ 'function (public\.)?claim_daily_challenges\('
     OR v_stack ~ 'function (public\.)?fn_ca_daily_bonus_claim\('
     OR v_stack ~ 'function (public\.)?fn_ca_mint\('
     OR v_stack ~ 'function (public\.)?fn_ca_burn\('
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM anon;
REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM authenticated;
