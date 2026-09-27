-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260722133251 "fn_claim_rakeback_and_expire_horse_periods_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ce13dd826269949d42002c1a84ad5e79 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- AUDIT FIX (rakeback claim). The old client claim flow (RakebackPage) marked periods
-- 'paid' itself, then called credit_player_rakeback with a CLIENT-SUPPLIED amount — but
-- that RPC is SECURITY INVOKER and wallets has no user-UPDATE policy, so the credit
-- silently no-op'd while periods flipped to paid. Replace with one secure DEFINER RPC:
-- server derives the player from auth.uid() (a user can only claim their OWN rakeback),
-- delegates each pending period to the fixed fn_close_settlement_period (which recomputes
-- the amount server-side, skips horses, credits atomically + idempotently).
CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user    uuid := (SELECT auth.uid());
  v_period  record;
  v_res     jsonb;
  v_count   int := 0;
  v_total   numeric := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND status = 'pending'
       AND (p_club_id IS NULL OR club_id = p_club_id)
     ORDER BY period_start
     FOR UPDATE
  LOOP
    v_res := public.fn_close_settlement_period(v_period.id);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_total := v_total + COALESCE((v_res->>'payout')::numeric, 0);
      IF COALESCE((v_res->>'payout')::numeric, 0) > 0 THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'periods_claimed', v_count, 'total_payout', v_total);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_claim_rakeback(uuid) TO authenticated;

-- Neutralize the existing spurious pending horse rakeback periods so no path can ever
-- pay them (belt-and-suspenders beyond the horse guard in fn_close_settlement_period).
UPDATE public.rakeback_periods rp
SET status = 'expired'
FROM public.profiles p
WHERE p.id = rp.user_id AND COALESCE(p.is_horse, false) = true AND rp.status = 'pending';
