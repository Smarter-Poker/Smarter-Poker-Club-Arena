-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419223109 "phase36_patch_user_profile_remove_badges"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 06fc488d79b9e6433cc2332d8b0876fc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Remove the 'badges' key from the home_games block in get_unified_user_profile.
-- Everything else (groups owned/joined, games attended counts, poker_near_me,
-- club_commander, clubs, social_pages, connections, engagement) preserved.
CREATE OR REPLACE FUNCTION public.get_unified_user_profile(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
             WHERE user_id = p_user_id AND response = 'yes')
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
            SELECT COUNT(*) FROM venue_checkins WHERE user_id = p_user_id)
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
END; $function$;
