-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184042 "phase26redux_a_fix_rsvp_column_name"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 78f833d3228c6533ccda9f568355606b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: commander_home_games column is `rsvp_yes` not `rsvp_yes_count`
CREATE OR REPLACE FUNCTION public.get_host_group_deep_dashboard(
    p_group_id        uuid,
    p_caller_user_id  uuid,
    p_days            int DEFAULT 90
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group       RECORD;
    v_cutoff      timestamptz;
    v_result      jsonb;
    v_is_authorized boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    v_cutoff := NOW() - (p_days || ' days')::interval;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT (v_group.owner_id = p_caller_user_id 
            OR EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                          AND role IN ('owner','admin') AND status='approved'))
      INTO v_is_authorized;
    IF NOT v_is_authorized THEN RAISE EXCEPTION 'NOT_HOST_OR_ADMIN'; END IF;

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window_days', p_days,
        'group', jsonb_build_object(
            'id', v_group.id, 'name', v_group.name, 'created_at', v_group.created_at,
            'member_count', v_group.member_count, 'games_hosted', v_group.games_hosted,
            'last_activity_at', v_group.last_activity_at, 'quality_score', v_group.quality_score,
            'vitality_score', v_group.vitality_score,
            'is_private', v_group.is_private, 'frequency', v_group.frequency
        ),
        'attendance', jsonb_build_object(
            'games_in_window', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND scheduled_date >= v_cutoff),
            'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status='completed' AND scheduled_date >= v_cutoff),
            'games_cancelled', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status='cancelled' AND scheduled_date >= v_cutoff),
            'avg_rsvp_yes', COALESCE((SELECT ROUND(AVG(rsvp_yes), 1) FROM commander_home_games 
                                        WHERE group_id = p_group_id AND scheduled_date >= v_cutoff), 0),
            'avg_attendance', COALESCE((SELECT ROUND(AVG(cnt), 1) FROM (
                    SELECT g.id, COUNT(r.id) AS cnt FROM commander_home_games g
                      LEFT JOIN commander_home_rsvps r ON r.game_id = g.id AND r.checked_in_at IS NOT NULL
                     WHERE g.group_id = p_group_id AND g.status='completed' AND g.scheduled_date >= v_cutoff
                     GROUP BY g.id) t), 0),
            'flake_rate_pct', COALESCE((
                SELECT CASE WHEN SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END) = 0 THEN 0
                            ELSE ROUND(100.0 * SUM(CASE WHEN r.flaked THEN 1 ELSE 0 END)::numeric / 
                                       NULLIF(SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END), 0), 1) END
                  FROM commander_home_rsvps r JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id AND g.scheduled_date >= v_cutoff), 0)
        ),
        'members', jsonb_build_object(
            'total_approved', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND status='approved'),
            'joined_in_window', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND created_at >= v_cutoff),
            'pending_approval', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND status='pending'),
            'banned', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND status='banned'),
            'regulars', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND is_regular = true),
            'with_flake_strikes', (SELECT COUNT(*) FROM commander_home_members WHERE group_id = p_group_id AND flake_strikes > 0)
        ),
        'content', jsonb_build_object(
            'posts_in_window', (SELECT COUNT(*) FROM commander_home_posts WHERE group_id = p_group_id AND created_at >= v_cutoff),
            'total_post_likes', COALESCE((SELECT COUNT(*) FROM commander_home_post_likes pl
                                            JOIN commander_home_posts p ON p.id = pl.post_id
                                           WHERE p.group_id = p_group_id AND pl.created_at >= v_cutoff), 0),
            'total_post_comments', COALESCE((SELECT COUNT(*) FROM commander_home_post_comments pc
                                               JOIN commander_home_posts p ON p.id = pc.post_id
                                              WHERE p.group_id = p_group_id AND pc.created_at >= v_cutoff), 0)
        ),
        'discovery', jsonb_build_object(
            'view_count', COALESCE(v_group.view_count, 0),
            'share_click_count', COALESCE(v_group.share_click_count, 0),
            'follower_count', (SELECT COUNT(*) FROM commander_home_group_follows WHERE group_id = p_group_id)
        ),
        'reminder_effectiveness', jsonb_build_object(
            'sent_6h_count', COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r
                                         JOIN commander_home_games g ON g.id = r.game_id
                                        WHERE g.group_id = p_group_id AND r.reminder_6h_sent_at >= v_cutoff), 0),
            'sent_1h_count', COALESCE((SELECT COUNT(*) FROM commander_home_rsvps r
                                         JOIN commander_home_games g ON g.id = r.game_id
                                        WHERE g.group_id = p_group_id AND r.reminder_1h_sent_at >= v_cutoff), 0),
            'reminder_to_checkin_rate_pct', COALESCE((
                SELECT CASE WHEN COUNT(*) FILTER (WHERE r.reminder_1h_sent_at IS NOT NULL) = 0 THEN 0
                            ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE r.checked_in_at IS NOT NULL 
                                                                  AND r.reminder_1h_sent_at IS NOT NULL)::numeric
                                       / NULLIF(COUNT(*) FILTER (WHERE r.reminder_1h_sent_at IS NOT NULL), 0), 1) END
                  FROM commander_home_rsvps r JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id AND r.reminder_1h_sent_at >= v_cutoff), 0)
        )
    ) INTO v_result;

    RETURN v_result;
END; $fn$;
