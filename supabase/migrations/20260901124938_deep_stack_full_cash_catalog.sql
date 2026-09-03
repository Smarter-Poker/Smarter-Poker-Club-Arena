-- =============================================================================
-- deep_stack_full_cash_catalog
-- Applied to production via Supabase MCP 2026-09-01 12:49 UTC.
--
-- Dan, 2026-09-01: "MAKE SURE YOU CREATE ALL THE CASH GAMES ... JUST DON'T
-- ALLOW THE HORSES TO PLAY UNTIL I'VE VERIFIED AND GIVEN THE GREEN LIGHT."
--
-- Deep Stack Society (standalone, club 11192) had 3 cash tables. This seeds
-- the full catalog: the platform's 8 cash families at the stake ladder the
-- Midway floor actually runs, one table per family x stake, club-scoped,
-- union_id NULL. Buy-ins are the platform rule: 40bb min, 200bb max.
-- Seat law per server/src/config/tableSeating.ts: nlh/flh 9, plo4 8, plo5 7,
-- plo6 6, plo8 8, short_deck 8, pineapple 8. Two dedicated straddle NLH
-- tables give the V18 straddle brain live traffic once horses are released.
--
-- Idempotent: a (club, name) that already exists non-deleted is skipped.
-- Two grid names collide with pre-existing tables (NLH 1/2, PLO4 0.05/0.10)
-- and are skipped; FLH 10/20 also pre-exists outside the grid. 67 new + 3
-- existing = 70 cash tables.
-- Horses stay benched (all 416 horse_status='disabled', latched), so these
-- open as empty 'waiting' tables until Dan's green light.
-- Defaults copied from the club's own healthy 'NLH 1/2' prototype row.
-- =============================================================================
DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_proto tables%ROWTYPE;
  v_defined int; v_inserted int; v_total int;
BEGIN
  SELECT * INTO v_proto FROM tables
   WHERE club_id=v_club AND name='NLH 1/2' AND coalesce(is_deleted,false)=false
   LIMIT 1;
  IF v_proto.id IS NULL THEN
    RAISE EXCEPTION 'prototype table NLH 1/2 not found for Deep Stack';
  END IF;

  CREATE TEMP TABLE dss_grid (
    name text, variant text, stakes text,
    sb numeric, bb numeric, seats int, straddle boolean
  ) ON COMMIT DROP;

  INSERT INTO dss_grid
  SELECT fam.label || ' ' || st.stakes,
         fam.variant, st.stakes, st.sb, st.bb, fam.seats, false
    FROM (VALUES
      ('NLH','nlh',9), ('FLH','flh',9), ('PLO4','plo4',8), ('PLO5','plo5',7),
      ('PLO6','plo6',6), ('PLO8','plo8',8), ('Short Deck','short_deck',8),
      ('Pineapple','pineapple',8)
    ) fam(label, variant, seats)
    CROSS JOIN (VALUES
      ('0.05/0.10', 0.05, 0.10), ('0.25/0.50', 0.25, 0.50),
      ('0.50/1', 0.50, 1.00), ('1/2', 1.00, 2.00), ('2/5', 2.00, 5.00),
      ('5/10', 5.00, 10.00), ('10/25', 10.00, 25.00), ('25/50', 25.00, 50.00)
    ) st(stakes, sb, bb);

  INSERT INTO dss_grid VALUES
    ('NLH 0.10/0.20','nlh','0.10/0.20',0.10,0.20,9,false),
    ('NLH 2/4','nlh','2/4',2.00,4.00,9,false),
    ('NLH 3/6','nlh','3/6',3.00,6.00,9,false),
    ('NLH Straddle 1/2','nlh','1/2',1.00,2.00,9,true),
    ('NLH Straddle 2/5','nlh','2/5',2.00,5.00,9,true);

  SELECT count(*) INTO v_defined FROM dss_grid;
  IF v_defined <> 69 THEN
    RAISE EXCEPTION 'grid defines % tables, expected 69', v_defined;
  END IF;

  INSERT INTO tables (
    club_id, union_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in, max_players,
    status, is_private, settings,
    rake_percent, rake_cap_bb, action_time_seconds, auto_create_table,
    straddle_enabled, enable_straddle, allow_straddle,
    run_it_twice_enabled, allow_run_it_twice, run_it_twice, auto_muck,
    time_bank_enabled, ante, ante_enabled, is_template
  )
  SELECT v_club, NULL, g.name, 'cash', g.variant, g.stakes,
         g.sb, g.bb, g.bb*40, g.bb*200, g.seats,
         'waiting', false, coalesce(v_proto.settings,'{}'::jsonb),
         v_proto.rake_percent, v_proto.rake_cap_bb,
         v_proto.action_time_seconds, false,
         g.straddle, true, true,
         v_proto.run_it_twice_enabled, v_proto.allow_run_it_twice,
         v_proto.run_it_twice, v_proto.auto_muck,
         v_proto.time_bank_enabled, 0, false, false
    FROM dss_grid g
   WHERE NOT EXISTS (
     SELECT 1 FROM tables t
      WHERE t.club_id=v_club AND t.name=g.name
        AND coalesce(t.is_deleted,false)=false);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT count(*) INTO v_total FROM tables
   WHERE club_id=v_club AND tournament_id IS NULL
     AND coalesce(is_deleted,false)=false;

  IF v_inserted <> 67 OR v_total <> 70 THEN
    RAISE EXCEPTION 'catalog wrong: inserted=% (expected 67), total=% (expected 70)', v_inserted, v_total;
  END IF;

  -- seat law spot check
  IF EXISTS (SELECT 1 FROM tables WHERE club_id=v_club AND game_variant='plo5'
              AND coalesce(is_deleted,false)=false AND max_players > 7)
     OR EXISTS (SELECT 1 FROM tables WHERE club_id=v_club AND game_variant='plo6'
              AND coalesce(is_deleted,false)=false AND max_players > 6) THEN
    RAISE EXCEPTION 'seat law violated in seeded catalog';
  END IF;
END $$;
