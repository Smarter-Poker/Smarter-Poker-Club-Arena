CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- DIAMOND PHASE 9: the chip shadow convention - prize_balance without a
  -- Spin's reserve legs, which the escrow row carries as reserve_in and
  -- reserve_out and fn_ca_escrow_balance_drift adds back.
  SELECT e.prize_in, e.bounty_in, e.fee_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out,
         e.fee_out, e.refund_out, e.prize_balance - r.spin_underwrite + r.spin_surplus,
         e.bounty_balance, e.fee_balance
    FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e
   CROSS JOIN LATERAL (
     SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'spin_underwrite'), 0)::numeric AS spin_underwrite,
            COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'spin_surplus'), 0)::numeric AS spin_surplus
       FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id = p_tournament_id) r
   WHERE public.fn_poker_diamond_tournament(p_tournament_id)
  UNION ALL
  SELECT * FROM public.fn_ca_tournament_escrow_chips(p_tournament_id)
   WHERE NOT public.fn_poker_diamond_tournament(p_tournament_id);
$function$
