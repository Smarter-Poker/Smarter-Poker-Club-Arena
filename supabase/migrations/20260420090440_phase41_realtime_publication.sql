-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090440 "phase41_realtime_publication"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f121b7e931dea06efb2e253d29f8546a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part F: publish both new tables on supabase_realtime so the UI
-- can subscribe to live seat-claim events for all viewers.

-- ALTER PUBLICATION ADD TABLE errors if already present; guard with a DO block.
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.commander_home_game_tables;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.commander_home_seat_reservations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- REPLICA IDENTITY FULL so UPDATE/DELETE payloads include the OLD row
-- (required for the UI to know which seat released without a round-trip).
ALTER TABLE public.commander_home_game_tables         REPLICA IDENTITY FULL;
ALTER TABLE public.commander_home_seat_reservations   REPLICA IDENTITY FULL;
