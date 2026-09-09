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

  -- CHIP STANDARD (2026-09-05): THE ESCROW ROW FIRST. A registration holds the
  -- spin's tournament_escrow row (its wallet debit's trigger) and then, when
  -- the seat count fills, books the entry here and waits for the advisory
  -- lock; the unbooked sweep holds the advisory lock and then reaches the
  -- same escrow row through the reserve leg. Two orders, one deadlock
  -- (40P01, one to three a day since 09-02; spin_entry_threw incidents).
  -- Taking the escrow row before the advisory lock gives every path one
  -- order: escrow, advisory, reserve pool. A spin with no row yet locks
  -- nothing here and opens at first sight as before.
  PERFORM 1 FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;

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

CREATE OR REPLACE FUNCTION public.fn_lock_tournament_launch_proof_parents(p_tournament_ids uuid[])
 RETURNS TABLE(tournament_id uuid, parent_status text, launch_id uuid, launch_lease_generation uuid, launch_completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT requested.id ORDER BY requested.id)
    INTO v_ids
    FROM unnest(p_tournament_ids) AS requested(id)
   WHERE requested.id IS NOT NULL;

  IF v_ids IS NULL THEN
    RETURN;
  END IF;

  /* Do not invert these two blocks.  Launch completion already owns receipt
     -> parent, and every child must join that order. */
  /* A few legacy RPCs entered with the tournament parent already locked.
     Waiting for a receipt owned by completion would make a cycle: completion
     waits for their parent while they wait for its receipt.  Fail that outer
     transaction as retryable instead of waiting; a clean retry enters this
     helper before touching another launch-proof row. */
  BEGIN
    PERFORM 1
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = ANY(v_ids)
     ORDER BY r.tournament_id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TOURNAMENT_TRANSITION_BUSY: launch proof receipt is changing'
      USING ERRCODE = '40001';
  END;

  PERFORM 1
    FROM public.tournaments t
   WHERE t.id = ANY(v_ids)
   ORDER BY t.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM unnest(v_ids) AS requested(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.tournaments t WHERE t.id = requested.id
     )
  ) THEN
    RAISE EXCEPTION 'tournament launch proof child names a missing parent'
      USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
    SELECT t.id,
           t.status::text,
           r.launch_id,
           r.lease_generation,
           r.completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts r
        ON r.tournament_id = t.id
     WHERE t.id = ANY(v_ids)
     ORDER BY t.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_ca_tournament_refund_plan(p_tournament_id uuid, p_user_id uuid)
 RETURNS TABLE(source_wallet_club_id uuid, gross_remaining numeric, prize_remaining numeric, bounty_remaining numeric, fee_remaining numeric, debit_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_count bigint;
  v_wallet_total numeric;
  v_charge_count bigint;
  v_charge_total numeric;
  v_refund_count bigint;
  v_refund_total numeric;
  v_tranche_count bigint;
  v_tranche_total numeric;
  v_wallet_gross numeric;
  v_direct_fee numeric;
  v_satellite_fee numeric;
  v_bounty numeric;
  v_satellite_in numeric;
  v_invalid bigint;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'refund plan requires tournament and player ids'
      USING ERRCODE = '22004';
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund plan tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
   ORDER BY e.user_id,e.entitlement_kind,e.id FOR SHARE;
  PERFORM 1 FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id
   ORDER BY tr.user_id,tr.entitlement_id FOR SHARE;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT count(*),round(COALESCE(sum(e.gross),0),2)
    INTO v_charge_count,v_charge_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id
     AND e.entitlement_kind='wallet_charge';
  IF v_wallet_count IS DISTINCT FROM v_charge_count
     OR v_wallet_total IS DISTINCT FROM v_charge_total THEN
    RAISE EXCEPTION
      'tournament % wallet charges and immutable entitlements disagree',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_invalid
    FROM public.tournament_refund_entitlements e
    LEFT JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id
     AND (
       l.id IS NULL OR l.club_id IS DISTINCT FROM e.refund_wallet_club_id
       OR l.amount IS DISTINCT FROM e.gross
       OR (e.entitlement_kind='wallet_charge' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'player_wallet'
         OR l.from_entity_id IS DISTINCT FROM e.user_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR lower(l.category) IS DISTINCT FROM e.charge_category))
       OR (e.entitlement_kind='satellite_seat' AND (
         l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM e.source_satellite_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
       OR (e.entitlement_kind='tournament_ticket' AND (
         l.tournament_id IS DISTINCT FROM e.tournament_id
         OR l.from_type IS DISTINCT FROM 'escrow'
         OR l.from_entity_id IS DISTINCT FROM e.source_ticket_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM e.tournament_id
         OR l.category IS DISTINCT FROM 'ticket_redeem'
         OR l.metadata->>'user_id' IS DISTINCT FROM e.user_id::text
         OR l.metadata->>'registration_id' IS DISTINCT FROM
              e.registration_id::text))
     );
  IF v_invalid <> 0 THEN
    RAISE EXCEPTION 'tournament % has % invalid refund entitlement sources',
      p_tournament_id,v_invalid USING ERRCODE = 'P0404';
  END IF;

  SELECT round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN ('wallet_gross','ticket_gross')
             THEN e.gross
           WHEN e.escrow_bucket='satellite_gross'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind IN ('wallet_charge','tournament_ticket')
             THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.entitlement_kind='satellite_seat' THEN e.refund_fee
           ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket IN (
             'wallet_gross','satellite_gross','ticket_gross')
             THEN e.refund_bounty ELSE 0 END),0),2),
         round(COALESCE(sum(CASE
           WHEN e.escrow_bucket='satellite_in'
             THEN e.refund_prize+e.refund_bounty ELSE 0 END),0),2)
    INTO v_wallet_gross,v_direct_fee,v_satellite_fee,v_bounty,v_satellite_in
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id;
  SELECT * INTO v_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR SHARE;
  IF v_escrow.tournament_id IS NULL
     OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross
     OR v_escrow.fee_entries_in IS DISTINCT FROM v_direct_fee
     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee
     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty
     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN
    RAISE EXCEPTION
      'tournament % escrow does not equal its immutable entitlement rails',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*),round(COALESCE(sum(w.amount),0),2)
    INTO v_refund_count,v_refund_total
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_tranche_count,v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_refund_count IS DISTINCT FROM v_tranche_count
     OR v_refund_total IS DISTINCT FROM v_tranche_total THEN
    RAISE EXCEPTION
      'player % tournament % has refund money without exact entitlement tranches',
      p_user_id,p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
    WHERE tr.tournament_id=p_tournament_id AND (
      e.tournament_id IS DISTINCT FROM tr.tournament_id
      OR e.user_id IS DISTINCT FROM tr.user_id
      OR e.refund_wallet_club_id IS DISTINCT FROM tr.source_wallet_club_id
      OR e.gross IS DISTINCT FROM tr.amount_paid_now
      OR e.refund_prize IS DISTINCT FROM tr.refund_prize
      OR e.refund_bounty IS DISTINCT FROM tr.refund_bounty
      OR e.refund_fee IS DISTINCT FROM tr.refund_fee)
  ) THEN
    RAISE EXCEPTION 'tournament % has a tranche detached from its entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN QUERY
  SELECT e.refund_wallet_club_id,e.gross,e.refund_prize,e.refund_bounty,
         e.refund_fee,1::bigint
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge'
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.fn_spin_ladder_is_the_drawn_one()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected jsonb;
  v_actual   jsonb;
BEGIN
  IF COALESCE(NEW.variant,'') <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Before the wheel is drawn there is no ladder to enforce.
  IF NEW.spin_multiplier IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT structure INTO v_expected
    FROM public.spin_payout_ladder WHERE multiplier = NEW.spin_multiplier;

  -- An unknown multiplier is a real question, not something to guess at.
  IF v_expected IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_actual := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_actual := NULL;
  END;

  IF v_actual IS NOT DISTINCT FROM v_expected THEN
    RETURN NEW;
  END IF;

  NEW.payout_structure := v_expected::text;

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      'critical',
      'fn_spin_ladder_is_the_drawn_one',
      format('Spin %s (%sx) had its payout ladder overwritten with %s; the drawn ladder %s was restored before it could underpay anyone.',
             COALESCE(NEW.name, NEW.id::text), NEW.spin_multiplier,
             COALESCE(v_actual::text,'(unreadable)'), v_expected::text),
      jsonb_build_object('kind','spin_ladder_overwritten',
                         'tournament_id', NEW.id,
                         'multiplier', NEW.spin_multiplier,
                         'was', v_actual,
                         'restored_to', v_expected),
      NEW.id::text);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the correction matters more than the alarm
  END;

  RETURN NEW;
END
$function$;
