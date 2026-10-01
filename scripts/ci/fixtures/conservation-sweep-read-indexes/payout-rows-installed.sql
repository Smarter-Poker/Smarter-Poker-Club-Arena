CREATE OR REPLACE FUNCTION public.fn_ca_payout_rows_without_money(p_days integer DEFAULT 30)
 RETURNS TABLE(tournament_id uuid, tournament_name text, player_id uuid, finish_position integer, source text, amount numeric, paid_at timestamp with time zone, idempotency_key text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT p.tournament_id, t.name, p.user_id, p.position, p.source, p.amount, p.paid_at, p.idempotency_key
      FROM public.tournament_payouts p
      JOIN public.tournaments t ON t.id = p.tournament_id
     WHERE p.source IN ('structure', 'reconcile', 'overlay_backpay', 'spin_backpay',
                        'hu_shortfall', 'late_reg_adjustment', 'final_table_deal', 'bubble_protection')
       AND p.user_id IS NOT NULL
       AND p.amount > 0
       AND p.paid_at > now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1))
       AND p.paid_at > (SELECT min(created_at) FROM public.wallet_credit_idempotency)
       AND (p.idempotency_key IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency w
                            WHERE w.key = p.idempotency_key))
     ORDER BY p.paid_at DESC;
  $function$
