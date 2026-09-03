-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Fix Cash Tables — Union Assignment + Activation + Duplicate Cleanup
-- Date: 2026-03-30
-- FIX 201/202: Cash tables must belong to the Midway Union and be in 'waiting' status
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Set union_id on ALL existing cash tables (non-tournament) that lack it.
-- Tables belong to clubs, but clubs are inside the Midway Union.
-- The union_id makes them discoverable on UnionGamesPage.
UPDATE tables
SET union_id = 'fade0000-0000-0000-0000-000000000001'
WHERE tournament_id IS NULL
  AND (union_id IS NULL OR union_id != 'fade0000-0000-0000-0000-000000000001');

-- Step 2: Reactivate ALL closed cash tables back to 'waiting'.
-- The server's cleanupStaleData() previously only reset waiting/running tables,
-- leaving closed tables permanently stuck. This fixes the backlog.
UPDATE tables
SET status = 'waiting', current_players = 0
WHERE tournament_id IS NULL
  AND status = 'closed';

-- Step 3: Clean up duplicate tournament tables (keep newest per name).
-- Each server restart created duplicates because there was no unique constraint.
-- Delete all but the most recent duplicate for each tournament table name.
DELETE FROM tables
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at DESC) as rn
    FROM tables
    WHERE tournament_id IS NOT NULL
  ) dupes
  WHERE rn > 1
);

-- Step 4: Remove duplicate atomic_seat_horse overload (if both exist).
-- The Supabase schema has TWO versions with identical params in different order,
-- causing "Could not choose the best candidate function" 300 errors.
-- Drop the older one if it exists (safe — only drops if overloaded).
-- NOTE: Run this manually if the migration runner doesn't support DO blocks:
DO $$
DECLARE
  overload_count integer;
BEGIN
  SELECT COUNT(*) INTO overload_count
  FROM pg_proc
  WHERE proname = 'atomic_seat_horse'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF overload_count > 1 THEN
    -- Drop one of the duplicates (the one with different param order)
    -- Keep the version matching: (p_table_id, p_horse_id, p_seat_number, p_buy_in, p_table_name)
    DROP FUNCTION IF EXISTS public.atomic_seat_horse(uuid, uuid, text, integer, numeric);
    RAISE NOTICE 'Dropped duplicate atomic_seat_horse overload';
  END IF;
END $$;
