-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901165751; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- deep_stack_green_light_the_horses
--
-- Dan, 2026-09-01: "ONCE THATS SET TO ZERO YOU CAN GREEN LIGHT THE HORSES
-- TO START PLAYING."
--
-- The zero state was verified this minute: BBJ 0/0/0, rake wallet and
-- counters 0, spin pool at its exact 20,000 seed, rake/settlement history
-- cleared, every horse at exactly 10,000, agent banks 3,340,000, bank
-- 2,479,213.44, unpaid-settlement queue empty.
--
-- This releases all 416 Deep Stack horses through the bench latch
-- (a_benched_horse_stays_benched requires app.horse_release for its
-- transaction). The engine's fleet, spin board, SNG board and tournament
-- registration pick them up on their normal ticks — club-scoped by the
-- entry gate and the deployed #2438/#2465 code.
-- =============================================================================
DO $$
DECLARE v_released int; v_avail int;
BEGIN
  PERFORM set_config('app.horse_release', 'on', true);

  UPDATE profiles SET horse_status = 'available'
   WHERE id IN (SELECT user_id FROM club_members
                 WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' AND is_bot)
     AND horse_status = 'disabled';
  GET DIAGNOSTICS v_released = ROW_COUNT;

  PERFORM set_config('app.horse_release', '', true);

  SELECT count(*) INTO v_avail FROM profiles
   WHERE id IN (SELECT user_id FROM club_members
                 WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' AND is_bot)
     AND horse_status = 'available';

  IF v_avail <> 416 THEN
    RAISE EXCEPTION 'released % of 416 (available=%)', v_released, v_avail;
  END IF;
END $$;
