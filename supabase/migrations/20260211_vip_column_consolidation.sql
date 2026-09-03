-- ═══════════════════════════════════════════════════════════════════════════════
-- VIP COLUMN CONSOLIDATION — Ensure all frontend-referenced columns exist
-- ═══════════════════════════════════════════════════════════════════════════════
-- The frontend references profiles.show_stack_bb, profiles.diamonds, and 
-- profiles.is_vip. This migration ensures they all exist.

-- 1. show_stack_bb on profiles (used by HamburgerMenu to persist preference)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_stack_bb BOOLEAN DEFAULT false;

-- 2. diamonds on profiles (quick-access cache of diamond_wallets.balance)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS diamonds INTEGER DEFAULT 0;

-- 3. is_vip + vip_level + vip_expires_at (idempotent)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vip_level TEXT DEFAULT 'none';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SYNC profiles.diamonds FROM diamond_wallets (one-time backfill)
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE profiles p
SET diamonds = COALESCE(dw.balance, 0)
FROM diamond_wallets dw
WHERE dw.user_id = p.id
  AND (p.diamonds IS NULL OR p.diamonds = 0);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TRIGGER: Keep profiles.diamonds in sync with diamond_wallets
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_sync_profile_diamonds()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE profiles
    SET diamonds = NEW.balance
    WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_profile_diamonds ON diamond_wallets;
CREATE TRIGGER trg_sync_profile_diamonds
    AFTER INSERT OR UPDATE OF balance ON diamond_wallets
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_profile_diamonds();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. TRIGGER: Sync profiles.is_vip from vip_subscriptions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_sync_profile_vip_status()
RETURNS TRIGGER AS $$
DECLARE
    v_is_vip BOOLEAN;
    v_vip_tier TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Find the best active subscription for this user
    SELECT vs.tier, vs.expires_at
    INTO v_vip_tier, v_expires_at
    FROM vip_subscriptions vs
    WHERE vs.user_id = NEW.user_id
      AND vs.is_active = true
      AND vs.expires_at > NOW()
    ORDER BY CASE vs.tier WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC
    LIMIT 1;

    v_is_vip := v_vip_tier IS NOT NULL;

    UPDATE profiles
    SET is_vip = v_is_vip,
        vip_level = COALESCE(v_vip_tier, 'none'),
        vip_expires_at = v_expires_at
    WHERE id = NEW.user_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_profile_vip ON vip_subscriptions;
CREATE TRIGGER trg_sync_profile_vip
    AFTER INSERT OR UPDATE ON vip_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_profile_vip_status();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. RPC: ADD DIAMONDS (for purchases/rewards)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_add_diamonds(
    p_user_id UUID,
    p_amount INTEGER,
    p_reason TEXT DEFAULT 'purchase'
)
RETURNS JSONB AS $$
DECLARE
    v_new_balance INTEGER;
BEGIN
    -- Update diamond_wallets (trigger will sync to profiles)
    UPDATE diamond_wallets
    SET balance = balance + p_amount,
        lifetime_earned = lifetime_earned + p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    -- If no wallet exists, create one
    IF NOT FOUND THEN
        INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
        VALUES (p_user_id, p_amount, p_amount, 0);
    END IF;

    SELECT balance INTO v_new_balance
    FROM diamond_wallets WHERE user_id = p_user_id;

    -- Record transaction (wallet_type/type/category constrained by CHECK constraints)
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, description, category)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, p_reason, 'promo');

    RETURN jsonb_build_object('success', true, 'new_balance', v_new_balance);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION fn_add_diamonds TO authenticated;
