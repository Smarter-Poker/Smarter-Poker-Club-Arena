CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
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
$function$
