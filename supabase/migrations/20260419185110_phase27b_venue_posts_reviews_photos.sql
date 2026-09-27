-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419185110 "phase27b_venue_posts_reviews_photos"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 df45ad70474613325e90f896f58d28ce of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
--  PHASE 27 PART B — Venue posts, reviews, photos
--  Post creation = manager-only (via existing is_venue_manager helper)
--  Review submission = any authenticated user
--  Review response = manager-only
--  Photo upload = manager-only (users can submit via claim/request flow later)
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- Posts: create, edit, delete, pin
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_venue_post(
    p_venue_id         integer,
    p_caller_user_id   uuid,
    p_content          text,
    p_post_type        text DEFAULT 'update',  -- update|event|promotion|tournament|announcement
    p_image_urls       text[] DEFAULT NULL,
    p_video_url        text DEFAULT NULL,
    p_is_pinned        boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_is_manager boolean; v_author_name text; v_id uuid; v_recent_count int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF length(trim(p_content)) < 2 OR length(p_content) > 5000 THEN RAISE EXCEPTION 'INVALID_CONTENT_LENGTH'; END IF;
    IF p_post_type NOT IN ('update','event','promotion','tournament','announcement') 
    THEN RAISE EXCEPTION 'INVALID_POST_TYPE'; END IF;

    v_is_manager := public.is_venue_manager(p_caller_user_id, p_venue_id);
    IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_VENUE_MANAGER'; END IF;

    -- Rate limit: 20 posts per hour per manager
    SELECT COUNT(*) INTO v_recent_count FROM commander_venue_posts 
     WHERE author_id = p_caller_user_id AND created_at > NOW() - INTERVAL '1 hour';
    IF v_recent_count >= 20 THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;

    SELECT COALESCE(display_name, username, 'Venue') INTO v_author_name FROM profiles WHERE id = p_caller_user_id;

    INSERT INTO commander_venue_posts (
        venue_id, author_id, author_name, content, post_type,
        image_urls, video_url, is_pinned, is_published
    ) VALUES (
        p_venue_id, p_caller_user_id, v_author_name, p_content, p_post_type,
        p_image_urls, p_video_url, p_is_pinned, true
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'post_id', v_id, 'venue_id', p_venue_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.create_venue_post(integer, uuid, text, text, text[], text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_venue_post(integer, uuid, text, text, text[], text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.edit_venue_post(
    p_post_id          uuid,
    p_caller_user_id   uuid,
    p_content          text DEFAULT NULL,
    p_post_type        text DEFAULT NULL,
    p_image_urls       text[] DEFAULT NULL,
    p_video_url        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_post RECORD; v_is_manager boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_post FROM commander_venue_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;

    -- Author OR any venue manager can edit
    IF v_post.author_id <> p_caller_user_id THEN
        v_is_manager := public.is_venue_manager(p_caller_user_id, v_post.venue_id);
        IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
    END IF;

    UPDATE commander_venue_posts 
       SET content = COALESCE(p_content, content),
           post_type = COALESCE(p_post_type, post_type),
           image_urls = COALESCE(p_image_urls, image_urls),
           video_url = COALESCE(p_video_url, video_url),
           updated_at = NOW()
     WHERE id = p_post_id;

    RETURN jsonb_build_object('success', true, 'post_id', p_post_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.edit_venue_post(uuid, uuid, text, text, text[], text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.edit_venue_post(uuid, uuid, text, text, text[], text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_venue_post(p_post_id uuid, p_caller_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_post RECORD; v_is_manager boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_post FROM commander_venue_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    IF v_post.author_id <> p_caller_user_id THEN
        v_is_manager := public.is_venue_manager(p_caller_user_id, v_post.venue_id);
        IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
    END IF;
    -- Soft-delete via is_published = false (preserves audit trail)
    UPDATE commander_venue_posts SET is_published = false, updated_at = NOW() WHERE id = p_post_id;
    RETURN jsonb_build_object('success', true);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.delete_venue_post(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_venue_post(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.toggle_venue_post_pin(p_post_id uuid, p_caller_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_post RECORD; v_is_manager boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_post FROM commander_venue_posts WHERE id = p_post_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
    v_is_manager := public.is_venue_manager(p_caller_user_id, v_post.venue_id);
    IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_VENUE_MANAGER'; END IF;
    UPDATE commander_venue_posts SET is_pinned = NOT is_pinned, updated_at = NOW() WHERE id = p_post_id;
    RETURN jsonb_build_object('success', true, 'is_pinned', NOT v_post.is_pinned);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.toggle_venue_post_pin(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.toggle_venue_post_pin(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Reviews: submit, respond (venue), mark helpful, flag
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_venue_review(
    p_venue_id              integer,
    p_caller_user_id        uuid,
    p_overall_rating        int,
    p_title                 text DEFAULT NULL,
    p_content               text DEFAULT NULL,
    p_game_selection_rating int DEFAULT NULL,
    p_staff_rating          int DEFAULT NULL,
    p_atmosphere_rating     int DEFAULT NULL,
    p_food_rating           int DEFAULT NULL,
    p_visit_date            date DEFAULT NULL,
    p_games_played          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_venue RECORD; v_id uuid; v_visited boolean; v_recent_count int; v_existing uuid;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_overall_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_OVERALL_RATING'; END IF;
    FOREACH p_overall_rating IN ARRAY ARRAY[p_game_selection_rating, p_staff_rating, p_atmosphere_rating, p_food_rating] LOOP
        IF p_overall_rating IS NOT NULL AND p_overall_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'INVALID_SUBRATING'; END IF;
    END LOOP;
    IF p_content IS NOT NULL AND length(p_content) > 5000 THEN RAISE EXCEPTION 'CONTENT_TOO_LONG'; END IF;

    SELECT id, name INTO v_venue FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active,true) AND NOT COALESCE(is_suppressed,false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;

    -- One review per user per venue — upsert
    SELECT id INTO v_existing FROM commander_venue_reviews 
     WHERE venue_id = p_venue_id AND reviewer_id = p_caller_user_id;

    -- Rate limit
    SELECT COUNT(*) INTO v_recent_count FROM commander_venue_reviews 
     WHERE reviewer_id = p_caller_user_id AND created_at > NOW() - INTERVAL '24 hours';
    IF v_recent_count >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;

    -- Check if user has actually been to this venue (auto-verified review)
    SELECT EXISTS(SELECT 1 FROM venue_checkins 
                   WHERE venue_id = p_venue_id::text AND user_id = p_caller_user_id::text) INTO v_visited;

    IF v_existing IS NOT NULL THEN
        UPDATE commander_venue_reviews 
           SET overall_rating = COALESCE(p_overall_rating, overall_rating),
               title = COALESCE(p_title, title),
               content = COALESCE(p_content, content),
               game_selection_rating = COALESCE(p_game_selection_rating, game_selection_rating),
               staff_rating = COALESCE(p_staff_rating, staff_rating),
               atmosphere_rating = COALESCE(p_atmosphere_rating, atmosphere_rating),
               food_rating = COALESCE(p_food_rating, food_rating),
               visit_date = COALESCE(p_visit_date, visit_date),
               games_played = COALESCE(p_games_played, games_played),
               is_verified = v_visited,
               updated_at = NOW()
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
REVOKE EXECUTE ON FUNCTION public.submit_venue_review(integer, uuid, int, text, text, int, int, int, int, date, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_venue_review(integer, uuid, int, text, text, int, int, int, int, date, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.respond_to_venue_review(
    p_review_id       uuid,
    p_caller_user_id  uuid,
    p_response        text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_review RECORD; v_is_manager boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF length(trim(p_response)) < 2 OR length(p_response) > 2000 THEN RAISE EXCEPTION 'INVALID_RESPONSE'; END IF;
    SELECT * INTO v_review FROM commander_venue_reviews WHERE id = p_review_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;

    v_is_manager := public.is_venue_manager(p_caller_user_id, v_review.venue_id);
    IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_VENUE_MANAGER'; END IF;

    UPDATE commander_venue_reviews 
       SET venue_response = p_response, venue_responded_at = NOW(), updated_at = NOW()
     WHERE id = p_review_id;

    RETURN jsonb_build_object('success', true, 'review_id', p_review_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.respond_to_venue_review(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.respond_to_venue_review(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_venue_review_helpful(
    p_review_id       uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_new_count int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    -- Simple increment (not tracking which users marked helpful — would need a join table)
    UPDATE commander_venue_reviews SET helpful_count = COALESCE(helpful_count, 0) + 1
     WHERE id = p_review_id RETURNING helpful_count INTO v_new_count;
    IF v_new_count IS NULL THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('success', true, 'helpful_count', v_new_count);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.mark_venue_review_helpful(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_venue_review_helpful(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- Photos: upload, set cover, delete
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upload_venue_photo(
    p_venue_id         integer,
    p_caller_user_id   uuid,
    p_url              text,
    p_thumbnail_url    text DEFAULT NULL,
    p_caption          text DEFAULT NULL,
    p_category         text DEFAULT 'interior',
    p_is_featured      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_is_manager boolean; v_id uuid; v_next_order int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_url IS NULL OR length(p_url) < 10 THEN RAISE EXCEPTION 'INVALID_URL'; END IF;
    v_is_manager := public.is_venue_manager(p_caller_user_id, p_venue_id);
    IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_VENUE_MANAGER'; END IF;

    SELECT COALESCE(MAX(display_order), 0) + 1 INTO v_next_order 
      FROM commander_venue_photos WHERE venue_id = p_venue_id;

    INSERT INTO commander_venue_photos (
        venue_id, uploaded_by, url, thumbnail_url, caption, category, 
        is_featured, display_order
    ) VALUES (
        p_venue_id, p_caller_user_id, p_url, p_thumbnail_url, p_caption, p_category,
        p_is_featured, v_next_order
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'photo_id', v_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.upload_venue_photo(integer, uuid, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.upload_venue_photo(integer, uuid, text, text, text, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_venue_cover_photo(
    p_photo_id        uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_photo RECORD; v_is_manager boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_photo FROM commander_venue_photos WHERE id = p_photo_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PHOTO_NOT_FOUND'; END IF;
    v_is_manager := public.is_venue_manager(p_caller_user_id, v_photo.venue_id);
    IF NOT v_is_manager THEN RAISE EXCEPTION 'NOT_VENUE_MANAGER'; END IF;

    UPDATE commander_venue_photos SET is_cover_photo = false WHERE venue_id = v_photo.venue_id;
    UPDATE commander_venue_photos SET is_cover_photo = true WHERE id = p_photo_id;
    RETURN jsonb_build_object('success', true, 'venue_id', v_photo.venue_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.set_venue_cover_photo(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_venue_cover_photo(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_venue_post(integer, uuid, text, text, text[], text, boolean) IS
  'Phase 27/B: Manager-only venue post. 20/hr rate limit.';
COMMENT ON FUNCTION public.submit_venue_review(integer, uuid, int, text, text, int, int, int, int, date, text) IS
  'Phase 27/B: User review. Upserts (one review per user per venue). Auto-verified if prior check-in exists.';
COMMENT ON FUNCTION public.respond_to_venue_review(uuid, uuid, text) IS
  'Phase 27/B: Manager posts official venue response to a review.';
