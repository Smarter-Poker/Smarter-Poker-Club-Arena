-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827220529; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TICKER ON/OFF — the player's switch and the club's switch
-- Dan 2026-08-27, mobile round 3, item 6: "the ticker at the top should be able
-- to turn on or off in the table settings and in the club settings."
--
-- TWO SWITCHES, composed as AND:
--   user_table_settings.show_ticker   "I do not want to see it."
--   clubs.ticker_enabled              "My club does not announce this way."
--
-- BOTH DEFAULT TRUE = today's behaviour, so this changes nothing until somebody
-- flips a switch. The client mirrors these column defaults in
-- DEFAULT_USER_TABLE_SETTINGS; a disagreement there both lies to the user before
-- their row loads and silently rewrites their other settings on the first
-- per-key upsert (see tests/user-table-settings-defaults.test.ts).
--
-- TIER 1 — additive, no existing data read or rewritten, no RLS/grant/policy
-- change, no function or view touched.
--
-- ROLLBACK:
--   ALTER TABLE user_table_settings DROP COLUMN IF EXISTS show_ticker;
--   ALTER TABLE clubs DROP COLUMN IF EXISTS ticker_enabled;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS show_ticker boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_table_settings.show_ticker IS
  'Player switch for the top announcement ticker (TournamentStartingTicker). TRUE = show. Composed with clubs.ticker_enabled as AND.';

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS ticker_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.clubs.ticker_enabled IS
  'Club switch for the top announcement ticker. FALSE suppresses this club''s starting-soon and overlay announcements for every member. Composed with user_table_settings.show_ticker as AND.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_table_settings'
      AND column_name = 'show_ticker' AND is_nullable = 'NO' AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'user_table_settings.show_ticker is missing, nullable, or not defaulted true';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clubs'
      AND column_name = 'ticker_enabled' AND is_nullable = 'NO' AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'clubs.ticker_enabled is missing, nullable, or not defaulted true';
  END IF;
END $$;
