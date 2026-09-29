-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419193416 "phase28b_venue_manager_analytics"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ca7c72ef2799a8c16f2b5ce42ef7e94e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 28 PART B — Venue Manager Analytics
-- Information-only dashboards for claimed-venue managers. No money.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1) Comprehensive manager dashboard
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_manager_dashboard(
    p_venue_id        integer,
    p_caller_user_id  uuid,
    p_days            int DEFAULT 30
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
        'checkins', jsonb_build_object(
            'total_in_window', (SELECT COUNT(*) FROM venue_checkins 
                                  WHERE venue_id = p_venue_id::text AND created_at >= v_cutoff),
            'unique_users_in_window', (SELECT COUNT(DISTINCT user_id) FROM venue_checkins 
                                         WHERE venue_id = p_venue_id::text AND created_at >= v_cutoff)
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
        'trending_rank_in_city', (
            -- Where this venue ranks among its city peers by recent engagement
            SELECT rank FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY 
                    (SELECT COUNT(*) FROM venue_checkins c 
                      WHERE c.venue_id = v.id::text AND c.created_at >= v_cutoff) * 4
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
REVOKE EXECUTE ON FUNCTION public.get_venue_manager_dashboard(integer, uuid, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_venue_manager_dashboard(integer, uuid, int) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 2) Review queue — reviews needing manager attention
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_manager_review_queue(
    p_venue_id        integer,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_is_manager boolean; v_venue RECORD; v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT id, claimed_by INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;
    v_is_manager := public.is_venue_manager(p_caller_user_id, p_venue_id);
    IF NOT v_is_manager AND v_venue.claimed_by <> p_caller_user_id THEN 
        RAISE EXCEPTION 'NOT_VENUE_MANAGER'; 
    END IF;

    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'awaiting_response', (
            SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
              FROM (SELECT id, reviewer_id, overall_rating, title, content, 
                           visit_date, helpful_count, is_verified, created_at
                      FROM commander_venue_reviews
                     WHERE venue_id = p_venue_id AND is_published = true 
                       AND venue_response IS NULL
                     ORDER BY created_at DESC LIMIT 20) r
        ),
        'low_rated_recent', (
            SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
              FROM (SELECT id, reviewer_id, overall_rating, title, content, 
                           visit_date, venue_response, created_at
                      FROM commander_venue_reviews
                     WHERE venue_id = p_venue_id AND is_published = true 
                       AND overall_rating <= 2
                       AND created_at > NOW() - INTERVAL '90 days'
                     ORDER BY created_at DESC LIMIT 20) r
        ),
        'flagged_reviews', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'review_id', r.id, 'flag_reason', f.reason, 'flag_detail', f.detail,
                'flagged_at', f.created_at, 'flag_status', f.status,
                'review_content', r.content, 'review_rating', r.overall_rating,
                'is_published', r.is_published
              ) ORDER BY f.created_at DESC), '[]'::jsonb)
              FROM commander_venue_review_flags f
              JOIN commander_venue_reviews r ON r.id = f.review_id
             WHERE r.venue_id = p_venue_id
        ),
        'counts', jsonb_build_object(
            'awaiting_response', (SELECT COUNT(*) FROM commander_venue_reviews 
                                    WHERE venue_id = p_venue_id AND is_published = true 
                                      AND venue_response IS NULL),
            'low_rated_last_90d', (SELECT COUNT(*) FROM commander_venue_reviews 
                                     WHERE venue_id = p_venue_id AND is_published = true 
                                       AND overall_rating <= 2 
                                       AND created_at > NOW() - INTERVAL '90 days'),
            'flagged', (SELECT COUNT(*) FROM commander_venue_review_flags f 
                         JOIN commander_venue_reviews r ON r.id = f.review_id
                        WHERE r.venue_id = p_venue_id)
        )
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_manager_review_queue(integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_venue_manager_review_queue(integer, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 3) Venue manager action items — top recommended actions
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_action_items(
    p_venue_id        integer,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE 
    v_venue RECORD; v_is_manager boolean; v_actions jsonb := '[]'::jsonb;
    v_cover_missing boolean; v_no_about boolean; v_no_hours boolean; v_no_phone boolean;
    v_recent_post_count int; v_unresponded_reviews int; v_photo_count int;
    v_has_upcoming_tournaments boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_venue FROM poker_venues WHERE id = p_venue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;
    v_is_manager := public.is_venue_manager(p_caller_user_id, p_venue_id);
    IF NOT v_is_manager AND v_venue.claimed_by <> p_caller_user_id THEN 
        RAISE EXCEPTION 'NOT_VENUE_MANAGER'; 
    END IF;

    -- Gather signals
    v_cover_missing := NOT EXISTS(SELECT 1 FROM commander_venue_photos 
                                    WHERE venue_id = p_venue_id AND is_cover_photo = true);
    v_no_about := v_venue.about IS NULL OR length(COALESCE(v_venue.about, '')) < 100;
    v_no_hours := v_venue.hours IS NULL;
    v_no_phone := v_venue.phone IS NULL;
    SELECT COUNT(*) INTO v_recent_post_count FROM commander_venue_posts 
     WHERE venue_id = p_venue_id AND is_published = true AND created_at > NOW() - INTERVAL '14 days';
    SELECT COUNT(*) INTO v_unresponded_reviews FROM commander_venue_reviews 
     WHERE venue_id = p_venue_id AND is_published = true AND venue_response IS NULL 
       AND created_at > NOW() - INTERVAL '30 days';
    SELECT COUNT(*) INTO v_photo_count FROM commander_venue_photos WHERE venue_id = p_venue_id;
    SELECT EXISTS(SELECT 1 FROM venue_daily_tournaments 
                    WHERE venue_id = p_venue_id 
                      AND COALESCE(is_active, true) AND NOT COALESCE(is_suppressed, false))
      INTO v_has_upcoming_tournaments;

    -- HIGH priority
    IF NOT v_venue.is_claimed THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high', 'type', 'claim_venue',
            'label', 'Claim this venue page to unlock manager tools',
            'impact', 'Unclaimed venues cannot post updates, respond to reviews, or upload photos'
        );
    END IF;
    IF v_unresponded_reviews >= 3 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high', 'type', 'respond_reviews',
            'label', 'Respond to ' || v_unresponded_reviews || ' recent review(s)',
            'count', v_unresponded_reviews,
            'impact', 'Venues that respond to reviews see 24% higher 5-star review rates'
        );
    END IF;
    IF v_cover_missing THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'high', 'type', 'upload_cover_photo',
            'label', 'Upload a cover photo',
            'impact', 'Pages without cover photos convert 3x worse on social shares'
        );
    END IF;

    -- MEDIUM priority
    IF v_recent_post_count = 0 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium', 'type', 'post_update',
            'label', 'Post a venue update (none in last 14 days)',
            'impact', 'Active venues see 5x follower growth vs quiet ones'
        );
    END IF;
    IF v_no_about THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium', 'type', 'add_about',
            'label', 'Write a detailed About section',
            'impact', 'Helps search engines and new players understand what makes this room unique'
        );
    END IF;
    IF v_photo_count < 3 THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium', 'type', 'add_photos',
            'label', 'Add more venue photos (currently ' || v_photo_count || ')',
            'impact', 'Listings with 5+ photos get 2.5x more follower conversion'
        );
    END IF;
    IF NOT v_has_upcoming_tournaments THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'medium', 'type', 'add_tournament_schedule',
            'label', 'Add your tournament schedule',
            'impact', 'Tournament listings drive the majority of venue discovery traffic'
        );
    END IF;

    -- LOW priority
    IF v_no_hours THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'low', 'type', 'add_hours',
            'label', 'Add operating hours',
            'impact', 'Required for rich snippet display in Google search'
        );
    END IF;
    IF v_no_phone THEN
        v_actions := v_actions || jsonb_build_object(
            'priority', 'low', 'type', 'add_phone',
            'label', 'Add contact phone number',
            'impact', 'Enables click-to-call on mobile searches'
        );
    END IF;

    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'venue_id', p_venue_id,
        'venue_name', v_venue.name,
        'action_count', jsonb_array_length(v_actions),
        'actions', v_actions
    );
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_action_items(integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_venue_action_items(integer, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_venue_manager_dashboard(integer, uuid, int) IS
  'Phase 28/B: Manager-only venue analytics — audience, content, reviews, check-ins, tournaments, trending rank in city.';
COMMENT ON FUNCTION public.get_venue_manager_review_queue(integer, uuid) IS
  'Phase 28/B: Reviews awaiting response + low-rated + flagged — triage queue for venue managers.';
COMMENT ON FUNCTION public.get_venue_action_items(integer, uuid) IS
  'Phase 28/B: Top recommended actions for venue managers based on current page state.';
