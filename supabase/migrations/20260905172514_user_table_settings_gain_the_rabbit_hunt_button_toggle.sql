-- 20260905172514_user_table_settings_gain_the_rabbit_hunt_button_toggle.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-09-05: "IT NEEDS A DISABLE OR HIDE OPTION IN THE TABLE SETTINGS FOR
-- USERS THAT DON'T WANT IT POPPING UP." The Rabbit Hunt button appears in the
-- bottom-left HUD slot for a beat at the end of every hand; some players read
-- that as a paid feature nagging them. This column is the opt-out.
--
-- DEFAULT TRUE. The switch hides an offer the player already had, so an
-- existing row that predates the column must behave exactly as it did
-- yesterday. Backfilling to true (rather than leaving NULL and relying on the
-- client's ?? fallback) means the database and the client agree without either
-- having to know about the other's default.
--
-- WHAT IT DOES NOT DO: it does not shorten the post-hand pause. That pause is
-- HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS, it is served by the engine to the
-- whole table, and a per-player setting that changed it would both alter
-- everybody else's pace and - because the pause would then happen only
-- sometimes - tell the table that the deck still had cards in it
-- (CLAUDE.md 10.5: timing is part of the treatment).
--
-- ONE transaction: every DDL statement fires Supabase's schema-cache reload,
-- ~28s on this database, and loose statements mean one reload each.

BEGIN;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS rabbit_hunt_button boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_table_settings.rabbit_hunt_button IS
  'Show the Rabbit Hunt button in the table HUD after a hand ends (Dan 2026-09-05). '
  'Hides the button only; the post-hand pause it lives in is table rhythm and is unchanged.';

COMMIT;
