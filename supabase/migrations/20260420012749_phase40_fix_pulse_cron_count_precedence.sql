-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420012749 "phase40_fix_pulse_cron_count_precedence"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 065623e7b018a3a885e0586ab5170f33 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 38: get_smarter_poker_pulse has an AND/OR precedence bug
-- in cron_jobs_active metric. AND binds tighter than OR, so:
--   WHERE active = true AND jobname LIKE 'home%' OR jobname LIKE 'pnm%'
-- counts (active home jobs) + (ALL pnm jobs regardless of active).
--
-- Impact: metrics-only, no security implications. Fix just adds parens.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_smarter_poker_pulse()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'cron'
AS $function$
DECLARE
    v_pulse jsonb;
BEGIN
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'home_games', jsonb_build_object(
            'groups_total', (SELECT COUNT(*) FROM commander_home_groups WHERE is_active),
            'groups_public', (SELECT COUNT(*) FROM commander_home_groups
                              WHERE is_active AND NOT is_private
                                AND profile_photo_url IS NOT NULL),
            'groups_private', (SELECT COUNT(*) FROM commander_home_groups
                               WHERE is_active AND is_private),
            'groups_stale', (SELECT COUNT(*) FROM commander_home_groups
                             WHERE is_active
                               AND last_activity_at < NOW() - INTERVAL '45 days'),
            'members_total', (SELECT COUNT(*) FROM commander_home_members WHERE status = 'approved'),
            'members_new_30d', (SELECT COUNT(*) FROM commander_home_members
                                WHERE created_at > NOW() - INTERVAL '30 days'),
            'games_scheduled_next_7d', (SELECT COUNT(*) FROM commander_home_games
                                         WHERE status IN ('scheduled','confirmed')
                                           AND scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7),
            'games_completed_all_time', (SELECT COUNT(*) FROM commander_home_games WHERE status='completed'),
            'games_completed_30d', (SELECT COUNT(*) FROM commander_home_games
                                     WHERE status='completed'
                                       AND updated_at > NOW() - INTERVAL '30 days'),
            'rsvps_yes_30d', (SELECT COUNT(*) FROM commander_home_rsvps
                               WHERE response='yes'
                                 AND responded_at > NOW() - INTERVAL '30 days'),
            'checkins_30d', (SELECT COUNT(*) FROM commander_home_rsvps
                              WHERE checked_in_at > NOW() - INTERVAL '30 days'),
            'flake_rate_30d_pct', (
                SELECT CASE
                    WHEN COUNT(*) FILTER (WHERE response='yes') = 0 THEN 0
                    ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE flaked=true)::numeric
                               / NULLIF(COUNT(*) FILTER (WHERE response='yes'), 0), 1)
                END
                FROM commander_home_rsvps
                WHERE responded_at > NOW() - INTERVAL '30 days'
            )
        ),
        'discovery', jsonb_build_object(
            'active_poker_locations_total', (SELECT COUNT(*) FROM mv_active_poker_locations),
            'by_source', (SELECT jsonb_object_agg(source, cnt)
                           FROM (SELECT source, COUNT(*) AS cnt
                                   FROM mv_active_poker_locations GROUP BY source) t),
            'top_states', (
                SELECT jsonb_agg(jsonb_build_object('state', state, 'count', cnt))
                  FROM (SELECT state, COUNT(*) AS cnt
                          FROM mv_active_poker_locations
                         WHERE state IS NOT NULL
                         GROUP BY state
                         ORDER BY cnt DESC
                         LIMIT 10) t
            ),
            'last_refresh', (SELECT MAX(refreshed_at) FROM mv_active_poker_locations)
        ),
        'content', jsonb_build_object(
            'venues_total', (SELECT COUNT(*) FROM poker_venues WHERE COALESCE(is_active,true)),
            'venues_claimed', (SELECT COUNT(*) FROM poker_venues WHERE is_claimed = true),
            'venue_tournaments_active', (SELECT COUNT(*) FROM venue_daily_tournaments
                                          WHERE COALESCE(is_active, true)
                                            AND NOT COALESCE(is_suppressed, false)),
            'venue_tournaments_suppressed', (SELECT COUNT(*) FROM venue_daily_tournaments
                                              WHERE is_suppressed = true)
        ),
        'system_health', jsonb_build_object(
            -- Fixed: parenthesize the OR on jobname patterns
            'cron_jobs_active', (SELECT COUNT(*) FROM cron.job
                                  WHERE active = true
                                    AND (jobname LIKE 'home%' OR jobname LIKE 'pnm%')),
            'cron_failures_24h', (
                SELECT COALESCE(SUM(failures_24h), 0)
                  FROM v_system_health_cron
            ),
            'latest_snapshot_week', (SELECT MAX(week_start)
                                      FROM commander_home_group_weekly_snapshots),
            'total_weekly_snapshots', (SELECT COUNT(*) FROM commander_home_group_weekly_snapshots)
        )
    ) INTO v_pulse;
    RETURN v_pulse;
END;
$function$;
