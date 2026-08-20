-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  SUPERSEDED 2026-08-20 — DO NOT APPLY                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- This migration was written on 2026-04-17 and never applied. The server code
-- inserted the four columns anyway and fell back "if the columns don't exist",
-- so for four months every single hand did two PostgREST round-trips: a 400
-- followed by a 201. Measured in edge_logs on 2026-08-20: 138 x 400 + 138 x 201
-- in the same minute, every minute — roughly 238,000 guaranteed-failing
-- requests a day, hidden behind the graceful fallback.
--
-- The decision is to keep the tiers DERIVED rather than stored, and the dead
-- write has been removed from server/src/services/supabase/handHistory.ts.
-- Reason: all four tiers are pure functions of columns hand_history already
-- stores. raw_events is `actions` re-keyed; audit_log is the row's own scalars
-- re-packed; player_summaries is derived from players + winners + actions; and
-- dispute_review is literally the other three concatenated with
-- showdown_results and community_cards. hand_history is already 10 GB across
-- 2.45M rows and takes 238,583 rows (~1 GB) a day — storing three redundant
-- copies of the largest payload on the platform would roughly quadruple that
-- growth and add no information.
--
-- Bible V8 §2.18 is satisfied by `buildHandHistoryTiers()` in
-- server/src/services/supabase/handHistory.ts, which materialises the same four
-- tiers on demand from a stored row.
--
-- Kept on disk as the record of what was intended and why it was not done.

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
