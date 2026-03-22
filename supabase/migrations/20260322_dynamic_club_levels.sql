-- ═══════════════════════════════════════════════════════════════════════════════
-- DYNAMIC CLUB & UNION LEVELS — Remove No-Downgrade Guard
-- March 22, 2026
--
-- Previously, levels never went down (GREATEST(existing_level, computed_level)).
-- This migration makes levels fully dynamic: they go UP and DOWN in real time
-- based on current player count and hierarchy.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. REDEFINE recompute_club_levels — Remove no-downgrade guard
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recompute_club_levels(
    p_club_id UUID DEFAULT NULL,
    p_force BOOLEAN DEFAULT FALSE  -- kept for API compat, now a no-op
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
    v_player_threshold_current INTEGER;
    v_player_threshold_next INTEGER;
    v_hierarchy_threshold_current INTEGER;
    v_hierarchy_threshold_next INTEGER;
    v_level_cursor INTEGER;
    v_threshold INTEGER;
BEGIN
    FOR rec IN
        SELECT id
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

        -- ── Final level — fully dynamic, always reflects current state ──
        v_computed_level := GREATEST(v_player_level, v_hierarchy_level, 1);

        -- ── Thresholds for progress bar ──
        v_player_threshold_current := ROUND(30 * POWER(1.125, v_player_level - 1));
        v_player_threshold_next := ROUND(30 * POWER(1.125, LEAST(v_player_level, 49)));
        v_hierarchy_threshold_current := ROUND(2 * POWER(1.086, v_hierarchy_level - 1));
        v_hierarchy_threshold_next := ROUND(2 * POWER(1.086, LEAST(v_hierarchy_level, 49)));

        -- ── Write to clubs table ──
        UPDATE clubs SET
            level = v_computed_level,
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
-- 2. REDEFINE recompute_union_levels — Remove no-downgrade guard
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recompute_union_levels(
    p_union_id UUID DEFAULT NULL,
    p_force BOOLEAN DEFAULT FALSE  -- kept for API compat, now a no-op
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
    v_player_threshold_current INTEGER;
    v_player_threshold_next INTEGER;
    v_hierarchy_threshold_current INTEGER;
    v_hierarchy_threshold_next INTEGER;
    v_level_cursor INTEGER;
    v_threshold INTEGER;
BEGIN
    FOR rec IN
        SELECT id
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

        -- ── Final level — fully dynamic, always reflects current state ──
        v_computed_level := GREATEST(v_player_level, v_hierarchy_level, 1);

        -- ── Thresholds ──
        v_player_threshold_current := ROUND(30 * POWER(1.125, v_player_level - 1));
        v_player_threshold_next := ROUND(30 * POWER(1.125, LEAST(v_player_level, 49)));
        v_hierarchy_threshold_current := ROUND(2 * POWER(1.086, v_hierarchy_level - 1));
        v_hierarchy_threshold_next := ROUND(2 * POWER(1.086, LEAST(v_hierarchy_level, 49)));

        -- ── Write to unions table ──
        UPDATE unions SET
            level = v_computed_level,
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
-- 3. BACKFILL — Recompute all clubs and unions to sync to current true levels
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT recompute_club_levels();
SELECT recompute_union_levels();
