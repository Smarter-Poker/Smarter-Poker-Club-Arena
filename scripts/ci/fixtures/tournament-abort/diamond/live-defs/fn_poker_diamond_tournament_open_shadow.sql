-- live_md5 158caca1151b5b7ccf33bf4d4ca61d6c
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l record; v_x record;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
    COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
    COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
    COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
    COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
    COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
    -- DIAMOND PHASE 9: a Spin's reserve legs, the chip escrow's reserve_in and reserve_out.
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus,
    -- 2026-10-06: a guarantee's overlay legs, the chip escrow's overlay_in (net).
    COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay'),0)
      - COALESCE(sum(amount)  FILTER (WHERE kind = 'overlay_return'),0) AS overlay
    INTO l
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  INSERT INTO public.tournament_escrow
    (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
     prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
     prize_balance, bounty_balance, fee_balance, opened_from)
  VALUES
    (p_tournament_id, true, l.prize_in + l.bounty_in + l.fee_in, l.fee_in, 0, l.bounty_in, l.overlay, 0,
     l.prize_out, l.bounty_out, l.fee_out, l.refund_prize, l.refund_bounty, l.refund_fee, l.spin_surplus, l.spin_underwrite,
     l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite + l.overlay, l.bounty_in - l.bounty_out - l.refund_bounty,
     l.fee_in - l.fee_out - l.refund_fee, 'diamond terminal shadow (from the Diamond ledger)')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT x.* INTO v_x FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id;
  IF v_x.prize_balance IS DISTINCT FROM (l.prize_in - l.prize_out - l.refund_prize - l.spin_surplus + l.spin_underwrite + l.overlay)::numeric
     OR v_x.reserve_in IS DISTINCT FROM l.spin_underwrite::numeric
     OR v_x.reserve_out IS DISTINCT FROM l.spin_surplus::numeric
     OR v_x.overlay_in IS DISTINCT FROM l.overlay::numeric
     OR v_x.bounty_balance IS DISTINCT FROM (l.bounty_in - l.bounty_out - l.refund_bounty)::numeric
     OR v_x.fee_balance IS DISTINCT FROM (l.fee_in - l.fee_out - l.refund_fee)::numeric
     OR v_x.prize_balance + v_x.bounty_balance + v_x.fee_balance
        IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'tournament % escrow shadow disagrees with its Diamond banks', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'prize_balance',v_x.prize_balance,'bounty_balance',v_x.bounty_balance,'fee_balance',v_x.fee_balance);
END $function$

