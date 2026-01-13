-- ═══════════════════════════════════════════════════════════════════════════════
-- 🐴 HYDRA HORSE FLEET — Bot User Accounts
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Creates the Hydra bot fleet as real user accounts in the system.
-- Each horse has a unique player number starting at #101.
--
-- These accounts are indistinguishable from human players (Invisible Fleet Law)
-- but are flagged internally for the Hydra system to control.
--
-- Created: 2026-01-13
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- HORSE PROFILES TABLE EXTENSION
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add horse-specific columns to profiles if not exists
DO $$
BEGIN
    -- Is this account a Hydra horse?
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'is_horse') THEN
        ALTER TABLE profiles ADD COLUMN is_horse BOOLEAN DEFAULT FALSE;
    END IF;
    
    -- Horse behavior profile (fish, reg, nit, lag)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'horse_profile') THEN
        ALTER TABLE profiles ADD COLUMN horse_profile TEXT CHECK (horse_profile IN ('fish', 'reg', 'nit', 'lag', 'maniac'));
    END IF;
    
    -- Horse status
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'horse_status') THEN
        ALTER TABLE profiles ADD COLUMN horse_status TEXT DEFAULT 'available' CHECK (horse_status IN ('available', 'seated', 'leaving', 'disabled'));
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HORSE ACTIVITY TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS horse_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    horse_id UUID NOT NULL REFERENCES profiles(id),
    table_id UUID NOT NULL,
    
    -- Session details
    seat_number INTEGER,
    buy_in_amount INTEGER NOT NULL,
    current_stack INTEGER NOT NULL,
    
    -- Timing
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    scheduled_leave_at TIMESTAMP WITH TIME ZONE,
    left_at TIMESTAMP WITH TIME ZONE,
    
    -- Stats
    hands_played INTEGER DEFAULT 0,
    orbits_played INTEGER DEFAULT 0,
    
    -- Organic recede tracking
    leaving_after_orbit BOOLEAN DEFAULT FALSE,
    triggered_by_player_id UUID REFERENCES profiles(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_horse_sessions_horse ON horse_sessions(horse_id);
CREATE INDEX IF NOT EXISTS idx_horse_sessions_table ON horse_sessions(table_id);
CREATE INDEX IF NOT EXISTS idx_horse_sessions_active ON horse_sessions(left_at) WHERE left_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED HORSE FLEET (300 Horses, #101 - #400)
-- ═══════════════════════════════════════════════════════════════════════════════

-- First names pool
CREATE TEMP TABLE IF NOT EXISTS horse_first_names (name TEXT);
INSERT INTO horse_first_names (name) VALUES
    ('Alex'), ('Jordan'), ('Taylor'), ('Morgan'), ('Casey'),
    ('Riley'), ('Quinn'), ('Charlie'), ('Skyler'), ('Dakota'),
    ('River'), ('Sage'), ('Phoenix'), ('Avery'), ('Blake'),
    ('Cameron'), ('Drew'), ('Emerson'), ('Finley'), ('Gray'),
    ('Harper'), ('Indie'), ('Jamie'), ('Kai'), ('Lane'),
    ('Mason'), ('Nico'), ('Oakley'), ('Parker'), ('Reese'),
    ('Sam'), ('Tatum'), ('Val'), ('Winter'), ('Zion'),
    ('Asher'), ('Bailey'), ('Carter'), ('Dylan'), ('Ellis'),
    ('Flynn'), ('Greer'), ('Hayden'), ('Ira'), ('Jules'),
    ('Kerry'), ('Logan'), ('Micah'), ('Noah'), ('Ollie');

-- Last names pool
CREATE TEMP TABLE IF NOT EXISTS horse_last_names (name TEXT);
INSERT INTO horse_last_names (name) VALUES
    ('Rivers'), ('Stone'), ('Knight'), ('Wolf'), ('Fox'),
    ('Crow'), ('Storm'), ('Blaze'), ('Frost'), ('Vale'),
    ('Chase'), ('Cross'), ('Steele'), ('Hawk'), ('Drake'),
    ('Raven'), ('Wolfe'), ('Pierce'), ('North'), ('West'),
    ('East'), ('South'), ('Brooks'), ('Woods'), ('Fields'),
    ('Lake'), ('Hill'), ('Dale'), ('Glen'), ('Marsh');

-- Profile types distribution (roughly: 40% fish, 30% reg, 15% nit, 10% lag, 5% maniac)
CREATE TEMP TABLE IF NOT EXISTS horse_profiles_dist (profile TEXT, weight INTEGER);
INSERT INTO horse_profiles_dist VALUES
    ('fish', 40), ('reg', 30), ('nit', 15), ('lag', 10), ('maniac', 5);

-- Generate horses
DO $$
DECLARE
    v_player_num INTEGER := 101;
    v_first TEXT;
    v_last TEXT;
    v_profile TEXT;
    v_username TEXT;
    v_display_name TEXT;
    v_avatar_seed TEXT;
    v_horse_id UUID;
BEGIN
    -- Generate 300 horses (#101 - #400)
    WHILE v_player_num <= 400 LOOP
        -- Random first name
        SELECT name INTO v_first FROM horse_first_names ORDER BY random() LIMIT 1;
        -- Random last name
        SELECT name INTO v_last FROM horse_last_names ORDER BY random() LIMIT 1;
        -- Random profile (weighted)
        SELECT profile INTO v_profile FROM horse_profiles_dist ORDER BY random() * weight DESC LIMIT 1;
        
        v_username := lower(v_first || v_last || v_player_num);
        v_display_name := v_first || ' ' || substr(v_last, 1, 1) || '.';
        v_avatar_seed := v_first || v_player_num;
        
        -- Check if horse already exists
        SELECT id INTO v_horse_id FROM profiles WHERE player_number = v_player_num;
        
        IF v_horse_id IS NULL THEN
            -- Create horse profile
            INSERT INTO profiles (
                id,
                email,
                username,
                display_name,
                player_number,
                avatar_url,
                role,
                is_horse,
                horse_profile,
                horse_status,
                created_at,
                updated_at
            ) VALUES (
                gen_random_uuid(),
                'horse' || v_player_num || '@hydra.internal',
                v_username,
                v_display_name,
                v_player_num,
                'https://api.dicebear.com/7.x/avataaars/svg?seed=' || v_avatar_seed,
                'user',
                TRUE,
                v_profile,
                'available',
                now(),
                now()
            );
        ELSE
            -- Update existing horse
            UPDATE profiles SET
                is_horse = TRUE,
                horse_profile = v_profile,
                horse_status = 'available',
                updated_at = now()
            WHERE id = v_horse_id;
        END IF;
        
        v_player_num := v_player_num + 1;
    END LOOP;
    
    RAISE NOTICE 'Created/Updated 300 Hydra horses (#101 - #400)';
END $$;

-- Clean up temp tables
DROP TABLE IF EXISTS horse_first_names;
DROP TABLE IF EXISTS horse_last_names;
DROP TABLE IF EXISTS horse_profiles_dist;

-- ═══════════════════════════════════════════════════════════════════════════════
-- HYDRA CONTROL FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Get available horses for seeding
CREATE OR REPLACE FUNCTION get_available_horses(p_count INTEGER DEFAULT 3, p_profile TEXT DEFAULT NULL)
RETURNS TABLE (
    id UUID,
    display_name TEXT,
    avatar_url TEXT,
    horse_profile TEXT,
    player_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.display_name,
        p.avatar_url,
        p.horse_profile,
        p.player_number
    FROM profiles p
    WHERE p.is_horse = TRUE
    AND p.horse_status = 'available'
    AND (p_profile IS NULL OR p.horse_profile = p_profile)
    ORDER BY random()
    LIMIT p_count;
END;
$$;

-- Seat a horse at a table
CREATE OR REPLACE FUNCTION seat_horse(
    p_horse_id UUID,
    p_table_id UUID,
    p_seat_number INTEGER,
    p_buy_in INTEGER
)
RETURNS UUID -- Returns session ID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_session_id UUID;
BEGIN
    -- Verify horse is available
    IF NOT EXISTS (
        SELECT 1 FROM profiles 
        WHERE id = p_horse_id AND is_horse = TRUE AND horse_status = 'available'
    ) THEN
        RAISE EXCEPTION 'Horse not available';
    END IF;
    
    -- Update horse status
    UPDATE profiles SET horse_status = 'seated', updated_at = now()
    WHERE id = p_horse_id;
    
    -- Create session
    INSERT INTO horse_sessions (horse_id, table_id, seat_number, buy_in_amount, current_stack)
    VALUES (p_horse_id, p_table_id, p_seat_number, p_buy_in, p_buy_in)
    RETURNING id INTO v_session_id;
    
    -- Seat at table (using existing seats table)
    INSERT INTO seats (table_id, user_id, seat_number, stack, status)
    VALUES (p_table_id, p_horse_id, p_seat_number, p_buy_in, 'active')
    ON CONFLICT (table_id, seat_number) DO UPDATE SET
        user_id = p_horse_id,
        stack = p_buy_in,
        status = 'active';
    
    RETURN v_session_id;
END;
$$;

-- Schedule horse to leave (Organic Recede)
CREATE OR REPLACE FUNCTION schedule_horse_leave(
    p_horse_id UUID,
    p_triggered_by UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Mark horse as leaving
    UPDATE profiles SET horse_status = 'leaving', updated_at = now()
    WHERE id = p_horse_id AND is_horse = TRUE;
    
    -- Update active session
    UPDATE horse_sessions SET
        leaving_after_orbit = TRUE,
        triggered_by_player_id = p_triggered_by,
        scheduled_leave_at = now() + INTERVAL '2 minutes' -- Approximate orbit time
    WHERE horse_id = p_horse_id AND left_at IS NULL;
    
    RETURN TRUE;
END;
$$;

-- Remove horse from table
CREATE OR REPLACE FUNCTION remove_horse(p_horse_id UUID, p_table_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_final_stack INTEGER;
BEGIN
    -- Get final stack
    SELECT stack INTO v_final_stack FROM seats
    WHERE table_id = p_table_id AND user_id = p_horse_id;
    
    -- Remove from seats
    DELETE FROM seats WHERE table_id = p_table_id AND user_id = p_horse_id;
    
    -- Update session
    UPDATE horse_sessions SET
        left_at = now(),
        current_stack = COALESCE(v_final_stack, current_stack)
    WHERE horse_id = p_horse_id AND table_id = p_table_id AND left_at IS NULL;
    
    -- Mark horse as available
    UPDATE profiles SET horse_status = 'available', updated_at = now()
    WHERE id = p_horse_id;
    
    RETURN TRUE;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE horse_sessions ENABLE ROW LEVEL SECURITY;

-- Admin only for horse sessions
CREATE POLICY horse_sessions_admin ON horse_sessions
    FOR ALL USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN profiles.is_horse IS 'Indicates this account is a Hydra bot player';
COMMENT ON COLUMN profiles.horse_profile IS 'Bot behavior profile: fish, reg, nit, lag, maniac';
COMMENT ON COLUMN profiles.horse_status IS 'Current horse status: available, seated, leaving, disabled';
COMMENT ON TABLE horse_sessions IS 'Tracks horse activity at tables for analytics';
COMMENT ON FUNCTION get_available_horses IS 'Retrieves random available horses for table seeding';
COMMENT ON FUNCTION seat_horse IS 'Seats a horse at a table and creates session';
COMMENT ON FUNCTION schedule_horse_leave IS 'Initiates organic recede for a horse';
COMMENT ON FUNCTION remove_horse IS 'Removes horse from table and makes available again';
