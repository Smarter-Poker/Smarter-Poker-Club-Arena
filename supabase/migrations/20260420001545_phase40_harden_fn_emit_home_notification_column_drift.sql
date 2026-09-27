-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420001545 "phase40_harden_fn_emit_home_notification_column_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0587d193d3deb389472ad62e69febef2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- Phase 40 — CRITICAL: fn_emit_home_notification had schema drift.
--
-- The function uses dynamic SQL: EXECUTE format('SELECT (%I)::text ...',
-- p_pref_column). When p_pref_column refers to a column that doesn't exist
-- on user_notification_preferences, Postgres raises 42703 and the entire
-- transaction aborts.
--
-- Audit showed 10 of 16 preference-column strings passed by callers do NOT
-- exist on user_notification_preferences. Every home-game trigger that
-- emits notifications (game created, cancelled, RSVP, reminder, recap
-- prompt, host broadcast, member status, post created) has been silently
-- blocking its parent operation for any user with a preferences row.
--
-- Fix: wrap the preference SELECT in its own BEGIN/EXCEPTION block. If the
-- column doesn't exist (42703) or the table has any other issue, we default
-- to allowing the notification — a non-existent preference column cannot be
-- an opt-out. This keeps the underlying operation (game create, RSVP, etc)
-- always committing.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_emit_home_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_link text,
  p_data jsonb,
  p_pref_column text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_allowed boolean := true;
    v_pref_val text;
BEGIN
    IF p_user_id IS NULL THEN RETURN; END IF;

    -- Check user pref if column name provided; default allow on any error
    IF p_pref_column IS NOT NULL THEN
      BEGIN
        EXECUTE format('SELECT (%I)::text FROM user_notification_preferences WHERE user_id = $1', p_pref_column)
             INTO v_pref_val
            USING p_user_id;
        IF v_pref_val = 'false' THEN v_allowed := false; END IF;
      EXCEPTION
        WHEN undefined_column THEN
          -- Schema drift: column doesn't exist → treat as opted-in
          RAISE WARNING 'fn_emit_home_notification: preference column % does not exist, defaulting to allow',
            p_pref_column;
          v_allowed := true;
        WHEN OTHERS THEN
          -- Any other failure (permissions, table missing, etc) → default allow
          RAISE WARNING 'fn_emit_home_notification: could not read pref %: % (%), defaulting to allow',
            p_pref_column, SQLERRM, SQLSTATE;
          v_allowed := true;
      END;
    END IF;

    IF v_allowed THEN
      BEGIN
        INSERT INTO notifications (user_id, type, title, message, link, data, read)
        VALUES (p_user_id, p_type, p_title, p_message, p_link, COALESCE(p_data, '{}'::jsonb), false);
      EXCEPTION WHEN OTHERS THEN
        -- Even the insert itself must not block the parent operation.
        -- Notifications are nice-to-have; game creation/RSVP is critical.
        RAISE WARNING 'fn_emit_home_notification: failed to insert notification: % (%)',
          SQLERRM, SQLSTATE;
      END;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.fn_emit_home_notification IS
  'Phase 40: emits a notification to a user, respecting their preference '
  'opt-out. Entirely defensive: a missing preference column, missing row, '
  'or insert failure will NEVER block the caller. Notifications are '
  'opportunistic; parent DB operations must always commit.';
