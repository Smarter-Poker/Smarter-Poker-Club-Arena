-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎫 VIP SUBSCRIPTIONS — Purchasable VIP Cards & Feature Gating
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. VIP SUBSCRIPTIONS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vip_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
    purchased_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    duration_days INTEGER NOT NULL,
    diamond_cost INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vip_subscriptions_user ON vip_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_vip_subscriptions_active ON vip_subscriptions(user_id, is_active, expires_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FEATURE PURCHASES TABLE (A-la-carte)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feature_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    feature TEXT NOT NULL,
    purchased_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ, -- NULL = permanent or use-based
    uses_remaining INTEGER, -- NULL = unlimited within expiry
    diamond_cost INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_purchases_user ON feature_purchases(user_id, feature);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. VIP PRICING TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vip_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    diamond_cost INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tier, duration_days)
);

-- Insert default pricing
INSERT INTO vip_pricing (tier, duration_days, diamond_cost) VALUES
    ('bronze', 7, 100),
    ('bronze', 30, 350),
    ('bronze', 90, 900),
    ('silver', 7, 250),
    ('silver', 30, 900),
    ('silver', 90, 2400),
    ('gold', 7, 500),
    ('gold', 30, 1800),
    ('gold', 90, 4800)
ON CONFLICT (tier, duration_days) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. FEATURE PRICING TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feature_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature TEXT NOT NULL UNIQUE,
    diamond_cost INTEGER NOT NULL,
    usage_type TEXT NOT NULL CHECK (usage_type IN ('per_use', 'per_session', 'permanent')),
    description TEXT,
    vip_tiers_included TEXT[] DEFAULT '{}', -- Which VIP tiers get this free
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default feature pricing
INSERT INTO feature_pricing (feature, diamond_cost, usage_type, description, vip_tiers_included) VALUES
    ('rabbit_hunt', 5, 'per_use', 'See what cards would have come', ARRAY['bronze', 'silver', 'gold']),
    ('show_stack_bb', 5, 'per_session', 'Display stack in big blinds', ARRAY['bronze', 'silver', 'gold']),
    ('offline_protection', 10, 'per_session', 'Protect from timeout when offline', ARRAY['gold']),
    ('time_bank_seconds', 1, 'per_use', 'Extra time bank (per 10 seconds)', ARRAY[]::TEXT[]),
    ('theme_unlock', 25, 'permanent', 'Unlock table theme', ARRAY[]::TEXT[]),
    ('club_creation', 100, 'permanent', 'Create additional club', ARRAY[]::TEXT[]),
    ('emoji_pack', 1, 'permanent', 'Unlock 50 emojis', ARRAY[]::TEXT[]),
    ('tag_pack', 1, 'permanent', 'Unlock 100 player tags', ARRAY[]::TEXT[])
ON CONFLICT (feature) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. RPC: GET ACTIVE VIP SUBSCRIPTION
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_vip_subscription(p_user_id UUID)
RETURNS TABLE (
    tier TEXT,
    expires_at TIMESTAMPTZ,
    days_remaining INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        vs.tier,
        vs.expires_at,
        EXTRACT(DAY FROM (vs.expires_at - NOW()))::INTEGER as days_remaining
    FROM vip_subscriptions vs
    WHERE vs.user_id = p_user_id 
      AND vs.is_active = true 
      AND vs.expires_at > NOW()
    ORDER BY 
        CASE vs.tier WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC,
        vs.expires_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. RPC: PURCHASE VIP CARD
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_purchase_vip_card(
    p_user_id UUID,
    p_tier TEXT,
    p_duration_days INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_diamond_cost INTEGER;
    v_current_balance INTEGER;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get pricing
    SELECT diamond_cost INTO v_diamond_cost
    FROM vip_pricing
    WHERE tier = p_tier AND duration_days = p_duration_days AND is_active = true;
    
    IF v_diamond_cost IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid tier or duration');
    END IF;
    
    -- Check diamond balance
    SELECT COALESCE(balance, 0) INTO v_current_balance
    FROM diamond_wallets
    WHERE user_id = p_user_id;
    
    IF v_current_balance < v_diamond_cost THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds', 'required', v_diamond_cost, 'balance', v_current_balance);
    END IF;
    
    -- Deduct diamonds
    UPDATE diamond_wallets
    SET balance = balance - v_diamond_cost, updated_at = NOW()
    WHERE user_id = p_user_id;
    
    -- Calculate expiry (extend if existing subscription of same or lower tier)
    SELECT GREATEST(NOW(), COALESCE(MAX(expires_at), NOW()))
    INTO v_expires_at
    FROM vip_subscriptions
    WHERE user_id = p_user_id AND is_active = true AND tier = p_tier;
    
    v_expires_at := v_expires_at + (p_duration_days || ' days')::INTERVAL;
    
    -- Create subscription
    INSERT INTO vip_subscriptions (user_id, tier, expires_at, duration_days, diamond_cost)
    VALUES (p_user_id, p_tier, v_expires_at, p_duration_days, v_diamond_cost);
    
    -- Record transaction
    INSERT INTO wallet_transactions (user_id, type, amount, description)
    VALUES (p_user_id, 'VIP_PURCHASE', -v_diamond_cost, 'VIP ' || p_tier || ' card (' || p_duration_days || ' days)');
    
    RETURN jsonb_build_object(
        'success', true, 
        'tier', p_tier, 
        'expires_at', v_expires_at,
        'diamond_cost', v_diamond_cost
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. RPC: CHECK FEATURE ACCESS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_check_feature_access(
    p_user_id UUID,
    p_feature TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_vip_tier TEXT;
    v_feature_pricing RECORD;
    v_has_purchase BOOLEAN;
BEGIN
    -- Get user's active VIP tier
    SELECT tier INTO v_vip_tier
    FROM vip_subscriptions
    WHERE user_id = p_user_id AND is_active = true AND expires_at > NOW()
    ORDER BY CASE tier WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC
    LIMIT 1;
    
    -- Get feature pricing
    SELECT * INTO v_feature_pricing
    FROM feature_pricing
    WHERE feature = p_feature;
    
    IF v_feature_pricing IS NULL THEN
        RETURN jsonb_build_object('has_access', false, 'error', 'Unknown feature');
    END IF;
    
    -- Check if VIP grants this feature
    IF v_vip_tier IS NOT NULL AND v_vip_tier = ANY(v_feature_pricing.vip_tiers_included) THEN
        RETURN jsonb_build_object('has_access', true, 'is_vip', true, 'vip_tier', v_vip_tier);
    END IF;
    
    -- Check for active a-la-carte purchase
    SELECT EXISTS(
        SELECT 1 FROM feature_purchases
        WHERE user_id = p_user_id 
          AND feature = p_feature
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (uses_remaining IS NULL OR uses_remaining > 0)
    ) INTO v_has_purchase;
    
    IF v_has_purchase THEN
        RETURN jsonb_build_object('has_access', true, 'is_vip', false, 'purchased', true);
    END IF;
    
    -- No access - return cost
    RETURN jsonb_build_object(
        'has_access', false, 
        'is_vip', v_vip_tier IS NOT NULL,
        'diamond_cost', v_feature_pricing.diamond_cost,
        'usage_type', v_feature_pricing.usage_type
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. RPC: PURCHASE FEATURE (A-la-carte)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_purchase_feature(
    p_user_id UUID,
    p_feature TEXT,
    p_quantity INTEGER DEFAULT 1
)
RETURNS JSONB AS $$
DECLARE
    v_feature_pricing RECORD;
    v_total_cost INTEGER;
    v_current_balance INTEGER;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Get feature pricing
    SELECT * INTO v_feature_pricing
    FROM feature_pricing
    WHERE feature = p_feature;
    
    IF v_feature_pricing IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unknown feature');
    END IF;
    
    v_total_cost := v_feature_pricing.diamond_cost * p_quantity;
    
    -- Check diamond balance
    SELECT COALESCE(balance, 0) INTO v_current_balance
    FROM diamond_wallets
    WHERE user_id = p_user_id;
    
    IF v_current_balance < v_total_cost THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds', 'required', v_total_cost);
    END IF;
    
    -- Deduct diamonds
    UPDATE diamond_wallets
    SET balance = balance - v_total_cost, updated_at = NOW()
    WHERE user_id = p_user_id;
    
    -- Set expiry based on usage type
    IF v_feature_pricing.usage_type = 'per_session' THEN
        v_expires_at := NOW() + INTERVAL '24 hours';
    ELSIF v_feature_pricing.usage_type = 'permanent' THEN
        v_expires_at := NULL;
    ELSE
        v_expires_at := NULL; -- per_use tracks uses_remaining instead
    END IF;
    
    -- Record purchase
    INSERT INTO feature_purchases (user_id, feature, expires_at, uses_remaining, diamond_cost)
    VALUES (
        p_user_id, 
        p_feature, 
        v_expires_at,
        CASE WHEN v_feature_pricing.usage_type = 'per_use' THEN p_quantity ELSE NULL END,
        v_total_cost
    );
    
    RETURN jsonb_build_object('success', true, 'feature', p_feature, 'cost', v_total_cost);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. RPC: CONSUME FEATURE USE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_consume_feature_use(
    p_user_id UUID,
    p_feature TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE feature_purchases
    SET uses_remaining = uses_remaining - 1
    WHERE user_id = p_user_id 
      AND feature = p_feature 
      AND uses_remaining > 0
      AND (expires_at IS NULL OR expires_at > NOW());
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT EXECUTE ON FUNCTION fn_get_vip_subscription TO authenticated;
GRANT EXECUTE ON FUNCTION fn_purchase_vip_card TO authenticated;
GRANT EXECUTE ON FUNCTION fn_check_feature_access TO authenticated;
GRANT EXECUTE ON FUNCTION fn_purchase_feature TO authenticated;
GRANT EXECUTE ON FUNCTION fn_consume_feature_use TO authenticated;
