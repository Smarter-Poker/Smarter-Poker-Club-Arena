-- ═══════════════════════════════════════════════════════════════════════════════
-- 🏆 TOURNAMENT EXPANSION — Prize Pool & Rebuy System
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Club Arena Tournament Expansion
-- Extended tournament functionality for MTTs and advanced features
--
-- Features:
-- - Prize pool tracking and distribution
-- - Rebuy/Add-on tracking
-- - Table balancing for multi-table tournaments
-- - Player elimination history
-- - Late registration management
--
-- Created: 2026-01-13
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT PRIZE POOLS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_prize_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    
    -- Pool composition
    total_entries INTEGER NOT NULL DEFAULT 0,
    total_rebuys INTEGER DEFAULT 0,
    total_addons INTEGER DEFAULT 0,
    
    -- Amounts
    entry_pool DECIMAL(18, 4) NOT NULL DEFAULT 0,
    rebuy_pool DECIMAL(18, 4) DEFAULT 0,
    addon_pool DECIMAL(18, 4) DEFAULT 0,
    total_pool DECIMAL(18, 4) NOT NULL DEFAULT 0,
    
    -- Rake/Fee
    total_rake DECIMAL(18, 4) DEFAULT 0,
    rake_percentage DECIMAL(5, 4) DEFAULT 0.10,
    
    -- Overlay (if guaranteed)
    guaranteed_amount DECIMAL(18, 4) DEFAULT 0,
    overlay_amount DECIMAL(18, 4) DEFAULT 0, -- Guaranteed - Pool (if negative = overlay)
    
    -- Status
    frozen_at TIMESTAMP WITH TIME ZONE, -- When pool was finalized
    distributed_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(tournament_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT PAYOUTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id),
    
    -- Placement
    finish_position INTEGER NOT NULL,
    total_entries INTEGER NOT NULL, -- Total players for percentage calc
    
    -- Payout calculation
    payout_percentage DECIMAL(6, 4) NOT NULL,
    payout_amount DECIMAL(18, 4) NOT NULL,
    
    -- Execution
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
    paid_at TIMESTAMP WITH TIME ZONE,
    wallet_transaction_id UUID,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(tournament_id, finish_position)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- REBUY/ADDON TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_rebuys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id),
    
    -- Type
    type TEXT NOT NULL CHECK (type IN ('rebuy', 'addon')),
    
    -- Details
    cost DECIMAL(18, 4) NOT NULL,
    chips_received INTEGER NOT NULL,
    blind_level INTEGER NOT NULL, -- Level at which rebuy occurred
    
    -- Payment
    paid_from_wallet TEXT DEFAULT 'PLAYER',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT TABLES (Multi-Table Tournament Support)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    table_number INTEGER NOT NULL,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'breaking', 'broken')),
    is_final_table BOOLEAN DEFAULT FALSE,
    
    -- Player count
    current_players INTEGER DEFAULT 0,
    max_players INTEGER DEFAULT 9,
    
    -- Balancing
    needs_balancing BOOLEAN DEFAULT FALSE,
    last_balanced_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(tournament_id, table_number)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT TABLE ASSIGNMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_table_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    tournament_table_id UUID NOT NULL REFERENCES tournament_tables(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id),
    
    -- Seat
    seat_number INTEGER NOT NULL CHECK (seat_number >= 1 AND seat_number <= 10),
    
    -- Stack
    current_stack INTEGER NOT NULL,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    eliminated_at TIMESTAMP WITH TIME ZONE,
    moved_from_table_id UUID REFERENCES tournament_tables(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    UNIQUE(tournament_table_id, seat_number),
    UNIQUE(tournament_id, player_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT ELIMINATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_eliminations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    eliminated_player_id UUID NOT NULL REFERENCES profiles(id),
    eliminating_player_id UUID REFERENCES profiles(id), -- NULL if blinded out
    
    -- Details
    finish_position INTEGER NOT NULL,
    blind_level INTEGER NOT NULL,
    hand_id UUID, -- Reference to the hand if applicable
    
    -- Elimination type
    elimination_type TEXT NOT NULL DEFAULT 'knockout' 
        CHECK (elimination_type IN ('knockout', 'blinded_out', 'disconnection')),
    
    -- Stack info at elimination
    final_stack INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- LATE REGISTRATION TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tournament_late_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES profiles(id),
    
    -- Registration details
    registered_at_level INTEGER NOT NULL,
    starting_stack INTEGER NOT NULL,
    
    -- Adjusted stack (if late reg penalty applies)
    adjusted_stack INTEGER,
    adjustment_reason TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_prize_pools_tournament ON tournament_prize_pools(tournament_id);
CREATE INDEX IF NOT EXISTS idx_payouts_tournament ON tournament_payouts(tournament_id);
CREATE INDEX IF NOT EXISTS idx_payouts_player ON tournament_payouts(player_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON tournament_payouts(status);

CREATE INDEX IF NOT EXISTS idx_rebuys_tournament ON tournament_rebuys(tournament_id);
CREATE INDEX IF NOT EXISTS idx_rebuys_player ON tournament_rebuys(player_id);

CREATE INDEX IF NOT EXISTS idx_tourn_tables_tournament ON tournament_tables(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tourn_tables_status ON tournament_tables(status);

CREATE INDEX IF NOT EXISTS idx_table_assignments_table ON tournament_table_assignments(tournament_table_id);
CREATE INDEX IF NOT EXISTS idx_table_assignments_player ON tournament_table_assignments(player_id);

CREATE INDEX IF NOT EXISTS idx_eliminations_tournament ON tournament_eliminations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_eliminations_player ON tournament_eliminations(eliminated_player_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE tournament_prize_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_rebuys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_table_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_eliminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_late_registrations ENABLE ROW LEVEL SECURITY;

-- Prize pools: Visible to all (read), managed by admins/club owners
CREATE POLICY prize_pools_read ON tournament_prize_pools
    FOR SELECT USING (true);

CREATE POLICY prize_pools_manage ON tournament_prize_pools
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM tournaments t
            JOIN clubs c ON t.club_id = c.id
            WHERE t.id = tournament_prize_pools.tournament_id
            AND c.owner_id = auth.uid()
        )
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- Payouts: Player can see their own, admins see all
CREATE POLICY payouts_self ON tournament_payouts
    FOR SELECT USING (
        player_id = auth.uid()
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- Rebuys: Same as payouts
CREATE POLICY rebuys_self ON tournament_rebuys
    FOR SELECT USING (
        player_id = auth.uid()
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- Tournament tables: Public read
CREATE POLICY tourn_tables_read ON tournament_tables
    FOR SELECT USING (true);

-- Table assignments: Public read (for lobby display)
CREATE POLICY table_assignments_read ON tournament_table_assignments
    FOR SELECT USING (true);

-- Eliminations: Public read
CREATE POLICY eliminations_read ON tournament_eliminations
    FOR SELECT USING (true);

-- Late registrations: Self + admin
CREATE POLICY late_reg_self ON tournament_late_registrations
    FOR SELECT USING (
        player_id = auth.uid()
        OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Calculate prize pool totals
CREATE OR REPLACE FUNCTION update_prize_pool_totals(p_tournament_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_entry_pool DECIMAL;
    v_rebuy_pool DECIMAL;
    v_addon_pool DECIMAL;
    v_total_entries INTEGER;
    v_total_rebuys INTEGER;
    v_total_addons INTEGER;
BEGIN
    -- Get tournament buy-in info
    SELECT 
        COUNT(*) as entries,
        COALESCE(SUM(t.buy_in), 0) as entry_pool
    INTO v_total_entries, v_entry_pool
    FROM tournament_players tp
    JOIN tournaments t ON tp.tournament_id = t.id
    WHERE tp.tournament_id = p_tournament_id;
    
    -- Get rebuy totals
    SELECT 
        COUNT(*) FILTER (WHERE type = 'rebuy'),
        COUNT(*) FILTER (WHERE type = 'addon'),
        COALESCE(SUM(cost) FILTER (WHERE type = 'rebuy'), 0),
        COALESCE(SUM(cost) FILTER (WHERE type = 'addon'), 0)
    INTO v_total_rebuys, v_total_addons, v_rebuy_pool, v_addon_pool
    FROM tournament_rebuys
    WHERE tournament_id = p_tournament_id;
    
    -- Upsert prize pool
    INSERT INTO tournament_prize_pools (
        tournament_id, total_entries, total_rebuys, total_addons,
        entry_pool, rebuy_pool, addon_pool, total_pool
    )
    VALUES (
        p_tournament_id, v_total_entries, v_total_rebuys, v_total_addons,
        v_entry_pool, v_rebuy_pool, v_addon_pool,
        v_entry_pool + v_rebuy_pool + v_addon_pool
    )
    ON CONFLICT (tournament_id) DO UPDATE SET
        total_entries = v_total_entries,
        total_rebuys = v_total_rebuys,
        total_addons = v_total_addons,
        entry_pool = v_entry_pool,
        rebuy_pool = v_rebuy_pool,
        addon_pool = v_addon_pool,
        total_pool = v_entry_pool + v_rebuy_pool + v_addon_pool,
        updated_at = now();
END;
$$;

-- Process rebuy
CREATE OR REPLACE FUNCTION process_tournament_rebuy(
    p_tournament_id UUID,
    p_player_id UUID,
    p_rebuy_type TEXT, -- 'rebuy' or 'addon'
    p_cost DECIMAL,
    p_chips INTEGER,
    p_current_level INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rebuy_id UUID;
BEGIN
    -- Insert rebuy record
    INSERT INTO tournament_rebuys (
        tournament_id, player_id, type, cost, chips_received, blind_level
    )
    VALUES (
        p_tournament_id, p_player_id, p_rebuy_type, p_cost, p_chips, p_current_level
    )
    RETURNING id INTO v_rebuy_id;
    
    -- Update player stack in assignment
    UPDATE tournament_table_assignments
    SET current_stack = current_stack + p_chips, updated_at = now()
    WHERE tournament_id = p_tournament_id AND player_id = p_player_id;
    
    -- Update prize pool
    PERFORM update_prize_pool_totals(p_tournament_id);
    
    RETURN v_rebuy_id;
END;
$$;

-- Eliminate player
CREATE OR REPLACE FUNCTION eliminate_tournament_player(
    p_tournament_id UUID,
    p_eliminated_player_id UUID,
    p_eliminating_player_id UUID,
    p_blind_level INTEGER,
    p_elimination_type TEXT DEFAULT 'knockout'
)
RETURNS INTEGER -- Returns finish position
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_remaining_players INTEGER;
    v_finish_position INTEGER;
BEGIN
    -- Count remaining active players
    SELECT COUNT(*) INTO v_remaining_players
    FROM tournament_table_assignments
    WHERE tournament_id = p_tournament_id AND is_active = TRUE;
    
    -- Finish position is remaining + 1
    v_finish_position := v_remaining_players;
    
    -- Mark player as eliminated
    UPDATE tournament_table_assignments
    SET is_active = FALSE, eliminated_at = now(), current_stack = 0, updated_at = now()
    WHERE tournament_id = p_tournament_id AND player_id = p_eliminated_player_id;
    
    -- Record elimination
    INSERT INTO tournament_eliminations (
        tournament_id, eliminated_player_id, eliminating_player_id,
        finish_position, blind_level, elimination_type
    )
    VALUES (
        p_tournament_id, p_eliminated_player_id, p_eliminating_player_id,
        v_finish_position, p_blind_level, p_elimination_type
    );
    
    -- Update tournament player record
    UPDATE tournament_players
    SET status = 'eliminated', eliminated_at = now(), finish_position = v_finish_position
    WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_player_id;
    
    RETURN v_finish_position;
END;
$$;

-- Balance tournament tables
CREATE OR REPLACE FUNCTION balance_tournament_tables(p_tournament_id UUID)
RETURNS INTEGER -- Returns number of moves made
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_total_players INTEGER;
    v_num_tables INTEGER;
    v_target_per_table INTEGER;
    v_moves_made INTEGER := 0;
    v_table_rec RECORD;
    v_player_rec RECORD;
    v_target_table_id UUID;
BEGIN
    -- Get active player count
    SELECT COUNT(*) INTO v_total_players
    FROM tournament_table_assignments
    WHERE tournament_id = p_tournament_id AND is_active = TRUE;
    
    -- Get number of active tables
    SELECT COUNT(*) INTO v_num_tables
    FROM tournament_tables
    WHERE tournament_id = p_tournament_id AND status = 'active';
    
    IF v_num_tables = 0 THEN RETURN 0; END IF;
    
    -- Calculate target players per table
    v_target_per_table := CEIL(v_total_players::DECIMAL / v_num_tables);
    
    -- Find tables that have too many players and move excess
    FOR v_table_rec IN
        SELECT tt.id, tt.table_number, COUNT(tta.id) as player_count
        FROM tournament_tables tt
        LEFT JOIN tournament_table_assignments tta ON tta.tournament_table_id = tt.id AND tta.is_active = TRUE
        WHERE tt.tournament_id = p_tournament_id AND tt.status = 'active'
        GROUP BY tt.id, tt.table_number
        HAVING COUNT(tta.id) > v_target_per_table + 1
        ORDER BY COUNT(tta.id) DESC
    LOOP
        -- Find a table with fewer players
        SELECT id INTO v_target_table_id
        FROM tournament_tables tt
        LEFT JOIN tournament_table_assignments tta ON tta.tournament_table_id = tt.id AND tta.is_active = TRUE
        WHERE tt.tournament_id = p_tournament_id 
        AND tt.status = 'active'
        AND tt.id != v_table_rec.id
        GROUP BY tt.id
        HAVING COUNT(tta.id) < v_target_per_table
        ORDER BY COUNT(tta.id) ASC
        LIMIT 1;
        
        IF v_target_table_id IS NOT NULL THEN
            -- Move one player
            UPDATE tournament_table_assignments
            SET tournament_table_id = v_target_table_id,
                moved_from_table_id = v_table_rec.id,
                updated_at = now()
            WHERE id = (
                SELECT id FROM tournament_table_assignments
                WHERE tournament_table_id = v_table_rec.id AND is_active = TRUE
                ORDER BY current_stack ASC
                LIMIT 1
            );
            
            v_moves_made := v_moves_made + 1;
        END IF;
    END LOOP;
    
    RETURN v_moves_made;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE tournament_prize_pools IS 'Prize pool composition and distribution tracking';
COMMENT ON TABLE tournament_payouts IS 'Individual payout records for tournament finishers';
COMMENT ON TABLE tournament_rebuys IS 'Rebuy and add-on transaction records';
COMMENT ON TABLE tournament_tables IS 'Multi-table tournament table management';
COMMENT ON TABLE tournament_table_assignments IS 'Player seat assignments across tournament tables';
COMMENT ON TABLE tournament_eliminations IS 'Player elimination history with details';
COMMENT ON TABLE tournament_late_registrations IS 'Late registration tracking and adjustments';

COMMENT ON FUNCTION update_prize_pool_totals IS 'Recalculates prize pool totals from entries and rebuys';
COMMENT ON FUNCTION process_tournament_rebuy IS 'Handles rebuy/addon with chip addition and pool update';
COMMENT ON FUNCTION eliminate_tournament_player IS 'Processes player elimination with position calculation';
COMMENT ON FUNCTION balance_tournament_tables IS 'Balances player counts across tournament tables';
