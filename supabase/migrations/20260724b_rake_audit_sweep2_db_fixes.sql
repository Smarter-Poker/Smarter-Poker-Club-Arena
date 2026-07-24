-- ═══════════════════════════════════════════════════════════════════════════════
-- RAKE-AUDIT SWEEP 2 (2026-07-24): DB-side rake/BBJ/settlement/tournament fixes
-- (Applied to the live PokerIQ-Production database on 2026-07-24 via MCP.)
--
-- FIX 1: bbj_atomic_payout — after a hit, the backup bank now ROLLS INTO the
--        main jackpot (reseed) and is zeroed; previously the backup bank
--        accumulated forever and the next jackpot was never reseeded. The RPC
--        also now writes the bbj_winners history row (with display names), so
--        the "Previous Winners" UI is populated by the live server payout path
--        (bbj_winners had 0 rows despite 27 recorded hits).
-- FIX 2: bbj_winners.club_id made nullable (union-level pools have no club_id)
--        + winner_display_name/loser_display_name columns added (the jackpot
--        page selects them; they did not exist, erroring the whole select).
-- FIX 3: bbj_record_contribution — increments hands_contributed (displays show
--        it as "Hands"; it was frozen because nothing incremented it).
-- FIX 4: get_union_rake_for_period — read the LIVE rake_records ledger; it
--        summed the dead rake_history table (no writes since 2026-05-01), so
--        the union weekly rake-back idempotency estimate was always $0.
-- FIX 5: settle_club_rakeback — only closes LAPSED periods (period_end <
--        today). Previously a mid-week run paid out the partial week, marked
--        it 'paid', and all remaining rake that week earned players nothing.
-- FIX 6: process_tournament_rebuy — logs category = rebuy type ('rebuy' /
--        'addon' / 'reentry') WITH related_entity_id = tournament id. It
--        logged category='tournament_buyin' with NO related id, so
--        recalculatePrizePool found zero rebuy/add-on transactions (rebuys
--        never entered the prize pool) and the "already used add-on" check
--        never matched (unlimited add-ons). Also sets status='playing' (the
--        real status vocabulary) instead of the unknown 'active'.
-- FIX 7: atomic_cancel_tournament — refunds ONLY non-horse players (horses
--        register free; refunding them MINTED chips), and reverses the
--        collected entry fees in the rake ledger (negative rake_records rows
--        + total_rake decrement) so cancelled tournaments no longer leave
--        phantom rake that clubs get billed for in settlement.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── FIX 2: bbj_winners schema ────────────────────────────────────────────────
ALTER TABLE bbj_winners ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE bbj_winners ADD COLUMN IF NOT EXISTS winner_display_name text;
ALTER TABLE bbj_winners ADD COLUMN IF NOT EXISTS loser_display_name text;

-- ── FIX 1: bbj_atomic_payout v2 ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bbj_atomic_payout(
  p_pool_id uuid, p_table_id uuid, p_hand_number bigint,
  p_payout_total_percent numeric, p_loser_user_id uuid, p_winner_user_id uuid,
  p_dealt_in_count integer, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, payout_id uuid,
               total_payout numeric, loser_share numeric, winner_share numeric,
               table_share numeric, balance_after numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance   numeric;
  v_total     numeric;
  v_loser     numeric;
  v_winner    numeric;
  v_table     numeric;
  v_payout_id uuid;
  v_existing  uuid;
  v_club_id   uuid;
  v_pre_hit_balance numeric;
  v_winner_name text;
  v_loser_name  text;
BEGIN
  SELECT id INTO v_existing
    FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT false, true, v_existing,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, NULL::numeric;
    RETURN;
  END IF;

  SELECT main_balance INTO v_balance FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance <= 0 THEN
    RETURN QUERY SELECT false, false, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, COALESCE(v_balance, 0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_balance;
  v_total  := ROUND(v_balance * (p_payout_total_percent / 100.0), 2);
  v_loser  := ROUND(v_total * 0.50, 2);  -- bad-beat holder: 50%
  v_winner := ROUND(v_total * 0.25, 2);  -- hand winner: 25%
  v_table  := ROUND(v_total - v_loser - v_winner, 2);  -- table: remainder (~25%)

  INSERT INTO bbj_payouts (
    pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata
  ) VALUES (
    p_pool_id, NULL, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_loser, v_winner, v_table, p_dealt_in_count, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    RETURN QUERY SELECT false, true, NULL::uuid,
                        0::numeric, 0::numeric, 0::numeric, 0::numeric, v_balance;
    RETURN;
  END IF;

  -- RAKE-AUDIT SWEEP 2: after paying out, the BACKUP bank rolls into MAIN as
  -- the reseed (and backup resets to 0). Previously backup accumulated forever.
  UPDATE bbj_pools
     SET main_balance    = GREATEST(0, main_balance - v_total) + COALESCE(backup_balance, 0),
         backup_balance  = 0,
         total_paid_out  = COALESCE(total_paid_out, 0) + v_total,
         hit_count       = COALESCE(hit_count, 0) + 1,
         last_hit_at     = now(),
         last_hit_amount = v_total,
         last_winner_id  = p_loser_user_id,
         last_loser_id   = p_winner_user_id,
         updated_at      = now()
   WHERE id = p_pool_id
   RETURNING main_balance, club_id INTO v_balance, v_club_id;

  -- RAKE-AUDIT SWEEP 2: write the bbj_winners history row (the UI reads it).
  -- Naming: the BAD-BEAT HOLDER (p_loser_user_id, who lost the hand with a
  -- monster) is the BBJ *winner* and takes the 50% share.
  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')
    INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')
    INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  INSERT INTO bbj_winners (
    pool_id, club_id, winner_id, loser_id,
    winner_display_name, loser_display_name,
    winner_hand, loser_hand,
    winner_payout, loser_payout, table_share_payout, total_payout,
    pool_amount_at_hit, table_id, hand_number, awarded_at
  ) VALUES (
    p_pool_id, v_club_id, p_loser_user_id, p_winner_user_id,
    v_winner_name, v_loser_name,
    COALESCE(p_metadata->>'winner_hand_name', 'Unknown'),
    COALESCE(p_metadata->>'loser_hand_name', 'Unknown'),
    v_loser, v_winner, v_table, v_total,
    v_pre_hit_balance, p_table_id, p_hand_number, now()
  )
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, false, v_payout_id, v_total, v_loser, v_winner, v_table, v_balance;
END;
$function$;

-- ── FIX 3: bbj_record_contribution increments hands_contributed ──────────────
CREATE OR REPLACE FUNCTION public.bbj_record_contribution(
  p_pool_id uuid, p_hand_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid,
  p_amount numeric DEFAULT 0, p_main_portion numeric DEFAULT 0,
  p_backup_portion numeric DEFAULT 0, p_promo_portion numeric DEFAULT 0,
  p_big_blind numeric DEFAULT 2.00, p_hand_number integer DEFAULT NULL::integer,
  p_club_id uuid DEFAULT NULL::uuid)
 RETURNS bbj_contributions
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_contribution bbj_contributions;
BEGIN
    UPDATE bbj_pools
    SET
        main_balance = main_balance + p_main_portion,
        backup_balance = backup_balance + p_backup_portion,
        promo_balance = promo_balance + p_promo_portion,
        total_contributed = total_contributed + p_amount,
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at = now()
    WHERE id = p_pool_id;

    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind, p_hand_number
    ) RETURNING * INTO v_contribution;

    RETURN v_contribution;
END;
$function$;

-- ── FIX 4: get_union_rake_for_period reads the live ledger ───────────────────
CREATE OR REPLACE FUNCTION public.get_union_rake_for_period(
  p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(club_id uuid, club_name text, rake_amount numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RETURN QUERY
  SELECT c.id, c.name, COALESCE(SUM(rr.rake_amount), 0)
    FROM clubs c
    LEFT JOIN rake_records rr
      ON rr.club_id = c.id
     AND rr.created_at >= p_start AND rr.created_at < p_end
   WHERE c.union_id = p_union_id
   GROUP BY c.id, c.name;
END;
$function$;

-- ── FIX 5: settle_club_rakeback only closes lapsed periods ───────────────────
CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period record;
  v_settled integer := 0;
  v_total_payout numeric := 0;
  v_close_result jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE  -- RAKE-AUDIT SWEEP 2: never close a week still in progress
  LOOP
    v_close_result := public.fn_close_settlement_period(v_period.id);
    IF (v_close_result->>'success')::boolean THEN
      v_settled := v_settled + 1;
      v_total_payout := v_total_payout + COALESCE((v_close_result->>'payout')::numeric, 0);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true,
    'club_id', p_club_id, 'periods_settled', v_settled, 'total_payout', v_total_payout);
END $function$;

-- ── FIX 6: process_tournament_rebuy category/related id/status ───────────────
CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid, p_user_id uuid, p_rebuy_type text,
  p_cost numeric, p_chips numeric, p_current_level integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric;
  v_new_chips integer;
  v_exists boolean;
  v_add integer := COALESCE(p_chips, 0)::integer;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN
    RAISE EXCEPTION 'Invalid rebuy cost';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  SELECT true INTO v_exists FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id LIMIT 1;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;

  SELECT balance INTO v_balance FROM wallets
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_cost THEN
    RAISE EXCEPTION 'Insufficient chips for rebuy';
  END IF;
  UPDATE wallets SET balance = balance - p_cost, updated_at = NOW()
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  -- RAKE-AUDIT SWEEP 2: status 'playing' (the real status vocabulary:
  -- registered/playing/eliminated/winner) — was 'active', an unknown status.
  IF p_rebuy_type = 'reentry' THEN
    UPDATE tournament_players
       SET chips = v_add, status = 'playing', eliminated_at = NULL,
           rebuys = COALESCE(rebuys, 0) + 1
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type = 'addon' THEN
    UPDATE tournament_players
       SET chips = COALESCE(chips, 0) + v_add, add_on = true
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE  -- rebuy
    UPDATE tournament_players
       SET chips = COALESCE(chips, 0) + v_add, status = 'playing',
           rebuys = COALESCE(rebuys, 0) + 1
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;

  -- RAKE-AUDIT SWEEP 2: category = the rebuy type and related_entity_id = the
  -- tournament. The old row (category 'tournament_buyin', no related id) was
  -- invisible to recalculatePrizePool (rebuys/add-ons NEVER entered the prize
  -- pool) and to the one-add-on-per-player check (unlimited add-ons).
  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_cost, p_rebuy_type,
            'Tournament ' || p_rebuy_type, p_tournament_id, v_balance - p_cost);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips, 'rebuy_type', p_rebuy_type);
END;
$function$;

-- ── FIX 7: atomic_cancel_tournament — no horse refunds, fee reversal ─────────
CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_tournament RECORD;
    v_player RECORD;
    v_refund_amount NUMERIC;
    v_fee NUMERIC;
    v_refunded_count INT := 0;
    v_total_refunded NUMERIC := 0;
    v_fees_reversed NUMERIC := 0;
BEGIN
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF v_tournament.status IN ('completed', 'canceled', 'CANCELLED') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;
    v_refund_amount := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);
    v_fee := COALESCE(v_tournament.buy_in_fee, 0);
    UPDATE tournaments SET status = 'CANCELLED', ended_at = NOW(), updated_at = NOW() WHERE id = p_tournament_id;
    IF v_refund_amount > 0 THEN
        -- RAKE-AUDIT SWEEP 2: refund ONLY real players. Horses register free
        -- (direct insert, no wallet debit) — refunding them minted chips from
        -- nothing on every cancellation.
        FOR v_player IN (
          SELECT tp.user_id, tp.id FROM tournament_players tp
          LEFT JOIN profiles pr ON pr.id = tp.user_id
          WHERE tp.tournament_id = p_tournament_id
            AND COALESCE(pr.is_horse, false) = false
        )
        LOOP
            UPDATE wallets SET balance = balance + v_refund_amount, updated_at = NOW()
            WHERE user_id = v_player.user_id AND wallet_type = 'PLAYER';
            PERFORM log_wallet_transaction(v_player.user_id, 'PLAYER', v_refund_amount, 'credit', 'refund',
                'Tournament cancellation refund: ' || COALESCE(v_tournament.name, 'Unknown'), NULL, NULL, p_tournament_id);
            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;

            -- RAKE-AUDIT SWEEP 2: reverse the entry fee in the rake ledger so
            -- settlement no longer bills clubs for fees that were refunded.
            IF v_fee > 0 THEN
                INSERT INTO rake_records (
                  hand_id, table_id, club_id, rake_amount, pot_size, num_players,
                  bbj_contribution, is_tournament, tournament_id, source, metadata
                ) VALUES (
                  NULL, p_tournament_id, v_tournament.club_id, -v_fee, v_fee, 1,
                  0, true, p_tournament_id, 'atomic_cancel_tournament',
                  jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_player.user_id)
                );
                v_fees_reversed := v_fees_reversed + v_fee;
            END IF;
        END LOOP;
    END IF;
    IF v_fees_reversed > 0 THEN
        UPDATE tournaments SET total_rake = GREATEST(0, COALESCE(total_rake, 0) - v_fees_reversed)
         WHERE id = p_tournament_id;
        UPDATE unions SET total_rake = GREATEST(0, COALESCE(total_rake, 0) - v_fees_reversed)
         WHERE id = v_tournament.union_id AND v_tournament.union_id IS NOT NULL;
    END IF;
    DELETE FROM tournament_players WHERE tournament_id = p_tournament_id;
    UPDATE tables SET status = 'closed', current_players = 0 WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count,
      'total_refunded', v_total_refunded, 'fees_reversed', v_fees_reversed);
END; $function$;
