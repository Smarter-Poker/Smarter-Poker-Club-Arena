-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419164553 "phase25a_unified_daily_tournaments_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 57b8f59c6cd44f2ead9e91b588ba3722 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART A — Unified daily tournaments RPC
--  Fixes P0.1 / P6.1 / P6.2 silent-failure: frontend daily-tournaments.js
--  can swap to this single RPC and get both venue + home-game tournaments.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_daily_tournaments_unified(
    p_target_date         date,
    p_state               text DEFAULT NULL,
    p_city                text DEFAULT NULL,
    p_include_home_games  boolean DEFAULT true,
    p_inactivity_days     int DEFAULT 45,
    p_limit               int DEFAULT 500
) RETURNS TABLE (
    source              text,            -- 'venue' or 'home_game'
    tournament_id       text,            -- uuid cast to text
    venue_id            text,            -- poker_venues.id or home_group.id
    venue_name          text,
    venue_slug          text,
    venue_type          text,            -- 'poker_room', 'home_game', etc.
    venue_city          text,
    venue_state         text,
    venue_lat           numeric,
    venue_lng           numeric,
    tournament_name     text,
    event_date          date,
    start_time          text,
    buy_in              integer,
    rebuy_addon         text,
    starting_stack      integer,
    blind_levels        text,
    level_duration_min  integer,
    guaranteed          integer,
    game_type           text,
    format              text,
    late_registration   text,
    notes               text,
    max_entries         integer,
    is_special_event    boolean,
    series_name         text,
    source_url          text,
    is_active           boolean,
    -- Home-game-specific extras
    is_private          boolean,
    rsvp_yes_count      integer,
    max_players         integer,
    host_id             uuid,
    home_group_id       uuid,
    requires_rsvp       boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_day_of_week  text;
BEGIN
    -- Map target date to day-of-week text
    v_day_of_week := lower(to_char(p_target_date, 'FMDay'));  -- 'monday','tuesday',...

    RETURN QUERY
    -- ═══════════════════════════════════════════════════════════════════
    -- Branch 1: Venue tournaments
    -- Pull from venue_daily_tournaments + recurring day-of-week matches
    -- ═══════════════════════════════════════════════════════════════════
    SELECT 
        'venue'::text AS source,
        t.id::text AS tournament_id,
        COALESCE(pv.id::text, t.venue_id::text) AS venue_id,
        COALESCE(pv.name, t.venue_name) AS venue_name,
        pv.slug AS venue_slug,
        COALESCE(pv.venue_type, 'poker_room') AS venue_type,
        pv.city AS venue_city,
        pv.state AS venue_state,
        COALESCE(pv.lat, pv.latitude) AS venue_lat,
        COALESCE(pv.lng, pv.longitude) AS venue_lng,
        t.tournament_name,
        COALESCE(t.event_date, p_target_date) AS event_date,
        t.start_time,
        t.buy_in,
        t.rebuy_addon,
        t.starting_stack,
        t.blind_levels,
        t.level_duration_minutes,
        t.guaranteed,
        t.game_type,
        t.format,
        t.late_registration,
        t.notes,
        t.max_entries,
        COALESCE(t.is_special_event, false),
        t.series_name,
        t.source_url,
        COALESCE(t.is_active, true),
        -- Home-game-only extras default to NULL/0 for venues
        NULL::boolean AS is_private,
        NULL::integer AS rsvp_yes_count,
        NULL::integer AS max_players,
        NULL::uuid    AS host_id,
        NULL::uuid    AS home_group_id,
        false         AS requires_rsvp
      FROM venue_daily_tournaments t
      LEFT JOIN poker_venues pv ON pv.id = t.venue_id
     WHERE COALESCE(t.is_active, true) = true
       AND COALESCE(t.is_suppressed, false) = false
       AND (
           -- Recurring weekly match: day_of_week matches target date
           (t.is_recurring = true AND lower(t.day_of_week) = v_day_of_week
            AND (t.event_date IS NULL OR t.event_date <= p_target_date))
           OR
           -- Specific event_date match (one-off event)
           (t.event_date = p_target_date)
       )
       AND (p_state IS NULL OR pv.state = p_state)
       AND (p_city IS NULL OR pv.city ILIKE p_city)

    UNION ALL

    -- ═══════════════════════════════════════════════════════════════════
    -- Branch 2: Home-game tournaments (public groups only)
    -- ═══════════════════════════════════════════════════════════════════
    SELECT 
        'home_game'::text AS source,
        g.id::text AS tournament_id,
        grp.id::text AS venue_id,
        grp.name AS venue_name,
        sp.slug AS venue_slug,
        'home_game'::text AS venue_type,
        grp.city AS venue_city,
        grp.state AS venue_state,
        grp.latitude AS venue_lat,
        grp.longitude AS venue_lng,
        COALESCE(g.title, grp.name || ' Home Tournament') AS tournament_name,
        g.scheduled_date AS event_date,
        CASE WHEN g.start_time IS NOT NULL 
             THEN to_char(g.start_time, 'HH24:MI')
             ELSE NULL END AS start_time,
        (g.buyin_min)::integer AS buy_in,
        NULL::text AS rebuy_addon,
        NULL::integer AS starting_stack,
        NULL::text AS blind_levels,
        NULL::integer AS level_duration_min,
        NULL::integer AS guaranteed,
        g.game_type,
        g.format,
        NULL::text AS late_registration,
        g.description AS notes,
        g.max_players AS max_entries,
        false AS is_special_event,
        NULL::text AS series_name,
        ('/hub/home-games/' || COALESCE(sp.slug, grp.id::text) || '/games/' || g.id::text)::text AS source_url,
        true AS is_active,
        -- Home-game extras
        grp.is_private,
        COALESCE(g.rsvp_yes, 0) AS rsvp_yes_count,
        g.max_players,
        g.host_id,
        grp.id AS home_group_id,
        true AS requires_rsvp
      FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = grp.id::text
     WHERE p_include_home_games = true
       AND g.scheduled_date = p_target_date
       AND g.status IN ('scheduled','confirmed','in_progress')
       AND g.format = 'tournament'
       AND grp.is_active = true
       AND grp.is_private = false  -- only public home groups show in daily feed
       AND grp.profile_photo_url IS NOT NULL  -- Phase 17 logo enforcement
       AND grp.last_activity_at > NOW() - (p_inactivity_days || ' days')::interval
       AND (p_state IS NULL OR grp.state = p_state)
       AND (p_city IS NULL OR grp.city ILIKE p_city)

     ORDER BY start_time NULLS LAST, tournament_name
     LIMIT GREATEST(1, LEAST(p_limit, 1000));
END;
$fn$;

COMMENT ON FUNCTION public.get_daily_tournaments_unified(date, text, text, boolean, int, int) IS
  'Phase 25/A: Unified daily tournaments feed combining scraped venues (venue_daily_tournaments) and public home-game tournaments (commander_home_games + commander_home_groups). Fixes P0.1/P6.1/P6.2 production silent-failure where home games were missing from /hub/daily-tournaments.';

REVOKE EXECUTE ON FUNCTION public.get_daily_tournaments_unified(date, text, text, boolean, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_daily_tournaments_unified(date, text, text, boolean, int, int) TO anon, authenticated, service_role;
