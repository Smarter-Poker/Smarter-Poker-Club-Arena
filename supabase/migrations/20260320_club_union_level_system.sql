-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB & UNION LEVEL SYSTEM — PokerBros-Style (1–50)
-- March 20, 2026
--
-- Club level is determined by MAX(player_level, hierarchy_level, 1)
-- Player level = f(total_players) using 30 * 1.125^(L-1)
-- Hierarchy level = f(hierarchy_units) using 2 * 1.086^(L-1)
-- hierarchy_units = admins*1.0 + super_agents*1.0 + agents*0.25
--
-- Union level aggregates all member clubs and applies same formula.
-- Levels NEVER auto-downgrade (use p_force=TRUE for raw recalc).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. ADD COLUMNS TO CLUBS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS player_level INTEGER DEFAULT 1;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hierarchy_level INTEGER DEFAULT 1;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hierarchy_units DECIMAL(10,2) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hierarchy_units_rounded_up INTEGER DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS admin_count INTEGER DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS super_agent_count INTEGER DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS agent_count INTEGER DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS player_threshold_current INTEGER DEFAULT 30;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS player_threshold_next INTEGER DEFAULT 34;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hierarchy_threshold_current INTEGER DEFAULT 2;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS hierarchy_threshold_next INTEGER DEFAULT 2;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ADD COLUMNS TO UNIONS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE unions ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS player_level INTEGER DEFAULT 1;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS hierarchy_level INTEGER DEFAULT 1;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS total_players INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS total_admins INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS total_super_agents INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS total_agents INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS hierarchy_units DECIMAL(10,2) DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS hierarchy_units_rounded_up INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS player_threshold_current INTEGER DEFAULT 30;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS player_threshold_next INTEGER DEFAULT 34;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS hierarchy_threshold_current INTEGER DEFAULT 2;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS hierarchy_threshold_next INTEGER DEFAULT 2;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CORE FUNCTION: recompute_club_levels
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recompute_club_levels(
    p_club_id UUID DEFAULT NULL,
    p_force BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    rec RECORD;
    v_total_players INTEGER;
    v_admin_count INTEGER;
    v_super_agent_count INTEGER;
    v_agent_count INTEGER;
    v_hierarchy_units DECIMAL(10,2);
    v_hierarchy_units_rounded_up INTEGER;
    v_player_level INTEGER;
    v_hierarchy_level INTEGER;
    v_computed_level INTEGER;
    v_final_level INTEGER;
    v_player_threshold_current INTEGER;
    v_player_threshold_next INTEGER;
    v_hierarchy_threshold_current INTEGER;
    v_hierarchy_threshold_next INTEGER;
    v_level_cursor INTEGER;
    v_threshold INTEGER;
BEGIN
    FOR rec IN
        SELECT id, level AS existing_level
        FROM clubs
        WHERE (p_club_id IS NULL OR id = p_club_id)
    LOOP
        -- ── Count roles from club_members ──
        SELECT
            COUNT(*) FILTER (WHERE status IN ('active', 'approved')),
            COUNT(*) FILTER (WHERE role IN ('admin', 'manager') AND status IN ('active', 'approved')),
            COUNT(*) FILTER (WHERE role = 'super_agent' AND status IN ('active', 'approved')),
            COUNT(*) FILTER (WHERE role IN ('agent', 'sub_agent') AND status IN ('active', 'approved'))
        INTO v_total_players, v_admin_count, v_super_agent_count, v_agent_count
        FROM club_members
        WHERE club_id = rec.id;

        -- ── Hierarchy units ──
        v_hierarchy_units := (v_admin_count * 1.00) + (v_super_agent_count * 1.00) + (v_agent_count * 0.25);
        v_hierarchy_units_rounded_up := CEIL(v_hierarchy_units);

        -- ── Compute player_level (highest L where total_players >= ROUND(30 * 1.125^(L-1))) ──
        v_player_level := 1;
        FOR v_level_cursor IN 1..50 LOOP
            v_threshold := ROUND(30 * POWER(1.125, v_level_cursor - 1));
            IF v_total_players >= v_threshold THEN
                v_player_level := v_level_cursor;
            ELSE
                EXIT;
            END IF;
        END LOOP;

        -- ── Compute hierarchy_level (highest L where hierarchy_units_rounded_up >= ROUND(2 * 1.086^(L-1))) ──
        v_hierarchy_level := 1;
        FOR v_level_cursor IN 1..50 LOOP
            v_threshold := ROUND(2 * POWER(1.086, v_level_cursor - 1));
            IF v_hierarchy_units_rounded_up >= v_threshold THEN
                v_hierarchy_level := v_level_cursor;
            ELSE
                EXIT;
            END IF;
        END LOOP;

        -- ── Final level ──
        v_computed_level := GREATEST(v_player_level, v_hierarchy_level, 1);

        -- No-downgrade guard (unless p_force = TRUE)
        IF p_force THEN
            v_final_level := v_computed_level;
        ELSE
            v_final_level := GREATEST(COALESCE(rec.existing_level, 1), v_computed_level);
        END IF;

        -- ── Thresholds for progress bar ──
        v_player_threshold_current := ROUND(30 * POWER(1.125, v_player_level - 1));
        v_player_threshold_next := ROUND(30 * POWER(1.125, LEAST(v_player_level, 49)));
        v_hierarchy_threshold_current := ROUND(2 * POWER(1.086, v_hierarchy_level - 1));
        v_hierarchy_threshold_next := ROUND(2 * POWER(1.086, LEAST(v_hierarchy_level, 49)));

        -- ── Write to clubs table ──
        UPDATE clubs SET
            level = v_final_level,
            player_level = v_player_level,
            hierarchy_level = v_hierarchy_level,
            hierarchy_units = v_hierarchy_units,
            hierarchy_units_rounded_up = v_hierarchy_units_rounded_up,
            admin_count = v_admin_count,
            super_agent_count = v_super_agent_count,
            agent_count = v_agent_count,
            member_count = v_total_players,
            player_threshold_current = v_player_threshold_current,
            player_threshold_next = v_player_threshold_next,
            hierarchy_threshold_current = v_hierarchy_threshold_current,
            hierarchy_threshold_next = v_hierarchy_threshold_next,
            updated_at = NOW()
        WHERE id = rec.id;
    END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. CORE FUNCTION: recompute_union_levels
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recompute_union_levels(
    p_union_id UUID DEFAULT NULL,
    p_force BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    rec RECORD;
    v_total_players INTEGER;
    v_total_admins INTEGER;
    v_total_super_agents INTEGER;
    v_total_agents INTEGER;
    v_club_count INTEGER;
    v_hierarchy_units DECIMAL(10,2);
    v_hierarchy_units_rounded_up INTEGER;
    v_player_level INTEGER;
    v_hierarchy_level INTEGER;
    v_computed_level INTEGER;
    v_final_level INTEGER;
    v_player_threshold_current INTEGER;
    v_player_threshold_next INTEGER;
    v_hierarchy_threshold_current INTEGER;
    v_hierarchy_threshold_next INTEGER;
    v_level_cursor INTEGER;
    v_threshold INTEGER;
BEGIN
    FOR rec IN
        SELECT id, COALESCE(level, 1) AS existing_level
        FROM unions
        WHERE (p_union_id IS NULL OR id = p_union_id)
    LOOP
        -- ── Aggregate from all member clubs (using denormalized club columns) ──
        SELECT
            COUNT(*),
            COALESCE(SUM(c.member_count), 0),
            COALESCE(SUM(c.admin_count), 0),
            COALESCE(SUM(c.super_agent_count), 0),
            COALESCE(SUM(c.agent_count), 0)
        INTO v_club_count, v_total_players, v_total_admins, v_total_super_agents, v_total_agents
        FROM union_clubs uc
        JOIN clubs c ON c.id = uc.club_id
        WHERE uc.union_id = rec.id;

        -- ── Hierarchy units (union-wide) ──
        v_hierarchy_units := (v_total_admins * 1.00) + (v_total_super_agents * 1.00) + (v_total_agents * 0.25);
        v_hierarchy_units_rounded_up := CEIL(v_hierarchy_units);

        -- ── Compute player_level ──
        v_player_level := 1;
        FOR v_level_cursor IN 1..50 LOOP
            v_threshold := ROUND(30 * POWER(1.125, v_level_cursor - 1));
            IF v_total_players >= v_threshold THEN
                v_player_level := v_level_cursor;
            ELSE
                EXIT;
            END IF;
        END LOOP;

        -- ── Compute hierarchy_level ──
        v_hierarchy_level := 1;
        FOR v_level_cursor IN 1..50 LOOP
            v_threshold := ROUND(2 * POWER(1.086, v_level_cursor - 1));
            IF v_hierarchy_units_rounded_up >= v_threshold THEN
                v_hierarchy_level := v_level_cursor;
            ELSE
                EXIT;
            END IF;
        END LOOP;

        -- ── Final level ──
        v_computed_level := GREATEST(v_player_level, v_hierarchy_level, 1);

        IF p_force THEN
            v_final_level := v_computed_level;
        ELSE
            v_final_level := GREATEST(rec.existing_level, v_computed_level);
        END IF;

        -- ── Thresholds ──
        v_player_threshold_current := ROUND(30 * POWER(1.125, v_player_level - 1));
        v_player_threshold_next := ROUND(30 * POWER(1.125, LEAST(v_player_level, 49)));
        v_hierarchy_threshold_current := ROUND(2 * POWER(1.086, v_hierarchy_level - 1));
        v_hierarchy_threshold_next := ROUND(2 * POWER(1.086, LEAST(v_hierarchy_level, 49)));

        -- ── Write to unions table ──
        UPDATE unions SET
            level = v_final_level,
            player_level = v_player_level,
            hierarchy_level = v_hierarchy_level,
            total_players = v_total_players,
            total_admins = v_total_admins,
            total_super_agents = v_total_super_agents,
            total_agents = v_total_agents,
            hierarchy_units = v_hierarchy_units,
            hierarchy_units_rounded_up = v_hierarchy_units_rounded_up,
            club_count = v_club_count,
            member_count = v_total_players,
            player_threshold_current = v_player_threshold_current,
            player_threshold_next = v_player_threshold_next,
            hierarchy_threshold_current = v_hierarchy_threshold_current,
            hierarchy_threshold_next = v_hierarchy_threshold_next,
            updated_at = NOW()
        WHERE id = rec.id;
    END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TRIGGER: Auto-recompute club level on club_members changes
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_recompute_club_level_on_member_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_club_id UUID;
    v_union_id UUID;
BEGIN
    -- Determine which club was affected
    IF TG_OP = 'DELETE' THEN
        v_club_id := OLD.club_id;
    ELSE
        v_club_id := NEW.club_id;
    END IF;

    -- Recompute club level
    PERFORM recompute_club_levels(v_club_id);

    -- If this club is in a union, also recompute the union level
    SELECT uc.union_id INTO v_union_id
    FROM union_clubs uc
    WHERE uc.club_id = v_club_id
    LIMIT 1;

    IF v_union_id IS NOT NULL THEN
        PERFORM recompute_union_levels(v_union_id);
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- Drop old triggers that are being replaced
DROP TRIGGER IF EXISTS trg_recompute_level_on_rake ON rake_records;
DROP TRIGGER IF EXISTS trg_sync_club_member_count ON club_members;
DROP TRIGGER IF EXISTS trg_recompute_club_level_on_member_change ON club_members;

-- Create new trigger for member changes (INSERT, DELETE, or role/status change)
CREATE TRIGGER trg_recompute_club_level_on_member_change
    AFTER INSERT OR DELETE OR UPDATE OF role, status ON club_members
    FOR EACH ROW
    EXECUTE FUNCTION fn_recompute_club_level_on_member_change();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. TRIGGER: Auto-recompute union level when clubs join/leave union
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_recompute_union_level_on_club_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recompute_union_levels(OLD.union_id);
        RETURN OLD;
    ELSE
        PERFORM recompute_union_levels(NEW.union_id);
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_union_level_on_club_change ON union_clubs;

CREATE TRIGGER trg_recompute_union_level_on_club_change
    AFTER INSERT OR DELETE ON union_clubs
    FOR EACH ROW
    EXECUTE FUNCTION fn_recompute_union_level_on_club_change();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. GRANT EXECUTE
-- ═══════════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION recompute_club_levels TO authenticated, anon;
GRANT EXECUTE ON FUNCTION recompute_union_levels TO authenticated, anon;
GRANT EXECUTE ON FUNCTION fn_recompute_club_level_on_member_change TO authenticated, anon;
GRANT EXECUTE ON FUNCTION fn_recompute_union_level_on_club_change TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. INITIAL BACKFILL — Recompute all clubs then all unions
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT recompute_club_levels(p_force := TRUE);
SELECT recompute_union_levels(p_force := TRUE);
