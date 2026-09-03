-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎯 GTO SOLUTIONS DATABASE - COMPLETE SCHEMA
-- Covers: Cash (HU, 6max, 9max) + MTT + SNG + Spins + HU Tournaments
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- GAME FORMATS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS game_formats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,  -- 'hu_cash', '6max_cash', 'mtt_6max_chipev', 'spin_3max'
    name TEXT NOT NULL,
    category TEXT NOT NULL,  -- 'cash', 'mtt', 'sng', 'spin'
    player_count INT NOT NULL,
    positions TEXT[] NOT NULL,
    
    -- Tournament-specific
    is_tournament BOOLEAN DEFAULT FALSE,
    uses_icm BOOLEAN DEFAULT FALSE,
    is_hyper BOOLEAN DEFAULT FALSE,
    
    description TEXT,
    solve_priority INT DEFAULT 5,  -- 1-10, higher = solve first
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed game formats
INSERT INTO game_formats (code, name, category, player_count, positions, is_tournament, uses_icm, is_hyper, solve_priority) VALUES
-- Cash Games
('hu_cash', 'Heads Up Cash', 'cash', 2, ARRAY['BTN', 'BB'], FALSE, FALSE, FALSE, 8),
('6max_cash', '6-Max Cash', 'cash', 6, ARRAY['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], FALSE, FALSE, FALSE, 10),
('9max_cash', 'Full Ring Cash', 'cash', 9, ARRAY['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'], FALSE, FALSE, FALSE, 5),

-- MTT (Multi-Table Tournaments)
('mtt_9max_chipev', 'MTT 9-Max Chip EV', 'mtt', 9, ARRAY['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'], TRUE, FALSE, FALSE, 7),
('mtt_9max_icm', 'MTT 9-Max ICM', 'mtt', 9, ARRAY['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'], TRUE, TRUE, FALSE, 8),
('mtt_6max_chipev', 'MTT 6-Max Chip EV', 'mtt', 6, ARRAY['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], TRUE, FALSE, FALSE, 9),
('mtt_6max_icm', 'MTT 6-Max ICM', 'mtt', 6, ARRAY['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], TRUE, TRUE, FALSE, 9),
('mtt_hu_chipev', 'MTT Heads Up Chip EV', 'mtt', 2, ARRAY['BTN', 'BB'], TRUE, FALSE, FALSE, 7),
('mtt_hu_icm', 'MTT Heads Up ICM', 'mtt', 2, ARRAY['BTN', 'BB'], TRUE, TRUE, FALSE, 8),
('mtt_3max_chipev', 'MTT 3-Max Chip EV', 'mtt', 3, ARRAY['BTN', 'SB', 'BB'], TRUE, FALSE, FALSE, 7),
('mtt_3max_icm', 'MTT 3-Max ICM (Final Table)', 'mtt', 3, ARRAY['BTN', 'SB', 'BB'], TRUE, TRUE, FALSE, 9),

-- SNG (Sit & Go)
('sng_9max_chipev', 'SNG 9-Max Chip EV', 'sng', 9, ARRAY['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'], TRUE, FALSE, FALSE, 6),
('sng_9max_icm', 'SNG 9-Max ICM', 'sng', 9, ARRAY['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB'], TRUE, TRUE, FALSE, 7),
('sng_6max_chipev', 'SNG 6-Max Chip EV', 'sng', 6, ARRAY['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], TRUE, FALSE, FALSE, 7),
('sng_6max_icm', 'SNG 6-Max ICM', 'sng', 6, ARRAY['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'], TRUE, TRUE, FALSE, 8),
('sng_hu', 'SNG Heads Up', 'sng', 2, ARRAY['BTN', 'BB'], TRUE, FALSE, FALSE, 6),

-- Spins (3-Max Hyper Turbo)
('spin_3max_chipev', 'Spin 3-Max Chip EV', 'spin', 3, ARRAY['BTN', 'SB', 'BB'], TRUE, FALSE, TRUE, 9),
('spin_3max_icm', 'Spin 3-Max ICM', 'spin', 3, ARRAY['BTN', 'SB', 'BB'], TRUE, TRUE, TRUE, 10),
('spin_hu_chipev', 'Spin HU Chip EV', 'spin', 2, ARRAY['BTN', 'BB'], TRUE, FALSE, TRUE, 8),
('spin_hu_icm', 'Spin HU ICM', 'spin', 2, ARRAY['BTN', 'BB'], TRUE, TRUE, TRUE, 9)

ON CONFLICT (code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- STACK DEPTH CONFIGS (by format)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stack_depth_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_format_id UUID REFERENCES game_formats(id),
    stack_depth_bb INT NOT NULL,
    solve_priority INT DEFAULT 5,
    description TEXT,
    
    UNIQUE(game_format_id, stack_depth_bb)
);

-- Seed stack depths for each format
DO $$
DECLARE
    format_rec RECORD;
BEGIN
    -- Cash game depths
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'cash' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 20, 6),
        (format_rec.id, 50, 8),
        (format_rec.id, 100, 10),
        (format_rec.id, 200, 7)
        ON CONFLICT DO NOTHING;
    END LOOP;
    
    -- MTT depths (wider range)
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'mtt' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 8, 7),
        (format_rec.id, 10, 9),
        (format_rec.id, 12, 8),
        (format_rec.id, 15, 9),
        (format_rec.id, 20, 10),
        (format_rec.id, 25, 9),
        (format_rec.id, 30, 8),
        (format_rec.id, 40, 7),
        (format_rec.id, 50, 8),
        (format_rec.id, 75, 6),
        (format_rec.id, 100, 5)
        ON CONFLICT DO NOTHING;
    END LOOP;
    
    -- SNG depths
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'sng' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 10, 9),
        (format_rec.id, 15, 10),
        (format_rec.id, 20, 10),
        (format_rec.id, 25, 9),
        (format_rec.id, 30, 8),
        (format_rec.id, 50, 7)
        ON CONFLICT DO NOTHING;
    END LOOP;
    
    -- Spin depths (hyper turbo - shallow)
    FOR format_rec IN SELECT id FROM game_formats WHERE category = 'spin' LOOP
        INSERT INTO stack_depth_configs (game_format_id, stack_depth_bb, solve_priority) VALUES
        (format_rec.id, 8, 8),
        (format_rec.id, 10, 10),
        (format_rec.id, 12, 10),
        (format_rec.id, 15, 10),
        (format_rec.id, 18, 9),
        (format_rec.id, 20, 9),
        (format_rec.id, 25, 8)
        ON CONFLICT DO NOTHING;
    END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- GTO SOLUTIONS (Main table)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gto_solutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_hash TEXT UNIQUE NOT NULL,
    
    -- Game Context
    game_format_id UUID REFERENCES game_formats(id),
    format_code TEXT NOT NULL,
    
    -- Position Context
    hero_position TEXT NOT NULL,
    villain_position TEXT,
    num_players_remaining INT,  -- For tournament ICM
    
    -- Stack & Pot
    stack_depth_bb INT NOT NULL,
    effective_stack DECIMAL,
    pot_size DECIMAL,
    pot_type TEXT NOT NULL,  -- 'rfi', 'srp', '3bet', '4bet', 'limp', 'reshove'
    
    -- ICM Context (tournaments)
    is_icm BOOLEAN DEFAULT FALSE,
    icm_payouts JSONB,  -- [50, 30, 20] percentages
    icm_stacks JSONB,   -- {BTN: 25, SB: 15, BB: 10}
    icm_bubble_factor DECIMAL,
    
    -- Board State
    street TEXT NOT NULL,  -- 'preflop', 'flop', 'turn', 'river'
    board TEXT[],
    board_texture TEXT,
    
    -- Action Context
    action_facing TEXT,  -- 'open', 'check', 'bet_33', 'bet_50', 'raise', 'shove'
    action_sequence TEXT[],  -- Full history ['rfi_2.5x', 'call']
    
    -- GTO Solution
    gto_action TEXT NOT NULL,
    gto_frequencies JSONB NOT NULL,  -- {fold: 0.3, call: 0.5, raise: 0.2}
    ev DECIMAL,
    ev_bb DECIMAL,  -- EV in big blinds
    ev_by_action JSONB,  -- {fold: 0, call: 10.5, raise: 12.3}
    
    -- Sizing Details
    raise_sizes JSONB,  -- {size_2x: 0.4, size_2.5x: 0.3, size_3x: 0.2, allin: 0.1}
    bet_sizes JSONB,    -- {size_33: 0.5, size_50: 0.3, size_75: 0.2}
    
    -- Solver Metadata
    solver_version TEXT DEFAULT 'PioSolver 3.0',
    solve_accuracy DECIMAL,
    solve_time_ms INT,
    iterations INT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_gto_hash ON gto_solutions(scenario_hash);
CREATE INDEX IF NOT EXISTS idx_gto_format ON gto_solutions(format_code);
CREATE INDEX IF NOT EXISTS idx_gto_context ON gto_solutions(hero_position, pot_type, street);
CREATE INDEX IF NOT EXISTS idx_gto_stack ON gto_solutions(stack_depth_bb);
CREATE INDEX IF NOT EXISTS idx_gto_icm ON gto_solutions(is_icm) WHERE is_icm = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SOLVE QUEUE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gto_solve_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_hash TEXT NOT NULL,
    
    -- Context
    game_format_id UUID REFERENCES game_formats(id),
    format_code TEXT NOT NULL,
    hero_position TEXT NOT NULL,
    villain_position TEXT,
    stack_depth_bb INT NOT NULL,
    pot_type TEXT NOT NULL,
    street TEXT NOT NULL,
    board TEXT[],
    action_facing TEXT,
    
    -- ICM (if applicable)
    is_icm BOOLEAN DEFAULT FALSE,
    icm_payouts JSONB,
    icm_stacks JSONB,
    
    -- Queue Management
    status TEXT DEFAULT 'pending',  -- 'pending', 'solving', 'completed', 'failed'
    priority INT DEFAULT 5,
    
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    retry_count INT DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON gto_solve_queue(status, priority DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PREFLOP RANGES (By format and stack depth)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS preflop_ranges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_format_id UUID REFERENCES game_formats(id),
    format_code TEXT NOT NULL,
    
    position TEXT NOT NULL,
    action_type TEXT NOT NULL,  -- 'rfi', 'vs_rfi', '3bet', 'vs_3bet', '4bet', 'limp', 'reshove'
    facing_position TEXT,
    
    stack_depth_bb INT NOT NULL,
    is_icm BOOLEAN DEFAULT FALSE,
    
    range_string TEXT NOT NULL,
    range_grid JSONB,  -- 13x13 matrix
    
    -- Frequencies
    action_frequency DECIMAL,  -- e.g., 3bet frequency
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_preflop_unique 
ON preflop_ranges(format_code, position, action_type, COALESCE(facing_position, ''), stack_depth_bb, is_icm);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRAINING DRILLS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS training_drills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    
    name TEXT NOT NULL,
    description TEXT,
    tags TEXT[],
    
    -- Game Config
    game_format_id UUID REFERENCES game_formats(id),
    format_code TEXT,
    pot_type TEXT,
    hero_position TEXT,
    villain_position TEXT,
    stack_depth_bb INT,
    
    -- ICM Settings
    is_icm BOOLEAN DEFAULT FALSE,
    
    -- Filters
    board_textures TEXT[],
    excluded_boards TEXT[],
    included_hands TEXT[],
    excluded_hands TEXT[],
    starting_action TEXT,
    
    -- Stats
    times_played INT DEFAULT 0,
    is_public BOOLEAN DEFAULT FALSE,
    is_system BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DRILL PERFORMANCE TRACKING
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS drill_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    drill_id UUID REFERENCES training_drills(id),
    
    session_date DATE NOT NULL,
    hands_played INT NOT NULL,
    correct_actions INT DEFAULT 0,
    accuracy_pct DECIMAL,
    avg_ev_loss DECIMAL,
    
    -- Breakdown
    action_breakdown JSONB,  -- {correct_folds: 5, correct_calls: 3...}
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE game_formats ENABLE ROW LEVEL SECURITY;
ALTER TABLE gto_solutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gto_solve_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE preflop_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_drills ENABLE ROW LEVEL SECURITY;
ALTER TABLE drill_performance ENABLE ROW LEVEL SECURITY;

-- Public read for solutions and ranges
CREATE POLICY "gto_solutions_read" ON gto_solutions FOR SELECT USING (true);
CREATE POLICY "preflop_ranges_read" ON preflop_ranges FOR SELECT USING (true);
CREATE POLICY "game_formats_read" ON game_formats FOR SELECT USING (true);

-- Drills - public can read public drills
CREATE POLICY "drills_public_read" ON training_drills 
    FOR SELECT USING (is_public = true OR user_id = auth.uid());

-- Performance - users see their own
CREATE POLICY "performance_own" ON drill_performance 
    FOR ALL USING (user_id = auth.uid());

-- Queue - service role only
CREATE POLICY "queue_service" ON gto_solve_queue 
    FOR ALL USING (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION compute_scenario_hash(
    p_format TEXT,
    p_position TEXT,
    p_pot_type TEXT,
    p_street TEXT,
    p_board TEXT[],
    p_action TEXT,
    p_stack INT,
    p_is_icm BOOLEAN DEFAULT FALSE
) RETURNS TEXT AS $$
BEGIN
    RETURN md5(
        COALESCE(p_format, '') || '|' ||
        COALESCE(p_position, '') || '|' ||
        COALESCE(p_pot_type, '') || '|' ||
        COALESCE(p_street, '') || '|' ||
        COALESCE(array_to_string(p_board, ','), '') || '|' ||
        COALESCE(p_action, '') || '|' ||
        COALESCE(p_stack::TEXT, '100') || '|' ||
        COALESCE(p_is_icm::TEXT, 'false')
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;
