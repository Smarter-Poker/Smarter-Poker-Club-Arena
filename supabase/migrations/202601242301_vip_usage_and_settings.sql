-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎫 VIP MONTHLY USAGE & PROFILE EXTENSIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ADD VIP COLUMNS TO PROFILES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. VIP MONTHLY USAGE TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vip_monthly_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    feature TEXT NOT NULL,
    period_start DATE NOT NULL,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, feature, period_start)
);

CREATE INDEX IF NOT EXISTS idx_vip_monthly_usage_user ON vip_monthly_usage(user_id, period_start);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. INCREMENT VIP USAGE RPC
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_increment_vip_usage(
    p_user_id UUID,
    p_feature TEXT
)
RETURNS VOID AS $$
DECLARE
    v_period_start DATE;
BEGIN
    v_period_start := date_trunc('month', NOW())::DATE;
    
    INSERT INTO vip_monthly_usage (user_id, feature, period_start, usage_count)
    VALUES (p_user_id, p_feature, v_period_start, 1)
    ON CONFLICT (user_id, feature, period_start)
    DO UPDATE SET 
        usage_count = vip_monthly_usage.usage_count + 1,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION fn_increment_vip_usage TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. TABLE SETTINGS PREFERENCES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_table_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    show_stack_in_bb BOOLEAN DEFAULT false,
    offline_protection BOOLEAN DEFAULT false,
    auto_time_bank BOOLEAN DEFAULT false,
    four_color_deck BOOLEAN DEFAULT false,
    auto_muck BOOLEAN DEFAULT true,
    show_chat BOOLEAN DEFAULT true,
    sound_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. GET USER TABLE SETTINGS RPC
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_table_settings(p_user_id UUID)
RETURNS TABLE (
    show_stack_in_bb BOOLEAN,
    offline_protection BOOLEAN,
    auto_time_bank BOOLEAN,
    four_color_deck BOOLEAN,
    auto_muck BOOLEAN,
    show_chat BOOLEAN,
    sound_enabled BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        uts.show_stack_in_bb,
        uts.offline_protection,
        uts.auto_time_bank,
        uts.four_color_deck,
        uts.auto_muck,
        uts.show_chat,
        uts.sound_enabled
    FROM user_table_settings uts
    WHERE uts.user_id = p_user_id;
    
    -- Return defaults if no settings found
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, false, false, true, true, true;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. UPDATE USER TABLE SETTINGS RPC
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_update_table_settings(
    p_user_id UUID,
    p_show_stack_in_bb BOOLEAN DEFAULT NULL,
    p_offline_protection BOOLEAN DEFAULT NULL,
    p_auto_time_bank BOOLEAN DEFAULT NULL,
    p_four_color_deck BOOLEAN DEFAULT NULL,
    p_auto_muck BOOLEAN DEFAULT NULL,
    p_show_chat BOOLEAN DEFAULT NULL,
    p_sound_enabled BOOLEAN DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_table_settings (user_id, show_stack_in_bb, offline_protection, auto_time_bank, four_color_deck, auto_muck, show_chat, sound_enabled)
    VALUES (
        p_user_id,
        COALESCE(p_show_stack_in_bb, false),
        COALESCE(p_offline_protection, false),
        COALESCE(p_auto_time_bank, false),
        COALESCE(p_four_color_deck, false),
        COALESCE(p_auto_muck, true),
        COALESCE(p_show_chat, true),
        COALESCE(p_sound_enabled, true)
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
        show_stack_in_bb = COALESCE(p_show_stack_in_bb, user_table_settings.show_stack_in_bb),
        offline_protection = COALESCE(p_offline_protection, user_table_settings.offline_protection),
        auto_time_bank = COALESCE(p_auto_time_bank, user_table_settings.auto_time_bank),
        four_color_deck = COALESCE(p_four_color_deck, user_table_settings.four_color_deck),
        auto_muck = COALESCE(p_auto_muck, user_table_settings.auto_muck),
        show_chat = COALESCE(p_show_chat, user_table_settings.show_chat),
        sound_enabled = COALESCE(p_sound_enabled, user_table_settings.sound_enabled),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION fn_get_table_settings TO authenticated;
GRANT EXECUTE ON FUNCTION fn_update_table_settings TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. PLAYER NOTES TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    target_user_id UUID NOT NULL,
    note TEXT,
    color TEXT DEFAULT '#3b82f6',
    tags TEXT[] DEFAULT '{}',
    hands_played INTEGER DEFAULT 0,
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_player_notes_user ON player_notes(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PLAYER NOTES RPC
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_player_note(p_user_id UUID, p_target_id UUID)
RETURNS TABLE (
    note TEXT,
    color TEXT,
    tags TEXT[],
    hands_played INTEGER,
    last_seen TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT pn.note, pn.color, pn.tags, pn.hands_played, pn.last_seen
    FROM player_notes pn
    WHERE pn.user_id = p_user_id AND pn.target_user_id = p_target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION fn_save_player_note(
    p_user_id UUID,
    p_target_id UUID,
    p_note TEXT,
    p_color TEXT DEFAULT '#3b82f6',
    p_tags TEXT[] DEFAULT '{}'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO player_notes (user_id, target_user_id, note, color, tags, last_seen)
    VALUES (p_user_id, p_target_id, p_note, p_color, p_tags, NOW())
    ON CONFLICT (user_id, target_user_id)
    DO UPDATE SET
        note = p_note,
        color = p_color,
        tags = p_tags,
        last_seen = NOW(),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION fn_get_player_note TO authenticated;
GRANT EXECUTE ON FUNCTION fn_save_player_note TO authenticated;
