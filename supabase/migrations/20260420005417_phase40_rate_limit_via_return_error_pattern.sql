-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420005417 "phase40_rate_limit_via_return_error_pattern"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fc7fbb412eea9f5a65236a35027acf72 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- The rate limiter's INSERT into commander_home_join_attempts was being
-- rolled back when RAISE EXCEPTION fired (PL/pgSQL rolls back the function's
-- entire subtransaction on uncaught exception).
--
-- Fix: rather than RAISE, return {success:false, error:'...'} for the
-- rate-limit-relevant failures (INVITE_CODE_REQUIRED, INVALID_INVITE_CODE,
-- RATE_LIMITED). The function returns normally, so the tracker INSERT
-- commits. Callers already check {success: true/false} in existing code
-- paths (it's the standard success-shape for this RPC). Other failure modes
-- (UNAUTHORIZED, GROUP_NOT_FOUND, etc.) continue to RAISE since those are
-- not rate-limited conditions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.join_home_group(
  p_group_id uuid, p_caller_user_id uuid, p_invite_code text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
SET row_security TO off
AS $function$
DECLARE
    v_group       RECORD;
    v_existing    RECORD;
    v_new_status  text;
    v_new_id      uuid;
    v_failed_attempts int;
    v_code_valid  boolean;
BEGIN
    -- Hard auth failures: still raise (these bypass rate-limit paths)
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        RAISE EXCEPTION 'ALREADY_OWNER';
    END IF;

    -- Rate-limited path for private groups
    IF v_group.is_private THEN
        IF p_invite_code IS NULL THEN
            -- Not a rate-limit-inducing failure (no code attempted)
            RAISE EXCEPTION 'INVITE_CODE_REQUIRED';
        END IF;

        -- Count recent failed attempts for this user
        SELECT COUNT(*) INTO v_failed_attempts
          FROM commander_home_join_attempts
         WHERE user_id = p_caller_user_id
           AND succeeded = false
           AND attempted_at > NOW() - INTERVAL '1 hour';

        IF v_failed_attempts >= 10 THEN
            -- Record the rejection AND return error (not raise) so the
            -- insert persists in the transaction
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RETURN jsonb_build_object(
                'success', false,
                'error', 'RATE_LIMITED',
                'hint', 'Too many failed invite-code attempts. Try again in 1 hour.'
            );
        END IF;

        v_code_valid := (
            p_invite_code = v_group.invite_code OR p_invite_code = v_group.club_code
        );

        IF NOT v_code_valid THEN
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RETURN jsonb_build_object(
                'success', false,
                'error', 'INVALID_INVITE_CODE'
            );
        END IF;
    END IF;

    -- Existing membership check
    SELECT * INTO v_existing
      FROM commander_home_members
     WHERE group_id = p_group_id AND user_id = p_caller_user_id;

    IF FOUND THEN
        CASE v_existing.status
          WHEN 'approved' THEN
            -- Record successful reattempt (idempotent "join")
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, true);
            RETURN jsonb_build_object(
                'success', true, 'already_member', true,
                'status', 'approved', 'role', v_existing.role,
                'member_id', v_existing.id
            );
          WHEN 'pending' THEN
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, true);
            RETURN jsonb_build_object(
                'success', true, 'already_pending', true,
                'status', 'pending', 'member_id', v_existing.id
            );
          WHEN 'banned' THEN
            -- Record as failure (the user can't join)
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RETURN jsonb_build_object(
                'success', false,
                'error', 'BANNED',
                'hint', 'user is banned from this group'
            );
          WHEN 'declined' THEN
            v_new_status := CASE
              WHEN v_group.is_private THEN 'pending'
              WHEN COALESCE(v_group.requires_approval, true) THEN 'pending'
              ELSE 'approved'
            END;
            UPDATE commander_home_members
               SET status = v_new_status,
                   joined_at = CASE WHEN v_new_status='approved' THEN NOW() ELSE joined_at END
             WHERE id = v_existing.id;
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, true);
            RETURN jsonb_build_object(
                'success', true, 're_requested', true,
                'status', v_new_status, 'member_id', v_existing.id
            );
        END CASE;
    END IF;

    v_new_status := CASE
      WHEN v_group.is_private THEN 'approved'
      WHEN COALESCE(v_group.requires_approval, true) THEN 'pending'
      ELSE 'approved'
    END;

    INSERT INTO commander_home_members
        (group_id, user_id, role, status, joined_at, created_at)
    VALUES
        (p_group_id, p_caller_user_id, 'member', v_new_status,
         CASE WHEN v_new_status='approved' THEN NOW() ELSE NULL END,
         NOW())
    RETURNING id INTO v_new_id;

    INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
    VALUES (p_caller_user_id, p_group_id, true);

    RETURN jsonb_build_object(
        'success', true,
        'status', v_new_status,
        'role', 'member',
        'member_id', v_new_id,
        'requires_approval', (v_new_status = 'pending')
    );
END;
$function$;

COMMENT ON FUNCTION public.join_home_group IS
  'Phase 40: rate-limited at 10 failed invite-code attempts per user per '
  'hour. Rate-limit-related failures (INVALID_INVITE_CODE, RATE_LIMITED, '
  'BANNED) return {success:false, error:"..."} instead of raising, so the '
  'tracker insert persists. Hard auth failures (UNAUTHORIZED, GROUP_NOT_FOUND, '
  'GROUP_INACTIVE, ALREADY_OWNER, INVITE_CODE_REQUIRED) still raise.';
