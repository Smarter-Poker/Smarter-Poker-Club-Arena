-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424154148 "20260421199100_hg_resolve_home_report_as_host"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9d7f9e3faf4926e38a12b6efee918f48 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Host-scoped resolution of a content report in their own group.
-- Host actions are CAPPED — they can dismiss, hide, or warn. They cannot
-- ban the author (that's a group-member ban, different action) OR strike
-- (platform penalty). Escalation categories are also blocked here.
--
-- Wraps resolve_home_content_report semantics but with host authz and
-- a whitelisted action set.
CREATE OR REPLACE FUNCTION public.resolve_home_report_as_host(
  p_report_id       uuid,
  p_group_id        uuid,
  p_action          text,      -- 'dismiss' | 'hide_content' | 'warn_author'
  p_moderator_note  text       DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_is_staff  boolean;
  v_report    RECORD;
  v_owner_id  uuid;
  v_report_group_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_moderator_note IS NOT NULL AND length(p_moderator_note) > 2000 THEN
    RAISE EXCEPTION 'MODERATOR_NOTE_TOO_LONG' USING HINT = 'max 2000 chars';
  END IF;
  IF p_action NOT IN ('dismiss','hide_content','warn_author') THEN
    RAISE EXCEPTION 'INVALID_ACTION'
      USING HINT = 'host actions: dismiss|hide_content|warn_author. For ban/strike/delete, escalate to platform.';
  END IF;

  -- Verify caller is host/admin of this group
  SELECT owner_id INTO v_owner_id FROM public.commander_home_groups WHERE id = p_group_id;
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
  v_is_staff := (v_owner_id = v_uid) OR EXISTS (
      SELECT 1 FROM public.commander_home_members
       WHERE group_id = p_group_id AND user_id = v_uid
         AND role IN ('admin','co_host') AND status='approved');
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_report FROM public.commander_home_content_reports
   WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;
  IF v_report.status IN ('reviewed','actioned','dismissed') THEN
    RAISE EXCEPTION 'REPORT_ALREADY_RESOLVED' USING HINT = 'status is ' || v_report.status;
  END IF;

  -- Block escalation categories from host resolution
  IF v_report.reason_category IN ('illegal','self_harm','doxxing') THEN
    RAISE EXCEPTION 'ESCALATION_REQUIRED'
      USING HINT = 'category ' || v_report.reason_category || ' must be resolved by platform staff';
  END IF;

  -- Block host from resolving reports where THEY are the accused party
  IF v_report.content_author_id = v_owner_id THEN
    RAISE EXCEPTION 'CONFLICT_OF_INTEREST'
      USING HINT = 'host cannot resolve reports against their own content';
  END IF;

  -- Verify report actually belongs to a piece of content in this group
  CASE v_report.reported_type
    WHEN 'post' THEN
      SELECT group_id INTO v_report_group_id FROM public.commander_home_posts WHERE id = v_report.reported_id;
    WHEN 'comment' THEN
      SELECT p.group_id INTO v_report_group_id FROM public.commander_home_post_comments c
        JOIN public.commander_home_posts p ON p.id = c.post_id WHERE c.id = v_report.reported_id;
    WHEN 'review' THEN
      SELECT g.group_id INTO v_report_group_id FROM public.commander_home_game_reviews r
        JOIN public.commander_home_games g ON g.id = r.game_id WHERE r.id = v_report.reported_id;
    WHEN 'game' THEN
      SELECT group_id INTO v_report_group_id FROM public.commander_home_games WHERE id = v_report.reported_id;
    WHEN 'member' THEN
      SELECT group_id INTO v_report_group_id FROM public.commander_home_members WHERE id = v_report.reported_id;
    ELSE v_report_group_id := NULL;
  END CASE;
  IF v_report_group_id IS DISTINCT FROM p_group_id THEN
    RAISE EXCEPTION 'REPORT_NOT_IN_GROUP' USING HINT = 'report does not belong to the specified group';
  END IF;

  -- Apply the action
  IF p_action = 'dismiss' THEN
    UPDATE public.commander_home_content_reports
       SET status='dismissed', resolved_at=NOW(),
           resolved_by=v_uid, moderator_note=p_moderator_note
     WHERE id=p_report_id;
  ELSIF p_action = 'hide_content' THEN
    CASE v_report.reported_type
      WHEN 'post' THEN
        UPDATE public.commander_home_posts SET is_hidden=true, hidden_at=NOW(),
          hidden_reason = COALESCE(hidden_reason, 'host_moderation')
         WHERE id = v_report.reported_id;
      WHEN 'comment' THEN
        UPDATE public.commander_home_post_comments SET is_hidden=true, hidden_at=NOW(),
          hidden_reason = COALESCE(hidden_reason, 'host_moderation')
         WHERE id = v_report.reported_id;
      WHEN 'review' THEN
        UPDATE public.commander_home_game_reviews SET is_hidden=true, hidden_at=NOW(),
          hidden_reason = COALESCE(hidden_reason, 'host_moderation')
         WHERE id = v_report.reported_id;
      ELSE NULL;
    END CASE;
    UPDATE public.commander_home_content_reports
       SET status='actioned', resolved_at=NOW(),
           resolved_by=v_uid, moderator_note=p_moderator_note
     WHERE id=p_report_id;
  ELSIF p_action = 'warn_author' THEN
    -- Emit a notification to the author instead of modifying content
    PERFORM public.fn_emit_home_notification(
      v_report.content_author_id, 'home_host_warning',
      'A host reviewed a report about your content',
      COALESCE(p_moderator_note,
        'A host reviewed a report and issued a warning. Please review the group rules.'),
      NULL, jsonb_build_object('group_id', p_group_id, 'report_id', p_report_id),
      NULL
    );
    UPDATE public.commander_home_content_reports
       SET status='reviewed', resolved_at=NOW(),
           resolved_by=v_uid, moderator_note=p_moderator_note
     WHERE id=p_report_id;
  END IF;

  -- Audit log
  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (p_group_id, v_uid, v_report.reported_type::text,
          v_report.reported_id, 'host.resolve_report',
          jsonb_build_object(
            'report_id',    p_report_id,
            'action',       p_action,
            'note_preview', LEFT(COALESCE(p_moderator_note,''), 200)));

  RETURN jsonb_build_object('success', true, 'action', p_action, 'report_id', p_report_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.resolve_home_report_as_host(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.resolve_home_report_as_host(uuid, uuid, text, text) TO authenticated, service_role;
