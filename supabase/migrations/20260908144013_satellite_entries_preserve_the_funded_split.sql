BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer)'::regprocedure)) <> '4c885de0a8e1227f9e0b364a8be0a7de' THEN
  RAISE EXCEPTION 'fn_award_satellite_seat changed; rebase before applying';
 END IF;
 IF md5(pg_get_functiondef('public.fn_ca_escrow_apply(uuid, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric)'::regprocedure)) <> '916ff0ee849e2f294b2bad129bdfadcc' THEN
  RAISE EXCEPTION 'fn_ca_escrow_apply changed; rebase before applying';
 END IF;
 IF md5(pg_get_functiondef('public.fn_ca_escrow_on_seat_transfer_leg()'::regprocedure)) <> '5bb25d8929d287a1b753cf30018ce0cb' THEN
  RAISE EXCEPTION 'fn_ca_escrow_on_seat_transfer_leg changed; rebase before applying';
 END IF;
 IF md5(pg_get_functiondef('public.fn_ca_tournament_escrow(uuid)'::regprocedure)) <> '29c0347fd00e9fc8a26e26eab53010af' THEN
  RAISE EXCEPTION 'fn_ca_tournament_escrow changed; rebase before applying';
 END IF;
 IF md5(pg_get_functiondef('public.fn_deliver_satellite_ticket_exact(uuid, uuid, uuid, text, integer, numeric)'::regprocedure)) <> '71339efabeb3dcafdfaec5279f259f07' THEN
  RAISE EXCEPTION 'fn_deliver_satellite_ticket_exact changed; rebase before applying';
 END IF;
 IF md5(pg_get_functiondef('public.fn_ca_escrow_on_rake_record()'::regprocedure)) <> '3e7001d3c93e38884b641752360dd19c' THEN
  RAISE EXCEPTION 'fn_ca_escrow_on_rake_record changed; rebase before applying';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text DEFAULT NULL::text, p_position integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
  v_existing_q boolean;
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
  v_split record;
  -- Lane G (2026-09-02): the seat is paid from the satellite's own pool.
  v_sat_pool numeric;
  v_moved    numeric := 0;
  v_short    numeric := 0;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- A previously committed award is a replay even if admission later closed.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

  IF FOUND THEN

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END IF;

  -- One database predicate owns level-based and minutes-only late entry.
  -- ANNOUNCED/REGISTERING targets are open until their pool is finalized;
  -- RUNNING targets must pass the same locked gate as a paid registrant.
  IF v_t.status IN ('ANNOUNCED','REGISTERING') THEN
    IF COALESCE(v_t.prize_pool_finalized,false) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
    END IF;
  ELSIF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_target_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','target_closed');
  END IF;

  SELECT count(*) INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_target_id;
  IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN
    RETURN jsonb_build_object('ok',false,'reason','target_full');
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount,
    COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false) OR COALESCE(v_t.is_mystery_bounty,false));
  IF v_split.prize < 0 OR v_split.bounty < 0 OR v_split.rake < 0
     OR v_split.charge <> v_split.prize + v_split.bounty + v_split.rake THEN
    RAISE EXCEPTION 'Invalid satellite target entry split' USING ERRCODE='23514';
  END IF;
  -- Open both escrows before journal triggers observe this award's writes.
  PERFORM public.fn_ca_escrow_apply(p_target_id, 'before satellite seat');
  PERFORM public.fn_ca_escrow_apply(p_satellite_id, 'before satellite seat');

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id, current_bounty)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id, v_split.bounty)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing - the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    --
    -- AND SAY WHEN YOU DO NOT KNOW. source_satellite_id has only been written
    -- since 2026-08-30; every seat awarded before that has it NULL. Collapsing
    -- NULL to FALSE answers "a different satellite seated them" and sends the
    -- caller down the branch that pays cash, on top of a seat this satellite
    -- may well have awarded. NULL means unknown, and the caller pays nothing.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + v_split.prize,
         bounty_pool     = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee', 'entry_split_version', 2,
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  v_value := round(COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 2);

  /* THE SEAT IS PAID FROM THE SATELLITE'S OWN POOL (Lane G, 2026-09-02).
     The target was just credited buy_in + fee. Until now nobody was debited,
     so the target owed prize money it never received and the satellite kept
     a pool it had already spent. Move the seat value out of the satellite's
     prize_pool, and write the one ledger row that says where it went.

     Every newly awarded seat must have a fully funded transfer and payout
     receipt in this transaction. Existing awards still replay above. */
  BEGIN
    SELECT prize_pool INTO v_sat_pool
      FROM public.tournaments
     WHERE id = p_satellite_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Satellite source tournament does not exist' USING ERRCODE = '23503';
    END IF;
    v_sat_pool := round(COALESCE(v_sat_pool, 0), 2);
    v_moved := LEAST(GREATEST(v_sat_pool, 0), v_value);
    v_short := round(v_value - v_moved, 2);

    IF v_moved > 0 THEN
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) - v_moved, 2)
       WHERE id = p_satellite_id;

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_satellite_id, 'tournaments.prize_pool',
         'prize_liability', p_target_id, 'tournaments.prize_pool+total_rake',
         v_moved, 'tournament_buyin', v_t.club_id, p_satellite_id,
         'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text || ':pool_transfer',
         format('Satellite seat: %s paid from the satellite pool into %s (buy-in %s + fee %s) for the seat of %s',
                v_moved, COALESCE(v_t.name, p_target_id::text),
                COALESCE(v_t.buy_in_amount, 0), COALESCE(v_t.buy_in_fee, 0), p_user_id),
         jsonb_build_object('kind', 'satellite_seat_pool_transfer',
                            'entry_split_version', 2, 'entry_prize', v_split.prize,
                            'entry_bounty', v_split.bounty, 'entry_fee', v_split.rake,
                            'satellite_id', p_satellite_id,
                            'satellite_target_id', p_target_id,
                            'user_id', p_user_id,
                            'registration_id', v_seat_id,
                            'seat_value', v_value,
                            'moved', v_moved,
                            'unbacked', v_short),
         v_sat_pool, round(v_sat_pool - v_moved, 2))
      ;
    END IF;

    IF v_short > 0 THEN
      RAISE EXCEPTION 'Satellite pool cannot fund the entire seat: required %, available %',
        v_value, v_sat_pool USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The seat, target counters, source debit and journal are indivisible.
    RAISE;
  END;

  /* The payout receipt commits with the new seat and its funded transfer. */
  BEGIN
    SELECT tournament_type, prize_pool INTO v_sat
      FROM public.tournaments WHERE id = p_satellite_id;
    SELECT count(*) INTO v_field
      FROM public.tournament_players WHERE tournament_id = p_satellite_id;
    v_value := COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0);

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
    VALUES
      (p_satellite_id, p_user_id, p_position, v_value, 'satellite_seat',
       'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text,
       now(), v_sat.tournament_type, v_field,
       -- The COLLECTED pool, as every earlier row recorded it: read before
       -- this seat's transfer reduced it.
       COALESCE(v_sat_pool, v_sat.prize_pool),
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0),
                          'entry_split_version', 2, 'entry_prize', v_split.prize,
                          'entry_bounty', v_split.bounty,
                          'pool_transfer', v_moved,
                          'unbacked', v_short))
    ;
  EXCEPTION WHEN OTHERS THEN
    -- An award without its payout receipt must roll back in full.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty,
    'rake', COALESCE(v_t.buy_in_fee, 0),
    'pool_transfer', v_moved,
    'unbacked', v_short);
END;
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee numeric := round(COALESCE(NEW.rake_amount, 0), 2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament, false) OR NEW.tournament_id IS NULL THEN RETURN NULL; END IF;
  /* CHIP STANDARD 5.3 (2026-09-05): a cancel's fee reversal is rake
     attribution, not escrow money. The refund that precedes it already
     returned the fee slice to the entrant from the fee bank (refund_fee);
     counting the reversal too took the fee out twice, drove the fee bank
     negative and refused the cancel's own refunds (probe 20:0x UTC on a
     target holding 43 qualifiers: fee -2.50, escrow_short). */
  IF v_fee < 0 AND NEW.source IN ('atomic_cancel_tournament','fn_unregister_from_tournament') THEN RETURN NULL; END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    /* PHASE 5 GATE (2026-09-05): the fee row carries the fee only. The seat's
       money arrives on the satellite's pool_transfer leg (buy-in + fee, or
       less when the satellite pool was short) through zz_ca_escrow_seat_transfer_leg;
       the fee is reclassed out of the prize bank here so the two together read
       exactly what arrived. A target with no fee gets no row here and is fed
       by the leg alone, which the rake row could never do. */
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat fee',
              p_satellite_fee_in => v_fee,
              p_satellite_in => CASE WHEN NEW.metadata->>'entry_split_version'='2' THEN 0 ELSE -v_fee END);
  ELSE
    PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'entry fee', p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metadata->>'entry_split_version' = '2' THEN
    IF round(NEW.amount,2) IS DISTINCT FROM round((NEW.metadata->>'entry_prize')::numeric
        + (NEW.metadata->>'entry_bounty')::numeric + (NEW.metadata->>'entry_fee')::numeric,2)
       OR (NEW.metadata->>'entry_prize')::numeric < 0
       OR (NEW.metadata->>'entry_bounty')::numeric < 0
       OR (NEW.metadata->>'entry_fee')::numeric < 0 THEN
      RAISE EXCEPTION 'Satellite transfer does not match its funded split' USING ERRCODE='23514';
    END IF;
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite split entry',
      p_gross_in => round(NEW.amount - (NEW.metadata->>'entry_fee')::numeric,2),
      p_bounty_in => (NEW.metadata->>'entry_bounty')::numeric);
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH t AS (
  SELECT id,
         COALESCE(bounty_amount, 0) AS bounty_amount,
         (COALESCE(is_bounty, false) OR COALESCE(is_pko, false)
          OR COALESCE(is_mystery_bounty, false)) AS is_b
    FROM public.tournaments
   WHERE id = p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type = 'debit'
                                   AND category IN ('tournament_buyin','rebuy','addon')), 0) AS gross_in,
    count(*) FILTER (WHERE type = 'debit' AND category = 'tournament_buyin') AS n_entry,
    count(*) FILTER (WHERE type = 'debit' AND category = 'rebuy')            AS n_rebuy,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'prize'), 0)
      - COALESCE(sum(amount) FILTER (WHERE type = 'debit'
                                       AND category IN ('prize','prize_reversal')), 0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'bounty'), 0) AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type = 'credit' AND category = 'refund'), 0) AS refund_out
  FROM public.wallet_transactions
  WHERE related_entity_id = p_tournament_id
), rr AS (
  SELECT
    COALESCE(sum(rake_amount), 0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (WHERE source = 'fn_award_satellite_seat'), 0) AS fee_sat,
    COALESCE(sum(rake_amount) FILTER (WHERE source = 'fn_award_satellite_seat' AND metadata->>'entry_split_version'='2'),0) AS fee_sat_split,
    COALESCE(sum(COALESCE(pot_size, 0) - rake_amount)
               FILTER (WHERE source = 'fn_award_satellite_seat'), 0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id = p_tournament_id AND is_tournament
    -- CHIP STANDARD 5.3 (2026-09-05): a cancel's fee reversal is attribution,
    -- not escrow money; the refund already returned the fee slice.
    -- 2026-09-06 (20260906145706): an UNREGISTRATION's fee reversal is the
    -- same thing.
    AND NOT (rake_amount < 0
             AND source IN ('atomic_cancel_tournament', 'fn_unregister_from_tournament'))
), ov AS (
  SELECT COALESCE(sum(a.amount), 0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id = p_tournament_id
     AND a.to_type = 'prize_liability'
     AND (a.category = 'overlay'
          OR (a.category = 'correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (
       COALESCE(a.description, '') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id = a.to_entity_id
            AND b.category = 'overlay'
            AND b.to_type = 'prize_liability'
            AND b.id <> a.id
            AND b.amount = a.amount
            AND COALESCE(b.description, '') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at - a.created_at))) < 5))
), stl AS (
  SELECT COALESCE(sum(amount), 0) AS moved,
    COALESCE(sum(amount) FILTER (WHERE metadata->>'entry_split_version'='2'),0) AS split_moved,
    COALESCE(sum((metadata->>'entry_fee')::numeric) FILTER (WHERE metadata->>'entry_split_version'='2'),0) AS split_fee,
    COALESCE(sum((metadata->>'entry_bounty')::numeric) FILTER (WHERE metadata->>'entry_split_version'='2'),0) AS split_bounty
    FROM public.chip_ledger
   WHERE to_entity_id = p_tournament_id AND to_type = 'prize_liability'
     AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tgo AS (
  SELECT COALESCE(sum(amount), 0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id = p_tournament_id
), sat AS (
  SELECT COALESCE(sum(amount), 0) AS seats_out
    FROM public.tournament_payouts
   WHERE tournament_id = p_tournament_id AND source = 'satellite_seat'
), fo AS (
  SELECT COALESCE(sum(amount), 0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id = p_tournament_id AND settled_at IS NOT NULL
), calc AS (
  SELECT
    round(w.gross_in + stl.split_moved - stl.split_fee, 2)                                          AS gross_in,
    round(rr.fee_in, 2)                                           AS fee_in,
    round(rr.fee_in - rr.fee_sat, 2)                              AS fee_entries,
    round(CASE WHEN t.is_b
               THEN w.n_entry * t.bounty_amount + w.n_rebuy * round(t.bounty_amount)
               ELSE 0 END + stl.split_bounty, 2)                                     AS bounty_in,
    round(CASE WHEN ov.ledger_overlay > 0 THEN ov.ledger_overlay
               ELSE tgo.tgo_amount END, 2)                        AS overlay_in,
    round(stl.moved - stl.split_moved - rr.fee_sat + rr.fee_sat_split, 2)                              AS satellite_in,
    round(w.prize_out + sat.seats_out, 2)                         AS prize_out,
    round(w.bounty_out, 2)                                        AS bounty_out,
    round(fo.fee_out, 2)                                          AS fee_out,
    round(w.refund_out, 2)                                        AS refund_out
  FROM t, w, rr, stl, ov, tgo, sat, fo
), split AS (
  -- NOT the spin draw. A Spin's prize really does come from the reserve, and
  -- 20260907162201 folded that draw in here - which reads correctly on its own
  -- and breaks fn_ca_escrow_apply, whose first-sight path derives gross_in
  -- from this number and then adds the reserve legs itself. The reserve
  -- movement belongs to tournament_escrow.reserve_in / reserve_out.
  SELECT c.*, round(c.gross_in - c.fee_entries - c.bounty_in, 2) AS prize_in
    FROM calc c
), apportion AS (
  SELECT s.*,
         CASE WHEN (s.prize_in + s.satellite_in + s.bounty_in + s.fee_in) > 0
              THEN round(s.refund_out * (s.prize_in + s.satellite_in) / (s.prize_in + s.satellite_in + s.bounty_in + s.fee_in), 2)
              ELSE s.refund_out END AS r_prize,
         CASE WHEN (s.prize_in + s.satellite_in + s.bounty_in + s.fee_in) > 0
              THEN round(s.refund_out * s.bounty_in / (s.prize_in + s.satellite_in + s.bounty_in + s.fee_in), 2)
              ELSE 0 END AS r_bounty
    FROM split s
)
SELECT
  a.prize_in,
  a.bounty_in,
  a.fee_in,
  a.overlay_in,
  a.satellite_in,
  a.prize_out,
  a.bounty_out,
  a.fee_out,
  a.refund_out,
  round(a.prize_in + a.overlay_in + a.satellite_in - a.prize_out - a.r_prize, 2)      AS prize_balance,
  round(a.bounty_in - a.bounty_out - a.r_bounty, 2)                                    AS bounty_balance,
  round(a.fee_in - a.fee_out - (a.refund_out - a.r_prize - a.r_bounty), 2)             AS fee_balance
FROM apportion a;
$function$;

CREATE OR REPLACE FUNCTION public.fn_deliver_satellite_ticket_exact(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text, p_position integer, p_ticket_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target public.tournaments%ROWTYPE;
  v_existing public.tournament_players%ROWTYPE;
  v_before_target_pool numeric;
  v_before_target_bounty numeric;
  v_split record;
  v_before_target_rake numeric;
  v_before_source_pool numeric;
  v_open boolean:=false;
  v_count integer;
  v_result jsonb;
  v_registration uuid;
  v_payout uuid;
  v_payout_meta jsonb;
  v_ledger_count integer;
  v_rake_count integer;
  v_target_buyin numeric;
  v_target_fee numeric;
  v_cash_reason text:='target_not_open';
BEGIN
  SELECT * INTO v_target FROM public.tournaments
   WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('delivery','cash','reason','target_missing'); END IF;
  SELECT count(*)::integer INTO v_count FROM public.tournament_players
   WHERE tournament_id=p_target_id;
  v_open:=CASE
    WHEN v_target.status IN ('ANNOUNCED','REGISTERING')
      THEN NOT COALESCE(v_target.prize_pool_finalized,false)
    WHEN v_target.status='RUNNING'
      THEN public.fn_tournament_late_registration_open(p_target_id)
    ELSE false END;
  v_open:=v_open AND (v_target.max_players IS NULL OR v_count<v_target.max_players);
  IF round(GREATEST(COALESCE(v_target.buy_in_amount,0),0)
           +GREATEST(COALESCE(v_target.buy_in_fee,0),0),2)
       <>round(p_ticket_value,2) THEN
    -- The winner owns the frozen advertised value. Never call the historical
    -- seat RPC at a later, different target price: it would debit the source by
    -- today's price. Cash the frozen value instead.
    v_open:=false;
    v_cash_reason:='target_economics_changed';
  END IF;

  SELECT * INTO v_existing FROM public.tournament_players
   WHERE tournament_id=p_target_id AND user_id=p_user_id FOR UPDATE;
  IF FOUND THEN
    IF COALESCE(v_existing.is_satellite_qualifier,false)
       AND v_existing.source_satellite_id=p_satellite_id THEN
      SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1],
             (array_agg(po.metadata ORDER BY po.id))[1]
        INTO v_count,v_payout,v_payout_meta
        FROM public.tournament_payouts po
       WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
         AND po.position=p_position AND po.source='satellite_seat'
         AND round(po.amount,2)=round(p_ticket_value,2)
         AND po.metadata->>'registration_id'=v_existing.id::text;
      v_target_buyin:=CASE
        WHEN COALESCE(v_payout_meta->>'target_buy_in','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_buy_in')::numeric ELSE -1 END;
      v_target_fee:=CASE
        WHEN COALESCE(v_payout_meta->>'target_fee','')~'^[0-9]+([.][0-9]+)?$'
          THEN (v_payout_meta->>'target_fee')::numeric ELSE -1 END;
      SELECT count(*)::integer INTO v_ledger_count
        FROM public.chip_ledger l
       WHERE l.idempotency_key='tourney:'||p_satellite_id::text||':seat:'
                               ||p_user_id::text||':pool_transfer'
         AND l.from_type='prize_liability' AND l.from_entity_id=p_satellite_id
         AND l.to_type='prize_liability' AND l.to_entity_id=p_target_id
         AND round(l.amount,2)=round(p_ticket_value,2)
         AND l.metadata->>'registration_id'=v_existing.id::text
         AND CASE WHEN COALESCE(l.metadata->>'moved','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'moved')::numeric,2) ELSE -1 END
             =round(p_ticket_value,2)
         AND CASE WHEN COALESCE(l.metadata->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                  THEN round((l.metadata->>'unbacked')::numeric,2) ELSE -1 END=0;
      SELECT count(*)::integer INTO v_rake_count
        FROM public.rake_records rr
       WHERE rr.tournament_id=p_target_id AND rr.source='fn_award_satellite_seat'
         AND rr.metadata->>'satellite_id'=p_satellite_id::text
         AND rr.metadata->>'user_id'=p_user_id::text
         AND rr.metadata->>'registration_id'=v_existing.id::text
         AND round(rr.rake_amount,2)=round(v_target_fee,2)
         AND round(COALESCE(rr.pot_size,0),2)=round(p_ticket_value,2);
      IF v_count<>1
         OR (CASE WHEN COALESCE(v_payout_meta->>'pool_transfer','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'pool_transfer')::numeric,2) ELSE -1 END)
            <>round(p_ticket_value,2)
         OR (CASE WHEN COALESCE(v_payout_meta->>'unbacked','')~'^[0-9]+([.][0-9]+)?$'
                 THEN round((v_payout_meta->>'unbacked')::numeric,2) ELSE -1 END)<>0
         OR round(v_target_buyin+v_target_fee,2)<>round(p_ticket_value,2)
         OR v_ledger_count<>1
         OR (v_target_fee>0 AND v_rake_count<>1)
         OR (v_target_fee=0 AND v_rake_count<>0) THEN
        RAISE EXCEPTION 'existing target seat has no exact fully-backed payout event'
          USING ERRCODE='check_violation';
      END IF;
      RETURN jsonb_build_object('delivery','seat','already',true,
        'registration_id',v_existing.id,'payout_id',v_payout);
    ELSIF COALESCE(v_existing.is_satellite_qualifier,false)
          AND v_existing.source_satellite_id IS NULL THEN
      RAISE EXCEPTION 'existing target satellite seat has ambiguous origin'
        USING ERRCODE='check_violation';
    ELSE
      RETURN jsonb_build_object('delivery','cash','reason','seat_already_held_elsewhere');
    END IF;
  END IF;
  IF NOT v_open THEN
    RETURN jsonb_build_object('delivery','cash','reason',v_cash_reason);
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_target.buy_in_amount,v_target.buy_in_fee,v_target.bounty_amount,
    COALESCE(v_target.is_bounty,false) OR COALESCE(v_target.is_pko,false) OR COALESCE(v_target.is_mystery_bounty,false));
  v_before_target_bounty:=round(COALESCE(v_target.bounty_pool,0),2);
  v_before_target_pool:=round(COALESCE(v_target.prize_pool,0),2);
  v_before_target_rake:=round(COALESCE(v_target.total_rake,0),2);
  SELECT round(COALESCE(t.prize_pool,0),2) INTO v_before_source_pool
    FROM public.tournaments t WHERE t.id=p_satellite_id FOR UPDATE;
  IF v_before_source_pool+0.005<round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'satellite guarantee is not funded for its frozen ticket'
      USING ERRCODE='check_violation';
  END IF;

  v_result:=public.fn_award_satellite_seat(
    p_satellite_id,p_target_id,p_user_id,p_username,p_position);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'awarded')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'pool_transfer')::numeric,-1)
          <>round(p_ticket_value,2)
     OR COALESCE((v_result->>'unbacked')::numeric,-1)<>0 THEN
    RAISE EXCEPTION 'exact target-seat award refused or wrote incomplete money: %',
      COALESCE(v_result::text,'null') USING ERRCODE='check_violation';
  END IF;
  v_registration:=(v_result->>'registration_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.id=v_registration AND tp.tournament_id=p_target_id
       AND tp.user_id=p_user_id AND tp.source_satellite_id=p_satellite_id
       AND COALESCE(tp.is_satellite_qualifier,false)
  ) THEN
    RAISE EXCEPTION 'seat helper returned without the exact target registration'
      USING ERRCODE='check_violation';
  END IF;
  SELECT count(*)::integer,(array_agg(po.id ORDER BY po.id))[1] INTO v_count,v_payout
    FROM public.tournament_payouts po
   WHERE po.tournament_id=p_satellite_id AND po.user_id=p_user_id
     AND po.position=p_position AND po.source='satellite_seat'
     AND round(po.amount,2)=round(p_ticket_value,2)
     AND po.metadata->>'registration_id'=v_registration::text
     AND round(COALESCE((po.metadata->>'pool_transfer')::numeric,-1),2)
          =round(p_ticket_value,2)
     AND round(COALESCE((po.metadata->>'unbacked')::numeric,-1),2)=0;
  IF v_count<>1
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_pool+v_split.prize
     OR (SELECT round(COALESCE(t.bounty_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id) <>v_before_target_bounty+v_split.bounty
     OR (SELECT round(COALESCE(t.total_rake,0),2) FROM public.tournaments t
          WHERE t.id=p_target_id)
          <>v_before_target_rake+round(COALESCE(v_target.buy_in_fee,0),2)
     OR (SELECT round(COALESCE(t.prize_pool,0),2) FROM public.tournaments t
          WHERE t.id=p_satellite_id)
          <>v_before_source_pool-round(p_ticket_value,2) THEN
    RAISE EXCEPTION 'target seat, payout and pool transfer are not one exact event'
      USING ERRCODE='check_violation';
  END IF;
  RETURN jsonb_build_object('delivery','seat','already',false,
    'registration_id',v_registration,'payout_id',v_payout);
END;
$function$;

COMMIT;
