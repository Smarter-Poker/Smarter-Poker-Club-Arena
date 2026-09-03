-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — 5-Digit Club Codes Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Changes club_id from 6-digit to 5-digit codes
-- Shark Club gets code 25450 (reserved)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: Generate unique 5-digit club code
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION generate_unique_club_id()
RETURNS INTEGER AS $$
DECLARE
    new_code INTEGER;
    code_exists BOOLEAN;
    max_attempts INTEGER := 100;
    attempt INTEGER := 0;
BEGIN
    LOOP
        -- Generate random 5-digit code between 10000 and 99999
        -- Avoid codes starting with 25450 as that's reserved for Shark Club
        new_code := 10000 + floor(random() * 90000)::int;
        
        -- Check if code already exists
        SELECT EXISTS(SELECT 1 FROM clubs WHERE club_id = new_code) INTO code_exists;
        
        -- Exit if unique code found
        IF NOT code_exists THEN
            RETURN new_code;
        END IF;
        
        attempt := attempt + 1;
        IF attempt >= max_attempts THEN
            RAISE EXCEPTION 'Could not generate unique club code after % attempts', max_attempts;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Update default for clubs table to use 5-digit codes
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE clubs 
ALTER COLUMN club_id 
SET DEFAULT (10000 + floor(random() * 90000)::int);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Migrate existing 6-digit codes to 5-digit codes
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
    club_record RECORD;
    new_code INTEGER;
    shark_club_id UUID;
BEGIN
    -- First, find and set Shark Club to 25450
    SELECT id INTO shark_club_id
    FROM clubs
    WHERE LOWER(name) LIKE '%shark%'
    LIMIT 1;
    
    IF shark_club_id IS NOT NULL THEN
        UPDATE clubs SET club_id = 25450 WHERE id = shark_club_id;
        RAISE NOTICE 'Shark Club assigned code: 25450';
    END IF;
    
    -- Now migrate any remaining 6-digit codes to 5-digit codes
    FOR club_record IN 
        SELECT id, club_id 
        FROM clubs 
        WHERE club_id >= 100000  -- 6-digit codes
        AND id != COALESCE(shark_club_id, '00000000-0000-0000-0000-000000000000')
    LOOP
        -- Generate new unique 5-digit code
        new_code := generate_unique_club_id();
        
        UPDATE clubs SET club_id = new_code WHERE id = club_record.id;
        RAISE NOTICE 'Migrated club % from % to %', club_record.id, club_record.club_id, new_code;
    END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Add trigger to auto-generate unique 5-digit code on insert
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_club_id_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Only generate if club_id is null or 0
    IF NEW.club_id IS NULL OR NEW.club_id = 0 THEN
        NEW.club_id := generate_unique_club_id();
    END IF;
    
    -- Verify uniqueness (will fail on constraint if duplicate)
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS clubs_auto_code ON clubs;

-- Create new trigger
CREATE TRIGGER clubs_auto_code
    BEFORE INSERT ON clubs
    FOR EACH ROW
    EXECUTE FUNCTION set_club_id_on_insert();

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$ 
BEGIN 
    RAISE NOTICE '♠ 5-DIGIT CLUB CODE MIGRATION COMPLETE';
    RAISE NOTICE '♠ Shark Club Code: 25450';
END $$;
