-- live_md5 3b4597f68e207fd94ed339a9a7e5421b
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
      -- DIAMOND PHASE 9: a Spin's reserve legs move its prize bank, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus,
      -- 2026-10-06: a guarantee's overlay legs move it too, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay'),0) AS overlay,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay_return'),0) AS overlay_return
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, (overlay - overlay_return)::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in + spin_underwrite - spin_surplus + overlay - overlay_return - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$

