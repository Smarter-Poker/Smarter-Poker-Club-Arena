-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT SCHEMA SYNC — Ensure all columns the code expects actually exist
-- ═══════════════════════════════════════════════════════════════════════════════
-- Safe to run multiple times (IF NOT EXISTS / DO blocks)
-- Syncs: TournamentService.ts createTournament() + server/src/index.ts
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── TOURNAMENTS TABLE: Core columns the code references ──────────────────────

-- game_type (code uses 'NLH', original schema has game_variant enum)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS game_type TEXT DEFAULT 'NLH';

-- variant (freezeout, bounty, sng, spin, etc.)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS variant TEXT DEFAULT 'freezeout';

-- tournament_type (MTT, SNG, SPIN)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS tournament_type TEXT DEFAULT 'MTT';

-- buy_in_amount (code uses this, original schema has buy_in)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS buy_in_amount DECIMAL(18, 4) DEFAULT 0;

-- buy_in_fee (code uses this, original schema has fee)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS buy_in_fee DECIMAL(18, 4) DEFAULT 0;

-- payout_structure (JSONB array of payout percentages)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payout_structure JSONB DEFAULT '[]'::jsonb;

-- guaranteed_prize
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS guaranteed_prize DECIMAL(18, 4) DEFAULT 0;

-- late_reg_mins (minutes of late registration)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS late_reg_mins INTEGER DEFAULT 0;

-- start_time (code uses this, original schema has scheduled_start)
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ;

-- ─── Rebuy columns ───────────────────────────────────────────────────────────

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_rebuy BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_cost DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_chips INTEGER DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_levels INTEGER DEFAULT 4;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS add_on_available BOOLEAN DEFAULT FALSE;

-- ─── Multi-Day columns ───────────────────────────────────────────────────────

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_multi_day BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS total_days INTEGER DEFAULT 1;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS day_number INTEGER DEFAULT 1;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS flight_number INTEGER DEFAULT 1;

-- ─── XMTT (Union Tournament) columns ─────────────────────────────────────────

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_xmtt BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS union_id UUID DEFAULT NULL;

-- ─── Spin type + rake + pinned ──────────────────────────────────────────────

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS spin_type TEXT DEFAULT 'standard';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS total_rake DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;

-- ─── Tournament Players: table_id for seat tracking ──────────────────────────

ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS table_id UUID DEFAULT NULL;

-- ─── Indexes for new columns ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tournaments_variant ON tournaments(variant);
CREATE INDEX IF NOT EXISTS idx_tournaments_tournament_type ON tournaments(tournament_type);
CREATE INDEX IF NOT EXISTS idx_tournaments_start_time ON tournaments(start_time);
CREATE INDEX IF NOT EXISTS idx_tournaments_union_id ON tournaments(union_id) WHERE union_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournament_players_table_id ON tournament_players(table_id) WHERE table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournaments_is_pinned ON tournaments(is_pinned) WHERE is_pinned = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — All columns code expects now exist in the database
-- ═══════════════════════════════════════════════════════════════════════════════
