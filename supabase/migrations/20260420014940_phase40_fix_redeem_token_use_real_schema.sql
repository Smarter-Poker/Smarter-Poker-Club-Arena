-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420014940 "phase40_fix_redeem_token_use_real_schema"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dcba4c125c616da0b69ca4ec90faa753 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.redeem_home_group_invite_token(
  p_token text, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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
     WHERE token = p_token AND is_active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;
    IF v_token.expires_at IS NOT NULL AND v_token.expires_at < NOW() THEN
        RAISE EXCEPTION 'TOKEN_EXPIRED';
    END IF;
    IF v_token.max_uses IS NOT NULL AND v_token.use_count >= v_token.max_uses THEN
        RAISE EXCEPTION 'TOKEN_EXHAUSTED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_token.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'via_token', v_token.id,
            'group_id', v_token.group_id,
            'already_owner', true
        );
    END IF;

    SELECT * INTO v_existing
      FROM commander_home_members
     WHERE group_id = v_token.group_id AND user_id = p_caller_user_id;

    IF FOUND THEN
        IF v_existing.status = 'banned' THEN
            RAISE EXCEPTION 'BANNED'
                  USING HINT = 'you are banned from this group';
        ELSIF v_existing.status = 'approved' THEN
            RETURN jsonb_build_object(
                'success', true,
                'via_token', v_token.id,
                'group_id', v_token.group_id,
                'already_member', true,
                'member_status', 'approved'
            );
        ELSIF v_existing.status IN ('pending', 'declined') THEN
            -- Token fast-tracks pending or recovers declined → approved
            v_already_state := v_existing.status;
            UPDATE commander_home_members
               SET status = 'approved',
                   joined_at = NOW()
             WHERE id = v_existing.id;
            v_was_new := true;
        ELSE
            v_already_state := v_existing.status;
            v_was_new := false;
        END IF;
    ELSE
        INSERT INTO commander_home_members
            (group_id, user_id, role, status, joined_at, created_at)
        VALUES
            (v_token.group_id, p_caller_user_id, 'member', 'approved', NOW(), NOW());
        v_was_new := true;
    END IF;

    IF v_was_new THEN
        UPDATE commander_home_invite_tokens
           SET use_count    = COALESCE(use_count, 0) + 1,
               last_used_at = NOW()
         WHERE id = v_token.id;
    END IF;

    INSERT INTO commander_home_audit_log
        (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES
        (v_token.group_id, p_caller_user_id, 'member', p_caller_user_id,
         'joined_via_token',
         jsonb_build_object('token_id', v_token.id, 'was_new', v_was_new,
                            'prior_status', v_already_state));

    RETURN jsonb_build_object(
        'success', true,
        'via_token', v_token.id,
        'group_id', v_token.group_id,
        'member_status', 'approved',
        'was_new', v_was_new,
        'prior_status', v_already_state
    );
END;
$function$;
