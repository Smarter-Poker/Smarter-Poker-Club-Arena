-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419185134 "phase27b_fix_rating_loop_variable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 aa0e2e1428bed2b7574729266d6b1b20 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: was overwriting p_overall_rating in the subrating loop
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

    SELECT EXISTS(SELECT 1 FROM venue_checkins 
                   WHERE venue_id = p_venue_id::text AND user_id = p_caller_user_id::text) INTO v_visited;

    IF v_existing IS NOT NULL THEN
        UPDATE commander_venue_reviews 
           SET overall_rating = p_overall_rating,
               title = COALESCE(p_title, title),
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
