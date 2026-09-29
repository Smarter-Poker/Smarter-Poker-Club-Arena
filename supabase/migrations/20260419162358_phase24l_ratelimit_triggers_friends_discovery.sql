-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419162358 "phase24l_ratelimit_triggers_friends_discovery"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bfe31d9bd8fb01e8ed2dfc7d26bf6b6f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART L — Rate-limit triggers + friends integration + discovery
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Defense-in-depth: rate-limit triggers on write-heavy tables
-- Only enforce when auth.uid() is set (bypasses for service_role / cron)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_enforce_rate_limit_members()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service / cron bypass
    IF NEW.user_id = auth.uid() THEN  -- self-initiated only
        IF NOT public.fn_check_home_rate_limit(auth.uid(), 'join') THEN
            RAISE EXCEPTION 'RATE_LIMITED' USING HINT = 'max 20 joins per hour';
        END IF;
    END IF;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_rate_limit_home_members
    BEFORE INSERT ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rate_limit_members();

CREATE OR REPLACE FUNCTION public.fn_enforce_rate_limit_posts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF NEW.author_id = auth.uid() THEN
        IF NOT public.fn_check_home_rate_limit(auth.uid(), 'post') THEN
            RAISE EXCEPTION 'RATE_LIMITED' USING HINT = 'max 30 posts per hour';
        END IF;
    END IF;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_rate_limit_home_posts
    BEFORE INSERT ON commander_home_posts
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rate_limit_posts();

CREATE OR REPLACE FUNCTION public.fn_enforce_rate_limit_comments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF NEW.author_id = auth.uid() THEN
        IF NOT public.fn_check_home_rate_limit(auth.uid(), 'comment') THEN
            RAISE EXCEPTION 'RATE_LIMITED' USING HINT = 'max 60 comments per hour';
        END IF;
    END IF;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_rate_limit_home_comments
    BEFORE INSERT ON commander_home_post_comments
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rate_limit_comments();

CREATE OR REPLACE FUNCTION public.fn_enforce_rate_limit_rsvps()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF NEW.user_id = auth.uid() THEN
        IF NOT public.fn_check_home_rate_limit(auth.uid(), 'rsvp') THEN
            RAISE EXCEPTION 'RATE_LIMITED' USING HINT = 'max 40 RSVP changes per hour';
        END IF;
    END IF;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_rate_limit_home_rsvps
    BEFORE INSERT ON commander_home_rsvps
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rate_limit_rsvps();

CREATE OR REPLACE FUNCTION public.fn_enforce_rate_limit_invites()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF NEW.created_by = auth.uid() THEN
        IF NOT public.fn_check_home_rate_limit(auth.uid(), 'invite_token') THEN
            RAISE EXCEPTION 'RATE_LIMITED' USING HINT = 'max 15 invite tokens per hour';
        END IF;
    END IF;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_rate_limit_home_invites
    BEFORE INSERT ON commander_home_invite_tokens
    FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_rate_limit_invites();

-- ════════════════════════════════════════════════════════════════════════
-- P6.6 — Friends integration: notify friends when a user joins a group
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_notify_friends_of_home_join()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group      RECORD;
    v_slug       text;
    v_joiner_name text;
    v_friend     RECORD;
BEGIN
    -- Only fire on transitions TO approved
    IF TG_OP = 'INSERT' AND NEW.status <> 'approved' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status = 'approved' OR NEW.status <> 'approved') THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    -- Only notify friends for PUBLIC groups (private group membership is sensitive)
    IF v_group.is_private THEN RETURN NEW; END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id=v_group.id::text LIMIT 1;
    SELECT COALESCE(display_name, full_name, username, 'A friend') INTO v_joiner_name
      FROM profiles WHERE id = NEW.user_id;

    FOR v_friend IN
        SELECT DISTINCT CASE 
                  WHEN f.user_id = NEW.user_id THEN f.friend_id
                  ELSE f.user_id END AS friend_user_id
          FROM friendships f
         WHERE (f.user_id = NEW.user_id OR f.friend_id = NEW.user_id)
           AND f.status = 'accepted'
    LOOP
        -- Don't notify the joiner themselves
        IF v_friend.friend_user_id = NEW.user_id THEN CONTINUE; END IF;
        -- Don't notify if friend is already in the group
        IF EXISTS (SELECT 1 FROM commander_home_members 
                    WHERE group_id = NEW.group_id AND user_id = v_friend.friend_user_id) THEN
            CONTINUE;
        END IF;

        PERFORM public.fn_emit_home_notification(
            v_friend.friend_user_id, 'home_group_friend_joined',
            v_joiner_name || ' joined ' || v_group.name,
            'Your friend is now in ' || v_group.name || ' — check it out',
            '/hub/home-games/' || COALESCE(v_slug, v_group.id::text),
            jsonb_build_object('group_id', v_group.id, 'friend_id', NEW.user_id),
            NULL
        );
    END LOOP;
    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_notify_friends_of_home_join
    AFTER INSERT OR UPDATE OF status ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_notify_friends_of_home_join();

-- ════════════════════════════════════════════════════════════════════════
-- P9.2 — Recommended home groups for a user
-- Scoring: city match + state match + friends-in-group + tags overlap + trending
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_recommended_home_groups(
    p_caller_user_id  uuid,
    p_limit           int DEFAULT 10
) RETURNS TABLE (
    group_id uuid, name text, slug text,
    city text, state text, profile_photo_url text,
    member_count int, friends_in_group bigint,
    recommendation_score numeric, reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
    v_user_city  text;
    v_user_state text;
    v_user_lat   numeric;
    v_user_lng   numeric;
    v_point      geography;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    SELECT city, state, 
           (CASE WHEN jsonb_typeof(location_data->'lat') = 'number' THEN (location_data->>'lat')::numeric ELSE NULL END),
           (CASE WHEN jsonb_typeof(location_data->'lng') = 'number' THEN (location_data->>'lng')::numeric ELSE NULL END)
      INTO v_user_city, v_user_state, v_user_lat, v_user_lng
      FROM profiles WHERE id = p_caller_user_id;

    IF v_user_lat IS NOT NULL AND v_user_lng IS NOT NULL THEN
        v_point := ST_SetSRID(ST_MakePoint(v_user_lng, v_user_lat), 4326)::geography;
    END IF;

    RETURN QUERY
    WITH friend_groups AS (
      SELECT m.group_id, COUNT(DISTINCT m.user_id) AS friend_count
        FROM commander_home_members m
       WHERE m.user_id IN (
           SELECT DISTINCT CASE WHEN f.user_id = p_caller_user_id THEN f.friend_id ELSE f.user_id END
             FROM friendships f
            WHERE (f.user_id = p_caller_user_id OR f.friend_id = p_caller_user_id)
              AND f.status = 'accepted'
       )
       AND m.status = 'approved'
       GROUP BY m.group_id
    ),
    scored AS (
      SELECT 
        g.id, g.name, sp.slug, g.city, g.state, g.profile_photo_url,
        COALESCE(g.member_count, 0) AS member_count,
        COALESCE(fg.friend_count, 0) AS friends_in_group,
        -- Scoring
        (COALESCE(fg.friend_count, 0) * 30    -- friends in group = huge signal
         + CASE WHEN v_user_city IS NOT NULL AND g.city ILIKE v_user_city THEN 20 ELSE 0 END
         + CASE WHEN v_user_state IS NOT NULL AND g.state = v_user_state THEN 10 ELSE 0 END
         + LEAST(10, COALESCE(g.games_hosted, 0)) * 0.5
         + CASE WHEN v_point IS NOT NULL AND g.location_geog IS NOT NULL 
                THEN GREATEST(0, 25 - (ST_Distance(g.location_geog, v_point)/1609.344)::numeric) 
                ELSE 0 END
        )::numeric AS score,
        CASE 
          WHEN COALESCE(fg.friend_count, 0) > 0 
            THEN fg.friend_count || ' friend' || CASE WHEN fg.friend_count > 1 THEN 's' ELSE '' END || ' in this group'
          WHEN v_user_city IS NOT NULL AND g.city ILIKE v_user_city 
            THEN 'In your city: ' || g.city
          WHEN v_user_state IS NOT NULL AND g.state = v_user_state 
            THEN 'In your state'
          ELSE 'Active home game'
        END AS reason
        FROM commander_home_groups g
        LEFT JOIN friend_groups fg ON fg.group_id = g.id
        LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
       WHERE g.is_active = true
         AND NOT g.is_private
         AND g.profile_photo_url IS NOT NULL
         AND g.last_activity_at > NOW() - INTERVAL '45 days'
         AND NOT EXISTS (SELECT 1 FROM commander_home_members m 
                          WHERE m.group_id = g.id AND m.user_id = p_caller_user_id)
         AND g.owner_id <> p_caller_user_id
    )
    SELECT s.id, s.name, s.slug, s.city, s.state, s.profile_photo_url,
           s.member_count, s.friends_in_group, s.score, s.reason
      FROM scored s
     ORDER BY s.score DESC
     LIMIT GREATEST(1, LEAST(p_limit, 50));
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_recommended_home_groups(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recommended_home_groups(uuid, int) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Host onboarding checklist — what has / hasn't been done
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_host_onboarding_checklist(
    p_group_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group        RECORD;
    v_member_count int;
    v_game_count   int;
    v_post_count   int;
    v_invite_count int;
    v_items        jsonb := '[]'::jsonb;
    v_completed    int := 0;
    v_total        int := 0;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id 
       AND NOT EXISTS (SELECT 1 FROM commander_home_members 
                        WHERE group_id = p_group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    SELECT COUNT(*) INTO v_member_count FROM commander_home_members 
     WHERE group_id = p_group_id AND status='approved';
    SELECT COUNT(*) INTO v_game_count FROM commander_home_games WHERE group_id = p_group_id;
    SELECT COUNT(*) INTO v_post_count FROM commander_home_posts WHERE group_id = p_group_id;
    SELECT COUNT(*) INTO v_invite_count FROM commander_home_invite_tokens WHERE group_id = p_group_id;

    v_items := jsonb_build_array(
        jsonb_build_object('id','logo','label','Upload a group logo',
                           'done', v_group.profile_photo_url IS NOT NULL,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 10),
        jsonb_build_object('id','description','label','Write a group description',
                           'done', v_group.description IS NOT NULL AND length(v_group.description) > 20,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 5),
        jsonb_build_object('id','location','label','Set your city and state',
                           'done', v_group.city IS NOT NULL AND v_group.state IS NOT NULL,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 7),
        jsonb_build_object('id','stakes','label','Set default game type and stakes',
                           'done', v_group.default_game_type IS NOT NULL AND v_group.default_stakes IS NOT NULL,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 5),
        jsonb_build_object('id','schedule','label','Set typical day and time',
                           'done', v_group.typical_day IS NOT NULL AND v_group.typical_time IS NOT NULL,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 5),
        jsonb_build_object('id','first_game','label','Schedule your first game',
                           'done', v_game_count > 0,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/games/new',
                           'weight', 15),
        jsonb_build_object('id','invite_members','label','Invite at least 3 members',
                           'done', v_member_count >= 3,
                           'current', v_member_count, 'target', 3,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/invite',
                           'weight', 12),
        jsonb_build_object('id','first_post','label','Post an announcement',
                           'done', v_post_count > 0,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host',
                           'weight', 5),
        jsonb_build_object('id','share_link','label','Create a shareable invite link',
                           'done', v_invite_count > 0,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/invite',
                           'weight', 8),
        jsonb_build_object('id','tags','label','Add discovery tags',
                           'done', array_length(v_group.tags, 1) IS NOT NULL AND array_length(v_group.tags, 1) > 0,
                           'cta_link','/hub/home-games/' || p_group_id::text || '/host/settings',
                           'weight', 3)
    );

    -- Compute completion percentage
    SELECT SUM((item->>'weight')::int) FILTER (WHERE (item->>'done')::boolean),
           SUM((item->>'weight')::int)
      INTO v_completed, v_total
      FROM jsonb_array_elements(v_items) item;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'items', v_items,
        'completion_pct', ROUND(100.0 * COALESCE(v_completed, 0)::numeric / NULLIF(v_total, 0), 1),
        'items_done', (SELECT COUNT(*) FROM jsonb_array_elements(v_items) WHERE (value->>'done')::boolean),
        'items_total', jsonb_array_length(v_items)
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_host_onboarding_checklist(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_host_onboarding_checklist(uuid, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Friends' home-game activity — "what are my friends up to"
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_friends_home_activity(
    p_caller_user_id  uuid,
    p_limit           int DEFAULT 20
) RETURNS TABLE (
    friend_id uuid, friend_name text, friend_avatar text,
    group_id uuid, group_name text, group_slug text, group_photo text,
    joined_at timestamptz, role text, is_host boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;

    RETURN QUERY
    WITH friends AS (
      SELECT DISTINCT CASE WHEN f.user_id = p_caller_user_id THEN f.friend_id ELSE f.user_id END AS fid
        FROM friendships f
       WHERE (f.user_id = p_caller_user_id OR f.friend_id = p_caller_user_id)
         AND f.status = 'accepted'
    )
    SELECT 
      m.user_id,
      COALESCE(p.display_name, p.full_name, p.username, 'Friend'),
      p.avatar_url,
      g.id, g.name, sp.slug, g.profile_photo_url,
      COALESCE(m.joined_at, m.created_at),
      m.role,
      g.owner_id = m.user_id AS is_host
    FROM commander_home_members m
    JOIN friends f ON f.fid = m.user_id
    JOIN commander_home_groups g ON g.id = m.group_id
    LEFT JOIN profiles p ON p.id = m.user_id
    LEFT JOIN social_pages sp ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
    WHERE m.status = 'approved'
      AND NOT g.is_private  -- don't leak private group memberships
      AND g.profile_photo_url IS NOT NULL
    ORDER BY COALESCE(m.joined_at, m.created_at) DESC
    LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_friends_home_activity(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_friends_home_activity(uuid, int) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Home-games leaderboards (hosts / attendees / reviewers)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_games_leaderboards(
    p_timeframe text DEFAULT 'all',  -- 'week','month','all'
    p_limit     int DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_since      timestamptz;
    v_top_hosts  jsonb;
    v_top_attendees jsonb;
    v_top_cities jsonb;
BEGIN
    v_since := CASE p_timeframe
        WHEN 'week'  THEN NOW() - INTERVAL '7 days'
        WHEN 'month' THEN NOW() - INTERVAL '30 days'
        ELSE '1970-01-01'::timestamptz
    END;

    -- Top hosts by completed games
    SELECT jsonb_agg(row_to_json(t))
      INTO v_top_hosts
      FROM (
        SELECT 
            grp.owner_id AS host_user_id,
            COALESCE(p.display_name, p.full_name, p.username, 'Host') AS host_name,
            p.avatar_url,
            COUNT(*) AS games_hosted,
            SUM(COALESCE(g.rsvp_yes, 0)) AS total_rsvps
          FROM commander_home_games g
          JOIN commander_home_groups grp ON grp.id = g.group_id
          LEFT JOIN profiles p ON p.id = grp.owner_id
         WHERE g.status = 'completed'
           AND g.updated_at >= v_since
           AND grp.profile_photo_url IS NOT NULL
         GROUP BY grp.owner_id, p.display_name, p.full_name, p.username, p.avatar_url
         ORDER BY games_hosted DESC, total_rsvps DESC
         LIMIT p_limit
      ) t;

    -- Top attendees by games attended (checked in)
    SELECT jsonb_agg(row_to_json(t))
      INTO v_top_attendees
      FROM (
        SELECT 
            r.user_id,
            COALESCE(p.display_name, p.full_name, p.username, 'Player') AS player_name,
            p.avatar_url,
            COUNT(*) AS games_attended
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
          LEFT JOIN profiles p ON p.id = r.user_id
         WHERE r.checked_in_at IS NOT NULL
           AND r.checked_in_at >= v_since
           AND g.status = 'completed'
         GROUP BY r.user_id, p.display_name, p.full_name, p.username, p.avatar_url
         ORDER BY games_attended DESC
         LIMIT p_limit
      ) t;

    -- Most active cities
    SELECT jsonb_agg(row_to_json(t))
      INTO v_top_cities
      FROM (
        SELECT 
            COALESCE(grp.city, 'Unknown') AS city,
            grp.state,
            COUNT(DISTINCT grp.id) AS active_groups,
            COUNT(*) FILTER (WHERE g.status='completed') AS games_completed
          FROM commander_home_games g
          JOIN commander_home_groups grp ON grp.id = g.group_id
         WHERE g.updated_at >= v_since
           AND grp.city IS NOT NULL
         GROUP BY grp.city, grp.state
         ORDER BY active_groups DESC, games_completed DESC
         LIMIT p_limit
      ) t;

    RETURN jsonb_build_object(
        'success', true,
        'timeframe', p_timeframe,
        'top_hosts', COALESCE(v_top_hosts, '[]'::jsonb),
        'top_attendees', COALESCE(v_top_attendees, '[]'::jsonb),
        'top_cities', COALESCE(v_top_cities, '[]'::jsonb)
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_games_leaderboards(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_home_games_leaderboards(text, int) TO anon, authenticated, service_role;
