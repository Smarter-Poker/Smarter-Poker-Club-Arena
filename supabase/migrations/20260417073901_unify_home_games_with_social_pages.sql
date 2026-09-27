-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417073901 "unify_home_games_with_social_pages"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fc8f7e2fecbca271ed23913918370c4f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Slugify helpers
CREATE OR REPLACE FUNCTION public.slugify_home_game(input text) RETURNS text AS $$
DECLARE s text;
BEGIN
  s := lower(coalesce(input, ''));
  s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
  s := regexp_replace(s, '^-+|-+$', '', 'g');
  IF s IS NULL OR length(s) = 0 THEN s := 'home-game'; END IF;
  RETURN s;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.unique_home_game_slug(base text) RETURNS text AS $$
DECLARE
  s text := public.slugify_home_game(base);
  candidate text := s;
  n int := 2;
BEGIN
  WHILE EXISTS (SELECT 1 FROM public.social_pages WHERE slug = candidate) LOOP
    candidate := s || '-' || n::text;
    n := n + 1;
    IF n > 500 THEN
      candidate := s || '-' || substr(md5(random()::text), 1, 6);
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END; $$ LANGUAGE plpgsql;

-- Backfill
INSERT INTO public.social_pages (
  owner_id, page_type, name, slug, description,
  avatar_url, cover_url, category,
  location_city, location_state, location_country,
  linked_entity_type, linked_entity_id,
  is_public, allow_member_posts, require_post_approval,
  metadata, created_at, updated_at
)
SELECT
  g.owner_id, 'home_game', g.name,
  public.unique_home_game_slug(g.name),
  coalesce(g.description, g.tagline, ''),
  g.profile_photo_url, g.cover_photo_url, 'home game',
  g.city, g.state, 'US',
  'home_group', g.id::text,
  (NOT coalesce(g.is_private, false)), true, false,
  jsonb_build_object(
    'home_group_id', g.id,
    'invite_code', g.invite_code,
    'club_code', g.club_code,
    'default_game_type', g.default_game_type,
    'default_stakes', g.default_stakes,
    'frequency', g.frequency
  ),
  g.created_at, now()
FROM public.commander_home_groups g
WHERE coalesce(g.is_active, true) = true
  AND coalesce(g.is_private, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM public.social_pages p
    WHERE p.linked_entity_type = 'home_group' AND p.linked_entity_id = g.id::text
  );

UPDATE public.commander_home_games cg
SET social_page_id = sp.id
FROM public.social_pages sp
WHERE sp.linked_entity_type = 'home_group'
  AND sp.linked_entity_id = cg.group_id::text
  AND cg.social_page_id IS NULL;

-- Indexes (no current_date in predicates — not IMMUTABLE)
CREATE INDEX IF NOT EXISTS idx_home_groups_public_discover
  ON public.commander_home_groups (is_active, is_private, state, city, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_home_games_by_group_date
  ON public.commander_home_games (group_id, scheduled_date);

CREATE INDEX IF NOT EXISTS idx_social_pages_home_games
  ON public.social_pages (page_type, is_public, location_state, location_city)
  WHERE page_type = 'home_game';

CREATE INDEX IF NOT EXISTS idx_social_pages_linked_home_group
  ON public.social_pages (linked_entity_id)
  WHERE linked_entity_type = 'home_group';

-- Auto-create trigger on INSERT
CREATE OR REPLACE FUNCTION public.autocreate_home_group_social_page() RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(NEW.is_active, true) = true AND coalesce(NEW.is_private, false) = false THEN
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
        true, true, false,
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
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_autocreate_home_group_social_page ON public.commander_home_groups;
CREATE TRIGGER trg_autocreate_home_group_social_page
  AFTER INSERT ON public.commander_home_groups
  FOR EACH ROW EXECUTE FUNCTION public.autocreate_home_group_social_page();

-- Sync trigger on UPDATE
CREATE OR REPLACE FUNCTION public.sync_home_group_to_social_page() RETURNS TRIGGER AS $$
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

  IF NOT FOUND AND coalesce(NEW.is_active, true) = true AND coalesce(NEW.is_private, false) = false THEN
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
      true, true, false,
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
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_home_group_to_social_page ON public.commander_home_groups;
CREATE TRIGGER trg_sync_home_group_to_social_page
  AFTER UPDATE ON public.commander_home_groups
  FOR EACH ROW EXECUTE FUNCTION public.sync_home_group_to_social_page();

-- Auto-link commander_home_games.social_page_id on insert
CREATE OR REPLACE FUNCTION public.link_home_game_to_social_page() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.social_page_id IS NULL AND NEW.group_id IS NOT NULL THEN
    SELECT id INTO NEW.social_page_id FROM public.social_pages
    WHERE linked_entity_type = 'home_group' AND linked_entity_id = NEW.group_id::text
    LIMIT 1;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_link_home_game_to_social_page ON public.commander_home_games;
CREATE TRIGGER trg_link_home_game_to_social_page
  BEFORE INSERT ON public.commander_home_games
  FOR EACH ROW EXECUTE FUNCTION public.link_home_game_to_social_page();
