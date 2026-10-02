-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419222751 "phase36_remove_home_game_rewards_surface"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b57c0989899e9debcaae601c46bb7772 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PHASE 36: Remove home-game rewards surface
-- ============================================================================
-- Constraint: Smarter.Poker is NOT a money intermediary for home games.
-- Paying hosts a Stripe-purchased virtual currency (diamonds) or granting
-- badges/leaderboards for hosting home games creates regulatory exposure
-- as inducement/compensation for brokering gambling activity.
-- 
-- This migration removes the entire rewards surface tied to home games.
-- No diamond transactions exist with source='home_games' (verified) so
-- there is nothing to unwind financially.
-- ============================================================================

-- 1. Drop triggers first (must come before the functions they reference)
DROP TRIGGER IF EXISTS trg_award_badges_on_complete ON commander_home_games;
DROP TRIGGER IF EXISTS trg_grant_host_diamonds_on_complete ON commander_home_games;

-- 2. Drop trigger functions (now orphaned)
DROP FUNCTION IF EXISTS public.fn_award_badges_on_game_complete();
DROP FUNCTION IF EXISTS public.fn_grant_host_diamonds_on_complete();

-- 3. Drop business/read functions
DROP FUNCTION IF EXISTS public.award_home_games_badges(uuid);
DROP FUNCTION IF EXISTS public._award_home_badge_if_new(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.get_home_games_diamond_history(uuid, integer);
DROP FUNCTION IF EXISTS public.get_home_games_leaderboards(text, integer);
DROP FUNCTION IF EXISTS public.get_user_home_games_badges(uuid);

-- 4. Drop the badge storage table (7 seeded rows, all informational)
DROP TABLE IF EXISTS public.commander_home_user_badges CASCADE;
