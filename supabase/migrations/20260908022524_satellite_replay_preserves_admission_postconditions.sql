-- Forward-only verification of the installed satellite replay correction.
-- Preserve the existing admission postconditions without rewriting an applied migration.
BEGIN;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_award_satellite_seat' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'FUNCTION public.fn_award_satellite_seat is missing';
  END IF;
  -- the seat gate agrees with the TS gate: a RUNNING target in late reg is open
  IF v_src NOT LIKE '%RUNNING%' OR v_src NOT LIKE '%late_reg_levels%' OR v_src NOT LIKE '%rebuy_levels%' THEN
    RAISE EXCEPTION 'the seat gate no longer reads RUNNING / late_reg_levels / rebuy_levels';
  END IF;
  -- it closes AT the cap, not one level past it
  IF v_src NOT LIKE '%COALESCE(v_t.current_level, 0) >= v_cap%' THEN
    RAISE EXCEPTION 'the level guard is not >= after the rewrite';
  END IF;
  IF v_src LIKE '%COALESCE(v_t.current_level, 0) > v_cap%' THEN
    RAISE EXCEPTION 'the off-by-one level guard survived the rewrite';
  END IF;
  -- it refuses a finalized prize pool
  IF v_src NOT LIKE '%prize_pool_finalized%' OR v_src NOT LIKE '%target_pool_finalized%' THEN
    RAISE EXCEPTION 'the seat gate no longer refuses a finalized prize pool';
  END IF;
  -- it names who seated a deduped winner, and a cash entrant is not an unknown
  IF v_src NOT LIKE '%held_from_this_satellite%' OR v_src NOT LIKE '%source_satellite_id%' THEN
    RAISE EXCEPTION 'the award no longer names who seated a deduped winner';
  END IF;
  IF v_src NOT LIKE '%CASE WHEN NOT v_existing_q THEN false%' THEN
    RAISE EXCEPTION 'a cash entrant who wins a seat is an unknown again';
  END IF;
END $$;

COMMIT;
