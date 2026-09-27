-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417085603 "enforce_home_game_social_page_invariants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f86163d36d82c46db60937dfc47f5376 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Structural guards so the home_game ↔ social_page relationship can never drift
-- ═══════════════════════════════════════════════════════════════════════════
-- We just verified 11 integrity invariants are green in current data. These
-- constraints lock those invariants in so a future code bug can't re-introduce
-- duplicates, orphans, or type mismatches.
-- ═══════════════════════════════════════════════════════════════════════════

-- INVARIANT 1: One social_page per home_group.
-- A commander_home_group MUST NOT have two social_pages pointing at it.
-- Partial index ensures this only applies to home_group entity type so other
-- linked types (venue, etc.) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_social_pages_one_per_home_group
  ON public.social_pages (linked_entity_id)
  WHERE linked_entity_type = 'home_group' AND page_type = 'home_game';

-- INVARIANT 2: If a social_page is linked to a home_group, its type MUST be
-- home_game. Prevents the "Bill's Game" scenario where a home game was
-- misrepresented as page_type='venue'.
ALTER TABLE public.social_pages
  DROP CONSTRAINT IF EXISTS ck_home_group_link_is_home_game;

ALTER TABLE public.social_pages
  ADD CONSTRAINT ck_home_group_link_is_home_game
  CHECK (
    linked_entity_type IS DISTINCT FROM 'home_group'
    OR page_type = 'home_game'
  );

-- INVARIANT 3: A commander_home_games event's social_page (if set) must be a
-- home_game type. The FK already guarantees referential integrity; this adds
-- the type correctness guarantee via a trigger (can't do cross-table CHECK).
CREATE OR REPLACE FUNCTION public.validate_home_game_social_page_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sp_type text;
  sp_linked_group text;
BEGIN
  IF NEW.social_page_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT page_type, linked_entity_id
    INTO sp_type, sp_linked_group
  FROM public.social_pages
  WHERE id = NEW.social_page_id;

  IF sp_type IS NULL THEN
    -- FK will catch this; belt + suspenders.
    RAISE EXCEPTION 'social_page_id % does not exist', NEW.social_page_id;
  END IF;

  IF sp_type <> 'home_game' THEN
    RAISE EXCEPTION 'commander_home_games.social_page_id must reference a social_page of page_type=home_game, got %', sp_type;
  END IF;

  -- The event's group MUST match the social page's linked group.
  IF NEW.group_id IS NOT NULL AND sp_linked_group IS DISTINCT FROM NEW.group_id::text THEN
    RAISE EXCEPTION 'commander_home_games event (group_id=%) cannot point at social_page linked to different group (linked_entity_id=%)',
      NEW.group_id, sp_linked_group;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_home_game_social_page_link ON public.commander_home_games;
CREATE TRIGGER trg_validate_home_game_social_page_link
  BEFORE INSERT OR UPDATE OF social_page_id, group_id ON public.commander_home_games
  FOR EACH ROW EXECUTE FUNCTION public.validate_home_game_social_page_link();
