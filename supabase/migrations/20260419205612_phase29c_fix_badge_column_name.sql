-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419205612 "phase29c_fix_badge_column_name"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2c8414a9ec938b94b22e88d4ffd9fe19 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: commander_home_user_badges column is badge_key not badge_type
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
          'username', v_profile.username,
          'avatar_url', v_profile.avatar_url,
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
                'city', v.city, 'state', v.state,
                'followed_at', f.followed_at
              ) ORDER BY f.followed_at DESC), '[]'::jsonb)
              FROM commander_venue_followers f
              JOIN poker_venues v ON v.id = f.venue_id
             WHERE f.user_id = p_user_id),
          'venues_managed', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'venue_id', v.id, 'name', v.name, 'slug', v.slug, 'role', m.role,
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
          'reviews_written_count', (
            SELECT COUNT(*) FROM commander_venue_reviews 
             WHERE reviewer_id = p_user_id AND is_published = true),
          'posts_authored_count', (
            SELECT COUNT(*) FROM commander_venue_posts 
             WHERE author_id = p_user_id AND is_published = true),
          'photos_uploaded_count', (
            SELECT COUNT(*) FROM commander_venue_photos WHERE uploaded_by = p_user_id)
      ),
      'club_commander', jsonb_build_object(
          'has_commander_access', (
            SELECT EXISTS(SELECT 1 FROM poker_venues 
                           WHERE claimed_by = p_user_id AND commander_enabled = true)
             OR EXISTS(SELECT 1 FROM venue_managers 
                        WHERE user_id = p_user_id AND is_active = true)),
          'commander_venue_count', (
            SELECT COUNT(*) FROM poker_venues 
             WHERE (claimed_by = p_user_id OR id IN (
                      SELECT venue_id FROM venue_managers 
                       WHERE user_id = p_user_id AND is_active = true))
               AND commander_enabled = true)
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
            SELECT COUNT(*) FROM social_page_followers WHERE user_id = p_user_id)
      ),
      'connections', jsonb_build_object(
          'friends_count', (
            SELECT COUNT(*) FROM friendships 
             WHERE (user_id = p_user_id OR friend_id = p_user_id) AND status = 'accepted')
      ),
      'engagement', CASE WHEN v_is_self THEN jsonb_build_object(
          'unread_notifications', 
              (SELECT COUNT(*) FROM notifications 
                WHERE user_id = p_user_id AND COALESCE(read, false) = false),
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

-- Also fix get_unified_user_activity — same badge column fix
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
        SELECT 'home_game_rsvp' AS kind, r.created_at AS ts,
               jsonb_build_object(
                   'game_id', r.game_id, 'game_title', g.game_title,
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
               jsonb_build_object('venue_id', venue_id, 'rating', overall_rating, 
                                  'title', title)
          FROM commander_venue_reviews
         WHERE reviewer_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'venue_post_published', created_at,
               jsonb_build_object('venue_id', venue_id, 'post_type', post_type,
                                  'content', substr(content, 1, 120))
          FROM commander_venue_posts
         WHERE author_id = p_user_id AND is_published = true

        UNION ALL
        SELECT 'diamonds_awarded', created_at,
               jsonb_build_object('amount', amount, 'source', source, 'metadata', metadata)
          FROM diamond_transactions
         WHERE user_id = p_user_id AND amount > 0
    )
    SELECT jsonb_build_object(
        'generated_at', now(),
        'user_id', p_user_id,
        'count', (SELECT COUNT(*) FROM activity),
        'items', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) 
                    FROM (SELECT kind, ts, payload FROM activity 
                           ORDER BY ts DESC NULLS LAST LIMIT p_limit) t)
    ) INTO v_result;
    RETURN v_result;
END; $fn$;
