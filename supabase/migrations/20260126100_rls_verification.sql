-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔒 RLS POLICY VERIFICATION & ENHANCEMENT — Phase 4
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Verifies and enhances RLS policies across all Club Arena tables
-- Ensures proper access control through the hierarchy:
-- Union → Club → Super Agent → Agent → Player
--
-- Created: 2026-01-24
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. HELPER FUNCTIONS FOR HIERARCHY CHECKS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Check if user is member of a club
CREATE OR REPLACE FUNCTION is_club_member(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM club_members 
        WHERE club_id = p_club_id 
        AND user_id = p_user_id 
        AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Check if user is club owner or admin
CREATE OR REPLACE FUNCTION is_club_admin(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM clubs WHERE id = p_club_id AND owner_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM club_members 
        WHERE club_id = p_club_id 
        AND user_id = p_user_id 
        AND role IN ('owner', 'admin')
        AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Check if user is union member
CREATE OR REPLACE FUNCTION is_union_member(p_union_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM union_members 
        WHERE union_id = p_union_id 
        AND user_id = p_user_id 
        AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Check if user is union admin
CREATE OR REPLACE FUNCTION is_union_admin(p_union_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM unions WHERE id = p_union_id AND owner_id = p_user_id
    ) OR EXISTS (
        SELECT 1 FROM union_members 
        WHERE union_id = p_union_id 
        AND user_id = p_user_id 
        AND role IN ('owner', 'admin')
        AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Check if user is an agent in a club
CREATE OR REPLACE FUNCTION is_club_agent(p_club_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM agents 
        WHERE club_id = p_club_id 
        AND user_id = p_user_id 
        AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Check if user is agent or above in hierarchy (for player data access)
CREATE OR REPLACE FUNCTION can_view_player(p_player_id UUID, p_viewer_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Can always view self
    IF p_player_id = p_viewer_id THEN
        RETURN TRUE;
    END IF;
    
    -- Check if viewer is agent who referred this player
    IF EXISTS (
        SELECT 1 FROM profiles 
        WHERE id = p_player_id 
        AND referred_by_agent IN (
            SELECT id FROM agents WHERE user_id = p_viewer_id AND status = 'active'
        )
    ) THEN
        RETURN TRUE;
    END IF;
    
    -- Check if viewer is club admin where player is member
    IF EXISTS (
        SELECT 1 FROM club_members cm
        WHERE cm.user_id = p_player_id
        AND is_club_admin(cm.club_id, p_viewer_id)
    ) THEN
        RETURN TRUE;
    END IF;
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLUB TABLE POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop existing policies to recreate
DROP POLICY IF EXISTS clubs_select ON clubs;
DROP POLICY IF EXISTS clubs_insert ON clubs;
DROP POLICY IF EXISTS clubs_update ON clubs;
DROP POLICY IF EXISTS clubs_delete ON clubs;

-- Anyone can view public clubs or clubs they belong to
CREATE POLICY clubs_select ON clubs
    FOR SELECT USING (
        is_public = true 
        OR owner_id = auth.uid()
        OR is_club_member(id, auth.uid())
    );

-- Authenticated users can create clubs
CREATE POLICY clubs_insert ON clubs
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Only owner can update club
CREATE POLICY clubs_update ON clubs
    FOR UPDATE USING (owner_id = auth.uid());

-- Only owner can delete club
CREATE POLICY clubs_delete ON clubs
    FOR DELETE USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CLUB MEMBERS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS club_members_select ON club_members;
DROP POLICY IF EXISTS club_members_insert ON club_members;
DROP POLICY IF EXISTS club_members_update ON club_members;
DROP POLICY IF EXISTS club_members_delete ON club_members;

-- Members can see other members in their clubs
CREATE POLICY club_members_select ON club_members
    FOR SELECT USING (
        user_id = auth.uid()
        OR is_club_member(club_id, auth.uid())
    );

-- Admins can add members, users can request to join
CREATE POLICY club_members_insert ON club_members
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        OR is_club_admin(club_id, auth.uid())
    );

-- Admins can update members, users can update their own record
CREATE POLICY club_members_update ON club_members
    FOR UPDATE USING (
        user_id = auth.uid()
        OR is_club_admin(club_id, auth.uid())
    );

-- Admins can remove members, users can leave
CREATE POLICY club_members_delete ON club_members
    FOR DELETE USING (
        user_id = auth.uid()
        OR is_club_admin(club_id, auth.uid())
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. AGENTS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS agents_select ON agents;
DROP POLICY IF EXISTS agents_insert ON agents;
DROP POLICY IF EXISTS agents_update ON agents;
DROP POLICY IF EXISTS agents_delete ON agents;

-- Agents visible to club members
CREATE POLICY agents_select ON agents
    FOR SELECT USING (
        user_id = auth.uid()
        OR is_club_member(club_id, auth.uid())
    );

-- Club admins can create agents
CREATE POLICY agents_insert ON agents
    FOR INSERT WITH CHECK (
        is_club_admin(club_id, auth.uid())
    );

-- Club admins or agent themselves can update
CREATE POLICY agents_update ON agents
    FOR UPDATE USING (
        user_id = auth.uid()
        OR is_club_admin(club_id, auth.uid())
    );

-- Only club admins can delete agents
CREATE POLICY agents_delete ON agents
    FOR DELETE USING (
        is_club_admin(club_id, auth.uid())
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TABLES POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS tables_select ON tables;
DROP POLICY IF EXISTS tables_insert ON tables;
DROP POLICY IF EXISTS tables_update ON tables;
DROP POLICY IF EXISTS tables_delete ON tables;

-- Tables visible to club members
CREATE POLICY tables_select ON tables
    FOR SELECT USING (
        is_club_member(club_id, auth.uid())
        OR club_id IS NULL  -- Public tables
    );

-- Club admins can create tables
CREATE POLICY tables_insert ON tables
    FOR INSERT WITH CHECK (
        is_club_admin(club_id, auth.uid())
        OR club_id IS NULL
    );

-- Club admins can update tables
CREATE POLICY tables_update ON tables
    FOR UPDATE USING (
        is_club_admin(club_id, auth.uid())
    );

-- Club admins can delete tables
CREATE POLICY tables_delete ON tables
    FOR DELETE USING (
        is_club_admin(club_id, auth.uid())
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. UNION POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS unions_select ON unions;
DROP POLICY IF EXISTS unions_insert ON unions;
DROP POLICY IF EXISTS unions_update ON unions;
DROP POLICY IF EXISTS unions_delete ON unions;

-- Unions are visible to authenticated users (owner or members have full access)
-- Note: unions table doesn't have is_private column in base schema
CREATE POLICY unions_select ON unions
    FOR SELECT USING (
        owner_id = auth.uid()
        OR is_union_member(id, auth.uid())
        OR auth.uid() IS NOT NULL  -- All authenticated users can discover unions
    );

-- Authenticated users can create unions
CREATE POLICY unions_insert ON unions
    FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Only owner can update union
CREATE POLICY unions_update ON unions
    FOR UPDATE USING (owner_id = auth.uid());

-- Only owner can delete union
CREATE POLICY unions_delete ON unions
    FOR DELETE USING (owner_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. FINANCIAL DATA POLICIES (Sensitive - strict access)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Commission History
DROP POLICY IF EXISTS commission_history_select ON commission_history;
CREATE POLICY commission_history_select ON commission_history
    FOR SELECT USING (
        agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
        OR is_club_admin(club_id, auth.uid())
    );

-- Settlement Periods
DROP POLICY IF EXISTS settlement_periods_select_new ON settlement_periods;
DROP POLICY IF EXISTS settlement_periods_admin ON settlement_periods;

CREATE POLICY settlement_periods_select_new ON settlement_periods
    FOR SELECT USING (
        is_club_member(club_id, auth.uid())
    );

CREATE POLICY settlement_periods_admin ON settlement_periods
    FOR ALL USING (
        is_club_admin(club_id, auth.uid())
    );

-- Wallet Transactions (users see their own)
DROP POLICY IF EXISTS wallet_transactions_self ON wallet_transactions;
CREATE POLICY wallet_transactions_self ON wallet_transactions
    FOR SELECT USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. TOURNAMENT POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS tournaments_select ON tournaments;
DROP POLICY IF EXISTS tournament_registrations_select ON tournament_registrations;

-- Tournaments visible to club members
CREATE POLICY tournaments_select ON tournaments
    FOR SELECT USING (
        is_club_member(club_id, auth.uid())
        OR club_id IS NULL
    );

-- Registration visible to self or club admins
CREATE POLICY tournament_registrations_select ON tournament_registrations
    FOR SELECT USING (
        user_id = auth.uid()
        OR is_club_admin(
            (SELECT club_id FROM tournaments WHERE id = tournament_id),
            auth.uid()
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. ADD XP FUNCTION (referenced by achievements)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION add_xp(p_user_id UUID, p_amount INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE profiles SET
        xp = COALESCE(xp, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — RLS policies verified and enhanced
-- ═══════════════════════════════════════════════════════════════════════════════
