-- 20260312010_referral_system.sql
-- Referral codes and redemption tracking

BEGIN;

-- Referral codes table
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  uses INT NOT NULL DEFAULT 0,
  max_uses INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);

-- Referral redemptions table
CREATE TABLE IF NOT EXISTS referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referee_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  chips_awarded_referrer INT NOT NULL DEFAULT 500,
  chips_awarded_referee INT NOT NULL DEFAULT 250,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer ON referral_redemptions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referee ON referral_redemptions(referee_id);

-- RLS for referral_codes
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users read own referral codes' AND tablename = 'referral_codes') THEN
    CREATE POLICY "Users read own referral codes" ON referral_codes FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users create own referral codes' AND tablename = 'referral_codes') THEN
    CREATE POLICY "Users create own referral codes" ON referral_codes FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- RLS for referral_redemptions
ALTER TABLE referral_redemptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users read own referral redemptions' AND tablename = 'referral_redemptions') THEN
    CREATE POLICY "Users read own referral redemptions" ON referral_redemptions FOR SELECT
      USING (auth.uid() = referrer_id OR auth.uid() = referee_id);
  END IF;
END $$;

-- RPC: Redeem a referral code — validates, enforces daily cap, awards chips
CREATE OR REPLACE FUNCTION redeem_referral_code(
  p_referee_id UUID,
  p_code TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_referrer_id UUID;
  v_code_id UUID;
  v_uses INT;
  v_max_uses INT;
  v_today_count INT;
  v_chips_referrer INT := 500;
  v_chips_referee INT := 250;
BEGIN
  -- Look up the code
  SELECT id, user_id, uses, max_uses INTO v_code_id, v_referrer_id, v_uses, v_max_uses
  FROM referral_codes
  WHERE code = UPPER(p_code);

  IF v_code_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid referral code');
  END IF;

  -- Cannot redeem own code
  IF v_referrer_id = p_referee_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot redeem your own referral code');
  END IF;

  -- Check if already redeemed by this user
  IF EXISTS (SELECT 1 FROM referral_redemptions WHERE referee_id = p_referee_id AND referrer_id = v_referrer_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already redeemed this referral');
  END IF;

  -- Check uses limit
  IF v_uses >= v_max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', 'Referral code has reached its limit');
  END IF;

  -- Check daily cap (5 per day per referrer)
  SELECT COUNT(*) INTO v_today_count
  FROM referral_redemptions
  WHERE referrer_id = v_referrer_id
    AND created_at >= date_trunc('day', now());

  IF v_today_count >= 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Referrer has reached daily limit');
  END IF;

  -- Insert redemption record
  INSERT INTO referral_redemptions (referrer_id, referee_id, code, chips_awarded_referrer, chips_awarded_referee)
  VALUES (v_referrer_id, p_referee_id, UPPER(p_code), v_chips_referrer, v_chips_referee);

  -- Update uses count
  UPDATE referral_codes SET uses = uses + 1 WHERE id = v_code_id;

  -- Award chips to referrer
  UPDATE profiles SET chips = COALESCE(chips, 0) + v_chips_referrer WHERE id = v_referrer_id;

  -- Award chips to referee
  UPDATE profiles SET chips = COALESCE(chips, 0) + v_chips_referee WHERE id = p_referee_id;

  RETURN jsonb_build_object(
    'success', true,
    'chips_referrer', v_chips_referrer,
    'chips_referee', v_chips_referee
  );
END;
$$;

COMMIT;
