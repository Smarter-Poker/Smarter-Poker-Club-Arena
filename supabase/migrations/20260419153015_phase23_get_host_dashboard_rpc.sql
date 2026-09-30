-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419153015 "phase23_get_host_dashboard_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6e615f92476dd6682e1424fc8e1ca6f5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 23 — get_host_dashboard RPC
--  -----------------------------------------------------------------------
--  Consolidated dashboard data for the host UI. One round-trip replacing
--  what would otherwise be 7-8 separate queries.
--
--  Authorization: caller must be owner OR admin of the target group.
--  'member' role does not see the host dashboard.
--
--  Returns JSONB with sections:
--    group            — core meta + slug + visibility status
--    stats            — counts (members, pending, upcoming, completed)
--    visibility       — reason, days_stale, can_revive, is_override
--    upcoming_games   — next 10 with RSVP breakdown
--    recent_games     — last 5 completed games
--    pending_requests — last 20 users awaiting approval
--    recent_members   — last 5 approved joiners
--    recent_posts     — last 5 posts in the group
--    review_summary   — aggregate avg rating + count
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_host_dashboard(
    p_group_id         uuid,
    p_caller_user_id   uuid,
    p_inactivity_days  int DEFAULT 45
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_group            RECORD;
    v_caller_role      text;
    v_is_visible       boolean;
    v_reason           text;
    v_days_stale       int;
    v_is_override      boolean;
    v_slug             text;

    v_stats            jsonb;
    v_upcoming         jsonb;
    v_recent_games     jsonb;
    v_pending          jsonb;
    v_recent_members   jsonb;
    v_recent_posts     jsonb;
    v_review_summary   jsonb;
BEGIN
    -- Auth guard
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED' 
              USING HINT = 'get_host_dashboard requires auth.uid() = p_caller_user_id';
    END IF;

    -- Load group
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GROUP_NOT_FOUND';
    END IF;

    -- Authorization: owner or approved admin only
    IF v_group.owner_id = p_caller_user_id THEN
        v_caller_role := 'owner';
    ELSE
        SELECT role INTO v_caller_role
          FROM commander_home_members
         WHERE group_id = p_group_id
           AND user_id  = p_caller_user_id
           AND status   = 'approved'
           AND role IN ('admin','owner');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'NOT_A_HOST' 
                  USING HINT = 'get_host_dashboard requires owner or admin role';
        END IF;
    END IF;

    -- Resolve slug for routing
    SELECT sp.slug INTO v_slug
      FROM social_pages sp
     WHERE sp.linked_entity_type = 'home_group'
       AND sp.linked_entity_id = v_group.id::text
     LIMIT 1;

    -- Compute visibility (same logic as get_home_group_visibility_status)
    v_is_override := (v_group.visibility_override_until IS NOT NULL 
                      AND v_group.visibility_override_until > NOW());
    v_days_stale  := CASE
                       WHEN v_group.last_activity_at IS NULL THEN NULL
                       ELSE GREATEST(0, EXTRACT(day FROM (NOW() - v_group.last_activity_at))::int)
                     END;
    v_is_visible  := CASE
                       WHEN NOT v_group.is_active THEN false
                       WHEN v_group.is_private THEN false  -- from public discovery POV
                       WHEN v_is_override THEN true
                       WHEN v_group.last_activity_at IS NULL THEN false
                       WHEN v_group.last_activity_at < NOW() - (p_inactivity_days || ' days')::interval THEN false
                       ELSE true
                     END;
    v_reason      := CASE
                       WHEN NOT v_group.is_active THEN 'inactive'
                       WHEN v_group.is_private THEN 'private'
                       WHEN v_is_override THEN 'override_active'
                       WHEN v_group.last_activity_at IS NULL THEN 'no_activity'
                       WHEN v_group.last_activity_at < NOW() - (p_inactivity_days || ' days')::interval THEN 'stale'
                       ELSE 'visible'
                     END;

    -- Stats
    SELECT jsonb_build_object(
        'total_members',      (SELECT COUNT(*) FROM commander_home_members 
                                WHERE group_id = p_group_id AND status = 'approved'),
        'pending_requests',   (SELECT COUNT(*) FROM commander_home_members 
                                WHERE group_id = p_group_id AND status = 'pending'),
        'banned_members',     (SELECT COUNT(*) FROM commander_home_members 
                                WHERE group_id = p_group_id AND status = 'banned'),
        'upcoming_games',     (SELECT COUNT(*) FROM commander_home_games 
                                WHERE group_id = p_group_id 
                                  AND status IN ('scheduled','confirmed')
                                  AND scheduled_date >= CURRENT_DATE),
        'completed_last_30d', (SELECT COUNT(*) FROM commander_home_games 
                                WHERE group_id = p_group_id 
                                  AND status = 'completed'
                                  AND scheduled_date >= CURRENT_DATE - 30),
        'total_games_hosted', COALESCE(v_group.games_hosted, 0)
    ) INTO v_stats;

    -- Upcoming games (next 10) with RSVP breakdown
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY sort_key), '[]'::jsonb) INTO v_upcoming
      FROM (
        SELECT
            jsonb_build_object(
                'id', hg.id,
                'title', hg.title,
                'scheduled_date', hg.scheduled_date,
                'start_time', hg.start_time,
                'end_time', hg.end_time,
                'game_type', hg.game_type,
                'stakes', hg.stakes,
                'format', hg.format,
                'buyin_min', hg.buyin_min,
                'buyin_max', hg.buyin_max,
                'max_players', hg.max_players,
                'min_players', hg.min_players,
                'status', hg.status,
                'allow_guests', hg.allow_guests,
                'rsvp_yes', COALESCE(hg.rsvp_yes, 0),
                'rsvp_maybe', COALESCE(hg.rsvp_maybe, 0),
                'rsvp_no', COALESCE(hg.rsvp_no, 0),
                'waitlist_count', COALESCE(hg.waitlist_count, 0),
                'seats_available', GREATEST(0, COALESCE(hg.max_players, 9) - COALESCE(hg.rsvp_yes, 0))
            ) AS row_payload,
            (hg.scheduled_date::text || ' ' || COALESCE(hg.start_time::text, '00:00')) AS sort_key
          FROM commander_home_games hg
         WHERE hg.group_id = p_group_id
           AND hg.status IN ('scheduled','confirmed','draft')
           AND hg.scheduled_date >= CURRENT_DATE
         ORDER BY hg.scheduled_date, hg.start_time
         LIMIT 10
      ) x;

    -- Recent completed games (last 5)
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY sort_key DESC), '[]'::jsonb) INTO v_recent_games
      FROM (
        SELECT
            jsonb_build_object(
                'id', hg.id,
                'title', hg.title,
                'scheduled_date', hg.scheduled_date,
                'status', hg.status,
                'format', hg.format,
                'rsvp_yes_final', COALESCE(hg.rsvp_yes, 0)
            ) AS row_payload,
            hg.scheduled_date AS sort_key
          FROM commander_home_games hg
         WHERE hg.group_id = p_group_id
           AND hg.status IN ('completed','cancelled')
         ORDER BY hg.scheduled_date DESC
         LIMIT 5
      ) x;

    -- Pending member requests (last 20)
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY sort_key DESC), '[]'::jsonb) INTO v_pending
      FROM (
        SELECT
            jsonb_build_object(
                'member_id', m.id,
                'user_id', m.user_id,
                'username', COALESCE(p.display_name, p.full_name, p.username, 'Unknown'),
                'avatar_url', p.avatar_url,
                'requested_at', m.created_at,
                'invited_by', m.invited_by
            ) AS row_payload,
            m.created_at AS sort_key
          FROM commander_home_members m
          LEFT JOIN profiles p ON p.id = m.user_id
         WHERE m.group_id = p_group_id
           AND m.status = 'pending'
         ORDER BY m.created_at DESC
         LIMIT 20
      ) x;

    -- Recent joiners (last 5 approved)
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY sort_key DESC), '[]'::jsonb) INTO v_recent_members
      FROM (
        SELECT
            jsonb_build_object(
                'user_id', m.user_id,
                'username', COALESCE(p.display_name, p.full_name, p.username, 'Unknown'),
                'avatar_url', p.avatar_url,
                'role', m.role,
                'joined_at', m.joined_at,
                'games_attended', COALESCE(m.games_attended, 0)
            ) AS row_payload,
            COALESCE(m.joined_at, m.created_at) AS sort_key
          FROM commander_home_members m
          LEFT JOIN profiles p ON p.id = m.user_id
         WHERE m.group_id = p_group_id
           AND m.status = 'approved'
           AND m.user_id <> v_group.owner_id
         ORDER BY COALESCE(m.joined_at, m.created_at) DESC
         LIMIT 5
      ) x;

    -- Recent posts (last 5)
    SELECT COALESCE(jsonb_agg(row_payload ORDER BY sort_key DESC), '[]'::jsonb) INTO v_recent_posts
      FROM (
        SELECT
            jsonb_build_object(
                'id', pst.id,
                'author_id', pst.author_id,
                'author_name', COALESCE(p.display_name, p.full_name, p.username),
                'content', LEFT(COALESCE(pst.content, ''), 280),
                'post_type', pst.post_type,
                'is_pinned', pst.is_pinned,
                'likes_count', COALESCE(pst.likes_count, 0),
                'comments_count', COALESCE(pst.comments_count, 0),
                'created_at', pst.created_at
            ) AS row_payload,
            pst.created_at AS sort_key
          FROM commander_home_posts pst
          LEFT JOIN profiles p ON p.id = pst.author_id
         WHERE pst.group_id = p_group_id
           AND COALESCE(pst.is_published, true) = true
         ORDER BY pst.created_at DESC
         LIMIT 5
      ) x;

    -- Review summary
    SELECT jsonb_build_object(
        'count',      COALESCE(COUNT(*), 0),
        'avg_rating', ROUND(COALESCE(AVG(r.rating)::numeric, 0), 2)
    ) INTO v_review_summary
      FROM commander_home_game_reviews r
      JOIN commander_home_games hg ON hg.id = r.game_id
     WHERE hg.group_id = p_group_id;

    -- Assemble final payload
    RETURN jsonb_build_object(
        'success', true,
        'caller_role', v_caller_role,
        'group', jsonb_build_object(
            'id', v_group.id,
            'slug', v_slug,
            'name', v_group.name,
            'tagline', v_group.tagline,
            'description', v_group.description,
            'profile_photo_url', v_group.profile_photo_url,
            'cover_photo_url', v_group.cover_photo_url,
            'city', v_group.city,
            'state', v_group.state,
            'is_private', v_group.is_private,
            'is_active', v_group.is_active,
            'default_game_type', v_group.default_game_type,
            'default_stakes', v_group.default_stakes,
            'typical_buyin_min', v_group.typical_buyin_min,
            'typical_buyin_max', v_group.typical_buyin_max,
            'max_players', v_group.max_players,
            'frequency', v_group.frequency,
            'typical_day', v_group.typical_day,
            'typical_time', v_group.typical_time,
            'club_code', v_group.club_code,
            'invite_code', v_group.invite_code,
            'created_at', v_group.created_at
        ),
        'visibility', jsonb_build_object(
            'is_visible', v_is_visible,
            'reason', v_reason,
            'days_stale', v_days_stale,
            'threshold_days', p_inactivity_days,
            'last_activity_at', v_group.last_activity_at,
            'visibility_override_until', v_group.visibility_override_until,
            'is_override_active', v_is_override,
            'can_revive', (v_reason = 'stale' OR v_reason = 'no_activity'),
            'warning_sent_at', v_group.inactivity_warning_sent_at,
            'hidden_notice_sent_at', v_group.inactivity_hidden_sent_at
        ),
        'stats', v_stats,
        'upcoming_games', v_upcoming,
        'recent_games', v_recent_games,
        'pending_requests', v_pending,
        'recent_members', v_recent_members,
        'recent_posts', v_recent_posts,
        'review_summary', v_review_summary
    );
END;
$fn$;

-- Clean ACL — authenticated + service_role only
REVOKE EXECUTE ON FUNCTION public.get_host_dashboard(uuid, uuid, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_host_dashboard(uuid, uuid, int) 
    TO authenticated, service_role;

COMMENT ON FUNCTION public.get_host_dashboard(uuid, uuid, int) IS
  'Phase 23: Consolidated host dashboard fetch. Authorization: caller must be group owner or approved admin. Returns 8-section JSONB replacing 7-8 separate queries.';
