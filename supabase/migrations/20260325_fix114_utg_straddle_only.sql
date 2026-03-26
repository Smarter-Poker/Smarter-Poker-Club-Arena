-- FIX 114: Remove Mississippi straddle — UTG only (2x BB)
-- Per Dan's directive: "ONLY STRADDLE WE ARE ALLOWING IS UTG. (2ND BIG BLIND ONLY)"
-- This migration:
-- 1. Updates any existing 'mississippi' rows to 'utg'
-- 2. Drops the old CHECK constraint
-- 3. Adds a new CHECK constraint allowing only 'utg'
-- 4. Sets max_straddles to 1 for all tables (UTG only = one straddle max)
-- 5. Updates column comments

-- Step 1: Normalize any existing Mississippi straddle tables to UTG
UPDATE public.tables SET straddle_type = 'utg' WHERE straddle_type = 'mississippi';

-- Step 2: Drop old CHECK constraint (name may vary — try common patterns)
-- PostgreSQL auto-names CHECK constraints as tablename_columnname_check
DO $$
BEGIN
  -- Try dropping by common auto-generated name
  ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_straddle_type_check;
  ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_check;
EXCEPTION WHEN undefined_object THEN
  NULL; -- Constraint doesn't exist, that's fine
END $$;

-- Step 3: Add new CHECK constraint — UTG only
ALTER TABLE public.tables ADD CONSTRAINT tables_straddle_type_check
  CHECK (straddle_type IN ('utg'));

-- Step 4: Force max_straddles = 1 for all tables (UTG = one straddle only)
UPDATE public.tables SET max_straddles = 1 WHERE max_straddles != 1;

-- Step 5: Update column comments
COMMENT ON COLUMN public.tables.straddle_enabled IS 'Bible V8 §4.4: When true, UTG straddle is allowed (2x BB)';
COMMENT ON COLUMN public.tables.straddle_type IS 'Bible V8 §4.4: Only utg allowed — UTG posts 2x BB before preflop action';
COMMENT ON COLUMN public.tables.max_straddles IS 'Bible V8 §4.4: Always 1 — only one UTG straddle per hand';
