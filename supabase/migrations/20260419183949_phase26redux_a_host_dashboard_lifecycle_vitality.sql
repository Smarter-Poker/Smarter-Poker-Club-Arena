-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419183949 "phase26redux_a_host_dashboard_lifecycle_vitality"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7e6845e736ff27600b7a34e1dc0c715e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  PHASE 26 (redux) PART A — Host Growth Analytics
--  INFORMATION ONLY. No money. No fees. No escrow. No transactions.
--  Every RPC here returns read-only analytics for hosts about their own group.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1) Host deep dashboard — one-call comprehensive host analytics
-- ────────────────────────────────────────────────────────────────────────
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

    -- Only owner + admins get deep dashboard
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
            'id', v_group.id,
            'name', v_group.name,
            'created_at', v_group.created_at,
            'member_count', v_group.member_count,
            'games_hosted', v_group.games_hosted,
            'last_activity_at', v_group.last_activity_at,
            'quality_score', v_group.quality_score,
            'is_private', v_group.is_private,
            'frequency', v_group.frequency
        ),
        'attendance', jsonb_build_object(
            'games_in_window', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id 
                                   AND scheduled_date >= v_cutoff),
            'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status='completed'
                                   AND scheduled_date >= v_cutoff),
            'games_cancelled', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status='cancelled'
                                   AND scheduled_date >= v_cutoff),
            'avg_rsvp_yes', COALESCE((
                SELECT ROUND(AVG(rsvp_yes_count), 1) FROM commander_home_games 
                 WHERE group_id = p_group_id AND scheduled_date >= v_cutoff
            ), 0),
            'avg_attendance', COALESCE((
                SELECT ROUND(AVG(cnt), 1) FROM (
                    SELECT g.id, COUNT(r.id) AS cnt
                      FROM commander_home_games g
                      LEFT JOIN commander_home_rsvps r ON r.game_id = g.id AND r.checked_in_at IS NOT NULL
                     WHERE g.group_id = p_group_id AND g.status='completed' AND g.scheduled_date >= v_cutoff
                     GROUP BY g.id
                ) t
            ), 0),
            'flake_rate_pct', COALESCE((
                SELECT CASE WHEN SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END) = 0 THEN 0
                            ELSE ROUND(100.0 * SUM(CASE WHEN r.flaked THEN 1 ELSE 0 END)::numeric / 
                                       NULLIF(SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END), 0), 1) END
                  FROM commander_home_rsvps r
                  JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id AND g.scheduled_date >= v_cutoff
            ), 0)
        ),
        'members', jsonb_build_object(
            'total_approved', (SELECT COUNT(*) FROM commander_home_members 
                                WHERE group_id = p_group_id AND status='approved'),
            'joined_in_window', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = p_group_id AND created_at >= v_cutoff),
            'pending_approval', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = p_group_id AND status='pending'),
            'banned', (SELECT COUNT(*) FROM commander_home_members 
                        WHERE group_id = p_group_id AND status='banned'),
            'regulars', (SELECT COUNT(*) FROM commander_home_members 
                          WHERE group_id = p_group_id AND is_regular = true),
            'with_flake_strikes', (SELECT COUNT(*) FROM commander_home_members 
                                    WHERE group_id = p_group_id AND flake_strikes > 0)
        ),
        'content', jsonb_build_object(
            'posts_in_window', (SELECT COUNT(*) FROM commander_home_posts 
                                 WHERE group_id = p_group_id AND created_at >= v_cutoff),
            'total_post_likes', COALESCE((
                SELECT COUNT(*) FROM commander_home_post_likes pl
                  JOIN commander_home_posts p ON p.id = pl.post_id
                 WHERE p.group_id = p_group_id AND pl.created_at >= v_cutoff
            ), 0),
            'total_post_comments', COALESCE((
                SELECT COUNT(*) FROM commander_home_post_comments pc
                  JOIN commander_home_posts p ON p.id = pc.post_id
                 WHERE p.group_id = p_group_id AND pc.created_at >= v_cutoff
            ), 0)
        ),
        'discovery', jsonb_build_object(
            'view_count', COALESCE(v_group.view_count, 0),
            'share_click_count', COALESCE(v_group.share_click_count, 0),
            'follower_count', (SELECT COUNT(*) FROM commander_home_group_follows 
                                WHERE group_id = p_group_id)
        ),
        'reminder_effectiveness', jsonb_build_object(
            'sent_6h_count', COALESCE((
                SELECT COUNT(*) FROM commander_home_rsvps r
                  JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id 
                   AND r.reminder_6h_sent_at >= v_cutoff
            ), 0),
            'sent_1h_count', COALESCE((
                SELECT COUNT(*) FROM commander_home_rsvps r
                  JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id 
                   AND r.reminder_1h_sent_at >= v_cutoff
            ), 0),
            'reminder_to_checkin_rate_pct', COALESCE((
                SELECT CASE WHEN COUNT(*) FILTER (WHERE r.reminder_1h_sent_at IS NOT NULL) = 0 THEN 0
                            ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE r.checked_in_at IS NOT NULL 
                                                                  AND r.reminder_1h_sent_at IS NOT NULL)::numeric
                                       / NULLIF(COUNT(*) FILTER (WHERE r.reminder_1h_sent_at IS NOT NULL), 0), 1) END
                  FROM commander_home_rsvps r
                  JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id AND r.reminder_1h_sent_at >= v_cutoff
            ), 0)
        )
    ) INTO v_result;

    RETURN v_result;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_host_group_deep_dashboard(uuid, uuid, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_host_group_deep_dashboard(uuid, uuid, int) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_host_group_deep_dashboard(uuid, uuid, int) IS
  'Phase 26 redux/A: Read-only host dashboard. No money/escrow/fees involved.';

-- ────────────────────────────────────────────────────────────────────────
-- 2) Member lifecycle segmentation — actionable intelligence for hosts
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_member_lifecycle_segments(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_is_authorized boolean; v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT EXISTS (SELECT 1 FROM commander_home_groups 
                    WHERE id = p_group_id AND owner_id = p_caller_user_id)
        OR EXISTS (SELECT 1 FROM commander_home_members 
                    WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                      AND role IN ('owner','admin') AND status='approved')
      INTO v_is_authorized;
    IF NOT v_is_authorized THEN RAISE EXCEPTION 'NOT_HOST_OR_ADMIN'; END IF;

    WITH member_activity AS (
        SELECT 
            m.user_id,
            m.created_at AS joined_at,
            m.is_regular,
            m.flake_strikes,
            m.games_attended,
            m.last_attended,
            -- games attended in last 30 / 60 / 90 days
            (SELECT COUNT(*) FROM commander_home_rsvps r 
              JOIN commander_home_games g ON g.id = r.game_id
             WHERE r.user_id = m.user_id AND g.group_id = p_group_id
               AND r.checked_in_at > NOW() - INTERVAL '30 days') AS attended_30d,
            (SELECT COUNT(*) FROM commander_home_rsvps r 
              JOIN commander_home_games g ON g.id = r.game_id
             WHERE r.user_id = m.user_id AND g.group_id = p_group_id
               AND r.checked_in_at > NOW() - INTERVAL '90 days') AS attended_90d,
            EXTRACT(day FROM (NOW() - m.created_at))::int AS days_since_join,
            EXTRACT(day FROM (NOW() - COALESCE(m.last_attended, m.created_at)))::int AS days_since_last_attended
          FROM commander_home_members m
         WHERE m.group_id = p_group_id AND m.status = 'approved'
    ),
    segmented AS (
        SELECT *, 
            CASE
                WHEN days_since_join <= 14 AND games_attended = 0 THEN 'new_never_attended'
                WHEN days_since_join <= 14 THEN 'new'
                WHEN attended_30d >= 3 THEN 'core'
                WHEN attended_30d >= 1 THEN 'active'
                WHEN attended_90d >= 1 AND days_since_last_attended <= 60 THEN 'drifting'
                WHEN days_since_last_attended BETWEEN 61 AND 120 THEN 'dormant'
                WHEN games_attended = 0 AND days_since_join > 60 THEN 'never_attended'
                ELSE 'churned'
            END AS segment
          FROM member_activity
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'segment_counts', (SELECT jsonb_object_agg(segment, cnt) FROM (
             SELECT segment, COUNT(*) AS cnt FROM segmented GROUP BY segment
           ) t),
        'members', jsonb_agg(jsonb_build_object(
            'user_id', user_id, 
            'segment', segment,
            'joined_at', joined_at,
            'games_attended_total', games_attended,
            'attended_30d', attended_30d,
            'attended_90d', attended_90d,
            'days_since_last_attended', days_since_last_attended,
            'is_regular', is_regular,
            'flake_strikes', flake_strikes
        ) ORDER BY attended_30d DESC, attended_90d DESC)
    ) INTO v_result
      FROM segmented;

    RETURN v_result;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_member_lifecycle_segments(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_member_lifecycle_segments(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_member_lifecycle_segments(uuid, uuid) IS
  'Phase 26 redux/A: Member segmentation for host re-engagement. Read-only, no money involved.';

-- ────────────────────────────────────────────────────────────────────────
-- 3) Group vitality score — 0-100 ongoing health (≠ quality_score discovery)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_group_vitality_score(p_group_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_score numeric := 0;
    v_games_30d int;
    v_games_90d int;
    v_attended_30d int;
    v_flake_rate numeric;
    v_active_members int;
    v_total_members int;
    v_posts_30d int;
BEGIN
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Games scheduled/completed (0-25)
    SELECT COUNT(*) INTO v_games_30d FROM commander_home_games
      WHERE group_id = p_group_id AND scheduled_date >= NOW() - INTERVAL '30 days';
    v_score := v_score + LEAST(25, v_games_30d * 6);

    -- Forward-looking games (0-15)
    v_score := v_score + LEAST(15, (SELECT COUNT(*) FROM commander_home_games 
                                     WHERE group_id = p_group_id 
                                       AND scheduled_date >= NOW() 
                                       AND status IN ('scheduled','confirmed')) * 5);

    -- Attendance vitality (0-20)
    SELECT COUNT(DISTINCT r.user_id) INTO v_attended_30d
      FROM commander_home_rsvps r
      JOIN commander_home_games g ON g.id = r.game_id
     WHERE g.group_id = p_group_id AND r.checked_in_at > NOW() - INTERVAL '30 days';
    v_score := v_score + LEAST(20, v_attended_30d * 2);

    -- Active member ratio (0-15)
    SELECT COUNT(*) INTO v_total_members FROM commander_home_members 
      WHERE group_id = p_group_id AND status='approved';
    SELECT COUNT(DISTINCT m.user_id) INTO v_active_members
      FROM commander_home_members m
      LEFT JOIN commander_home_rsvps r ON r.user_id = m.user_id
      LEFT JOIN commander_home_games g ON g.id = r.game_id AND g.group_id = p_group_id
     WHERE m.group_id = p_group_id AND m.status='approved'
       AND (r.responded_at > NOW() - INTERVAL '60 days' OR m.last_attended > NOW() - INTERVAL '60 days');
    IF v_total_members > 0 THEN
        v_score := v_score + LEAST(15, (v_active_members::numeric / v_total_members) * 15);
    END IF;

    -- Content life (0-10)
    SELECT COUNT(*) INTO v_posts_30d FROM commander_home_posts 
      WHERE group_id = p_group_id AND created_at > NOW() - INTERVAL '30 days';
    v_score := v_score + LEAST(10, v_posts_30d * 2);

    -- Flake rate penalty (0 to -15)
    SELECT CASE WHEN SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END) = 0 THEN 0
                ELSE 100.0 * SUM(CASE WHEN r.flaked THEN 1 ELSE 0 END)::numeric / 
                     NULLIF(SUM(CASE WHEN r.response='yes' THEN 1 ELSE 0 END), 0) END
      INTO v_flake_rate
      FROM commander_home_rsvps r
      JOIN commander_home_games g ON g.id = r.game_id
     WHERE g.group_id = p_group_id AND r.responded_at > NOW() - INTERVAL '60 days';
    v_score := v_score - LEAST(15, (COALESCE(v_flake_rate, 0) / 100) * 15);

    -- Recency bonus/penalty (0-15)
    DECLARE v_recency_days int := EXTRACT(day FROM (NOW() - COALESCE(v_group.last_activity_at, v_group.created_at)))::int;
    BEGIN
        IF v_recency_days <= 7 THEN v_score := v_score + 15;
        ELSIF v_recency_days <= 21 THEN v_score := v_score + 10;
        ELSIF v_recency_days <= 45 THEN v_score := v_score + 3;
        ELSIF v_recency_days > 90 THEN v_score := v_score - 10;
        END IF;
    END;

    RETURN ROUND(GREATEST(0, LEAST(100, v_score)), 1);
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.compute_group_vitality_score(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compute_group_vitality_score(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.compute_group_vitality_score(uuid) IS
  'Phase 26 redux/A: 0-100 ongoing vitality score. Distinct from quality_score (which drives discovery). No money.';

-- Storage column + batch refresh
ALTER TABLE commander_home_groups 
    ADD COLUMN IF NOT EXISTS vitality_score numeric,
    ADD COLUMN IF NOT EXISTS vitality_refreshed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_home_groups_vitality 
    ON commander_home_groups (vitality_score DESC NULLS LAST) 
    WHERE is_active = true;

CREATE OR REPLACE FUNCTION public.fn_refresh_all_vitality_scores()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_updated int := 0; v_group RECORD;
BEGIN
    FOR v_group IN SELECT id FROM commander_home_groups WHERE is_active = true LOOP
        UPDATE commander_home_groups 
           SET vitality_score = public.compute_group_vitality_score(v_group.id),
               vitality_refreshed_at = NOW()
         WHERE id = v_group.id;
        v_updated := v_updated + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'updated', v_updated);
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.fn_refresh_all_vitality_scores() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_refresh_all_vitality_scores() TO service_role;

-- Seed values + schedule daily 04:15 UTC
SELECT public.fn_refresh_all_vitality_scores();

SELECT cron.schedule(
    'home-groups-vitality-refresh',
    '15 4 * * *',
    $$SELECT public.fn_refresh_all_vitality_scores();$$
);
