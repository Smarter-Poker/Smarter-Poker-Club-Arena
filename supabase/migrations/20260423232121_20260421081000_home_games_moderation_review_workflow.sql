-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232121 "20260421081000_home_games_moderation_review_workflow"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8d80cdfe39aa767e09251d0936be07d0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 2 (retry, typo fixed): Moderation review workflow (GAP-A)
--
-- Before: report_home_content accepted user reports, but reports
-- accumulated in status='pending' with no admin review path. This
-- migration ships the admin-side of the moderation loop.
--
-- Schema changes:
--   1) is_hidden/hidden_at/hidden_by/hidden_reason on posts,
--      post_comments, game_reviews, game_photos
--   2) content_author_id, content_hidden_at, action_taken on
--      commander_home_content_reports
--   3) last_strike_at + banned_at/banned_by/ban_reason on members
--      (needed by Phase 3 auto-decay + ban-audit trail)
--   4) CHECK constraint extended to include 'hidden_pending_review'
--      status used by auto-hide from Phase 3
--
-- RPCs:
--   • list_home_content_reports — admin queue listing
--   • get_home_content_report_detail — one report + content snapshot
--   • resolve_home_content_report — take action, audit, notify author
--
-- Actions available to moderators:
--   dismiss, hide_content, delete_content, warn_author, strike_author,
--   ban_author — each wires correctly through content-type-specific
--   tables and uses the existing flake_strikes counter.

BEGIN;

-- Content-hide columns on the 4 reportable content tables --------------
ALTER TABLE public.commander_home_posts
  ADD COLUMN IF NOT EXISTS is_hidden     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

ALTER TABLE public.commander_home_post_comments
  ADD COLUMN IF NOT EXISTS is_hidden     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

ALTER TABLE public.commander_home_game_reviews
  ADD COLUMN IF NOT EXISTS is_hidden     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

ALTER TABLE public.commander_home_game_photos
  ADD COLUMN IF NOT EXISTS is_hidden     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

-- Indexes for read paths that filter hidden content
CREATE INDEX IF NOT EXISTS idx_commander_home_posts_visible
  ON public.commander_home_posts (group_id, created_at DESC) WHERE is_hidden = false;
CREATE INDEX IF NOT EXISTS idx_commander_home_post_comments_visible
  ON public.commander_home_post_comments (post_id, created_at) WHERE is_hidden = false;
CREATE INDEX IF NOT EXISTS idx_commander_home_game_reviews_visible
  ON public.commander_home_game_reviews (game_id, created_at DESC) WHERE is_hidden = false;
CREATE INDEX IF NOT EXISTS idx_commander_home_game_photos_visible
  ON public.commander_home_game_photos (game_id, created_at DESC) WHERE is_hidden = false;

-- Reports enrichment --------------------------------------------------
ALTER TABLE public.commander_home_content_reports
  ADD COLUMN IF NOT EXISTS content_author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS action_taken      text;

ALTER TABLE public.commander_home_content_reports
  DROP CONSTRAINT IF EXISTS commander_home_content_reports_status_check;
ALTER TABLE public.commander_home_content_reports
  ADD CONSTRAINT commander_home_content_reports_status_check
  CHECK (status = ANY (ARRAY[
    'pending',
    'hidden_pending_review',
    'reviewed',
    'actioned',
    'dismissed'
  ]));

CREATE INDEX IF NOT EXISTS idx_commander_home_content_reports_open
  ON public.commander_home_content_reports (status, created_at DESC)
  WHERE status IN ('pending', 'hidden_pending_review');

-- Members: add strike-decay + ban-audit columns ----------------------
-- flake_strikes already exists (integer). last_strike_at is needed for
-- auto-decay (Phase 3 cron). banned_at/banned_by/ban_reason track the
-- audit trail when status='banned' is set, so appeals have context.
ALTER TABLE public.commander_home_members
  ADD COLUMN IF NOT EXISTS last_strike_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_at      timestamptz,
  ADD COLUMN IF NOT EXISTS banned_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ban_reason     text;

-- ─── list_home_content_reports ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_home_content_reports(
  p_caller_user_id uuid,
  p_status         text    DEFAULT NULL,
  p_reported_type  text    DEFAULT NULL,
  p_limit          integer DEFAULT 50,
  p_offset         integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_rows jsonb;
  v_total int;
  v_safe_limit int;
  v_safe_offset int;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_caller_user_id;
  IF v_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING HINT = 'moderation queue is admin-only';
  END IF;

  v_safe_limit  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*) INTO v_total
    FROM public.commander_home_content_reports r
   WHERE (p_status IS NULL OR r.status = p_status)
     AND (p_reported_type IS NULL OR r.reported_type = p_reported_type);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id',                  r.id,
             'reporter_id',         r.reporter_id,
             'reporter_name',       COALESCE(p_reporter.display_name, p_reporter.username, 'Unknown'),
             'reported_type',       r.reported_type,
             'reported_id',         r.reported_id,
             'content_author_id',   r.content_author_id,
             'content_author_name', COALESCE(p_author.display_name, p_author.username, 'Unknown'),
             'reason_category',     r.reason_category,
             'reason_text',         r.reason_text,
             'status',              r.status,
             'content_hidden_at',   r.content_hidden_at,
             'reviewed_by',         r.reviewed_by,
             'reviewed_at',         r.reviewed_at,
             'moderator_note',      r.moderator_note,
             'action_taken',        r.action_taken,
             'created_at',          r.created_at
           )
           ORDER BY r.created_at DESC
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT *
        FROM public.commander_home_content_reports
       WHERE (p_status IS NULL OR status = p_status)
         AND (p_reported_type IS NULL OR reported_type = p_reported_type)
       ORDER BY created_at DESC
       LIMIT v_safe_limit OFFSET v_safe_offset
    ) r
    LEFT JOIN public.profiles p_reporter ON p_reporter.id = r.reporter_id
    LEFT JOIN public.profiles p_author   ON p_author.id   = r.content_author_id;

  RETURN jsonb_build_object(
    'success', true,
    'total',   v_total,
    'limit',   v_safe_limit,
    'offset',  v_safe_offset,
    'reports', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_home_content_reports(uuid,text,text,integer,integer) FROM public;
GRANT EXECUTE ON FUNCTION public.list_home_content_reports(uuid,text,text,integer,integer) TO authenticated;

-- ─── get_home_content_report_detail ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_home_content_report_detail(
  p_report_id      uuid,
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role    text;
  v_report  RECORD;
  v_snapshot jsonb;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_caller_user_id;
  IF v_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_report FROM public.commander_home_content_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;

  CASE v_report.reported_type
    WHEN 'post' THEN
      SELECT jsonb_build_object(
        'id', id, 'group_id', group_id, 'author_id', author_id,
        'content', content, 'image_urls', image_urls, 'video_url', video_url,
        'is_hidden', is_hidden, 'hidden_at', hidden_at, 'hidden_reason', hidden_reason,
        'created_at', created_at
      ) INTO v_snapshot
        FROM public.commander_home_posts WHERE id = v_report.reported_id;
    WHEN 'comment' THEN
      SELECT jsonb_build_object(
        'id', id, 'post_id', post_id, 'author_id', author_id,
        'content', content,
        'is_hidden', is_hidden, 'hidden_at', hidden_at,
        'created_at', created_at
      ) INTO v_snapshot
        FROM public.commander_home_post_comments WHERE id = v_report.reported_id;
    WHEN 'review' THEN
      SELECT jsonb_build_object(
        'id', id, 'game_id', game_id, 'reviewer_id', reviewer_id,
        'rating', rating, 'review_text', review_text,
        'is_hidden', is_hidden, 'hidden_at', hidden_at,
        'created_at', created_at
      ) INTO v_snapshot
        FROM public.commander_home_game_reviews WHERE id = v_report.reported_id;
    WHEN 'game' THEN
      SELECT jsonb_build_object(
        'id', id, 'group_id', group_id, 'host_id', host_id,
        'title', title, 'description', description,
        'scheduled_date', scheduled_date, 'status', status,
        'created_at', created_at
      ) INTO v_snapshot
        FROM public.commander_home_games WHERE id = v_report.reported_id;
    WHEN 'group' THEN
      SELECT jsonb_build_object(
        'id', id, 'owner_id', owner_id, 'name', name,
        'description', description, 'is_active', is_active,
        'created_at', created_at
      ) INTO v_snapshot
        FROM public.commander_home_groups WHERE id = v_report.reported_id;
    WHEN 'member' THEN
      SELECT jsonb_build_object(
        'id', id, 'group_id', group_id, 'user_id', user_id,
        'role', role, 'status', status, 'flake_strikes', flake_strikes,
        'banned_at', banned_at, 'ban_reason', ban_reason
      ) INTO v_snapshot
        FROM public.commander_home_members WHERE id = v_report.reported_id;
    ELSE
      v_snapshot := NULL;
  END CASE;

  RETURN jsonb_build_object(
    'success', true,
    'report', to_jsonb(v_report),
    'content_snapshot', v_snapshot
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_home_content_report_detail(uuid,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_home_content_report_detail(uuid,uuid) TO authenticated;

-- ─── resolve_home_content_report ─────────────────────────────────────
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
  v_role       text;
  v_report     RECORD;
  v_group_id   uuid;
  v_notice     text;
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
    RAISE EXCEPTION 'REPORT_ALREADY_RESOLVED'
          USING HINT = 'status is ' || v_report.status;
  END IF;

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
           SET status='cancelled',
               cancelled_at=now(),
               cancelled_by=p_caller_user_id,
               cancellation_reason = COALESCE(p_moderator_note, 'moderation_action')
         WHERE id = v_report.reported_id AND status NOT IN ('completed','cancelled');
      WHEN 'group' THEN
        UPDATE public.commander_home_groups
           SET is_active=false
         WHERE id = v_report.reported_id;
      ELSE NULL;
    END CASE;
    v_notice := 'Your ' || v_report.reported_type ||
                ' was hidden for violating community policy.';

  ELSIF p_action = 'delete_content' THEN
    CASE v_report.reported_type
      WHEN 'post' THEN
        DELETE FROM public.commander_home_posts WHERE id = v_report.reported_id;
      WHEN 'comment' THEN
        DELETE FROM public.commander_home_post_comments WHERE id = v_report.reported_id;
      WHEN 'review' THEN
        DELETE FROM public.commander_home_game_reviews WHERE id = v_report.reported_id;
      WHEN 'game' THEN
        UPDATE public.commander_home_games
           SET status='cancelled',
               cancelled_at=now(),
               cancelled_by=p_caller_user_id,
               cancellation_reason = COALESCE(p_moderator_note, 'moderation_delete')
         WHERE id = v_report.reported_id AND status NOT IN ('completed','cancelled');
      ELSE NULL;
    END CASE;
    v_notice := 'Your ' || v_report.reported_type ||
                ' was removed for violating community policy.';

  ELSIF p_action = 'warn_author' THEN
    v_notice := 'A moderator reviewed a report on your ' || v_report.reported_type ||
                ' and issued a warning. Please review the community guidelines.';

  ELSIF p_action = 'strike_author' THEN
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

    IF v_group_id IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
      UPDATE public.commander_home_members
         SET flake_strikes  = COALESCE(flake_strikes, 0) + 1,
             last_strike_at = now()
       WHERE group_id = v_group_id AND user_id = v_report.content_author_id;
    END IF;
    v_notice := 'Your account received a strike for a community policy violation.';

  ELSIF p_action = 'ban_author' THEN
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
      WHEN 'group' THEN v_group_id := v_report.reported_id;
      WHEN 'member' THEN
        SELECT group_id INTO v_group_id FROM public.commander_home_members WHERE id = v_report.reported_id;
    END CASE;
    IF v_group_id IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
      UPDATE public.commander_home_members
         SET status     = 'banned',
             banned_at  = now(),
             banned_by  = p_caller_user_id,
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
         content_hidden_at = CASE
           WHEN p_action IN ('hide_content','delete_content') THEN now()
           ELSE content_hidden_at
         END
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

  INSERT INTO public.commander_home_audit_log(group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (v_group_id, p_caller_user_id, v_report.reported_type, v_report.reported_id,
          'moderation.' || p_action,
          jsonb_build_object('report_id', p_report_id, 'note', p_moderator_note));

  RETURN jsonb_build_object(
    'success',  true,
    'report_id', p_report_id,
    'action',    p_action
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_home_content_report(uuid,text,text,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_home_content_report(uuid,text,text,uuid) TO authenticated;

COMMIT;
