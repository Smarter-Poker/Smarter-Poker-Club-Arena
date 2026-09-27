-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420013204 "phase40_fix_redeem_invite_token_for_private_groups"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2ac670df02c1d2d184c4438a8a4046fe of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — Bug 41: redeem_home_group_invite_token is broken for private
-- groups. It calls join_home_group(group_id, user, NULL) — with NULL invite
-- code — which then raises INVITE_CODE_REQUIRED for any private group.
-- Since invite tokens are specifically designed to onboard people into
-- private groups via shareable URLs, the entire feature is silently broken.
--
-- Fix: do the membership insertion inline after the token validates. The
-- token itself is proof of invitation; callers don't also need the group's
-- invite_code.
--
-- Still honored:
--   - Ban check (banned users cannot rejoin)
--   - Ownership check (owner doesn't need to redeem their own token)
--   - Already-member check
--   - Declined-status recovery
--   - use_count increment only on fresh approval
-- ============================================================================

CREATE OR REPLACE FUNCTION public.redeem_home_group_invite_token(
  p_token text, p_caller_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_token         RECORD;
    v_group         RECORD;
    v_existing      RECORD;
    v_was_new       boolean := true;
    v_already_state text;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    -- Validate token
    SELECT * INTO v_token FROM commander_home_invite_tokens
     WHERE token = p_token AND is_active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_TOKEN'; END IF;
    IF v_token.expires_at IS NOT NULL AND v_token.expires_at < NOW() THEN
        RAISE EXCEPTION 'TOKEN_EXPIRED';
    END IF;
    IF v_token.max_uses IS NOT NULL AND v_token.use_count >= v_token.max_uses THEN
        RAISE EXCEPTION 'TOKEN_EXHAUSTED';
    END IF;

    -- Validate group
    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_token.group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    -- Owner doesn't need to redeem their own token (already a member by definition)
    IF v_group.owner_id = p_caller_user_id THEN
        RETURN jsonb_build_object(
            'success', true,
            'via_token', v_token.id,
            'group_id', v_token.group_id,
            'already_owner', true
        );
    END IF;

    -- Inspect any existing membership row
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
                'already_member', true
            );
        ELSIF v_existing.status = 'pending' THEN
            -- Token fast-tracks pending to approved.
            UPDATE commander_home_members
               SET status = 'approved',
                   approved_at = NOW(),
                   updated_at = NOW()
             WHERE id = v_existing.id;
            v_was_new := true;   -- count this as a fresh approval for use_count
        ELSIF v_existing.status = 'declined' THEN
            -- Token overrides prior decline — re-admits as approved.
            UPDATE commander_home_members
               SET status = 'approved',
                   approved_at = NOW(),
                   updated_at = NOW()
             WHERE id = v_existing.id;
            v_was_new := true;
        ELSE
            -- Unknown prior state; treat conservatively
            v_was_new := false;
            v_already_state := v_existing.status;
        END IF;
    ELSE
        -- Insert fresh approved membership
        INSERT INTO commander_home_members
            (group_id, user_id, role, status, approved_at)
        VALUES
            (v_token.group_id, p_caller_user_id, 'member', 'approved', NOW());
        v_was_new := true;
    END IF;

    -- Increment use_count only for fresh approvals
    IF v_was_new THEN
        UPDATE commander_home_invite_tokens
           SET use_count    = COALESCE(use_count, 0) + 1,
               last_used_at = NOW()
         WHERE id = v_token.id;
    END IF;

    -- Audit
    INSERT INTO commander_home_audit_log
        (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES
        (v_token.group_id, p_caller_user_id, 'member', p_caller_user_id,
         'joined_via_token',
         jsonb_build_object('token_id', v_token.id, 'was_new', v_was_new));

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

COMMENT ON FUNCTION public.redeem_home_group_invite_token IS
  'Phase 40: fixed — no longer routes through join_home_group (which rejects '
  'private groups without an invite_code). A valid unexpired unexhausted token '
  'is itself proof of invitation and auto-approves the caller.';
