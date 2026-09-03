-- Atomic deduction for table chip locks (used for dealer tips and insurance)
CREATE OR REPLACE FUNCTION deduct_table_chip_lock(
    p_user_id uuid,
    p_table_id uuid,
    p_amount numeric
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
    v_current_amount numeric;
BEGIN
    -- Get current amount with row-level lock to prevent concurrent modifications
    SELECT amount INTO v_current_amount
    FROM table_chip_locks
    WHERE user_id = p_user_id AND table_id = p_table_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No chips locked at this table';
    END IF;

    IF v_current_amount < p_amount THEN
        RAISE EXCEPTION 'Insufficient chips for deduction';
    END IF;

    -- Deduct the amount safely
    UPDATE table_chip_locks
    SET amount = amount - p_amount
    WHERE user_id = p_user_id AND table_id = p_table_id;
END;
$$;
