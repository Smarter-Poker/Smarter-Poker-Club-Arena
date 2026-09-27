-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417184301 "phase22_home_game_tournaments_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 25be8b1ce09dfed8f32e4e1ca47a902c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 22 — get_home_game_tournaments_for_date RPC
--  -----------------------------------------------------------------------
--  Purpose: replace Phase 20's unreliable PostgREST embedded-resource
--  filter (`group:commander_home_groups!inner(...)` + `.eq('group.*')`)
--  with a single server-side SQL round-trip that returns already-filtered,
--  already-joined, slug-enriched rows ready for the Daily Tournaments API.
--
--  Background: Phase 20 shipped a supabase-js query that relied on
--  `.eq('group.is_private', false)` against an embedded resource. This is
--  rejected by PostgREST at runtime (the error is swallowed by the
--  non-fatal catch block), so zero home-game tournaments have been
--  surfacing in /api/poker/daily-tournaments since b97cf0a4.
--
--  All filters that used to live in the JS client (activity window,
--  privacy, active-flag, optional state filter) are now pushed into this
--  function, so the API's only remaining responsibilities are shape
--  conversion and response merging.
--
--  Safety profile:
--    - STABLE (read-only, no writes)
--    - SECURITY DEFINER with locked search_path (public only)
--    - Never returns private groups, inactive groups, or stale-past-
--      threshold groups
--    - No owner_id / host_id / PII-adjacent fields returned
--    - Tournament locations surface as approximate city/state + jitterable
--      lat/lng; exact address never returned
--    - Safe to expose to anon (consumed by public API); the row filter
--      matches the privacy rules the API and PNM/Near-Me pages already
--      use.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_home_game_tournaments_for_date(
    p_target_date      date,
    p_state            text DEFAULT NULL,
    p_inactivity_days  int  DEFAULT 45
)
RETURNS TABLE (
    tournament_id               uuid,
    title                       text,
    description                 text,
    scheduled_date              date,
    start_time                  time,
    game_type                   text,
    stakes                      text,
    buyin_min                   int,
    buyin_max                   int,
    status                      text,
    rsvp_yes                    int,
    max_players                 int,
    group_id                    uuid,
    group_name                  text,
    city                        text,
    state                       text,
    latitude                    numeric,
    longitude                   numeric,
    profile_photo_url           text,
    last_activity_at            timestamptz,
    visibility_override_until   timestamptz,
    slug                        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
    SELECT
        hg.id                           AS tournament_id,
        hg.title,
        hg.description,
        hg.scheduled_date,
        hg.start_time,
        hg.game_type,
        hg.stakes,
        hg.buyin_min,
        hg.buyin_max,
        hg.status,
        hg.rsvp_yes,
        hg.max_players,
        g.id                            AS group_id,
        g.name                          AS group_name,
        g.city,
        g.state,
        g.latitude,
        g.longitude,
        g.profile_photo_url,
        g.last_activity_at,
        g.visibility_override_until,
        sp.slug
    FROM commander_home_games hg
    INNER JOIN commander_home_groups g
            ON g.id = hg.group_id
    LEFT  JOIN social_pages sp
            ON sp.linked_entity_type = 'home_group'
           AND sp.linked_entity_id   = g.id::text
    WHERE hg.format         = 'tournament'
      AND hg.status         IN ('scheduled', 'in_progress')
      AND hg.scheduled_date = p_target_date
      AND g.is_private      = false
      AND g.is_active       = true
      AND (
            g.last_activity_at          >= NOW() - (p_inactivity_days || ' days')::interval
         OR g.created_at                >= NOW() - (p_inactivity_days || ' days')::interval
         OR (g.visibility_override_until IS NOT NULL AND g.visibility_override_until > NOW())
      )
      AND (p_state IS NULL OR UPPER(g.state) = UPPER(p_state))
    ORDER BY hg.start_time ASC, hg.title ASC;
$func$;

COMMENT ON FUNCTION public.get_home_game_tournaments_for_date(date, text, int) IS
  'Phase 22. Returns home-game tournaments for a given date with group join, slug, and 45-day activity filter applied server-side. Replaces the Phase 20 PostgREST embedded-resource query which silently fails in production. Callers: /api/poker/daily-tournaments.';

-- Allow both public (anon) and logged-in (authenticated) roles to invoke.
-- The row-level filter already ensures no private/inactive data leaks.
GRANT EXECUTE ON FUNCTION public.get_home_game_tournaments_for_date(date, text, int)
    TO anon, authenticated, service_role;
