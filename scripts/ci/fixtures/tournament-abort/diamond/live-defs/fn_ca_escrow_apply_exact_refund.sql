-- live_md5 2d76b04e7ed4feda16b6e9420d7c00cd
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply_exact_refund(p_tournament_id uuid, p_what text, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
BEGIN
  IF p_tournament_id IS NULL
     OR p_refund_prize IS NULL OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize < 0 OR p_refund_bounty < 0 OR p_refund_fee < 0
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_prize + v_bounty + v_fee <= 0 THEN
    RAISE EXCEPTION 'exact refund requires finite nonnegative whole-cent rails'
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.tournament_escrow
     SET refund_prize = refund_prize + v_prize,
         refund_bounty = refund_bounty + v_bounty,
         refund_fee = refund_fee + v_fee,
         prize_balance = round(
           (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in
           - reserve_out + reserve_in - prize_out - refund_prize - v_prize,2),
         bounty_balance = round(
           bounty_in - bounty_out - refund_bounty - v_bounty,2),
         fee_balance = round(
           fee_entries_in + satellite_fee_in - fee_out - refund_fee - v_fee,2),
         updated_at = now()
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;
  IF v.tournament_id IS NULL OR v.enforced IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'exact refund escrow for tournament % is absent or unenforced',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v.prize_balance IS NULL OR v.bounty_balance IS NULL OR v.fee_balance IS NULL
     OR v.refund_prize IS NULL OR v.refund_bounty IS NULL OR v.refund_fee IS NULL
     OR v.prize_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.bounty_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR v.prize_balance IS DISTINCT FROM round(v.prize_balance,2)
     OR v.bounty_balance IS DISTINCT FROM round(v.bounty_balance,2)
     OR v.fee_balance IS DISTINCT FROM round(v.fee_balance,2)
     OR v.refund_prize IS DISTINCT FROM round(v.refund_prize,2)
     OR v.refund_bounty IS DISTINCT FROM round(v.refund_bounty,2)
     OR v.refund_fee IS DISTINCT FROM round(v.refund_fee,2)
     OR v.prize_balance < -0.005
     OR v.bounty_balance < -0.005
     OR v.fee_balance < -0.005 THEN
    RAISE EXCEPTION
      'escrow_short: tournament % cannot pay exact % rails %, %, %; balances would be %, %, %',
      p_tournament_id,p_what,v_prize,v_bounty,v_fee,
      v.prize_balance,v.bounty_balance,v.fee_balance USING ERRCODE = 'P0403';
  END IF;
END;
$function$

