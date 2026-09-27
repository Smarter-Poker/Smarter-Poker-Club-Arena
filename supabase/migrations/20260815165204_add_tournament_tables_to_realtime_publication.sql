-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815165204 "add_tournament_tables_to_realtime_publication"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bdcaaa3612fc23c5d0e8e4f7d2219004 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- VISIBLE FIX 2026-08-15: "nothing updates without a refresh".
-- TournamentDetails subscribes to postgres_changes on `tournaments` (prize
-- pool, level, entrants) and `tournament_players` (standings, chip counts,
-- my-table assignment); TablePage subscribes to `tournament_players` for live
-- bounty heads; TournamentLobbyPage subscribes to `tournaments` for the card
-- list. NONE of those three tables were members of the supabase_realtime
-- publication, so every one of those subscriptions has been silently dead —
-- the client opens a channel, receives nothing, and the UI only ever reflects
-- whatever was true at mount.
--
-- REPLICA IDENTITY FULL is required so UPDATE events carry the old row (the
-- clients diff against it) rather than just the primary key.

ALTER TABLE public.tournaments          REPLICA IDENTITY FULL;
ALTER TABLE public.tournament_players   REPLICA IDENTITY FULL;
ALTER TABLE public.tournament_bounties  REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='tournaments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournaments;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='tournament_players') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_players;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='tournament_bounties') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_bounties;
  END IF;
END $$;

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['tournaments','tournament_players','tournament_bounties']) AS t
  WHERE NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname='supabase_realtime' AND tablename=t);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'still not published for realtime: %', v_missing;
  END IF;
END $$;
