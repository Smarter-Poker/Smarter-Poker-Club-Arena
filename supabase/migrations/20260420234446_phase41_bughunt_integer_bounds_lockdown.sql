-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420234446 "phase41_bughunt_integer_bounds_lockdown"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 73679c3e4468b9e260225bd0ca709042 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Pass 42: Integer-bounds lockdown (4 CVE-class findings BF-1..BF-4)
--
-- BUGS:
--   BF-1 (commander_home_games.guest_limit):
--     NO constraint. Host can set guest_limit = INT_MAX (2147483647) or
--     negative. Negative values confuse guest-enforcement logic (e.g.,
--     "guest count must be < -1000000"), and INT_MAX allows unbounded
--     guests. Phase 41 spec: one guest per member per table.
--
--   BF-2 (commander_home_game_tables.buyin_min):
--     No nonneg CHECK (only min<=max). Host can set buyin_min=-500, which
--     corrupts displayed stakes and breaks downstream buyin-range filters.
--
--   BF-3 (commander_home_game_tables.buyin_max):
--     Same as BF-2 — no nonneg enforcement.
--
--   BF-4 (commander_home_game_tables.table_number):
--     No upper bound. Host can set table_number = INT_MAX, which
--     breaks client-side table ordering/rendering and confuses admin
--     tools. Reasonable bound: 1..100 tables per game (matches
--     max_players/max_seats domain).
--
-- FIX:
--   Add CHECK constraints with sensible bounds. Matches existing style
--   (nullable columns allow NULL; otherwise require in-range value).
-- =====================================================================

-- BF-1: guest_limit bounds 0..10 (business rule: default 1, max reasonable 10)
ALTER TABLE public.commander_home_games
  ADD CONSTRAINT chk_home_games_guest_limit
    CHECK (guest_limit IS NULL OR (guest_limit >= 0 AND guest_limit <= 10));

-- BF-2: buyin_min nonneg on game_tables
ALTER TABLE public.commander_home_game_tables
  ADD CONSTRAINT chk_home_game_tables_buyin_min_nonneg
    CHECK (buyin_min IS NULL OR buyin_min >= 0);

-- BF-3: buyin_max nonneg on game_tables
ALTER TABLE public.commander_home_game_tables
  ADD CONSTRAINT chk_home_game_tables_buyin_max_nonneg
    CHECK (buyin_max IS NULL OR buyin_max >= 0);

-- BF-4: table_number 1..100
ALTER TABLE public.commander_home_game_tables
  ADD CONSTRAINT chk_home_game_tables_table_number
    CHECK (table_number >= 1 AND table_number <= 100);
