-- 20260909174722_spin_draw_books_one_funded_rule_receipt.sql
-- Version reserved by scripts/new-migration.mjs after Supabase CLI creation.
-- Phase 3: selection, reserve booking and the recovery rules commit together.
-- Migration version reserved through the repository allocator after CLI creation.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure))
      IS DISTINCT FROM '107ce74bc2bd8d36f7b5838b58061e41' THEN
    RAISE EXCEPTION 'Spin settlement changed since this correction was reviewed';
  END IF;
END;
$guard$;

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

  -- A claimed operator shortfall has no funding debit. Reject it before
  -- writing a draw or escrow credit. The atomic launch caller excludes such
  -- tiers while holding this same pool lock; this also fences older callers.
  IF v_prize > v_available THEN
    RAISE EXCEPTION 'Spin prize % exceeds funded reserve % for tournament %',
      v_prize, v_available, p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_drawn := v_prize;

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


-- No hot-parent FK: the launch RPC validates and locks the parent. Evidence
-- survives tournament retirement; application roles cannot mutate receipts.
CREATE TABLE public.spin_draw_receipts (
  tournament_id uuid PRIMARY KEY,
  launch_id uuid NOT NULL,
  lease_generation uuid NOT NULL,
  rule_manifest jsonb NOT NULL,
  rule_sha256 text NOT NULL CHECK (rule_sha256 ~ '^[0-9a-f]{64}$'),
  entrants jsonb NOT NULL CHECK (jsonb_array_length(entrants) = 3),
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
ALTER TABLE public.spin_draw_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.spin_draw_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.spin_draw_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.trg_spin_draw_receipt_is_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'A booked Spin draw receipt is immutable' USING ERRCODE = '23514';
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_spin_draw_receipt_is_immutable() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER spin_draw_receipt_is_immutable
BEFORE UPDATE OR DELETE ON public.spin_draw_receipts
FOR EACH ROW EXECUTE FUNCTION public.trg_spin_draw_receipt_is_immutable();

CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(
  p_tournament_id uuid,
  p_launch_id uuid,
  p_lease_generation uuid,
  p_rule_manifest jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_launch public.tournament_launch_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_saved public.spin_draw_receipts%ROWTYPE;
  v_player record;
  v_entrants jsonb;
  v_paid numeric;
  v_entitled numeric;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_wallet_gross numeric;
  v_manifest jsonb;
  v_hash text;
  v_tier jsonb;
  v_draw jsonb;
  v_settle jsonb;
  v_entry jsonb;
  v_receipt jsonb;
  v_multiplier numeric;
  v_prize numeric;
  v_count bigint;
  v_covered numeric;
  v_provenance text := 'at_draw';
  v_blinds jsonb;
  v_payouts jsonb;
  v_locked jsonb;
  v_freq numeric;
  v_weight numeric;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;
  SELECT * INTO v_lease FROM public.engine_tournament_leases
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_lease.protocol_version IS DISTINCT FROM 2
     OR v_lease.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_lease.heartbeat_at IS NULL
     OR v_lease.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  -- Same receipt -> parent order as registration, launch and cancellation.
  PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(ARRAY[p_tournament_id]);
  SELECT * INTO v_launch FROM public.tournament_launch_receipts
   WHERE tournament_id = p_tournament_id;
  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id;
  IF v_launch.launch_id IS DISTINCT FROM p_launch_id
     OR v_launch.lease_generation IS DISTINCT FROM p_lease_generation
     OR v_launch.completed_at IS NOT NULL
     OR v_t.status IS DISTINCT FROM 'REGISTERING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_state_mismatch');
  END IF;
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_purchases_frozen');
  END IF;
  IF v_t.variant IS DISTINCT FROM 'spin' OR v_t.max_players IS DISTINCT FROM 3
     OR COALESCE(v_t.buy_in_amount, 0) <= 0
     OR COALESCE(v_t.buy_in_fee, 0) <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_spin_contract');
  END IF;

  SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
           'user_id', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_entrants
    FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
     AND p.status IN ('registered', 'playing');
  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND p.status IN ('registered', 'playing')) <> 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_field_unproven');
  END IF;

  -- Spin admission proves net paid entries directly. The generic refund
  -- planner compares advertised entry fees with escrow.fee_entries_in, but
  -- Spin escrow records its embedded 8% rake there despite buy_in_fee=0.
  -- A payout/refund policy comparison cannot stand in for this payment proof.
  SELECT * INTO v_escrow FROM public.tournament_escrow
   WHERE tournament_id = p_tournament_id FOR UPDATE;
  SELECT COALESCE(sum(w.amount), 0) INTO v_wallet_gross
    FROM public.wallet_transactions w WHERE w.related_entity_id = p_tournament_id
     AND w.type = 'debit' AND lower(w.category) = 'tournament_buyin';
  IF v_escrow.tournament_id IS NULL OR v_escrow.enforced IS DISTINCT FROM true
     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'spin_entry_escrow_unproven');
  END IF;
  FOR v_player IN SELECT p.user_id FROM public.tournament_players p
    WHERE p.tournament_id = p_tournament_id AND p.status IN ('registered', 'playing')
    ORDER BY p.user_id LOOP
    -- The wallet receipt proves what this player still paid, including any
    -- prior refund. Immutable entitlements independently prove the original
    -- debit's exact wallet -> tournament double-entry leg and its consumption.
    SELECT COALESCE(sum(CASE
      WHEN w.type='debit' AND lower(w.category)='tournament_buyin' THEN w.amount
      WHEN w.type='credit' AND lower(w.category) IN ('refund','tournament_refund') THEN -w.amount
      ELSE 0 END), 0) INTO v_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=p_tournament_id AND w.user_id=v_player.user_id;
    SELECT COALESCE(sum(e.gross), 0) INTO v_entitled
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
       AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross
       AND l.tournament_id=e.tournament_id AND l.from_type='player_wallet'
       AND l.from_entity_id=e.user_id AND l.to_type='prize_liability'
       AND l.to_entity_id=e.tournament_id AND lower(l.category)=e.charge_category
     WHERE e.tournament_id=p_tournament_id AND e.user_id=v_player.user_id
       AND e.entitlement_kind='wallet_charge' AND e.charge_category='tournament_buyin'
       AND e.refund_fee=0 AND e.refund_bounty=0
       AND NOT EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.source_refund_entitlement_id=e.id);
    IF v_paid IS DISTINCT FROM v_t.buy_in_amount OR v_entitled IS DISTINCT FROM v_paid THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_paid_entry_unproven');
    END IF;
  END LOOP;

  SELECT * INTO v_saved FROM public.spin_draw_receipts WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_saved.launch_id IS DISTINCT FROM p_launch_id
       OR v_saved.entrants IS DISTINCT FROM v_entrants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_receipt_roster_mismatch');
    END IF;
    -- A new owner or newer rules cannot reroll or rewrite a committed result.
    RETURN v_saved.receipt || jsonb_build_object('replay', true);
  END IF;

  SELECT count(*), min(l.multiplier), min(-l.amount)
    INTO v_count, v_multiplier, v_covered FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = p_tournament_id AND l.kind = 'jackpot_draw';
  IF v_count > 0 THEN
    -- Cutover recovery uses the already projected rules. It does not pretend
    -- that a historical probability snapshot exists or replace it with today's.
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    IF v_count <> 1 OR v_multiplier IS DISTINCT FROM v_t.spin_multiplier
       OR v_covered IS DISTINCT FROM v_prize OR COALESCE(v_multiplier, 0) <= 0
       OR jsonb_typeof(v_t.blind_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.blind_structure::jsonb) = 0
       OR jsonb_typeof(v_t.payout_structure::jsonb) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_t.payout_structure::jsonb) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_spin_rules_unproven');
    END IF;
    v_provenance := 'legacy_projection';
    v_blinds := v_t.blind_structure::jsonb;
    v_payouts := v_t.payout_structure::jsonb;
    v_locked := COALESCE(v_t.spin_locked_tiers::jsonb, '[]'::jsonb);
    v_manifest := jsonb_build_object('version', 1, 'probability_snapshot', NULL,
      'buy_in', v_t.buy_in_amount, 'seats', 3, 'starting_chips', v_t.starting_chips,
      'multiplier', v_multiplier, 'blind_structure', v_blinds, 'payout_structure', v_payouts);
    v_settle := jsonb_build_object('pool_covered', v_covered, 'operator_shortfall', 0);
  ELSE
    IF v_t.spin_multiplier IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'projected_spin_draw_has_no_funding_proof');
    END IF;
    v_manifest := p_rule_manifest;
    IF v_manifest IS NULL OR (v_manifest->>'version')::int IS DISTINCT FROM 1
       OR (v_manifest->>'buy_in')::numeric IS DISTINCT FROM v_t.buy_in_amount
       OR (v_manifest->>'seats')::int IS DISTINCT FROM 3
       OR (v_manifest->>'starting_chips')::int IS DISTINCT FROM v_t.starting_chips
       OR (v_manifest->>'rake_rate')::numeric IS DISTINCT FROM public.fn_spin_rake_rate(v_t.buy_in_amount)
       OR jsonb_typeof(v_manifest->'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_manifest->'tiers') = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;
    v_manifest := v_manifest || jsonb_build_object('draw_function_md5',
      md5(pg_get_functiondef('public.fn_spin_draw_multiplier(uuid,numeric,jsonb,numeric,integer)'::regprocedure)));
    v_freq := 0; v_weight := 0;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(v_manifest->'tiers') LOOP
      IF jsonb_typeof(v_tier->'freq') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_tier->'multiplier') IS DISTINCT FROM 'number'
         OR COALESCE((v_tier->>'freq')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'multiplier')::numeric, 0) <= 0
         OR COALESCE((v_tier->>'reserveThresholdX')::numeric, -1) < 0
         OR jsonb_typeof(v_tier->'blind_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'blind_structure') <> 12
         OR (v_tier#>>'{blind_structure,11,spinContinuation,version}')::int IS DISTINCT FROM 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorLevel}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,anchorBigBlind}')::numeric, 0) <= 0
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,growth}')::numeric, 0) <= 1
         OR COALESCE((v_tier#>>'{blind_structure,11,spinContinuation,roundBigTo}')::numeric, 0) <= 0
         OR jsonb_typeof(v_tier->'payout_structure') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_tier->'payout_structure') NOT BETWEEN 1 AND 3
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'blind_structure') WITH ORDINALITY b(value, ordinal)
            WHERE (b.value->>'level')::numeric IS DISTINCT FROM b.ordinal::numeric
               OR COALESCE((b.value->>'smallBlind')::numeric, 0) <= 0
               OR COALESCE((b.value->>'bigBlind')::numeric, 0) < (b.value->>'smallBlind')::numeric
               OR COALESCE((b.value->>'duration')::numeric, 0) <= 0
               OR (b.value->>'ante')::numeric IS DISTINCT FROM 0::numeric)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_tier->'payout_structure') WITH ORDINALITY p(value, ordinal)
            WHERE (p.value->>'place')::numeric IS DISTINCT FROM p.ordinal::numeric
               OR COALESCE((p.value->>'percentage')::numeric, 0) <= 0)
         OR (SELECT sum((x->>'percentage')::numeric)
               FROM jsonb_array_elements(v_tier->'payout_structure') x) IS DISTINCT FROM 100::numeric THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
      END IF;
      v_freq := v_freq + (v_tier->>'freq')::numeric;
      v_weight := v_weight + (v_tier->>'freq')::numeric * (v_tier->>'multiplier')::numeric;
    END LOOP;
    IF v_weight <> v_freq * 3 * (1 - (v_manifest->>'rake_rate')::numeric)
       OR (SELECT count(DISTINCT x->>'multiplier') FROM jsonb_array_elements(v_manifest->'tiers') x)
           <> jsonb_array_length(v_manifest->'tiers') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'spin_rule_manifest_invalid');
    END IF;

    -- Entry owns escrow -> entry advisory -> reserve locks. Its committed net
    -- contribution must be present before the affordability gate is evaluated.
    v_entry := public.fn_spin_book_entry(p_tournament_id);
    IF NOT COALESCE((v_entry->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin entry booking failed: %', v_entry USING ERRCODE = 'P0404';
    END IF;
    IF (SELECT count(*) FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger l
         WHERE l.tournament_id=p_tournament_id AND l.kind='contribution'
           AND l.club_id=public.fn_spin_reserve_pool(v_t.club_id)
           AND l.seats=3 AND l.buy_in=v_t.buy_in_amount
           AND l.house_rake=round(3*v_t.buy_in_amount*(v_manifest->>'rake_rate')::numeric, 2)
           AND l.amount=round(3*v_t.buy_in_amount, 2)-l.house_rake) THEN
      RAISE EXCEPTION 'Spin contribution does not prove the three funded entries' USING ERRCODE = 'P0404';
    END IF;
    -- Zero hypothetical seats: all three paid entries are already in balance.
    -- The draw's pool row lock remains held through settlement and the receipt.
    v_draw := public.fn_spin_draw_multiplier(v_t.club_id, v_t.buy_in_amount,
      v_manifest->'tiers', (v_manifest->>'rake_rate')::numeric, 0);
    IF NOT COALESCE((v_draw->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin funded draw unavailable: %', v_draw USING ERRCODE = 'P0404';
    END IF;
    v_multiplier := (v_draw->>'multiplier')::numeric;
    v_prize := round(v_t.buy_in_amount * v_multiplier, 2);
    SELECT value INTO STRICT v_tier FROM jsonb_array_elements(v_manifest->'tiers')
     WHERE (value->>'multiplier')::numeric = v_multiplier;
    v_blinds := v_tier->'blind_structure';
    v_payouts := v_tier->'payout_structure';
    v_locked := COALESCE(v_draw->'locked', '[]'::jsonb);
    v_settle := public.fn_spin_settle_game(p_tournament_id, v_t.club_id,
      v_t.buy_in_amount, 3, v_multiplier, (v_manifest->>'rake_rate')::numeric);
    IF NOT COALESCE((v_settle->>'ok')::boolean, false)
       OR (v_settle->>'pool_covered')::numeric IS DISTINCT FROM v_prize
       OR COALESCE((v_settle->>'operator_shortfall')::numeric, 0) <> 0
       OR v_settle->>'reason' = 'already_settled' THEN
      -- Raising rolls back entry, draw and any transitive escrow write too.
      RAISE EXCEPTION 'Spin settlement does not prove the selected funded prize: %', v_settle
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_hash := encode(extensions.digest(v_manifest::text, 'sha256'), 'hex');
  v_receipt := v_settle || jsonb_build_object('ok', true, 'replay', false,
    'tournament_id', p_tournament_id, 'launch_id', p_launch_id,
    'multiplier', v_multiplier, 'prize_pool', v_prize, 'buy_in', v_t.buy_in_amount,
    'starting_chips', v_t.starting_chips, 'blind_structure', v_blinds,
    'payout_structure', v_payouts, 'locked', v_locked, 'entrants', v_entrants,
    'rule_manifest', v_manifest, 'rule_sha256', v_hash, 'rule_provenance', v_provenance,
    'draw_inputs', v_draw);
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,
    rule_manifest, rule_sha256, entrants, receipt)
  VALUES (p_tournament_id, p_launch_id, p_lease_generation, v_manifest, v_hash, v_entrants, v_receipt);
  RETURN v_receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb) TO service_role;

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_spin_ladder_is_the_drawn_one()'::regprocedure))
      IS DISTINCT FROM '0b3e2d6c78407ca10e12a6dae6ef88d1' THEN
    RAISE EXCEPTION 'Spin payout guard changed since this correction was reviewed';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.fn_spin_ladder_is_the_drawn_one()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_expected jsonb;
  v_actual   jsonb;
  v_booked jsonb;
BEGIN
  SELECT r.receipt INTO v_booked FROM public.spin_draw_receipts r
   WHERE r.tournament_id=NEW.id;
  IF v_booked IS NOT NULL THEN
    IF NEW.variant IS DISTINCT FROM 'spin'
       OR NEW.buy_in_amount IS DISTINCT FROM (v_booked->>'buy_in')::numeric
       OR NEW.starting_chips IS DISTINCT FROM (v_booked->>'starting_chips')::int THEN
      RAISE EXCEPTION 'A booked Spin keeps its funded entry and board contract' USING ERRCODE='23514';
    END IF;
    -- Do not project the secret before the engine's reveal. Once projected,
    -- clearing or replacing that result cannot detach it from its receipt.
    IF NEW.spin_multiplier IS NULL AND TG_OP='UPDATE' AND OLD.spin_multiplier IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.spin_multiplier IS DISTINCT FROM (v_booked->>'multiplier')::numeric THEN
      RAISE EXCEPTION 'A booked Spin keeps its original multiplier' USING ERRCODE='23514';
    END IF;
    v_expected := v_booked->'payout_structure';
    NEW.blind_structure := (v_booked->'blind_structure')::text;
  ELSIF COALESCE(NEW.variant,'') <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Before the wheel is drawn there is no ladder to enforce.
  IF NEW.spin_multiplier IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_booked IS NULL THEN
    SELECT structure INTO v_expected
      FROM public.spin_payout_ladder WHERE multiplier = NEW.spin_multiplier;
  END IF;

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

COMMIT;
