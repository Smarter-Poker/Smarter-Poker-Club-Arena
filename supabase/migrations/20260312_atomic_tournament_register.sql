-- ==============================================================================
-- ATOMIC TOURNAMENT REGISTRATION (Buy-in)
-- ==============================================================================
-- Replaces vulnerable multi-step typescript operations with a single, transactional 
-- database function. Ensures chips are never lost if the player insertion fails.

CREATE OR REPLACE FUNCTION atomic_tournament_register(
  p_tournament_id UUID,
  p_user_id UUID,
  p_username TEXT,
  p_total_cost NUMERIC,
  p_current_bounty NUMERIC,
  p_mystery_bounty_value NUMERIC,
  p_is_bounty_tournament BOOLEAN
) RETURNS UUID AS $$
DECLARE
  v_wallet_balance NUMERIC;
  v_player_id UUID;
BEGIN
  -- 1. Check and deduct from player wallet securely
  SELECT balance INTO v_wallet_balance
  FROM wallets
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
  FOR UPDATE;

  IF NOT FOUND OR v_wallet_balance < p_total_cost THEN
    RAISE EXCEPTION 'Insufficient chips in Player Wallet.';
  END IF;

  UPDATE wallets
  SET balance = balance - p_total_cost,
      updated_at = NOW()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  -- 2. Insert into tournament_players
  IF p_is_bounty_tournament THEN
    INSERT INTO tournament_players (
      tournament_id,
      user_id,
      username,
      chips,
      status,
      current_bounty,
      mystery_bounty_value,
      bounties_collected,
      bounty_winnings
    ) VALUES (
      p_tournament_id,
      p_user_id,
      p_username,
      0,
      'registered',
      p_current_bounty,
      p_mystery_bounty_value,
      0,
      0
    ) RETURNING id INTO v_player_id;
  ELSE
    INSERT INTO tournament_players (
      tournament_id,
      user_id,
      username,
      chips,
      status
    ) VALUES (
      p_tournament_id,
      p_user_id,
      p_username,
      0,
      'registered'
    ) RETURNING id INTO v_player_id;
  END IF;

  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
