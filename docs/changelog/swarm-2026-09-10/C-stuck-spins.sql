-- ============================================================================
-- C — Stuck Spins.  ANALYSIS ONLY.  Nothing in this file has been applied.
--
-- Part 1: the rolled-back probes exactly as they were run (safe to re-run: each
--         ends in RAISE EXCEPTION and rolls back; the error text is the result).
-- Part 2: DRAFT migration (COMMENTED OUT) for the orchestrator — DDL.
-- Part 3: ROLLBACK — the ORIGINAL definitions of what Part 2 replaces.
-- Do NOT wrap in BEGIN/COMMIT (the orchestrator batches).
-- ============================================================================


-- ============================================================================
-- PART 1a — PROBE 1 (ROLLED BACK).  Ran 2026-09-10 03:2x UTC, result in C-stuck-spins.md §1.3
--   step 1: the engine's exact RPC with the REAL manifest -> projected_spin_draw_has_no_funding_proof
--   step 2: UPDATE spin_multiplier = NULL -> refused by trigger spin_tournament_contract_is_draw
--   step 3: draw + settle + row stamp through the platform's own functions -> ok, money moves cleanly
--   step 4: the atomic RPC again -> ok (legacy_projection), receipt booked
-- ============================================================================
DO $probe$
DECLARE
  c_tid constant uuid := 'a9c5e229-001b-4a49-af0a-f1b703f29dfa';
  v_t public.tournaments%ROWTYPE;
  v_launch public.tournament_launch_receipts%ROWTYPE;
  v_lease public.engine_tournament_leases%ROWTYPE;
  v_esc0 public.tournament_escrow%ROWTYPE;
  v_esc1 public.tournament_escrow%ROWTYPE;
  v_owner uuid; v_pool0 numeric; v_pool1 numeric;
  v_sb numeric[] := ARRAY[10,15,20,30,40,50,60,75,90,105,145,205];
  v_blinds jsonb; v_tiers jsonb := '[]'::jsonb; v_manifest jsonb; v_tier record;
  v_gate1 jsonb; v_gate2 jsonb; v_draw jsonb; v_settle jsonb;
  v_null_err text := 'no error';
  v_mult numeric; v_prize numeric;
  v_ledger jsonb; v_rcpt int; v_chip_legs jsonb; v_row jsonb;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '20s';

  -- manifest, content-identical to spinRuleManifest(10, 1000) at engine commit 1695880b
  -- (generated from server/src/tournament/SpinDrawReceipt.ts + config/spinSpec.ts and cross-checked)
  SELECT jsonb_agg(jsonb_build_object('level', i, 'smallBlind', v_sb[i], 'bigBlind', v_sb[i]*2, 'ante', 0, 'duration', 180)
         || CASE WHEN i = 12 THEN jsonb_build_object('spinContinuation', jsonb_build_object('version',1,'anchorLevel',10,'anchorBigBlind',210,'growth',1.4,'roundBigTo',10)) ELSE '{}'::jsonb END
         ORDER BY i)
    INTO v_blinds FROM generate_series(1,12) i;
  FOR v_tier IN SELECT * FROM (VALUES
      (2::numeric, 4809776::numeric, '[1]'::jsonb, 0::numeric),
      (3, 3930716, '[1]', 0), (4, 900000, '[1]', 0), (5, 250000, '[1]', 0),
      (10, 100000, '[0.8,0.2]', 0), (25, 7500, '[0.8,0.12,0.08]', 0),
      (50, 1000, '[0.8,0.12,0.08]', 0), (100, 1008, '[0.8,0.12,0.08]', 1.5)) AS x(m, f, p, thr)
  LOOP
    v_tiers := v_tiers || jsonb_build_object('multiplier', v_tier.m, 'freq', v_tier.f, 'payouts', v_tier.p,
      'levelMinutes', 3, 'reserveThresholdX', v_tier.thr, 'blind_structure', v_blinds,
      'payout_structure', (SELECT jsonb_agg(jsonb_build_object('place', o, 'percentage', round((e::numeric)*100, 2)) ORDER BY o)
                             FROM jsonb_array_elements_text(v_tier.p) WITH ORDINALITY q(e, o)));
  END LOOP;
  v_manifest := jsonb_build_object('version',1,'buy_in',10,'seats',3,'rake_rate',0.08,'starting_chips',1000,'tiers',v_tiers);

  SELECT * INTO v_t FROM public.tournaments WHERE id = c_tid;
  SELECT * INTO v_launch FROM public.tournament_launch_receipts WHERE tournament_id = c_tid;
  SELECT * INTO v_lease FROM public.engine_tournament_leases WHERE tournament_id = c_tid;
  SELECT * INTO v_esc0 FROM public.tournament_escrow WHERE tournament_id = c_tid;
  v_owner := public.fn_spin_reserve_owner(v_t.club_id);
  SELECT balance INTO v_pool0 FROM public.spin_bonus_pools WHERE club_id = v_owner;

  -- STEP 1: the engine's exact call, with the real manifest (not NULL)
  v_gate1 := public.fn_spin_draw_and_settle_atomic(c_tid, v_launch.launch_id, v_lease.lease_generation, v_manifest);

  -- STEP 2: is a data-only repair (spin_multiplier 0 -> NULL) even allowed?
  BEGIN
    UPDATE public.tournaments SET spin_multiplier = NULL WHERE id = c_tid;
  EXCEPTION WHEN OTHERS THEN
    v_null_err := SQLSTATE || ' ' || SQLERRM;
  END;

  -- STEP 3: the draw + settle + row projection the pre-atomic engine performed
  v_draw := public.fn_spin_draw_multiplier(v_t.club_id, v_t.buy_in_amount, v_manifest->'tiers', 0.08, 0);
  v_mult := (v_draw->>'multiplier')::numeric;
  v_prize := round(v_t.buy_in_amount * v_mult, 2);
  v_settle := public.fn_spin_settle_game(c_tid, v_t.club_id, v_t.buy_in_amount, 3, v_mult, 0.08);
  UPDATE public.tournaments SET spin_multiplier = v_mult, prize_pool = v_prize,
         spin_locked_tiers = COALESCE(v_draw->'locked', '[]'::jsonb)
   WHERE id = c_tid;

  -- STEP 4: the atomic authority again, now that a funded draw + projection exist (legacy_projection branch)
  v_gate2 := public.fn_spin_draw_and_settle_atomic(c_tid, v_launch.launch_id, v_lease.lease_generation, v_manifest);

  SELECT * INTO v_esc1 FROM public.tournament_escrow WHERE tournament_id = c_tid;
  SELECT balance INTO v_pool1 FROM public.spin_bonus_pools WHERE club_id = v_owner;
  SELECT jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'multiplier', multiplier, 'balance_after', balance_after) ORDER BY created_at)
    INTO v_ledger FROM public.spin_reserve_ledger WHERE tournament_id = c_tid;
  SELECT jsonb_agg(jsonb_build_object('cat', category, 'from', from_type, 'to', to_type, 'amt', amount) ORDER BY created_at)
    INTO v_chip_legs FROM public.chip_ledger WHERE tournament_id = c_tid AND category IN ('spin_entry','spin_prize');
  SELECT count(*) INTO v_rcpt FROM public.spin_draw_receipts WHERE tournament_id = c_tid;
  SELECT jsonb_build_object('spin_multiplier', spin_multiplier, 'prize_pool', prize_pool, 'locked', spin_locked_tiers, 'status', status)
    INTO v_row FROM public.tournaments WHERE id = c_tid;

  RAISE EXCEPTION 'PROBE_ROLLED_BACK %', jsonb_pretty(jsonb_build_object(
    'tournament', c_tid,
    'row_before', jsonb_build_object('spin_multiplier', v_t.spin_multiplier, 'prize_pool', v_t.prize_pool, 'buy_in', v_t.buy_in_amount, 'starting_chips', v_t.starting_chips),
    'manifest_sha256', encode(extensions.digest(v_manifest::text, 'sha256'), 'hex'),
    'step1_gate_with_real_manifest', v_gate1,
    'step2_null_multiplier_update', v_null_err,
    'step3_draw', v_draw - 'locked',
    'step3_settle', v_settle,
    'step4_gate_after_funded_draw', jsonb_build_object('ok', v_gate2->'ok', 'reason', v_gate2->'reason', 'replay', v_gate2->'replay',
        'multiplier', v_gate2->'multiplier', 'prize_pool', v_gate2->'prize_pool', 'rule_provenance', v_gate2->'rule_provenance',
        'pool_covered', v_gate2->'pool_covered', 'operator_shortfall', v_gate2->'operator_shortfall'),
    'pool_balance_before', v_pool0, 'pool_balance_after', v_pool1,
    'escrow_before', jsonb_build_object('gross_in', v_esc0.gross_in, 'reserve_out', v_esc0.reserve_out, 'reserve_in', v_esc0.reserve_in, 'prize_balance', v_esc0.prize_balance, 'fee_balance', v_esc0.fee_balance),
    'escrow_after',  jsonb_build_object('gross_in', v_esc1.gross_in, 'reserve_out', v_esc1.reserve_out, 'reserve_in', v_esc1.reserve_in, 'prize_balance', v_esc1.prize_balance, 'fee_balance', v_esc1.fee_balance),
    'reserve_ledger_after', v_ledger,
    'chip_legs_after', v_chip_legs,
    'spin_draw_receipts_after', v_rcpt,
    'row_after', v_row));
END $probe$;

-- Observed (rolled back):
--   step1  {"ok":false,"reason":"projected_spin_draw_has_no_funding_proof"}
--   step2  P0404 Spin a9c5e229-… tournament contract must equal its one immutable reserve draw
--   step3  draw 2x ok; settle ok (pool 56546.52 -> 56526.52, escrow reserve_in 0->20, prize_balance 0->20,
--          ledger jackpot_draw -20, chip leg spin_prize spin_reserve->prize_liability 20); row stamp accepted
--   step4  ok:true replay:false rule_provenance:"legacy_projection" multiplier 2 prize_pool 20 pool_covered 20
--          operator_shortfall 0; spin_draw_receipts_after 1


-- ============================================================================
-- PART 1b — PROBE 2 (ROLLED BACK).  D2: "D1 fixed, at_draw branch as written" leaves the row unstamped.
--   Runs as the engine identity (service_role claims) so the managed-lifecycle guard behaves as in prod.
-- ============================================================================
DO $probe$
DECLARE
  c_tid constant uuid := 'a9c5e229-001b-4a49-af0a-f1b703f29dfa';
  v_t public.tournaments%ROWTYPE; v_launch public.tournament_launch_receipts%ROWTYPE;
  v_settle jsonb; v_pres_err text := 'no error'; v_stamp_err text := 'no error'; v_pres2_err text := 'no error'; v_row jsonb; v_entrants jsonb;
BEGIN
  SET LOCAL lock_timeout = '4s'; SET LOCAL statement_timeout = '20s';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);  -- engine identity for the guards (probe only, rolled back)
  SELECT * INTO v_t FROM public.tournaments WHERE id = c_tid;
  SELECT * INTO v_launch FROM public.tournament_launch_receipts WHERE tournament_id = c_tid;
  SELECT jsonb_agg(jsonb_build_object('registration_id', p.id, 'user_id', p.user_id) ORDER BY p.user_id, p.id) INTO v_entrants FROM public.tournament_players p WHERE p.tournament_id = c_tid;
  v_settle := public.fn_spin_settle_game(c_tid, v_t.club_id, v_t.buy_in_amount, 3, 2, 0.08);
  INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation, rule_manifest, rule_sha256, entrants, receipt)
  VALUES (c_tid, v_launch.launch_id, v_launch.lease_generation, jsonb_build_object('version',1,'buy_in',10,'seats',3,'starting_chips',1000),
          repeat('0',64), v_entrants,
          jsonb_build_object('ok',true,'multiplier',2,'prize_pool',20,'buy_in',10,'starting_chips',1000,
                             'blind_structure', v_t.blind_structure::jsonb, 'payout_structure', '[{"place":1,"percentage":100}]'::jsonb));
  -- (a) the engine's spinPresentationPatch (TournamentManagerBase.ts:3444-3494) on the UNSTAMPED row
  BEGIN
    UPDATE public.tournaments SET is_premium_spin = false, blind_structure = v_t.blind_structure,
           payout_structure = '[{"place":1,"percentage":100}]', spin_reveal_lag_ms = 1234, spin_reveal_at = now()
     WHERE id = c_tid;
  EXCEPTION WHEN OTHERS THEN v_pres_err := SQLSTATE || ' ' || SQLERRM; END;
  -- (b) the stamp the retired fn_spin_draw_and_settle performed
  BEGIN
    UPDATE public.tournaments SET spin_multiplier = 2, prize_pool = 20, spin_locked_tiers = '[]'::jsonb WHERE id = c_tid;
  EXCEPTION WHEN OTHERS THEN v_stamp_err := SQLSTATE || ' ' || SQLERRM; END;
  -- (c) the presentation patch again, on the STAMPED row
  BEGIN
    UPDATE public.tournaments SET is_premium_spin = false, blind_structure = v_t.blind_structure,
           payout_structure = '[{"place":1,"percentage":100}]', spin_reveal_lag_ms = 1234, spin_reveal_at = now()
     WHERE id = c_tid;
  EXCEPTION WHEN OTHERS THEN v_pres2_err := SQLSTATE || ' ' || SQLERRM; END;
  SELECT jsonb_build_object('spin_multiplier', spin_multiplier, 'prize_pool', prize_pool, 'status', status, 'reveal_lag', spin_reveal_lag_ms) INTO v_row FROM public.tournaments WHERE id = c_tid;
  RAISE EXCEPTION 'PROBE_ROLLED_BACK %', jsonb_pretty(jsonb_build_object('settle_ok', v_settle->'ok',
    'a_presentation_patch_on_unstamped_row', v_pres_err, 'b_stamp_after_draw', v_stamp_err, 'c_presentation_patch_on_stamped_row', v_pres2_err, 'row', v_row));
END $probe$;

-- Observed (rolled back):
--   a  23514 A booked Spin keeps its original multiplier     (zzz_spin_ladder_is_the_drawn_one)
--   b  no error
--   c  no error


-- ============================================================================
-- PART 2 — DRAFT MIGRATION (COMMENTED OUT — orchestrator applies DDL).
--   spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row
--   D1: gate on COALESCE(spin_multiplier,0) > 0 instead of IS NOT NULL.
--   D2: the at_draw branch stamps tournaments (multiplier, prize, locked tiers,
--       tier blinds/payouts, premium flag) after the receipt, with read-back.
--   D3: the seat-first creator writes the NULL it validated (INSERT lists
--       spin_multiplier, spin_locked_tiers explicitly).
--   Guards: md5 of the live definitions at analysis time.
-- ============================================================================
/*
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '1c911e3ada50ffe0493b9b375e3fa9ae' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle_atomic changed since C-stuck-spins was analysed';
  END IF;
  IF md5(pg_get_functiondef('public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '92cbf5680d78bdbaa4309412b3d19dfd' THEN
    RAISE EXCEPTION 'fn_create_seat_first_game_atomic changed since C-stuck-spins was analysed';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_rule_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
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
  v_played_recovery boolean := false;
  v_recovery jsonb;
  v_stamped integer;                                                  -- D2
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

  -- A dealt Spin may have one proven busted/vacated original seat. This does
  -- not lower the fresh-launch field: the proof requires the original three
  -- paid identities, immutable money journals, a persisted hand, two exact
  -- live seats and conservation of all three bought starting stacks.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
               'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id
         AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;

  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND (p.status IN ('registered', 'playing')
            OR (v_played_recovery AND p.status = 'eliminated'))) <> 3 THEN
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
    WHERE p.tournament_id = p_tournament_id
      AND (p.status IN ('registered', 'playing')
           OR (v_played_recovery AND p.status = 'eliminated'))
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
    -- D1 (C-stuck-spins): tournaments.spin_multiplier has DEFAULT 0 and the
    -- seat-first creator omits the column, so 0 is "undrawn" exactly as NULL
    -- is. Every other reader on the platform already uses COALESCE(...,0).
    -- A drawn multiplier is never 0 (all tiers >= 2; fn_spin_settle_game
    -- rejects <= 0). Only a POSITIVE projection without a funded draw is the
    -- case this refusal exists for.
    IF COALESCE(v_t.spin_multiplier, 0) > 0 THEN
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

  -- D2 (C-stuck-spins): the tournament row is the contract the engine, the
  -- ladder trigger and proveTournamentLaunchSetup read back. The retired
  -- fn_spin_draw_and_settle stamped it; the atomic authority must too, in the
  -- same transaction as the draw. spin_tournament_contract_is_draw proves the
  -- stamp equals the one jackpot_draw; zzz_spin_ladder_is_the_drawn_one proves
  -- it equals the receipt just written. A legacy_projection row is already
  -- stamped (the branch required equality), so this is a no-op there.
  IF v_provenance = 'at_draw' THEN
    UPDATE public.tournaments
       SET spin_multiplier   = v_multiplier,
           prize_pool        = v_prize,
           spin_locked_tiers = v_locked,
           blind_structure   = v_blinds::text,
           payout_structure  = v_payouts::text
     WHERE id = p_tournament_id;
    -- NOT is_premium_spin: fn_satellite_target_contract_is_immutable freezes it
    -- once entry_contract_locked (true on every funded Spin). The engine's own
    -- presentation patch sets it for a 100x draw (TournamentManagerBase.ts:3445)
    -- and would be refused there — a separate, rare (0.01%) defect, out of scope.
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
    IF v_stamped <> 1 OR NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id = p_tournament_id
            AND t.spin_multiplier IS NOT DISTINCT FROM v_multiplier
            AND t.prize_pool IS NOT DISTINCT FROM v_prize
            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked) THEN
      RAISE EXCEPTION 'Spin % tournament contract did not read back exactly', p_tournament_id
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN v_receipt;
END;
$function$;

-- D3: the creator writes the NULL it validated. Identical to the live body
-- except the INSERT column list / VALUES (two columns added, explicit NULLs).
-- Apply as: pg_get_functiondef(...) with this one edit:
--   INSERT INTO public.tournaments (
--     id, club_id, union_id, name, game_type, variant, tournament_type,
--     buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips,
--     max_players, min_players, table_size, current_players, status,
--     blind_structure, payout_structure, start_time,
--     late_reg_levels, late_reg_mins,
--     satellite_target_id, satellite_seats, short_description,
--     spin_multiplier, spin_locked_tiers                                   -- added
--   ) VALUES (
--     ...,
--     v_satellite_target_id, v_satellite_seats, v_short_description,
--     NULL, NULL                                                           -- added
--   ) RETURNING * INTO v_created;
-- (Optional, same intent at the schema level, no rewrite:
--   ALTER TABLE public.tournaments ALTER COLUMN spin_multiplier SET DEFAULT NULL;
--  then also change fn_spin_expire_unfilled's `spin_multiplier IS NOT NULL` to COALESCE(...,0) > 0.)

-- Dry-run self-test for the orchestrator (rolled back, must run as the engine identity):
DO $selftest$
DECLARE
  c_tid constant uuid := 'a9c5e229-001b-4a49-af0a-f1b703f29dfa';
  v_launch public.tournament_launch_receipts%ROWTYPE; v_lease public.engine_tournament_leases%ROWTYPE;
  v_t public.tournaments%ROWTYPE; v_r1 jsonb; v_r2 jsonb; v_manifest jsonb; v_pool0 numeric; v_pool1 numeric; v_owner uuid;
BEGIN
  SET LOCAL lock_timeout = '4s'; SET LOCAL statement_timeout = '20s';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- build v_manifest exactly as in PROBE 1 (omitted here for brevity; copy the block)
  SELECT * INTO v_t FROM public.tournaments WHERE id = c_tid;
  SELECT * INTO v_launch FROM public.tournament_launch_receipts WHERE tournament_id = c_tid;
  SELECT * INTO v_lease FROM public.engine_tournament_leases WHERE tournament_id = c_tid;
  v_owner := public.fn_spin_reserve_owner(v_t.club_id);
  SELECT balance INTO v_pool0 FROM public.spin_bonus_pools WHERE club_id = v_owner;
  IF v_t.spin_multiplier IS DISTINCT FROM 0 OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger WHERE tournament_id = c_tid AND kind='jackpot_draw')
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts WHERE tournament_id = c_tid) THEN
    RAISE EXCEPTION 'SELFTEST_PRECONDITION: row already drawn';
  END IF;
  v_r1 := public.fn_spin_draw_and_settle_atomic(c_tid, v_launch.launch_id, v_lease.lease_generation, v_manifest);
  v_r2 := public.fn_spin_draw_and_settle_atomic(c_tid, v_launch.launch_id, v_lease.lease_generation, v_manifest);
  SELECT * INTO v_t FROM public.tournaments WHERE id = c_tid;
  SELECT balance INTO v_pool1 FROM public.spin_bonus_pools WHERE club_id = v_owner;
  IF NOT ((v_r1->>'ok')::boolean AND (v_r1->>'replay')::boolean = false AND v_r1->>'rule_provenance' = 'at_draw'
     AND (v_r1->>'operator_shortfall')::numeric = 0
     AND (v_r1->>'prize_pool')::numeric = round(v_t.buy_in_amount * (v_r1->>'multiplier')::numeric, 2)
     AND (v_r1->>'pool_covered')::numeric = (v_r1->>'prize_pool')::numeric
     AND (v_r2->>'replay')::boolean = true
     AND v_t.spin_multiplier = (v_r1->>'multiplier')::numeric
     AND v_t.prize_pool = (v_r1->>'prize_pool')::numeric
     AND v_t.spin_locked_tiers IS NOT NULL
     AND v_t.payout_structure::jsonb = v_r1->'payout_structure'
     AND (SELECT count(*) FROM public.spin_reserve_ledger WHERE tournament_id = c_tid AND kind='jackpot_draw') = 1
     AND (SELECT count(*) FROM public.spin_draw_receipts WHERE tournament_id = c_tid) = 1
     AND (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id = c_tid) = (v_r1->>'prize_pool')::numeric
     AND v_pool0 - v_pool1 = (v_r1->>'prize_pool')::numeric
     AND (SELECT count(*) FROM public.chip_ledger WHERE tournament_id = c_tid AND category='spin_prize' AND amount = (v_r1->>'prize_pool')::numeric) = 1) THEN
    RAISE EXCEPTION 'SELFTEST_FAILED r1=% r2=% row=%', v_r1 - 'rule_manifest' - 'draw_inputs', v_r2 - 'rule_manifest' - 'draw_inputs', to_jsonb(v_t);
  END IF;
  RAISE EXCEPTION 'SELFTEST_ROLLED_BACK ok: multiplier % prize % pool % -> %', v_r1->>'multiplier', v_r1->>'prize_pool', v_pool0, v_pool1;
END $selftest$;
*/


-- ============================================================================
-- PART 3 — ROLLBACK: ORIGINAL definition of fn_spin_draw_and_settle_atomic
--   (live on 2026-09-10 03:10 UTC, md5(pg_get_functiondef) = 1c911e3ada50ffe0493b9b375e3fa9ae).
--   fn_create_seat_first_game_atomic is unchanged by Part 2 except the D3 edit;
--   its live md5 is 92cbf5680d78bdbaa4309412b3d19dfd (full body in the DB, pg_get_functiondef).
-- ============================================================================
/*
CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_rule_manifest jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
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
  v_played_recovery boolean := false;
  v_recovery jsonb;
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

  -- A dealt Spin may have one proven busted/vacated original seat. This does
  -- not lower the fresh-launch field: the proof requires the original three
  -- paid identities, immutable money journals, a persisted hand, two exact
  -- live seats and conservation of all three bought starting stacks.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>'ok')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), jsonb_agg(jsonb_build_object('registration_id', p.id,
               'user_id', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id
         AND p.status IN ('playing', 'eliminated');
    END IF;
  END IF;

  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND (p.status IN ('registered', 'playing')
            OR (v_played_recovery AND p.status = 'eliminated'))) <> 3 THEN
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
    WHERE p.tournament_id = p_tournament_id
      AND (p.status IN ('registered', 'playing')
           OR (v_played_recovery AND p.status = 'eliminated'))
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
*/
