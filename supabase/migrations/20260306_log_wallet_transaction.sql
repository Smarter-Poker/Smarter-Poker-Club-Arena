-- ═══════════════════════════════════════════════════════════════════════════════
--  Log Wallet Transaction RPC
--  SECURITY DEFINER function to insert audit records into wallet_transactions
--  Bypasses RLS so all chip movements can be recorded regardless of user role
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION log_wallet_transaction(
    p_user_id UUID,
    p_wallet_type TEXT,
    p_amount DECIMAL,
    p_type TEXT,
    p_category TEXT,
    p_description TEXT,
    p_table_id UUID DEFAULT NULL,
    p_hand_id UUID DEFAULT NULL,
    p_related_entity_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tx_id UUID;
BEGIN
    INSERT INTO wallet_transactions (
        id, user_id, wallet_type, amount, type, category,
        description, table_id, hand_id, related_entity_id, created_at
    ) VALUES (
        gen_random_uuid(), p_user_id, p_wallet_type, p_amount, p_type, p_category,
        p_description, p_table_id, p_hand_id, p_related_entity_id, NOW()
    )
    RETURNING id INTO v_tx_id;

    RETURN v_tx_id;
END;
$$;

GRANT EXECUTE ON FUNCTION log_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID, UUID) TO anon, authenticated;
