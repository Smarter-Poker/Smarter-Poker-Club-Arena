CREATE OR REPLACE FUNCTION public.fn_ca_payout_rows_without_money(p_days integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, tournament_name text, player_id uuid, finish_position integer, source text, amount numeric, paid_at timestamp with time zone, idempotency_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1));
BEGIN
  /* THE WINDOW IS A VALUE WHEN THE QUERY IS PLANNED (2026-10-22). As a
     LANGUAGE sql SECURITY DEFINER function the window arrived as an unknown
     parameter, so the three days the conservation sweep asks for were read as
     every payout ever paid: a sequential scan of tournament_payouts (876k
     rows) and of wallet_credit_idempotency for its earliest row, 13-55 s.
     Planned with its value, the window reads idx_tournament_payouts_paid_money
     and the earliest row reads idx_wallet_credit_idempotency_created. Same
     query, same rows, same order. */
  RETURN QUERY
    SELECT p.tournament_id, t.name, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                        'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
       AND p.user_id IS NOT NULL
       AND p.amount > 0
       AND p.paid_at > v_since
       AND p.paid_at > (SELECT min(w0.created_at) FROM public.wallet_credit_idempotency w0)
       AND (p.idempotency_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                            WHERE w.key = p.idempotency_key))
     ORDER BY p.paid_at DESC;
END
$function$;
