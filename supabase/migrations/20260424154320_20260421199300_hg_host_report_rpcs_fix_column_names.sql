-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424154320 "20260421199300_hg_host_report_rpcs_fix_column_names"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 947ad62930848f12e78f54ee29c4b5d3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: columns are reviewed_by/reviewed_at (not resolved_*). Keeping
-- fn signature identical so no callers break.
CREATE OR REPLACE FUNCTION public.list_home_group_reports_for_host(
  p_group_id uuid,
  p_status   text    DEFAULT NULL,
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_rows jsonb;
  v_total int;
  v_safe_limit int;
  v_safe_offset int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;

  v_is_staff := EXISTS (SELECT 1 FROM public.commander_home_groups
       WHERE id = p_group_id AND owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.commander_home_members
       WHERE group_id = p_group_id AND user_id = v_uid
         AND role IN ('admin','co_host') AND status='approved');
  IF NOT v_is_staff THEN RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE='42501'; END IF;

  v_safe_limit  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*) INTO v_total
    FROM public.commander_home_content_reports r
   WHERE r.reason_category NOT IN ('illegal','self_harm','doxxing')
     AND r.content_author_id <> (SELECT owner_id FROM public.commander_home_groups WHERE id = p_group_id)
     AND (p_status IS NULL OR r.status = p_status)
     AND (
       (r.reported_type IN ('post','comment')
         AND r.reported_id IN (SELECT p.id FROM public.commander_home_posts p WHERE p.group_id = p_group_id))
       OR (r.reported_type = 'game'
         AND r.reported_id IN (SELECT g.id FROM public.commander_home_games g WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'review'
         AND r.reported_id IN (SELECT rv.id FROM public.commander_home_game_reviews rv
           JOIN public.commander_home_games g ON g.id = rv.game_id WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'member'
         AND r.reported_id IN (SELECT m.id FROM public.commander_home_members m WHERE m.group_id = p_group_id))
     );

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id',                  r.id,
             'reporter_id',         r.reporter_id,
             'reporter_name',       COALESCE(p_rep.display_name, p_rep.username, 'Unknown'),
             'reported_type',       r.reported_type,
             'reported_id',         r.reported_id,
             'content_author_id',   r.content_author_id,
             'content_author_name', COALESCE(p_auth.display_name, p_auth.username, 'Unknown'),
             'reason_category',     r.reason_category,
             'reason_text',         r.reason_text,
             'status',              r.status,
             'created_at',          r.created_at,
             'reviewed_at',         r.reviewed_at,
             'action_taken',        r.action_taken
           ) ORDER BY r.created_at DESC
         ), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT * FROM public.commander_home_content_reports r
       WHERE r.reason_category NOT IN ('illegal','self_harm','doxxing')
         AND r.content_author_id <> (SELECT owner_id FROM public.commander_home_groups WHERE id = p_group_id)
         AND (p_status IS NULL OR r.status = p_status)
         AND (
           (r.reported_type IN ('post','comment')
             AND r.reported_id IN (SELECT p.id FROM public.commander_home_posts p WHERE p.group_id = p_group_id))
           OR (r.reported_type = 'game'
             AND r.reported_id IN (SELECT g.id FROM public.commander_home_games g WHERE g.group_id = p_group_id))
           OR (r.reported_type = 'review'
             AND r.reported_id IN (SELECT rv.id FROM public.commander_home_game_reviews rv
               JOIN public.commander_home_games g ON g.id = rv.game_id WHERE g.group_id = p_group_id))
           OR (r.reported_type = 'member'
             AND r.reported_id IN (SELECT m.id FROM public.commander_home_members m WHERE m.group_id = p_group_id))
         )
       ORDER BY r.created_at DESC
       LIMIT v_safe_limit OFFSET v_safe_offset
    ) r
    LEFT JOIN public.profiles p_rep  ON p_rep.id  = r.reporter_id
    LEFT JOIN public.profiles p_auth ON p_auth.id = r.content_author_id;

  RETURN jsonb_build_object('success', true, 'total', v_total,
    'limit', v_safe_limit, 'offset', v_safe_offset, 'reports', v_rows);
END;
$fn$;

-- Fix resolve fn too (column names + action_taken field)
CREATE OR REPLACE FUNCTION public.resolve_home_report_as_host(
  p_report_id uuid, p_group_id uuid,
  p_action text, p_moderator_note text DEFAULT NULL
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_report RECORD;
  v_owner_id uuid;
  v_report_group_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;
  IF p_moderator_note IS NOT NULL AND length(p_moderator_note) > 2000 THEN
    RAISE EXCEPTION 'MODERATOR_NOTE_TOO_LONG' USING HINT='max 2000 chars'; END IF;
  IF p_action NOT IN ('dismiss','hide_content','warn_author') THEN
    RAISE EXCEPTION 'INVALID_ACTION'
      USING HINT='host actions: dismiss|hide_content|warn_author. For ban/strike/delete, escalate to platform.';
  END IF;

  SELECT owner_id INTO v_owner_id FROM public.commander_home_groups WHERE id = p_group_id;
  IF v_owner_id IS NULL THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
  v_is_staff := (v_owner_id = v_uid) OR EXISTS (
      SELECT 1 FROM public.commander_home_members
       WHERE group_id = p_group_id AND user_id = v_uid
         AND role IN ('admin','co_host') AND status='approved');
  IF NOT v_is_staff THEN RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_report FROM public.commander_home_content_reports
   WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;
  IF v_report.status IN ('reviewed','actioned','dismissed') THEN
    RAISE EXCEPTION 'REPORT_ALREADY_RESOLVED' USING HINT='status is ' || v_report.status;
  END IF;
  IF v_report.reason_category IN ('illegal','self_harm','doxxing') THEN
    RAISE EXCEPTION 'ESCALATION_REQUIRED'
      USING HINT='category ' || v_report.reason_category || ' must be resolved by platform staff';
  END IF;
  IF v_report.content_author_id = v_owner_id THEN
    RAISE EXCEPTION 'CONFLICT_OF_INTEREST'
      USING HINT='host cannot resolve reports against their own content';
  END IF;

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
    RAISE EXCEPTION 'REPORT_NOT_IN_GROUP' USING HINT='report does not belong to the specified group';
  END IF;

  IF p_action = 'dismiss' THEN
    UPDATE public.commander_home_content_reports
       SET status='dismissed', reviewed_at=NOW(), reviewed_by=v_uid,
           moderator_note=p_moderator_note, action_taken='dismissed'
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
       SET status='actioned', reviewed_at=NOW(), reviewed_by=v_uid,
           moderator_note=p_moderator_note, action_taken='hide_content',
           content_hidden_at=NOW()
     WHERE id=p_report_id;
  ELSIF p_action = 'warn_author' THEN
    PERFORM public.fn_emit_home_notification(
      v_report.content_author_id, 'home_host_warning',
      'A host reviewed a report about your content',
      COALESCE(p_moderator_note,
        'A host reviewed a report and issued a warning. Please review the group rules.'),
      NULL, jsonb_build_object('group_id', p_group_id, 'report_id', p_report_id), NULL);
    UPDATE public.commander_home_content_reports
       SET status='reviewed', reviewed_at=NOW(), reviewed_by=v_uid,
           moderator_note=p_moderator_note, action_taken='warn_author'
     WHERE id=p_report_id;
  END IF;

  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (p_group_id, v_uid, v_report.reported_type::text,
          v_report.reported_id, 'host.resolve_report',
          jsonb_build_object(
            'report_id', p_report_id,
            'action', p_action,
            'note_preview', LEFT(COALESCE(p_moderator_note,''), 200)));

  RETURN jsonb_build_object('success', true, 'action', p_action, 'report_id', p_report_id);
END;
$fn$;
