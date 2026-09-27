-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419213631 "phase31d_remove_obsolete_text_casts_in_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1547f66a2b174ad726de85f17306932a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 31D — Remove obsolete ::text casts from 3 Phase 27/28 RPCs
-- 
-- After Phase 31 converted venue_checkins.{user_id,venue_id} to uuid/integer,
-- these functions still had legacy ::text casts. They still worked because
-- casts between compatible types are permitted, but they:
--   1. Bypass the new index types (potential perf loss)
--   2. Leave stale idioms in the code
--   3. Made future refactors riskier
-- Each function body is otherwise preserved byte-for-byte.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1. get_venue_manager_dashboard — 3 casts removed
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_manager_dashboard(
    p_venue_id integer, p_caller_user_id uuid, p_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_venue RECORD; v_cutoff timestamptz; v_is_manager boolean; v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    v_cutoff := NOW() - (p_days || ' days')::interval;

    SELECT id, name, slug, city, state, venue_type, trust_score, is_claimed, claimed_by, 
           follower_count, poker_tables, captain_enabled, commander_enabled
      INTO v_venue FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    v_is_manager := public.is_venue_manager(p_caller_user_id, p_venue_id);
    IF NOT v_is_manager AND v_venue.claimed_by <> p_caller_user_id THEN 
        RAISE EXCEPTION 'NOT_VENUE_MANAGER'; 
    END IF;

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window_days', p_days,
        'venue', row_to_json(v_venue),
        'audience', jsonb_build_object(
            'total_followers', COALESCE(v_venue.follower_count, 0),
            'new_followers_in_window', (SELECT COUNT(*) FROM commander_venue_followers 
                                          WHERE venue_id = p_venue_id AND followed_at >= v_cutoff),
            'follower_notify_posts', (SELECT COUNT(*) FROM commander_venue_followers 
                                        WHERE venue_id = p_venue_id AND notify_posts = true),
            'follower_notify_tournaments', (SELECT COUNT(*) FROM commander_venue_followers 
                                              WHERE venue_id = p_venue_id AND notify_tournaments = true)
        ),
        'content', jsonb_build_object(
            'posts_total', (SELECT COUNT(*) FROM commander_venue_posts 
                             WHERE venue_id = p_venue_id AND is_published = true),
            'posts_in_window', (SELECT COUNT(*) FROM commander_venue_posts 
                                 WHERE venue_id = p_venue_id AND is_published = true 
                                   AND created_at >= v_cutoff),
            'posts_by_type', (SELECT jsonb_object_agg(post_type, cnt)
                               FROM (SELECT post_type, COUNT(*) AS cnt 
                                       FROM commander_venue_posts 
                                      WHERE venue_id = p_venue_id AND is_published = true 
                                        AND created_at >= v_cutoff
                                      GROUP BY post_type) t),
            'total_post_likes_in_window', COALESCE((
                SELECT SUM(likes_count) FROM commander_venue_posts 
                 WHERE venue_id = p_venue_id AND created_at >= v_cutoff), 0),
            'pinned_posts', (SELECT COUNT(*) FROM commander_venue_posts 
                              WHERE venue_id = p_venue_id AND is_pinned = true AND is_published = true)
        ),
        'reviews', jsonb_build_object(
            'total', (SELECT COUNT(*) FROM commander_venue_reviews 
                       WHERE venue_id = p_venue_id AND is_published = true),
            'new_in_window', (SELECT COUNT(*) FROM commander_venue_reviews 
                               WHERE venue_id = p_venue_id AND is_published = true 
                                 AND created_at >= v_cutoff),
            'avg_rating', COALESCE((SELECT ROUND(AVG(overall_rating), 2) FROM commander_venue_reviews 
                                      WHERE venue_id = p_venue_id AND is_published = true), 0),
            'rating_distribution', (
                SELECT jsonb_object_agg(overall_rating::text, cnt)
                  FROM (SELECT overall_rating, COUNT(*) AS cnt FROM commander_venue_reviews 
                         WHERE venue_id = p_venue_id AND is_published = true
                         GROUP BY overall_rating) t
            ),
            'awaiting_response', (SELECT COUNT(*) FROM commander_venue_reviews 
                                    WHERE venue_id = p_venue_id AND is_published = true 
                                      AND venue_response IS NULL 
                                      AND created_at >= v_cutoff),
            'verified_reviews', (SELECT COUNT(*) FROM commander_venue_reviews 
                                   WHERE venue_id = p_venue_id AND is_published = true 
                                     AND is_verified = true)
        ),
        -- Phase 31D: ::text casts removed; venue_checkins.venue_id is now integer
        'checkins', jsonb_build_object(
            'total_in_window', (SELECT COUNT(*) FROM venue_checkins 
                                  WHERE venue_id = p_venue_id AND created_at >= v_cutoff),
            'unique_users_in_window', (SELECT COUNT(DISTINCT user_id) FROM venue_checkins 
                                         WHERE venue_id = p_venue_id AND created_at >= v_cutoff)
        ),
        'tournaments', jsonb_build_object(
            'this_week', (SELECT COUNT(*) FROM venue_daily_tournaments 
                            WHERE venue_id = p_venue_id 
                              AND COALESCE(is_active, true) AND NOT COALESCE(is_suppressed, false)),
            'suppressed', (SELECT COUNT(*) FROM venue_daily_tournaments 
                             WHERE venue_id = p_venue_id AND COALESCE(is_suppressed, false) = true)
        ),
        'media', jsonb_build_object(
            'total_photos', (SELECT COUNT(*) FROM commander_venue_photos WHERE venue_id = p_venue_id),
            'has_cover', (SELECT EXISTS(SELECT 1 FROM commander_venue_photos 
                                          WHERE venue_id = p_venue_id AND is_cover_photo = true))
        ),
        -- Phase 31D: c.venue_id = v.id::text cast removed (both now integer)
        'trending_rank_in_city', (
            SELECT rank FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY 
                    (SELECT COUNT(*) FROM venue_checkins c 
                      WHERE c.venue_id = v.id AND c.created_at >= v_cutoff) * 4
                    + (SELECT COUNT(*) FROM commander_venue_reviews r 
                        WHERE r.venue_id = v.id AND r.is_published = true 
                          AND r.created_at >= v_cutoff) * 3
                    + (SELECT COUNT(*) FROM commander_venue_followers f 
                        WHERE f.venue_id = v.id AND f.followed_at >= v_cutoff) * 2.5
                    + COALESCE(v.trust_score, 0) * 0.2
                    DESC NULLS LAST
                ) AS rank
                  FROM poker_venues v
                 WHERE v.state = v_venue.state AND v.city = v_venue.city
                   AND COALESCE(v.is_active, true) AND NOT COALESCE(v.is_suppressed, false)
            ) r WHERE r.id = p_venue_id
        )
    ) INTO v_result;
    RETURN v_result;
END; $fn$;

-- ────────────────────────────────────────────────────────────────────────
-- 2. submit_venue_review — 2 casts removed (venue_id + user_id)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_venue_review(
    p_venue_id integer, p_caller_user_id uuid, p_overall_rating integer,
    p_title text DEFAULT NULL::text, p_content text DEFAULT NULL::text,
    p_game_selection_rating integer DEFAULT NULL::integer, 
    p_staff_rating integer DEFAULT NULL::integer,
    p_atmosphere_rating integer DEFAULT NULL::integer,
    p_food_rating integer DEFAULT NULL::integer,
    p_visit_date date DEFAULT NULL::date,
    p_games_played text[] DEFAULT NULL::text[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE 
    v_venue RECORD; v_id uuid; v_visited boolean; v_recent_count int; v_existing uuid;
    v_tmp_rating int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_overall_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_OVERALL_RATING'; END IF;
    FOREACH v_tmp_rating IN ARRAY ARRAY[p_game_selection_rating, p_staff_rating, p_atmosphere_rating, p_food_rating] LOOP
        IF v_tmp_rating IS NOT NULL AND v_tmp_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_SUBRATING'; END IF;
    END LOOP;
    IF p_content IS NOT NULL AND length(p_content) > 5000 THEN RAISE EXCEPTION 'CONTENT_TOO_LONG'; END IF;

    SELECT id, name INTO v_venue FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    SELECT id INTO v_existing FROM commander_venue_reviews 
     WHERE venue_id = p_venue_id AND reviewer_id = p_caller_user_id;

    SELECT COUNT(*) INTO v_recent_count FROM commander_venue_reviews 
     WHERE reviewer_id = p_caller_user_id AND created_at > NOW() - INTERVAL '24 hours';
    IF v_recent_count >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;

    -- Phase 31D: venue_id and user_id are both now typed correctly; no casts.
    SELECT EXISTS(SELECT 1 FROM venue_checkins 
                   WHERE venue_id = p_venue_id AND user_id = p_caller_user_id) INTO v_visited;

    IF v_existing IS NOT NULL THEN
        UPDATE commander_venue_reviews 
           SET overall_rating = p_overall_rating, title = COALESCE(p_title, title),
               content = COALESCE(p_content, content),
               game_selection_rating = COALESCE(p_game_selection_rating, game_selection_rating),
               staff_rating = COALESCE(p_staff_rating, staff_rating),
               atmosphere_rating = COALESCE(p_atmosphere_rating, atmosphere_rating),
               food_rating = COALESCE(p_food_rating, food_rating),
               visit_date = COALESCE(p_visit_date, visit_date),
               games_played = COALESCE(p_games_played, games_played),
               is_verified = v_visited, updated_at = NOW()
         WHERE id = v_existing;
        RETURN jsonb_build_object('success', true, 'review_id', v_existing, 'updated', true);
    END IF;

    INSERT INTO commander_venue_reviews (
        venue_id, reviewer_id, overall_rating, title, content,
        game_selection_rating, staff_rating, atmosphere_rating, food_rating,
        visit_date, games_played, is_verified, is_published
    ) VALUES (
        p_venue_id, p_caller_user_id, p_overall_rating, p_title, p_content,
        p_game_selection_rating, p_staff_rating, p_atmosphere_rating, p_food_rating,
        p_visit_date, p_games_played, v_visited, true
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'review_id', v_id, 'is_verified', v_visited);
END; $fn$;

-- ────────────────────────────────────────────────────────────────────────
-- 3. get_venue_public_detail — 2 casts removed
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_public_detail(
    p_venue_slug text DEFAULT NULL::text, 
    p_venue_id integer DEFAULT NULL::integer, 
    p_caller_user_id uuid DEFAULT NULL::uuid
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
            -- Phase 31D: ::text cast removed
            'checkin_count_30d', (SELECT COUNT(*) FROM venue_checkins 
                                    WHERE venue_id = v_venue.id
                                      AND created_at > NOW() - INTERVAL '30 days'),
            'review_count', (SELECT COUNT(*) FROM commander_venue_reviews 
                              WHERE venue_id = v_venue.id AND is_published = true),
            'avg_rating', COALESCE((SELECT ROUND(AVG(overall_rating), 2) FROM commander_venue_reviews 
                                      WHERE venue_id = v_venue.id AND is_published = true), 0),
            'photo_count', (SELECT COUNT(*) FROM commander_venue_photos WHERE venue_id = v_venue.id),
            'tournament_count_this_week', (
                SELECT COUNT(*) FROM venue_daily_tournaments 
                 WHERE venue_id = v_venue.id
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
        -- Phase 31D: ::text cast removed
        'recent_checkins', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'user_name', user_name, 'message', message, 'created_at', created_at
            ) ORDER BY created_at DESC), '[]'::jsonb)
              FROM (SELECT user_name, message, created_at FROM venue_checkins 
                     WHERE venue_id = v_venue.id
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
