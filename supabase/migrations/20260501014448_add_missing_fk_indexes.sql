-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260501014448 as "add_missing_fk_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- Add covering indexes for foreign keys flagged by the perf advisor.
-- Without these:
--   - cascading deletes on the referenced table do a seq-scan on this one
--   - joins/lookups by the FK column are slow even on small tables
--
-- Three tables affected (all are user-data, scan patterns 100% match the
-- FK column lookup):

CREATE INDEX IF NOT EXISTS idx_live_streams_feed_post_id
    ON public.live_streams (feed_post_id)
    WHERE feed_post_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_picture_history_user_id
    ON public.profile_picture_history (user_id);

CREATE INDEX IF NOT EXISTS idx_social_media_library_user_id
    ON public.social_media_library (user_id);
