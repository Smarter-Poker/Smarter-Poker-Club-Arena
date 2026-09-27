-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419181656 "phase25g_founder_pulse_and_system_health"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 091a86bce9f89e12046afacebd11e1d9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 25 PART G — Founder "pulse" RPC + system health observability
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- 1) System health view — cron jobs, last-run times, recent failures
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.v_system_health_cron AS
SELECT 
    j.jobid,
    j.jobname,
    j.schedule,
    j.active,
    (SELECT status FROM cron.job_run_details d 
      WHERE d.jobid = j.jobid 
      ORDER BY d.start_time DESC LIMIT 1) AS last_status,
    (SELECT start_time FROM cron.job_run_details d 
      WHERE d.jobid = j.jobid 
      ORDER BY d.start_time DESC LIMIT 1) AS last_run_at,
    (SELECT end_time - start_time FROM cron.job_run_details d 
      WHERE d.jobid = j.jobid 
      ORDER BY d.start_time DESC LIMIT 1) AS last_run_duration,
    (SELECT COUNT(*) FROM cron.job_run_details d 
      WHERE d.jobid = j.jobid 
        AND d.start_time > NOW() - INTERVAL '24 hours'
        AND d.status = 'failed') AS failures_24h
  FROM cron.job j
 WHERE j.jobname LIKE 'home%' OR j.jobname LIKE 'pnm%' OR j.jobname LIKE 'flag-garbage%';

GRANT SELECT ON public.v_system_health_cron TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 2) Founder "pulse" RPC — one call, full product snapshot
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_smarter_poker_pulse()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'cron'
AS $fn$
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
            ),
            'badges_awarded', (SELECT COUNT(*) FROM commander_home_user_badges),
            'diamonds_to_hosts_30d', COALESCE((
                SELECT SUM(amount) FROM diamond_transactions 
                 WHERE source = 'home_games' 
                   AND created_at > NOW() - INTERVAL '30 days'
            ), 0)
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
            'cron_jobs_active', (SELECT COUNT(*) FROM cron.job 
                                  WHERE active = true AND jobname LIKE 'home%' OR jobname LIKE 'pnm%'),
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
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_smarter_poker_pulse() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_smarter_poker_pulse() TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 3) Group quality score — 0-100 for each home group, surfaces to sort discovery
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE commander_home_groups 
    ADD COLUMN IF NOT EXISTS quality_score numeric;

CREATE OR REPLACE FUNCTION public.compute_home_group_quality_score(p_group_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group        RECORD;
    v_score        numeric := 0;
    v_avg_rating   numeric;
    v_completion   numeric;
    v_recency_days int;
    v_review_count int;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Logo: required for discovery
    IF v_group.profile_photo_url IS NOT NULL THEN v_score := v_score + 15; END IF;
    -- Description present
    IF v_group.description IS NOT NULL AND length(v_group.description) > 50 THEN v_score := v_score + 10; END IF;
    -- Tagline present
    IF v_group.tagline IS NOT NULL THEN v_score := v_score + 5; END IF;
    -- Location set
    IF v_group.city IS NOT NULL AND v_group.state IS NOT NULL THEN v_score := v_score + 8; END IF;
    IF v_group.location_geog IS NOT NULL THEN v_score := v_score + 4; END IF;
    -- Member traction (capped)
    v_score := v_score + LEAST(15, COALESCE(v_group.member_count, 0) * 1.5);
    -- Games hosted (capped)
    v_score := v_score + LEAST(20, COALESCE(v_group.games_hosted, 0) * 2.0);
    -- Recency bonus
    v_recency_days := EXTRACT(day FROM (NOW() - COALESCE(v_group.last_activity_at, v_group.created_at)))::int;
    IF v_recency_days <= 7 THEN v_score := v_score + 10;
    ELSIF v_recency_days <= 21 THEN v_score := v_score + 6;
    ELSIF v_recency_days <= 45 THEN v_score := v_score + 2;
    END IF;
    -- Reviews
    SELECT COALESCE(AVG(r.rating), 0), COUNT(*) 
      INTO v_avg_rating, v_review_count
      FROM commander_home_game_reviews r
      JOIN commander_home_games g ON g.id = r.game_id
     WHERE g.group_id = p_group_id;
    IF v_review_count >= 3 AND v_avg_rating >= 4.0 THEN v_score := v_score + 8;
    ELSIF v_review_count >= 1 AND v_avg_rating >= 3.5 THEN v_score := v_score + 4;
    END IF;
    -- Tags present
    IF v_group.tags IS NOT NULL AND array_length(v_group.tags, 1) > 0 THEN v_score := v_score + 3; END IF;
    -- Public visibility
    IF NOT v_group.is_private THEN v_score := v_score + 2; END IF;

    RETURN ROUND(LEAST(100, v_score), 1);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.compute_home_group_quality_score(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compute_home_group_quality_score(uuid) TO authenticated, service_role;

-- Batch update function to refresh all quality_scores
CREATE OR REPLACE FUNCTION public.fn_refresh_all_home_group_quality_scores()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_updated int := 0; v_group RECORD;
BEGIN
    FOR v_group IN SELECT id FROM commander_home_groups WHERE is_active = true LOOP
        UPDATE commander_home_groups 
           SET quality_score = public.compute_home_group_quality_score(v_group.id)
         WHERE id = v_group.id;
        v_updated := v_updated + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'groups_updated', v_updated);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_all_home_group_quality_scores() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_refresh_all_home_group_quality_scores() TO service_role;

-- Run once + schedule daily at 04:00 UTC
SELECT public.fn_refresh_all_home_group_quality_scores();

SELECT cron.schedule(
    'home-groups-quality-refresh',
    '0 4 * * *',
    $$SELECT public.fn_refresh_all_home_group_quality_scores();$$
);

-- Index it so the trending RPC can sort by it
CREATE INDEX IF NOT EXISTS idx_home_groups_quality_score 
    ON commander_home_groups (quality_score DESC NULLS LAST) 
    WHERE is_active = true AND NOT is_private;
