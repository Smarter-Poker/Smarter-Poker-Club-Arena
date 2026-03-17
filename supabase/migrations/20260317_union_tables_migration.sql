-- ═══════════════════════════════════════════════════════════════════════════════
-- UNION-ONLY TABLE ARCHITECTURE MIGRATION
-- ═══════════════════════════════════════════════════════════════════════════════
-- Rule: If a club is part of a union, tables use union_id NOT club_id.
--       club_id is ONLY used if a club is standalone (not attached to a union).
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Add union_id column to tables
ALTER TABLE tables ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tables_union ON tables(union_id);

-- Step 2: Make club_id nullable (union tables don't need it)
ALTER TABLE tables ALTER COLUMN club_id DROP NOT NULL;

-- Step 3: Create Midway Union in the unions table
-- Using the same owner_id as the Midway Union club entry
INSERT INTO unions (id, name, description, owner_id, settings)
SELECT 
  'fade0000-0000-0000-0000-u00000000001'::uuid,
  'Midway Union',
  'The central union connecting Shark Club and Club JAQK',
  owner_id,
  '{"revenue_share_percent": 10, "shared_player_pool": true, "cross_club_tournaments": true}'::jsonb
FROM clubs WHERE id = 'fade0000-0000-0000-0000-000000000001'
ON CONFLICT DO NOTHING;

-- Step 4: Link Shark Club and Club JAQK to Midway Union
INSERT INTO union_clubs (union_id, club_id) VALUES
  ('fade0000-0000-0000-0000-u00000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'),  -- SHARK CLUB
  ('fade0000-0000-0000-0000-u00000000001', 'a0000000-0000-0000-0000-000000000001')   -- Club JAQK
ON CONFLICT DO NOTHING;

-- Step 5: Delete ALL existing tables from Club JAQK and SHARK CLUB
-- (User directive: kill all existing tables, recreate under union)
DELETE FROM table_seats WHERE table_id IN (
  SELECT id FROM tables WHERE club_id IN (
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
    'a0000000-0000-0000-0000-000000000001'
  )
);

DELETE FROM tables WHERE club_id IN (
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  'a0000000-0000-0000-0000-000000000001'
);

-- Step 6: Create tables under Midway Union (union_id, NO club_id)
-- ─── NLH Tables ────────────────────────────────────────────────────────────
INSERT INTO tables (id, union_id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, status) VALUES
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH Micro 0.10/0.20', 'cash', 'nlh', '0.1/0.2', 0.10, 0.20, 8.00, 40.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 0.25/0.50', 'cash', 'nlh', '0.25/0.5', 0.25, 0.50, 20.00, 100.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 0.50/1.00', 'cash', 'nlh', '0.5/1', 0.50, 1.00, 40.00, 200.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 1.00/2.00', 'cash', 'nlh', '1/2', 1.00, 2.00, 80.00, 400.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 2.00/5.00', 'cash', 'nlh', '2/5', 2.00, 5.00, 200.00, 1000.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 5.00/10.00', 'cash', 'nlh', '5/10', 5.00, 10.00, 400.00, 2000.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 6-Max 0.10/0.20', 'cash', 'nlh', '0.1/0.2', 0.10, 0.20, 8.00, 40.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 6-Max 0.50/1.00', 'cash', 'nlh', '0.5/1', 0.50, 1.00, 40.00, 200.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'NLH 6-Max 1.00/2.00', 'cash', 'nlh', '1/2', 1.00, 2.00, 80.00, 400.00, 6, 'waiting');

-- ─── PLO4 Tables ───────────────────────────────────────────────────────────
INSERT INTO tables (id, union_id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, status) VALUES
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 0.10/0.20', 'cash', 'plo4', '0.1/0.2', 0.10, 0.20, 8.00, 40.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 0.25/0.50', 'cash', 'plo4', '0.25/0.5', 0.25, 0.50, 20.00, 100.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 0.50/1.00', 'cash', 'plo4', '0.5/1', 0.50, 1.00, 40.00, 200.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 1.00/2.00', 'cash', 'plo4', '1/2', 1.00, 2.00, 80.00, 400.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 2.00/5.00', 'cash', 'plo4', '2/5', 2.00, 5.00, 200.00, 1000.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO4 5.00/10.00', 'cash', 'plo4', '5/10', 5.00, 10.00, 400.00, 2000.00, 6, 'waiting');

-- ─── PLO5 Tables ───────────────────────────────────────────────────────────
INSERT INTO tables (id, union_id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, status) VALUES
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO5 0.25/0.50', 'cash', 'plo5', '0.25/0.5', 0.25, 0.50, 20.00, 100.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO5 0.50/1.00', 'cash', 'plo5', '0.5/1', 0.50, 1.00, 40.00, 200.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO5 1.00/2.00', 'cash', 'plo5', '1/2', 1.00, 2.00, 80.00, 400.00, 6, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO5 2.00/5.00', 'cash', 'plo5', '2/5', 2.00, 5.00, 200.00, 1000.00, 6, 'waiting');

-- ─── PLO8 Tables ───────────────────────────────────────────────────────────
INSERT INTO tables (id, union_id, club_id, name, game_type, game_variant, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, status) VALUES
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO8 0.25/0.50', 'cash', 'plo8', '0.25/0.5', 0.25, 0.50, 20.00, 100.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO8 0.50/1.00', 'cash', 'plo8', '0.5/1', 0.50, 1.00, 40.00, 200.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO8 1.00/2.00', 'cash', 'plo8', '1/2', 1.00, 2.00, 80.00, 400.00, 9, 'waiting'),
  (gen_random_uuid(), 'fade0000-0000-0000-0000-u00000000001', NULL, 'PLO8 2.00/5.00', 'cash', 'plo8', '2/5', 2.00, 5.00, 200.00, 1000.00, 6, 'waiting');

-- Step 7: Add RLS policy for union-based table visibility
CREATE POLICY "Members can view union tables" ON tables
  FOR SELECT USING (
    union_id IN (
      SELECT uc.union_id FROM union_clubs uc
      JOIN club_members cm ON cm.club_id = uc.club_id
      WHERE cm.user_id = auth.uid()
    )
  );

-- Step 8: Verify
DO $$
DECLARE
  v_union_count INTEGER;
  v_table_count INTEGER;
  v_club_link_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_union_count FROM unions WHERE name = 'Midway Union';
  SELECT COUNT(*) INTO v_table_count FROM tables WHERE union_id = 'fade0000-0000-0000-0000-u00000000001';
  SELECT COUNT(*) INTO v_club_link_count FROM union_clubs WHERE union_id = 'fade0000-0000-0000-0000-u00000000001';
  
  RAISE NOTICE '═══ MIGRATION RESULTS ═══';
  RAISE NOTICE 'Union rows: %', v_union_count;
  RAISE NOTICE 'Union tables: %', v_table_count;
  RAISE NOTICE 'Linked clubs: %', v_club_link_count;
END $$;
