-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417084543 "link_every_home_game_to_social_page"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2bee6b1b602c7b3be9fce374bd0b9098 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ════════════════════════════════════════════════════════════════════════════
-- EVERY home_group gets a social_page (public or private), and every
-- commander_home_games event gets social_page_id filled in.
--
-- Before today the trigger only fired when is_private=false AND is_active=true.
-- Private groups were silently skipped. That meant:
--   • 1 of 2 home_groups (the private one) had no social_page
--   • 3 of 7 home_games events had NULL social_page_id
--
-- New policy: EVERY group has a social_page record. Visibility is controlled by
-- social_pages.is_public (= is_active AND NOT is_private), not by existence.
-- Private groups therefore still have a page for internal member-only features,
-- but remain hidden from public discovery (the discover API filters is_public).
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Upgrade autocreate trigger — drop the is_private gate. Only skip if inactive.
CREATE OR REPLACE FUNCTION public.autocreate_home_group_social_page()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- We create a social_page for EVERY group (public and private). The visibility
  -- of the page is derived from the group's privacy flags.
  IF NOT EXISTS (
    SELECT 1 FROM public.social_pages
    WHERE linked_entity_type = 'home_group' AND linked_entity_id = NEW.id::text
  ) THEN
    INSERT INTO public.social_pages (
      owner_id, page_type, name, slug, description,
      avatar_url, cover_url, category,
      location_city, location_state, location_country,
      linked_entity_type, linked_entity_id,
      is_public, allow_member_posts, require_post_approval, metadata
    ) VALUES (
      NEW.owner_id, 'home_game', NEW.name,
      public.unique_home_game_slug(NEW.name),
      coalesce(NEW.description, NEW.tagline, ''),
      NEW.profile_photo_url, NEW.cover_photo_url, 'home game',
      NEW.city, NEW.state, 'US',
      'home_group', NEW.id::text,
      -- is_public reflects the runtime state: active AND not private
      (coalesce(NEW.is_active, true) AND NOT coalesce(NEW.is_private, false)),
      true, false,
      jsonb_build_object(
        'home_group_id', NEW.id,
        'invite_code', NEW.invite_code,
        'club_code', NEW.club_code,
        'default_game_type', NEW.default_game_type,
        'default_stakes', NEW.default_stakes,
        'frequency', NEW.frequency
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Upgrade sync trigger — same policy (create the page if missing, regardless
--    of privacy). Existing UPDATE path already flips is_public correctly.
CREATE OR REPLACE FUNCTION public.sync_home_group_to_social_page()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.social_pages sp
  SET name          = NEW.name,
      description   = coalesce(NEW.description, NEW.tagline, sp.description),
      avatar_url    = coalesce(NEW.profile_photo_url, sp.avatar_url),
      cover_url     = coalesce(NEW.cover_photo_url, sp.cover_url),
      location_city = NEW.city,
      location_state= NEW.state,
      is_public     = (coalesce(NEW.is_active, true) AND NOT coalesce(NEW.is_private, false)),
      metadata      = coalesce(sp.metadata, '{}'::jsonb) || jsonb_build_object(
        'home_group_id', NEW.id,
        'invite_code', NEW.invite_code,
        'club_code', NEW.club_code,
        'default_game_type', NEW.default_game_type,
        'default_stakes', NEW.default_stakes,
        'frequency', NEW.frequency
      ),
      updated_at    = now()
  WHERE sp.linked_entity_type = 'home_group'
    AND sp.linked_entity_id = NEW.id::text;

  -- If no row existed, create one (regardless of privacy — is_public below
  -- reflects the real privacy state).
  IF NOT FOUND THEN
    INSERT INTO public.social_pages (
      owner_id, page_type, name, slug, description,
      avatar_url, cover_url, category,
      location_city, location_state, location_country,
      linked_entity_type, linked_entity_id,
      is_public, allow_member_posts, require_post_approval, metadata
    ) VALUES (
      NEW.owner_id, 'home_game', NEW.name,
      public.unique_home_game_slug(NEW.name),
      coalesce(NEW.description, NEW.tagline, ''),
      NEW.profile_photo_url, NEW.cover_photo_url, 'home game',
      NEW.city, NEW.state, 'US',
      'home_group', NEW.id::text,
      (coalesce(NEW.is_active, true) AND NOT coalesce(NEW.is_private, false)),
      true, false,
      jsonb_build_object(
        'home_group_id', NEW.id,
        'invite_code', NEW.invite_code,
        'club_code', NEW.club_code,
        'default_game_type', NEW.default_game_type,
        'default_stakes', NEW.default_stakes,
        'frequency', NEW.frequency
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- 3. BACKFILL — every commander_home_group that's missing a social_page gets one.
--    This covers the 1 private group that was skipped before.
INSERT INTO public.social_pages (
  owner_id, page_type, name, slug, description,
  avatar_url, cover_url, category,
  location_city, location_state, location_country,
  linked_entity_type, linked_entity_id,
  is_public, allow_member_posts, require_post_approval, metadata,
  created_at, updated_at
)
SELECT
  g.owner_id, 'home_game', g.name,
  public.unique_home_game_slug(g.name),
  coalesce(g.description, g.tagline, ''),
  g.profile_photo_url, g.cover_photo_url, 'home game',
  g.city, g.state, 'US',
  'home_group', g.id::text,
  (coalesce(g.is_active, true) AND NOT coalesce(g.is_private, false)),
  true, false,
  jsonb_build_object(
    'home_group_id', g.id,
    'invite_code', g.invite_code,
    'club_code', g.club_code,
    'default_game_type', g.default_game_type,
    'default_stakes', g.default_stakes,
    'frequency', g.frequency,
    'backfilled_private', g.is_private
  ),
  coalesce(g.created_at, now()), now()
FROM public.commander_home_groups g
WHERE NOT EXISTS (
  SELECT 1 FROM public.social_pages sp
  WHERE sp.linked_entity_type='home_group'
    AND sp.linked_entity_id = g.id::text
);

-- 4. BACKFILL EVENTS — every commander_home_games row that has social_page_id NULL
--    now resolves the link via its group_id.
UPDATE public.commander_home_games hg
SET social_page_id = sp.id
FROM public.social_pages sp
WHERE hg.social_page_id IS NULL
  AND hg.group_id IS NOT NULL
  AND sp.linked_entity_type = 'home_group'
  AND sp.linked_entity_id = hg.group_id::text
  AND sp.page_type = 'home_game';
