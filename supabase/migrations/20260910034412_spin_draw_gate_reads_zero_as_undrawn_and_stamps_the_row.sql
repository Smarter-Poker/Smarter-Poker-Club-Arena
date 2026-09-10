-- 20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (swarm workstream C, 2026-09-10; full evidence in
-- /mnt outputs C-stuck-spins.md and docs/changelog/2026-09-10-swarm-per-hand-cost.md):
--
-- 106 Spin tournaments sat in REGISTERING with three PAID players each (7,872
-- chips debited from 243 wallets, 7,242.24 held in the two reserve pools as
-- spin_entry contributions, 629.76 booked rake). No Spin had launched since
-- 2026-09-09 11:44 UTC and spin_draw_receipts was EMPTY: the atomic draw
-- function (migration 20260909183856) had never succeeded in production. The
-- engine retried it ~87 times a second (254k calls by 03:54 UTC).
--
-- D1: fn_spin_draw_and_settle_atomic refused with
--     projected_spin_draw_has_no_funding_proof when spin_multiplier IS NOT NULL.
--     tournaments.spin_multiplier has DEFAULT 0, and the seat-first creator
--     (20260908130000) omits the column from its INSERT even though the engine
--     passes null, so every Spin since 09-08 carried 0. The old draw path
--     overwrote it; the new one refused it. Every other reader on the platform
--     already uses COALESCE(spin_multiplier,0) > 0; the gate now does too. A
--     drawn multiplier is never 0 (all tiers >= 2; fn_spin_settle_game rejects
--     <= 0), so only a POSITIVE projection without a funded draw is refused.
--
-- D2: the at_draw branch never stamped tournaments (spin_multiplier, prize_pool,
--     spin_locked_tiers, tier blinds/payouts). Probe-confirmed: fixing D1 alone
--     moves the money and then stalls one step later, because
--     zzz_spin_ladder_is_the_drawn_one refuses the engine's presentation patch
--     on an unstamped row and proveTournamentLaunchSetup refuses row != booked.
--     The stamp now happens after the receipt, in the same transaction, with
--     an exact read-back. is_premium_spin is NOT stamped (contract-frozen).
--
-- PROVEN BEFORE APPLY (2026-09-10 03:50 UTC): the new body was created inside
-- a transaction that ended in RAISE (rolled back, no reload), and in that
-- transaction a live stuck Spin (fe29a0a3, 10-chip buy-in) drew 2x, funded a
-- 20-chip prize from the reserve pool (56546.52 -> 56526.52), wrote its receipt,
-- stamped its row, replayed idempotently, and passed 14 conservation asserts.
--
-- RESULT AFTER APPLY (03:51 -> 03:54 UTC): the engine's existing loop launched
-- all 106 through this path - 106 receipts, 106 RUNNING, 163 Spin hands in the
-- first three minutes, 0 still stuck; 6,952 chips of prizes (57x2, 37x3, 6x4,
-- 4x5, 1x10, 1x25) funded from the pools exactly (6,952 debited, 106 prize
-- legs); the retry loop stopped (call count flat). No refunds, no manual money.
--
-- STILL OPEN (engine, not this file): the launcher treats every non-ok reason
-- as retryable with no backoff (TournamentManagerBase.ts:3312-3348 +
-- GameServer.ts:6434-6560 restart cycle). Deterministic refusals must park the
-- launch and raise one alert. And D3: the creator should write the NULL it
-- validated (or the column default should be NULL); fn_spin_expire_unfilled
-- has the same NULL/0 slip.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $guard$
BEGIN
  -- Applied on production 2026-09-10 03:51 UTC; on any other database the
  -- previous body must be the one analysed, or stop.
  IF pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure) NOT LIKE '%D1 (C-stuck-spins)%'
     AND md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))
         IS DISTINCT FROM '1c911e3ada50ffe0493b9b375e3fa9ae' THEN
    RAISE EXCEPTION 'fn_spin_draw_and_settle_atomic changed since C-stuck-spins was analysed';
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

-- Only the engine (service_role) may call this money-moving SECURITY DEFINER
-- function. Production already had exactly this grant set (postgres,
-- service_role); stated here so the migration is self-describing and the
-- definer-authorization gate can see it.
REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb) TO service_role;

COMMIT;

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
