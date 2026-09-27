-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419181743 "phase25h_public_metrics_and_final_sweep"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 efaf853f20a75cb1c5707ea88d3d1237 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART H — Public metrics + documentation pass
-- =========================================================================

-- Public-safe metrics RPC — for landing page, "By the numbers" widgets, 
-- investor decks. Returns only aggregates, no PII, no private group data.
CREATE OR REPLACE FUNCTION public.get_public_smarter_poker_metrics()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'platform', jsonb_build_object(
            'total_poker_locations', (SELECT COUNT(*) FROM mv_active_poker_locations),
            'states_covered', (SELECT COUNT(DISTINCT state) 
                                 FROM mv_active_poker_locations 
                                 WHERE state IS NOT NULL),
            'cities_covered', (SELECT COUNT(DISTINCT city) 
                                 FROM mv_active_poker_locations 
                                 WHERE city IS NOT NULL)
        ),
        'venues', jsonb_build_object(
            'total_poker_rooms', (SELECT COUNT(*) FROM poker_venues 
                                    WHERE COALESCE(is_active, true) 
                                      AND NOT COALESCE(is_suppressed, false)),
            'tournaments_today', (
                SELECT COUNT(*) FROM venue_daily_tournaments 
                 WHERE COALESCE(is_active, true) 
                   AND NOT COALESCE(is_suppressed, false)
                   AND (
                     (is_recurring AND lower(day_of_week) = lower(to_char(CURRENT_DATE, 'FMDay')))
                     OR event_date = CURRENT_DATE
                   )
            ),
            'tournaments_this_week', (
                SELECT COUNT(*) FROM venue_daily_tournaments 
                 WHERE COALESCE(is_active, true) 
                   AND NOT COALESCE(is_suppressed, false)
                   AND (
                     is_recurring
                     OR (event_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)
                   )
            )
        ),
        'home_games', jsonb_build_object(
            'public_groups', (SELECT COUNT(*) FROM commander_home_groups 
                                WHERE is_active AND NOT is_private 
                                  AND profile_photo_url IS NOT NULL),
            'total_members', (SELECT COUNT(*) FROM commander_home_members WHERE status='approved'),
            'games_scheduled_ahead', (SELECT COUNT(*) FROM commander_home_games 
                                       WHERE status IN ('scheduled','confirmed')
                                         AND scheduled_date >= CURRENT_DATE),
            'games_completed_lifetime', (SELECT COUNT(*) FROM commander_home_games 
                                          WHERE status = 'completed')
        ),
        'engagement', jsonb_build_object(
            'badges_earned', (SELECT COUNT(*) FROM commander_home_user_badges),
            'badges_unique_users', (SELECT COUNT(DISTINCT user_id) FROM commander_home_user_badges)
        )
    );
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_public_smarter_poker_metrics() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_public_smarter_poker_metrics() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_public_smarter_poker_metrics() IS
  'Phase 25/H: Public-safe aggregate metrics for landing page / investor decks. No PII, no private group data.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Comments on the new Phase 25 artifacts for future maintainers / AI readers
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON FUNCTION public.get_daily_tournaments_unified(date, text, text, boolean, int, int) IS
  'Phase 25/A: Primary entry point for /hub/daily-tournaments page. Merges venue + home-game tournaments. Fixes P0.1/P6.1/P6.2.';
COMMENT ON FUNCTION public.get_poker_near_me_unified(numeric,numeric,numeric,boolean,boolean,text,int,int) IS
  'Phase 25/B: Primary entry point for /hub/poker-near-me. PostGIS radius search merging venues + public home groups.';
COMMENT ON FUNCTION public.search_poker_unified(text, text, text, boolean, boolean, int, int) IS
  'Phase 25/C: Global search bar RPC. Weighted FTS + trigram fuzzy across venues + home groups.';
COMMENT ON MATERIALIZED VIEW mv_active_poker_locations IS
  'Phase 25/D: Hot-path MV for PNM state-index pages. Refreshed every 30 min by cron job pnm-locations-refresh.';
COMMENT ON FUNCTION public.get_poker_locations_by_state(text, int) IS
  'Phase 25/D: State-page optimized read from mv_active_poker_locations. Used by /poker-near-me/{state} pages.';
COMMENT ON FUNCTION public.fn_flag_garbage_tournaments() IS
  'Phase 25/D: Scraper cleanup. Suppresses rows with JSON/JS garbage in tournament_name. Runs daily 03:15 UTC.';
COMMENT ON FUNCTION public.get_smarter_poker_pulse() IS
  'Phase 25/G: Founder-facing one-call dashboard. Complete product snapshot for admin UI.';
COMMENT ON VIEW public.v_system_health_cron IS
  'Phase 25/G: Cron job health view. Shows last run status, duration, and 24h failure count.';
COMMENT ON COLUMN commander_home_groups.quality_score IS
  'Phase 25/G: 0-100 computed score driving discovery sort order. Refreshed daily by home-groups-quality-refresh cron.';
