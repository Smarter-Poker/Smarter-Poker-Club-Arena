-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419191616 "phase27c_helpful_flagging_trending"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2164dfcad387085287adacacb3865687 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 27 PART C — Review helpful tracking, flagging/moderation, trending venues
-- All information-only. No money surface.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- 1) Helpful-tracking table — one vote per user per review, idempotent
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_venue_review_helpful (
    review_id   uuid NOT NULL REFERENCES commander_venue_reviews(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    is_helpful  boolean NOT NULL DEFAULT true,  -- future: allow unhelpful too
    created_at  timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (review_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_review_helpful_review ON commander_venue_review_helpful(review_id);

ALTER TABLE commander_venue_review_helpful ENABLE ROW LEVEL SECURITY;

CREATE POLICY review_helpful_public_select ON commander_venue_review_helpful
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY review_helpful_own_insert ON commander_venue_review_helpful
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY review_helpful_own_delete ON commander_venue_review_helpful
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Trigger keeps commander_venue_reviews.helpful_count in sync
CREATE OR REPLACE FUNCTION public.fn_sync_review_helpful_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_rid uuid;
BEGIN
    v_rid := COALESCE(NEW.review_id, OLD.review_id);
    UPDATE commander_venue_reviews 
       SET helpful_count = (SELECT COUNT(*) FROM commander_venue_review_helpful WHERE review_id = v_rid AND is_helpful)
     WHERE id = v_rid;
    RETURN COALESCE(NEW, OLD);
END; $fn$;

CREATE TRIGGER trg_sync_review_helpful_count
    AFTER INSERT OR UPDATE OR DELETE ON commander_venue_review_helpful
    FOR EACH ROW EXECUTE FUNCTION public.fn_sync_review_helpful_count();

-- Replace the naive mark_venue_review_helpful with idempotent version
DROP FUNCTION IF EXISTS public.mark_venue_review_helpful(uuid, uuid);

CREATE OR REPLACE FUNCTION public.toggle_venue_review_helpful(
    p_review_id       uuid,
    p_caller_user_id  uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_exists boolean; v_count int; v_review_exists boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT EXISTS(SELECT 1 FROM commander_venue_reviews WHERE id = p_review_id) INTO v_review_exists;
    IF NOT v_review_exists THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;

    SELECT EXISTS(SELECT 1 FROM commander_venue_review_helpful 
                   WHERE review_id = p_review_id AND user_id = p_caller_user_id) INTO v_exists;

    IF v_exists THEN
        DELETE FROM commander_venue_review_helpful 
         WHERE review_id = p_review_id AND user_id = p_caller_user_id;
    ELSE
        INSERT INTO commander_venue_review_helpful (review_id, user_id, is_helpful)
        VALUES (p_review_id, p_caller_user_id, true);
    END IF;

    SELECT helpful_count INTO v_count FROM commander_venue_reviews WHERE id = p_review_id;
    RETURN jsonb_build_object('success', true, 'now_marked_helpful', NOT v_exists, 'helpful_count', v_count);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.toggle_venue_review_helpful(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.toggle_venue_review_helpful(uuid, uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 2) Review flagging/moderation
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_venue_review_flags (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id    uuid NOT NULL REFERENCES commander_venue_reviews(id) ON DELETE CASCADE,
    flagger_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    reason       text NOT NULL CHECK (reason IN ('spam','harassment','fake','off_topic','hate_speech','inaccurate','other')),
    detail       text CHECK (detail IS NULL OR length(detail) <= 1000),
    status       text NOT NULL DEFAULT 'pending' 
                   CHECK (status IN ('pending','reviewed','dismissed','upheld')),
    reviewer_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
    reviewer_note text,
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    reviewed_at  timestamptz,
    UNIQUE (review_id, flagger_id)
);

CREATE INDEX idx_review_flags_pending 
    ON commander_venue_review_flags (status, created_at) WHERE status = 'pending';
CREATE INDEX idx_review_flags_review ON commander_venue_review_flags (review_id);

ALTER TABLE commander_venue_review_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY review_flags_flagger_select ON commander_venue_review_flags
  FOR SELECT TO authenticated USING (flagger_id = auth.uid());
CREATE POLICY review_flags_flagger_insert ON commander_venue_review_flags
  FOR INSERT TO authenticated WITH CHECK (flagger_id = auth.uid());

CREATE OR REPLACE FUNCTION public.flag_venue_review(
    p_review_id       uuid,
    p_caller_user_id  uuid,
    p_reason          text,
    p_detail          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_review RECORD; v_id uuid; v_recent int; v_is_own boolean;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_reason NOT IN ('spam','harassment','fake','off_topic','hate_speech','inaccurate','other')
    THEN RAISE EXCEPTION 'INVALID_REASON'; END IF;

    SELECT id, reviewer_id INTO v_review FROM commander_venue_reviews WHERE id = p_review_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_NOT_FOUND'; END IF;
    IF v_review.reviewer_id = p_caller_user_id THEN RAISE EXCEPTION 'CANNOT_FLAG_OWN_REVIEW'; END IF;

    -- Rate limit: 10 flags per 24h per user
    SELECT COUNT(*) INTO v_recent FROM commander_venue_review_flags 
     WHERE flagger_id = p_caller_user_id AND created_at > NOW() - INTERVAL '24 hours';
    IF v_recent >= 10 THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;

    INSERT INTO commander_venue_review_flags (review_id, flagger_id, reason, detail)
    VALUES (p_review_id, p_caller_user_id, p_reason, p_detail)
    ON CONFLICT (review_id, flagger_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
    RETURNING id INTO v_id;

    -- Auto-flag review for moderator attention if it hits 3+ distinct flaggers
    IF (SELECT COUNT(*) FROM commander_venue_review_flags 
         WHERE review_id = p_review_id AND status = 'pending') >= 3 THEN
        UPDATE commander_venue_reviews SET is_published = false WHERE id = p_review_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'flag_id', v_id);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.flag_venue_review(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.flag_venue_review(uuid, uuid, text, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 3) Moderator queue RPC — admin-only (service_role will call this)
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_venue_moderation_queue(
    p_limit int DEFAULT 50,
    p_status text DEFAULT 'pending'
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    p_limit := LEAST(GREATEST(p_limit, 1), 200);
    IF p_status NOT IN ('pending','reviewed','dismissed','upheld','all') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;

    WITH flagged AS (
        SELECT f.id AS flag_id, f.review_id, f.reason, f.detail, f.status,
               f.created_at AS flagged_at,
               r.venue_id, r.reviewer_id, r.overall_rating, r.title, r.content,
               r.is_published, r.is_verified, r.created_at AS review_created_at,
               v.name AS venue_name, v.city, v.state,
               (SELECT COUNT(*) FROM commander_venue_review_flags 
                 WHERE review_id = f.review_id AND status = 'pending') AS total_pending_flags
          FROM commander_venue_review_flags f
          JOIN commander_venue_reviews r ON r.id = f.review_id
          JOIN poker_venues v ON v.id = r.venue_id
         WHERE (p_status = 'all' OR f.status = p_status)
         ORDER BY f.created_at DESC
         LIMIT p_limit
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'status_filter', p_status,
        'count', (SELECT COUNT(*) FROM flagged),
        'total_pending_flags', (SELECT COUNT(*) FROM commander_venue_review_flags WHERE status='pending'),
        'auto_unpublished_reviews', (
            SELECT COUNT(*) FROM commander_venue_reviews r
             WHERE r.is_published = false
               AND EXISTS(SELECT 1 FROM commander_venue_review_flags f 
                          WHERE f.review_id = r.id AND f.status='pending')
        ),
        'items', COALESCE((SELECT jsonb_agg(row_to_json(flagged)) FROM flagged), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_venue_moderation_queue(int, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_venue_moderation_queue(int, text) TO service_role;

-- Admin acts on a flag → uphold (hide review permanently) or dismiss (restore review)
CREATE OR REPLACE FUNCTION public.resolve_review_flag(
    p_flag_id         uuid,
    p_reviewer_id     uuid,
    p_action          text,  -- 'uphold' | 'dismiss'
    p_reviewer_note   text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $fn$
DECLARE v_flag RECORD;
BEGIN
    IF p_action NOT IN ('uphold','dismiss') THEN RAISE EXCEPTION 'INVALID_ACTION'; END IF;
    SELECT * INTO v_flag FROM commander_venue_review_flags WHERE id = p_flag_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLAG_NOT_FOUND'; END IF;
    IF v_flag.status <> 'pending' THEN RAISE EXCEPTION 'ALREADY_RESOLVED'; END IF;

    UPDATE commander_venue_review_flags 
       SET status = CASE p_action WHEN 'uphold' THEN 'upheld' ELSE 'dismissed' END,
           reviewer_id = p_reviewer_id, reviewer_note = p_reviewer_note, reviewed_at = NOW()
     WHERE id = p_flag_id;

    IF p_action = 'uphold' THEN
        UPDATE commander_venue_reviews SET is_published = false WHERE id = v_flag.review_id;
    ELSIF p_action = 'dismiss' THEN
        -- If no other pending flags on this review, restore publication
        IF NOT EXISTS(SELECT 1 FROM commander_venue_review_flags 
                       WHERE review_id = v_flag.review_id AND status = 'pending' AND id <> p_flag_id)
        THEN UPDATE commander_venue_reviews SET is_published = true WHERE id = v_flag.review_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('success', true, 'action', p_action);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.resolve_review_flag(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_review_flag(uuid, uuid, text, text) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- 4) Trending venues — composite score of recent check-ins + reviews + follows
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_trending_venues(
    p_state       text DEFAULT NULL,
    p_city        text DEFAULT NULL,
    p_days        int DEFAULT 7,
    p_limit       int DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb; v_cutoff timestamptz;
BEGIN
    p_limit := LEAST(GREATEST(p_limit, 1), 100);
    p_days := LEAST(GREATEST(p_days, 1), 90);
    v_cutoff := NOW() - (p_days || ' days')::interval;

    WITH scored AS (
        SELECT v.id, v.name, v.slug, v.city, v.state, v.venue_type,
               v.trust_score, v.is_claimed, v.follower_count,
               COALESCE((SELECT COUNT(*) FROM venue_checkins c 
                          WHERE c.venue_id = v.id::text AND c.created_at >= v_cutoff), 0) AS checkins_recent,
               COALESCE((SELECT COUNT(*) FROM commander_venue_reviews r 
                          WHERE r.venue_id = v.id AND r.created_at >= v_cutoff 
                            AND r.is_published = true), 0) AS reviews_recent,
               COALESCE((SELECT ROUND(AVG(overall_rating), 2) FROM commander_venue_reviews r
                          WHERE r.venue_id = v.id AND r.is_published = true), 0) AS avg_rating,
               COALESCE((SELECT COUNT(*) FROM commander_venue_followers f
                          WHERE f.venue_id = v.id AND f.followed_at >= v_cutoff), 0) AS new_followers_recent,
               COALESCE((SELECT COUNT(*) FROM commander_venue_posts p
                          WHERE p.venue_id = v.id AND p.created_at >= v_cutoff 
                            AND p.is_published = true), 0) AS posts_recent
          FROM poker_venues v
         WHERE COALESCE(v.is_active, true) AND NOT COALESCE(v.is_suppressed, false)
           AND (p_state IS NULL OR v.state = p_state)
           AND (p_city IS NULL OR v.city ILIKE p_city)
    ),
    ranked AS (
        SELECT *, 
               -- Composite trending score:
               -- check-ins heavily weighted, then reviews, then new follows, posts, avg rating
               (checkins_recent * 4.0 
                + reviews_recent * 3.0 
                + new_followers_recent * 2.5
                + posts_recent * 1.5
                + avg_rating * 2
                + COALESCE(trust_score, 0) * 0.2
                + CASE WHEN is_claimed THEN 2 ELSE 0 END
               ) AS trending_score
          FROM scored
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window_days', p_days,
        'state_filter', p_state, 'city_filter', p_city,
        'count', (SELECT LEAST(COUNT(*), p_limit) FROM ranked WHERE trending_score > 0),
        'venues', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'slug', slug, 'city', city, 'state', state,
                'venue_type', venue_type, 'is_claimed', is_claimed,
                'trust_score', trust_score, 'follower_count', follower_count, 'avg_rating', avg_rating,
                'signals', jsonb_build_object(
                    'checkins_recent', checkins_recent,
                    'reviews_recent', reviews_recent,
                    'new_followers_recent', new_followers_recent,
                    'posts_recent', posts_recent
                ),
                'trending_score', ROUND(trending_score::numeric, 2)
            ) ORDER BY trending_score DESC)
              FROM (SELECT * FROM ranked WHERE trending_score > 0 
                     ORDER BY trending_score DESC LIMIT p_limit) t
        ), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_trending_venues(text, text, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_trending_venues(text, text, int, int) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.toggle_venue_review_helpful(uuid, uuid) IS
  'Phase 27/C: Idempotent helpful vote. Upsert/delete tracked per-user in commander_venue_review_helpful.';
COMMENT ON FUNCTION public.flag_venue_review(uuid, uuid, text, text) IS
  'Phase 27/C: Flag a review for moderation. Auto-unpublishes review at 3+ pending flags.';
COMMENT ON FUNCTION public.get_venue_moderation_queue(int, text) IS
  'Phase 27/C: Admin-only moderation queue of flagged reviews.';
COMMENT ON FUNCTION public.get_trending_venues(text, text, int, int) IS
  'Phase 27/C: Composite trending score of venues by recent check-ins, reviews, follows, posts.';
