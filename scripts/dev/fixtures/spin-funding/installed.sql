CREATE OR REPLACE FUNCTION public.fn_spin_draw_multiplier(p_club_id uuid, p_buy_in numeric, p_tiers jsonb, p_rake_rate numeric DEFAULT 0.08, p_seats integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_bal numeric := 0; v_stake numeric := 0; v_contrib numeric := 0;
  v_eligible jsonb := '[]'::jsonb; v_tier jsonb;
  v_total numeric := 0; v_roll numeric; v_acc numeric := 0;
  v_pick numeric := NULL; v_locked jsonb := '[]'::jsonb;
  v_prize numeric; v_thr numeric; v_owner uuid;
  v_pending numeric := 0;
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);

  -- FOR UPDATE: concurrent draws on the same pool serialize here (and with
  -- fn_spin_settle_game, which locks the same row), so two spins can no
  -- longer pass the affordability gate against the same chips.
  SELECT balance, GREATEST(highest_stake, COALESCE(p_buy_in,0))
    INTO v_bal, v_stake FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- Prizes already drawn against this pool but not yet settled: their spin
  -- rows carry a multiplier while no jackpot_draw ledger row exists yet.
  -- Bounded to 24h; anything older is the sweep's business, and the settle
  -- normally follows its draw within milliseconds.
  SELECT COALESCE(sum(round(t.buy_in_amount * t.spin_multiplier, 2)), 0)
    INTO v_pending
    FROM public.tournaments t
   WHERE t.variant = 'spin'
     AND t.spin_multiplier IS NOT NULL
     AND t.created_at > now() - interval '24 hours'
     AND t.status NOT IN ('COMPLETED','CANCELLED','CANCELED')
     AND public.fn_spin_reserve_pool(t.club_id) = v_owner
     AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
                     WHERE l.tournament_id = t.id AND l.kind = 'jackpot_draw');
  v_bal := v_bal - v_pending;

  v_contrib := round(COALESCE(p_buy_in,0) * COALESCE(p_seats,3)
                     * (1 - COALESCE(p_rake_rate,0.08)), 2);

  FOR v_tier IN SELECT * FROM jsonb_array_elements(p_tiers) LOOP
    v_prize := (v_tier->>'multiplier')::numeric * COALESCE(p_buy_in,0);
    v_thr   := COALESCE((v_tier->>'reserveThresholdX')::numeric, 0);

    IF (v_bal + v_contrib) < v_prize THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'unaffordable',
        'unlocksAt', round(v_prize - v_contrib, 2));
    ELSIF v_thr > 0 AND v_bal < (v_tier->>'multiplier')::numeric * v_stake * v_thr THEN
      v_locked := v_locked || jsonb_build_object(
        'multiplier', (v_tier->>'multiplier')::numeric,
        'reason', 'threshold',
        'unlocksAt', round((v_tier->>'multiplier')::numeric * v_stake * v_thr, 2));
    ELSE
      v_eligible := v_eligible || v_tier;
      v_total := v_total + COALESCE((v_tier->>'freq')::numeric, 0);
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_eligible_tiers',
      'reserve_balance', v_bal, 'locked', v_locked, 'owner_id', v_owner);
  END IF;

  v_roll := (('x' || encode(extensions.gen_random_bytes(6),'hex'))::bit(48)::bigint)::numeric
            / 281474976710656::numeric * v_total;

  FOR v_tier IN SELECT * FROM jsonb_array_elements(v_eligible) LOOP
    v_acc := v_acc + COALESCE((v_tier->>'freq')::numeric,0);
    IF v_roll < v_acc THEN v_pick := (v_tier->>'multiplier')::numeric; EXIT; END IF;
  END LOOP;
  IF v_pick IS NULL THEN
    v_pick := (v_eligible -> (jsonb_array_length(v_eligible)-1) ->> 'multiplier')::numeric;
  END IF;

  RETURN jsonb_build_object('ok', true, 'multiplier', v_pick,
    'reserve_balance', v_bal, 'highest_stake', v_stake,
    'contribution', v_contrib, 'locked', v_locked, 'owner_id', v_owner,
    'eligible_count', jsonb_array_length(v_eligible));
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_spin_settle_game(p_tournament_id uuid, p_club_id uuid, p_buy_in numeric, p_seats integer, p_multiplier numeric, p_rake_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_collected numeric; v_rake numeric; v_reserve_in numeric;
  v_prize numeric; v_bal numeric; v_available numeric;
  v_shortfall numeric := 0; v_drawn numeric;
  v_owner uuid; v_kind text; v_seed numeric; v_wallet text;
  v_floor numeric; v_instalment numeric := 0;
  v_seed_returned numeric := 0; v_wallet_after numeric := NULL;
  v_booked_mult numeric; v_booked_drawn numeric;
  v_entry_booked boolean;
  v_rake_booked boolean;
BEGIN
  IF COALESCE(p_buy_in,0) <= 0 OR COALESCE(p_seats,0) <= 0 OR COALESCE(p_multiplier,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  v_owner := public.fn_spin_reserve_pool(p_club_id);

  SELECT balance INTO v_bal
    FROM public.spin_bonus_pools WHERE club_id = v_owner FOR UPDATE;

  -- THE PRIZE IS WHAT THIS FUNCTION OWNS. A contribution row on its own means
  -- the entry was booked when the last seat was paid and the prize still is
  -- not; only a jackpot_draw row means settled.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
             WHERE tournament_id = p_tournament_id AND kind = 'jackpot_draw') THEN
    SELECT l.multiplier, -l.amount INTO v_booked_mult, v_booked_drawn
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw'
     ORDER BY l.created_at ASC LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'reason', 'already_settled',
      'multiplier', v_booked_mult, 'pool_covered', v_booked_drawn);
  END IF;

  v_collected  := round(p_buy_in * p_seats, 2);
  v_rake       := round(v_collected * COALESCE(p_rake_rate, 0.08), 2);
  v_reserve_in := round(v_collected - v_rake, 2);
  v_prize      := round(p_buy_in * p_multiplier, 2);

  v_entry_booked := EXISTS (SELECT 1 FROM public.spin_reserve_ledger
                             WHERE tournament_id = p_tournament_id AND kind = 'contribution');
  v_rake_booked  := EXISTS (SELECT 1 FROM public.rake_records
                             WHERE tournament_id = p_tournament_id
                               AND source IN ('fn_spin_book_entry','fn_spin_settle_game'));

  IF NOT v_entry_booked THEN
    -- ZERO-DRIFT phase 2: reserve intake = spin_entry vs the tournament.
    PERFORM set_config('app.ledger_category', 'spin_entry', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.spin_bonus_pools
       SET balance = balance + v_reserve_in,
           total_deposited = total_deposited + v_reserve_in,
           spin_count = spin_count + 1,
           highest_stake = GREATEST(highest_stake, p_buy_in),
           updated_at = now()
     WHERE club_id = v_owner RETURNING balance INTO v_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;

    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
    VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_available,
            p_multiplier, p_buy_in, p_seats, v_rake,
            CASE WHEN v_owner = p_club_id THEN 'buy-ins less fixed rake'
                 ELSE format('buy-ins less fixed rake (club %s)', p_club_id) END);
  ELSE
    -- Already funded at entry. Read where the pool actually stands.
    SELECT balance INTO v_available
      FROM public.spin_bonus_pools WHERE club_id = v_owner;
    IF v_available IS NULL THEN
      RAISE EXCEPTION 'spin pool row missing for owner % settling tournament %',
        v_owner, p_tournament_id;
    END IF;
  END IF;

  IF v_prize > v_available THEN
    v_shortfall := round(v_prize - v_available, 2);
    v_drawn := v_available;
  ELSE
    v_drawn := v_prize;
  END IF;

  -- ZERO-DRIFT phase 2: the draw funds the tournament's prize pool.
  -- CHIP STANDARD 1.3 (2026-09-02): ... and names the tournament it funds. With only
  -- the category set, this leg landed spin_reserve -> settlement_suspense (3,303 rows
  -- / 185,189.00 a day, R9). service_role-only, so the primitive is used.
  PERFORM public.fn_ca_declare_ledger('spin_prize', 'prize_liability', p_tournament_id);

  UPDATE public.spin_bonus_pools
     SET balance = balance - v_drawn,
         total_drawn = total_drawn + v_drawn,
         bonus_count = bonus_count + CASE WHEN p_multiplier >= 10 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE club_id = v_owner RETURNING balance INTO v_bal;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'jackpot_draw', -v_drawn, v_bal,
          p_multiplier, p_buy_in, p_seats, v_rake,
          CASE WHEN v_shortfall > 0
               THEN format('prize pool (pool covered %s of %s)', v_drawn, v_prize)
               ELSE 'prize pool' END);

  IF v_shortfall > 0 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, note)
    VALUES (v_owner, p_tournament_id, 'adjustment', 0, v_bal,
            p_multiplier, p_buy_in, p_seats,
            format('SHORTFALL %s covered by operator - pool was too thin for a %sx. Seed it.',
                   v_shortfall, p_multiplier));
  END IF;

  IF v_rake > 0 AND p_club_id IS NOT NULL AND NOT v_rake_booked THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, p_club_id, v_rake, v_collected, p_seats, 0, true,
            p_tournament_id, 'fn_spin_settle_game',
            jsonb_build_object('kind','spin_rake','multiplier',p_multiplier,
                               'buy_in',p_buy_in,'rake_rate',p_rake_rate,
                               'shortfall',v_shortfall,'reserve_owner',v_owner));
  END IF;

  -- THE REPAYMENT PLAN - one instalment per settle, at most.
  SELECT seeded_amount, seed_source_wallet, owner_kind, required_seed_at_activation
    INTO v_seed, v_wallet, v_kind, v_floor
    FROM public.spin_bonus_pools WHERE club_id = v_owner;

  v_instalment := public.fn_spin_seed_instalment(v_bal, COALESCE(v_seed,0), COALESCE(v_floor,0));

  IF v_instalment > 0 AND v_wallet IS NOT NULL THEN
    PERFORM set_config('app.ledger_category', 'treasury_transfer', true);
    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_entity', v_owner::text, true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(v_owner, v_kind, v_wallet, v_instalment);

    IF v_wallet_after IS NOT NULL THEN
      UPDATE public.spin_bonus_pools
         SET balance              = balance - v_instalment,
             seeded_amount        = seeded_amount - v_instalment,
             seed_returned_amount = seed_returned_amount + v_instalment,
             seed_returned_at     = now(),
             required_seed_at_activation =
               CASE WHEN seeded_amount - v_instalment <= 0 THEN 0
                    ELSE required_seed_at_activation END,
             updated_at           = now()
       WHERE club_id = v_owner RETURNING balance INTO v_bal;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'spin pool row vanished for owner % after repaying % to %',
          v_owner, v_instalment, v_wallet;
      END IF;

      v_seed_returned := v_instalment;

      INSERT INTO public.spin_reserve_ledger
        (club_id, tournament_id, kind, amount, balance_after, note)
      VALUES (v_owner, p_tournament_id, 'seed_return', -v_instalment, v_bal,
              format('seed instalment to %s %s - 50%% of %s above a floor of %s; %s still owed',
                     v_kind, v_wallet, round(v_bal + v_instalment - v_floor, 2), v_floor,
                     GREATEST(COALESCE(v_seed,0) - v_instalment, 0)));
    END IF;

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in, 'prize_pool', v_prize,
    'pool_covered', v_drawn, 'operator_shortfall', v_shortfall,
    'balance', v_bal, 'seed_returned', v_seed_returned,
    'entry_booked_at_seat', v_entry_booked,
    'seed_outstanding', GREATEST(COALESCE(v_seed,0) - v_seed_returned, 0),
    'owner_id', v_owner, 'source_wallet_after', v_wallet_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_spin_shortfall_funds_the_escrow()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_drawn     numeric;
  v_prize     numeric;
  v_shortfall numeric;
BEGIN
  IF NEW.kind <> 'adjustment' OR NEW.note IS NULL OR NEW.note NOT LIKE 'SHORTFALL %' THEN
    RETURN NULL;
  END IF;
  IF COALESCE(NEW.multiplier, 0) <= 0 OR COALESCE(NEW.buy_in, 0) <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT -l.amount INTO v_drawn
    FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = NEW.tournament_id AND l.kind = 'jackpot_draw'
   ORDER BY l.created_at ASC LIMIT 1;

  v_prize     := round(NEW.multiplier * NEW.buy_in, 2);
  v_shortfall := round(v_prize - COALESCE(v_drawn, 0), 2);
  IF v_shortfall <= 0 THEN
    RETURN NULL;
  END IF;

  PERFORM public.fn_ca_escrow_apply(
    NEW.tournament_id,
    'spin reserve shortfall covered by the operator',
    0, 0, 0, 0, v_shortfall
  );
  RETURN NULL;
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

CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid DEFAULT NULL::uuid, p_settlement_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_autoskip_tables text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$;