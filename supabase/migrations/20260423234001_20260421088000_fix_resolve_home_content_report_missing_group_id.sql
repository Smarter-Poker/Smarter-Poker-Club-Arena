-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423234001 "20260421088000_fix_resolve_home_content_report_missing_group_id"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a4a91976bed1a06f063669a83aea20f4 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug caught in end-to-end probe: resolve_home_content_report's audit_log
-- INSERT fails NOT NULL on group_id because v_group_id was only resolved
-- inside the strike_author and ban_author branches. For dismiss,
-- hide_content, delete_content, and warn_author, v_group_id was NULL →
-- 23502 at commit time.
--
-- Fix: resolve v_group_id unconditionally near the top of the function,
-- after auth checks. Then remove the duplicate resolution that was
-- previously inside the two branches (now redundant but harmless).

CREATE OR REPLACE FUNCTION public.resolve_home_content_report(
  p_report_id      uuid,
  p_action         text,
  p_moderator_note text,
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role     text;
  v_report   RECORD;
  v_group_id uuid;
  v_notice   text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_caller_user_id;
  IF v_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_action NOT IN ('dismiss','hide_content','delete_content','warn_author','strike_author','ban_author') THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  SELECT * INTO v_report FROM public.commander_home_content_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;

  IF v_report.status IN ('reviewed','actioned','dismissed') THEN
    RAISE EXCEPTION 'REPORT_ALREADY_RESOLVED' USING HINT = 'status is ' || v_report.status;
  END IF;

  -- Resolve the owning group for every action. Used by audit log + some
  -- branches. Nullable if the reported content has already been deleted
  -- or if the type doesn't map to a group (bug in caller); we'll accept
  -- NULL in audit log below and the schema will tell us if that's OK.
  CASE v_report.reported_type
    WHEN 'post' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_posts WHERE id = v_report.reported_id;
    WHEN 'comment' THEN
      SELECT p.group_id INTO v_group_id
        FROM public.commander_home_post_comments c
        JOIN public.commander_home_posts p ON p.id = c.post_id
       WHERE c.id = v_report.reported_id;
    WHEN 'review' THEN
      SELECT g.group_id INTO v_group_id
        FROM public.commander_home_game_reviews r
        JOIN public.commander_home_games g ON g.id = r.game_id
       WHERE r.id = v_report.reported_id;
    WHEN 'game' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_games WHERE id = v_report.reported_id;
    WHEN 'group' THEN
      v_group_id := v_report.reported_id;
    WHEN 'member' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_members WHERE id = v_report.reported_id;
  END CASE;

  -- Action dispatch
  IF p_action = 'dismiss' THEN
    v_notice := NULL;

  ELSIF p_action = 'hide_content' THEN
    CASE v_report.reported_type
      WHEN 'post' THEN
        UPDATE public.commander_home_posts
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'comment' THEN
        UPDATE public.commander_home_post_comments
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'review' THEN
        UPDATE public.commander_home_game_reviews
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'game' THEN
        UPDATE public.commander_home_games
           SET status='cancelled', cancelled_at=now(), cancelled_by=p_caller_user_id,
               cancellation_reason = COALESCE(p_moderator_note, 'moderation_action')
         WHERE id = v_report.reported_id AND status NOT IN ('completed','cancelled');
      WHEN 'group' THEN
        UPDATE public.commander_home_groups SET is_active=false WHERE id = v_report.reported_id;
      ELSE NULL;
    END CASE;
    v_notice := 'Your ' || v_report.reported_type || ' was hidden for violating community policy.';

  ELSIF p_action = 'delete_content' THEN
    CASE v_report.reported_type
      WHEN 'post'    THEN DELETE FROM public.commander_home_posts         WHERE id = v_report.reported_id;
      WHEN 'comment' THEN DELETE FROM public.commander_home_post_comments WHERE id = v_report.reported_id;
      WHEN 'review'  THEN DELETE FROM public.commander_home_game_reviews  WHERE id = v_report.reported_id;
      WHEN 'game'    THEN
        UPDATE public.commander_home_games
           SET status='cancelled', cancelled_at=now(), cancelled_by=p_caller_user_id,
               cancellation_reason = COALESCE(p_moderator_note, 'moderation_delete')
         WHERE id = v_report.reported_id AND status NOT IN ('completed','cancelled');
      ELSE NULL;
    END CASE;
    v_notice := 'Your ' || v_report.reported_type || ' was removed for violating community policy.';

  ELSIF p_action = 'warn_author' THEN
    v_notice := 'A moderator reviewed a report on your ' || v_report.reported_type ||
                ' and issued a warning. Please review the community guidelines.';

  ELSIF p_action = 'strike_author' THEN
    IF v_group_id IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
      UPDATE public.commander_home_members
         SET flake_strikes  = COALESCE(flake_strikes, 0) + 1,
             last_strike_at = now()
       WHERE group_id = v_group_id AND user_id = v_report.content_author_id;
    END IF;
    v_notice := 'Your account received a strike for a community policy violation.';

  ELSIF p_action = 'ban_author' THEN
    IF v_group_id IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
      UPDATE public.commander_home_members
         SET status='banned', banned_at=now(), banned_by=p_caller_user_id,
             ban_reason = COALESCE(p_moderator_note, 'policy_violation')
       WHERE group_id = v_group_id AND user_id = v_report.content_author_id;
    END IF;
    v_notice := 'You have been banned from this group for a policy violation.';
  END IF;

  UPDATE public.commander_home_content_reports
     SET status         = CASE WHEN p_action='dismiss' THEN 'dismissed' ELSE 'actioned' END,
         reviewed_by    = p_caller_user_id,
         reviewed_at    = now(),
         moderator_note = p_moderator_note,
         action_taken   = p_action,
         content_hidden_at = CASE WHEN p_action IN ('hide_content','delete_content') THEN now()
                                  ELSE content_hidden_at END
   WHERE id = p_report_id;

  IF v_notice IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
    PERFORM public.fn_emit_home_notification(
      p_user_id     => v_report.content_author_id,
      p_type        => 'moderation_action',
      p_title       => 'Moderation action',
      p_message     => v_notice,
      p_link        => NULL,
      p_data        => jsonb_build_object(
                         'report_id',     p_report_id,
                         'reported_type', v_report.reported_type,
                         'action',        p_action
                       ),
      p_pref_column => NULL
    );
  END IF;

  -- Audit log — group_id MAY be NULL if content already deleted. The
  -- audit_log column is NOT NULL; if v_group_id is NULL we skip the
  -- insert rather than 500.
  IF v_group_id IS NOT NULL THEN
    INSERT INTO public.commander_home_audit_log(group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_group_id, p_caller_user_id, v_report.reported_type, v_report.reported_id,
            'moderation.' || p_action,
            jsonb_build_object('report_id', p_report_id, 'note', p_moderator_note));
  END IF;

  RETURN jsonb_build_object(
    'success',  true,
    'report_id', p_report_id,
    'action',    p_action,
    'group_id_resolved', v_group_id IS NOT NULL
  );
END;
$function$;
