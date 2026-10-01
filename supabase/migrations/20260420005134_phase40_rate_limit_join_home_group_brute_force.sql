-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420005134 "phase40_rate_limit_join_home_group_brute_force"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bfac97ce24cee7d52bb131f2bf60e00c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — brute-force vulnerability on private-group invite codes.
--
-- Bug: join_home_group validates invite_code/club_code against the stored
-- values, but there's no rate limit on attempts. club_codes in production
-- are 6 base58-like chars (~38B combinations) which is fine, but the
-- 2 test groups have legacy short codes (HG-9834, 4 digits = 10K combos).
-- Either way, an attacker with any group's UUID can attempt codes in an
-- infinite loop and gain APPROVED private-group membership on success.
--
-- Fix:
-- 1. Create tracking table for join attempts (both success and failure)
-- 2. In join_home_group, before validating a private-group invite code,
--    check recent failed attempts and reject if > 10 in the last hour
--    across all groups for this user. After validation, record the attempt.
-- 3. RLS on tracker: only service_role can SELECT/INSERT/UPDATE/DELETE.
-- ============================================================================

-- Tracking table
CREATE TABLE IF NOT EXISTS commander_home_join_attempts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  group_id uuid,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_home_join_attempts_ratelimit
  ON commander_home_join_attempts(user_id, attempted_at DESC);

-- RLS: only server-side code can read/write these rows (SECURITY DEFINER
-- functions will bypass). Direct API access is blocked entirely.
ALTER TABLE commander_home_join_attempts ENABLE ROW LEVEL SECURITY;
-- No policies = all deny (unless service_role bypass applies)

COMMENT ON TABLE commander_home_join_attempts IS
  'Phase 40: rate-limit tracker for join_home_group attempts. Prevents '
  'brute-force of private-group invite codes.';

-- ----------------------------------------------------------------------------
-- Rewrite join_home_group with rate limit
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_home_group(
  p_group_id uuid, p_caller_user_id uuid, p_invite_code text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
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

    -- Phase 40: brute-force protection for private-group invite codes.
    -- Only trigger the rate check when the caller is attempting to use
    -- a code (not when they're joining a public group or re-requesting
    -- after decline without a code).
    IF v_group.is_private THEN
        IF p_invite_code IS NULL THEN
            RAISE EXCEPTION 'INVITE_CODE_REQUIRED';
        END IF;

        -- Count failed attempts in the last hour for this user across all groups
        SELECT COUNT(*) INTO v_failed_attempts
          FROM commander_home_join_attempts
         WHERE user_id = p_caller_user_id
           AND succeeded = false
           AND attempted_at > NOW() - INTERVAL '1 hour';

        IF v_failed_attempts >= 10 THEN
            -- Log this rejection as a failure to escalate further
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

    -- Existing membership check
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

COMMENT ON FUNCTION public.join_home_group IS
  'Phase 40: now rate-limited. After 10 invalid invite-code attempts in '
  '1 hour, the user is blocked for the remainder of the hour. Each attempt '
  '(success or failure) is recorded in commander_home_join_attempts.';

-- Cleanup function to periodically trim old attempts (>7d old)
CREATE OR REPLACE FUNCTION public.fn_cleanup_home_join_attempts()
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM commander_home_join_attempts
   WHERE attempted_at < NOW() - INTERVAL '7 days';
$$;
