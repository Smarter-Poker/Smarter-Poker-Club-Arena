CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_owner uuid; v_seats integer;
  v_collected numeric; v_rake numeric; v_reserve_in numeric; v_balance numeric;
  v_contrib jsonb; v_per_head numeric; v_seated integer;
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id;

  IF NOT FOUND OR COALESCE(v_t.variant,'') <> 'spin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry:' || p_tournament_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_reserve_owner');
  END IF;

  v_seats      := GREATEST(COALESCE(v_t.max_players, 3), 1);
  v_collected  := round(v_t.buy_in_amount * v_seats, 2);
  v_rake       := round(v_collected * public.fn_spin_rake_rate(v_t.buy_in_amount), 2);
  v_reserve_in := round(v_collected - v_rake, 2);

  PERFORM set_config('app.ledger_category', 'spin_entry', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count = spin_count + 1,
         highest_stake = GREATEST(highest_stake, v_t.buy_in_amount),
         updated_at = now()
   WHERE club_id = v_owner
   RETURNING balance INTO v_balance;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_pool_row', 'owner_id', v_owner);
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_balance,
          NULL, v_t.buy_in_amount, v_seats, v_rake,
          CASE WHEN v_owner = v_t.club_id
               THEN 'buy-ins less fixed rake, booked when the last seat was paid'
               ELSE format('buy-ins less fixed rake, booked when the last seat was paid (club %s)', v_t.club_id)
          END);

  IF v_rake > 0 THEN
    -- NO DIRECT TREASURY CREDIT. atomic_distribute_rake consumes this
    -- rake_records row and moves the chips to treasury and union. Crediting
    -- clubs.chip_treasury here as well double-credited every spin.
    SELECT jsonb_object_agg(tp.user_id::text, v_t.buy_in_amount), count(*)
      INTO v_contrib, v_seated
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id;

    v_per_head := CASE WHEN COALESCE(v_seated,0) > 0
                       THEN round(v_rake / v_seated, 4) ELSE NULL END;

    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source,
       player_contributions, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_rake, v_collected,
            COALESCE(v_seated, v_seats), 0, true,
            p_tournament_id, 'fn_spin_book_entry',
            v_contrib,
            jsonb_build_object('kind','spin_rake','buy_in',v_t.buy_in_amount,
                               'rake_rate', public.fn_spin_rake_rate(v_t.buy_in_amount),
                               'booked_at','entry','reserve_owner',v_owner,
                               'treasury_credited', false,
                               'distributed_by','atomic_distribute_rake',
                               'rake_per_player', v_per_head,
                               'seats_attributed', COALESCE(v_seated,0)));
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in,
    'balance', v_balance, 'owner_id', v_owner, 'seats', v_seats,
    'treasury_credited', false,
    'rake_per_player', v_per_head, 'seats_attributed', COALESCE(v_seated,0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid) TO service_role;
