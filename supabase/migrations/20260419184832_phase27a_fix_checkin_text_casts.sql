-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184832 "phase27a_fix_checkin_text_casts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5d3ae954cb473156f197825039be0643 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: venue_checkins uses text for user_id + venue_id (legacy schema)
-- Also: user_venue_checkins.venue_id is uuid but poker_venues.id is integer — 
-- skip writing to that table until schema drift is reconciled separately.
CREATE OR REPLACE FUNCTION public.checkin_to_venue(
    p_venue_id        integer,
    p_caller_user_id  uuid,
    p_message         text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_venue RECORD; v_user_name text; v_id uuid; v_recent_count int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_message IS NOT NULL AND length(p_message) > 500 THEN RAISE EXCEPTION 'MESSAGE_TOO_LONG'; END IF;

    SELECT id, name INTO v_venue FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    -- Rate limit: venue_checkins.user_id is text, cast accordingly
    SELECT COUNT(*) INTO v_recent_count FROM venue_checkins 
     WHERE user_id = p_caller_user_id::text AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED' USING HINT='max 10 check-ins per hour'; END IF;

    SELECT COALESCE(display_name, username, 'Anonymous') INTO v_user_name 
      FROM profiles WHERE id = p_caller_user_id;

    INSERT INTO venue_checkins (venue_id, user_id, user_name, message)
    VALUES (p_venue_id::text, p_caller_user_id::text, v_user_name, p_message)
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
      'success', true, 'checkin_id', v_id, 
      'venue_id', p_venue_id, 'venue_name', v_venue.name,
      'note', 'user_venue_checkins not written due to pre-existing venue_id uuid/integer type mismatch'
    );
END; $fn$;

-- Also fix the recent_checkins subquery in get_venue_public_detail — it implicitly 
-- filtered venue_id by integer but column is text
CREATE OR REPLACE FUNCTION public.get_venue_public_detail(
    p_venue_slug      text DEFAULT NULL,
    p_venue_id        integer DEFAULT NULL,
    p_caller_user_id  uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_venue RECORD; v_result jsonb; v_is_following boolean := false;
BEGIN
    IF p_venue_slug IS NULL AND p_venue_id IS NULL THEN RAISE EXCEPTION 'SLUG_OR_ID_REQUIRED'; END IF;

    SELECT id, name, slug, tagline, about, city, state, country, address, phone, website,
           venue_type, poker_tables, stakes_cash, games_offered, hours,
           latitude, longitude, trust_score, is_claimed, claimed_by,
           is_featured, commander_enabled, captain_enabled, follower_count
      INTO v_venue
      FROM poker_venues
     WHERE ((p_venue_id IS NOT NULL AND id = p_venue_id)
            OR (p_venue_slug IS NOT NULL AND slug = p_venue_slug))
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
     LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    IF p_caller_user_id IS NOT NULL AND auth.uid() = p_caller_user_id THEN
        SELECT EXISTS(SELECT 1 FROM commander_venue_followers 
                       WHERE venue_id = v_venue.id AND user_id = p_caller_user_id) INTO v_is_following;
    END IF;

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'venue', row_to_json(v_venue),
        'is_following', v_is_following,
        'stats', jsonb_build_object(
            'follower_count', COALESCE(v_venue.follower_count, 0),
            'post_count', (SELECT COUNT(*) FROM commander_venue_posts 
                            WHERE venue_id = v_venue.id AND is_published = true),
            'checkin_count_30d', (SELECT COUNT(*) FROM venue_checkins 
                                    WHERE venue_id = v_venue.id::text
                                      AND created_at > NOW() - INTERVAL '30 days'),
            'review_count', (SELECT COUNT(*) FROM commander_venue_reviews 
                              WHERE venue_id = v_venue.id AND is_published = true),
            'avg_rating', COALESCE((SELECT ROUND(AVG(overall_rating), 2) FROM commander_venue_reviews 
                                      WHERE venue_id = v_venue.id AND is_published = true), 0),
            'photo_count', (SELECT COUNT(*) FROM commander_venue_photos WHERE venue_id = v_venue.id),
            'tournament_count_this_week', (
                SELECT COUNT(*) FROM venue_daily_tournaments 
                 WHERE venue_id = v_venue.id::text
                   AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false)
            )
        ),
        'cover_photo', (SELECT url FROM commander_venue_photos 
                         WHERE venue_id = v_venue.id AND is_cover_photo = true LIMIT 1),
        'recent_posts', (
            SELECT COALESCE(jsonb_agg(row_to_json(p) ORDER BY p.created_at DESC), '[]'::jsonb)
              FROM (SELECT id, author_id, author_name, content, post_type, image_urls, video_url,
                           likes_count, comments_count, is_pinned, created_at
                      FROM commander_venue_posts 
                     WHERE venue_id = v_venue.id AND is_published = true
                     ORDER BY is_pinned DESC, created_at DESC
                     LIMIT 5) p
        ),
        'recent_checkins', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'user_name', user_name, 'message', message, 'created_at', created_at
            ) ORDER BY created_at DESC), '[]'::jsonb)
              FROM (SELECT user_name, message, created_at FROM venue_checkins 
                     WHERE venue_id = v_venue.id::text
                     ORDER BY created_at DESC LIMIT 10) t
        ),
        'latest_news', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'title', title, 'published_at', published_at, 'source_url', source_url
            ) ORDER BY published_at DESC), '[]'::jsonb)
              FROM (SELECT title, published_at, source_url FROM venue_news 
                     WHERE venue_id = v_venue.id AND COALESCE(is_active,true)
                     ORDER BY published_at DESC LIMIT 3) t
        )
    ) INTO v_result;

    RETURN v_result;
END; $fn$;

-- Also cast in feed
CREATE OR REPLACE FUNCTION public.get_venue_feed(
    p_venue_id  integer,
    p_cursor    timestamptz DEFAULT NULL,
    p_limit     int DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    p_limit := LEAST(GREATEST(p_limit, 1), 50);
    p_cursor := COALESCE(p_cursor, NOW() + INTERVAL '1 day');

    WITH unified AS (
        SELECT 'post'::text AS item_type, id::text AS item_id, created_at AS ts,
               jsonb_build_object(
                   'author_name', author_name, 'content', content, 'post_type', post_type,
                   'image_urls', image_urls, 'video_url', video_url,
                   'likes_count', likes_count, 'comments_count', comments_count,
                   'is_pinned', is_pinned
               ) AS payload
          FROM commander_venue_posts 
         WHERE venue_id = p_venue_id AND is_published = true AND created_at < p_cursor
        UNION ALL
        SELECT 'news'::text, id::text, COALESCE(published_at, scraped_at) AS ts,
               jsonb_build_object(
                   'title', title, 'content', content, 'image_url', image_url,
                   'source_url', source_url, 'published_at', published_at
               ) AS payload
          FROM venue_news 
         WHERE venue_id = p_venue_id AND COALESCE(is_active,true)
           AND COALESCE(published_at, scraped_at) < p_cursor
        UNION ALL
        SELECT 'review'::text, id::text, created_at,
               jsonb_build_object(
                   'reviewer_id', reviewer_id, 'overall_rating', overall_rating,
                   'title', title, 'content', content, 'visit_date', visit_date,
                   'helpful_count', helpful_count, 'is_verified', is_verified,
                   'venue_response', venue_response, 'venue_responded_at', venue_responded_at
               ) AS payload
          FROM commander_venue_reviews 
         WHERE venue_id = p_venue_id AND is_published = true AND created_at < p_cursor
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(), 'venue_id', p_venue_id,
        'count', LEAST((SELECT COUNT(*) FROM unified), p_limit),
        'has_more', (SELECT COUNT(*) FROM unified) > p_limit,
        'next_cursor', (SELECT MIN(ts) FROM (SELECT ts FROM unified ORDER BY ts DESC LIMIT p_limit) t),
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'type', item_type, 'id', item_id, 'ts', ts, 'payload', payload) ORDER BY ts DESC)
              FROM (SELECT * FROM unified ORDER BY ts DESC LIMIT p_limit) t
        ), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
