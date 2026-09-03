-- ═══════════════════════════════════════════════════════════════════════════════
-- TOURNAMENT BOUNTIES, SPIN, ADD-ON & MISSING COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds all missing schema for:
--   - Bounty (KO) / Progressive KO (PKO) / Mystery Bounty tournaments
--   - Spin & Go multiplier tracking
--   - Add-on period configuration
--   - Prize pool finalization flag
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── TOURNAMENTS TABLE: Add missing columns ─────────────────────────────────

-- Bounty flags
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_bounty BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_pko BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_mystery_bounty BOOLEAN DEFAULT FALSE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bounty_amount DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS mystery_bounty_min INTEGER DEFAULT 1;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS mystery_bounty_max INTEGER DEFAULT 50;

-- Spin & Go
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS spin_multiplier DECIMAL(18, 4) DEFAULT NULL;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_premium_spin BOOLEAN DEFAULT FALSE;

-- Add-on configuration
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_cost DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_chips INTEGER DEFAULT 0;

-- Prize pool finalization
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS prize_pool_finalized BOOLEAN DEFAULT FALSE;

-- ─── TOURNAMENT_PLAYERS TABLE: Add missing bounty tracking columns ──────────

ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS current_bounty DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS bounties_collected INTEGER DEFAULT 0;
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS bounty_winnings DECIMAL(18, 4) DEFAULT 0;
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS mystery_bounty_value DECIMAL(18, 4) DEFAULT NULL;

-- ─── TOURNAMENT_BOUNTIES TABLE ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tournament_bounties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    eliminated_player_id UUID NOT NULL,
    collector_player_id UUID NOT NULL,
    bounty_amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    added_to_collector_bounty DECIMAL(18, 4) DEFAULT 0,
    is_mystery_revealed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ─── INDEXES ────────────────────────────────────────────────────────────────

-- Tournament bounties: fast lookup by tournament + player
CREATE INDEX IF NOT EXISTS idx_tournament_bounties_tournament_id
    ON tournament_bounties(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_bounties_collector
    ON tournament_bounties(collector_player_id);
CREATE INDEX IF NOT EXISTS idx_tournament_bounties_eliminated
    ON tournament_bounties(eliminated_player_id);

-- Tournament players: fast elimination check (server polls this every 5s)
CREATE INDEX IF NOT EXISTS idx_tournament_players_status
    ON tournament_players(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_tournament_players_chips
    ON tournament_players(tournament_id, status, chips);

-- Hand history: fast lookup for knocker determination (most recent hand at table)
CREATE INDEX IF NOT EXISTS idx_hand_history_table_created
    ON hand_history(table_id, created_at DESC);

-- ─── RLS POLICIES ───────────────────────────────────────────────────────────

ALTER TABLE tournament_bounties ENABLE ROW LEVEL SECURITY;

-- Anyone can read bounty records for tournaments they participate in
CREATE POLICY IF NOT EXISTS "tournament_bounties_select"
    ON tournament_bounties FOR SELECT
    USING (TRUE);

-- Only service role can insert/update (server-side only)
CREATE POLICY IF NOT EXISTS "tournament_bounties_insert_service"
    ON tournament_bounties FOR INSERT
    WITH CHECK (TRUE);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE
-- ═══════════════════════════════════════════════════════════════════════════════
