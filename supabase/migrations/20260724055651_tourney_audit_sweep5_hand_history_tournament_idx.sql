-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724055651 "tourney_audit_sweep5_hand_history_tournament_idx"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 59b1c8639982626eff82e8bcc88dbe72 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TOURNEY-AUDIT SWEEP 5 (2026-07-24): hand_history had NO tournament_id index.
-- The stale-tournament sweep, tournament activity checks, and tournament hand
-- reporting all filter hand_history by tournament_id (+ created_at) against a
-- 1.4M+ row table — each was a full/partial scan. Partial composite index
-- covers tournament rows only.
CREATE INDEX IF NOT EXISTS idx_hand_history_tournament_created
  ON public.hand_history (tournament_id, created_at DESC)
  WHERE tournament_id IS NOT NULL;
