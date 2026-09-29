-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419163706 "phase24n_v2_achievements_feed_selfclaim_welcome"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 55cd261bf8a95d6bd2ca65f2cc19acf6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART N v2 — Achievements + unified feed + self-seat + welcome + abuse
--  Fix: replaced nested PROCEDURE with standalone helper fn
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- Seat self-claim — player takes an empty seat themselves
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.claim_home_game_seat(
    p_game_id         uuid,
    p_seat_number     int,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE 
    v_game RECORD; v_group RECORD; 
    v_existing RECORD; v_rsvp RECORD;
    v_player_name text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_seat_number < 1 OR p_seat_number > 20 THEN RAISE EXCEPTION 'INVALID_SEAT_NUMBER'; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress') THEN RAISE EXCEPTION 'GAME_NOT_ACTIVE'; END IF;
    IF p_seat_number > COALESCE(v_game.max_players, 9) THEN RAISE EXCEPTION 'SEAT_EXCEEDS_MAX_PLAYERS'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    SELECT * INTO v_rsvp FROM commander_home_rsvps 
     WHERE game_id = p_game_id AND user_id = p_caller_user_id;

    IF NOT FOUND OR v_rsvp.response <> 'yes' THEN
        RAISE EXCEPTION 'NO_YES_RSVP' USING HINT = 'must RSVP yes before claiming a seat';
    END IF;

    IF EXISTS (SELECT 1 FROM commander_home_seats 
                WHERE game_id = p_game_id AND user_id = p_caller_user_id 
                  AND status IN ('occupied','away')) THEN
        RAISE EXCEPTION 'ALREADY_SEATED';
    END IF;

    SELECT * INTO v_existing FROM commander_home_seats 
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    IF FOUND AND v_existing.status IN ('occupied','away') THEN
        RAISE EXCEPTION 'SEAT_TAKEN' USING HINT = 'seat ' || p_seat_number || ' is occupied';
    END IF;

    SELECT COALESCE(display_name, full_name, username, 'Player') INTO v_player_name
      FROM profiles WHERE id = p_caller_user_id;

    IF FOUND THEN
        UPDATE commander_home_seats 
           SET user_id = p_caller_user_id, player_name = v_player_name,
               status = 'occupied', seated_at = NOW(), away_since = NULL, updated_at = NOW()
         WHERE id = v_existing.id;
    ELSE
        INSERT INTO commander_home_seats (game_id, seat_number, user_id, player_name, status, seated_at)
        VALUES (p_game_id, p_seat_number, p_caller_user_id, v_player_name, 'occupied', NOW());
    END IF;

    UPDATE commander_home_rsvps
       SET checked_in_at = COALESCE(checked_in_at, NOW()),
           flaked = false, updated_at = NOW()
     WHERE id = v_rsvp.id;

    RETURN jsonb_build_object('success', true, 'seat_number', p_seat_number);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.claim_home_game_seat(uuid, int, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_home_game_seat(uuid, int, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_own_home_game_seat(
    p_game_id         uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE v_existing RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_existing FROM commander_home_seats 
     WHERE game_id = p_game_id AND user_id = p_caller_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_SEATED'; END IF;

    UPDATE commander_home_seats 
       SET user_id = NULL, player_name = NULL, status = 'empty', 
           seated_at = NULL, away_since = NULL, note = NULL, updated_at = NOW()
     WHERE id = v_existing.id;

    RETURN jsonb_build_object('success', true, 'seat_number', v_existing.seat_number);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.release_own_home_game_seat(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_own_home_game_seat(uuid, uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Achievement/badge system — standalone helper (fixes nested-procedure bug)
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commander_home_user_badges (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    badge_key    text NOT NULL,
    earned_at    timestamptz NOT NULL DEFAULT NOW(),
    metadata     jsonb DEFAULT '{}',
    UNIQUE (user_id, badge_key)
);

CREATE INDEX idx_home_badges_user ON commander_home_user_badges(user_id, earned_at DESC);
ALTER TABLE commander_home_user_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_badges_select_public ON commander_home_user_badges
  FOR SELECT USING (true);

-- Standalone helper: insert a badge only if new, return whether it was new
CREATE OR REPLACE FUNCTION public._award_home_badge_if_new(
    p_user_id   uuid,
    p_badge_key text,
    p_metadata  jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_inserted boolean := false;
BEGIN
    INSERT INTO commander_home_user_badges (user_id, badge_key, metadata)
    VALUES (p_user_id, p_badge_key, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (user_id, badge_key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted::int > 0;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public._award_home_badge_if_new(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._award_home_badge_if_new(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.award_home_games_badges(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_games_hosted    int;
    v_games_attended  int;
    v_groups_owned    int;
    v_avg_rating      numeric;
    v_new_badges      jsonb := '[]'::jsonb;

    -- Inline helper wrapper that appends to v_new_badges when new
    v_meta  jsonb;
    v_keys  text[] := ARRAY[]::text[];
BEGIN
    SELECT COALESCE(SUM(games_hosted), 0) INTO v_games_hosted 
      FROM commander_home_groups WHERE owner_id = p_user_id;
    SELECT COUNT(*) INTO v_games_attended 
      FROM commander_home_rsvps r 
      WHERE r.user_id = p_user_id AND r.checked_in_at IS NOT NULL;
    SELECT COUNT(*) INTO v_groups_owned 
      FROM commander_home_groups WHERE owner_id = p_user_id;
    SELECT COALESCE(AVG(r.rating), 0) INTO v_avg_rating
      FROM commander_home_game_reviews r
      JOIN commander_home_games g ON g.id = r.game_id
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = p_user_id OR g.host_id = p_user_id;

    -- Host tier
    IF v_games_hosted >= 1   AND public._award_home_badge_if_new(p_user_id, 'first_host',       jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'first_host'; END IF;
    IF v_games_hosted >= 5   AND public._award_home_badge_if_new(p_user_id, 'host_veteran_5',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'host_veteran_5'; END IF;
    IF v_games_hosted >= 10  AND public._award_home_badge_if_new(p_user_id, 'host_veteran_10',  jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'host_veteran_10'; END IF;
    IF v_games_hosted >= 25  AND public._award_home_badge_if_new(p_user_id, 'host_veteran_25',  jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'host_veteran_25'; END IF;
    IF v_games_hosted >= 50  AND public._award_home_badge_if_new(p_user_id, 'host_legend_50',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'host_legend_50'; END IF;
    IF v_games_hosted >= 100 AND public._award_home_badge_if_new(p_user_id, 'host_centurion',   jsonb_build_object('at', v_games_hosted)) THEN v_keys := v_keys || 'host_centurion'; END IF;

    -- Player tier
    IF v_games_attended >= 1   AND public._award_home_badge_if_new(p_user_id, 'first_game_played', jsonb_build_object('at', v_games_attended)) THEN v_keys := v_keys || 'first_game_played'; END IF;
    IF v_games_attended >= 5   AND public._award_home_badge_if_new(p_user_id, 'regular_5',         jsonb_build_object('at', v_games_attended)) THEN v_keys := v_keys || 'regular_5'; END IF;
    IF v_games_attended >= 10  AND public._award_home_badge_if_new(p_user_id, 'reliable_regular',  jsonb_build_object('at', v_games_attended)) THEN v_keys := v_keys || 'reliable_regular'; END IF;
    IF v_games_attended >= 25  AND public._award_home_badge_if_new(p_user_id, 'dedicated_25',      jsonb_build_object('at', v_games_attended)) THEN v_keys := v_keys || 'dedicated_25'; END IF;
    IF v_games_attended >= 50  AND public._award_home_badge_if_new(p_user_id, 'fixture_50',        jsonb_build_object('at', v_games_attended)) THEN v_keys := v_keys || 'fixture_50'; END IF;

    -- Special
    IF v_groups_owned >= 2 AND public._award_home_badge_if_new(p_user_id, 'multi_host', jsonb_build_object('groups', v_groups_owned)) THEN v_keys := v_keys || 'multi_host'; END IF;
    IF v_avg_rating >= 4.5 AND v_games_hosted >= 3 
       AND public._award_home_badge_if_new(p_user_id, 'five_star_host', jsonb_build_object('rating', v_avg_rating, 'games', v_games_hosted))
    THEN v_keys := v_keys || 'five_star_host'; END IF;

    v_new_badges := to_jsonb(v_keys);

    IF array_length(v_keys, 1) > 0 THEN
        PERFORM public.fn_emit_home_notification(
            p_user_id, 'home_badges_earned',
            'You earned ' || array_length(v_keys, 1) || ' badge' || 
                CASE WHEN array_length(v_keys, 1) > 1 THEN 's' ELSE '' END || '!',
            'Nice work. Check your profile to see them.',
            '/hub/profile/badges',
            jsonb_build_object('new_badges', v_new_badges),
            NULL
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true, 'user_id', p_user_id,
        'new_badges', v_new_badges,
        'stats', jsonb_build_object(
            'games_hosted', v_games_hosted,
            'games_attended', v_games_attended,
            'groups_owned', v_groups_owned,
            'avg_rating', v_avg_rating
        )
    );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.award_home_games_badges(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_home_games_badges(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_user_home_games_badges(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'badge_key', badge_key,
        'earned_at', earned_at,
        'metadata', metadata
    ) ORDER BY earned_at DESC), '[]'::jsonb)
    FROM commander_home_user_badges WHERE user_id = p_user_id;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_user_home_games_badges(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_home_games_badges(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_award_badges_on_game_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_host_id uuid; v_attendee RECORD;
BEGIN
    IF OLD.status = 'completed' OR NEW.status <> 'completed' THEN RETURN NEW; END IF;

    SELECT COALESCE(NEW.host_id, owner_id) INTO v_host_id FROM commander_home_groups WHERE id = NEW.group_id;
    IF v_host_id IS NOT NULL THEN
        PERFORM public.award_home_games_badges(v_host_id);
    END IF;

    FOR v_attendee IN 
        SELECT DISTINCT user_id FROM commander_home_rsvps 
         WHERE game_id = NEW.id AND checked_in_at IS NOT NULL
    LOOP
        PERFORM public.award_home_games_badges(v_attendee.user_id);
    END LOOP;

    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_award_badges_on_complete
    AFTER UPDATE OF status ON commander_home_games
    FOR EACH ROW EXECUTE FUNCTION public.fn_award_badges_on_game_complete();

-- ════════════════════════════════════════════════════════════════════════
-- Auto-welcome post on member approval
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_welcome_new_approved_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_member_name text;
    v_welcome_exists boolean;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status <> 'approved' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.status = 'approved' OR NEW.status <> 'approved') THEN RETURN NEW; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = NEW.group_id;
    IF v_group.owner_id = NEW.user_id THEN RETURN NEW; END IF;
    
    SELECT COALESCE(display_name, full_name, username, 'a new member') INTO v_member_name
      FROM profiles WHERE id = NEW.user_id;

    SELECT EXISTS(
        SELECT 1 FROM commander_home_posts 
         WHERE group_id = NEW.group_id 
           AND post_type = 'announcement'
           AND data->>'welcome_user_id' = NEW.user_id::text
    ) INTO v_welcome_exists;
    
    IF v_welcome_exists THEN RETURN NEW; END IF;

    INSERT INTO commander_home_posts (
        group_id, author_id, post_type, visible_to,
        content, data, is_published, is_pinned
    ) VALUES (
        NEW.group_id, v_group.owner_id, 'announcement', 'members',
        '👋 Everyone welcome ' || v_member_name || ' to ' || v_group.name || '!',
        jsonb_build_object('welcome_user_id', NEW.user_id, 'auto_generated', true),
        true, false
    );

    RETURN NEW;
END; $fn$;

CREATE TRIGGER trg_welcome_new_approved_member
    AFTER INSERT OR UPDATE OF status ON commander_home_members
    FOR EACH ROW EXECUTE FUNCTION public.fn_welcome_new_approved_member();

-- ════════════════════════════════════════════════════════════════════════
-- Unified group feed — combined posts + games + polls + photos
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_group_feed(
    p_group_id        uuid,
    p_caller_user_id  uuid,
    p_limit           int DEFAULT 20,
    p_before          timestamptz DEFAULT NULL
) RETURNS TABLE (
    entry_type text, entry_id uuid,
    created_at timestamptz,
    author_id uuid, author_name text, author_avatar text,
    title text, content text, image_urls text[],
    metadata jsonb, link_to text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_group RECORD;
    v_is_member boolean;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    v_is_member := (v_group.owner_id = p_caller_user_id)
                OR EXISTS (SELECT 1 FROM commander_home_members 
                            WHERE group_id = p_group_id AND user_id = p_caller_user_id 
                              AND status = 'approved');

    IF v_group.is_private AND NOT v_is_member THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

    RETURN QUERY
    WITH post_entries AS (
        SELECT 'post'::text AS et, p.id, p.created_at, p.author_id,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text AS aname,
               pr.avatar_url,
               NULL::text AS ttl,
               p.content, 
               COALESCE(p.image_urls, ARRAY[]::text[]),
               jsonb_build_object(
                   'post_type', p.post_type,
                   'is_pinned', p.is_pinned,
                   'likes_count', p.likes_count,
                   'comments_count', p.comments_count
               ) AS meta,
               ('/hub/home-games/' || p_group_id::text || '#post-' || p.id::text)::text AS lnk
          FROM commander_home_posts p
          LEFT JOIN profiles pr ON pr.id = p.author_id
         WHERE p.group_id = p_group_id
           AND (p.visible_to = 'public' OR v_is_member)
    ),
    game_entries AS (
        SELECT 'game'::text, g.id, g.created_at, g.host_id,
               COALESCE(pr.display_name, pr.full_name, 'Host')::text,
               pr.avatar_url,
               COALESCE(g.title, 'Home game')::text,
               g.description, 
               CASE WHEN g.cover_photo_url IS NOT NULL 
                    THEN ARRAY[g.cover_photo_url] 
                    ELSE ARRAY[]::text[] END,
               jsonb_build_object(
                   'status', g.status,
                   'scheduled_date', g.scheduled_date,
                   'start_time', g.start_time,
                   'stakes', g.stakes,
                   'game_type', g.game_type,
                   'format', g.format,
                   'rsvp_yes', g.rsvp_yes,
                   'max_players', g.max_players
               ),
               ('/hub/home-games/' || p_group_id::text || '/games/' || g.id::text)::text
          FROM commander_home_games g
          LEFT JOIN profiles pr ON pr.id = g.host_id
         WHERE g.group_id = p_group_id
           AND (NOT v_group.is_private OR v_is_member)
    ),
    poll_entries AS (
        SELECT 'poll'::text, pl.id, pl.created_at, pl.created_by,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text,
               pr.avatar_url,
               pl.question::text,
               NULL::text,
               ARRAY[]::text[],
               jsonb_build_object(
                   'poll_type', pl.poll_type,
                   'options', pl.options,
                   'is_closed', pl.is_closed,
                   'closes_at', pl.closes_at,
                   'vote_count', (SELECT COUNT(*) FROM commander_home_poll_votes WHERE poll_id = pl.id)
               ),
               ('/hub/home-games/' || p_group_id::text || '#poll-' || pl.id::text)::text
          FROM commander_home_polls pl
          LEFT JOIN profiles pr ON pr.id = pl.created_by
         WHERE pl.group_id = p_group_id
           AND v_is_member
    ),
    photo_entries AS (
        SELECT 'photo'::text, ph.id, ph.created_at, ph.uploader_id,
               COALESCE(pr.display_name, pr.full_name, 'Member')::text,
               pr.avatar_url,
               NULL::text,
               ph.caption,
               ARRAY[ph.photo_url],
               jsonb_build_object('game_id', ph.game_id, 'is_featured', ph.is_featured),
               ('/hub/home-games/' || p_group_id::text || '/games/' || ph.game_id::text)::text
          FROM commander_home_game_photos ph
          LEFT JOIN profiles pr ON pr.id = ph.uploader_id
          JOIN commander_home_games g ON g.id = ph.game_id
         WHERE g.group_id = p_group_id
           AND (NOT v_group.is_private OR v_is_member)
    ),
    unified AS (
        SELECT * FROM post_entries
        UNION ALL SELECT * FROM game_entries
        UNION ALL SELECT * FROM poll_entries
        UNION ALL SELECT * FROM photo_entries
    )
    SELECT u.et, u.id, u.created_at, u.author_id, u.aname, u.avatar_url,
           u.ttl, u.content, u.image_urls, u.meta, u.lnk
      FROM unified u
     WHERE (p_before IS NULL OR u.created_at < p_before)
     ORDER BY u.created_at DESC
     LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_group_feed(uuid, uuid, int, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_home_group_feed(uuid, uuid, int, timestamptz) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Mark all home-games notifications as read
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mark_all_home_notifications_read(p_caller_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_updated int;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    UPDATE notifications 
       SET read = true, is_read = true, updated_at = NOW()
     WHERE user_id = p_caller_user_id 
       AND type LIKE 'home_%'
       AND read = false;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'marked_read', v_updated);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.mark_all_home_notifications_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_home_notifications_read(uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Abuse pattern detection — flag users with repeated reports
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.detect_home_abuse_patterns(
    p_lookback_days int DEFAULT 30,
    p_min_reports   int DEFAULT 3
) RETURNS TABLE (
    target_type text, target_id uuid, 
    report_count bigint, unique_reporters bigint,
    reason_breakdown jsonb,
    first_reported timestamptz, last_reported timestamptz,
    suggested_action text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    RETURN QUERY
    WITH agg AS (
        SELECT r.reported_type AS t_type, r.reported_id AS t_id,
               COUNT(*) AS rc, COUNT(DISTINCT r.reporter_id) AS ur,
               MIN(r.created_at) AS fr, MAX(r.created_at) AS lr
          FROM commander_home_content_reports r
         WHERE r.status = 'pending'
           AND r.created_at > NOW() - (p_lookback_days || ' days')::interval
         GROUP BY r.reported_type, r.reported_id
        HAVING COUNT(*) >= p_min_reports
    ),
    breakdown AS (
        SELECT r.reported_type AS t_type, r.reported_id AS t_id,
               jsonb_object_agg(r.reason_category, c) AS breakdown_json
          FROM (
            SELECT reported_type, reported_id, reason_category, COUNT(*) AS c
              FROM commander_home_content_reports
             WHERE status = 'pending'
               AND created_at > NOW() - (p_lookback_days || ' days')::interval
             GROUP BY reported_type, reported_id, reason_category
          ) r
         GROUP BY r.reported_type, r.reported_id
    )
    SELECT a.t_type, a.t_id, a.rc, a.ur,
           COALESCE(b.breakdown_json, '{}'::jsonb),
           a.fr, a.lr,
           CASE 
               WHEN a.ur >= 5 AND a.rc >= 5 THEN 'auto_action_recommended'
               WHEN a.ur >= 3 THEN 'review_urgently'
               ELSE 'review_normally'
           END
      FROM agg a
      LEFT JOIN breakdown b ON b.t_type = a.t_type AND b.t_id = a.t_id
     ORDER BY a.ur DESC, a.rc DESC;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.detect_home_abuse_patterns(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_home_abuse_patterns(int, int) TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- Faceted browse — counts per city, state, stakes, tags
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_home_groups_facets()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_facets jsonb;
BEGIN
    SELECT jsonb_build_object(
        'cities', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('city', city, 'state', state, 'count', c))
              FROM (SELECT city, state, COUNT(*) AS c FROM commander_home_groups 
                     WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
                       AND last_activity_at > NOW() - INTERVAL '45 days'
                       AND city IS NOT NULL
                     GROUP BY city, state 
                     ORDER BY c DESC 
                     LIMIT 30) t
        ), '[]'::jsonb),
        'states', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', state, 'count', c))
              FROM (SELECT state, COUNT(*) AS c FROM commander_home_groups 
                     WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
                       AND last_activity_at > NOW() - INTERVAL '45 days'
                       AND state IS NOT NULL
                     GROUP BY state
                     ORDER BY c DESC) t
        ), '[]'::jsonb),
        'game_types', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('game_type', default_game_type, 'count', c))
              FROM (SELECT default_game_type, COUNT(*) AS c FROM commander_home_groups 
                     WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
                       AND last_activity_at > NOW() - INTERVAL '45 days'
                       AND default_game_type IS NOT NULL
                     GROUP BY default_game_type 
                     ORDER BY c DESC) t
        ), '[]'::jsonb),
        'stakes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('stakes', default_stakes, 'count', c))
              FROM (SELECT default_stakes, COUNT(*) AS c FROM commander_home_groups 
                     WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
                       AND last_activity_at > NOW() - INTERVAL '45 days'
                       AND default_stakes IS NOT NULL
                     GROUP BY default_stakes 
                     ORDER BY c DESC) t
        ), '[]'::jsonb),
        'tags', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('tag', tag, 'count', c))
              FROM (SELECT unnest(tags) AS tag, COUNT(*) AS c 
                      FROM commander_home_groups 
                     WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
                       AND last_activity_at > NOW() - INTERVAL '45 days'
                       AND tags IS NOT NULL AND array_length(tags, 1) > 0
                     GROUP BY unnest(tags)
                     ORDER BY c DESC 
                     LIMIT 30) t
        ), '[]'::jsonb),
        'total_discoverable', (
            SELECT COUNT(*) FROM commander_home_groups 
             WHERE NOT is_private AND is_active AND profile_photo_url IS NOT NULL
               AND last_activity_at > NOW() - INTERVAL '45 days'
        )
    ) INTO v_facets;

    RETURN v_facets;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_home_groups_facets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_home_groups_facets() TO anon, authenticated, service_role;
