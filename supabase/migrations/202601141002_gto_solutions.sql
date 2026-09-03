-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎯 GTO SOLUTIONS DATABASE SCHEMA
-- PioSolver output storage for training games and horse decisions
-- ═══════════════════════════════════════════════════════════════════════════════

-- Core GTO Solutions Table
CREATE TABLE IF NOT EXISTS gto_solutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_hash TEXT UNIQUE NOT NULL,
    
    -- Context
    position TEXT NOT NULL,  -- 'BTN', 'CO', 'MP', 'UTG', 'SB', 'BB'
    villain_position TEXT,
    stack_depth_bb INT NOT NULL,  -- 100, 50, 25, etc.
    pot_type TEXT NOT NULL,  -- 'srp', '3bet', '4bet', 'limp'
    street TEXT NOT NULL,  -- 'preflop', 'flop', 'turn', 'river'
    
    -- Board State
    board TEXT[],  -- ['As', '5c', '9d']
    board_texture TEXT,  -- 'dry', 'wet', 'paired', 'monotone', etc.
    
    -- Action Context
    action_facing TEXT,  -- 'check', 'bet_33', 'bet_50', 'bet_75', 'bet_100', 'allin'
    pot_size DECIMAL,
    effective_stack DECIMAL,
    
    -- GTO Solution
    gto_action TEXT NOT NULL,  -- Primary recommended action
    gto_frequencies JSONB NOT NULL,  -- {fold: 0.3, call: 0.5, raise: 0.2}
    ev DECIMAL,
    ev_by_action JSONB,  -- {fold: 0, call: 10.5, raise: 12.3}
    
    -- Sizing (for raises)
    raise_sizes JSONB,  -- {size_33: 0.4, size_50: 0.3, size_75: 0.2, size_100: 0.1}
    
    -- Solver Metadata
    solver_version TEXT DEFAULT 'PioSolver 3.0',
    solve_accuracy DECIMAL,  -- Target accuracy achieved
    solve_time_ms INT,
    iterations INT,
    
    -- Raw Data
    solver_output TEXT,  -- Full Pio CFR output
    tree_file TEXT,  -- Reference to .txt tree config
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Primary lookup by scenario hash
CREATE INDEX IF NOT EXISTS idx_gto_scenario_hash ON gto_solutions(scenario_hash);

-- Query by game context
CREATE INDEX IF NOT EXISTS idx_gto_context ON gto_solutions(position, pot_type, street);

-- Query by board texture
CREATE INDEX IF NOT EXISTS idx_gto_board ON gto_solutions(board_texture, street);

-- Query by action facing
CREATE INDEX IF NOT EXISTS idx_gto_action ON gto_solutions(action_facing, pot_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SCENARIO QUEUE (for batch processing)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gto_solve_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_hash TEXT NOT NULL,
    
    -- Scenario Definition
    position TEXT NOT NULL,
    villain_position TEXT,
    stack_depth_bb INT NOT NULL,
    pot_type TEXT NOT NULL,
    street TEXT NOT NULL,
    board TEXT[],
    action_facing TEXT,
    
    -- Queue Status
    status TEXT DEFAULT 'pending',  -- 'pending', 'solving', 'completed', 'failed'
    priority INT DEFAULT 5,  -- 1-10, higher = more important
    
    -- Processing
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON gto_solve_queue(status, priority DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PREFLOP RANGES TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS preflop_ranges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Position Context
    position TEXT NOT NULL,  -- 'BTN', 'CO', 'MP', 'UTG', 'SB', 'BB'
    action_type TEXT NOT NULL,  -- 'open', 'vs_open', '3bet', 'vs_3bet', '4bet'
    facing_position TEXT,  -- Position of raise we're facing
    
    -- Stack Depth
    stack_depth_bb INT NOT NULL,
    
    -- Range Data
    range_string TEXT NOT NULL,  -- 'AA,KK,QQ,AKs,AKo' format
    range_grid JSONB,  -- 13x13 matrix with frequencies
    
    -- Frequencies
    open_frequency DECIMAL,
    call_frequency DECIMAL,
    raise_frequency DECIMAL,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_preflop_unique 
ON preflop_ranges(position, action_type, facing_position, stack_depth_bb);

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTION: Compute scenario hash
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION compute_scenario_hash(
    p_position TEXT,
    p_pot_type TEXT,
    p_street TEXT,
    p_board TEXT[],
    p_action_facing TEXT,
    p_stack_depth INT
) RETURNS TEXT AS $$
BEGIN
    RETURN md5(
        COALESCE(p_position, '') || '|' ||
        COALESCE(p_pot_type, '') || '|' ||
        COALESCE(p_street, '') || '|' ||
        COALESCE(array_to_string(p_board, ','), '') || '|' ||
        COALESCE(p_action_facing, '') || '|' ||
        COALESCE(p_stack_depth::TEXT, '100')
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES (Public read for solutions)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE gto_solutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gto_solve_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE preflop_ranges ENABLE ROW LEVEL SECURITY;

-- Public read access for GTO solutions
CREATE POLICY "gto_solutions_public_read" ON gto_solutions
    FOR SELECT USING (true);

-- Public read for preflop ranges
CREATE POLICY "preflop_ranges_public_read" ON preflop_ranges
    FOR SELECT USING (true);

-- Admin only for queue management (service role)
CREATE POLICY "queue_service_role_all" ON gto_solve_queue
    FOR ALL USING (auth.role() = 'service_role');
