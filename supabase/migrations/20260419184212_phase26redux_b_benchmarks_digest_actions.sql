-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184212 "phase26redux_b_benchmarks_digest_actions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3ef1c1e9665c02205375e0dad605d92e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  PHASE 26 (redux) PART B — Benchmarks + Weekly Digest + Action Items
--  INFORMATION ONLY. No money.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 4) Anonymous host benchmarks — percentile rank vs similar groups
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_host_benchmarks(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_is_authorized boolean;
    v_member_bucket text;
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT (v_group.owner_id = p_caller_user_id 
            OR EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                          AND role IN ('owner','admin') AND status='approved'))
      INTO v_is_authorized;
    IF NOT v_is_authorized THEN RAISE EXCEPTION 'NOT_HOST_OR_ADMIN'; END IF;

    -- Size bucket for comparison peer set
    v_member_bucket := CASE 
        WHEN COALESCE(v_group.member_count, 0) < 5 THEN 'small (1-4)'
        WHEN COALESCE(v_group.member_count, 0) < 12 THEN 'medium (5-11)'
        WHEN COALESCE(v_group.member_count, 0) < 25 THEN 'large (12-24)'
        ELSE 'very_large (25+)' END;

    WITH peer_set AS (
        SELECT id, member_count, games_hosted, quality_score, vitality_score,
               COALESCE((SELECT COUNT(*) FROM commander_home_games g 
                          WHERE g.group_id = commander_home_groups.id 
                            AND g.status='completed' 
                            AND g.scheduled_date > NOW() - INTERVAL '90 days'), 0) AS completed_90d,
               COALESCE(view_count, 0) AS view_count,
               COALESCE(share_click_count, 0) AS share_click_count
          FROM commander_home_groups
         WHERE is_active = true
           AND (
                 (COALESCE(member_count,0) < 5  AND v_member_bucket = 'small (1-4)')
              OR (COALESCE(member_count,0) BETWEEN 5 AND 11  AND v_member_bucket = 'medium (5-11)')
              OR (COALESCE(member_count,0) BETWEEN 12 AND 24 AND v_member_bucket = 'large (12-24)')
              OR (COALESCE(member_count,0) >= 25 AND v_member_bucket = 'very_large (25+)')
           )
    ),
    my_stats AS (
        SELECT * FROM peer_set WHERE id = p_group_id
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'group_id', p_group_id,
        'size_bucket', v_member_bucket,
        'peer_count', (SELECT COUNT(*) FROM peer_set),
        'my_stats', (SELECT row_to_json(ms) FROM my_stats ms),
        'percentiles', jsonb_build_object(
            'games_completed_90d', COALESCE(
                (SELECT ROUND(100.0 * (COUNT(*) FILTER (WHERE completed_90d < (SELECT completed_90d FROM my_stats))) 
                              / NULLIF(COUNT(*), 0), 0) FROM peer_set), 0),
            'quality_score', COALESCE(
                (SELECT ROUND(100.0 * (COUNT(*) FILTER (WHERE quality_score < (SELECT quality_score FROM my_stats))) 
                              / NULLIF(COUNT(*), 0), 0) FROM peer_set WHERE quality_score IS NOT NULL), 0),
            'vitality_score', COALESCE(
                (SELECT ROUND(100.0 * (COUNT(*) FILTER (WHERE vitality_score < (SELECT vitality_score FROM my_stats))) 
                              / NULLIF(COUNT(*), 0), 0) FROM peer_set WHERE vitality_score IS NOT NULL), 0),
            'view_count', COALESCE(
                (SELECT ROUND(100.0 * (COUNT(*) FILTER (WHERE view_count < (SELECT view_count FROM my_stats))) 
                              / NULLIF(COUNT(*), 0), 0) FROM peer_set), 0)
        ),
        'peer_averages', jsonb_build_object(
            'avg_games_completed_90d', (SELECT ROUND(AVG(completed_90d), 1) FROM peer_set),
            'avg_quality_score', (SELECT ROUND(AVG(quality_score), 1) FROM peer_set WHERE quality_score IS NOT NULL),
            'avg_vitality_score', (SELECT ROUND(AVG(vitality_score), 1) FROM peer_set WHERE vitality_score IS NOT NULL),
            'avg_member_count', (SELECT ROUND(AVG(member_count), 1) FROM peer_set)
        )
    ) INTO v_result;

    RETURN v_result;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_host_benchmarks(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_host_benchmarks(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_host_benchmarks(uuid, uuid) IS
  'Phase 26 redux/B: Anonymous percentile rank vs similar-sized groups. No PII exposed.';

-- ────────────────────────────────────────────────────────────────────────
-- 5) Weekly host digest payload — structured data for weekly email
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_host_weekly_digest_payload(
    p_host_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_week_start timestamptz;
    v_week_prev_start timestamptz;
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_caller_user_id <> p_host_id THEN RAISE EXCEPTION 'CAN_ONLY_REQUEST_OWN_DIGEST'; END IF;

    -- Week starts Monday 00:00 UTC
    v_week_start := date_trunc('week', NOW());
    v_week_prev_start := v_week_start - INTERVAL '7 days';

    WITH my_groups AS (
        SELECT id, name, slug FROM commander_home_groups 
         WHERE owner_id = p_host_id AND is_active = true
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'host_id', p_host_id,
        'week_start', v_week_start,
        'prev_week_start', v_week_prev_start,
        'groups', (SELECT jsonb_agg(jsonb_build_object(
            'group_id', mg.id,
            'group_name', mg.name,
            'group_slug', mg.slug,
            'this_week', jsonb_build_object(
                'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                      WHERE group_id = mg.id AND status='completed'
                                        AND scheduled_date >= v_week_start),
                'games_upcoming', (SELECT COUNT(*) FROM commander_home_games 
                                     WHERE group_id = mg.id 
                                       AND status IN ('scheduled','confirmed')
                                       AND scheduled_date >= NOW()),
                'new_members', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = mg.id AND created_at >= v_week_start),
                'rsvps_received', (SELECT COUNT(*) FROM commander_home_rsvps r 
                                     JOIN commander_home_games g ON g.id = r.game_id
                                    WHERE g.group_id = mg.id AND r.responded_at >= v_week_start),
                'checkins', (SELECT COUNT(*) FROM commander_home_rsvps r 
                               JOIN commander_home_games g ON g.id = r.game_id
                              WHERE g.group_id = mg.id AND r.checked_in_at >= v_week_start),
                'posts', (SELECT COUNT(*) FROM commander_home_posts 
                           WHERE group_id = mg.id AND created_at >= v_week_start),
                'views', (SELECT SUM(coalesce(view_count,0)) FROM commander_home_groups WHERE id = mg.id)
            ),
            'last_week', jsonb_build_object(
                'games_completed', (SELECT COUNT(*) FROM commander_home_games 
                                      WHERE group_id = mg.id AND status='completed'
                                        AND scheduled_date BETWEEN v_week_prev_start AND v_week_start),
                'new_members', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = mg.id 
                                    AND created_at BETWEEN v_week_prev_start AND v_week_start),
                'rsvps_received', (SELECT COUNT(*) FROM commander_home_rsvps r 
                                     JOIN commander_home_games g ON g.id = r.game_id
                                    WHERE g.group_id = mg.id 
                                      AND r.responded_at BETWEEN v_week_prev_start AND v_week_start),
                'checkins', (SELECT COUNT(*) FROM commander_home_rsvps r 
                               JOIN commander_home_games g ON g.id = r.game_id
                              WHERE g.group_id = mg.id 
                                AND r.checked_in_at BETWEEN v_week_prev_start AND v_week_start)
            ),
            'scores', jsonb_build_object(
                'quality', (SELECT quality_score FROM commander_home_groups WHERE id = mg.id),
                'vitality', (SELECT vitality_score FROM commander_home_groups WHERE id = mg.id)
            ),
            'pending_approvals', (SELECT COUNT(*) FROM commander_home_members 
                                    WHERE group_id = mg.id AND status='pending'),
            'dormant_member_count', (SELECT COUNT(*) FROM commander_home_members m
                                       WHERE m.group_id = mg.id AND m.status='approved'
                                         AND (m.last_attended IS NULL 
                                              OR m.last_attended < NOW() - INTERVAL '60 days'))
        )) FROM my_groups mg)
    ) INTO v_result;

    RETURN v_result;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_host_weekly_digest_payload(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_host_weekly_digest_payload(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_host_weekly_digest_payload(uuid, uuid) IS
  'Phase 26 redux/B: Structured payload for weekly host email digest. Own-data only.';

-- ────────────────────────────────────────────────────────────────────────
-- 6) Action items — top 3-5 recommended actions based on current data
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_host_action_items(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_is_authorized boolean;
    v_actions jsonb := '[]'::jsonb;
    v_pending_approvals int;
    v_dormant_members int;
    v_next_game_days_away int;
    v_has_upcoming boolean;
    v_posts_30d int;
    v_view_count int;
    v_logo_missing boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT (v_group.owner_id = p_caller_user_id 
            OR EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                          AND role IN ('owner','admin') AND status='approved'))
      INTO v_is_authorized;
    IF NOT v_is_authorized THEN RAISE EXCEPTION 'NOT_HOST_OR_ADMIN'; END IF;

    -- Gather signals
    SELECT COUNT(*) INTO v_pending_approvals FROM commander_home_members 
      WHERE group_id = p_group_id AND status='pending';
    SELECT COUNT(*) INTO v_dormant_members FROM commander_home_members 
      WHERE group_id = p_group_id AND status='approved'
        AND (last_attended IS NULL OR last_attended < NOW() - INTERVAL '60 days');
    SELECT COUNT(*) > 0 INTO v_has_upcoming FROM commander_home_games 
      WHERE group_id = p_group_id AND status IN ('scheduled','confirmed') 
        AND scheduled_date >= NOW();
    IF v_has_upcoming THEN
        SELECT EXTRACT(day FROM (MIN(scheduled_date::timestamptz) - NOW()))::int 
          INTO v_next_game_days_away
          FROM commander_home_games 
         WHERE group_id = p_group_id AND status IN ('scheduled','confirmed') 
           AND scheduled_date >= NOW();
    END IF;
    SELECT COUNT(*) INTO v_posts_30d FROM commander_home_posts 
      WHERE group_id = p_group_id AND created_at > NOW() - INTERVAL '30 days';
    v_view_count := COALESCE(v_group.view_count, 0);
    v_logo_missing := v_group.profile_photo_url IS NULL;

    -- High priority actions first
    IF v_pending_approvals > 0 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high',
            'type', 'review_pending_members',
            'label', 'Review ' || v_pending_approvals || ' pending member request(s)',
            'count', v_pending_approvals,
            'impact', 'Members waiting for approval cannot RSVP or participate'
        );
    END IF;

    IF NOT v_has_upcoming THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high',
            'type', 'schedule_next_game',
            'label', 'Schedule your next game',
            'impact', 'No upcoming games means no RSVPs, no check-ins, and vitality drops fast'
        );
    ELSIF v_next_game_days_away > 14 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium',
            'type', 'add_sooner_game',
            'label', 'Add a game within the next 2 weeks (next is ' || v_next_game_days_away || ' days out)',
            'impact', 'Groups with weekly+ cadence see 3x the engagement'
        );
    END IF;

    IF v_logo_missing THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high',
            'type', 'upload_logo',
            'label', 'Upload a group logo/photo',
            'impact', 'Groups without a photo are hidden from public discovery'
        );
    END IF;

    IF v_dormant_members >= 3 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium',
            'type', 'reengage_dormant',
            'label', 'Re-engage ' || v_dormant_members || ' dormant member(s)',
            'count', v_dormant_members,
            'impact', 'Dormant regulars often return with a personal nudge'
        );
    END IF;

    IF v_posts_30d = 0 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium',
            'type', 'post_update',
            'label', 'Share a group post — it''s been a while',
            'impact', 'Active groups post at least weekly'
        );
    END IF;

    IF v_group.description IS NULL OR length(COALESCE(v_group.description, '')) < 50 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'low',
            'type', 'improve_description',
            'label', 'Write a fuller group description',
            'impact', 'Helps new members understand what your group is about'
        );
    END IF;

    IF v_view_count = 0 AND NOT v_group.is_private THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'low',
            'type', 'share_group_link',
            'label', 'Share your group link to drive discovery',
            'impact', 'Public groups with shared links grow 4x faster'
        );
    END IF;

    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'group_id', p_group_id,
        'action_count', jsonb_array_length(v_actions),
        'actions', v_actions
    );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_host_action_items(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_host_action_items(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_host_action_items(uuid, uuid) IS
  'Phase 26 redux/B: Top recommended actions for host based on current group state.';
