-- Phase 10: Add missing leaderboard columns to player_stats
-- These columns are needed for the tournaments_won and ROI leaderboard metrics

ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS tournaments_played INTEGER DEFAULT 0;
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS tournaments_won INTEGER DEFAULT 0;
