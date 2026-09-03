-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix Batch 2: Rewrite 10 actively-called RPCs with wrong column references
-- Found by comprehensive audit of all 1190 DB functions
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. atomic_table_cashout: wallet_transactions.reference_id → table_id
CREATE OR REPLACE FUNCTION atomic_table_cashout(p_user_id uuid, p_table_id uuid, p_seat_number integer)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_stack NUMERIC;
BEGIN
    SELECT stack INTO v_stack FROM table_seats
    WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active seat not found for cash-out'; END IF;
    IF v_stack > 0 THEN
        INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', v_stack)
        ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_stack, updated_at = NOW();
        INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id)
        VALUES (p_user_id, 'PLAYER', 'credit', v_stack, 'cashout', 'Cash-out from table', p_table_id);
    END IF;
    UPDATE table_seats SET left_at = NOW(), leave_pending = false
    WHERE table_id = p_table_id AND user_id = p_user_id AND seat_number = p_seat_number AND left_at IS NULL;
    UPDATE tables SET current_players = (SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL)
    WHERE id = p_table_id;
    RETURN v_stack;
END; $func$;

-- 2. atomic_table_rebuy: wallet_transactions.reference_id → table_id
CREATE OR REPLACE FUNCTION atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_seat_exists BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL) INTO v_seat_exists;
    IF NOT v_seat_exists THEN RAISE EXCEPTION 'Active seat not found for auto-rebuy'; END IF;
    UPDATE wallets SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient balance for auto-rebuy'; END IF;
    UPDATE table_seats SET stack = stack + p_amount
    WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, table_id)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'rebuy', 'Auto-rebuy topup at table', p_table_id);
END; $func$;

-- 3. atomic_seat_horse: remove profiles.horse_status (doesn't exist)
CREATE OR REPLACE FUNCTION atomic_seat_horse(p_table_id uuid, p_horse_id uuid, p_seat_number integer, p_buy_in numeric, p_table_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
DECLARE v_balance DECIMAL;
BEGIN
    SELECT balance INTO v_balance FROM wallets WHERE user_id = p_horse_id AND wallet_type = 'PLAYER' FOR UPDATE;
    IF v_balance IS NULL OR v_balance < p_buy_in THEN RETURN FALSE; END IF;
    UPDATE wallets SET balance = balance - p_buy_in, updated_at = NOW() WHERE user_id = p_horse_id AND wallet_type = 'PLAYER';
    INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description)
    VALUES (p_horse_id, 'PLAYER', p_buy_in, 'debit', 'buyin', 'Buy-in at ' || p_table_name || ': ' || p_buy_in || ' chips');
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
    VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active', NOW());
    UPDATE tables SET current_players = (SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND status IN ('active', 'sitting_out') AND left_at IS NULL)
    WHERE id = p_table_id;
    RETURN TRUE;
END; $func$;

-- 4. credit_player_rakeback: wallet_transactions.period_id doesn't exist
CREATE OR REPLACE FUNCTION credit_player_rakeback(p_user_id uuid, p_amount numeric, p_period_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
BEGIN
    IF p_user_id != auth.uid() THEN RAISE EXCEPTION 'Unauthorized: can only credit your own account'; END IF;
    IF p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'rakeback',
      CASE WHEN p_period_id IS NOT NULL THEN 'Rakeback credit for period ' || p_period_id::text ELSE 'Rakeback credit' END);
END; $func$;

-- 5. fn_save_player_note: note → notes, color → color_label
CREATE OR REPLACE FUNCTION fn_save_player_note(p_user_id uuid, p_target_id uuid, p_note text, p_color text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
BEGIN
    INSERT INTO player_notes (user_id, target_user_id, notes, color_label, updated_at)
    VALUES (p_user_id, p_target_id, p_note, p_color, NOW())
    ON CONFLICT (user_id, target_user_id) DO UPDATE SET notes = p_note, color_label = p_color, updated_at = NOW();
END; $func$;

-- 6. seat_horse: seat → seat_number, seated_at → joined_at
CREATE OR REPLACE FUNCTION seat_horse(p_table_id uuid, p_horse_id uuid, p_seat integer, p_stack numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
BEGIN
    IF EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND seat_number = p_seat AND status = 'active') THEN
        RETURN FALSE;
    END IF;
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
    VALUES (p_table_id, p_horse_id, p_seat, p_stack, 'active', NOW());
    RETURN TRUE;
END; $func$;

-- 7. add_vip_points: profiles.vip_points doesn't exist — ledger only
CREATE OR REPLACE FUNCTION add_vip_points(p_user_id uuid, p_amount integer, p_type varchar, p_desc text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
BEGIN
    INSERT INTO public.vip_points_ledger (user_id, amount, transaction_type, description)
    VALUES (p_user_id, p_amount, p_type, p_desc);
END; $func$;

-- 8. atomic_cancel_tournament: canceled_at → ended_at
CREATE OR REPLACE FUNCTION atomic_cancel_tournament(p_tournament_id uuid, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
DECLARE
    v_tournament RECORD;
    v_player RECORD;
    v_refund_amount NUMERIC;
    v_refunded_count INT := 0;
    v_total_refunded NUMERIC := 0;
BEGIN
    SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    IF v_tournament.status IN ('completed', 'canceled', 'CANCELLED') THEN
        RAISE EXCEPTION 'Tournament is already %', v_tournament.status;
    END IF;
    v_refund_amount := COALESCE(v_tournament.buy_in_amount, 0) + COALESCE(v_tournament.buy_in_fee, 0);
    UPDATE tournaments SET status = 'CANCELLED', ended_at = NOW(), updated_at = NOW() WHERE id = p_tournament_id;
    IF v_refund_amount > 0 THEN
        FOR v_player IN (SELECT user_id, id FROM tournament_players WHERE tournament_id = p_tournament_id)
        LOOP
            UPDATE wallets SET balance = balance + v_refund_amount, updated_at = NOW()
            WHERE user_id = v_player.user_id AND wallet_type = 'PLAYER';
            PERFORM log_wallet_transaction(v_player.user_id, 'PLAYER', v_refund_amount, 'credit', 'refund',
                'Tournament cancellation refund: ' || COALESCE(v_tournament.name, 'Unknown'), NULL, NULL, p_tournament_id);
            v_refunded_count := v_refunded_count + 1;
            v_total_refunded := v_total_refunded + v_refund_amount;
        END LOOP;
    END IF;
    DELETE FROM tournament_players WHERE tournament_id = p_tournament_id;
    UPDATE tables SET status = 'closed', current_players = 0 WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('success', true, 'refunded_count', v_refunded_count, 'total_refunded', v_total_refunded);
END; $func$;

-- 9. claim_daily_bonus: last_daily_bonus → last_login_date
CREATE OR REPLACE FUNCTION claim_daily_bonus(p_user_id uuid, p_amount numeric DEFAULT 100)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_last_claimed TIMESTAMP;
BEGIN
    SELECT last_login_date INTO v_last_claimed FROM profiles WHERE id = p_user_id;
    IF v_last_claimed IS NOT NULL AND v_last_claimed > NOW() - INTERVAL '24 hours' THEN
        RETURN json_build_object('success', false, 'error', 'Already claimed today');
    END IF;
    UPDATE profiles SET last_login_date = NOW(), updated_at = NOW() WHERE id = p_user_id;
    PERFORM credit_player_wallet(p_user_id, p_amount);
    RETURN json_build_object('success', true, 'amount', p_amount);
END; $func$;

-- 10. update_player_hand_stats: hands_played/hands_won → total_hands_played
CREATE OR REPLACE FUNCTION update_player_hand_stats(p_user_id uuid, p_hands_played integer DEFAULT 1, p_hands_won integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
BEGIN
    UPDATE profiles SET total_hands_played = COALESCE(total_hands_played, 0) + p_hands_played, updated_at = NOW() WHERE id = p_user_id;
END; $func$;

-- Supporting: create vip_points_ledger if not exists
CREATE TABLE IF NOT EXISTS vip_points_ledger (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL,
    amount integer NOT NULL,
    transaction_type varchar NOT NULL,
    description text,
    created_at timestamptz DEFAULT now()
);
ALTER TABLE vip_points_ledger ENABLE ROW LEVEL SECURITY;

-- Supporting: ensure unique index for player_notes upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_notes_user_target ON player_notes(user_id, target_user_id);
