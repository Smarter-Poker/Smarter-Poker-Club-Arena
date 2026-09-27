-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417153918 "phase17_venue_unification_home_groups_first_class"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 44c7ee3254d4d8880b11349630b82706 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 17: VENUE UNIFICATION — HOME GROUPS AS FIRST-CLASS VENUES
-- ══════════════════════════════════════════════════════════════════════
--
--  Dan's direction: "ADD ALL HOMEGAMES TO VENUE COUNT AS WELL. KEEP IT
--  CLEAN AND CONSISTENT."
--
--  FULL ARC TO DATE
--
--    R1: "Home games NOT in PNM / Social Pages"              (Phase 15)
--    R2: "Home games visible in PNM but NOT counted as venues"
--        (Phase 16A revert + Phase 16B visibility reversal)
--    R3: "Home games ARE counted as venues. Unified." ← THIS PHASE
--
--  R3 is the right long-term architecture. Keeping home groups as a
--  separate island forced every venue-consuming query to know about
--  two sources of truth; the counts drifted; the PNM UI needed UNION
--  logic that kept skewing. "Clean and consistent" means one schema,
--  one source of truth, one count.
--
--  THE MODEL
--
--    Each commander_home_groups row gets a corresponding poker_venues
--    row with venue_type='home_group'. PNM sees them like any other
--    venue. Venue counts include them. UI differentiates via the
--    venue_type badge ('home_group' renders as "Home Game" with a
--    different color/icon).
--
--    This is effectively Phase 16A, but with is_suppressed=false so
--    they're visible, rather than hidden shadows.
--
--  WHAT THIS MIGRATION DOES
--
--    1. poker_venues.home_group_id (uuid, unique, FK CASCADE) — 1:1
--       link to commander_home_groups.
--    2. poker_venues.commander_home_table_id (uuid) — fast-lookup to
--       the default table (for the Table Tablet flow).
--    3. fn_home_group_sync_venue(group_id) — idempotent upsert; shadows
--       are now created is_suppressed=false so they appear everywhere.
--    4. AFTER INSERT / UPDATE OF (name, max_players, city, state, lat,
--       lng) triggers on commander_home_groups.
--    5. Backfill loop for existing groups.
--
--  NOT INCLUDED (UI follow-ups handled in app code changes):
--    - Venue-type badge rendering for 'home_group' cards
--    - Removing the Phase 15 list-query quarantine in
--      /api/social/pages/index.js (separate commit)
--    - PNM card click-through behavior (home_group cards should route
--      to /hub/home-games/{slug}, not /hub/venues/{id})
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE poker_venues
    ADD COLUMN IF NOT EXISTS home_group_id uuid,
    ADD COLUMN IF NOT EXISTS commander_home_table_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS ux_poker_venues_home_group_id
    ON poker_venues (home_group_id) WHERE home_group_id IS NOT NULL;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_poker_venues_home_group'
    ) THEN
        ALTER TABLE poker_venues
        ADD CONSTRAINT fk_poker_venues_home_group
        FOREIGN KEY (home_group_id) REFERENCES commander_home_groups(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Sync function: NOW creates shadows with is_suppressed=false (the key
-- difference vs the reverted Phase 16A). Home groups are visible venues.
CREATE OR REPLACE FUNCTION fn_home_group_sync_venue(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_group       commander_home_groups%ROWTYPE;
    v_venue_id    integer;
    v_table_id    uuid;
    v_max_seats   integer;
    v_social_page social_pages%ROWTYPE;
    v_slug        text;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF v_group.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'group not found');
    END IF;

    v_max_seats := GREATEST(COALESCE(v_group.max_players, 9), 2);

    -- Grab the linked social_page (if any) for slug + cover photos
    SELECT * INTO v_social_page
      FROM social_pages
     WHERE linked_entity_type = 'home_group'
       AND linked_entity_id  = p_group_id::text
     LIMIT 1;

    v_slug := v_social_page.slug;

    -- 1) Upsert shadow venue — is_suppressed=false (VISIBLE)
    SELECT id INTO v_venue_id FROM poker_venues WHERE home_group_id = p_group_id;

    IF v_venue_id IS NULL THEN
        INSERT INTO poker_venues (
            name, venue_type, city, state, country,
            latitude, longitude, lat, lng,
            is_active, is_suppressed, commander_enabled,
            home_group_id, source, slug,
            cover_photo_url, profile_photo_url, tagline, about
        ) VALUES (
            v_group.name, 'home_group',
            COALESCE(v_group.city, 'Unknown'),
            COALESCE(v_group.state, 'NA'),
            'US',
            v_group.latitude, v_group.longitude,
            v_group.latitude, v_group.longitude,
            true, false, true,
            p_group_id, 'home_group_shadow', v_slug,
            v_group.cover_photo_url, v_group.profile_photo_url,
            v_group.tagline, v_group.description
        ) RETURNING id INTO v_venue_id;
    ELSE
        UPDATE poker_venues
           SET name              = v_group.name,
               city              = COALESCE(v_group.city, city),
               state             = COALESCE(v_group.state, state),
               latitude          = COALESCE(v_group.latitude, latitude),
               longitude         = COALESCE(v_group.longitude, longitude),
               lat               = COALESCE(v_group.latitude, lat),
               lng               = COALESCE(v_group.longitude, lng),
               is_active         = true,
               is_suppressed     = false,        -- KEY: visible
               commander_enabled = true,
               slug              = COALESCE(v_slug, slug),
               cover_photo_url   = COALESCE(v_group.cover_photo_url, cover_photo_url),
               profile_photo_url = COALESCE(v_group.profile_photo_url, profile_photo_url),
               tagline           = COALESCE(v_group.tagline, tagline),
               about             = COALESCE(v_group.description, about)
         WHERE id = v_venue_id;
    END IF;

    -- 2) Upsert default table (one per group; the Table Tablet flow uses it)
    SELECT id INTO v_table_id
      FROM commander_tables
     WHERE venue_id = v_venue_id AND table_number = 1
     LIMIT 1;

    IF v_table_id IS NULL THEN
        INSERT INTO commander_tables (
            venue_id, table_number, table_name, max_seats, status
        ) VALUES (
            v_venue_id, 1, 'Table 1', v_max_seats, 'available'
        ) RETURNING id INTO v_table_id;
    ELSE
        UPDATE commander_tables SET max_seats = v_max_seats WHERE id = v_table_id;
    END IF;

    UPDATE poker_venues SET commander_home_table_id = v_table_id WHERE id = v_venue_id;

    RETURN jsonb_build_object(
        'success', true, 'group_id', p_group_id,
        'venue_id', v_venue_id, 'table_id', v_table_id,
        'max_seats', v_max_seats, 'slug', v_slug
    );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_group_sync_venue(uuid) TO authenticated, service_role;

-- Trigger fn
CREATE OR REPLACE FUNCTION fn_trg_home_group_sync_venue()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM fn_home_group_sync_venue(NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_home_group_sync_venue_ins ON commander_home_groups;
CREATE TRIGGER trg_home_group_sync_venue_ins
AFTER INSERT ON commander_home_groups
FOR EACH ROW EXECUTE FUNCTION fn_trg_home_group_sync_venue();

DROP TRIGGER IF EXISTS trg_home_group_sync_venue_upd ON commander_home_groups;
CREATE TRIGGER trg_home_group_sync_venue_upd
AFTER UPDATE OF
    name, max_players, city, state, latitude, longitude,
    cover_photo_url, profile_photo_url, tagline, description
  ON commander_home_groups
FOR EACH ROW
WHEN (
    OLD.name IS DISTINCT FROM NEW.name
 OR OLD.max_players IS DISTINCT FROM NEW.max_players
 OR OLD.city IS DISTINCT FROM NEW.city
 OR OLD.state IS DISTINCT FROM NEW.state
 OR OLD.latitude IS DISTINCT FROM NEW.latitude
 OR OLD.longitude IS DISTINCT FROM NEW.longitude
 OR OLD.cover_photo_url IS DISTINCT FROM NEW.cover_photo_url
 OR OLD.profile_photo_url IS DISTINCT FROM NEW.profile_photo_url
 OR OLD.tagline IS DISTINCT FROM NEW.tagline
 OR OLD.description IS DISTINCT FROM NEW.description
)
EXECUTE FUNCTION fn_trg_home_group_sync_venue();

-- Backfill
DO $$
DECLARE g RECORD; result jsonb;
BEGIN
    FOR g IN SELECT id, name FROM commander_home_groups LOOP
        result := fn_home_group_sync_venue(g.id);
        RAISE NOTICE 'Synced %: %', g.name, result;
    END LOOP;
END $$;
