-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424011938 "20260421142000_hg_audit_log_coverage_for_6_admin_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cfd0f19992a164a8e93cb09b26dbbca5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Audit log coverage for 6 admin/moderator actions that were missing
-- commander_home_audit_log inserts. Now every privileged state change
-- leaves a durable trail for compliance / incident investigation.
--
--   fn_home_auto_hide_on_report_threshold (trigger) → system auto-hide
--   promote_home_game_waitlist               → waitlist promotion batch
--   revive_home_group                        → dormancy revival
--   set_home_member_private_note             → host note update
--   set_home_member_regular                  → regular flag toggle
--   withdraw_home_group_promotion            → promotion request pullback

-- ── 1. fn_home_auto_hide_on_report_threshold ────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_auto_hide_on_report_threshold()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold int;
  v_open_count int;
  v_author_id uuid;
  v_group_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.status NOT IN ('pending','hidden_pending_review') THEN
    RETURN NEW;
  END IF;

  SELECT value::int INTO v_threshold FROM public.platform_policies
   WHERE key = 'home_games.moderation.auto_hide_threshold';
  IF v_threshold IS NULL THEN v_threshold := 3; END IF;

  SELECT COUNT(*) INTO v_open_count FROM public.commander_home_content_reports
   WHERE reported_type = NEW.reported_type AND reported_id = NEW.reported_id
     AND status IN ('pending','hidden_pending_review');

  IF v_open_count < v_threshold THEN RETURN NEW; END IF;

  -- Resolve group + author
  CASE NEW.reported_type
    WHEN 'post' THEN
      UPDATE public.commander_home_posts
         SET is_hidden = true, hidden_at = COALESCE(hidden_at, now()),
             hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
       WHERE id = NEW.reported_id AND is_hidden = false
      RETURNING author_id, group_id INTO v_author_id, v_group_id;
    WHEN 'comment' THEN
      WITH updated AS (
        UPDATE public.commander_home_post_comments
           SET is_hidden = true, hidden_at = COALESCE(hidden_at, now()),
               hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
         WHERE id = NEW.reported_id AND is_hidden = false
        RETURNING author_id, post_id)
      SELECT u.author_id, p.group_id INTO v_author_id, v_group_id
        FROM updated u JOIN public.commander_home_posts p ON p.id = u.post_id;
    WHEN 'review' THEN
      WITH updated AS (
        UPDATE public.commander_home_game_reviews
           SET is_hidden = true, hidden_at = COALESCE(hidden_at, now()),
               hidden_reason = COALESCE(hidden_reason, 'auto_hide_threshold_reached')
         WHERE id = NEW.reported_id AND is_hidden = false
        RETURNING reviewer_id, game_id)
      SELECT u.reviewer_id, g.group_id INTO v_author_id, v_group_id
        FROM updated u JOIN public.commander_home_games g ON g.id = u.game_id;
    ELSE RETURN NEW;
  END CASE;

  UPDATE public.commander_home_content_reports
     SET status = 'hidden_pending_review',
         content_hidden_at = COALESCE(content_hidden_at, now())
   WHERE reported_type = NEW.reported_type AND reported_id = NEW.reported_id
     AND status = 'pending';

  IF v_author_id IS NOT NULL THEN
    PERFORM public.fn_emit_home_notification(
      p_user_id => v_author_id, p_type => 'moderation_auto_hide',
      p_title => 'Your content was hidden pending review',
      p_message => 'Multiple users reported your ' || NEW.reported_type ||
                   '. It is temporarily hidden while a moderator reviews. ' ||
                   'If the reports are dismissed, it will be restored.',
      p_link => NULL,
      p_data => jsonb_build_object('reported_type', NEW.reported_type,
                                   'reported_id', NEW.reported_id),
      p_pref_column => NULL);
  END IF;

  -- ★ NEW: audit log — actor_id NULL = system action
  IF v_group_id IS NOT NULL THEN
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (
      v_group_id, NULL, NEW.reported_type, NEW.reported_id,
      'moderation.auto_hide_threshold',
      jsonb_build_object('threshold', v_threshold,
                         'open_reports', v_open_count,
                         'report_id', NEW.id));
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 2. promote_home_game_waitlist ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.promote_home_game_waitlist(
  p_game_id uuid, p_caller_user_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game RECORD; v_group RECORD;
    v_seats_open int; v_promoted_ids uuid[] := ARRAY[]::uuid[];
    v_rsvp RECORD; v_is_trigger_call boolean; v_is_service_role boolean;
    v_uid uuid;
BEGIN
    v_is_trigger_call := (current_setting('app.hg_waitlist_auto_promote', true) = '1');
    v_is_service_role := (auth.role() = 'service_role');

    IF v_is_trigger_call OR v_is_service_role THEN NULL;
    ELSE
        IF p_caller_user_id IS NULL THEN
            RAISE EXCEPTION 'UNAUTHORIZED' USING HINT = 'promote_home_game_waitlist requires p_caller_user_id';
        END IF;
        IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
            RAISE EXCEPTION 'UNAUTHORIZED' USING HINT = 'auth.uid() must match p_caller_user_id';
        END IF;
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed') THEN RAISE EXCEPTION 'GAME_NOT_OPEN'; END IF;

    IF NOT v_is_trigger_call AND NOT v_is_service_role THEN
        SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
        IF v_game.host_id <> p_caller_user_id
           AND v_group.owner_id <> p_caller_user_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members
                            WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                              AND role = 'admin' AND status = 'approved')
        THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
    END IF;

    v_seats_open := GREATEST(0,
        COALESCE(v_game.max_players, 9) - COALESCE(v_game.rsvp_yes, 0));
    IF v_seats_open = 0 THEN
        RETURN jsonb_build_object('success', true, 'promoted_count', 0, 'seats_full', true);
    END IF;

    FOR v_rsvp IN
        SELECT id, user_id FROM commander_home_rsvps
         WHERE game_id = p_game_id AND response = 'waitlist'
         ORDER BY responded_at LIMIT v_seats_open FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE commander_home_rsvps
           SET response = 'yes', updated_at = NOW()
         WHERE id = v_rsvp.id;
        v_promoted_ids := array_append(v_promoted_ids, v_rsvp.user_id);
    END LOOP;

    IF array_length(v_promoted_ids, 1) > 0 THEN
      FOREACH v_uid IN ARRAY v_promoted_ids LOOP
        BEGIN
          PERFORM public.fn_emit_home_notification(
            p_user_id => v_uid, p_type => 'home_game_waitlist_promoted',
            p_title => 'You''re off the waitlist!',
            p_message => 'A seat opened up and you''re in for the game.',
            p_link => '/hub/home-games/' || p_game_id::text,
            p_data => jsonb_build_object('game_id', p_game_id, 'group_id', v_game.group_id),
            p_pref_column => NULL);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'promote notify failed for user %: %', v_uid, SQLERRM;
        END;
      END LOOP;

      -- ★ NEW: audit log the promotion batch
      INSERT INTO public.commander_home_audit_log
        (group_id, actor_id, target_type, target_id, action, metadata)
      VALUES (
        v_game.group_id,
        COALESCE(p_caller_user_id,
                 CASE WHEN v_is_trigger_call THEN NULL
                      WHEN v_is_service_role THEN NULL
                      ELSE auth.uid() END),
        'game', p_game_id,
        CASE WHEN v_is_trigger_call THEN 'waitlist.auto_promoted'
             ELSE 'waitlist.promoted' END,
        jsonb_build_object(
          'promoted_count', array_length(v_promoted_ids, 1),
          'promoted_user_ids', v_promoted_ids));
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'promoted_count', COALESCE(array_length(v_promoted_ids, 1), 0),
        'promoted_user_ids', v_promoted_ids);
END;
$function$;

-- ── 3. revive_home_group ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revive_home_group(p_group_id uuid, p_caller_user_id uuid)
 RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE g_owner_id uuid; g_is_active boolean; new_ts timestamptz;
BEGIN
    IF auth.role() <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id) THEN
        RAISE EXCEPTION 'revive_home_group: caller identity mismatch' USING ERRCODE = '42501';
    END IF;
    IF p_group_id IS NULL OR p_caller_user_id IS NULL THEN
        RAISE EXCEPTION 'revive_home_group: both p_group_id and p_caller_user_id are required'
          USING ERRCODE = '22004';
    END IF;
    SELECT owner_id, is_active INTO g_owner_id, g_is_active
      FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'revive_home_group: home group % not found', p_group_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT g_is_active THEN
        RAISE EXCEPTION 'revive_home_group: group is deactivated and cannot be revived by host' USING ERRCODE = '22023';
    END IF;
    IF p_caller_user_id <> g_owner_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members m
                        WHERE m.group_id = p_group_id AND m.user_id = p_caller_user_id
                          AND m.status = 'approved' AND m.role = 'admin') THEN
        RAISE EXCEPTION 'revive_home_group: caller is not authorized for this group' USING ERRCODE = '42501';
    END IF;
    UPDATE commander_home_groups
       SET last_activity_at = NOW(), updated_at = NOW()
     WHERE id = p_group_id
     RETURNING last_activity_at INTO new_ts;

    -- ★ NEW: audit log
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'revived',
            jsonb_build_object('new_last_activity_at', new_ts));

    RETURN new_ts;
END;
$function$;

-- ── 4. set_home_member_private_note ──────────────────────────────
CREATE OR REPLACE FUNCTION public.set_home_member_private_note(
  p_group_id uuid, p_member_user_id uuid, p_note text, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_note IS NOT NULL AND length(p_note) > 1000 THEN RAISE EXCEPTION 'NOTE_TOO_LONG'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id=p_group_id AND user_id=p_caller_user_id
                          AND role='admin' AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    UPDATE commander_home_members SET host_private_note = p_note
     WHERE group_id = p_group_id AND user_id = p_member_user_id;

    -- ★ NEW: audit log (store only presence — not content, for privacy)
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'member', p_member_user_id, 'private_note_set',
            jsonb_build_object('note_present', (p_note IS NOT NULL AND length(p_note) > 0),
                               'note_length',  COALESCE(length(p_note), 0)));

    RETURN jsonb_build_object('success', true);
END;
$function$;

-- ── 5. set_home_member_regular ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_home_member_regular(
  p_group_id uuid, p_member_user_id uuid, p_is_regular boolean, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id=p_group_id AND user_id=p_caller_user_id
                          AND role='admin' AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    UPDATE commander_home_members SET is_regular = p_is_regular
     WHERE group_id = p_group_id AND user_id = p_member_user_id;

    -- ★ NEW: audit log
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'member', p_member_user_id,
            CASE WHEN p_is_regular THEN 'regular_flag_set' ELSE 'regular_flag_unset' END,
            jsonb_build_object('is_regular', p_is_regular));

    RETURN jsonb_build_object('success', true, 'is_regular', p_is_regular);
END;
$function$;

-- ── 6. withdraw_home_group_promotion ─────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_home_group_promotion(
  p_group_id uuid, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF v_group.owner_id <> p_caller_user_id THEN RAISE EXCEPTION 'OWNER_ONLY_ACTION'; END IF;

    UPDATE commander_home_group_promotion_requests
       SET status = 'withdrawn', reviewed_at = NOW()
     WHERE group_id = p_group_id AND status IN ('pending','reviewing');

    UPDATE commander_home_groups SET promotion_requested_at = NULL WHERE id = p_group_id;

    -- ★ NEW: audit log
    INSERT INTO public.commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'promotion_withdrawn',
            '{}'::jsonb);

    RETURN jsonb_build_object('success', true);
END;
$function$;
