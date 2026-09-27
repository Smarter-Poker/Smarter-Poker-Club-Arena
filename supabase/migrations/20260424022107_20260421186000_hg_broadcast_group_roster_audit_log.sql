-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424022107 "20260421186000_hg_broadcast_group_roster_audit_log"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa5739a41ffd3c47e53156b1c30025e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper bug hunt: broadcast_to_home_game_rsvps writes to audit_log
-- after each host broadcast, but broadcast_to_home_group_roster does
-- not. Group-wide announcements are a higher-risk fan-out and need
-- the same durable record.

CREATE OR REPLACE FUNCTION public.broadcast_to_home_group_roster(
  p_group_id uuid, p_caller_user_id uuid,
  p_title text, p_body text,
  p_include_members boolean DEFAULT true,
  p_include_followers boolean DEFAULT true,
  p_link_path text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
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

    IF NOT (
      v_group.owner_id = p_caller_user_id
      OR EXISTS (SELECT 1 FROM commander_home_members
                  WHERE group_id = p_group_id AND user_id = p_caller_user_id
                    AND role = 'admin' AND status = 'approved')
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_GROUP_STAFF');
    END IF;

    IF v_role <> 'service_role' AND NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_broadcast_group', 5, 60) THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'RATE_LIMIT_EXCEEDED',
        'detail', 'Group broadcasts limited to 5 per hour per sender.'
      );
    END IF;

    SELECT sp.slug INTO v_slug FROM social_pages sp
     WHERE sp.linked_entity_type='home_group'
       AND sp.linked_entity_id = p_group_id::text LIMIT 1;

    v_link := COALESCE(p_link_path,
                       '/hub/home-games/' || COALESCE(v_slug, p_group_id::text));

    IF p_include_members THEN
      FOR v_recipient IN
        SELECT m.user_id FROM commander_home_members m
         WHERE m.group_id = p_group_id AND m.status = 'approved'
           AND m.user_id <> p_caller_user_id
           AND COALESCE(m.notify_announcements, true) = true
      LOOP
        PERFORM public.fn_emit_home_notification(
            v_recipient, 'home_group_announcement',
            v_group.name || ': ' || p_title, p_body, v_link,
            jsonb_build_object('group_id', p_group_id, 'via', 'announcement'),
            'home_game_announcements'
        );
        v_members_sent := v_members_sent + 1;
      END LOOP;
    END IF;

    IF p_include_followers THEN
      FOR v_recipient IN
        SELECT f.user_id FROM commander_home_group_follows f
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
            v_recipient, 'home_group_announcement_followed',
            v_group.name || ': ' || p_title, p_body, v_link,
            jsonb_build_object('group_id', p_group_id, 'via', 'follow'),
            NULL
        );
        v_followers_sent := v_followers_sent + 1;
      END LOOP;
    END IF;

    -- ★ NEW: audit-log the broadcast (recipient counts + content preview only)
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'roster_broadcast',
            jsonb_build_object(
              'members_notified',   v_members_sent,
              'followers_notified', v_followers_sent,
              'title',              LEFT(p_title, 100),
              'body_preview',       LEFT(p_body,  200)));

    RETURN jsonb_build_object(
      'success', true,
      'members_notified', v_members_sent,
      'followers_notified', v_followers_sent,
      'total', v_members_sent + v_followers_sent
    );
END;
$function$;
