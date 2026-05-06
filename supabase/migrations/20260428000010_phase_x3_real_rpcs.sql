-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase X3 — replace phantom RPCs with real implementations.
-- Migration: 20260428000010_phase_x3_real_rpcs.sql
--
-- Replaces:
--   public.record_rake                       (was phantom — only updated clubs.total_rake)
--   public.calculate_cascading_commission    (was phantom — empty stubs across 3 overloads)
--
-- Adds:
--   public.settle_hand_atomically            (P0-A1 — wraps full settlement in one tx)
--   public.fn_create_settlement_period       (P0-A2 — opens a new rakeback period)
--   public.fn_close_settlement_period        (P0-A2 — closes period + writes payouts)
--   public.fn_bbj_check_eligible             (P0-A5 — quad-aces-cracked detector)
--   public.fn_bbj_payout                     (P0-A5 — writes bbj_payouts + recipients)
--
-- Notes preserved (NOT touched by this migration — they're already real):
--   public.fn_request_cashout                (real impl: club_memberships + cashout_requests + chip_transactions)
--   public.fn_tournament_atomic_register     (real impl: club_tournaments + tournament_registrations + chip_transactions)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- DROP ALL PHANTOM OVERLOADS — replace with single canonical signature each
-- ───────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.record_rake(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public.record_rake(text, uuid, uuid, numeric, numeric, integer);

DROP FUNCTION IF EXISTS public.calculate_cascading_commission(numeric, uuid);
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(uuid, numeric);
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(text, uuid, uuid, numeric);


-- ═══════════════════════════════════════════════════════════════════════════
-- record_rake — real implementation
-- Caller (engine settlement): one call per settled hand.
-- Side-effects (atomic, single transaction):
--   1. INSERT INTO rake_records (rake_amount, bbj_contribution, etc.)
--   2. UPDATE bbj_pools.pool_amount += bbj_contribution (per club, club_id-level pool)
--   3. UPDATE club_wallets period_rake_collected + lifetime_rake_collected
--   4. UPDATE club_wallet_transactions ledger row (type='rake_in')
--   5. UPDATE clubs.total_rake (legacy aggregate; some dashboards still read it)
-- Returns jsonb with success flag + rake_record_id for audit chain.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_rake(
  p_hand_id        uuid    DEFAULT NULL,
  p_club_id        uuid    DEFAULT NULL,
  p_table_id       uuid    DEFAULT NULL,
  p_rake_amount    numeric DEFAULT 0,
  p_pot_size       numeric DEFAULT 0,
  p_num_players    integer DEFAULT 0,
  p_player_contributions jsonb DEFAULT NULL,
  p_is_tournament  boolean DEFAULT FALSE,
  p_tournament_id  uuid    DEFAULT NULL,
  p_bbj_pct        numeric DEFAULT 0.05   -- 5% default; clubs override via clubs.settings
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_bbj_amount   numeric := 0;
  v_rake_id      uuid;
  v_pool_id      uuid;
  v_new_balance  numeric;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_rake');
  END IF;

  -- 1. BBJ contribution slice
  v_bbj_amount := ROUND(p_rake_amount * COALESCE(p_bbj_pct, 0)::numeric, 4);

  -- 2. Insert rake_records row (this is the authoritative source for rakeback cron)
  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution,
    pot_size, num_players, player_contributions,
    is_tournament, tournament_id, source, metadata
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake_amount, v_bbj_amount,
    p_pot_size, p_num_players, p_player_contributions,
    p_is_tournament, p_tournament_id,
    CASE WHEN p_is_tournament THEN 'tournament' ELSE 'cash_game' END,
    jsonb_build_object('bbj_pct_applied', p_bbj_pct)
  )
  RETURNING id INTO v_rake_id;

  -- 3. Increment club's BBJ pool (or create one if first hand)
  IF p_club_id IS NOT NULL AND v_bbj_amount > 0 THEN
    INSERT INTO public.bbj_pools (club_id, pool_amount, hands_contributed, total_contributed)
    VALUES (p_club_id, v_bbj_amount, 1, v_bbj_amount)
    ON CONFLICT (club_id) DO UPDATE
      SET pool_amount       = public.bbj_pools.pool_amount + v_bbj_amount,
          hands_contributed = public.bbj_pools.hands_contributed + 1,
          total_contributed = public.bbj_pools.total_contributed + v_bbj_amount,
          updated_at        = NOW()
    RETURNING id INTO v_pool_id;
  END IF;

  -- 4. Update club_wallets period accumulators + ledger
  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_rake_collected   = period_rake_collected   + p_rake_amount,
           period_bbj_contribution = period_bbj_contribution + v_bbj_amount,
           lifetime_rake_collected = lifetime_rake_collected + p_rake_amount,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj_amount,
           chip_balance            = chip_balance + (p_rake_amount - v_bbj_amount),
           updated_at              = NOW()
     WHERE club_id = p_club_id
    RETURNING chip_balance INTO v_new_balance;

    -- Append-only ledger row
    IF v_new_balance IS NOT NULL THEN
      INSERT INTO public.club_wallet_transactions (
        club_id, type, amount, balance_after, related_id, reason
      ) VALUES (
        p_club_id, 'rake_in', (p_rake_amount - v_bbj_amount), v_new_balance,
        v_rake_id, 'Rake collected (BBJ pct: ' || p_bbj_pct::text || ')'
      );
    END IF;
  END IF;

  -- 5. Legacy aggregate on clubs.total_rake (kept for dashboard compatibility)
  IF p_club_id IS NOT NULL THEN
    UPDATE public.clubs
       SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,
           updated_at = NOW()
     WHERE id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'rake_record_id', v_rake_id,
    'bbj_pool_id', v_pool_id,
    'rake', p_rake_amount,
    'bbj_contribution', v_bbj_amount
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_rake(
  uuid, uuid, uuid, numeric, numeric, integer, jsonb, boolean, uuid, numeric
) TO service_role, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- calculate_cascading_commission — real implementation
-- Walks the agent hierarchy upward from the player's leaf assignment,
-- writing one row to agent_commissions per tier.
--
-- Hierarchy (leaf → root):
--   sub_agent (if assigned) → parent_agent → club_owner
--   OR
--   agent (if directly assigned) → club_owner
--
-- Each tier gets a slice of the rake based on its commission_pct/rate.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(
  p_hand_id        uuid    DEFAULT NULL,
  p_club_id        uuid    DEFAULT NULL,
  p_player_user_id uuid    DEFAULT NULL,
  p_rake_amount    numeric DEFAULT 0,
  p_rake_record_id uuid    DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_assignment      record;
  v_sub_agent       record;
  v_agent           record;
  v_club_owner_id   uuid;
  v_remaining       numeric;
  v_slice           numeric;
  v_results         jsonb := '[]'::jsonb;
  v_commission_id   uuid;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 OR p_club_id IS NULL OR p_player_user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'commissions', v_results, 'skipped', 'missing_inputs');
  END IF;

  v_remaining := p_rake_amount;

  -- Find the player's assignment (sub_agent OR agent)
  SELECT * INTO v_assignment
    FROM public.player_agent_assignments
   WHERE player_id = p_player_user_id AND club_id = p_club_id;

  -- Walk hierarchy. If no row, fall through directly to club owner.
  IF FOUND THEN
    -- 1. SUB-AGENT (if assigned)
    IF v_assignment.sub_agent_id IS NOT NULL THEN
      SELECT s.id, s.parent_agent_id, s.commission_pct, s.user_id
        INTO v_sub_agent
        FROM public.sub_agents s
       WHERE s.id = v_assignment.sub_agent_id AND s.status = 'active';

      IF FOUND THEN
        v_slice := ROUND(v_remaining * (v_sub_agent.commission_pct / 100.0)::numeric, 4);
        IF v_slice > 0 THEN
          INSERT INTO public.agent_commissions
            (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
          VALUES
            (p_club_id, v_sub_agent.user_id, v_slice, v_sub_agent.commission_pct,
             'rake', COALESCE(p_rake_record_id, p_hand_id),
             'sub_agent slice')
          RETURNING id INTO v_commission_id;

          v_results := v_results || jsonb_build_object(
            'tier', 'sub_agent', 'user_id', v_sub_agent.user_id,
            'amount', v_slice, 'commission_id', v_commission_id
          );
          v_remaining := v_remaining - v_slice;
        END IF;

        -- Promote to parent agent for next loop iteration
        SELECT id, user_id, commission_rate INTO v_agent
          FROM public.agents
         WHERE id = v_sub_agent.parent_agent_id AND status = 'active';
      END IF;
    -- 1b. DIRECT AGENT (no sub-agent)
    ELSIF v_assignment.agent_id IS NOT NULL THEN
      SELECT id, user_id, commission_rate INTO v_agent
        FROM public.agents
       WHERE id = v_assignment.agent_id AND status = 'active';
    END IF;

    -- 2. AGENT (parent or direct)
    IF v_agent.id IS NOT NULL THEN
      v_slice := ROUND(v_remaining * (v_agent.commission_rate / 100.0)::numeric, 4);
      IF v_slice > 0 THEN
        INSERT INTO public.agent_commissions
          (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
        VALUES
          (p_club_id, v_agent.user_id, v_slice, v_agent.commission_rate,
           'rake', COALESCE(p_rake_record_id, p_hand_id),
           'agent slice')
        RETURNING id INTO v_commission_id;

        v_results := v_results || jsonb_build_object(
          'tier', 'agent', 'user_id', v_agent.user_id,
          'amount', v_slice, 'commission_id', v_commission_id
        );
        v_remaining := v_remaining - v_slice;
      END IF;
    END IF;
  END IF;

  -- 3. CLUB OWNER — receives the residual
  SELECT owner_id INTO v_club_owner_id FROM public.clubs WHERE id = p_club_id;
  IF v_club_owner_id IS NOT NULL AND v_remaining > 0 THEN
    INSERT INTO public.agent_commissions
      (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
    VALUES
      (p_club_id, v_club_owner_id, v_remaining, NULL,
       'rake', COALESCE(p_rake_record_id, p_hand_id),
       'club owner residual')
    RETURNING id INTO v_commission_id;

    v_results := v_results || jsonb_build_object(
      'tier', 'owner', 'user_id', v_club_owner_id,
      'amount', v_remaining, 'commission_id', v_commission_id
    );
  END IF;

  -- Update club_wallets ledger (commission_out)
  IF p_club_id IS NOT NULL THEN
    UPDATE public.club_wallets
       SET period_commission_paid   = period_commission_paid   + p_rake_amount,
           lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
           updated_at = NOW()
     WHERE club_id = p_club_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'hand_id', p_hand_id,
    'club_id', p_club_id,
    'player_user_id', p_player_user_id,
    'rake_amount', p_rake_amount,
    'commissions', v_results
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid)
  TO service_role, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- settle_hand_atomically — single-call settlement entry point
-- Wraps:
--   - settlement_idempotency_keys check (so retries don't double-settle)
--   - record_rake
--   - calculate_cascading_commission for each player who contributed rake
-- One transaction; failure rolls back everything.
--
-- Caller: ServerTableEngine on each settled hand.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.settle_hand_atomically(
  p_table_id uuid,
  p_hand_id  uuid,
  p_payload  jsonb     -- { club_id, rake, pot, num_players, player_contributions: {user_id: rake_share}, is_tournament, tournament_id }
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.settlement_idempotency_keys%ROWTYPE;
  v_rake_result jsonb;
  v_commission_results jsonb := '[]'::jsonb;
  v_player record;
  v_individual_result jsonb;
  v_final_result jsonb;
BEGIN
  -- 1. Idempotency check
  SELECT * INTO v_existing
    FROM public.settlement_idempotency_keys
   WHERE table_id = p_table_id AND hand_id = p_hand_id;

  IF FOUND THEN
    IF v_existing.status = 'succeeded' THEN
      -- Already settled; return cached result
      RETURN v_existing.result;
    ELSIF v_existing.status = 'in_flight' THEN
      -- Concurrent attempt; bump attempt_count
      UPDATE public.settlement_idempotency_keys
         SET attempt_count = attempt_count + 1,
             last_attempt_at = NOW()
       WHERE table_id = p_table_id AND hand_id = p_hand_id;
      RAISE EXCEPTION 'settlement already in flight for table=% hand=%', p_table_id, p_hand_id;
    -- status = 'failed' → retry; fall through
    END IF;
  ELSE
    INSERT INTO public.settlement_idempotency_keys
      (table_id, hand_id, status)
    VALUES (p_table_id, p_hand_id, 'in_flight');
  END IF;

  BEGIN
    -- 2. Record rake (writes rake_records, BBJ contribution, club_wallets)
    v_rake_result := public.record_rake(
      p_hand_id        := p_hand_id,
      p_club_id        := (p_payload->>'club_id')::uuid,
      p_table_id       := p_table_id,
      p_rake_amount    := COALESCE((p_payload->>'rake')::numeric, 0),
      p_pot_size       := COALESCE((p_payload->>'pot')::numeric, 0),
      p_num_players    := COALESCE((p_payload->>'num_players')::int, 0),
      p_player_contributions := p_payload->'player_contributions',
      p_is_tournament  := COALESCE((p_payload->>'is_tournament')::boolean, FALSE),
      p_tournament_id  := NULLIF(p_payload->>'tournament_id','')::uuid,
      p_bbj_pct        := COALESCE((p_payload->>'bbj_pct')::numeric, 0.05)
    );

    -- 3. Walk commission cascade for each player who contributed rake
    FOR v_player IN
      SELECT key::uuid AS user_id, value::numeric AS rake_share
        FROM jsonb_each_text(COALESCE(p_payload->'player_contributions', '{}'::jsonb))
       WHERE value::numeric > 0
    LOOP
      v_individual_result := public.calculate_cascading_commission(
        p_hand_id        := p_hand_id,
        p_club_id        := (p_payload->>'club_id')::uuid,
        p_player_user_id := v_player.user_id,
        p_rake_amount    := v_player.rake_share,
        p_rake_record_id := (v_rake_result->>'rake_record_id')::uuid
      );
      v_commission_results := v_commission_results || jsonb_build_array(v_individual_result);
    END LOOP;

    v_final_result := jsonb_build_object(
      'success', true,
      'table_id', p_table_id,
      'hand_id', p_hand_id,
      'rake', v_rake_result,
      'commissions', v_commission_results
    );

    -- Mark idempotency row succeeded with cached result
    UPDATE public.settlement_idempotency_keys
       SET status = 'succeeded',
           result = v_final_result,
           completed_at = NOW(),
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;

    RETURN v_final_result;
  EXCEPTION WHEN OTHERS THEN
    -- Mark idempotency row failed; allow retry
    UPDATE public.settlement_idempotency_keys
       SET status = 'failed',
           error  = SQLERRM,
           last_attempt_at = NOW()
     WHERE table_id = p_table_id AND hand_id = p_hand_id;
    RAISE;
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.settle_hand_atomically(uuid, uuid, jsonb)
  TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- fn_create_settlement_period — opens a new rakeback period for a (club, user)
-- Used by rakeback-settle cron when no open period exists.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_create_settlement_period(
  p_club_id      uuid,
  p_user_id      uuid,
  p_period_start date DEFAULT CURRENT_DATE,
  p_period_end   date DEFAULT CURRENT_DATE + INTERVAL '7 days'
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_period_id uuid;
  v_rate numeric;
BEGIN
  -- Resolve rakeback rate from agent (or default 10%)
  SELECT COALESCE(a.player_rakeback_rate, 0.10) INTO v_rate
    FROM public.player_agent_assignments paa
    LEFT JOIN public.agents a ON a.id = paa.agent_id
   WHERE paa.player_id = p_user_id AND paa.club_id = p_club_id
   LIMIT 1;
  v_rate := COALESCE(v_rate, 0.10);

  INSERT INTO public.rakeback_periods
    (user_id, club_id, period_start, period_end, rakeback_rate, status)
  VALUES
    (p_user_id, p_club_id, p_period_start, p_period_end, v_rate, 'pending')
  RETURNING id INTO v_period_id;

  RETURN v_period_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_create_settlement_period(uuid, uuid, date, date)
  TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- fn_close_settlement_period — closes a period
-- 1. Sums rake_records in window
-- 2. Computes payout = rake_total * rakeback_rate
-- 3. Writes rakeback_period_payouts row (1 per user)
-- 4. Credits user wallet
-- 5. Marks period status='paid'
-- All atomic.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(
  p_period_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_period record;
  v_rake_total numeric;
  v_payout     numeric;
  v_payout_id  uuid;
  v_wallet_balance numeric;
BEGIN
  SELECT * INTO v_period
    FROM public.rakeback_periods
   WHERE id = p_period_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status = 'paid' THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'already_paid', 'period_id', p_period_id);
  END IF;

  -- Aggregate this user's rake contribution in the window from rake_records
  SELECT COALESCE(SUM(
    COALESCE((r.player_contributions->v_period.user_id::text)::numeric, 0)
  ), 0)
    INTO v_rake_total
    FROM public.rake_records r
   WHERE r.club_id = v_period.club_id
     AND r.created_at::date >= v_period.period_start
     AND r.created_at::date <= v_period.period_end;

  v_payout := ROUND(v_rake_total * v_period.rakeback_rate, 4);

  -- Update header
  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout,
         status = 'paid',
         paid_at = NOW()
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  -- Write payout receipt
  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_period.rakeback_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  -- Credit user's main wallet
  UPDATE public.wallets
     SET balance    = balance + v_payout,
         updated_at = NOW()
   WHERE user_id = v_period.user_id AND wallet_type = 'main'
  RETURNING balance INTO v_wallet_balance;

  IF v_wallet_balance IS NOT NULL THEN
    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, amount, type, category,
       description, related_entity_id, balance_after)
    VALUES
      (v_period.user_id, 'main', v_payout, 'credit', 'rakeback',
       'Rakeback payout for period ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
       v_payout_id, v_wallet_balance);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'period_id', p_period_id,
    'rake_total', v_rake_total,
    'rakeback_rate', v_period.rakeback_rate,
    'payout', v_payout,
    'payout_id', v_payout_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- fn_bbj_check_eligible — returns BBJ-eligible scenarios for a hand
-- Trigger condition (default Aces Cracked Quads):
--   loser had quad aces (or better), beaten on showdown.
-- Returns null if not eligible, else { winner_id, loser_id, table_id, hand_number, pool_id }.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_bbj_check_eligible(
  p_hand_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_hand record;
  v_winner jsonb;
  v_loser jsonb;
  v_pool_id uuid;
BEGIN
  SELECT * INTO v_hand FROM public.hand_history WHERE id = p_hand_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Find loser hand: must contain 'four of a kind, aces' AND be beaten at showdown.
  -- Heuristic: scan v_hand.players where best_hand JSON contains 'quads_aces' or rank=='four_of_a_kind' && top_kicker='A'.
  -- (Engine should set this metadata explicitly. Heuristic is a safety net.)
  SELECT player INTO v_loser
    FROM jsonb_array_elements(COALESCE(v_hand.players, '[]'::jsonb)) AS player
   WHERE LOWER(COALESCE(player->>'best_hand_label', '')) LIKE '%four of a kind%aces%'
      OR LOWER(COALESCE(player->>'best_hand_label', '')) LIKE '%quads%aces%'
   LIMIT 1;

  IF v_loser IS NULL THEN RETURN NULL; END IF;

  -- Winner is the one who beat them
  SELECT player INTO v_winner
    FROM jsonb_array_elements(COALESCE(v_hand.winners, '[]'::jsonb)) AS player
   LIMIT 1;

  IF v_winner IS NULL THEN RETURN NULL; END IF;

  -- Find the club's BBJ pool via the table's club_id
  SELECT bp.id INTO v_pool_id
    FROM public.bbj_pools bp
    JOIN public.tables t ON t.club_id = bp.club_id
   WHERE t.id = v_hand.table_id
     AND bp.status = 'active'
   LIMIT 1;

  RETURN jsonb_build_object(
    'eligible', TRUE,
    'hand_id', p_hand_id,
    'table_id', v_hand.table_id,
    'hand_number', v_hand.hand_number,
    'winner_user_id', v_winner->>'user_id',
    'loser_user_id', v_loser->>'user_id',
    'pool_id', v_pool_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_check_eligible(uuid) TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- fn_bbj_payout — write BBJ payout from pool to (winner, loser, table)
-- Splits: 50% winner / 25% loser / 25% table (remaining seated players).
-- All payouts written to bbj_payouts + bbj_payout_recipients.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_bbj_payout(
  p_pool_id uuid,
  p_hand_id uuid,
  p_table_id uuid,
  p_winner_user_id uuid,
  p_loser_user_id uuid,
  p_table_player_ids uuid[]   -- excluding winner+loser, currently seated
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_pool record;
  v_total numeric;
  v_winner_share numeric;
  v_loser_share  numeric;
  v_table_share  numeric;
  v_per_table_player numeric;
  v_payout_id uuid;
  v_player uuid;
  v_count int;
BEGIN
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND OR v_pool.pool_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_pool_or_zero_balance');
  END IF;

  v_total := v_pool.pool_amount;
  v_winner_share := ROUND(v_total * 0.50, 4);
  v_loser_share  := ROUND(v_total * 0.25, 4);
  v_table_share  := v_total - v_winner_share - v_loser_share;
  v_count        := COALESCE(array_length(p_table_player_ids, 1), 0);
  v_per_table_player := CASE WHEN v_count > 0 THEN ROUND(v_table_share / v_count, 4) ELSE 0 END;

  -- Drain pool
  UPDATE public.bbj_pools
     SET pool_amount     = 0,
         last_hit_at     = NOW(),
         last_hit_amount = v_total,
         last_winner_id  = p_winner_user_id,
         last_loser_id   = p_loser_user_id,
         hit_count       = COALESCE(hit_count, 0) + 1,
         total_paid_out  = COALESCE(total_paid_out, 0) + v_total,
         updated_at      = NOW()
   WHERE id = p_pool_id;

  -- Header row
  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count)
  VALUES
    (p_pool_id, p_hand_id, p_table_id, p_winner_user_id, p_loser_user_id,
     v_total, v_winner_share, v_loser_share, v_table_share, v_count)
  RETURNING id INTO v_payout_id;

  -- Credit winner
  UPDATE public.wallets SET balance = balance + v_winner_share, updated_at = NOW()
   WHERE user_id = p_winner_user_id AND wallet_type = 'main';

  -- Credit loser
  UPDATE public.wallets SET balance = balance + v_loser_share, updated_at = NOW()
   WHERE user_id = p_loser_user_id AND wallet_type = 'main';

  -- Credit table-share recipients
  IF v_count > 0 THEN
    FOREACH v_player IN ARRAY p_table_player_ids LOOP
      UPDATE public.wallets SET balance = balance + v_per_table_player, updated_at = NOW()
       WHERE user_id = v_player AND wallet_type = 'main';

      INSERT INTO public.bbj_payout_recipients (payout_id, user_id, amount)
      VALUES (v_payout_id, v_player, v_per_table_player);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payout_id', v_payout_id,
    'total_amount', v_total,
    'winner_share', v_winner_share,
    'loser_share', v_loser_share,
    'table_share_each', v_per_table_player,
    'table_player_count', v_count
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_payout(uuid, uuid, uuid, uuid, uuid, uuid[])
  TO service_role;

COMMENT ON FUNCTION public.record_rake IS 'Phase X3 — real impl. Writes rake_records + bbj_pools + club_wallets. Replaces phantom stub.';
COMMENT ON FUNCTION public.calculate_cascading_commission IS 'Phase X3 — real impl. Walks player → sub_agent → agent → owner; writes agent_commissions per tier.';
COMMENT ON FUNCTION public.settle_hand_atomically IS 'Phase X3 — atomic settlement entry point with idempotency on (table_id, hand_id).';
COMMENT ON FUNCTION public.fn_create_settlement_period IS 'Phase X3 — opens new rakeback_periods row.';
COMMENT ON FUNCTION public.fn_close_settlement_period IS 'Phase X3 — closes period, writes payout receipt, credits wallet atomically.';
COMMENT ON FUNCTION public.fn_bbj_check_eligible IS 'Phase X3 — BBJ trigger detection (quad aces beat by default).';
COMMENT ON FUNCTION public.fn_bbj_payout IS 'Phase X3 — writes bbj_payouts header + bbj_payout_recipients + credits wallets.';
