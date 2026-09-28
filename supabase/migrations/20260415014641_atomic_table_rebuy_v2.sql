-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260415014641 as "atomic_table_rebuy_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
DROP FUNCTION IF EXISTS atomic_table_rebuy(UUID, UUID, NUMERIC);

CREATE OR REPLACE FUNCTION atomic_table_rebuy(
    p_user_id UUID,
    p_table_id UUID,
    p_amount NUMERIC
) RETURNS TABLE(new_stack NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_seat_number INT;
    v_new_stack NUMERIC;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Rebuy amount must be positive';
    END IF;

    SELECT seat_number INTO v_seat_number
    FROM table_seats
    WHERE table_id = p_table_id
      AND user_id = p_user_id
      AND left_at IS NULL
    LIMIT 1;

    IF v_seat_number IS NULL THEN
        RAISE EXCEPTION 'Player has no active seat at this table to rebuy into';
    END IF;

    UPDATE wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id
      AND wallet_type = 'PLAYER'
      AND balance >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient wallet balance for rebuy';
    END IF;

    UPDATE table_seats
    SET stack = stack + p_amount, updated_at = NOW()
    WHERE table_id = p_table_id
      AND user_id = p_user_id
      AND left_at IS NULL
    RETURNING stack INTO v_new_stack;

    INSERT INTO wallet_transactions (
        user_id, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'debit', -p_amount, 'rebuy',
        'Cash game rebuy at table', p_table_id
    );

    RETURN QUERY SELECT v_new_stack;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_table_rebuy(UUID, UUID, NUMERIC) TO authenticated, anon, service_role;
