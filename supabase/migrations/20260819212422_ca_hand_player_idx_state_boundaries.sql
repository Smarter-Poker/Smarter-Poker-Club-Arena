-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819212422 "ca_hand_player_idx_state_boundaries"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fc2d6744f672673c8b22627b5ed8cf34 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Two boundaries instead of a single forward watermark: the stats RPC only
-- wants a player's MOST RECENT hands, so the newest must be indexed first and
-- the old tail fills in behind.
--   idx_ceil  — newest indexed instant (new hands land above it)
--   idx_floor — oldest indexed instant (backfill walks downward from here)
ALTER TABLE public.ca_hand_player_idx_state
  ADD COLUMN IF NOT EXISTS idx_floor timestamptz,
  ADD COLUMN IF NOT EXISTS idx_ceil  timestamptz,
  ADD COLUMN IF NOT EXISTS backfill_complete boolean NOT NULL DEFAULT false;

UPDATE public.ca_hand_player_idx_state
SET idx_floor = coalesce(idx_floor, now()),
    idx_ceil  = coalesce(idx_ceil,  now())
WHERE id;
