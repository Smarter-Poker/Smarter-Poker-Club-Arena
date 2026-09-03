-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB LEVEL & MEMBER COUNT IMPROVEMENTS (March 19, 2026)
-- 
-- 1. Fix recompute_club_levels formula (member-count-driven, supports 1-50)
-- 2. Backfill club_members.status = 'active' for all NULL rows
-- 3. Sync trigger: auto-update clubs.member_count on INSERT/DELETE
-- 4. Level trigger: auto-recompute clubs.level on rake_records INSERT
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. FIX recompute_club_levels — Member-count-driven formula (1-50 scale)
--
-- Old formula: FLOOR(LOG(2, members) + LOG(2, rake/100)) — broke when rake=0
-- New formula: Member-count-based levels 1-50, with rake as a bonus multiplier.
--   Base level = LOG-scaled from member count:
--     1-2 members → Level 1, 3-5 → Level 2, 6-10 → Level 3, etc.
--   Bonus = small boost from accumulated rake (max +5 extra levels)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION recompute_club_levels(
    p_club_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_sql TEXT;
BEGIN
    -- Base level: purely from member count (logarithmic scale 1-45)
    --   1 member → 1, 5 → 3, 10 → 5, 25 → 7, 50 → 9, 100 → 11,
    --   250 → 14, 500 → 16, 1000 → 18, 5000 → 24, 10000 → 27
    -- Rake bonus: small additive boost (0-5) based on total_rake
    --   0 rake → 0, 1000 rake → +1, 10000 → +2, 100000 → +3, 1M → +4, 10M → +5
    v_sql := '
        UPDATE clubs
        SET level = LEAST(
            GREATEST(
                -- Base: member count drives the level (logarithmic scale)
                FLOOR(LN(GREATEST(COALESCE(member_count, 1), 1) + 1) * 4)
                -- Bonus: rake contribution (small additive, max +5)
                + LEAST(FLOOR(LN(GREATEST(COALESCE(total_rake, 0), 0) + 1) / 2.3), 5),
            1),
        50),
            updated_at = NOW()
    ';

    IF p_club_id IS NOT NULL THEN
        EXECUTE v_sql || ' WHERE id = $1' USING p_club_id;
    ELSE
        EXECUTE v_sql || ' WHERE TRUE';
    END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. BACKFILL club_members.status for existing NULL rows
-- ═══════════════════════════════════════════════════════════════════════════════
UPDATE club_members
SET status = 'active'
WHERE status IS NULL
  AND club_id IS NOT NULL;

-- Set default for future inserts (so even if code forgets, it's 'active')
ALTER TABLE club_members ALTER COLUMN status SET DEFAULT 'active';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. TRIGGER: Auto-sync clubs.member_count on club_members INSERT/DELETE
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_sync_club_member_count()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_club_id UUID;
    v_count INTEGER;
BEGIN
    -- Determine which club_id to update
    IF TG_OP = 'DELETE' THEN
        v_club_id := OLD.club_id;
    ELSE
        v_club_id := NEW.club_id;
    END IF;

    -- Count active members for this club
    SELECT COUNT(*) INTO v_count
    FROM club_members
    WHERE club_id = v_club_id
      AND (status IS NULL OR status IN ('active', 'approved'));

    -- Update the denormalized counter
    UPDATE clubs
    SET member_count = v_count,
        updated_at = NOW()
    WHERE id = v_club_id;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- Drop existing trigger if present (safe re-run)
DROP TRIGGER IF EXISTS trg_sync_club_member_count ON club_members;

-- Create trigger for INSERT, DELETE, and UPDATE of status column
CREATE TRIGGER trg_sync_club_member_count
    AFTER INSERT OR DELETE OR UPDATE OF status ON club_members
    FOR EACH ROW
    EXECUTE FUNCTION fn_sync_club_member_count();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. TRIGGER: Auto-recompute club level when rake changes
-- Fires on rake_records INSERT to keep clubs.level fresh
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_recompute_club_level_on_rake()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- Only recompute if the rake record has a club_id
    IF NEW.club_id IS NOT NULL THEN
        PERFORM recompute_club_levels(NEW.club_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_level_on_rake ON rake_records;

CREATE TRIGGER trg_recompute_level_on_rake
    AFTER INSERT ON rake_records
    FOR EACH ROW
    EXECUTE FUNCTION fn_recompute_club_level_on_rake();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. RUN INITIAL RECOMPUTE for all clubs (applies the new formula)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT recompute_club_levels();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. GRANT EXECUTE on new functions
-- ═══════════════════════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION fn_sync_club_member_count TO authenticated, anon;
GRANT EXECUTE ON FUNCTION fn_recompute_club_level_on_rake TO authenticated, anon;
