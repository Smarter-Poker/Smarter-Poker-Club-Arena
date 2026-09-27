-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721191039 "fn_generate_all_credit_invoices_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 532c76b4fde35a92c38e2d915b54bef5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Task #55: bulk weekly credit-invoice generator. Loops over non-prepaid agents with
-- positive debt (credit_limit - agent_wallet_balance) and generates one invoice each
-- via fn_generate_credit_invoice. period_end is anchored to the week boundary so the
-- whole operation is IDEMPOTENT per week: a trigger firing daily (or hourly) converges
-- to exactly one invoice per agent per week (fn_generate_credit_invoice conflicts on
-- (agent_id, period_end)). This lets a simple always-on trigger (the engine settlement
-- daemon) drive it reliably without precise scheduling.
CREATE OR REPLACE FUNCTION public.fn_generate_all_credit_invoices(
  p_period_end timestamptz DEFAULT date_trunc('week', now())
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_agent record;
  v_debt numeric;
  v_generated int := 0;
  v_duplicate int := 0;
  v_failed int := 0;
  v_period_start timestamptz := p_period_end - interval '7 days';
  v_due_date timestamptz := p_period_end + interval '2 days';
  v_res jsonb;
BEGIN
  FOR v_agent IN
    SELECT id, credit_limit, agent_wallet_balance
    FROM agents
    WHERE COALESCE(is_prepaid, false) = false
      AND COALESCE(credit_limit, 0) - COALESCE(agent_wallet_balance, 0) > 0
  LOOP
    v_debt := GREATEST(0, COALESCE(v_agent.credit_limit, 0) - COALESCE(v_agent.agent_wallet_balance, 0));
    IF v_debt <= 0 THEN CONTINUE; END IF;
    v_res := fn_generate_credit_invoice(v_agent.id, v_period_start, p_period_end, v_debt, v_due_date);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      IF COALESCE((v_res->>'duplicate')::boolean, false)
        THEN v_duplicate := v_duplicate + 1;
        ELSE v_generated := v_generated + 1;
      END IF;
    ELSE
      v_failed := v_failed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'generated', v_generated,
    'duplicate', v_duplicate, 'failed', v_failed, 'period_end', p_period_end);
END;
$function$;
