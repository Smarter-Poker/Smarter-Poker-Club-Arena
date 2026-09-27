-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417152310 "phase16b_home_game_visibility_reversal_and_reservations"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f899701df0496bd4af33951c9d667169 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════
--  PHASE 16B: VISIBILITY REVERSAL + RESERVATION RPCs
-- ══════════════════════════════════════════════════════════════════════
--
--  PRODUCT CORRECTION — Dan's new direction:
--
--    "Home games need to and MUST be visible everywhere. They are
--    designed to be displayed under Poker Near Me for maximum
--    exposure."
--
--  This is a complete reversal of the prior Phase 15 quarantine +
--  Phase 16A is_suppressed=true stance. Strategically sharp: home
--  games exist to attract new players; hiding them from PNM
--  strangles the top-of-funnel exposure. Maximum visibility wins.
--
--  WHAT THIS MIGRATION DOES
--
--    1. DROP ck_poker_venues_not_home_game (no longer blocks any
--       venue_type). venue_type='home_group' is now a first-class
--       venue type alongside casino/cardroom/charity/etc.
--
--    2. Flip is_suppressed → false on existing shadow home-group
--       venues. PNM will now surface them.
--
--    3. Update fn_home_group_sync_venue so future shadows default to
--       is_suppressed=false (same as any other real venue).
--
--    4. Install reservation RPCs for the Table Tablet flow:
--
--         fn_home_start_game             — host provisions the live
--                                          session: creates a
--                                          commander_games row on the
--                                          shadow table, seeds N empty
--                                          seats (N = group max_players)
--
--         fn_home_reserve_seat           — follower claims seat N.
--                                          Relies on
--                                          commander_seats UNIQUE
--                                          (game_id, seat_number)
--                                          for concurrency; two
--                                          parallel callers can't
--                                          both take seat 3
--
--         fn_home_release_seat           — follower releases their
--                                          own reservation (or host
--                                          releases anyone's)
--
--         fn_home_confirm_all_reservations — host flips all
--                                          status='reserved' rows
--                                          for this game to
--                                          status='occupied' at
--                                          game-start time
--
--         fn_home_end_game               — host closes the session;
--                                          commander_games.closed_at
--                                          = NOW(). Seats stay on
--                                          record for history.
--
--  AUTHZ MODEL
--
--    • fn_home_start_game  — staff only (owner or approved admin
--                             of the group). Uses the existing
--                             fn_home_caller_is_game_staff helper.
--                             Wait — that helper was dropped when
--                             Phase 14 was reverted. Re-installing
--                             it inline here as fn_home_is_group_staff
--                             (slightly different signature: takes a
--                             group_id rather than a game_id).
--
--    • fn_home_reserve_seat — any authenticated user (any follower)
--                             can reserve. This is intentional — Dan's
--                             spec is "followers click and reserve,"
--                             not "approved members can reserve."
--                             Max exposure = minimal friction.
--
--    • fn_home_release_seat — the user who reserved it, OR group staff.
--
--    • fn_home_confirm_all_reservations — group staff.
--
--    • fn_home_end_game     — group staff.
-- ══════════════════════════════════════════════════════════════════════

-- ── Step 1: Un-quarantine PNM CHECK constraint ───────────────────────
ALTER TABLE poker_venues DROP CONSTRAINT IF EXISTS ck_poker_venues_not_home_game;

-- ── Step 2: Make existing shadow venues publicly visible ─────────────
UPDATE poker_venues
   SET is_suppressed = false
 WHERE venue_type = 'home_group' AND home_group_id IS NOT NULL;

-- ── Step 3: Update sync function so future shadows default visible ───
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

    SELECT id INTO v_venue_id FROM poker_venues WHERE home_group_id = p_group_id;

    IF v_venue_id IS NULL THEN
        INSERT INTO poker_venues (
            name, venue_type, city, state, country,
            is_active, is_suppressed, commander_enabled,
            home_group_id, source,
            latitude, longitude, lat, lng
        ) VALUES (
            v_group.name, 'home_group',
            COALESCE(v_group.city, 'Unknown'),
            COALESCE(v_group.state, 'NA'),
            'US',
            true,
            false,                            -- visible to PNM now
            true,
            p_group_id, 'home_group_shadow',
            v_group.latitude, v_group.longitude,
            v_group.latitude, v_group.longitude
        ) RETURNING id INTO v_venue_id;
    ELSE
        UPDATE poker_venues
           SET name  = v_group.name,
               city  = COALESCE(v_group.city, city),
               state = COALESCE(v_group.state, state),
               latitude  = COALESCE(v_group.latitude, latitude),
               longitude = COALESCE(v_group.longitude, longitude),
               lat       = COALESCE(v_group.latitude, lat),
               lng       = COALESCE(v_group.longitude, lng),
               is_active = true,
               is_suppressed = false,
               commander_enabled = true
         WHERE id = v_venue_id;
    END IF;

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
        'venue_id', v_venue_id, 'table_id', v_table_id, 'max_seats', v_max_seats
    );
END;
$$;

-- Also backfill coordinates on existing shadows (they were created w/o lat/lng)
DO $$
DECLARE g RECORD;
BEGIN
    FOR g IN SELECT id FROM commander_home_groups LOOP
        PERFORM fn_home_group_sync_venue(g.id);
    END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════
--  AUTHZ HELPER — staff check by GROUP id (not game_id like Phase 14's)
-- ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_home_is_group_staff(p_caller uuid, p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF p_caller IS NULL OR p_group_id IS NULL THEN RETURN false; END IF;

    -- Owner
    IF EXISTS (SELECT 1 FROM commander_home_groups
               WHERE id = p_group_id AND owner_id = p_caller) THEN
        RETURN true;
    END IF;

    -- Approved admin
    IF EXISTS (SELECT 1 FROM commander_home_members
               WHERE group_id = p_group_id
                 AND user_id = p_caller
                 AND status = 'approved'
                 AND role IN ('owner','admin')) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_home_is_group_staff(uuid, uuid) TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════
--  RPC: fn_home_start_game
--  Host provisions the live session for a commander_home_games event.
--  - Looks up the group's shadow venue + table
--  - Creates a commander_games row (the live session root)
--  - Seeds `max_players` empty seats so followers can reserve
--  - Updates the table's current_game_id
--  - Stamps commander_home_games with a link to the session
-- ══════════════════════
