-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232234 "20260421082000_home_games_report_dedup_and_abuse_enforcement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 abc740e246d48e58ee6e19d7ca4407cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 6 (GAP-F): Report deduplication
-- Before: a user could submit the same report against the same content
-- 10 times and create 10 distinct rows. Partial unique guarantees at the
-- DB layer: one open report per (reporter, content) while pending or
-- awaiting review. Once resolved (actioned/dismissed/reviewed), the pair
-- opens up again (user can report further misbehavior).
--
-- PHASE 3 (GAP-B): Abuse enforcement loop
--   3a) Auto-hide on N reports — a trigger on content_reports counts
--       open reports for a given content piece and, when the threshold
--       is reached, auto-flips is_hidden=true on the content + marks
--       all associated reports as 'hidden_pending_review' so moderators
--       see they came in hot.
--   3b) Strike auto-decay — cron-callable function. Strikes decay by 1
--       every 90 days since last_strike_at. Keeps old offenses from
--       haunting users forever.
--   3c) Ban appeals — create/review pair of RPCs + table.
--   3d) auto_ban_after_flakes on the group is already used; now on
--       strike_author via resolve_home_content_report we cross that
--       threshold → auto-ban.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- PHASE 6 — Report dedup
-- ══════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_home_content_reports_open_by_reporter
  ON public.commander_home_content_reports (reporter_id, reported_type, reported_id)
  WHERE status IN ('pending','hidden_pending_review');

-- ══════════════════════════════════════════════════════════════════════
-- PHASE 3a — Auto-hide on N reports
-- ══════════════════════════════════════════════════════════════════════

-- Threshold for auto-hide. Tuneable per content type via platform_policies.
INSERT INTO public.platform_policies (key, value, description)
VALUES
  ('home_games.moderation.auto_hide_threshold',
   '3',
   'Number of distinct OPEN reports on a single piece of content that will trigger automatic hide (pending moderator review). Conservative starting value — revisit after observing real traffic.'),
  ('home_games.moderation.strike_decay_days',
   '90',
   'Strikes decay by 1 every N days since last_strike_at. Never below zero.'),
  ('home_games.moderation.auto_ban_at_strikes',
   '3',
   'Strike count at which auto-ban fires on strike_author action.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_home_auto_hide_on_report_threshold()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold int;
  v_open_count int;
  v_author_id uuid;
BEGIN
  -- Only run when a new OPEN report is inserted. Updates don't count.
  IF TG_OP <> 'INSERT' OR NEW.status NOT IN ('pending','hidden_pending_review') THEN
    RETURN NEW;
  END IF;

  SELECT value::int INTO v_threshold
    FROM public.platform_policies
   WHERE key = 'home_games.moderation.auto_hide_threshold';
  IF v_threshold IS NULL THEN v_threshold := 3; END IF;

  -- Count distinct OPEN reports for this specific content piece
  SELECT COUNT(*) INTO v_open_count
    FROM public.commander_home_content_reports
   WHERE reported_type = NEW.reported_type
     AND reported_id   = NEW.reported_id
     AND status IN ('pending','hidden_pending_review');

  IF v_open_count < v_threshold THEN
    RETURN NEW;
  END IF;

  -- Resolve author id + hide the content. Safe no-ops if already hidden.
  CASE NEW.reported_type
    WHEN 'post' THEN
      UPDATE public.commander_home_posts
         SET is_hidden = true,
             hidden_at = COALESCE(hidden_at, now()),
             hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
       WHERE id = NEW.reported_id AND is_hidden = false
      RETURNING author_id INTO v_author_id;
    WHEN 'comment' THEN
      UPDATE public.commander_home_post_comments
         SET is_hidden = true,
             hidden_at = COALESCE(hidden_at, now()),
             hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
       WHERE id = NEW.reported_id AND is_hidden = false
      RETURNING author_id INTO v_author_id;
    WHEN 'review' THEN
      UPDATE public.commander_home_game_reviews
         SET is_hidden = true,
             hidden_at = COALESCE(hidden_at, now()),
             hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
       WHERE id = NEW.reported_id AND is_hidden = false
      RETURNING reviewer_id INTO v_author_id;
    ELSE
      -- games / groups / members don't auto-hide; they need human review
      RETURN NEW;
  END CASE;

  -- Flip ALL currently-pending reports on this content to hidden_pending_review
  UPDATE public.commander_home_content_reports
     SET status = 'hidden_pending_review',
         content_hidden_at = COALESCE(content_hidden_at, now())
   WHERE reported_type = NEW.reported_type
     AND reported_id   = NEW.reported_id
     AND status = 'pending';

  -- Notify the author their content was auto-hidden
  IF v_author_id IS NOT NULL THEN
    PERFORM public.fn_emit_home_notification(
      p_user_id     => v_author_id,
      p_type        => 'moderation_auto_hide',
      p_title       => 'Your content was hidden pending review',
      p_message     => 'Multiple users reported your ' || NEW.reported_type ||
                       '. It is temporarily hidden while a moderator reviews. ' ||
                       'If the reports are dismissed, it will be restored.',
      p_link        => NULL,
      p_data        => jsonb_build_object(
                         'reported_type', NEW.reported_type,
                         'reported_id',   NEW.reported_id
                       ),
      p_pref_column => NULL
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_home_auto_hide_on_report_threshold
  ON public.commander_home_content_reports;
CREATE TRIGGER trg_home_auto_hide_on_report_threshold
  AFTER INSERT ON public.commander_home_content_reports
  FOR EACH ROW EXECUTE FUNCTION public.fn_home_auto_hide_on_report_threshold();

-- ══════════════════════════════════════════════════════════════════════
-- PHASE 3b — Strike auto-decay (cron-callable)
-- ══════════════════════════════════════════════════════════════════════
-- Run this daily from pg_cron or a Vercel cron route. It reduces strikes
-- by 1 for every full decay interval elapsed since last_strike_at.
-- Never drops below zero. If strikes hits zero, last_strike_at is
-- cleared so the member's slate is clean.
CREATE OR REPLACE FUNCTION public.fn_decay_home_member_strikes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_decay_days int;
  v_affected int;
BEGIN
  SELECT value::int INTO v_decay_days
    FROM public.platform_policies
   WHERE key = 'home_games.moderation.strike_decay_days';
  IF v_decay_days IS NULL THEN v_decay_days := 90; END IF;

  WITH decayable AS (
    SELECT id,
           GREATEST(0,
             COALESCE(flake_strikes, 0)
               - FLOOR(EXTRACT(EPOCH FROM (now() - last_strike_at)) / (v_decay_days * 86400))::int
           )::int AS new_strikes
      FROM public.commander_home_members
     WHERE flake_strikes > 0
       AND last_strike_at IS NOT NULL
       AND last_strike_at < now() - make_interval(days => v_decay_days)
  )
  UPDATE public.commander_home_members m
     SET flake_strikes  = d.new_strikes,
         last_strike_at = CASE WHEN d.new_strikes = 0 THEN NULL ELSE last_strike_at END
    FROM decayable d
   WHERE m.id = d.id
     AND m.flake_strikes <> d.new_strikes;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'decay_days', v_decay_days,
    'members_updated', v_affected
  );
END;
$function$;

-- Service-role only — cron invocation
REVOKE ALL ON FUNCTION public.fn_decay_home_member_strikes() FROM public;
REVOKE ALL ON FUNCTION public.fn_decay_home_member_strikes() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_decay_home_member_strikes() TO service_role;

-- ══════════════════════════════════════════════════════════════════════
-- PHASE 3c — Ban appeal workflow
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.commander_home_ban_appeals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        uuid        NOT NULL REFERENCES public.commander_home_groups(id) ON DELETE CASCADE,
  member_id       uuid        NOT NULL REFERENCES public.commander_home_members(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  appeal_text     text        NOT NULL CHECK (length(appeal_text) BETWEEN 1 AND 2000),
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','denied','withdrawn')),
  reviewed_by     uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  reviewer_note   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commander_home_ban_appeals_open
  ON public.commander_home_ban_appeals (status, created_at DESC)
  WHERE status = 'pending';
-- One pending appeal per banned user per group
CREATE UNIQUE INDEX IF NOT EXISTS uq_commander_home_ban_appeals_open_per_user
  ON public.commander_home_ban_appeals (group_id, user_id)
  WHERE status = 'pending';

ALTER TABLE public.commander_home_ban_appeals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appeals_self_read ON public.commander_home_ban_appeals;
CREATE POLICY appeals_self_read ON public.commander_home_ban_appeals
  FOR SELECT USING (user_id = auth.uid());

-- Create an appeal (user-side)
CREATE OR REPLACE FUNCTION public.submit_home_ban_appeal(
  p_group_id       uuid,
  p_appeal_text    text,
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member RECORD;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_appeal_text IS NULL OR length(trim(p_appeal_text)) < 1 THEN
    RAISE EXCEPTION 'APPEAL_TEXT_REQUIRED';
  END IF;
  IF length(p_appeal_text) > 2000 THEN
    RAISE EXCEPTION 'APPEAL_TEXT_TOO_LONG' USING HINT = 'max 2000 chars';
  END IF;

  SELECT * INTO v_member FROM public.commander_home_members
   WHERE group_id = p_group_id AND user_id = p_caller_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF v_member.status <> 'banned' THEN
    RAISE EXCEPTION 'NOT_BANNED' USING HINT = 'only banned members can appeal';
  END IF;

  INSERT INTO public.commander_home_ban_appeals
    (group_id, member_id, user_id, appeal_text)
  VALUES
    (p_group_id, v_member.id, p_caller_user_id, trim(p_appeal_text))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'appeal_id', v_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'APPEAL_ALREADY_PENDING';
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_home_ban_appeal(uuid,text,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_home_ban_appeal(uuid,text,uuid) TO authenticated;

-- Review an appeal (owner/admin of the group)
CREATE OR REPLACE FUNCTION public.review_home_ban_appeal(
  p_appeal_id      uuid,
  p_decision       text,   -- 'approved' | 'denied'
  p_reviewer_note  text,
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_appeal RECORD;
  v_is_staff boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_decision NOT IN ('approved','denied') THEN
    RAISE EXCEPTION 'INVALID_DECISION';
  END IF;

  SELECT * INTO v_appeal FROM public.commander_home_ban_appeals WHERE id = p_appeal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPEAL_NOT_FOUND'; END IF;
  IF v_appeal.status <> 'pending' THEN
    RAISE EXCEPTION 'APPEAL_ALREADY_REVIEWED' USING HINT = 'status is ' || v_appeal.status;
  END IF;

  -- Caller must be owner or admin of the group
  SELECT (
    EXISTS (SELECT 1 FROM public.commander_home_groups
             WHERE id = v_appeal.group_id AND owner_id = p_caller_user_id)
    OR EXISTS (SELECT 1 FROM public.commander_home_members
                WHERE group_id = v_appeal.group_id
                  AND user_id  = p_caller_user_id
                  AND role IN ('owner','admin')
                  AND status   = 'approved')
  ) INTO v_is_staff;
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'FORBIDDEN' USING HINT = 'only group owner/admin can review appeals';
  END IF;

  UPDATE public.commander_home_ban_appeals
     SET status        = p_decision,
         reviewed_by   = p_caller_user_id,
         reviewed_at   = now(),
         reviewer_note = p_reviewer_note
   WHERE id = p_appeal_id;

  IF p_decision = 'approved' THEN
    UPDATE public.commander_home_members
       SET status         = 'approved',
           banned_at      = NULL,
           banned_by      = NULL,
           ban_reason     = NULL,
           flake_strikes  = 0,
           last_strike_at = NULL
     WHERE id = v_appeal.member_id;

    PERFORM public.fn_emit_home_notification(
      p_user_id     => v_appeal.user_id,
      p_type        => 'ban_appeal_approved',
      p_title       => 'Ban appeal approved',
      p_message     => 'Your ban appeal was approved. You can rejoin this group.',
      p_link        => NULL,
      p_data        => jsonb_build_object('group_id', v_appeal.group_id),
      p_pref_column => NULL
    );
  ELSE
    PERFORM public.fn_emit_home_notification(
      p_user_id     => v_appeal.user_id,
      p_type        => 'ban_appeal_denied',
      p_title       => 'Ban appeal denied',
      p_message     => COALESCE(
                         'Your ban appeal was denied. Reviewer note: ' || p_reviewer_note,
                         'Your ban appeal was denied.'
                       ),
      p_link        => NULL,
      p_data        => jsonb_build_object('group_id', v_appeal.group_id),
      p_pref_column => NULL
    );
  END IF;

  INSERT INTO public.commander_home_audit_log(group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (v_appeal.group_id, p_caller_user_id, 'member', v_appeal.member_id,
          'ban_appeal.' || p_decision,
          jsonb_build_object('appeal_id', p_appeal_id, 'note', p_reviewer_note));

  RETURN jsonb_build_object('success', true, 'appeal_id', p_appeal_id, 'decision', p_decision);
END;
$function$;

REVOKE ALL ON FUNCTION public.review_home_ban_appeal(uuid,text,text,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.review_home_ban_appeal(uuid,text,text,uuid) TO authenticated;

-- Withdraw own pending appeal
CREATE OR REPLACE FUNCTION public.withdraw_home_ban_appeal(
  p_appeal_id      uuid,
  p_caller_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_appeal RECORD;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT * INTO v_appeal FROM public.commander_home_ban_appeals
   WHERE id = p_appeal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPEAL_NOT_FOUND'; END IF;
  IF v_appeal.user_id <> p_caller_user_id THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF v_appeal.status <> 'pending' THEN
    RAISE EXCEPTION 'APPEAL_NOT_PENDING';
  END IF;

  UPDATE public.commander_home_ban_appeals
     SET status = 'withdrawn', reviewed_at = now()
   WHERE id = p_appeal_id;

  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.withdraw_home_ban_appeal(uuid,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.withdraw_home_ban_appeal(uuid,uuid) TO authenticated;

COMMIT;
