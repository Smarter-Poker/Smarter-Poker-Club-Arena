-- ==============================================================================
-- ATOMIC TOURNAMENT UNREGISTER (Refund)
-- ==============================================================================
-- Safely deletes a tournament registration and refunds the player's wallet 
-- in a single atomic transaction.

CREATE OR REPLACE FUNCTION atomic_tournament_unregister(
  p_tournament_id UUID,
  p_user_id UUID,
  p_refund_amount NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_count INT;
  v_tournament_name TEXT;
BEGIN
  -- 1. Try to delete the registration. 
  -- We ONLY delete if status is 'registered'. If they are 'playing' or 'eliminated', it fails.
  WITH deleted AS (
    DELETE FROM tournament_players
    WHERE tournament_id = p_tournament_id 
      AND user_id = p_user_id 
      AND status = 'registered'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted_count FROM deleted;

  -- If no rows deleted, they were either not registered or already seated.
  IF v_deleted_count = 0 THEN
    RETURN FALSE;
  END IF;

  -- 2. Refund to Player Wallet securely
  UPDATE wallets
  SET balance = balance + p_refund_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  -- Fetch tournament name for logging
  SELECT name INTO v_tournament_name FROM tournaments WHERE id = p_tournament_id;

  -- 3. Log transaction
  PERFORM log_wallet_transaction(
    p_user_id,
    'PLAYER',
    p_refund_amount,
    'credit',
    'refund',
    'Tournament unregister refund: ' || COALESCE(v_tournament_name, 'Unknown'),
    NULL,
    NULL,
    p_tournament_id
  );

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION atomic_tournament_unregister(UUID, UUID, NUMERIC) TO anon, authenticated;
