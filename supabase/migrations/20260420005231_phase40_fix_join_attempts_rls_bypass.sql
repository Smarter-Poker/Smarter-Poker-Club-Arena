-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420005231 "phase40_fix_join_attempts_rls_bypass"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0903a5f3d597fc70d44037d0fdc42ae8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix: SECURITY DEFINER function needs explicit RLS bypass to write to the
-- tracker table. Since commander_home_join_attempts has RLS on with no
-- policies, the function's INSERT was silently rejected, defeating the
-- rate limiter.

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
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN
        RAISE EXCEPTION 'UNAUTHORIZED';
    END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = p_group_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
    IF NOT v_group.is_active THEN RAISE EXCEPTION 'GROUP_INACTIVE'; END IF;

    IF v_group.owner_id = p_caller_user_id THEN
        RAISE EXCEPTION 'ALREADY_OWNER';
    END IF;

    IF v_group.is_private THEN
        IF p_invite_code IS NULL THEN
            RAISE EXCEPTION 'INVITE_CODE_REQUIRED';
        END IF;

        SELECT COUNT(*) INTO v_failed_attempts
          FROM commander_home_join_attempts
         WHERE user_id = p_caller_user_id
           AND succeeded = false
           AND attempted_at > NOW() - INTERVAL '1 hour';

        IF v_failed_attempts >= 10 THEN
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RAISE EXCEPTION 'RATE_LIMITED'
              USING HINT = 'Too many failed invite-code attempts. Try again in 1 hour.';
        END IF;

        v_code_valid := (
            p_invite_code = v_group.invite_code OR p_invite_code = v_group.club_code
        );

        IF NOT v_code_valid THEN
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RAISE EXCEPTION 'INVALID_INVITE_CODE';
        END IF;
    END IF;

    SELECT * INTO v_existing
      FROM commander_home_members
     WHERE group_id = p_group_id AND user_id = p_caller_user_id;

    IF FOUND THEN
        CASE v_existing.status
          WHEN 'approved' THEN
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
            INSERT INTO commander_home_join_attempts(user_id, group_id, succeeded)
            VALUES (p_caller_user_id, p_group_id, false);
            RAISE EXCEPTION 'BANNED'
                  USING HINT = 'user is banned from this group';
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
