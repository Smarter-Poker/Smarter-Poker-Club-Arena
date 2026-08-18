-- Drop the dead per-table / per-club "time bank seconds" setting.
--
-- Owner decision 2026-08-18. A time bank is a flat 20-second grant, 2 per
-- street (Bible V8 s6.2) — there has been no per-table or per-club "seconds per
-- activation" for some time, and no engine code ever read these columns. Every
-- one of the 55,912 rows in tables and all 3 rows in clubs held the identical
-- default of 30, so nothing configured is being lost.
--
-- Two owner-facing numeric inputs (ClubSettingsPage, ClubDetailPage) wrote to
-- clubs.time_bank_seconds and did nothing at all. The single live consequence
-- was in TableService, where time_bank_enabled was DERIVED from the seconds
-- value — making 0 an undocumented off switch. That is an explicit boolean now.
--
-- Ordering matters: the code that selected tables.time_bank_seconds shipped in
-- Smarter-Poker-Club-Arena@6ff7db2e and is confirmed live on the engine
-- (/health reported version 6ff7db2e) BEFORE this migration runs, so no
-- running query can reference a column that no longer exists.

ALTER TABLE public.tables DROP COLUMN IF EXISTS time_bank_seconds;
ALTER TABLE public.clubs  DROP COLUMN IF EXISTS time_bank_seconds;
