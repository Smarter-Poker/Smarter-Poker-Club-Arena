-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820173421 "commander_tournament_structural_integrity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5d482067223b2e1fcf2b5e462df3c1cd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Structural Integrity For Tournament Seating And Results
--
-- The races are closed in code (commander_claim_open_seat,
-- commander_claim_finish_position) and the historic corruption is repaired
-- (53 duplicate seats, 61 duplicate finish positions). These indexes make the
-- invariants structural so no future code path, migration, manual SQL fix or
-- third-party script can reintroduce them.
--
-- PARTIAL on purpose:
--   * seats: only live statuses occupy a chair. Eliminated, cancelled, winner,
--     cashed and bagged players legitimately share NULL seats or historic ones.
--   * finish positions: only non-null positions must be unique per tournament.
--
-- Pre-flight aborts rather than half-applying if anything is still dirty.

DO $$
DECLARE
  v_seat_dups integer;
  v_pos_dups integer;
BEGIN
  SELECT count(*) INTO v_seat_dups
  FROM commander_tournament_entries a
  JOIN commander_tournament_entries b
    ON a.tournament_id = b.tournament_id
   AND a.table_number = b.table_number
   AND a.seat_number = b.seat_number
   AND a.id < b.id
  WHERE a.status IN ('registered','seated','active')
    AND b.status IN ('registered','seated','active');

  SELECT count(*) INTO v_pos_dups
  FROM commander_tournament_entries a
  JOIN commander_tournament_entries b
    ON a.tournament_id = b.tournament_id
   AND a.finish_position = b.finish_position
   AND a.id < b.id
  WHERE a.finish_position IS NOT NULL;

  IF v_seat_dups > 0 THEN
    RAISE EXCEPTION 'refusing to add seat uniqueness: % duplicate live seats remain', v_seat_dups;
  END IF;
  IF v_pos_dups > 0 THEN
    RAISE EXCEPTION 'refusing to add finish uniqueness: % duplicate finish positions remain', v_pos_dups;
  END IF;
END $$;

-- One live player per chair.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_entries_live_seat
  ON public.commander_tournament_entries (tournament_id, table_number, seat_number)
  WHERE status IN ('registered','seated','active')
    AND table_number IS NOT NULL
    AND seat_number IS NOT NULL;

-- One player per finishing place.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_entries_finish_position
  ON public.commander_tournament_entries (tournament_id, finish_position)
  WHERE finish_position IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_commander_entries_live_seat') THEN
    RAISE EXCEPTION 'uq_commander_entries_live_seat not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_commander_entries_finish_position') THEN
    RAISE EXCEPTION 'uq_commander_entries_finish_position not created';
  END IF;
END $$;

-- ROLLBACK:
-- DROP INDEX IF EXISTS public.uq_commander_entries_live_seat;
-- DROP INDEX IF EXISTS public.uq_commander_entries_finish_position;
