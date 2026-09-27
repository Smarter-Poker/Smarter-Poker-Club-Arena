-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184915 "phase27a_fix_tournament_venueid_cast"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 042b7e916f06f85df5f2db3bb4dc46d3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- venue_daily_tournaments.venue_id is integer — only venue_checkins is text
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
                 WHERE venue_id = v_venue.id  -- integer, no cast
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
