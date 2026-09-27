-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423230236 "20260421070000_bug14_home_games_unique_group_date"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 56c6b8012aea986d802c6d3ae9e1542f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-14 (MED — TOCTOU on game creation)
--
-- Three RPCs (clone_home_game, create_home_game_from_template,
-- fn_generate_recurring_home_games) plus the primary user-facing create
-- route (pages/api/commander/home-games/events/index.js POST) can all
-- create a commander_home_games row for a (group_id, scheduled_date)
-- pair without a holding lock on the group. Two concurrent calls
-- (including the trivial "user double-clicks Create Game") therefore race:
-- both pass the EXISTS-based duplicate check and both INSERT, leaving
-- the group with two non-cancelled games on the same date. The primary
-- create route in events/index.js doesn't even do the EXISTS check;
-- it's entirely unguarded.
--
-- Fix: partial unique index on (group_id, scheduled_date) WHERE status
-- <> 'cancelled'. This turns the RPC "DATE_ALREADY_SCHEDULED" check
-- into a hard DB-level guarantee and also catches the events/index.js
-- path for free — a double-click gets a 23505 instead of two rows.
--
-- Verified zero existing duplicates in prod before shipping.

CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_home_games_one_active_per_group_per_date
  ON public.commander_home_games (group_id, scheduled_date)
  WHERE status <> 'cancelled';
