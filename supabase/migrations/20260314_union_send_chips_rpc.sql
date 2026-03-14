-- ════════════════════════════════════════════════════════════════════════════════
--  Migration: fn_union_send_chips_to_club — Atomic Union→Club chip transfer
--  Created: 2026-03-14 — Audit Round 3 fix for BUG #19 (phantom transaction)
-- ════════════════════════════════════════════════════════════════════════════════

-- ATOMIC TRANSFER: Debit union_wallets.chip_balance → Credit club owner's chip_balance
-- + Log to union_transactions in a single transaction.
-- If the union has insufficient chips, RAISE EXCEPTION (aborts entire TX).

CREATE OR REPLACE FUNCTION fn_union_send_chips_to_club(
    p_union_id UUID,
    p_club_id UUID,
    p_amount NUMERIC,
    p_notes TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_union_balance NUMERIC;
    v_owner_user_id UUID;
BEGIN
    -- 1. Validate amount
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Transfer amount must be positive';
    END IF;

    -- 2. Check union chip balance (SELECT ... FOR UPDATE locks the row)
    SELECT chip_balance INTO v_union_balance
    FROM public.union_wallets
    WHERE union_id = p_union_id
    FOR UPDATE;

    IF v_union_balance IS NULL THEN
        RAISE EXCEPTION 'Union wallet not found for union %', p_union_id;
    END IF;

    IF v_union_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient union chip balance. Available: %, Requested: %', v_union_balance, p_amount;
    END IF;

    -- 3. Find the club owner (recipient of chips)
    SELECT user_id INTO v_owner_user_id
    FROM public.club_members
    WHERE club_id = p_club_id AND role = 'owner'
    LIMIT 1;

    IF v_owner_user_id IS NULL THEN
        RAISE EXCEPTION 'Club owner not found for club %', p_club_id;
    END IF;

    -- 4. ATOMIC: Debit union wallet
    UPDATE public.union_wallets
    SET chip_balance = chip_balance - p_amount,
        updated_at = NOW()
    WHERE union_id = p_union_id;

    -- 5. ATOMIC: Credit club owner's chip balance
    UPDATE public.club_members
    SET chip_balance = chip_balance + p_amount
    WHERE club_id = p_club_id AND role = 'owner';

    -- 6. ATOMIC: Log the transaction
    INSERT INTO public.union_transactions (union_id, club_id, type, amount, notes)
    VALUES (p_union_id, p_club_id, 'send_to_club', p_amount, COALESCE(p_notes, 'Union chip distribution'));

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
