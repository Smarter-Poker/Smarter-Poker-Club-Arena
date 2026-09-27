-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419204310 "phase29_integration_autoprovision_fixed"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 aab0cd248ee388860f87c1872310ac5d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 29 — INTEGRATION: Auto-provision + Backfill (fixed for existing 
-- ck_home_group_link_is_home_game constraint → page_type='home_game')
-- ══════════════════════════════════════════════════════════════════════════

-- A1. Home group helper → use page_type='home_game' (matches existing constraint)
CREATE OR REPLACE FUNCTION public.fn_ensure_social_page_for_home_group(p_group_id uuid)
RETURNS uuid 
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_existing_id uuid; v_group RECORD; v_new_id uuid;
BEGIN
    SELECT id INTO v_existing_id FROM social_pages
     WHERE linked_entity_type = 'home_group' AND linked_entity_id = p_group_id::text
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;

    SELECT id, owner_id, name, description, tagline, profile_photo_url, cover_photo_url,
           city, state, is_private
      INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    INSERT INTO social_pages (
        owner_id, page_type, name, description, avatar_url, cover_url, category,
        location_city, location_state, linked_entity_type, linked_entity_id,
        is_public, metadata
    ) VALUES (
        v_group.owner_id, 'home_game',   -- legacy vocab required by check constraint
        v_group.name, COALESCE(v_group.description, v_group.tagline),
        v_group.profile_photo_url, v_group.cover_photo_url, 'poker',
        v_group.city, v_group.state, 'home_group', v_group.id::text,
        NOT COALESCE(v_group.is_private, false),
        jsonb_build_object('auto_provisioned', true, 'source', 'phase29', 'at', now())
    ) RETURNING id INTO v_new_id;
    RETURN v_new_id;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ensure_social_page_for_home_group failed for %: %', p_group_id, SQLERRM;
    RETURN NULL;
END; $fn$;

-- A2. Venue helper (unchanged — page_type='venue' is already in allowed vocab)
CREATE OR REPLACE FUNCTION public.fn_ensure_social_page_for_venue(p_venue_id integer)
RETURNS uuid 
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_existing_id uuid; v_venue RECORD; v_new_id uuid; v_cover text;
BEGIN
    SELECT id INTO v_existing_id FROM social_pages
     WHERE linked_entity_type = 'venue' AND linked_entity_id = p_venue_id::text
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;

    SELECT id, name, tagline, about, city, state, country, phone, website,
           is_claimed, claimed_by, venue_type
      INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT url INTO v_cover FROM commander_venue_photos
     WHERE venue_id = p_venue_id AND is_cover_photo = true LIMIT 1;

    INSERT INTO social_pages (
        owner_id, page_type, name, description, cover_url, category,
        website, phone, location_city, location_state, location_country,
        linked_entity_type, linked_entity_id, linked_venue_id,
        is_public, metadata
    ) VALUES (
        v_venue.claimed_by, 'venue', v_venue.name,
        COALESCE(v_venue.tagline, v_venue.about),
        v_cover, 'poker',
        v_venue.website, v_venue.phone,
        v_venue.city, v_venue.state, COALESCE(v_venue.country, 'US'),
        'venue', v_venue.id::text, v_venue.id::text,
        true,
        jsonb_build_object('auto_provisioned', true, 'source', 'phase29',
                           'at', now(), 'is_claimed', v_venue.is_claimed)
    ) RETURNING id INTO v_new_id;
    RETURN v_new_id;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ensure_social_page_for_venue failed for %: %', p_venue_id, SQLERRM;
    RETURN NULL;
END; $fn$;

-- A3. Club helper (page_type='club' is already in allowed vocab)
CREATE OR REPLACE FUNCTION public.fn_ensure_social_page_for_club(p_club_id uuid)
RETURNS uuid 
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_existing_id uuid; v_club RECORD; v_new_id uuid;
BEGIN
    SELECT id INTO v_existing_id FROM social_pages
     WHERE linked_entity_type = 'club' AND linked_entity_id = p_club_id::text
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN RETURN v_existing_id; END IF;

    SELECT id, name, description, owner_id, avatar_url, logo_url, is_public
      INTO v_club FROM clubs WHERE id = p_club_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    INSERT INTO social_pages (
        owner_id, page_type, name, description, avatar_url, category,
        linked_entity_type, linked_entity_id,
        is_public, metadata
    ) VALUES (
        v_club.owner_id, 'club', v_club.name, v_club.description,
        COALESCE(v_club.avatar_url, v_club.logo_url), 'poker',
        'club', v_club.id::text,
        COALESCE(v_club.is_public, true),
        jsonb_build_object('auto_provisioned', true, 'source', 'phase29', 'at', now())
    ) RETURNING id INTO v_new_id;
    RETURN v_new_id;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ensure_social_page_for_club failed for %: %', p_club_id, SQLERRM;
    RETURN NULL;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.fn_ensure_social_page_for_home_group(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ensure_social_page_for_venue(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_ensure_social_page_for_club(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_ensure_social_page_for_home_group(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_ensure_social_page_for_venue(integer) TO service_role;
GRANT  EXECUTE ON FUNCTION public.fn_ensure_social_page_for_club(uuid) TO service_role;

-- A4. Trigger: AFTER INSERT on commander_home_groups
CREATE OR REPLACE FUNCTION public.trg_fn_autocreate_home_group_social_page()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    PERFORM public.fn_ensure_social_page_for_home_group(NEW.id);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'autocreate home_group social_page failed: %', SQLERRM;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_autocreate_home_group_social_page ON commander_home_groups;
CREATE TRIGGER trg_autocreate_home_group_social_page
    AFTER INSERT ON commander_home_groups
    FOR EACH ROW EXECUTE FUNCTION public.trg_fn_autocreate_home_group_social_page();

-- A5. Trigger: venue claim wiring (BEFORE UPDATE so we can set commander_enabled in same row)
CREATE OR REPLACE FUNCTION public.trg_fn_venue_claim_wiring()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF COALESCE(OLD.is_claimed, false) = false AND COALESCE(NEW.is_claimed, false) = true THEN
        PERFORM public.fn_ensure_social_page_for_venue(NEW.id);
        IF NOT COALESCE(NEW.commander_enabled, false) THEN
            NEW.commander_enabled := true;
            IF NEW.commander_activated_at IS NULL THEN NEW.commander_activated_at := now(); END IF;
        END IF;
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'venue claim wiring failed for venue %: %', NEW.id, SQLERRM;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_venue_claim_wiring ON poker_venues;
CREATE TRIGGER trg_venue_claim_wiring
    BEFORE UPDATE ON poker_venues
    FOR EACH ROW 
    WHEN (OLD.is_claimed IS DISTINCT FROM NEW.is_claimed)
    EXECUTE FUNCTION public.trg_fn_venue_claim_wiring();

-- A6. Trigger: AFTER INSERT on clubs
CREATE OR REPLACE FUNCTION public.trg_fn_autocreate_club_social_page()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    PERFORM public.fn_ensure_social_page_for_club(NEW.id);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'autocreate club social_page failed: %', SQLERRM;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_autocreate_club_social_page ON clubs;
CREATE TRIGGER trg_autocreate_club_social_page
    AFTER INSERT ON clubs
    FOR EACH ROW EXECUTE FUNCTION public.trg_fn_autocreate_club_social_page();

-- ════════════════════════════════════════════════════════════════════
-- PART B — Normalize existing rows + backfill
-- ════════════════════════════════════════════════════════════════════

-- B1. Normalize existing venue social_page: fill linked_entity_type/id where only linked_venue_id is set
UPDATE social_pages 
   SET linked_entity_type = 'venue', 
       linked_entity_id = linked_venue_id
 WHERE linked_venue_id IS NOT NULL 
   AND (linked_entity_type IS NULL OR linked_entity_id IS NULL);

-- B2. Backfill every commander_home_group (existing 2 already have pages — helper is idempotent)
DO $$
DECLARE r RECORD; v_count int := 0;
BEGIN
    FOR r IN SELECT id FROM commander_home_groups LOOP
        IF public.fn_ensure_social_page_for_home_group(r.id) IS NOT NULL THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'home_group social_pages resolved: %', v_count;
END $$;

-- B3. Backfill every CLAIMED venue + auto-enable Commander
DO $$
DECLARE r RECORD; v_sp_count int := 0; v_cmd_count int := 0;
BEGIN
    FOR r IN SELECT id, commander_enabled FROM poker_venues 
              WHERE is_claimed = true 
                AND COALESCE(is_active, true) 
                AND NOT COALESCE(is_suppressed, false) LOOP
        IF public.fn_ensure_social_page_for_venue(r.id) IS NOT NULL THEN
            v_sp_count := v_sp_count + 1;
        END IF;
        IF COALESCE(r.commander_enabled, false) = false THEN
            UPDATE poker_venues 
               SET commander_enabled = true,
                   commander_activated_at = COALESCE(commander_activated_at, now())
             WHERE id = r.id;
            v_cmd_count := v_cmd_count + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'venue social_pages resolved: %, commander enabled: %', v_sp_count, v_cmd_count;
END $$;

-- B4. Backfill every club
DO $$
DECLARE r RECORD; v_count int := 0;
BEGIN
    FOR r IN SELECT id FROM clubs LOOP
        IF public.fn_ensure_social_page_for_club(r.id) IS NOT NULL THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'club social_pages resolved: %', v_count;
END $$;

-- B5. Indexes for fast linked_entity lookup
CREATE INDEX IF NOT EXISTS idx_social_pages_linked_entity 
    ON social_pages (linked_entity_type, linked_entity_id) 
 WHERE linked_entity_type IS NOT NULL;

COMMENT ON COLUMN social_pages.linked_entity_type IS
  'Canonical entity linking. Values: home_group, venue, club. Use alongside linked_entity_id.';
COMMENT ON COLUMN social_pages.linked_venue_id IS
  'LEGACY: use linked_entity_type=''venue'' + linked_entity_id instead.';

COMMENT ON FUNCTION public.trg_fn_venue_claim_wiring() IS
  'Phase 29/A: When a venue is claimed, auto-provision its social_page and enable Commander.';
