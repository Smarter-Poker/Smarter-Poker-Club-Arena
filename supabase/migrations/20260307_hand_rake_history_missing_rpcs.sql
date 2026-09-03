-- =============================================
-- Missing tables and RPC functions
-- hand_history, rake_history, increment_rake_generated, fn_toggle_message_reaction
-- =============================================

-- 1. hand_history table
CREATE TABLE IF NOT EXISTS hand_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id UUID,
  tournament_id UUID,
  hand_number INTEGER NOT NULL,
  game_variant TEXT NOT NULL DEFAULT 'nlh',
  small_blind DECIMAL(12,2) NOT NULL DEFAULT 0,
  big_blind DECIMAL(12,2) NOT NULL DEFAULT 0,
  pot_size DECIMAL(12,2) NOT NULL DEFAULT 0,
  rake_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  community_cards TEXT[],
  winners JSONB,
  players JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hand_history_table ON hand_history(table_id);
CREATE INDEX IF NOT EXISTS idx_hand_history_tournament ON hand_history(tournament_id);
CREATE INDEX IF NOT EXISTS idx_hand_history_created ON hand_history(created_at DESC);

-- 2. rake_history table
CREATE TABLE IF NOT EXISTS rake_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id UUID,
  club_id UUID,
  hand_number INTEGER,
  rake_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  pot_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  bbj_drop DECIMAL(12,2) NOT NULL DEFAULT 0,
  promo_drop DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rake_history_table ON rake_history(table_id);
CREATE INDEX IF NOT EXISTS idx_rake_history_club ON rake_history(club_id);
CREATE INDEX IF NOT EXISTS idx_rake_history_created ON rake_history(created_at DESC);

-- 3. increment_rake_generated RPC
CREATE OR REPLACE FUNCTION increment_rake_generated(
  p_club_id UUID,
  p_user_id UUID,
  p_amount DECIMAL
) RETURNS VOID AS $$
BEGIN
  UPDATE club_members
  SET rake_generated = COALESCE(rake_generated, 0) + p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. fn_toggle_message_reaction (alias for toggle_message_reaction)
-- Code calls with p_reaction, table column is "reaction" not "emoji"
CREATE OR REPLACE FUNCTION fn_toggle_message_reaction(
  p_message_id UUID,
  p_reaction VARCHAR(32),
  p_user_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_existing UUID;
  v_result JSONB;
BEGIN
  SELECT id INTO v_existing FROM message_reactions
  WHERE message_id = p_message_id AND user_id = p_user_id AND reaction = p_reaction;
  IF v_existing IS NOT NULL THEN
    DELETE FROM message_reactions WHERE id = v_existing;
    v_result := jsonb_build_object('action', 'removed', 'reaction', p_reaction);
  ELSE
    INSERT INTO message_reactions (message_id, user_id, reaction)
    VALUES (p_message_id, p_user_id, p_reaction);
    v_result := jsonb_build_object('action', 'added', 'reaction', p_reaction);
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4b. Generic increment() RPC function for atomic field increments
CREATE OR REPLACE FUNCTION increment(x DECIMAL)
RETURNS DECIMAL AS $$
BEGIN
  RETURN x;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Ensure all hand_history columns exist (existing table may have subset)
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS table_id UUID;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS tournament_id UUID;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS hand_number INTEGER;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS game_variant TEXT DEFAULT 'nlh';
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS small_blind DECIMAL(12,2) DEFAULT 0;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS big_blind DECIMAL(12,2) DEFAULT 0;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS rake_amount DECIMAL(12,2) DEFAULT 0;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS community_cards TEXT[];
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS winners JSONB;
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS players JSONB DEFAULT '[]';
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '[]';
ALTER TABLE hand_history ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE rake_history ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ DEFAULT NOW();

-- 6. Fix pot_size column type (original table had INTEGER, needs DECIMAL for exact values)
ALTER TABLE hand_history ALTER COLUMN pot_size TYPE DECIMAL(12,2) USING pot_size::DECIMAL(12,2);

-- 7. Ensure wallet_type constraint includes CLUB
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_wallet_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_wallet_type_check
CHECK (wallet_type IN ('PLAYER', 'CLUB', 'UNION', 'PLATFORM'));

-- 8. Expanded wallet_transactions category constraint
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_category_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_category_check
CHECK (category IN (
  'buyin', 'cashout', 'promo', 'rake', 'transfer',
  'tournament_buyin', 'tournament_winnings', 'tournament_cashout',
  'horse_refill', 'deposit', 'withdrawal', 'refund', 'bbj', 'bonus'
));
