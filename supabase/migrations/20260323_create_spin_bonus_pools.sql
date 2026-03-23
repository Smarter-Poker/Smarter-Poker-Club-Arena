-- Create spin_bonus_pools table
CREATE TABLE IF NOT EXISTS spin_bonus_pools (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_deposited NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_drawn NUMERIC(12,2) NOT NULL DEFAULT 0,
  spin_count INTEGER NOT NULL DEFAULT 0,
  bonus_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(club_id)
);

-- Enable RLS
ALTER TABLE spin_bonus_pools ENABLE ROW LEVEL SECURITY;

-- Policy: service role can do everything, anon can read
CREATE POLICY "Service role full access" ON spin_bonus_pools FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Anon read access" ON spin_bonus_pools FOR SELECT USING (true);

-- RPC: Deposit into pool (atomic increment)
CREATE OR REPLACE FUNCTION spin_pool_deposit(p_club_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
  INSERT INTO spin_bonus_pools (club_id, balance, total_deposited, spin_count)
  VALUES (p_club_id, p_amount, p_amount, 1)
  ON CONFLICT (club_id) DO UPDATE SET
    balance = spin_bonus_pools.balance + p_amount,
    total_deposited = spin_bonus_pools.total_deposited + p_amount,
    spin_count = spin_bonus_pools.spin_count + 1,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Draw from pool (atomic, capped at balance)
CREATE OR REPLACE FUNCTION spin_pool_draw(p_club_id UUID, p_amount NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  v_available NUMERIC;
  v_actual NUMERIC;
BEGIN
  -- Lock the row
  SELECT balance INTO v_available
  FROM spin_bonus_pools
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available <= 0 THEN
    RETURN 0;
  END IF;

  v_actual := LEAST(p_amount, v_available);

  UPDATE spin_bonus_pools
  SET balance = balance - v_actual,
      total_drawn = total_drawn + v_actual,
      bonus_count = bonus_count + 1,
      updated_at = NOW()
  WHERE club_id = p_club_id;

  RETURN v_actual;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
