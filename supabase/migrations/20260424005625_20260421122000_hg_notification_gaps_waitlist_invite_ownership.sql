-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424005625 "20260421122000_hg_notification_gaps_waitlist_invite_ownership"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 77c2e5f5719219eec313ae94bbf1e3cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Notification coverage gaps filled:
--   • promote_home_game_waitlist → notify each promoted user
--   • redeem_home_group_invite_token → notify token creator
--   • transfer_home_group_ownership → notify new owner
--
-- Each emit is wrapped in its own exception block so a notification
-- failure never rolls back the state change.

-- ── 1. promote_home_game_waitlist — notify promoted users ────────
CREATE OR REPLACE FUNCTION public.promote_home_game_waitlist(
  p_game_id uuid, p_caller_user_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game            RECORD;
    v_group           RECORD;
    v_seats_open      int;
    v_promoted_ids    uuid[] := ARRAY[]::uuid[];
    v_rsvp            RECORD;
    v_is_trigger_call boolean;
    v_is_service_role boolean;
    v_uid             uuid;
BEGIN
    v_is_trigger_call := (current_setting('app.hg_waitlist_auto_promote', true) = '1');
    v_is_service_role := (auth.role() = 'service_role');

    IF v_is_trigger_call OR v_is_service_role THEN
        NULL;
    ELSE
        IF p_caller_user_id IS NULL THEN
            RAISE EXCEPTION 'UNAUTHORIZED'
                  USING HINT = 'promote_home_game_waitlist requires p_caller_user_id';
        END IF;
        IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
            RAISE EXCEPTION 'UNAUTHORIZED'
                  USING HINT = 'auth.uid() must match p_caller_user_id';
        END IF;
    END IF;

    SELECT * INTO v_game
      FROM commander_home_games
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN';
    END IF;

    IF NOT v_is_trigger_call AND NOT v_is_service_role THEN
        SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
        IF v_game.host_id <> p_caller_user_id
           AND v_group.owner_id <> p_caller_user_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members
                            WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                              AND role = 'admin' AND status = 'approved')
        THEN
            RAISE EXCEPTION 'NOT_AUTHORIZED';
        END IF;
    END IF;

    v_seats_open := GREATEST(0,
        COALESCE(v_game.max_players, 9) - COALESCE(v_game.rsvp_yes, 0));
    IF v_seats_open = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'promoted_count', 0,
            'seats_full', true
        );
    END IF;

    FOR v_rsvp IN
        SELECT id, user_id FROM commander_home_rsvps
         WHERE game_id = p_game_id
           AND response = 'waitlist'
         ORDER BY responded_at
         LIMIT v_seats_open
         FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE commander_home_rsvps
           SET response   = 'yes',
               updated_at = NOW()
         WHERE id = v_rsvp.id;
        v_promoted_ids := array_append(v_promoted_ids, v_rsvp.user_id);
    END LOOP;

    -- ★ NEW: notify every promoted user that they're off the waitlist
    IF array_length(v_promoted_ids, 1) > 0 THEN
      FOREACH v_uid IN ARRAY v_promoted_ids LOOP
        BEGIN
          PERFORM public.fn_emit_home_notification(
            p_user_id     => v_uid,
            p_type        => 'home_game_waitlist_promoted',
            p_title       => 'You''re off the waitlist!',
            p_message     => 'A seat opened up and you''re in for the game.',
            p_link        => '/hub/home-games/' || p_game_id::text,
            p_data        => jsonb_build_object(
                               'game_id',  p_game_id,
                               'group_id', v_game.group_id),
            p_pref_column => NULL
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'promote notify failed for user %: %', v_uid, SQLERRM;
        END;
      END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'promoted_count', COALESCE(array_length(v_promoted_ids, 1), 0),
        'promoted_user_ids', v_promoted_ids
    );
END;
$function$;

-- ── 2. redeem_home_group_invite_token — notify token creator ────
CREATE OR REPLACE FUNCTION public.redeem_home_group_invite_token(
  p_token text, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET row_security TO 'off'
AS $function$
DECLARE
    v_token         RECORD;
    v_group         RECORD;
    v_existing      RECORD;
    v_was_new       boolean := false;
    v_already_state text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_token FROM commander_home_invite_tokens
     WHERE token = p_token AND is_active = true
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;
    IF v_token.expires_at IS NOT NULL AND v_token.expires_at < NOW() THEN
        RAISE EXCEPTION 'TOKEN_EXPIRED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_token.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        RETURN jsonb_build_object(
            'success', true, 'via_token', v_token.id,
            'group_id', v_token.group_id, 'already_owner', true
        );
    END IF;

    SELECT * INTO v_existing
      FROM commander_home_members
     WHERE group_id = v_token.group_id AND user_id = p_caller_user_id;

    IF FOUND THEN
        IF v_existing.status = 'banned' THEN
            RAISE EXCEPTION 'BANNED' USING HINT = 'you are banned from this group';
        ELSIF v_existing.status = 'approved' THEN
            RETURN jsonb_build_object(
                'success', true, 'via_token', v_token.id,
                'group_id', v_token.group_id,
                'already_member', true, 'member_status', 'approved'
            );
        ELSIF v_existing.status IN ('pending', 'declined') THEN
            IF v_token.max_uses IS NOT NULL
               AND COALESCE(v_token.use_count, 0) >= v_token.max_uses THEN
                RAISE EXCEPTION 'TOKEN_EXHAUSTED';
            END IF;
            v_already_state := v_existing.status;
            PERFORM set_config('app.hg_token_redeem_allowed', '1', true);
            UPDATE commander_home_members
               SET status = 'approved', joined_at = NOW()
             WHERE id = v_existing.id;
            PERFORM set_config('app.hg_token_redeem_allowed', '', true);
            v_was_new := true;
        ELSE
            v_already_state := v_existing.status;
            v_was_new := false;
        END IF;
    ELSE
        IF v_token.max_uses IS NOT NULL
           AND COALESCE(v_token.use_count, 0) >= v_token.max_uses THEN
            RAISE EXCEPTION 'TOKEN_EXHAUSTED';
        END IF;
        PERFORM set_config('app.hg_token_redeem_allowed', '1', true);
        INSERT INTO commander_home_members
            (group_id, user_id, role, status, joined_at, created_at)
        VALUES
            (v_token.group_id, p_caller_user_id, 'member', 'approved', NOW(), NOW());
        PERFORM set_config('app.hg_token_redeem_allowed', '', true);
        v_was_new := true;
    END IF;

    IF v_was_new THEN
        UPDATE commander_home_invite_tokens
           SET use_count    = COALESCE(use_count, 0) + 1,
               last_used_at = NOW()
         WHERE id = v_token.id;

        -- ★ NEW: notify the token creator (if not themselves redeeming)
        IF v_token.created_by IS NOT NULL
           AND v_token.created_by <> p_caller_user_id THEN
            BEGIN
              PERFORM public.fn_emit_home_notification(
                p_user_id     => v_token.created_by,
                p_type        => 'home_invite_redeemed',
                p_title       => 'Your invite was used',
                p_message     => 'Someone joined ' ||
                                 COALESCE(v_group.name, 'your group') ||
                                 ' with your invite link.',
                p_link        => '/hub/home-games/group/' || v_group.id::text,
                p_data        => jsonb_build_object(
                                   'group_id', v_group.id,
                                   'token_id', v_token.id,
                                   'token_label', v_token.label,
                                   'redeemed_by', p_caller_user_id),
                p_pref_column => NULL
              );
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'redeem notify failed: %', SQLERRM;
            END;
        END IF;
    END IF;

    INSERT INTO commander_home_audit_log
        (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES
        (v_token.group_id, p_caller_user_id, 'member', p_caller_user_id,
         'joined_via_token',
         jsonb_build_object('token_id', v_token.id, 'was_new', v_was_new,
                            'prior_status', v_already_state));

    RETURN jsonb_build_object(
        'success', true, 'via_token', v_token.id,
        'group_id', v_token.group_id, 'member_status', 'approved',
        'was_new', v_was_new, 'prior_status', v_already_state
    );
END;
$function$;

-- ── 3. transfer_home_group_ownership — notify new owner ────────
CREATE OR REPLACE FUNCTION public.transfer_home_group_ownership(
  p_group_id uuid, p_new_owner_user_id uuid, p_caller_user_id uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_group          RECORD;
    v_target_member  RECORD;
    v_old_owner      uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;

    IF v_group.owner_id <> p_caller_user_id THEN
        RAISE EXCEPTION 'OWNER_ONLY_ACTION';
    END IF;
    IF v_group.owner_id = p_new_owner_user_id THEN
        RAISE EXCEPTION 'ALREADY_OWNER';
    END IF;

    SELECT * INTO v_target_member
      FROM commander_home_members
     WHERE group_id = p_group_id AND user_id = p_new_owner_user_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_NOT_MEMBER'; END IF;
    IF v_target_member.status <> 'approved' THEN RAISE EXCEPTION 'TARGET_NOT_APPROVED'; END IF;
    IF v_target_member.role <> 'admin' THEN
        RAISE EXCEPTION 'TARGET_NOT_ADMIN'
              USING HINT = 'promote to admin first, then transfer';
    END IF;

    v_old_owner := v_group.owner_id;

    UPDATE commander_home_groups
       SET owner_id = p_new_owner_user_id, updated_at = NOW()
     WHERE id = p_group_id;

    UPDATE commander_home_members
       SET role = 'admin'
     WHERE group_id = p_group_id AND user_id = v_old_owner;

    UPDATE commander_home_members
       SET role = 'owner'
     WHERE group_id = p_group_id AND user_id = p_new_owner_user_id;

    INSERT INTO commander_home_audit_log
      (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (p_group_id, p_caller_user_id, 'group', p_group_id, 'ownership_transferred',
            jsonb_build_object('from_user', v_old_owner, 'to_user', p_new_owner_user_id));

    -- ★ NEW: notify the new owner
    BEGIN
      PERFORM public.fn_emit_home_notification(
        p_user_id     => p_new_owner_user_id,
        p_type        => 'home_group_ownership_transferred',
        p_title       => 'You''re the new owner',
        p_message     => 'Ownership of ' || COALESCE(v_group.name, 'a group') ||
                         ' was transferred to you.',
        p_link        => '/hub/home-games/group/' || p_group_id::text,
        p_data        => jsonb_build_object(
                           'group_id',        p_group_id,
                           'previous_owner',  v_old_owner),
        p_pref_column => NULL
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ownership-transfer notify failed: %', SQLERRM;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'group_id', p_group_id,
        'previous_owner', v_old_owner,
        'new_owner', p_new_owner_user_id
    );
END;
$function$;
