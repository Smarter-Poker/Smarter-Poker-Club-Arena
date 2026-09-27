-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424011704 "20260421140000_hg_text_length_caps_and_array_limits"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 18dde3c150322f82c305dcac13026de8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commercial-grade defense against oversized user input. Caps are
-- generous vs. normal human usage but tight enough to block payload
-- abuse (giant submitted strings that blow up logs, notifications,
-- or waste storage).
--
--   cancel_home_game.p_reason              → 1000 chars
--   create_home_game_from_template.p_title → 200 chars
--   create_home_game_from_template.p_address → 500 chars
--   fn_home_assign_seat.p_player_name      → 60 chars
--   fn_home_assign_seat.p_note             → 500 chars
--   request_home_group_promotion.p_reason  → 2000 chars
--   resolve_home_content_report.p_moderator_note → 2000 chars
--   review_home_ban_appeal.p_reviewer_note → 2000 chars
--   rsvp_to_home_game.p_message            → 500 chars
--   vote_home_group_poll.p_option_ids[]    → 50 elements

-- ── 1. cancel_home_game ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_home_game(
  p_game_id uuid, p_caller_user_id uuid, p_reason text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_game RECORD; v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF p_reason IS NOT NULL AND length(p_reason) > 1000 THEN
      RAISE EXCEPTION 'REASON_TOO_LONG' USING HINT = 'max 1000 chars';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status IN ('completed','cancelled') THEN
        RAISE EXCEPTION 'GAME_ALREADY_FINAL' USING HINT = 'status is ' || v_game.status;
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_game.host_id <> p_caller_user_id
       AND v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND role = 'admin' AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_AUTHORIZED_TO_CANCEL'; END IF;

    UPDATE commander_home_games
       SET status='cancelled', cancelled_at=NOW(), cancelled_by=p_caller_user_id,
           cancellation_reason=p_reason, updated_at=NOW()
     WHERE id = p_game_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_game.group_id, p_caller_user_id, 'game', p_game_id, 'cancelled',
            jsonb_build_object('reason', p_reason, 'scheduled_date', v_game.scheduled_date));

    RETURN jsonb_build_object(
        'success', true, 'game_id', p_game_id, 'new_status', 'cancelled',
        'rsvps_to_notify', (SELECT COUNT(*) FROM commander_home_rsvps
                             WHERE game_id = p_game_id AND response IN ('yes','maybe','waitlist'))
    );
END;
$function$;

-- ── 2. create_home_game_from_template ────────────────────────────
CREATE OR REPLACE FUNCTION public.create_home_game_from_template(
  p_template_id uuid, p_scheduled_date date, p_caller_user_id uuid,
  p_title text DEFAULT NULL::text, p_address text DEFAULT NULL::text,
  p_address_visible_to text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_template RECORD; v_group RECORD; v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_scheduled_date <= CURRENT_DATE THEN
      RAISE EXCEPTION 'DATE_MUST_BE_FUTURE'; END IF;
    IF p_title IS NOT NULL AND length(p_title) > 200 THEN
      RAISE EXCEPTION 'TITLE_TOO_LONG' USING HINT = 'max 200 chars'; END IF;
    IF p_address IS NOT NULL AND length(p_address) > 500 THEN
      RAISE EXCEPTION 'ADDRESS_TOO_LONG' USING HINT = 'max 500 chars'; END IF;

    SELECT * INTO v_template FROM commander_home_game_templates WHERE id = p_template_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_template.group_id;
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_template.group_id AND user_id = p_caller_user_id
                          AND role IN ('admin','owner') AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    IF EXISTS (SELECT 1 FROM commander_home_games
                WHERE group_id = v_template.group_id AND scheduled_date = p_scheduled_date
                  AND status NOT IN ('cancelled'))
    THEN RAISE EXCEPTION 'DATE_ALREADY_SCHEDULED'; END IF;

    INSERT INTO commander_home_games (
        group_id, host_id, title, description,
        game_type, stakes, format, buyin_min, buyin_max,
        scheduled_date, start_time, address, address_visible_to,
        max_players, min_players, allow_guests, guest_limit,
        food_drinks, special_rules, status
    ) VALUES (
        v_template.group_id, p_caller_user_id,
        COALESCE(p_title, v_template.name), v_template.description,
        v_template.game_type, v_template.stakes, v_template.format,
        v_template.buyin_min, v_template.buyin_max,
        p_scheduled_date, v_template.default_start_time,
        p_address,
        COALESCE(p_address_visible_to,
                 CASE WHEN v_group.is_private THEN 'approved' ELSE 'rsvp' END),
        v_template.max_players, v_template.min_players,
        v_template.allow_guests, v_template.guest_limit,
        v_template.food_drinks, v_template.special_rules, 'scheduled'
    ) RETURNING id INTO v_new_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_template.group_id, p_caller_user_id, 'game', v_new_id, 'from_template',
            jsonb_build_object('template_id', p_template_id, 'date', p_scheduled_date));

    RETURN jsonb_build_object('success', true, 'game_id', v_new_id);
END;
$function$;

-- ── 3. fn_home_assign_seat ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_home_assign_seat(
  p_caller uuid, p_game_id uuid, p_seat_number integer,
  p_user_id uuid DEFAULT NULL::uuid,
  p_player_name text DEFAULT NULL::text,
  p_note text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_exists boolean;
BEGIN
    IF auth.role() <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller) THEN
        RETURN jsonb_build_object('success', false, 'error', 'unauthorized: caller identity mismatch');
    END IF;
    IF NOT fn_home_caller_is_game_staff(p_caller, p_game_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'not authorized');
    END IF;
    IF p_seat_number IS NULL OR p_seat_number < 1 OR p_seat_number > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'seat_number must be 1..12');
    END IF;
    IF p_user_id IS NULL AND (p_player_name IS NULL OR LENGTH(TRIM(p_player_name)) = 0) THEN
        RETURN jsonb_build_object('success', false, 'error', 'either user_id or player_name required');
    END IF;
    IF p_player_name IS NOT NULL AND LENGTH(p_player_name) > 60 THEN
        RETURN jsonb_build_object('success', false, 'error', 'player_name too long (max 60)');
    END IF;
    IF p_note IS NOT NULL AND LENGTH(p_note) > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'note too long (max 500)');
    END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_seats
                    WHERE game_id = p_game_id AND seat_number = p_seat_number) INTO v_exists;
    IF NOT v_exists THEN
        INSERT INTO commander_home_seats (game_id, seat_number) VALUES (p_game_id, p_seat_number);
    END IF;

    IF p_user_id IS NOT NULL THEN
        UPDATE commander_home_seats
           SET user_id = NULL, player_name = NULL, status = 'empty',
               seated_at = NULL, away_since = NULL, note = NULL, updated_at = NOW()
         WHERE game_id = p_game_id AND user_id = p_user_id AND seat_number <> p_seat_number;
    END IF;

    UPDATE commander_home_seats
       SET user_id = p_user_id, player_name = p_player_name, status = 'seated',
           seated_at = COALESCE(seated_at, NOW()), away_since = NULL,
           note = p_note, updated_at = NOW()
     WHERE game_id = p_game_id AND seat_number = p_seat_number;

    RETURN jsonb_build_object('success', true, 'game_id', p_game_id, 'seat_number', p_seat_number);
END;
$function$;

-- ── 4. request_home_group_promotion ──────────────────────────────
CREATE OR REPLACE FUNCTION public.request_home_group_promotion(
  p_group_id uuid, p_caller_user_id uuid, p_reason text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_group RECORD; v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_reason IS NOT NULL AND length(p_reason) > 2000 THEN
      RAISE EXCEPTION 'REASON_TOO_LONG' USING HINT = 'max 2000 chars'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF v_group.owner_id <> p_caller_user_id THEN RAISE EXCEPTION 'OWNER_ONLY_ACTION'; END IF;
    IF v_group.promoted_to_club_id IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_PROMOTED'; END IF;

    IF COALESCE(v_group.games_hosted, 0) < 3 THEN
        RAISE EXCEPTION 'NEED_MIN_GAMES' USING HINT='requires at least 3 completed games';
    END IF;
    IF COALESCE(v_group.member_count, 0) < 5 THEN
        RAISE EXCEPTION 'NEED_MIN_MEMBERS' USING HINT='requires at least 5 members';
    END IF;

    INSERT INTO commander_home_group_promotion_requests (group_id, requested_by, reason)
    VALUES (p_group_id, p_caller_user_id, p_reason)
    ON CONFLICT (group_id) DO UPDATE
        SET status = 'pending', reason = EXCLUDED.reason,
            requested_at = NOW(), reviewer_id = NULL, reviewer_note = NULL
    RETURNING id INTO v_new_id;

    UPDATE commander_home_groups SET promotion_requested_at = NOW() WHERE id = p_group_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'promotion_requested',
            jsonb_build_object('reason', p_reason));

    RETURN jsonb_build_object('success', true, 'request_id', v_new_id, 'status', 'pending');
END;
$function$;

-- ── 5. resolve_home_content_report (add p_moderator_note cap) ────
-- Full rewrite unchanged except length check at top
CREATE OR REPLACE FUNCTION public.resolve_home_content_report(
  p_report_id uuid, p_action text, p_moderator_note text, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_role text; v_report RECORD; v_group_id uuid; v_notice text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_moderator_note IS NOT NULL AND length(p_moderator_note) > 2000 THEN
    RAISE EXCEPTION 'MODERATOR_NOTE_TOO_LONG' USING HINT = 'max 2000 chars';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = p_caller_user_id;
  IF v_role NOT IN ('admin','superadmin','god') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_action NOT IN ('dismiss','hide_content','delete_content','warn_author','strike_author','ban_author') THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;

  SELECT * INTO v_report FROM public.commander_home_content_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_NOT_FOUND'; END IF;
  IF v_report.status IN ('reviewed','actioned','dismissed') THEN
    RAISE EXCEPTION 'REPORT_ALREADY_RESOLVED' USING HINT = 'status is ' || v_report.status;
  END IF;

  CASE v_report.reported_type
    WHEN 'post' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_posts WHERE id = v_report.reported_id;
    WHEN 'comment' THEN
      SELECT p.group_id INTO v_group_id FROM public.commander_home_post_comments c
        JOIN public.commander_home_posts p ON p.id = c.post_id WHERE c.id = v_report.reported_id;
    WHEN 'review' THEN
      SELECT g.group_id INTO v_group_id FROM public.commander_home_game_reviews r
        JOIN public.commander_home_games g ON g.id = r.game_id WHERE r.id = v_report.reported_id;
    WHEN 'game' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_games WHERE id = v_report.reported_id;
    WHEN 'group' THEN v_group_id := v_report.reported_id;
    WHEN 'member' THEN
      SELECT group_id INTO v_group_id FROM public.commander_home_members WHERE id = v_report.reported_id;
  END CASE;

  IF p_action = 'dismiss' THEN v_notice := NULL;
  ELSIF p_action = 'hide_content' THEN
    CASE v_report.reported_type
      WHEN 'post' THEN UPDATE public.commander_home_posts
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'comment' THEN UPDATE public.commander_home_post_comments
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'review' THEN UPDATE public.commander_home_game_reviews
           SET is_hidden=true, hidden_at=now(), hidden_by=p_caller_user_id,
               hidden_reason = COALESCE(p_moderator_note, 'policy_violation')
         WHERE id = v_report.reported_id;
      WHEN 'game' THEN UPDATE public.commander_home_games
           SET status='cancelled', cancelled_at=now(), cancelled_by=p_caller_user_id,
               cancellation_reason = COALESCE(p_moderator_note, 'moderation_action')
         WHERE id = v_report.reported_id AND status NOT IN ('completed','cancelled');
      WHEN 'group' THEN UPDATE public.commander_home_groups SET is_active=false WHERE id = v_report.reported_id;
      ELSE NULL;
    END CASE;
    v_notice := 'Your ' || v_report.reported_type || ' was hidden for violating community policy.';
  ELSIF p_action = 'delete_content' THEN
    CASE v_report.reported_type
      WHEN 'post'    THEN DELETE FROM public.commander_home_posts         WHERE id = v_report.reported_id;
      WHEN 'comment' THEN DELETE FROM public.commander_home_post_comments WHERE id = v_report.reported_id;
      WHEN 'review'  THEN DELETE FROM public.commander_home_game_reviews  WHERE id = v_report.reported_id;
      WHEN 'game'    THEN UPDATE public.commander_home_games
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
         SET flake_strikes = COALESCE(flake_strikes, 0) + 1, last_strike_at = now()
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
     SET status = CASE WHEN p_action='dismiss' THEN 'dismissed' ELSE 'actioned' END,
         reviewed_by = p_caller_user_id, reviewed_at = now(),
         moderator_note = p_moderator_note, action_taken = p_action,
         content_hidden_at = CASE WHEN p_action IN ('hide_content','delete_content') THEN now()
                                  ELSE content_hidden_at END
   WHERE id = p_report_id;

  IF v_notice IS NOT NULL AND v_report.content_author_id IS NOT NULL THEN
    PERFORM public.fn_emit_home_notification(
      p_user_id => v_report.content_author_id, p_type => 'moderation_action',
      p_title => 'Moderation action', p_message => v_notice, p_link => NULL,
      p_data => jsonb_build_object('report_id', p_report_id,
                                   'reported_type', v_report.reported_type,
                                   'action', p_action),
      p_pref_column => NULL);
  END IF;

  IF v_group_id IS NOT NULL THEN
    INSERT INTO public.commander_home_audit_log(group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_group_id, p_caller_user_id, v_report.reported_type, v_report.reported_id,
            'moderation.' || p_action,
            jsonb_build_object('report_id', p_report_id, 'note', p_moderator_note));
  END IF;

  RETURN jsonb_build_object('success', true, 'report_id', p_report_id,
    'action', p_action, 'group_id_resolved', v_group_id IS NOT NULL);
END;
$function$;

-- ── 6. review_home_ban_appeal (add p_reviewer_note cap) ──────────
CREATE OR REPLACE FUNCTION public.review_home_ban_appeal(
  p_appeal_id uuid, p_decision text, p_reviewer_note text, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_appeal RECORD; v_is_staff boolean;
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
  ) INTO v_is_staff;
  IF NOT v_is_staff THEN
    RAISE EXCEPTION 'FORBIDDEN' USING HINT = 'only group owner/admin can review appeals';
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
          jsonb_build_object('appeal_id', p_appeal_id, 'note', p_reviewer_note));

  RETURN jsonb_build_object('success', true, 'appeal_id', p_appeal_id, 'decision', p_decision);
END;
$function$;

-- ── 7. rsvp_to_home_game (add p_message cap) ─────────────────────
CREATE OR REPLACE FUNCTION public.rsvp_to_home_game(
  p_game_id uuid, p_response text, p_caller_user_id uuid,
  p_bringing_guests integer DEFAULT 0, p_message text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game RECORD; v_group RECORD; v_host_profile RECORD;
    v_is_member boolean := false; v_is_banned boolean := false;
    v_rsvp_id uuid; v_updated_game RECORD;
    v_game_start_ts timestamptz; v_effective_tz text;
    v_dm_result jsonb; v_conv_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED'
              USING HINT = 'rsvp_to_home_game requires auth.uid() = p_caller_user_id';
    END IF;
    IF p_response NOT IN ('yes','maybe','no','waitlist') THEN
        RAISE EXCEPTION 'INVALID_RESPONSE'
              USING HINT = 'response must be one of: yes, maybe, no, waitlist';
    END IF;
    IF p_message IS NOT NULL AND length(p_message) > 500 THEN
        RAISE EXCEPTION 'MESSAGE_TOO_LONG' USING HINT = 'max 500 chars';
    END IF;
    IF p_bringing_guests IS NULL OR p_bringing_guests < 0 THEN p_bringing_guests := 0; END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status = 'cancelled' THEN
      RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP' USING HINT = 'game status is cancelled';
    END IF;
    IF v_game.status NOT IN ('scheduled','confirmed','in_progress','completed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN_FOR_RSVP'
              USING HINT = 'game status is ' || COALESCE(v_game.status,'NULL');
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_members
       WHERE group_id = v_game.group_id AND user_id = p_caller_user_id AND status = 'banned')
     INTO v_is_banned;
    IF v_is_banned THEN RAISE EXCEPTION 'BANNED'; END IF;

    SELECT EXISTS (SELECT 1 FROM commander_home_groups
         WHERE id = v_game.group_id AND owner_id = p_caller_user_id)
    OR EXISTS (SELECT 1 FROM commander_home_members
         WHERE group_id = v_game.group_id AND user_id = p_caller_user_id AND status = 'approved')
     INTO v_is_member;

    IF v_group.is_private AND NOT v_is_member THEN
        RAISE EXCEPTION 'NOT_A_MEMBER'
              USING HINT = 'private group RSVP requires approved membership';
    END IF;

    v_effective_tz := COALESCE(
                        NULLIF(v_game.timezone, ''),
                        NULLIF(v_group.timezone, ''),
                        'America/New_York');
    v_game_start_ts := (v_game.scheduled_date + v_game.start_time) AT TIME ZONE v_effective_tz;

    IF v_game.status = 'completed' OR v_game.status = 'in_progress'
       OR v_game_start_ts <= NOW()
    THEN
        IF p_caller_user_id = v_game.host_id THEN
            RAISE EXCEPTION 'HOST_CANNOT_RSVP_TO_OWN_GAME';
        END IF;
        v_dm_result := public.fn_get_or_create_conversation(
            p_caller_user_id, v_game.host_id, 'direct');
        IF COALESCE((v_dm_result->>'success')::boolean, false) THEN
            v_conv_id := (v_dm_result->>'conversation_id')::uuid;
        ELSE v_conv_id := NULL; END IF;

        SELECT p.id, p.username, p.display_name, p.full_name, p.avatar_url
          INTO v_host_profile FROM profiles p WHERE p.id = v_game.host_id;

        RETURN jsonb_build_object(
            'success', false, 'error', 'GAME_STARTED',
            'message', 'This game has already started. Message the host directly.',
            'game', jsonb_build_object(
                'id', v_game.id, 'scheduled_date', v_game.scheduled_date,
                'start_time', v_game.start_time, 'timezone', v_effective_tz,
                'status', v_game.status),
            'host', jsonb_build_object(
                'id', v_host_profile.id, 'username', v_host_profile.username,
                'display_name', COALESCE(v_host_profile.display_name,
                                         v_host_profile.full_name, v_host_profile.username),
                'avatar_url', v_host_profile.avatar_url),
            'conversation_id', v_conv_id,
            'dm_url', CASE WHEN v_conv_id IS NOT NULL
                           THEN '/hub/messenger/' || v_conv_id::text
                           ELSE NULL END);
    END IF;

    IF NOT v_game.allow_guests AND p_bringing_guests > 0 THEN
        RAISE EXCEPTION 'GUESTS_NOT_ALLOWED';
    END IF;
    IF v_game.allow_guests AND v_game.guest_limit IS NOT NULL
       AND p_bringing_guests > v_game.guest_limit THEN
        RAISE EXCEPTION 'GUEST_LIMIT_EXCEEDED'
              USING HINT = 'maximum ' || v_game.guest_limit || ' guests per player';
    END IF;

    INSERT INTO commander_home_rsvps AS r
        (game_id, user_id, response, bringing_guests, message, responded_at, updated_at)
    VALUES
        (p_game_id, p_caller_user_id, p_response, p_bringing_guests, p_message, NOW(), NOW())
    ON CONFLICT (game_id, user_id) DO UPDATE
        SET response=EXCLUDED.response, bringing_guests=EXCLUDED.bringing_guests,
            message=EXCLUDED.message, updated_at=NOW()
    RETURNING id INTO v_rsvp_id;

    SELECT id, rsvp_yes, rsvp_maybe, rsvp_no, waitlist_count INTO v_updated_game
      FROM commander_home_games WHERE id = p_game_id;

    RETURN jsonb_build_object(
        'success', true, 'rsvp_id', v_rsvp_id, 'game_id', p_game_id, 'response', p_response,
        'counts', jsonb_build_object('yes', v_updated_game.rsvp_yes,
            'maybe', v_updated_game.rsvp_maybe, 'no', v_updated_game.rsvp_no,
            'waitlist', v_updated_game.waitlist_count));
END;
$function$;

-- ── 8. vote_home_group_poll (cap p_option_ids array count) ───────
CREATE OR REPLACE FUNCTION public.vote_home_group_poll(
  p_poll_id uuid, p_caller_user_id uuid, p_option_ids text[]
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_poll RECORD; v_group RECORD;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF array_length(p_option_ids, 1) IS NULL OR array_length(p_option_ids, 1) = 0 THEN
        RAISE EXCEPTION 'NO_OPTIONS_SELECTED';
    END IF;
    IF array_length(p_option_ids, 1) > 50 THEN
        RAISE EXCEPTION 'TOO_MANY_OPTIONS' USING HINT = 'max 50 options per vote';
    END IF;

    SELECT * INTO v_poll FROM commander_home_polls WHERE id = p_poll_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'POLL_NOT_FOUND'; END IF;
    IF v_poll.is_closed OR (v_poll.closes_at IS NOT NULL AND v_poll.closes_at < NOW()) THEN
        RAISE EXCEPTION 'POLL_CLOSED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_poll.group_id;

    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_poll.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

    IF v_poll.poll_type = 'single_choice' AND array_length(p_option_ids, 1) > 1 THEN
        RAISE EXCEPTION 'SINGLE_CHOICE_ONE_ALLOWED';
    END IF;

    INSERT INTO commander_home_poll_votes (poll_id, user_id, option_ids)
    VALUES (p_poll_id, p_caller_user_id, p_option_ids)
    ON CONFLICT (poll_id, user_id) DO UPDATE
        SET option_ids = EXCLUDED.option_ids, updated_at = NOW();

    RETURN jsonb_build_object('success', true, 'poll_id', p_poll_id);
END;
$function$;

-- ── 9. create_home_group_invite_token (add p_label cap) ──────────
CREATE OR REPLACE FUNCTION public.create_home_group_invite_token(
  p_group_id uuid, p_caller_user_id uuid,
  p_max_uses integer DEFAULT NULL::integer,
  p_expires_at timestamptz DEFAULT NULL::timestamptz,
  p_label text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_group RECORD; v_is_host boolean; v_token text; v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_invite_token_create', 20, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED' USING HINT = 'invite tokens: 20 per 60 min.';
    END IF;

    IF p_label IS NOT NULL AND length(p_label) > 100 THEN
      RAISE EXCEPTION 'LABEL_TOO_LONG' USING HINT = 'max 100 chars';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    v_is_host := (v_group.owner_id = p_caller_user_id)
              OR EXISTS (SELECT 1 FROM commander_home_members
                          WHERE group_id = p_group_id AND user_id = p_caller_user_id
                            AND role = 'admin' AND status = 'approved');
    IF NOT v_is_host THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    LOOP
        v_token := upper(substr(translate(encode(gen_random_bytes(10), 'base64'), '+/=0O1IL', ''), 1, 12));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM commander_home_invite_tokens WHERE token = v_token);
    END LOOP;

    INSERT INTO commander_home_invite_tokens
        (group_id, created_by, token, max_uses, expires_at, label)
    VALUES
        (p_group_id, p_caller_user_id, v_token, p_max_uses, p_expires_at, p_label)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true, 'token_id', v_new_id, 'token', v_token,
        'share_url_hint', '/hub/home-games/join/' || v_token);
END;
$function$;

-- ── 10. record_home_game_photo (add p_caption cap) ───────────────
CREATE OR REPLACE FUNCTION public.record_home_game_photo(
  p_game_id uuid, p_caller_user_id uuid, p_photo_url text, p_caption text DEFAULT NULL::text
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_game RECORD; v_group RECORD; v_new_id uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;
    IF NOT public.fn_try_consume_home_rate_limit(
         p_caller_user_id, 'home_game_photo_upload', 40, 60) THEN
      RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED' USING HINT = 'photo uploads: 40 per 60 min.';
    END IF;
    IF p_photo_url IS NULL OR length(trim(p_photo_url)) = 0 THEN
        RAISE EXCEPTION 'MISSING_URL';
    END IF;
    IF p_caption IS NOT NULL AND length(p_caption) > 500 THEN
        RAISE EXCEPTION 'CAPTION_TOO_LONG' USING HINT = 'max 500 chars';
    END IF;

    SELECT * INTO v_game FROM commander_home_games WHERE id = p_game_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;

    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                          AND status = 'approved')
    THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

    INSERT INTO commander_home_game_photos (game_id, uploader_id, photo_url, caption)
    VALUES (p_game_id, p_caller_user_id, p_photo_url, p_caption)
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'photo_id', v_new_id);
END;
$function$;
