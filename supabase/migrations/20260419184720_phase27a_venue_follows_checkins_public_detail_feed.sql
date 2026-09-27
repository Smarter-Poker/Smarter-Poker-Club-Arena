-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419184720 "phase27a_venue_follows_checkins_public_detail_feed"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 50cb67167df179dfdb2fe852034824f1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  PHASE 27 PART A — Venue social: follows + check-ins + public detail + feed
--  Zero money. Pure social/content/discovery. No transactions.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1) follow_venue / unfollow_venue / get_my_followed_venues
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.follow_venue(
    p_venue_id         integer,
    p_caller_user_id   uuid,
    p_notify_posts     boolean DEFAULT true,
    p_notify_events    boolean DEFAULT true,
    p_notify_promotions boolean DEFAULT false,
    p_notify_tournaments boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_venue RECORD; v_existing uuid; v_id uuid;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT id, name, is_active, is_suppressed INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND OR COALESCE(v_venue.is_suppressed, false) OR NOT COALESCE(v_venue.is_active, true) 
    THEN RAISE EXCEPTION 'VENUE_NOT_FOUND_OR_INACTIVE'; END IF;

    SELECT id INTO v_existing FROM commander_venue_followers 
     WHERE venue_id = p_venue_id AND user_id = p_caller_user_id;

    IF v_existing IS NOT NULL THEN
        UPDATE commander_venue_followers 
           SET notify_posts=p_notify_posts, notify_events=p_notify_events,
               notify_promotions=p_notify_promotions, notify_tournaments=p_notify_tournaments
         WHERE id = v_existing;
        RETURN jsonb_build_object('success', true, 'already_following', true, 'follow_id', v_existing);
    END IF;

    INSERT INTO commander_venue_followers (venue_id, user_id, notify_posts, notify_events, notify_promotions, notify_tournaments)
    VALUES (p_venue_id, p_caller_user_id, p_notify_posts, p_notify_events, p_notify_promotions, p_notify_tournaments)
    RETURNING id INTO v_id;

    -- Keep denormalized counter in sync if helper trigger isn't firing
    UPDATE poker_venues SET follower_count = COALESCE(follower_count, 0) + 1 WHERE id = p_venue_id;

    RETURN jsonb_build_object('success', true, 'follow_id', v_id, 'venue_id', p_venue_id, 'venue_name', v_venue.name);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.follow_venue(integer, uuid, boolean, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.follow_venue(integer, uuid, boolean, boolean, boolean, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unfollow_venue(p_venue_id integer, p_caller_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_deleted int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    WITH d AS (
      DELETE FROM commander_venue_followers 
       WHERE venue_id = p_venue_id AND user_id = p_caller_user_id RETURNING 1
    ) SELECT COUNT(*) INTO v_deleted FROM d;

    IF v_deleted > 0 THEN
        UPDATE poker_venues SET follower_count = GREATEST(0, COALESCE(follower_count, 1) - 1) 
         WHERE id = p_venue_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'unfollowed', v_deleted > 0);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.unfollow_venue(integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unfollow_venue(integer, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_followed_venues(
    p_caller_user_id uuid,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 100);
    p_offset := GREATEST(p_offset, 0);

    WITH followed AS (
      SELECT f.id AS follow_id, f.venue_id, f.followed_at,
             f.notify_posts, f.notify_events, f.notify_promotions, f.notify_tournaments,
             v.name, v.slug, v.city, v.state, v.venue_type, v.trust_score, v.is_claimed, v.follower_count
        FROM commander_venue_followers f
        JOIN poker_venues v ON v.id = f.venue_id
       WHERE f.user_id = p_caller_user_id 
         AND COALESCE(v.is_active, true) AND NOT COALESCE(v.is_suppressed, false)
       ORDER BY f.followed_at DESC
       LIMIT p_limit OFFSET p_offset
    )
    SELECT jsonb_build_object(
      'generated_at', NOW(),
      'total_follows', (SELECT COUNT(*) FROM commander_venue_followers WHERE user_id = p_caller_user_id),
      'returned', (SELECT COUNT(*) FROM followed),
      'venues', COALESCE((SELECT jsonb_agg(row_to_json(followed)) FROM followed), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_my_followed_venues(uuid, int, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_followed_venues(uuid, int, int) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 2) Check in to a venue (casual "I'm here" — feeds venue_checkins table)
-- ────────────────────────────────────────────────────────────────────────
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

    -- Rate limit: max 10 check-ins per hour per user
    SELECT COUNT(*) INTO v_recent_count FROM venue_checkins 
     WHERE user_id = p_caller_user_id AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED' USING HINT='max 10 check-ins per hour'; END IF;

    SELECT COALESCE(display_name, username, 'Anonymous') INTO v_user_name FROM profiles WHERE id = p_caller_user_id;

    INSERT INTO venue_checkins (venue_id, user_id, user_name, message)
    VALUES (p_venue_id, p_caller_user_id, v_user_name, p_message)
    RETURNING id INTO v_id;

    -- Also append to user_venue_checkins for personal history + review-prompt pipeline
    INSERT INTO user_venue_checkins (user_id, venue_id, checkin_time)
    VALUES (p_caller_user_id, p_venue_id, NOW());

    RETURN jsonb_build_object('success', true, 'checkin_id', v_id, 'venue_id', p_venue_id, 'venue_name', v_venue.name);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.checkin_to_venue(integer, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.checkin_to_venue(integer, uuid, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 3) Public venue detail — single call for /poker-near-me/[slug] pages
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_public_detail(
    p_venue_slug      text DEFAULT NULL,
    p_venue_id        integer DEFAULT NULL,
    p_caller_user_id  uuid DEFAULT NULL  -- optional; used to surface "is_following" flag
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_venue RECORD; v_result jsonb; v_is_following boolean := false;
BEGIN
    IF p_venue_slug IS NULL AND p_venue_id IS NULL THEN RAISE EXCEPTION 'SLUG_OR_ID_REQUIRED'; END IF;

    SELECT id, name, slug, tagline, about, city, state, country, address, phone, website,
           venue_type, poker_tables, stakes_cash, games_offered, hours,
           latitude, longitude, trust_score, is_claimed, claimed_by,
           is_featured, commander_enabled, captain_enabled,
           follower_count
      INTO v_venue
      FROM poker_venues
     WHERE (p_venue_id IS NOT NULL AND id = p_venue_id)
        OR (p_venue_slug IS NOT NULL AND slug = p_venue_slug)
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
                                    WHERE venue_id = v_venue.id 
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
REVOKE EXECUTE ON FUNCTION public.get_venue_public_detail(text, integer, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_venue_public_detail(text, integer, uuid) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 4) Unified venue feed — posts + news + reviews timeline
-- ────────────────────────────────────────────────────────────────────────
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
        'generated_at', NOW(),
        'venue_id', p_venue_id,
        'count', LEAST(COUNT(*), p_limit),
        'has_more', COUNT(*) > p_limit,
        'next_cursor', (SELECT MIN(ts) FROM (SELECT ts FROM unified ORDER BY ts DESC LIMIT p_limit) t),
        'items', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'type', item_type, 'id', item_id, 'ts', ts, 'payload', payload
            ) ORDER BY ts DESC)
              FROM (SELECT * FROM unified ORDER BY ts DESC LIMIT p_limit) t
        ), '[]'::jsonb)
    ) INTO v_result
      FROM unified;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_feed(integer, timestamptz, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_venue_feed(integer, timestamptz, int) TO anon, authenticated, service_role;

-- Indexes that back these queries
CREATE INDEX IF NOT EXISTS idx_venue_checkins_venue_created 
    ON venue_checkins (venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commander_venue_followers_user 
    ON commander_venue_followers (user_id, followed_at DESC);
CREATE INDEX IF NOT EXISTS idx_commander_venue_posts_venue_created 
    ON commander_venue_posts (venue_id, created_at DESC) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_commander_venue_reviews_venue_created 
    ON commander_venue_reviews (venue_id, created_at DESC) WHERE is_published = true;

COMMENT ON FUNCTION public.follow_venue(integer, uuid, boolean, boolean, boolean, boolean) IS
  'Phase 27/A: Follow a venue to subscribe to posts/events/promotions/tournaments. No money.';
COMMENT ON FUNCTION public.get_venue_public_detail(text, integer, uuid) IS
  'Phase 27/A: Single-call public venue page data. Safe for anon. Used by /poker-near-me/[slug].';
COMMENT ON FUNCTION public.get_venue_feed(integer, timestamptz, int) IS
  'Phase 27/A: Unified posts + news + reviews timeline for venue pages. Paginated via cursor.';
