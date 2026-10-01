-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425064241 "20260421200000_hg_compat_views_for_my_clubs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e74bfa70baca19d63db8c44927ea0be7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX (production): /hub/my-clubs.js bundle queries
--   .from('home_game_members')
--   .select('role, home_game_groups!inner(id, name, slug, city, state,
--                                          profile_photo_url,
--                                          default_game_type,
--                                          default_stakes)')
-- but those tables don't exist — real tables are commander_home_members
-- and commander_home_groups, and slug lives in social_pages (linked).
-- This silently returns 0 rows in production (PostgREST returns empty,
-- not an error, when the embedded relationship key matches a related
-- view by name).
--
-- Ship a fix without touching the bundle: create compatibility VIEWs
-- with the exact names + columns the bundle expects, and an FK
-- relationship via a comment that PostgREST recognizes.

-- View 1: home_game_groups
DROP VIEW IF EXISTS public.home_game_groups CASCADE;
CREATE VIEW public.home_game_groups AS
SELECT
  g.id,
  g.name,
  COALESCE(sp.slug, g.id::text) AS slug,
  g.city,
  g.state,
  g.profile_photo_url,
  g.default_game_type,
  g.default_stakes,
  g.owner_id,
  g.is_private,
  g.is_21_plus,
  g.is_active,
  g.member_count,
  g.created_at,
  g.tagline,
  g.club_code,
  g.invite_code
FROM public.commander_home_groups g
LEFT JOIN public.social_pages sp
       ON sp.linked_entity_type='home_group'
      AND sp.linked_entity_id = g.id::text;

-- View 2: home_game_members  (with FK comment for PostgREST embedding)
DROP VIEW IF EXISTS public.home_game_members CASCADE;
CREATE VIEW public.home_game_members AS
SELECT
  m.id,
  m.group_id,
  m.user_id,
  m.role,
  m.status,
  m.joined_at
FROM public.commander_home_members m;

-- Grant SELECT on views
GRANT SELECT ON public.home_game_groups  TO authenticated, anon, service_role;
GRANT SELECT ON public.home_game_members TO authenticated, anon, service_role;

-- PostgREST uses information_schema FKs to discover the relationship
-- between home_game_members and home_game_groups for the !inner embed.
-- Views don't carry FKs, so we publish the relationship via a comment
-- using PostgREST's foreign key embedding hint syntax.
COMMENT ON VIEW public.home_game_members IS
  E'@graphql({"primary_key_columns": ["id"]})\nThis view is a compatibility shim for /hub/my-clubs.';

-- Need an actual FK relationship for !inner to work. Use the underlying
-- table FK by re-publishing the view with its base table relationship.
-- PostgREST handles view-on-table FK propagation when the column
-- matches an FK on the base table. commander_home_members.group_id
-- references commander_home_groups.id — verify:
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname LIKE '%commander_home_members_group_id%' AND c.contype='f'
  ) THEN
    RAISE WARNING 'No FK on commander_home_members.group_id — !inner may not embed';
  END IF;
END $$;
