-- ═══════════════════════════════════════════════════════════════════════════════
-- 🐴 SHARK CLUB — 100 Horse Fleet Seed (Horses #101-#200)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Inserts 100 horse profiles into the profiles table and registers them
-- as members of the Shark Club (club_id = 25450).
--
-- Profile Distribution:
--   Fish    (40): #101-#140
--   Reg     (30): #141-#170
--   Nit     (15): #171-#185
--   Lag     (10): #186-#195
--   Maniac  (5):  #196-#200
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    shark_club_uuid UUID;
    horse_id UUID;
    horse_num INT;
    horse_username TEXT;
    horse_display TEXT;
    horse_profile TEXT;
    i INT;
BEGIN
    -- Find the Shark Club UUID
    SELECT id INTO shark_club_uuid FROM clubs WHERE club_id = 25450 LIMIT 1;

    IF shark_club_uuid IS NULL THEN
        RAISE EXCEPTION 'Shark Club (club_id=25450) not found!';
    END IF;

    RAISE NOTICE '♠ Found Shark Club: %', shark_club_uuid;

    FOR i IN 101..200 LOOP
        -- Generate deterministic UUID for each horse
        horse_id := ('22222222-2222-2222-2222-' || LPAD(i::TEXT, 12, '0'))::UUID;
        horse_num := 20000 + i;  -- Player numbers 20101-20200
        horse_username := 'Horse_' || i;
        horse_display := 'Horse #' || i;

        -- Assign profile based on distribution
        IF i <= 140 THEN
            horse_profile := 'fish';
        ELSIF i <= 170 THEN
            horse_profile := 'reg';
        ELSIF i <= 185 THEN
            horse_profile := 'nit';
        ELSIF i <= 195 THEN
            horse_profile := 'lag';
        ELSE
            horse_profile := 'maniac';
        END IF;

        -- Insert into auth.users first (required for FK)
        INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, aud, role)
        VALUES (
            horse_id,
            'horse' || i || '@smarter.poker',
            '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
            NOW(),
            NOW(),
            NOW(),
            '00000000-0000-0000-0000-000000000000',
            'authenticated',
            'authenticated'
        )
        ON CONFLICT (id) DO NOTHING;

        -- Insert horse profile
        INSERT INTO profiles (
            id, username, display_name, avatar_url, player_number,
            is_horse, horse_profile, horse_status,
            xp, level, vip_level, streak_days, last_login,
            stats, settings, created_at
        ) VALUES (
            horse_id,
            horse_username,
            horse_display,
            NULL,
            horse_num,
            true,
            horse_profile,
            'available',
            0, 1, 'bronze', 0, NOW(),
            '{}'::jsonb, '{}'::jsonb, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
            is_horse = true,
            horse_profile = EXCLUDED.horse_profile,
            horse_status = 'available';

        -- Add horse as member of Shark Club
        INSERT INTO club_members (
            id, club_id, user_id, role, nickname, chip_balance, status, joined_at
        ) VALUES (
            ('33333333-3333-3333-3333-' || LPAD(i::TEXT, 12, '0'))::UUID,
            shark_club_uuid,
            horse_id,
            'member',
            horse_display,
            100000.00,
            'active',
            NOW()
        )
        ON CONFLICT (id) DO NOTHING;

    END LOOP;

    RAISE NOTICE '✅ Successfully seeded 100 horses (#101-#200) into Shark Club!';
    RAISE NOTICE '   Fish: 40 | Reg: 30 | Nit: 15 | Lag: 10 | Maniac: 5';
END $$;
