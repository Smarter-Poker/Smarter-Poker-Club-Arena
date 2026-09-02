-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825195559; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Move AI-generated Club Arena avatar URLs from avatar_url → arena_avatar_url
-- These are custom-avatars/generated paths written by setActiveAvatar()
UPDATE public.profiles
SET
  arena_avatar_url = COALESCE(arena_avatar_url, avatar_url),
  avatar_url       = NULL
WHERE
  avatar_url IS NOT NULL
  AND (
    avatar_url LIKE '%custom-avatars/generated/%'
    OR avatar_url LIKE '%/custom-avatars/%'
  );
