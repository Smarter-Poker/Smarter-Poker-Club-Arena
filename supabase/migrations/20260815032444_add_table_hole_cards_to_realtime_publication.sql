-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815032444 "add_table_hole_cards_to_realtime_publication"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0bad705613758b8bd1a203ab0516071c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Live E2E 2026-08-15: the client's secure hole-card channel
-- (table-cards-secure-<table>-<user>, postgres_changes on table_hole_cards)
-- has been failing with CHANNEL_ERROR on every table page load because
-- table_hole_cards was never added to the supabase_realtime publication.
-- RLS is enabled with "Users can read own hole cards" (auth.uid() = user_id),
-- so publishing the table only ever streams a player their OWN cards.
-- REPLICA IDENTITY FULL so the engine's upsert path (INSERT ... ON CONFLICT
-- DO UPDATE, used by hole-card re-push on reconnect) delivers full rows on
-- UPDATE events.

ALTER TABLE public.table_hole_cards REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.table_hole_cards;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'table_hole_cards'
  ) THEN
    RAISE EXCEPTION 'table_hole_cards did not land in supabase_realtime publication';
  END IF;
END $$;
