-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419212946 "phase31_schema_drift_user_id_text_to_uuid"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84525f19b337c4a96e7ba01bbab24b4b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 31 — HIGH_RISK SCHEMA DRIFT CLEANUP
-- Convert all legacy TEXT user_id columns to UUID, fix broken
-- user_venue_checkins.venue_id (uuid → integer), recreate affected RLS
-- policies, add FKs to profiles. Executed as one atomic migration.
--
-- Safety pre-verified:
--   • Empty tables: venue_reviews, page_activity, page_claims, 
--     notification_reads, live_games, user_venue_checkins
--   • Populated tables: venue_checkins (6 rows), table_seats (87 rows)
--     — ALL rows parse as valid UUID
--   • No views depend on these columns
--   • RLS policies that reference user_id catalogued and will be rebuilt
-- ══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- STAGE 1: venue_checkins.user_id  TEXT → UUID  (6 rows)
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS venue_checkins_insert_own ON venue_checkins;

ALTER TABLE venue_checkins 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

CREATE POLICY venue_checkins_insert_own ON venue_checkins
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Add FK to profiles (ON DELETE CASCADE — check-ins without a user are worthless)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_checkins_user_profile') THEN
    ALTER TABLE venue_checkins 
      ADD CONSTRAINT fk_venue_checkins_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 2: venue_reviews.user_id  TEXT → UUID  (0 rows — empty table)
-- Has 6 RLS policies that reference user_id with text cast.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can delete own reviews" ON venue_reviews;
DROP POLICY IF EXISTS "Users can update own reviews" ON venue_reviews;
DROP POLICY IF EXISTS "Users can insert own reviews" ON venue_reviews;
DROP POLICY IF EXISTS "venue_reviews_insert_own" ON venue_reviews;

ALTER TABLE venue_reviews 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

CREATE POLICY "Users can delete own reviews" ON venue_reviews
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can update own reviews" ON venue_reviews
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own reviews" ON venue_reviews
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY venue_reviews_insert_own ON venue_reviews
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_venue_reviews_user_profile') THEN
    ALTER TABLE venue_reviews 
      ADD CONSTRAINT fk_venue_reviews_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 3: notification_reads.user_id  TEXT → UUID  (0 rows)
-- 2 RLS policies reference user_id.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS notification_reads_owner ON notification_reads;
DROP POLICY IF EXISTS notification_reads_insert_own ON notification_reads;

ALTER TABLE notification_reads 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

CREATE POLICY notification_reads_owner ON notification_reads
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY notification_reads_insert_own ON notification_reads
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_notification_reads_user_profile') THEN
    ALTER TABLE notification_reads 
      ADD CONSTRAINT fk_notification_reads_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 4: page_activity.user_id  TEXT → UUID  (0 rows)
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS page_activity_insert_own ON page_activity;

ALTER TABLE page_activity 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

CREATE POLICY page_activity_insert_own ON page_activity
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_page_activity_user_profile') THEN
    ALTER TABLE page_activity 
      ADD CONSTRAINT fk_page_activity_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 5: page_claims.user_id  TEXT → UUID  (0 rows, no user_id RLS)
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE page_claims 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint 
                  WHERE conname = 'fk_page_claims_user_profile') THEN
    ALTER TABLE page_claims 
      ADD CONSTRAINT fk_page_claims_user_profile 
      FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 6: live_games.user_id  TEXT → UUID  (0 rows, Club Arena)
-- No RLS policy references user_id. No FK added (Arena uses loose refs).
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE live_games 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 7: table_seats.user_id  TEXT → UUID  (87 rows, Club Arena)
-- All 87 rows parse as valid UUID. No RLS policy references user_id.
-- No FK added (Arena uses loose refs to allow guest/anon seats).
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE table_seats 
  ALTER COLUMN user_id TYPE uuid USING user_id::uuid;

-- ════════════════════════════════════════════════════════════════════
-- STAGE 8: user_venue_checkins.venue_id  UUID → INTEGER  (0 rows)
-- Table was fundamentally broken: venue_id UUID but poker_venues.id INT.
-- Since table is empty, drop/readd the column cleanly.
-- Also simplify the 3 RLS policies now that user_id is already uuid.
-- ════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can insert own checkins" ON user_venue_checkins;
DROP POLICY IF EXISTS "Users can update own checkins" ON user_venue_checkins;
DROP POLICY IF EXISTS "Users can view own checkins" ON user_venue_checkins;

ALTER TABLE user_venue_checkins DROP COLUMN venue_id;
ALTER TABLE user_venue_checkins ADD COLUMN venue_id integer;

CREATE POLICY "Users can insert own checkins" ON user_venue_checkins
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own checkins" ON user_venue_checkins
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can view own checkins" ON user_venue_checkins
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Index for fast venue+user lookup
CREATE INDEX IF NOT EXISTS idx_user_venue_checkins_user_venue 
  ON user_venue_checkins (user_id, venue_id);
CREATE INDEX IF NOT EXISTS idx_user_venue_checkins_venue_id 
  ON user_venue_checkins (venue_id);

-- ════════════════════════════════════════════════════════════════════
-- STAGE 9: Update Phase 29 unified_user_activity to remove obsolete cast
-- (venue_checkins.user_id is now uuid, no more ::text cast needed)
-- ════════════════════════════════════════════════════════════════════
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
        -- venue_checkins.user_id is now UUID (post-Phase 31) — no more ::text cast
        SELECT 'venue_checkin', c.created_at,
               jsonb_build_object('venue_id', c.venue_id, 'message', c.message)
          FROM venue_checkins c WHERE c.user_id = p_user_id

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

-- ════════════════════════════════════════════════════════════════════
-- STAGE 10: Also fix Phase 29 unified_profile.checkins_count
-- (same cast removal — user_id is now uuid)
-- ════════════════════════════════════════════════════════════════════
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
          -- Phase 31: cast removed — venue_checkins.user_id is now uuid
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
END; $fn$;

COMMENT ON TABLE venue_checkins IS 'Phase 31: user_id migrated TEXT→UUID, FK to profiles.id added.';
COMMENT ON TABLE venue_reviews IS 'Phase 31: user_id migrated TEXT→UUID, FK to profiles.id added.';
COMMENT ON TABLE notification_reads IS 'Phase 31: user_id migrated TEXT→UUID, FK to profiles.id added.';
COMMENT ON TABLE page_activity IS 'Phase 31: user_id migrated TEXT→UUID, FK to profiles.id added.';
COMMENT ON TABLE page_claims IS 'Phase 31: user_id migrated TEXT→UUID, FK to profiles.id added.';
COMMENT ON TABLE live_games IS 'Phase 31: user_id migrated TEXT→UUID (Club Arena, no FK — allows loose refs).';
COMMENT ON TABLE table_seats IS 'Phase 31: user_id migrated TEXT→UUID (Club Arena, no FK — allows guest seats).';
COMMENT ON TABLE user_venue_checkins IS 'Phase 31: venue_id fixed UUID→INTEGER to match poker_venues.id. RLS policies cleaned up.';
