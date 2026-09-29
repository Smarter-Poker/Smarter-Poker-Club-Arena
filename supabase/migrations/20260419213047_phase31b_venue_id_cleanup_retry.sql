-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419213047 "phase31b_venue_id_cleanup_retry"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9d0f0d99eefd825af8e7d8b00a315f49 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Delete orphan venue_checkins (point at non-existent venues)
DELETE FROM venue_checkins vc
 WHERE NOT EXISTS(SELECT 1 FROM poker_venues v WHERE v.id = vc.venue_id::integer);

-- Now convert venue_checkins.venue_id TEXT → INTEGER
ALTER TABLE venue_checkins 
  ALTER COLUMN venue_id TYPE integer USING venue_id::integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_checkins_venue') THEN
    ALTER TABLE venue_checkins 
      ADD CONSTRAINT fk_venue_checkins_venue 
      FOREIGN KEY (venue_id) REFERENCES poker_venues(id) ON DELETE CASCADE;
  END IF;
END $$;

-- venue_reviews (empty)
ALTER TABLE venue_reviews 
  ALTER COLUMN venue_id TYPE integer USING venue_id::integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_reviews_venue') THEN
    ALTER TABLE venue_reviews 
      ADD CONSTRAINT fk_venue_reviews_venue 
      FOREIGN KEY (venue_id) REFERENCES poker_venues(id) ON DELETE CASCADE;
  END IF;
END $$;

-- live_games (empty, Club Arena — no FK to poker_venues)
ALTER TABLE live_games 
  ALTER COLUMN venue_id TYPE integer USING venue_id::integer;
