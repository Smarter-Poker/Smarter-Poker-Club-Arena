-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419205907 "phase29d_venue_claim_flow"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 37674704c3e8e9bd45d3695513607daa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 29 PART D — Venue Claim Flow
-- No money. Just "I work here" → admin approves → Commander access unlocked.
-- Pairs with trg_venue_claim_wiring (Part A) which auto-provisions social_page
-- and sets commander_enabled=true when is_claimed flips true.
-- ══════════════════════════════════════════════════════════════════════════

-- Fix has_commander_access consistency in get_unified_user_profile
-- (profile was saying TRUE for any venue manager; summary correctly gates on
-- commander_enabled. Make profile match summary.)
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
                'claim_id', id, 'venue_id', venue_id, 'status', status,
                'verification_method', verification_method, 'created_at', created_at
              ) ORDER BY created_at DESC), '[]'::jsonb)
              FROM venue_claims 
             WHERE user_id = p_user_id AND status IN ('pending','under_review')
          ) ELSE NULL END,
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
          -- Consistent with summary: requires commander_enabled=true
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

-- ════════════════════════════════════════════════════════════════════
-- submit_venue_claim_request — user submits claim for a venue
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.submit_venue_claim_request(
    p_venue_id             integer,
    p_caller_user_id       uuid,
    p_verification_method  text,     -- 'email_domain', 'phone_match', 'document', 'business_license', 'admin_review'
    p_claimant_name        text,
    p_claimant_title       text,     -- e.g., 'General Manager', 'Owner', 'Poker Room Manager'
    p_claimant_email       text,
    p_claimant_phone       text DEFAULT NULL,
    p_claimant_notes       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_venue RECORD; 
    v_existing_claim RECORD;
    v_claim_id uuid; 
    v_verification_code text;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    IF p_verification_method NOT IN ('email_domain','phone_match','document','business_license','admin_review') THEN
        RAISE EXCEPTION 'INVALID_VERIFICATION_METHOD';
    END IF;
    IF p_claimant_name IS NULL OR length(trim(p_claimant_name)) = 0 THEN 
        RAISE EXCEPTION 'CLAIMANT_NAME_REQUIRED'; 
    END IF;
    IF p_claimant_email IS NULL OR p_claimant_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
        RAISE EXCEPTION 'INVALID_EMAIL';
    END IF;

    SELECT id, name, is_claimed, claimed_by INTO v_venue 
      FROM poker_venues WHERE id = p_venue_id 
       AND COALESCE(is_active, true) AND NOT COALESCE(is_suppressed, false);
    IF NOT FOUND THEN RAISE EXCEPTION 'VENUE_NOT_FOUND'; END IF;
    IF v_venue.is_claimed = true AND v_venue.claimed_by <> p_caller_user_id THEN
        RAISE EXCEPTION 'VENUE_ALREADY_CLAIMED';
    END IF;

    -- Prevent duplicate pending claim by same user for same venue
    SELECT id, status INTO v_existing_claim FROM venue_claims
     WHERE venue_id = p_venue_id AND user_id = p_caller_user_id
       AND status IN ('pending','under_review')
     LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'DUPLICATE_PENDING_CLAIM',
            'claim_id', v_existing_claim.id, 'status', v_existing_claim.status
        );
    END IF;

    -- Generate a verification code (used for email/phone verification flows)
    v_verification_code := upper(substring(encode(gen_random_bytes(6), 'hex'), 1, 8));

    INSERT INTO venue_claims (
        venue_id, user_id, status, verification_method,
        claimant_name, claimant_title, claimant_email, claimant_phone,
        verification_code, verification_attempts, claimant_notes
    ) VALUES (
        p_venue_id, p_caller_user_id, 'pending', p_verification_method,
        p_claimant_name, p_claimant_title, p_claimant_email, p_claimant_phone,
        v_verification_code, 0, p_claimant_notes
    ) RETURNING id INTO v_claim_id;

    RETURN jsonb_build_object(
        'success', true, 'claim_id', v_claim_id, 'venue_id', p_venue_id,
        'venue_name', v_venue.name, 'status', 'pending',
        'verification_method', p_verification_method,
        'verification_code', v_verification_code,
        'message', 'Claim submitted. Admin will review and contact you at ' || p_claimant_email
    );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.submit_venue_claim_request(integer, uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.submit_venue_claim_request(integer, uuid, text, text, text, text, text, text) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════
-- approve_venue_claim — admin approves a claim → flips is_claimed=true
-- (which triggers trg_venue_claim_wiring → social_page + commander_enabled)
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.approve_venue_claim(
    p_claim_id       uuid,
    p_admin_user_id  uuid,
    p_admin_notes    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_claim RECORD; v_admin_role text; v_previous_owner uuid;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_admin_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;

    -- Only admins can approve
    SELECT role INTO v_admin_role FROM profiles WHERE id = p_admin_user_id;
    IF v_admin_role IS NULL OR v_admin_role NOT IN ('admin','superadmin','moderator') THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;

    SELECT id, venue_id, user_id, status INTO v_claim FROM venue_claims
     WHERE id = p_claim_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
    IF v_claim.status NOT IN ('pending','under_review') THEN
        RAISE EXCEPTION 'CLAIM_NOT_ACTIONABLE';
    END IF;

    -- Check if venue already claimed by someone else
    SELECT claimed_by INTO v_previous_owner FROM poker_venues WHERE id = v_claim.venue_id;
    IF v_previous_owner IS NOT NULL AND v_previous_owner <> v_claim.user_id THEN
        RAISE EXCEPTION 'VENUE_ALREADY_CLAIMED_BY_ANOTHER';
    END IF;

    -- Update claim
    UPDATE venue_claims 
       SET status = 'approved', verified_at = now(), 
           verified_by = p_admin_user_id,
           admin_notes = COALESCE(p_admin_notes, admin_notes),
           updated_at = now()
     WHERE id = p_claim_id;

    -- Flip the venue to claimed — this fires trg_venue_claim_wiring which:
    --   (a) auto-creates social_page, and
    --   (b) sets commander_enabled=true
    UPDATE poker_venues
       SET is_claimed = true,
           claimed_by = v_claim.user_id,
           claimed_at = COALESCE(claimed_at, now())
     WHERE id = v_claim.venue_id;

    -- Add claimant as the venue's primary manager
    INSERT INTO venue_managers (
        venue_id, user_id, role,
        can_edit_info, can_edit_hours, can_edit_games, can_post_updates,
        can_respond_reviews, can_manage_promotions, can_view_analytics, can_invite_staff,
        is_active, invited_by
    ) VALUES (
        v_claim.venue_id, v_claim.user_id, 'owner',
        true, true, true, true, true, true, true, true, true, p_admin_user_id
    ) ON CONFLICT DO NOTHING;

    -- Dismiss other pending claims for the same venue
    UPDATE venue_claims
       SET status = 'rejected',
           rejection_reason = 'Another claim was approved first',
           updated_at = now()
     WHERE venue_id = v_claim.venue_id AND id <> p_claim_id 
       AND status IN ('pending','under_review');

    RETURN jsonb_build_object(
        'success', true, 'claim_id', p_claim_id, 'venue_id', v_claim.venue_id,
        'new_owner_id', v_claim.user_id,
        'commander_enabled', true, 'social_page_auto_provisioned', true
    );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.approve_venue_claim(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.approve_venue_claim(uuid, uuid, text) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════
-- reject_venue_claim — admin rejects
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reject_venue_claim(
    p_claim_id       uuid,
    p_admin_user_id  uuid,
    p_rejection_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_claim RECORD; v_admin_role text;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_admin_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    SELECT role INTO v_admin_role FROM profiles WHERE id = p_admin_user_id;
    IF v_admin_role NOT IN ('admin','superadmin','moderator') THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;
    SELECT id, status INTO v_claim FROM venue_claims WHERE id = p_claim_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
    IF v_claim.status NOT IN ('pending','under_review') THEN
        RAISE EXCEPTION 'CLAIM_NOT_ACTIONABLE';
    END IF;

    UPDATE venue_claims 
       SET status = 'rejected', rejection_reason = p_rejection_reason,
           verified_by = p_admin_user_id, updated_at = now()
     WHERE id = p_claim_id;

    RETURN jsonb_build_object('success', true, 'claim_id', p_claim_id, 'status', 'rejected');
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.reject_venue_claim(uuid, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reject_venue_claim(uuid, uuid, text) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════
-- get_venue_claim_queue — admin-only review queue
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_venue_claim_queue(p_admin_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_admin_role text;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_admin_user_id THEN 
        RAISE EXCEPTION 'UNAUTHORIZED'; 
    END IF;
    SELECT role INTO v_admin_role FROM profiles WHERE id = p_admin_user_id;
    IF v_admin_role NOT IN ('admin','superadmin','moderator') THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;

    RETURN jsonb_build_object(
        'generated_at', now(),
        'pending', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'claim_id', c.id, 'venue_id', c.venue_id, 'venue_name', v.name,
            'venue_city', v.city, 'venue_state', v.state,
            'claimant_user_id', c.user_id,
            'claimant_name', c.claimant_name, 'claimant_title', c.claimant_title,
            'claimant_email', c.claimant_email, 'claimant_phone', c.claimant_phone,
            'verification_method', c.verification_method,
            'claimant_notes', c.claimant_notes,
            'created_at', c.created_at
          ) ORDER BY c.created_at), '[]'::jsonb)
          FROM venue_claims c JOIN poker_venues v ON v.id = c.venue_id
         WHERE c.status IN ('pending','under_review')),
        'counts', jsonb_build_object(
            'pending', (SELECT COUNT(*) FROM venue_claims WHERE status = 'pending'),
            'under_review', (SELECT COUNT(*) FROM venue_claims WHERE status = 'under_review'),
            'approved_last_30d', (SELECT COUNT(*) FROM venue_claims 
                                    WHERE status = 'approved' 
                                      AND verified_at > now() - INTERVAL '30 days'),
            'rejected_last_30d', (SELECT COUNT(*) FROM venue_claims 
                                    WHERE status = 'rejected' 
                                      AND updated_at > now() - INTERVAL '30 days')
        )
    );
END; $fn$;

REVOKE EXECUTE ON FUNCTION public.get_venue_claim_queue(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_venue_claim_queue(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.submit_venue_claim_request(integer, uuid, text, text, text, text, text, text) IS
  'Phase 29/D: Submit a claim to manage a venue page. No money. Admin approval required.';
COMMENT ON FUNCTION public.approve_venue_claim(uuid, uuid, text) IS
  'Phase 29/D: Admin approves a venue claim → auto-fires social_page + commander_enabled via trigger + creates venue_manager row.';
COMMENT ON FUNCTION public.reject_venue_claim(uuid, uuid, text) IS
  'Phase 29/D: Admin rejects a venue claim with a reason.';
COMMENT ON FUNCTION public.get_venue_claim_queue(uuid) IS
  'Phase 29/D: Admin-only review queue for venue claims.';
