-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419222923 "phase36_patch_public_metrics"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8a48b76b7c0f38b326e4140e3080ee38 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Remove the 'engagement' block (counts of dropped badges table) from
-- get_public_smarter_poker_metrics. Leave the rest of the shape intact.
CREATE OR REPLACE FUNCTION public.get_public_smarter_poker_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        )
    );
END; $function$;
