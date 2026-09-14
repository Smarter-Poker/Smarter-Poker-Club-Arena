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
  IF v_stack ~ 'function (public[.])?deduct_diamonds[(]'
     OR v_stack ~ 'function (public[.])?fn_union_send_to_member[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenge[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenges[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_claim[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_boost_extra[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'
     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_mint[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
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
$function$
;
