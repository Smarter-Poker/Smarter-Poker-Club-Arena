-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721123601 "solved_spots_gold_v2_corrected_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1901d4d94c58f096f535d654a10d7b89 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-07-19 Engine audit phase 3 — corrected re-solve target.
-- The original ingest (turn_river_solver.py) scrambled per-hand arrays: the
-- f/b45 columns hold EV/equity arrays, hand_evs holds a different node's
-- strategy. Source .cfr files were deleted post-upload, so recovery is
-- impossible — the two solver machines re-export CORRECT data into this new
-- column (old strategy_matrix stays untouched until v2 coverage is verified
-- and the engine reader is flipped).
--
-- strategy_matrix_v2 shape (written by the corrected export pipeline):
--   {
--     "actions": ["c","b16","b45"],              -- REAL root actions (no fold at root)
--     "frequencies": { "c": {hand:0-1}, ... },   -- per-combo, sums to 1 across actions in range
--     "hand_evs":    { hand: chip_ev },          -- REAL per-combo EV (nuts rank highest)
--     "response_nodes": {                          -- optional-preferred: unlocks fold/call/raise
--        "vs_b16": {"actions":["f","c","r"],"frequencies":{...}},
--        "vs_check": {"actions":["c","b16"],"frequencies":{...}}
--     },
--     "meta": { "oop_range":..., "ip_range":..., "sizings":..., "rake":..., "pot":..., "eff_stack":... }
--   }
ALTER TABLE public.solved_spots_gold
  ADD COLUMN IF NOT EXISTS strategy_matrix_v2 jsonb,
  ADD COLUMN IF NOT EXISTS solved_v2_at timestamptz;

-- Fast work-finding for the two machines (partial index shrinks as work completes)
CREATE INDEX IF NOT EXISTS idx_ssg_v2_pending
  ON public.solved_spots_gold (street, game_type)
  WHERE strategy_matrix_v2 IS NULL;

-- Assertion
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='solved_spots_gold'
      AND column_name='strategy_matrix_v2'
  ) THEN RAISE EXCEPTION 'strategy_matrix_v2 column missing after migration'; END IF;
END $$;
