-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827005711; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'review_home_ban_appeal'
      AND pg_get_function_identity_arguments(p.oid)
          = 'p_appeal_id uuid, p_decision text, p_reviewer_note text, p_caller_user_id uuid'
  ) THEN
    RAISE EXCEPTION 'review_home_ban_appeal(uuid,text,text,uuid) not found -- signature drifted, do not replace blindly';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.review_home_ban_appeal(
  p_appeal_id uuid, p_decision text, p_reviewer_note text, p_caller_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_appeal RECORD;
  v_is_group_staff boolean;
  v_is_platform_staff boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_decision NOT IN ('approved','denied') THEN RAISE EXCEPTION 'INVALID_DECISION'; END IF;
  IF p_reviewer_note IS NOT NULL AND length(p_reviewer_note) > 2000 THEN
    RAISE EXCEPTION 'REVIEWER_NOTE_TOO_LONG' USING HINT = 'max 2000 chars';
  END IF;

  SELECT * INTO v_appeal FROM public.commander_home_ban_appeals WHERE id = p_appeal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APPEAL_NOT_FOUND'; END IF;
  IF v_appeal.status <> 'pending' THEN
    RAISE EXCEPTION 'APPEAL_ALREADY_REVIEWED' USING HINT = 'status is ' || v_appeal.status;
  END IF;

  SELECT (
    EXISTS (SELECT 1 FROM public.commander_home_groups
             WHERE id = v_appeal.group_id AND owner_id = p_caller_user_id)
    OR EXISTS (SELECT 1 FROM public.commander_home_members
                WHERE group_id = v_appeal.group_id AND user_id = p_caller_user_id
                  AND role IN ('owner','admin') AND status = 'approved')
  ) INTO v_is_group_staff;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_caller_user_id AND role IN ('admin','superadmin','god')
  ) INTO v_is_platform_staff;

  IF NOT (v_is_group_staff OR v_is_platform_staff) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING HINT = 'only group owner/admin or platform staff can review appeals';
  END IF;

  UPDATE public.commander_home_ban_appeals
     SET status = p_decision, reviewed_by = p_caller_user_id,
         reviewed_at = now(), reviewer_note = p_reviewer_note
   WHERE id = p_appeal_id;

  IF p_decision = 'approved' THEN
    UPDATE public.commander_home_members
       SET status='approved', banned_at=NULL, banned_by=NULL, ban_reason=NULL,
           flake_strikes=0, last_strike_at=NULL
     WHERE id = v_appeal.member_id;

    PERFORM public.fn_emit_home_notification(
      p_user_id => v_appeal.user_id, p_type => 'ban_appeal_approved',
      p_title => 'Ban appeal approved',
      p_message => 'Your ban appeal was approved. You can rejoin this group.',
      p_link => NULL,
      p_data => jsonb_build_object('group_id', v_appeal.group_id),
      p_pref_column => NULL);
  ELSE
    PERFORM public.fn_emit_home_notification(
      p_user_id => v_appeal.user_id, p_type => 'ban_appeal_denied',
      p_title => 'Ban appeal denied',
      p_message => COALESCE('Your ban appeal was denied. Reviewer note: ' || p_reviewer_note,
                            'Your ban appeal was denied.'),
      p_link => NULL,
      p_data => jsonb_build_object('group_id', v_appeal.group_id),
      p_pref_column => NULL);
  END IF;

  INSERT INTO public.commander_home_audit_log(group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (v_appeal.group_id, p_caller_user_id, 'member', v_appeal.member_id,
          'ban_appeal.' || p_decision,
          jsonb_build_object(
            'appeal_id', p_appeal_id,
            'note', p_reviewer_note,
            'reviewed_as', CASE WHEN v_is_group_staff THEN 'group_staff' ELSE 'platform_staff' END));

  RETURN jsonb_build_object('success', true, 'appeal_id', p_appeal_id, 'decision', p_decision);
END;
$function$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'review_home_ban_appeal';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'review_home_ban_appeal vanished';
  END IF;
  IF v_def NOT LIKE '%auth.uid() <> p_caller_user_id%' THEN
    RAISE EXCEPTION 'caller identity pin missing -- refusing to leave this in place';
  END IF;
  IF v_def NOT LIKE '%v_is_platform_staff%' THEN
    RAISE EXCEPTION 'platform staff branch did not land';
  END IF;
  IF v_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'row lock lost -- two reviewers could decide the same appeal';
  END IF;
  RAISE NOTICE 'review_home_ban_appeal: platform staff branch applied, identity pin and row lock intact';
END $$;
