-- live_md5 c6c26c25ab8a8b1222d375c7d6df0d2f
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
  r_out numeric := 0; r_in numeric := 0;
  v_sp_prize numeric; v_sp_bounty numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false)) INTO v_spin
      FROM public.tournaments t WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(p_tournament_id);
    SELECT COALESCE(sum(rr.rake_amount), 0) INTO v_sat_fee FROM public.rake_records rr
     WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament AND rr.source = 'fn_award_satellite_seat';
    v_prize_in := e.prize_in; v_tot := e.prize_in + e.satellite_in + e.bounty_in + e.fee_in;
    IF v_tot > 0 THEN
      r_p := round(e.refund_out * (e.prize_in + e.satellite_in) / v_tot, 2);
      r_b := round(e.refund_out * e.bounty_in / v_tot, 2);
    ELSE
      r_p := e.refund_out;
    END IF;
    r_f := round(e.refund_out - r_p - r_b, 2);
    /* PHASE 5.2: a spin's prize bank also moves through the reserve.
       2026-09-07: read from spin_reserve_ledger, not from the chip_ledger
       spin_entry / spin_prize legs it used to read. Those legs are the DERIVED
       record and one pair of them went missing: on 2026-09-06 at 12:50:38 both
       legs of tournament afa045db landed as `adjustment` rows into
       settlement_suspense with a NULL entity, their intended category
       surviving only inside the description text. The escrow therefore never
       learned that 60.00 had been drawn for a 60.00 prize, and
       fn_settle_tournament_obligation refused the winner's last 4.80 as
       escrow_short - for a day, with an open critical alert nobody could act
       on. spin_reserve_ledger is the record the pool balance itself moved by;
       it cannot be missing while the money has moved. Verified across 18,318
       escrow rows: 0 disagree with it, 1 was missing the legs entirely. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0),
           COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0)
      INTO r_out, r_in
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind IN ('contribution', 'jackpot_draw');
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, true,
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f, round(r_out, 2), round(r_in, 2),
       round(e.prize_balance - r_out + r_in, 2), e.bounty_balance, e.fee_balance,
       'shadow at first sight (' || p_what || ')')
    ON CONFLICT (tournament_id) DO NOTHING;
    RETURN;
  END IF;

  IF COALESCE(p_refund, 0) > 0 THEN
    v_prize_in := v.gross_in - v.fee_entries_in - v.bounty_in + v.satellite_in;
    v_tot := v.gross_in + v.satellite_in + v.satellite_fee_in;
    IF v_tot > 0 THEN
      r_p := round(p_refund * v_prize_in / v_tot, 2);
      r_b := round(p_refund * v.bounty_in / v_tot, 2);
    ELSE
      SELECT s.prize, s.bounty INTO v_sp_prize, v_sp_bounty
        FROM public.tournaments t2
        CROSS JOIN LATERAL public.fn_tournament_entry_split(t2.buy_in_amount, t2.buy_in_fee, t2.bounty_amount,
               COALESCE(t2.is_bounty, false) OR COALESCE(t2.is_pko, false) OR COALESCE(t2.is_mystery_bounty, false)) s
       WHERE t2.id = p_tournament_id;
      IF COALESCE(v_sp_prize, 0) + COALESCE(v_sp_bounty, 0) > 0 THEN
        r_p := round(p_refund * v_sp_prize / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
        r_b := round(p_refund * v_sp_bounty / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
      ELSE
        r_p := p_refund;
      END IF;
    END IF;
    r_f := round(p_refund - r_p - r_b, 2);
  END IF;

  UPDATE public.tournament_escrow
     SET gross_in = gross_in + COALESCE(p_gross_in, 0),
         fee_entries_in = fee_entries_in + COALESCE(p_fee_entries_in, 0),
         satellite_fee_in = satellite_fee_in + COALESCE(p_satellite_fee_in, 0),
         bounty_in = bounty_in + COALESCE(p_bounty_in, 0),
         overlay_in = overlay_in + COALESCE(p_overlay_in, 0),
         satellite_in = satellite_in + COALESCE(p_satellite_in, 0),
         prize_out = prize_out + COALESCE(p_prize_out, 0),
         bounty_out = bounty_out + COALESCE(p_bounty_out, 0),
         fee_out = fee_out + COALESCE(p_fee_out, 0),
         refund_prize = refund_prize + r_p, refund_bounty = refund_bounty + r_b, refund_fee = refund_fee + r_f,
         reserve_out = reserve_out + COALESCE(p_reserve_out, 0), reserve_in = reserve_in + COALESCE(p_reserve_in, 0),
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2),
         bounty_balance = round(bounty_in - bounty_out - refund_bounty, 2),
         fee_balance    = round(fee_entries_in + satellite_fee_in - fee_out - refund_fee, 2)
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;

  IF v.enforced AND v_outflow
     AND (v.prize_balance < -0.005 OR v.bounty_balance < -0.005 OR v.fee_balance < -0.005) THEN
    RAISE EXCEPTION 'escrow_short: tournament % cannot pay this % - it would leave prize %, bounty %, fee % (chip standard Phase 5.1: an event pays only what it holds)',
      p_tournament_id, p_what, v.prize_balance, v.bounty_balance, v.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
END;
$function$

