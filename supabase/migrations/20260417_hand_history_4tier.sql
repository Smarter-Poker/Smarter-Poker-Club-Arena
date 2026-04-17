-- ═══════════════════════════════════════════════════════════════════════════════
--  Bible V8 §2.18 — Hand History 4-Tier Columns
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Adds JSONB columns for the 4-tier hand history system:
--   Tier 1: raw_events     — Every action with seq, seat, userId, amount, stage, timestamp
--   Tier 2: audit_log      — Normalized hand summary for compliance/audit
--   Tier 3: player_summaries — Per-player results for stats/leaderboards
--   Tier 4: dispute_review  — Complete package for dispute resolution
--
-- The server code (supabase.ts logHandHistory) already has graceful fallback:
-- if these columns don't exist, it falls back to legacy insert.
-- Once this migration runs, the full 4-tier data will be persisted.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add columns if they don't already exist
DO $$
BEGIN
  -- Tier 1: Raw Events
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hand_history' AND column_name = 'raw_events'
  ) THEN
    ALTER TABLE hand_history ADD COLUMN raw_events jsonb;
    COMMENT ON COLUMN hand_history.raw_events IS 'Bible V8 §2.18 Tier 1: Every action with seq, seat, userId, amount, stage, timestamp';
  END IF;

  -- Tier 2: Audit Log
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hand_history' AND column_name = 'audit_log'
  ) THEN
    ALTER TABLE hand_history ADD COLUMN audit_log jsonb;
    COMMENT ON COLUMN hand_history.audit_log IS 'Bible V8 §2.18 Tier 2: Normalized hand summary for compliance/audit';
  END IF;

  -- Tier 3: Player Summaries
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hand_history' AND column_name = 'player_summaries'
  ) THEN
    ALTER TABLE hand_history ADD COLUMN player_summaries jsonb;
    COMMENT ON COLUMN hand_history.player_summaries IS 'Bible V8 §2.18 Tier 3: Per-player results for stats/leaderboards';
  END IF;

  -- Tier 4: Dispute Review Package
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hand_history' AND column_name = 'dispute_review'
  ) THEN
    ALTER TABLE hand_history ADD COLUMN dispute_review jsonb;
    COMMENT ON COLUMN hand_history.dispute_review IS 'Bible V8 §2.18 Tier 4: Complete package for dispute resolution';
  END IF;
END $$;

-- Index on raw_events for searching specific actions (e.g., all-in events)
CREATE INDEX IF NOT EXISTS idx_hand_history_raw_events
  ON hand_history USING gin (raw_events jsonb_path_ops);

-- Index on player_summaries for player-specific queries
CREATE INDEX IF NOT EXISTS idx_hand_history_player_summaries
  ON hand_history USING gin (player_summaries jsonb_path_ops);
