-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419212012 "phase30_production_hardening"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8d000c77f1f9ebb73afded9beffcfbe1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 30 — PRODUCTION HARDENING PASS
-- No new products. Only: integrity, indexes, gaps, notifications, search.
-- ══════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- PART A — FOREIGN KEY INTEGRITY
-- Prevent orphan rows going forward on the 4 tables that had no FK to profiles.
-- ────────────────────────────────────────────────────────────────────────

-- commander_home_groups.owner_id → profiles.id ON DELETE SET NULL
-- (group data is valuable; transfer_ownership RPC handles the orphan case)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_commander_home_groups_owner_profile') THEN
    ALTER TABLE commander_home_groups 
      ADD CONSTRAINT fk_commander_home_groups_owner_profile 
      FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- venue_managers.user_id → profiles.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_managers_user_profile') THEN
    ALTER TABLE venue_managers 
      ADD CONSTRAINT fk_venue_managers_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- social_pages.owner_id → profiles.id ON DELETE SET NULL
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_social_pages_owner_profile') THEN
    ALTER TABLE social_pages 
      ADD CONSTRAINT fk_social_pages_owner_profile 
      FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- venue_claims.user_id → profiles.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_claims_user_profile') THEN
    ALTER TABLE venue_claims 
      ADD CONSTRAINT fk_venue_claims_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- PART B — HOT-PATH INDEXES
-- Needed by unified RPCs (get_unified_user_profile, summary, activity)
-- ────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_venue_managers_user_id_active 
    ON venue_managers (user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_poker_venues_claimed_by 
    ON poker_venues (claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venue_claims_user_status 
    ON venue_claims (user_id, status);
CREATE INDEX IF NOT EXISTS idx_commander_home_user_badges_user_id
    ON commander_home_user_badges (user_id);
CREATE INDEX IF NOT EXISTS idx_diamond_transactions_user_created
    ON diamond_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commander_venue_reviews_reviewer_published
    ON commander_venue_reviews (reviewer_id) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_commander_venue_posts_author_published
    ON commander_venue_posts (author_id) WHERE is_published = true;

-- ────────────────────────────────────────────────────────────────────────
-- PART C — CLAIM LIFECYCLE NOTIFICATIONS
-- When a venue claim is approved or rejected, notify the claimant
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_emit_claim_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_venue_name text;
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    SELECT name INTO v_venue_name FROM poker_venues WHERE id = NEW.venue_id;
    IF v_venue_name IS NULL THEN RETURN NEW; END IF;

    IF NEW.status = 'approved' THEN
        INSERT INTO notifications (user_id, type, title, message, data, actor_id, link)
        VALUES (
            NEW.user_id, 
            'venue_claim_approved',
            'Your venue claim was approved!',
            'You are now the verified manager of ' || v_venue_name || '. Commander access has been enabled.',
            jsonb_build_object('venue_id', NEW.venue_id, 'venue_name', v_venue_name, 
                               'claim_id', NEW.id),
            NEW.verified_by,
            '/poker-near-me/' || 
              (SELECT lower(state) || '/' || 
                      regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g') || '/' || slug
                 FROM poker_venues WHERE id = NEW.venue_id)
        );
    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO notifications (user_id, type, title, message, data, actor_id)
        VALUES (
            NEW.user_id,
            'venue_claim_rejected',
            'Update on your venue claim',
            'Your claim for ' || v_venue_name || ' could not be approved. ' || 
                COALESCE('Reason: ' || NEW.rejection_reason, 'Please contact support for details.'),
            jsonb_build_object('venue_id', NEW.venue_id, 'venue_name', v_venue_name, 
                               'claim_id', NEW.id, 'rejection_reason', NEW.rejection_reason),
            NEW.verified_by
        );
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'claim notification emit failed: %', SQLERRM;
    RETURN NEW;
END; $fn$;

DROP TRIGGER IF EXISTS trg_emit_claim_notification ON venue_claims;
CREATE TRIGGER trg_emit_claim_notification
    AFTER UPDATE OF status ON venue_claims
    FOR EACH ROW EXECUTE FUNCTION public.fn_emit_claim_notification();

-- ────────────────────────────────────────────────────────────────────────
-- PART D — EXPAND UNIFIED ACTIVITY FEED
-- Add: venue check-ins, photo uploads, social_page follows, received 
-- notifications → single unified timeline.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_unified_user_activity(
    p_user_id uuid, p_limit int DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 200);

    WITH activity AS (
        SELECT 'home_game_rsvp' AS kind, r.responded_at AS ts,
               jsonb_build_object(
                   'game_id', r.game_id, 'game_title', g.title,
                   'game_type', g.game_type, 'format', g.format,
                   'group_id', g.group_id, 'group_name', hg.name,
                   'response', r.response, 'checked_in', r.checked_in_at IS NOT NULL
               ) AS payload
          FROM commander_home_rsvps r
          JOIN commander_home_games g ON g.id = r.game_id
          JOIN commander_home_groups hg ON hg.id = g.group_id
         WHERE r.user_id = p_user_id

        UNION ALL
        SELECT 'home_group_joined', m.joined_at,
               jsonb_build_object('group_id', g.id, 'group_name', g.name, 'role', m.role)
          FROM commander_home_members m
          JOIN commander_home_groups g ON g.id = m.group_id
         WHERE m.user_id = p_user_id AND m.status = 'approved'

        UNION ALL
        SELECT 'badge_earned', earned_at,
               jsonb_build_object('badge_key', badge_key, 'metadata', metadata)
          FROM commander_home_user_badges WHERE user_id = p_user_id

        UNION ALL
        SELECT 'venue_followed', f.followed_at,
               jsonb_build_object('venue_id', v.id, 'name', v.name,
                                  'slug', v.slug, 'city', v.city, 'state', v.state)
          FROM commander_venue_followers f
          JOIN poker_venues v ON v.id = f.venue_id
         WHERE f.user_id = p_user_id

        UNION ALL
        SELECT 'venue_review_written', created_at,
               jsonb_build_object('venue_id', venue_id, 'rating', overall_rating, 'title', title)
          FROM commander_venue_reviews
         WHERE reviewer_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'venue_post_published', created_at,
               jsonb_build_object('venue_id', venue_id, 'post_type', post_type,
                                  'content', substr(content, 1, 120))
          FROM commander_venue_posts
         WHERE author_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'venue_photo_uploaded', created_at,
               jsonb_build_object('venue_id', venue_id, 'url', url,
                                  'caption', caption, 'is_cover_photo', is_cover_photo)
          FROM commander_venue_photos WHERE uploaded_by = p_user_id

        UNION ALL
        -- venue_checkins has user_id as TEXT — cast safely
        SELECT 'venue_checkin', c.created_at,
               jsonb_build_object('venue_id', c.venue_id, 'message', c.message)
          FROM venue_checkins c WHERE c.user_id = p_user_id::text

        UNION ALL
        SELECT 'social_page_followed', f.created_at,
               jsonb_build_object('page_id', f.page_id, 'page_name', sp.name,
                                  'page_type', sp.page_type, 'page_slug', sp.slug)
          FROM social_page_followers f
          JOIN social_pages sp ON sp.id = f.page_id
         WHERE f.user_id = p_user_id

        UNION ALL
        SELECT 'diamonds_awarded', created_at,
               jsonb_build_object('amount', amount, 'source', source, 'metadata', metadata)
          FROM diamond_transactions
         WHERE user_id = p_user_id AND amount > 0

        UNION ALL
        SELECT 'venue_claim_submitted', created_at,
               jsonb_build_object('claim_id', id, 'venue_id', venue_id, 'status', status)
          FROM venue_claims WHERE user_id = p_user_id
    )
    SELECT jsonb_build_object(
        'generated_at', now(),
        'user_id', p_user_id,
        'count', (SELECT COUNT(*) FROM activity),
        'items', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) 
                    FROM (SELECT kind, ts, payload FROM activity 
                           WHERE ts IS NOT NULL
                           ORDER BY ts DESC LIMIT p_limit) t)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;

-- ────────────────────────────────────────────────────────────────────────
-- PART E — EXPAND UNIFIED PROFILE
-- Add preview fields: recent_notifications, pending_claims (already had), 
-- friends_preview
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_unified_user_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_profile RECORD; 
    v_is_self boolean := (auth.uid() = p_user_id);
    v_result jsonb;
BEGIN
    SELECT id, display_name, full_name, username, avatar_url, city, state,
           email_verified, phone_verified, diamonds, created_at
      INTO v_profile FROM profiles WHERE id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;

    SELECT jsonb_build_object(
      'profile', jsonb_build_object(
          'id', v_profile.id,
          'display_name', v_profile.display_name,
          'full_name', CASE WHEN v_is_self THEN v_profile.full_name ELSE NULL END,
          'username', v_profile.username, 'avatar_url', v_profile.avatar_url,
          'city', v_profile.city, 'state', v_profile.state,
          'email_verified', CASE WHEN v_is_self THEN v_profile.email_verified ELSE NULL END,
          'phone_verified', CASE WHEN v_is_self THEN v_profile.phone_verified ELSE NULL END,
          'diamonds', CASE WHEN v_is_self THEN v_profile.diamonds ELSE NULL END,
          'member_since', v_profile.created_at
      ),
      'home_games', jsonb_build_object(
          'groups_owned', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', g.id, 'name', g.name,
                'slug', (SELECT sp.slug FROM social_pages sp 
                          WHERE sp.linked_entity_type='home_group' 
                            AND sp.linked_entity_id = g.id::text LIMIT 1),
                'city', g.city, 'state', g.state,
                'quality_score', g.quality_score, 'vitality_score', g.vitality_score,
                'is_private', g.is_private, 'created_at', g.created_at
              ) ORDER BY g.created_at DESC), '[]'::jsonb)
              FROM commander_home_groups g WHERE g.owner_id = p_user_id),
          'groups_joined', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'group_id', g.id, 'group_name', g.name,
                'role', m.role, 'status', m.status, 'joined_at', m.joined_at
              ) ORDER BY m.joined_at DESC), '[]'::jsonb)
              FROM commander_home_members m
              JOIN commander_home_groups g ON g.id = m.group_id
             WHERE m.user_id = p_user_id AND m.status = 'approved'),
          'games_attended', (
            SELECT COUNT(*) FROM commander_home_rsvps 
             WHERE user_id = p_user_id AND response = 'yes' AND checked_in_at IS NOT NULL),
          'games_rsvpd_yes', (
            SELECT COUNT(*) FROM commander_home_rsvps 
             WHERE user_id = p_user_id AND response = 'yes'),
          'badges', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'badge_key', badge_key, 'earned_at', earned_at, 'metadata', metadata
              ) ORDER BY earned_at DESC), '[]'::jsonb)
              FROM commander_home_user_badges WHERE user_id = p_user_id)
      ),
      'poker_near_me', jsonb_build_object(
          'venues_followed', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'venue_id', v.id, 'name', v.name, 'slug', v.slug,
                'city', v.city, 'state', v.state, 'followed_at', f.followed_at
              ) ORDER BY f.followed_at DESC), '[]'::jsonb)
              FROM commander_venue_followers f
              JOIN poker_venues v ON v.id = f.venue_id
             WHERE f.user_id = p_user_id),
          'venues_managed', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'venue_id', v.id, 'name', v.name, 'slug', v.slug, 'role', m.role,
                'commander_enabled', v.commander_enabled,
                'can_post_updates', m.can_post_updates,
                'can_respond_reviews', m.can_respond_reviews
              ) ORDER BY v.name), '[]'::jsonb)
              FROM venue_managers m
              JOIN poker_venues v ON v.id = m.venue_id
             WHERE m.user_id = p_user_id AND m.is_active = true),
          'venues_claimed_as_owner', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'venue_id', id, 'name', name, 'slug', slug,
                'commander_enabled', commander_enabled, 'claimed_at', claimed_at
              ) ORDER BY claimed_at DESC), '[]'::jsonb)
              FROM poker_venues WHERE claimed_by = p_user_id),
          'pending_claims', CASE WHEN v_is_self THEN (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'claim_id', c.id, 'venue_id', c.venue_id, 'venue_name', v.name,
                'status', c.status, 'verification_method', c.verification_method, 
                'created_at', c.created_at
              ) ORDER BY c.created_at DESC), '[]'::jsonb)
              FROM venue_claims c JOIN poker_venues v ON v.id = c.venue_id
             WHERE c.user_id = p_user_id AND c.status IN ('pending','under_review')
          ) ELSE NULL END,
          'reviews_written_count', (
            SELECT COUNT(*) FROM commander_venue_reviews 
             WHERE reviewer_id = p_user_id AND is_published = true),
          'posts_authored_count', (
            SELECT COUNT(*) FROM commander_venue_posts 
             WHERE author_id = p_user_id AND is_published = true),
          'photos_uploaded_count', (
            SELECT COUNT(*) FROM commander_venue_photos WHERE uploaded_by = p_user_id),
          'checkins_count', (
            SELECT COUNT(*) FROM venue_checkins WHERE user_id = p_user_id::text)
      ),
      'club_commander', jsonb_build_object(
          'has_commander_access', EXISTS(
            SELECT 1 FROM poker_venues v
             WHERE v.commander_enabled = true
               AND (v.claimed_by = p_user_id 
                    OR v.id IN (SELECT venue_id FROM venue_managers 
                                 WHERE user_id = p_user_id AND is_active = true))),
          'commander_venue_count', (
            SELECT COUNT(*) FROM poker_venues v
             WHERE v.commander_enabled = true
               AND (v.claimed_by = p_user_id
                    OR v.id IN (SELECT venue_id FROM venue_managers 
                                 WHERE user_id = p_user_id AND is_active = true)))
      ),
      'clubs', jsonb_build_object(
          'memberships', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'club_id', c.id, 'club_name', c.name, 'role', m.role, 'status', m.status
              ) ORDER BY c.name), '[]'::jsonb)
              FROM club_members m JOIN clubs c ON c.id = m.club_id
             WHERE m.user_id = p_user_id)
      ),
      'social_pages', jsonb_build_object(
          'pages_owned', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', id, 'page_type', page_type, 'name', name, 'slug', slug,
                'linked_entity_type', linked_entity_type,
                'follower_count', follower_count
              ) ORDER BY name), '[]'::jsonb)
              FROM social_pages WHERE owner_id = p_user_id),
          'pages_followed_count', (
            SELECT COUNT(*) FROM social_page_followers WHERE user_id = p_user_id),
          'pages_followed_preview', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'page_id', sp.id, 'name', sp.name, 'slug', sp.slug, 'page_type', sp.page_type
              ) ORDER BY f.created_at DESC), '[]'::jsonb)
              FROM (SELECT * FROM social_page_followers 
                     WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 5) f
              JOIN social_pages sp ON sp.id = f.page_id)
      ),
      'connections', jsonb_build_object(
          'friends_count', (
            SELECT COUNT(*) FROM friendships 
             WHERE (user_id = p_user_id OR friend_id = p_user_id) AND status = 'accepted'),
          'friends_preview', CASE WHEN v_is_self THEN (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', p.id, 'display_name', p.display_name, 'username', p.username,
                'avatar_url', p.avatar_url
              ) ORDER BY p.display_name), '[]'::jsonb)
              FROM (SELECT CASE WHEN user_id = p_user_id THEN friend_id ELSE user_id END AS friend_uid
                      FROM friendships 
                     WHERE (user_id = p_user_id OR friend_id = p_user_id) 
                       AND status = 'accepted' LIMIT 5) f
              JOIN profiles p ON p.id = f.friend_uid
          ) ELSE NULL END
      ),
      'engagement', CASE WHEN v_is_self THEN jsonb_build_object(
          'unread_notifications', 
              (SELECT COUNT(*) FROM notifications 
                WHERE user_id = p_user_id AND COALESCE(read, false) = false),
          'recent_notifications', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', id, 'type', type, 'title', title, 'message', message,
                'read', read, 'link', link, 'action_url', action_url,
                'created_at', created_at
              ) ORDER BY created_at DESC), '[]'::jsonb)
              FROM (SELECT * FROM notifications 
                     WHERE user_id = p_user_id 
                     ORDER BY created_at DESC LIMIT 5) n
          ),
          'diamond_balance', v_profile.diamonds,
          'last_home_game_checkin', 
              (SELECT MAX(checked_in_at) FROM commander_home_rsvps 
                WHERE user_id = p_user_id)
        ) ELSE NULL END,
      'generated_at', now(),
      'viewer_is_self', v_is_self
    ) INTO v_result;
    RETURN v_result;
END; $fn$;

-- ────────────────────────────────────────────────────────────────────────
-- PART F — UNIFIED CROSS-PRODUCT SEARCH
-- Single RPC that searches home_groups + venues + clubs in one query
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_unified_entities(
    p_query       text,
    p_state       text DEFAULT NULL,
    p_city        text DEFAULT NULL,
    p_entity_type text DEFAULT NULL,  -- 'venue', 'home_group', 'club', or NULL for all
    p_limit       int  DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_result jsonb; v_tsq tsquery;
BEGIN
    IF p_query IS NULL OR length(trim(p_query)) < 2 THEN 
        RAISE EXCEPTION 'QUERY_TOO_SHORT'; 
    END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 100);
    -- Build a safe tsquery (prefix match)
    BEGIN
        v_tsq := to_tsquery('english', regexp_replace(trim(p_query), '\s+', ' & ', 'g') || ':*');
    EXCEPTION WHEN OTHERS THEN
        v_tsq := plainto_tsquery('english', p_query);
    END;

    WITH results AS (
        -- VENUES
        SELECT 'venue' AS entity_type, v.id::text AS entity_id,
               v.name, v.slug, v.city, v.state, v.venue_type AS subtype,
               v.trust_score AS rank_score, 
               v.tagline AS tagline,
               '/poker-near-me/' || lower(COALESCE(v.state,'us')) || '/' ||
                  COALESCE(regexp_replace(lower(v.city), '[^a-z0-9]+', '-', 'g'), 'city') || '/' ||
                  v.slug AS url_path,
               jsonb_build_object('is_claimed', v.is_claimed, 'commander_enabled', v.commander_enabled,
                                  'follower_count', v.follower_count, 'poker_tables', v.poker_tables) AS metadata
          FROM poker_venues v
         WHERE (p_entity_type IS NULL OR p_entity_type = 'venue')
           AND COALESCE(v.is_active, true) AND NOT COALESCE(v.is_suppressed, false)
           AND v.slug IS NOT NULL
           AND (p_state IS NULL OR v.state ILIKE p_state)
           AND (p_city IS NULL OR v.city ILIKE p_city)
           AND (v.search_vector @@ v_tsq OR v.name ILIKE '%' || p_query || '%')

        UNION ALL
        -- HOME GROUPS (public only)
        SELECT 'home_group', g.id::text,
               g.name, 
               (SELECT slug FROM social_pages sp 
                 WHERE sp.linked_entity_type='home_group' 
                   AND sp.linked_entity_id = g.id::text LIMIT 1),
               g.city, g.state, NULL,
               g.quality_score,
               g.tagline,
               '/home-games/' || g.id::text,
               jsonb_build_object('is_private', g.is_private,
                                  'quality_score', g.quality_score,
                                  'vitality_score', g.vitality_score)
          FROM commander_home_groups g
         WHERE (p_entity_type IS NULL OR p_entity_type = 'home_group')
           AND g.is_private = false
           AND (p_state IS NULL OR g.state ILIKE p_state)
           AND (p_city IS NULL OR g.city ILIKE p_city)
           AND (g.search_vector @@ v_tsq OR g.name ILIKE '%' || p_query || '%')

        UNION ALL
        -- CLUBS
        SELECT 'club', c.id::text, c.name, c.slug, NULL, NULL, NULL,
               NULL::real, c.description,
               '/clubs/' || COALESCE(c.slug, c.id::text),
               jsonb_build_object('is_public', c.is_public)
          FROM clubs c
         WHERE (p_entity_type IS NULL OR p_entity_type = 'club')
           AND COALESCE(c.is_public, true) = true
           AND c.name ILIKE '%' || p_query || '%'
    )
    SELECT jsonb_build_object(
        'generated_at', now(),
        'query', p_query,
        'filters', jsonb_build_object('state', p_state, 'city', p_city, 
                                      'entity_type', p_entity_type),
        'total', (SELECT COUNT(*) FROM results),
        'results', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
                      FROM (SELECT * FROM results 
                             ORDER BY rank_score DESC NULLS LAST, name
                             LIMIT p_limit) t)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.search_unified_entities(text, text, text, text, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.search_unified_entities(text, text, text, text, int) TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────
-- PART G — PLATFORM HEALTH CHECK RPC
-- Single-call integrity + wiring score. Callable by anyone admin.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_platform_integrity_report(p_admin_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_admin_role text; 
    v_total_groups int; v_groups_with_sp int;
    v_total_claimed int; v_claimed_with_sp int; v_claimed_with_cmd int;
    v_total_clubs int; v_clubs_with_sp int;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_admin_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    SELECT role INTO v_admin_role FROM profiles WHERE id = p_admin_user_id;
    IF v_admin_role NOT IN ('admin','superadmin','moderator') THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;

    SELECT COUNT(*) INTO v_total_groups FROM commander_home_groups;
    SELECT COUNT(*) INTO v_groups_with_sp FROM commander_home_groups g
       WHERE EXISTS(SELECT 1 FROM social_pages sp 
                    WHERE sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text);
    SELECT COUNT(*) INTO v_total_claimed FROM poker_venues WHERE is_claimed = true;
    SELECT COUNT(*) INTO v_claimed_with_sp FROM poker_venues v 
       WHERE v.is_claimed = true AND EXISTS(
         SELECT 1 FROM social_pages sp 
          WHERE sp.linked_entity_type='venue' AND sp.linked_entity_id = v.id::text);
    SELECT COUNT(*) INTO v_claimed_with_cmd FROM poker_venues 
       WHERE is_claimed = true AND commander_enabled = true;
    SELECT COUNT(*) INTO v_total_clubs FROM clubs;
    SELECT COUNT(*) INTO v_clubs_with_sp FROM clubs c
       WHERE EXISTS(SELECT 1 FROM social_pages sp 
                    WHERE sp.linked_entity_type='club' AND sp.linked_entity_id = c.id::text);

    RETURN jsonb_build_object(
        'generated_at', now(),
        'identity', jsonb_build_object(
            'auth_users_real', (SELECT COUNT(*) FROM auth.users 
                                  WHERE email NOT LIKE '%@hydra.bot'),
            'profiles_real', (SELECT COUNT(*) FROM profiles p
                                WHERE EXISTS(SELECT 1 FROM auth.users u 
                                              WHERE u.id = p.id 
                                                AND u.email NOT LIKE '%@hydra.bot')),
            'real_users_without_profile', (
                SELECT COUNT(*) FROM auth.users u 
                 WHERE NOT EXISTS(SELECT 1 FROM profiles p WHERE p.id = u.id)
                   AND u.email NOT LIKE '%@hydra.bot')
        ),
        'wiring_coverage', jsonb_build_object(
            'home_groups', jsonb_build_object('total', v_total_groups, 
                                               'with_social_page', v_groups_with_sp,
                                               'coverage_pct', CASE WHEN v_total_groups > 0 
                                                 THEN ROUND(v_groups_with_sp::numeric / v_total_groups * 100, 1) 
                                                 ELSE 100 END),
            'claimed_venues', jsonb_build_object('total', v_total_claimed,
                                                  'with_social_page', v_claimed_with_sp,
                                                  'with_commander_enabled', v_claimed_with_cmd,
                                                  'social_coverage_pct', CASE WHEN v_total_claimed > 0 
                                                    THEN ROUND(v_claimed_with_sp::numeric / v_total_claimed * 100, 1) 
                                                    ELSE 100 END,
                                                  'commander_coverage_pct', CASE WHEN v_total_claimed > 0 
                                                    THEN ROUND(v_claimed_with_cmd::numeric / v_total_claimed * 100, 1) 
                                                    ELSE 100 END),
            'clubs', jsonb_build_object('total', v_total_clubs,
                                         'with_social_page', v_clubs_with_sp,
                                         'coverage_pct', CASE WHEN v_total_clubs > 0 
                                           THEN ROUND(v_clubs_with_sp::numeric / v_total_clubs * 100, 1) 
                                           ELSE 100 END)
        ),
        'triggers_installed', (SELECT jsonb_agg(tgname)
          FROM pg_trigger 
         WHERE NOT tgisinternal 
           AND tgname IN ('trg_autocreate_home_group_social_page',
                          'trg_venue_claim_wiring',
                          'trg_autocreate_club_social_page',
                          'trg_emit_claim_notification')),
        'foreign_keys_established', jsonb_build_object(
            'fk_commander_home_groups_owner_profile', 
                EXISTS(SELECT 1 FROM pg_constraint 
                        WHERE conname = 'fk_commander_home_groups_owner_profile'),
            'fk_venue_managers_user_profile',
                EXISTS(SELECT 1 FROM pg_constraint 
                        WHERE conname = 'fk_venue_managers_user_profile'),
            'fk_social_pages_owner_profile',
                EXISTS(SELECT 1 FROM pg_constraint 
                        WHERE conname = 'fk_social_pages_owner_profile'),
            'fk_venue_claims_user_profile',
                EXISTS(SELECT 1 FROM pg_constraint 
                        WHERE conname = 'fk_venue_claims_user_profile')
        ),
        'pending_claims_queue_depth', 
            (SELECT COUNT(*) FROM venue_claims WHERE status IN ('pending','under_review')),
        'active_managers', (SELECT COUNT(*) FROM venue_managers WHERE is_active = true),
        'verdict', CASE 
            WHEN v_total_groups = v_groups_with_sp 
             AND v_total_claimed = v_claimed_with_sp
             AND v_total_claimed = v_claimed_with_cmd
             AND v_total_clubs = v_clubs_with_sp
            THEN 'FULLY_WIRED'
            ELSE 'GAPS_EXIST'
        END
    );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_platform_integrity_report(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_platform_integrity_report(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_unified_entities(text, text, text, text, int) IS
  'Phase 30: Single RPC searching across venues, home_groups, clubs with unified ranking.';
COMMENT ON FUNCTION public.get_platform_integrity_report(uuid) IS
  'Phase 30: Admin-only single-call health report showing wiring coverage across all entity types.';
COMMENT ON FUNCTION public.fn_emit_claim_notification() IS
  'Phase 30: Auto-emit notification to claimant on approve/reject status change.';
