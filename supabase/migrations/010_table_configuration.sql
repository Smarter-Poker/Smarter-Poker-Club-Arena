-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE CONFIGURATION COLUMNS — Full PokerBros Feature Set
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds all 40+ configuration options to the tables table
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- GAME MODE
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS game_mode VARCHAR(10) DEFAULT 'regular';

-- ═══════════════════════════════════════════════════════════════════════════════
-- BASIC SETTINGS (toggles)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_vip_only BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS ban_chat BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS label_as_new BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS hide_club_name BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_template BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- GAME VARIANTS (toggles)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS bomb_pot_enabled BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS double_board BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS triple_board BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS pineapple_holdem BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS seven_deuce_enabled BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS nit_game BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS cap_enabled BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS no_rathole BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE PARAMETERS
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS action_time_seconds INTEGER DEFAULT 15;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS min_buy_in_bb INTEGER DEFAULT 2;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS max_buy_in_bb INTEGER DEFAULT 25;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS ante_bb DECIMAL(10, 2) DEFAULT 0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS career_percent_min INTEGER DEFAULT 0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS maintain_percent_min INTEGER DEFAULT 0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS maintain_hands INTEGER DEFAULT 10;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_start_players INTEGER DEFAULT 2;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS game_length_hours INTEGER DEFAULT 12;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TIME & AUTO SETTINGS (toggles)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS calltime_enabled BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_extension BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_restart BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_create_table BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_utg_straddle BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS voluntary_straddle BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS insurance_enabled BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RUN IT MULTI-TIMES
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS run_it_mode VARCHAR(20) DEFAULT 'none';
-- Values: 'none', 'player_choice', 'mandatory_twice', 'mandatory_three'

-- ═══════════════════════════════════════════════════════════════════════════════
-- RAKE SETTINGS (Default 10% with 3BB cap)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE tables ADD COLUMN IF NOT EXISTS rake_percent DECIMAL(5, 2) DEFAULT 10.0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS rake_cap_bb DECIMAL(5, 2) DEFAULT 3;

-- SNG/MTT SPECIFIC
ALTER TABLE tables ADD COLUMN IF NOT EXISTS sng_buy_in INTEGER DEFAULT 100;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS sng_custom_buy_in BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS blind_structure VARCHAR(20) DEFAULT 'standard';
ALTER TABLE tables ADD COLUMN IF NOT EXISTS payout_structure VARCHAR(20) DEFAULT 'payout1';
ALTER TABLE tables ADD COLUMN IF NOT EXISTS starting_chips INTEGER DEFAULT 1000;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS blinds_up_minutes INTEGER DEFAULT 3;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS next_step_satellite BOOLEAN DEFAULT false;

-- MTT SPECIFIC
ALTER TABLE tables ADD COLUMN IF NOT EXISTS short_description TEXT DEFAULT '';
ALTER TABLE tables ADD COLUMN IF NOT EXISTS accelerated_mtt BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS all_in_or_fold BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS custom_rebuy_reentry_cost BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS number_of_rebuys_reentries INTEGER DEFAULT 3;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS add_on_multiplier DECIMAL(3, 1) DEFAULT 1.0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS custom_add_on BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS add_on_break_length_minutes INTEGER DEFAULT 1;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS ko_bounty BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS gtd_prize_pool BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS final_table_deal BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS big_blind_ante BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS authorized_to_register BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS late_registration_level INTEGER DEFAULT 6;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS early_bird_registration BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS bubble_protection BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS featured_tournament BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS min_players_mtt INTEGER DEFAULT 30;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS max_players_mtt INTEGER DEFAULT 300;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS multi_day_mtt BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS save_start_time BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS start_time TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS restart_tournament_every BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS tournament_schedule BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS synchronized_breaks BOOLEAN DEFAULT true;

-- SECURITY/RESTRICTION SETTINGS
ALTER TABLE tables ADD COLUMN IF NOT EXISTS agent_downline_limit INTEGER DEFAULT NULL;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS buy_in_authorization BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS restrict_device BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS restrict_observers BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS gps_restriction BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS ip_restriction BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS pc_emulator_restriction BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS photo_rotation_verification BOOLEAN DEFAULT false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_tables_featured ON tables(is_featured) WHERE is_featured = true;
CREATE INDEX IF NOT EXISTS idx_tables_template ON tables(is_template) WHERE is_template = true;
CREATE INDEX IF NOT EXISTS idx_tables_created_by ON tables(created_by);

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICY FOR TABLE CREATION
-- ═══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Club admins can create tables" ON tables;
CREATE POLICY "Club admins can create tables" ON tables
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM club_members 
            WHERE club_members.club_id = tables.club_id 
            AND club_members.user_id = auth.uid()
            AND club_members.role IN ('owner', 'admin')
            AND club_members.status = 'active'
        )
    );

DROP POLICY IF EXISTS "Club admins can update tables" ON tables;
CREATE POLICY "Club admins can update tables" ON tables
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM club_members 
            WHERE club_members.club_id = tables.club_id 
            AND club_members.user_id = auth.uid()
            AND club_members.role IN ('owner', 'admin')
            AND club_members.status = 'active'
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$ 
BEGIN 
    RAISE NOTICE '♠ TABLE CONFIGURATION COLUMNS ADDED SUCCESSFULLY';
    RAISE NOTICE 'All 40+ configuration options now available in tables table';
    RAISE NOTICE 'Rake defaults: 10% with 3BB cap (adjustable down)';
END $$;
