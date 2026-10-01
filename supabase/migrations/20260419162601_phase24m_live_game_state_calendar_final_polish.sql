-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419162601 "phase24m_live_game_state_calendar_final_polish"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 74935d5ae1c4d0865e9e7c7b949176d5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART M — Live game state + personal calendar + edge-case columns
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Final schema additions
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE commander_home_games
    ADD COLUMN IF NOT EXISTS rsvp_closes_at timestamptz,
    ADD COLUMN IF NOT EXISTS rsvps_closed boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS notes_for_attendees text;  -- shown only to yes-RSVPs

ALTER TABLE commander_home_groups
    ADD COLUMN IF NOT EXISTS is_21_plus boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_charity boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS charity_beneficiary text,
    ADD COLUMN IF NOT EXISTS smoking_policy text CHECK (
        smoking_policy IS NULL OR smoking_policy IN ('smoking_ok','outside_only','non_smoking')
    );

COMMENT ON COLUMN commander_home_games.rsvp_closes_at IS
  'Phase 24/M: optional RSVP deadline; after this time responses are rejected';
COMMENT ON COLUMN commander_home_games.notes_for_attendees IS
  'Phase 24/M: private note revealed only to approved members who RSVPd yes (e.g. "gate code 1234")';
COMMENT ON COLUMN commander_home_groups.is_charity IS
  'Phase 24/M: marks the group as a charity/fundraiser game';

-- ════════════════════════════════════════════════════════════════════════
-- Live game-night state (seated + on-break + en-route + waitlist)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_live_home_game_state(
    p_game_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_game  RECORD;
    v_group RECORD;
    v_is_host boolean;
    v_seated jsonb;
    v_away   jsonb;
    v_enroute jsonb;
    v_waitlist jsonb;
    v_no_response jsonb;
    v_flakes jsonb;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    v_is_host := (v_game.host_id = p_caller_user_id)
              OR (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members 
                          WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    -- Seated players
    SELECT jsonb_agg(jsonb_build_object(
        'seat_number', s.seat_number, 'user_id', s.user_id,
        'player_name', COALESCE(s.player_name, p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'seated_at', s.seated_at,
        'checked_in_at', r.checked_in_at
    ) ORDER BY s.seat_number)
    INTO v_seated
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    LEFT JOIN commander_home_rsvps r ON r.game_id = s.game_id AND r.user_id = s.user_id
    WHERE s.game_id = p_game_id AND s.status = 'occupied';

    -- Away players
    SELECT jsonb_agg(jsonb_build_object(
        'seat_number', s.seat_number, 'user_id', s.user_id,
        'player_name', COALESCE(s.player_name, p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'away_since', s.away_since
    ) ORDER BY s.seat_number)
    INTO v_away
    FROM commander_home_seats s
    LEFT JOIN profiles p ON p.id = s.user_id
    WHERE s.game_id = p_game_id AND s.status = 'away';

    -- En route: RSVPd yes, not yet checked in, not seated
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'bringing_guests', r.bringing_guests
    ))
    INTO v_enroute
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id 
      AND r.response = 'yes' 
      AND r.checked_in_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM commander_home_seats s 
                       WHERE s.game_id = p_game_id AND s.user_id = r.user_id 
                         AND s.status IN ('occupied','away'));

    -- Waitlist
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url,
        'joined_waitlist_at', r.responded_at
    ) ORDER BY r.responded_at)
    INTO v_waitlist
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id AND r.response = 'waitlist';

    -- No response / missing: approved members who haven't RSVPd
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', m.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Member'),
        'avatar_url', p.avatar_url
    ))
    INTO v_no_response
    FROM commander_home_members m
    LEFT JOIN profiles p ON p.id = m.user_id
    WHERE m.group_id = v_game.group_id 
      AND m.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM commander_home_rsvps r 
                       WHERE r.game_id = p_game_id AND r.user_id = m.user_id);

    -- Flaked (for post-game display)
    SELECT jsonb_agg(jsonb_build_object(
        'user_id', r.user_id,
        'player_name', COALESCE(p.display_name, p.full_name, 'Player'),
        'avatar_url', p.avatar_url
    ))
    INTO v_flakes
    FROM commander_home_rsvps r
    LEFT JOIN profiles p ON p.id = r.user_id
    WHERE r.game_id = p_game_id AND r.flaked = true;

    RETURN jsonb_build_object(
        'success', true,
        'game', jsonb_build_object(
            'id', v_game.id, 'title', v_game.title, 
            'status', v_game.status, 
            'scheduled_date', v_game.scheduled_date,
            'start_time', v_game.start_time,
            'max_players', COALESCE(v_game.max_players, 9),
            'rsvp_yes', v_game.rsvp_yes, 'rsvp_maybe', v_game.rsvp_maybe,
            'rsvp_no', v_game.rsvp_no, 'waitlist_count', v_game.waitlist_count
        ),
        'seated', COALESCE(v_seated, '[]'::jsonb),
        'seated_count', jsonb_array_length(COALESCE(v_seated, '[]'::jsonb)),
        'away', COALESCE(v_away, '[]'::jsonb),
        'en_route', COALESCE(v_enroute, '[]'::jsonb),
        'en_route_count', jsonb_array_length(COALESCE(v_enroute, '[]'::jsonb)),
        'waitlist', COALESCE(v_waitlist, '[]'::jsonb),
        'no_response', COALESCE(v_no_response, '[]'::jsonb),
        'flakes', COALESCE(v_flakes, '[]'::jsonb)
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_live_home_game_state(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_live_home_game_state(uuid, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Personal calendar — a user's upcoming RSVPs across all their groups
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_user_home_games_calendar(
    p_caller_user_id  uuid,
    p_days_ahead      int DEFAULT 60
) RETURNS TABLE (
    game_id uuid, group_id uuid, group_name text, group_slug text,
    title text, scheduled_date date, start_time time, end_time time,
    stakes text, game_type text, format text,
    address text, address_visible boolean,
    notes_for_attendees text,
    my_response text, my_checked_in_at timestamptz,
    rsvp_yes int, rsvp_maybe int, max_players int, waitlist_count int,
    status text, is_host boolean, cover_photo_url text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    RETURN QUERY
    SELECT 
        g.id, g.group_id, grp.name, sp.slug,
        g.title, g.scheduled_date, g.start_time, g.end_time,
        g.stakes, g.game_type, g.format,
        -- Address visibility: show address only if yes-RSVP + member
        CASE 
          WHEN g.address_visible_to = 'public' THEN g.address
          WHEN g.address_visible_to = 'members' 
               AND EXISTS (SELECT 1 FROM commander_home_members m 
                            WHERE m.group_id = g.group_id AND m.user_id = p_caller_user_id 
                              AND m.status='approved') THEN g.address
          WHEN g.address_visible_to = 'rsvpd' 
               AND COALESCE(r.response, '') = 'yes' THEN g.address
          ELSE NULL 
        END AS address,
        (CASE WHEN g.address_visible_to = 'public' OR 
                   (g.address_visible_to = 'members' AND EXISTS (SELECT 1 FROM commander_home_members m WHERE m.group_id = g.group_id AND m.user_id = p_caller_user_id AND m.status='approved')) OR
                   (g.address_visible_to = 'rsvpd' AND COALESCE(r.response,'') = 'yes') THEN true ELSE false END) AS address_visible,
        -- notes_for_attendees only if yes-RSVP
        CASE WHEN COALESCE(r.response, '') = 'yes' THEN g.notes_for_attendees ELSE NULL END,
        r.response, r.checked_in_at,
        g.rsvp_yes, g.rsvp_maybe, g.max_players, g.waitlist_count,
        g.status,
        g.host_id = p_caller_user_id OR grp.owner_id = p_caller_user_id AS is_host,
        g.cover_photo_url
      FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id=grp.id::text
      LEFT JOIN commander_home_rsvps r ON r.game_id = g.id AND r.user_id = p_caller_user_id
     WHERE g.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + (p_days_ahead || ' days')::interval
       AND g.status IN ('scheduled','confirmed','in_progress')
       AND (
         -- Member
         EXISTS (SELECT 1 FROM commander_home_members m 
                  WHERE m.group_id = g.group_id AND m.user_id = p_caller_user_id 
                    AND m.status='approved')
         OR grp.owner_id = p_caller_user_id
         OR g.host_id = p_caller_user_id
         -- Or public group with any RSVP
         OR (NOT grp.is_private AND r.user_id IS NOT NULL)
       )
     ORDER BY g.scheduled_date, g.start_time NULLS LAST;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_user_home_games_calendar(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_home_games_calendar(uuid, int) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Close RSVPs early (manual host action)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.close_home_game_rsvps(
    p_game_id         uuid,
    p_caller_user_id  uuid,
    p_reopen          boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_game RECORD; v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

    UPDATE commander_home_games 
       SET rsvps_closed = NOT p_reopen, updated_at = NOW()
     WHERE id = p_game_id;

    RETURN jsonb_build_object('success', true, 'rsvps_closed', NOT p_reopen);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.close_home_game_rsvps(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_home_game_rsvps(uuid, uuid, boolean) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Add RSVP deadline enforcement as a BEFORE INSERT guard on rsvps
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_enforce_rsvp_deadline()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_game RECORD;
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;  -- service bypass (cron/trigger)
    
    SELECT rsvps_closed, rsvp_closes_at, status, scheduled_date, start_time 
      INTO v_game 
      FROM commander_home_games WHERE id = NEW.game_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    IF v_game.rsvps_closed = true THEN
        RAISE EXCEPTION 'RSVPS_CLOSED' USING HINT='host has closed RSVPs for this game';
    END IF;

    IF v_game.rsvp_closes_at IS NOT NULL AND v_game.rsvp_closes_at < NOW() THEN
        RAISE EXCEPTION 'RSVP_DEADLINE_PASSED' 
              USING HINT='RSVP deadline was ' || v_game.rsvp_closes_at::text;
    END IF;

    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_enforce_rsvp_deadline
    BEFORE INSERT OR UPDATE OF response ON commander_home_rsvps
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rsvp_deadline();

-- ════════════════════════════════════════════════════════════════════════
-- Group analytics snapshot — a complete group scorecard for the host
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_group_analytics(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'member_stats', jsonb_build_object(
            'total_approved', COALESCE(v_group.member_count, 0),
            'regulars', (SELECT COUNT(*) FROM commander_home_members 
                         WHERE group_id = p_group_id AND is_regular = true AND status = 'approved'),
            'pending', (SELECT COUNT(*) FROM commander_home_members 
                         WHERE group_id = p_group_id AND status = 'pending'),
            'banned', (SELECT COUNT(*) FROM commander_home_members 
                        WHERE group_id = p_group_id AND status = 'banned'),
            'joined_last_30d', (SELECT COUNT(*) FROM commander_home_members 
                                  WHERE group_id = p_group_id AND created_at > NOW() - INTERVAL '30 days')
        ),
        'game_stats', jsonb_build_object(
            'total_games', (SELECT COUNT(*) FROM commander_home_games WHERE group_id = p_group_id),
            'completed_games', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status = 'completed'),
            'cancelled_games', (SELECT COUNT(*) FROM commander_home_games 
                                 WHERE group_id = p_group_id AND status = 'cancelled'),
            'upcoming_games', (SELECT COUNT(*) FROM commander_home_games 
                                WHERE group_id = p_group_id 
                                  AND status IN ('scheduled','confirmed') 
                                  AND scheduled_date >= CURRENT_DATE),
            'avg_attendance_90d', COALESCE((
                SELECT ROUND(AVG(rsvp_yes)::numeric, 1) FROM commander_home_games 
                 WHERE group_id = p_group_id AND status = 'completed'
                   AND updated_at > NOW() - INTERVAL '90 days'
            ), 0)
        ),
        'engagement', jsonb_build_object(
            'post_count', (SELECT COUNT(*) FROM commander_home_posts WHERE group_id = p_group_id),
            'post_count_30d', (SELECT COUNT(*) FROM commander_home_posts 
                                WHERE group_id = p_group_id AND created_at > NOW() - INTERVAL '30 days'),
            'total_likes', (SELECT COUNT(*) FROM commander_home_post_likes pl
                             JOIN commander_home_posts p ON p.id = pl.post_id
                             WHERE p.group_id = p_group_id),
            'total_comments', (SELECT COUNT(*) FROM commander_home_post_comments pc
                                JOIN commander_home_posts p ON p.id = pc.post_id
                                WHERE p.group_id = p_group_id)
        ),
        'discovery', jsonb_build_object(
            'view_count', COALESCE(v_group.view_count, 0),
            'share_click_count', COALESCE(v_group.share_click_count, 0),
            'active_invite_tokens', (SELECT COUNT(*) FROM commander_home_invite_tokens 
                                      WHERE group_id = p_group_id AND is_active = true)
        ),
        'reputation', jsonb_build_object(
            'review_count', (SELECT COUNT(*) FROM commander_home_game_reviews r
                              JOIN commander_home_games g ON g.id = r.game_id
                              WHERE g.group_id = p_group_id),
            'avg_rating', COALESCE((
                SELECT ROUND(AVG(rating)::numeric, 2) FROM commander_home_game_reviews r
                 JOIN commander_home_games g ON g.id = r.game_id
                 WHERE g.group_id = p_group_id
            ), 0),
            'flake_count_90d', (SELECT COUNT(*) FROM commander_home_rsvps r
                                 JOIN commander_home_games g ON g.id = r.game_id
                                 WHERE g.group_id = p_group_id AND r.flaked = true
                                   AND g.updated_at > NOW() - INTERVAL '90 days')
        ),
        'activity', jsonb_build_object(
            'last_activity_at', v_group.last_activity_at,
            'days_since_activity', EXTRACT(day FROM (NOW() - v_group.last_activity_at))::int,
            'stale_warning_sent_at', v_group.inactivity_warning_sent_at,
            'hidden_sent_at', v_group.inactivity_hidden_sent_at
        )
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_group_analytics(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_group_analytics(uuid, uuid) TO authenticated, service_role;
