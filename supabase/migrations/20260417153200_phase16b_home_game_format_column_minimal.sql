-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417153200 "phase16b_home_game_format_column_minimal"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4851dc15e5be445de6a7a5e3f114881c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 16B: HOME-GAME FORMAT (cash vs tournament)
-- ══════════════════════════════════════════════════════════════════════
--
--  Dan's spec: "IF A HOME GAME HAS TOURNAMENTS, THOSE TOURNAMENTS SHOULD
--  BE PICKED UP AND ADDED TO THE DAILY TOURNAMENTS PAGES."
--
--  PROBLEM: commander_home_games.game_type stores the poker VARIANT
--  (nlh, plo, omaha8, etc.) — NOT the format. All 7 existing home-game
--  rows have game_type='nlh'; one has "Tournament" in its title but no
--  schema flag distinguishes it from cash games.
--
--  FIX: add a `format` column, check-constrained to 'cash'/'tournament',
--  defaulting to 'cash' (the status-quo for ALL existing rows). Backfill
--  via title heuristic for the one existing row that's meant to be a
--  tournament ("Phase 4 Test — NLHE Tournament").
--
--  INDEX on (format, scheduled_date) so the Daily Tournaments API can
--  filter home-game tournaments by date without a seq scan.
--
--  MINIMALIST NOTE:  this migration does NOT touch poker_venues,
--  commander_games, commander_tables, or any Club Commander tool
--  table. Home groups stay in their own schema island. The Daily
--  Tournaments bridge lives at the API layer via UNION on
--  commander_home_games — no shadow rows, no cross-table FKs.
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE commander_home_games
    ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'cash'
    CHECK (format IN ('cash', 'tournament'));

CREATE INDEX IF NOT EXISTS idx_commander_home_games_format_date
    ON commander_home_games (format, scheduled_date)
    WHERE format = 'tournament';

-- Heuristic backfill
UPDATE commander_home_games
   SET format = 'tournament'
 WHERE format = 'cash'
   AND (
        title ILIKE '%tournament%'
     OR title ILIKE '%tourney%'
     OR title ILIKE '%freezeout%'
     OR title ILIKE '%freeze out%'
     OR title ILIKE '%MTT%'
   );

-- Results
SELECT format, COUNT(*) AS games
FROM commander_home_games
GROUP BY format
ORDER BY games DESC;
