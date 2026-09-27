-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417151745 "phase16a_home_group_virtual_venue_bridge"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9dba5a6c40192124ae68c995ce208297 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 16A: HOME GROUP ↔ CLUB COMMANDER VENUE BRIDGE
-- ══════════════════════════════════════════════════════════════════════
--
--  PRODUCT VISION (as laid out by Dan):
--
--    Host announces the night: push notif goes to every follower —
--    "Game starts at 7PM, reserve your seat now."
--    Follower taps → lands on the Table Tablet for THIS game → sees
--    the seats (9-max, 6-max, whatever) → picks one → it locks with
--    their name. Every other follower watching sees the seat flip to
--    "reserved (Jenna)" in real-time. Host hits "Start Game" → all
--    reserved seats become "playing" (occupied). Followers who don't
--    attend get the live spectator view: who's at the table, who's
--    on break, chip counts if the host surfaces them.
--
--  MECHANICS:
--
--    Every Club Commander tool — Table Tablet, seating, clock, Live
--    Games feed, tournaments — hangs off `poker_venues.id` (int).
--    Home groups have no linkage to that tree today.
--
--    Cleanest bridge: every commander_home_groups row gets a SHADOW
--    poker_venues row (is_suppressed=true so PNM can't see it) plus
--    one commander_tables row scoped to that venue. Existing Club
--    Commander code-paths then "just work" for home groups — no
--    refactor of the venue-scoped tooling, just virtual venue rows
--    in the same schema.
--
--  WHAT THIS MIGRATION DOES:
--
--    1. Adds poker_venues.home_group_id (uuid, unique, nullable, FK).
--    2. Adds poker_venues.commander_home_table_id (uuid, the shadow
--       table's id, denormalized for fast lookup; FK deferred to
--       avoid circular chicken/egg during INSERT).
--    3. Writes a function fn_home_group_sync_venue(group_id) that:
--         - INSERTs a poker_venues row if missing (venue_type='home_group',
--           is_suppressed=true, commander_enabled=true, name/city/state
--           copied from the group)
--         - Updates name/city/state if the group row changed
--         - INSERTs a commander_tables row (table_number=1, max_seats=
--           group.max_players or 9) if missing
--         - Returns { venue_id, table_id }
--    4. AFTER INSERT/UPDATE triggers on commander_home_groups to call
--       fn_home_group_sync_venue.
--    5. Backfills the 2 existing home groups (High Rollers, Saturday
--       Night Poker Club) via the function.
--
--  VISIBILITY:
--
--    venue_type='home_group' does NOT collide with the existing
--    ck_poker_venues_not_home_game CHECK (which blocks 'home_game',
--    'homegame', 'home-game'). Confirmed in prior schema audit.
--
--    PNM consumer filtering hardening is a follow-on concern in
--    Phase 16 Chunk D (UI wiring) — the /api/poker/venues endpoint
--    should filter on (NOT is_suppressed) AND (venue_type !=
--    'home_group'). For now the is_suppressed=true default keeps
--    them out of public surfaces that already respect that flag.
-- ══════════════════════════════════════════════════════════════════════

-- ── Schema extensions ────────────────────────────────────────────────
ALTER TABLE poker_venues
    ADD COLUMN IF NOT EXISTS home_group_id uuid,
    ADD COLUMN IF NOT EXISTS commander_home_table_id uuid;

-- One shadow venue per group (1:1)
CREATE UNIQUE INDEX IF NOT EXISTS ux_poker_venues_home_group_id
    ON poker_venues (home_group_id) WHERE home_group_id IS NOT NULL;

-- FK (deferrable = false; home groups must exist before venues sync)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_poker_venues_home_group'
    ) THEN
        ALTER TABLE poker_venues
        ADD CONSTRAINT fk_poker_venues_home_group
        FOREIGN KEY (home_group_id) REFERENCES commander_home_groups(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ── Sync function ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_home_group_sync_venue(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_group       commander_home_groups%ROWTYPE;
    v_venue_id    integer;
    v_table_id    uuid;
    v_max_seats   integer;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF v_group.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'group not found');
    END IF;

    v_max_seats := GREATEST(COALESCE(v_group.max_players, 9), 2);

    -- 1) Upsert shadow venue
    SELECT id INTO v_venue_id FROM poker_venues WHERE home_group_id = p_group_id;

    IF v_venue_id IS NULL THEN
        INSERT INTO poker_venues (
            name, venue_type, city, state, country,
            is_active, is_suppressed, commander_enabled,
            home_group_id, source
        ) VALUES (
            v_group.name, 'home_group',
            COALESCE(v_group.city, 'Unknown'),
            COALESCE(v_group.state, 'NA'),
            'US',
            true, true, true,
            p_group_id, 'home_group_shadow'
        ) RETURNING id INTO v_venue_id;
    ELSE
        UPDATE poker_venues
           SET name  = v_group.name,
               city  = COALESCE(v_group.city, city),
               state = COALESCE(v_group.state, state),
               is_active = true,
               is_suppressed = true,
               commander_enabled = true
         WHERE id = v_venue_id;
    END IF;

    -- 2) Upsert default table (one per group; more can be added later by host)
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
        -- Keep max_seats in sync with group.max_players
        UPDATE commander_tables
           SET max_seats = v_max_seats
         WHERE id = v_table_id;
    END IF;

    -- 3) Denormalize default table id onto the venue for fast lookup
    UPDATE poker_venues
       SET commander_home_table_id = v_table_id
     WHERE id = v_venue_id;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'venue_id', v_venue_id,
        'table_id', v_table_id,
        'max_seats', v_max_seats
    );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_group_sync_venue(uuid) TO authenticated, service_role;

-- ── Trigger: sync on group insert/update ─────────────────────────────
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
AFTER UPDATE OF name, max_players, city, state ON commander_home_groups
FOR EACH ROW
WHEN (
    OLD.name IS DISTINCT FROM NEW.name
 OR OLD.max_players IS DISTINCT FROM NEW.max_players
 OR OLD.city IS DISTINCT FROM NEW.city
 OR OLD.state IS DISTINCT FROM NEW.state
)
EXECUTE FUNCTION fn_trg_home_group_sync_venue();

-- ── Backfill: the 2 existing home groups ─────────────────────────────
DO $$
DECLARE g RECORD; result jsonb;
BEGIN
    FOR g IN SELECT id, name FROM commander_home_groups LOOP
        result := fn_home_group_sync_venue(g.id);
        RAISE NOTICE 'Backfilled %: %', g.name, result;
    END LOOP;
END $$;
