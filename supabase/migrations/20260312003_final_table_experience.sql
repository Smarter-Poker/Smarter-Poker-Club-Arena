-- ═══════════════════════════════════════════════════════════════════════════════
-- Final Table Experience — Schema Extensions
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds columns needed for the Final Table overlay, player style classification,
-- and heads-up auto-switch features.

-- 1. final_table_triggered: prevents re-firing the final table overlay
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS final_table_triggered BOOLEAN DEFAULT FALSE;

-- 2. player_stats for session-level VPIP/PFR tracking (used by PlayerStyleClassifier)
-- If not already present, add aggregate stat columns to tournament_entries
ALTER TABLE tournament_entries
  ADD COLUMN IF NOT EXISTS vpip_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pfr_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hands_played INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aggressive_actions INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS passive_actions INTEGER DEFAULT 0;

-- 3. Add player style cache column (avoids re-classification on every render)
ALTER TABLE tournament_entries
  ADD COLUMN IF NOT EXISTS player_style TEXT DEFAULT NULL;

COMMENT ON COLUMN tournaments.final_table_triggered IS 'Prevents re-firing the Final Table overlay after it has been shown once';
COMMENT ON COLUMN tournament_entries.vpip_count IS 'Count of hands where player voluntarily put money in pot';
COMMENT ON COLUMN tournament_entries.pfr_count IS 'Count of hands where player raised preflop';
COMMENT ON COLUMN tournament_entries.player_style IS 'Cached player style classification (shark/fish/rock/maniac/tag/lag/nit/calling_station)';
