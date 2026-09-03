-- TOURNEY-AUDIT SWEEP 5 (2026-07-24): performance index.
-- (Applied to the live PokerIQ-Production database on 2026-07-24 via MCP.)
-- hand_history had NO tournament_id index — the stale-tournament sweep,
-- activity checks, and tournament reporting scanned 1.4M+ rows.
CREATE INDEX IF NOT EXISTS idx_hand_history_tournament_created
  ON public.hand_history (tournament_id, created_at DESC)
  WHERE tournament_id IS NOT NULL;
