-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260426014027 "20260426090000_hg_grandfather_existing_users_onboarded"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 119fa92d7696612ca92d00f3b8923a5b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LAUNCH-CRITICAL BUG FIX: existing HG users blocked from all writes.
--
-- Phase 17 added fn_hg_require_onboarded_on_write trigger that raises
-- ONBOARDING_REQUIRED unless profiles.home_games_onboarded_at IS NOT NULL.
-- Audit shows EVERY user in commander_home_members (incl. Dan, the founder
-- and SatNight owner) has this column null.
--
-- Effect: nobody can post, comment, RSVP, like, schedule games, etc. The
-- trigger fires AFTER the user has already joined the group, so existing
-- members are silently locked out from interacting.
--
-- Grandfather strategy: anyone who already has HG activity is treated as
-- onboarded. Specifically, set home_games_onboarded_at = NOW() for any
-- user who:
--   - Owns a home group, OR
--   - Is an approved member of any home group, OR
--   - Has authored any HG post/comment, OR
--   - Has RSVP'd to any HG game, OR
--   - Has hosted any HG game, OR
--   - Has uploaded a HG photo, OR
--   - Has reviewed an HG game
--
-- New users still go through the welcome flow. Idempotent: only sets
-- the column if currently null.

UPDATE public.profiles p
   SET home_games_onboarded_at = NOW()
 WHERE p.home_games_onboarded_at IS NULL
   AND p.id IN (
     SELECT owner_id FROM public.commander_home_groups
     UNION
     SELECT user_id FROM public.commander_home_members WHERE status = 'approved'
     UNION
     SELECT author_id FROM public.commander_home_posts
     UNION
     SELECT author_id FROM public.commander_home_post_comments
     UNION
     SELECT user_id FROM public.commander_home_rsvps
     UNION
     SELECT host_id FROM public.commander_home_games
     UNION
     SELECT uploader_id FROM public.commander_home_game_photos
     UNION
     SELECT reviewer_id FROM public.commander_home_game_reviews
   );
