-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429004924 "drop_dead_social_media_policies_20260428"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 599258694c1405b6736645958f21aab5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Drop two dead RLS policies on storage.objects that reference a non-existent bucket.
-- The actual bucket id is 'social-media' (HYPHEN). These two policies referenced
-- 'social_media' (UNDERSCORE), so they never matched any row. Active bucket-specific
-- policies (social_media_upload_own, social_media_public_read, social_media_delete_own)
-- handle the real bucket. See .memory/problems/2026-04-28-video-upload-jws.md.
DROP POLICY IF EXISTS "social_media_insert" ON storage.objects;
DROP POLICY IF EXISTS "social_media_select" ON storage.objects;
