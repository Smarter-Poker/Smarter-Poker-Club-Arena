-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825195528; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Move Club Arena preset avatar URLs from avatar_url → arena_avatar_url
-- Affected rows: any profile where avatar_url looks like a CA preset path
-- Pattern: /avatars/free/*, /avatars/vip/*, /avatars/table/*
UPDATE public.profiles
SET
  arena_avatar_url = COALESCE(arena_avatar_url, avatar_url),
  avatar_url       = NULL
WHERE
  avatar_url IS NOT NULL
  AND (
    avatar_url LIKE '/avatars/free/%'
    OR avatar_url LIKE '/avatars/vip/%'
    OR avatar_url LIKE '/avatars/table/%'
    OR avatar_url LIKE '%/social-media/avatars/free_%'
    OR avatar_url LIKE '%/social-media/avatars/vip_%'
  );
