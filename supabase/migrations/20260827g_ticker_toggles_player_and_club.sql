-- ═══════════════════════════════════════════════════════════════════════════
-- TICKER ON/OFF — the player's switch and the club's switch
-- Dan 2026-08-27, mobile round 3, item 6:
--   "the ticker at the top should be able to turn on or off in the table
--    settings and in the club settings."
-- ═══════════════════════════════════════════════════════════════════════════
--
-- TWO SWITCHES, NOT ONE, because they answer different questions:
--
--   user_table_settings.show_ticker   "I do not want to see it."
--   clubs.ticker_enabled              "My club does not announce this way."
--
-- They compose as AND: the strip is drawn only when the viewer wants it AND
-- the club it would be speaking for allows it. Either side can silence it, and
-- neither can force it on the other.
--
-- BOTH DEFAULT TRUE, which is exactly today's behaviour, so applying this
-- migration changes nothing for anybody until somebody flips a switch. That
-- also matters for `user_table_settings`: the client mirrors these column
-- defaults in DEFAULT_USER_TABLE_SETTINGS, and a client default that disagrees
-- with the column both lies to the user before their row loads and silently
-- rewrites their other settings on the first per-key upsert (the history is in
-- tests/user-table-settings-defaults.test.ts). The DB is the source of truth;
-- this file is what the client is then made to match.
--
-- TIER 1 — additive, two nullable-free boolean columns with defaults, no
-- existing data read or rewritten, no RLS/grant/policy change, no function or
-- view touched.
--
-- ROLLBACK:
--   ALTER TABLE user_table_settings DROP COLUMN IF EXISTS show_ticker;
--   ALTER TABLE clubs DROP COLUMN IF EXISTS ticker_enabled;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS show_ticker boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_table_settings.show_ticker IS
  'Player switch for the top announcement ticker (TournamentStartingTicker). '
  'TRUE = show. Composed with clubs.ticker_enabled as AND.';

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS ticker_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.clubs.ticker_enabled IS
  'Club switch for the top announcement ticker. FALSE suppresses this club''s '
  'starting-soon and overlay announcements for every member. Composed with '
  'user_table_settings.show_ticker as AND.';

-- POST-APPLY ASSERTIONS. A migration that cannot prove its own effect is a
-- migration somebody has to go and check by hand.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_table_settings'
      AND column_name = 'show_ticker'
      AND is_nullable = 'NO'
      AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION
      'user_table_settings.show_ticker is missing, nullable, or not defaulted true';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clubs'
      AND column_name = 'ticker_enabled'
      AND is_nullable = 'NO'
      AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION
      'clubs.ticker_enabled is missing, nullable, or not defaulted true';
  END IF;
END $$;
