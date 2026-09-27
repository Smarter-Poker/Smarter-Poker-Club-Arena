-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420052210 "phase40_home_group_roster_for_host"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ceac4cbfaea84d14790dd1b88d8e0f4e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Feature: host's unified "database of players"
--
-- Unifies approved members + non-member followers into a single roster the
-- host/owner/admin can SELECT, DM individually, or broadcast to (push notif).
--
-- Three RPCs:
--   1. get_home_group_roster(group_id, caller_user_id)
--        -> rows of everyone the host can reach, with relationship flag and
--           notification prefs. Host/owner/admin gated.
--
--   2. start_home_group_roster_dm(group_id, from, to, initial_message)
--        -> opens/reuses a 1:1 conversation between host-side caller and a
--           roster target (member OR follower). Bidirectional: follower can
--           reply normally once the convo exists.
--
--   3. broadcast_to_home_group_roster(group_id, caller, title, body,
--                                     include_members, include_followers,
--                                     link_path)
--        -> emits push/in-app notifications to the selected slices of the
--           roster. Reuses fn_emit_home_notification for each recipient.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Roster view: host's database of players
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_home_group_roster(
    p_group_id uuid,
    p_caller_user_id uuid
)
RETURNS TABLE (
    user_id              uuid,
    username             text,
    display_name         text,
    avatar_url           text,
    relationship         text,           -- 'member' | 'follower' | 'both'
    member_role          text,           -- null unless member
    member_status        text,           -- 'approved' / 'banned' / 'pending'
    member_joined_at     timestamptz,
    follower_since       timestamptz,
    notify_new_games     boolean,        -- true if ANY of the user's prefs say yes
    notify_announcements boolean,
    checked_in_games     int             -- lifetime attendance in this group
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller uuid := auth.uid();
    v_role   text := auth.role();
BEGIN
    IF v_role <> 'service_role' THEN
      IF v_caller IS NULL OR v_caller <> p_caller_user_id THEN
        RAISE EXCEPTION 'AUTH_MISMATCH' USING HINT='auth.uid() must equal p_caller_user_id';
      END IF;
    END IF;

    -- Caller must be host/owner/admin of this group
    IF NOT (
         EXISTS (SELECT 1 FROM commander_home_groups
                  WHERE id = p_group_id AND owner_id = p_caller_user_id)
      OR EXISTS (SELECT 1 FROM commander_home_members
                  WHERE group_id = p_group_id AND user_id = p_caller_user_id
                    AND role = 'admin' AND status = 'approved')
    ) THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED'
            USING HINT='only group owner or approved admin may view the roster';
    END IF;

    RETURN QUERY
    WITH unified AS (
        -- Approved / pending / banned members
        SELECT m.user_id,
               'member'::text AS src,
               m.role AS m_role,
               m.status AS m_status,
               m.joined_at AS m_joined,
               NULL::timestamptz AS f_since,
               COALESCE(m.notify_new_games, true) AS m_notify_games,
               COALESCE(m.notify_announcements, true) AS m_notify_ann
          FROM commander_home_members m
         WHERE m.group_id = p_group_id

        UNION ALL

        -- Followers (may or may not overlap with members)
        SELECT f.user_id,
               'follower'::text AS src,
               NULL::text AS m_role,
               NULL::text AS m_status,
               NULL::timestamptz AS m_joined,
               f.created_at AS f_since,
               f.notify_new_games AS m_notify_games,
               f.notify_announcements AS m_notify_ann
          FROM commander_home_group_follows f
         WHERE f.group_id = p_group_id
    ),
    collapsed AS (
        SELECT u.user_id,
               CASE
                 WHEN bool_or(src='member') AND bool_or(src='follower') THEN 'both'
                 WHEN bool_or(src='member')   THEN 'member'
                 ELSE 'follower'
               END AS relationship,
               MAX(CASE WHEN src='member' THEN m_role   END) AS member_role,
               MAX(CASE WHEN src='member' THEN m_status END) AS member_status,
               MAX(CASE WHEN src='member' THEN m_joined END) AS member_joined_at,
               MAX(CASE WHEN src='follower' THEN f_since END) AS follower_since,
               bool_or(m_notify_games)  AS notify_new_games,
               bool_or(m_notify_ann)    AS notify_announcements
          FROM unified u
         GROUP BY u.user_id
    )
    SELECT c.user_id,
           p.username,
           COALESCE(p.display_name, p.full_name, p.username) AS display_name,
           p.avatar_url,
           c.relationship,
           c.member_role,
           c.member_status,
           c.member_joined_at,
           c.follower_since,
           c.notify_new_games,
           c.notify_announcements,
           (
              SELECT COUNT(*)::int
                FROM commander_home_rsvps r
                JOIN commander_home_games g ON g.id = r.game_id
               WHERE g.group_id = p_group_id
                 AND r.user_id = c.user_id
                 AND r.checked_in_at IS NOT NULL
           ) AS checked_in_games
      FROM collapsed c
      JOIN profiles p ON p.id = c.user_id
     ORDER BY
        (c.member_status = 'banned') ASC,      -- banned last
        c.relationship = 'follower',            -- members before follower-only
        COALESCE(c.member_joined_at, c.follower_since) DESC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_home_group_roster(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_home_group_roster(uuid, uuid)
  TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 2. Host DM to roster member (member OR follower)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_home_group_roster_dm(
    p_group_id uuid,
    p_from_user_id uuid,
    p_to_user_id uuid,
    p_initial_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller  uuid := auth.uid();
    v_role    text := auth.role();
    v_is_staff boolean;
    v_to_is_member boolean;
    v_to_is_follower boolean;
    v_to_banned boolean;
    v_conv jsonb; v_conv_id uuid;
    v_msg jsonb; v_trim text;
BEGIN
    IF p_group_id IS NULL OR p_from_user_id IS NULL OR p_to_user_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'MISSING_PARAMS');
    END IF;
    IF p_from_user_id = p_to_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'SELF_DM');
    END IF;

    IF v_role <> 'service_role' THEN
      IF v_caller IS NULL OR v_caller <> p_from_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTH_MISMATCH');
      END IF;
    END IF;

    -- Caller must be host/owner/admin of the group
    v_is_staff := EXISTS (
      SELECT 1 FROM commander_home_groups
       WHERE id = p_group_id AND owner_id = p_from_user_id
    ) OR EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = p_group_id AND user_id = p_from_user_id
         AND role = 'admin' AND status = 'approved'
    );

    IF NOT v_is_staff THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_GROUP_STAFF');
    END IF;

    -- Target must be an approved member OR follower; not banned
    v_to_banned := EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = p_group_id AND user_id = p_to_user_id AND status = 'banned'
    );
    IF v_to_banned THEN
      RETURN jsonb_build_object('success', false, 'error', 'TARGET_BANNED');
    END IF;

    v_to_is_member := EXISTS (
      SELECT 1 FROM commander_home_members
       WHERE group_id = p_group_id AND user_id = p_to_user_id AND status = 'approved'
    );
    v_to_is_follower := EXISTS (
      SELECT 1 FROM commander_home_group_follows
       WHERE group_id = p_group_id AND user_id = p_to_user_id
    );

    IF NOT (v_to_is_member OR v_to_is_follower) THEN
      RETURN jsonb_build_object('success', false, 'error', 'TARGET_NOT_IN_ROSTER');
    END IF;

    -- Validate initial message length up-front
    v_trim := NULLIF(TRIM(COALESCE(p_initial_message, '')), '');
    IF v_trim IS NOT NULL AND length(v_trim) > 4000 THEN
      RETURN jsonb_build_object('success', false, 'error', 'MESSAGE_TOO_LONG');
    END IF;

    -- Get/create conversation
    v_conv := public.fn_get_or_create_conversation(p_from_user_id, p_to_user_id);
    IF NOT COALESCE((v_conv->>'success')::boolean, false) THEN
      RETURN jsonb_build_object('success', false,
                                'error', 'CONVERSATION_FAILED',
                                'detail', v_conv);
    END IF;
    v_conv_id := (v_conv->>'conversation_id')::uuid;

    -- Seed message if provided
    IF v_trim IS NOT NULL THEN
      v_msg := public.fn_send_message(v_conv_id, p_from_user_id, v_trim, 'text');
      IF NOT COALESCE((v_msg->>'success')::boolean, false) THEN
        RETURN jsonb_build_object(
          'success', true,
          'conversation_id', v_conv_id,
          'created', COALESCE((v_conv->>'created')::boolean, false),
          'message_sent', false,
          'target_relationship',
            CASE WHEN v_to_is_member AND v_to_is_follower THEN 'both'
                 WHEN v_to_is_member THEN 'member'
                 ELSE 'follower' END,
          'message_error', v_msg
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'conversation_id', v_conv_id,
      'created', COALESCE((v_conv->>'created')::boolean, false),
      'message_sent', v_trim IS NOT NULL,
      'target_relationship',
        CASE WHEN v_to_is_member AND v_to_is_follower THEN 'both'
             WHEN v_to_is_member THEN 'member'
             ELSE 'follower' END,
      'context_group_id', p_group_id
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.start_home_group_roster_dm(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_home_group_roster_dm(uuid, uuid, uuid, text)
  TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 3. Broadcast push/in-app notification to roster
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_to_home_group_roster(
    p_group_id uuid,
    p_caller_user_id uuid,
    p_title text,
    p_body text,
    p_include_members boolean DEFAULT true,
    p_include_followers boolean DEFAULT true,
    p_link_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET row_security TO 'off'
AS $fn$
DECLARE
    v_caller uuid := auth.uid();
    v_role   text := auth.role();
    v_group  RECORD;
    v_recipient uuid;
    v_members_sent int := 0;
    v_followers_sent int := 0;
    v_slug text;
    v_link text;
BEGIN
    IF v_role <> 'service_role' THEN
      IF v_caller IS NULL OR v_caller <> p_caller_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'AUTH_MISMATCH');
      END IF;
    END IF;

    IF COALESCE(TRIM(p_title), '') = '' OR COALESCE(TRIM(p_body), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'error', 'MISSING_TITLE_OR_BODY');
    END IF;
    IF length(p_title) > 200 OR length(p_body) > 2000 THEN
      RETURN jsonb_build_object('success', false, 'error', 'CONTENT_TOO_LONG');
    END IF;
    IF p_include_members = false AND p_include_followers = false THEN
      RETURN jsonb_build_object('success', false, 'error', 'NO_AUDIENCE');
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'GROUP_NOT_FOUND');
    END IF;

    -- Caller must be host/owner/admin
    IF NOT (
      v_group.owner_id = p_caller_user_id
      OR EXISTS (SELECT 1 FROM commander_home_members
                  WHERE group_id = p_group_id AND user_id = p_caller_user_id
                    AND role = 'admin' AND status = 'approved')
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_GROUP_STAFF');
    END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group'
       AND sp.linked_entity_id = p_group_id::text LIMIT 1;

    v_link := COALESCE(p_link_path,
                       '/hub/home-games/' || COALESCE(v_slug, p_group_id::text));

    -- Members branch
    IF p_include_members THEN
      FOR v_recipient IN
        SELECT m.user_id
          FROM commander_home_members m
         WHERE m.group_id = p_group_id
           AND m.status = 'approved'
           AND m.user_id <> p_caller_user_id
           AND COALESCE(m.notify_announcements, true) = true
      LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient,
            'home_group_announcement',
            v_group.name || ': ' || p_title,
            p_body,
            v_link,
            jsonb_build_object('group_id', p_group_id, 'via', 'announcement'),
            'home_game_announcements'
        );
        v_members_sent := v_members_sent + 1;
      END LOOP;
    END IF;

    -- Followers branch (skip users already reached via the members branch)
    IF p_include_followers THEN
      FOR v_recipient IN
        SELECT f.user_id
          FROM commander_home_group_follows f
         WHERE f.group_id = p_group_id
           AND f.notify_announcements = true
           AND f.user_id <> p_caller_user_id
           AND (NOT p_include_members
                OR NOT EXISTS (SELECT 1 FROM commander_home_members m
                                WHERE m.group_id = p_group_id
                                  AND m.user_id = f.user_id
                                  AND m.status = 'approved'))
      LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient,
            'home_group_announcement_followed',
            v_group.name || ': ' || p_title,
            p_body,
            v_link,
            jsonb_build_object('group_id', p_group_id, 'via', 'follow'),
            NULL  -- follower prefs live in commander_home_group_follows
        );
        v_followers_sent := v_followers_sent + 1;
      END LOOP;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'members_notified', v_members_sent,
      'followers_notified', v_followers_sent,
      'total', v_members_sent + v_followers_sent
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.broadcast_to_home_group_roster(uuid, uuid, text, text, boolean, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.broadcast_to_home_group_roster(uuid, uuid, text, text, boolean, boolean, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_home_group_roster IS
  'Phase 40: host-only unified "database of players" — approved/pending/banned '
  'members + followers, deduped, with attendance count and notification prefs.';
COMMENT ON FUNCTION public.start_home_group_roster_dm IS
  'Phase 40: host opens/reuses a DM with any roster member (approved member '
  'or follower). Bidirectional — follower replies via social_messages RLS.';
COMMENT ON FUNCTION public.broadcast_to_home_group_roster IS
  'Phase 40: host fan-out push/in-app notification to roster. Independent '
  'toggles for members vs followers. Respects per-row notify_announcements.';
