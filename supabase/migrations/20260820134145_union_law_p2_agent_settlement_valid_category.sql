-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134145 "union_law_p2_agent_settlement_valid_category"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 77f966599a3027be2421b1204d19a709 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- PRE-EXISTING BUG surfaced while testing P2: atomic_pay_agent_settlement wrote
-- wallet_transactions.category = 'agent_settlement', which is NOT in the
-- wallet_transactions_category_check allow-list. Every agent settlement payout
-- would have raised a check-constraint violation and rolled back — the agent
-- commission payout path could never have paid anyone. Use 'commission', which
-- is the allow-listed category for exactly this.
CREATE OR REPLACE FUNCTION public.atomic_pay_agent_settlement(p_settlement_id uuid, p_agent_id uuid, p_amount numeric, p_period_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_user_id uuid;
  v_agent_club    uuid;
  v_res           jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;

  SELECT user_id, club_id INTO v_agent_user_id, v_agent_club
    FROM public.agents WHERE id = p_agent_id;
  IF v_agent_user_id IS NULL THEN
    RAISE EXCEPTION 'agent % not found', p_agent_id;
  END IF;

  v_res := public.fn_pay_player_chips(
    v_agent_user_id, p_amount, 'commission',
    'Agent commission payout (settlement ' || p_settlement_id::text
      || ', period ' || p_period_id::text || ')',
    v_agent_club, p_settlement_id);

  UPDATE public.agents
     SET lifetime_earnings  = COALESCE(lifetime_earnings, 0) + p_amount,
         pending_commission = GREATEST(COALESCE(pending_commission,0) - p_amount, 0),
         updated_at         = NOW()
   WHERE id = p_agent_id;

  INSERT INTO public.audit_trail
    (actor_id, actor_role, action, target_type, target_id,
     amount, currency, reason)
  VALUES
    (v_agent_user_id, 'system', 'agent_settlement_payout', 'settlement',
     p_settlement_id, p_amount, 'CHIPS',
     'atomic_pay_agent_settlement payout to ' || COALESCE(v_res->>'source','global_wallet'));
END;
$function$;

