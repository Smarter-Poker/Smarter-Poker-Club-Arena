-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421052523 "20260421060000_bug9_add_missing_profile_preferences_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4c23fcc0168b4a1d00efdeb5f99a33e2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-9 (HIGH — every settings toggle returns 500 in prod)
--
-- Five RPCs write to five profiles.*_preferences jsonb columns that do
-- not exist on the profiles table, and the client code reads from the
-- same five missing columns. plpgsql_check flagged the write paths:
--
--   update_hub_preferences        -> SET hub_preferences        (42703)
--   update_friend_preferences     -> SET friend_preferences     (42703)
--   update_store_preferences      -> SET store_preferences      (42703)
--   update_messenger_preferences  -> SET messenger_preferences  (42703)
--   update_reels_preferences      -> SET reels_preferences      (42703)
--
-- Client callsites:
--   src/state/userPreferences.ts        — sets hub_preferences (hiddenCardIds)
--   src/services/preferences-service.js — sets friend/store/messenger/reels
-- The matching .select('hub_preferences').eq('id', ...) reads in
-- userPreferences.ts also 400 because PostgREST rejects unknown columns.
--
-- The singular profiles.preferences jsonb column exists but is unused
-- by any code (zero reads across pages/, lib/, src/). Fix path of least
-- surprise: add the 5 columns the code expects, each defaulting to
-- empty jsonb. RPC bodies and reads start working immediately with no
-- code changes.
--
-- (Note: client has try/catch around the two with `throw error` —
-- friend and store — so users see a toast/error. update_hub and the
-- two already-disabled-in-client messenger/reels just log to console
-- and silently fail. Either way the sync never worked.)

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hub_preferences        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS friend_preferences     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS store_preferences      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS messenger_preferences  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reels_preferences      jsonb NOT NULL DEFAULT '{}'::jsonb;
