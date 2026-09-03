-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: process_tournament_rebuy (restore 6-param version) + RLS gaps
-- ═══════════════════════════════════════════════════════════════════════════════
-- The 20260125800 migration accidentally replaced the correct 6-param version
-- with a 3-param version. This restores the original from 007_tournament_expansion.

-- Drop the broken 3-param version first
DROP FUNCTION IF EXISTS process_tournament_rebuy(UUID, UUID, NUMERIC);

-- Recreate with correct 6 parameters matching TournamentService.ts
CREATE OR REPLACE FUNCTION process_tournament_rebuy(
    p_tournament_id UUID,
    p_player_id UUID,
    p_rebuy_type TEXT, -- 'rebuy' or 'addon'
    p_cost DECIMAL,
    p_chips INTEGER,
    p_current_level INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rebuy_id UUID;
    v_wallet_ok BOOLEAN;
BEGIN
    -- Deduct from player wallet
    IF p_cost > 0 THEN
        v_wallet_ok := deduct_player_wallet(p_player_id, p_cost);
        IF NOT v_wallet_ok THEN
            RAISE EXCEPTION 'Insufficient balance for %', p_rebuy_type;
        END IF;
    END IF;

    -- Insert rebuy record
    INSERT INTO tournament_rebuys (
        tournament_id, player_id, type, cost, chips_received, blind_level
    )
    VALUES (
        p_tournament_id, p_player_id, p_rebuy_type, p_cost, p_chips, p_current_level
    )
    RETURNING id INTO v_rebuy_id;

    -- Update player chips
    UPDATE tournament_players
    SET chips = chips + p_chips,
        rebuys = CASE WHEN p_rebuy_type = 'rebuy' THEN COALESCE(rebuys, 0) + 1 ELSE rebuys END,
        add_on = CASE WHEN p_rebuy_type = 'addon' THEN TRUE ELSE add_on END
    WHERE tournament_id = p_tournament_id AND user_id = p_player_id;

    -- Update prize pool
    UPDATE tournaments
    SET prize_pool = COALESCE(prize_pool, 0) + p_cost
    WHERE id = p_tournament_id;

    -- Log wallet transaction
    PERFORM log_wallet_transaction(
        p_player_id, 'PLAYER', -p_cost, 'debit', p_rebuy_type,
        'Tournament ' || p_rebuy_type || ' (level ' || p_current_level || ')',
        NULL, NULL, p_tournament_id
    );

    RETURN v_rebuy_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_tournament_rebuy(UUID, UUID, TEXT, DECIMAL, INTEGER, INTEGER) TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: tournament_bounties missing UPDATE/DELETE RLS policies
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tournament_bounties_update_service' AND tablename = 'tournament_bounties') THEN
        CREATE POLICY "tournament_bounties_update_service" ON tournament_bounties FOR UPDATE USING (TRUE);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tournament_bounties_delete_service' AND tablename = 'tournament_bounties') THEN
        CREATE POLICY "tournament_bounties_delete_service" ON tournament_bounties FOR DELETE USING (TRUE);
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════════
