-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225624 "set_push_type_pref_accept_server_user_id"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a906e2464a457aea9ced41bdaed5c3ec of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- set_push_type_pref -- accept an explicit user id from a server context  Tier 2
-- ============================================================================
-- BUG (live): the function derived the caller from auth.uid(), but
-- /api/notifications/push-types calls it with the SERVICE-ROLE client (every API
-- route in this repo uses src/lib/supabaseServerClient). Under service_role
-- there is no `sub` claim, so auth.uid() was NULL and the function always raised
-- 'Authentication required'. The route returned 500 and PushNotificationToggle
-- rolled the switch back -- so NO USER COULD EVER TURN A PUSH CATEGORY OFF.
--
-- RULE (deliberately not keyed on auth.role(), which is 'postgres' for a
-- migration and can vary by connection path):
--   auth.uid() IS NOT NULL  -> an end-user JWT is present. Use it and IGNORE
--                              p_user_id, so a logged-in client can never write
--                              another user's preferences.
--   auth.uid() IS NULL      -> no end-user context, i.e. service_role/postgres.
--                              Trust p_user_id; the API route verified the JWT.
-- `anon` has no EXECUTE grant, so an unauthenticated caller cannot reach the
-- second branch.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_push_type_pref(
  p_key text,
  p_enabled boolean,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_next jsonb;
BEGIN
  IF v_uid IS NULL THEN
    v_uid := p_user_id;  -- trusted server context only (see header)
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_key IS NULL OR length(p_key) = 0 OR length(p_key) > 64 THEN
    RAISE EXCEPTION 'Invalid preference key';
  END IF;

  INSERT INTO public.notification_preferences (user_id, push_type_prefs)
  VALUES (v_uid, CASE WHEN p_enabled THEN '{}'::jsonb
                      ELSE jsonb_build_object(p_key, false) END)
  ON CONFLICT (user_id) DO UPDATE
    SET push_type_prefs = CASE
          -- DEFAULT-ON model: enabling DELETES the key rather than storing true,
          -- so a type added to the catalog later is on for everyone.
          WHEN p_enabled THEN COALESCE(public.notification_preferences.push_type_prefs, '{}'::jsonb) - p_key
          ELSE COALESCE(public.notification_preferences.push_type_prefs, '{}'::jsonb)
               || jsonb_build_object(p_key, false)
        END,
        updated_at = now()
  RETURNING push_type_prefs INTO v_next;

  RETURN v_next;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_push_type_pref(text, boolean, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_push_type_pref(text, boolean, uuid) TO authenticated, service_role;

-- Remove the broken 2-arg overload so nothing can bind to it.
DROP FUNCTION IF EXISTS public.set_push_type_pref(text, boolean);

-- POST-APPLY ASSERTIONS -- exercise the real server path end to end.
DO $$
DECLARE v_res jsonb; v_uid uuid; v_before jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='set_push_type_pref'
       AND pg_get_function_identity_arguments(p.oid) = 'text, boolean'
  ) THEN
    RAISE EXCEPTION 'the broken 2-arg overload still exists';
  END IF;

  SELECT id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RETURN; END IF;

  SELECT push_type_prefs INTO v_before FROM public.notification_preferences WHERE user_id = v_uid;

  v_res := public.set_push_type_pref('system', false, v_uid);
  IF (v_res ->> 'system') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'disable did not persist: %', v_res;
  END IF;

  v_res := public.set_push_type_pref('system', true, v_uid);
  IF v_res ? 'system' THEN
    RAISE EXCEPTION 'enable did not clear the key: %', v_res;
  END IF;

  -- Leave the test user exactly as found.
  UPDATE public.notification_preferences
     SET push_type_prefs = COALESCE(v_before, '{}'::jsonb)
   WHERE user_id = v_uid;
END $$;

-- ROLLBACK
-- (restore the 2-arg body from migration push_type_prefs_atomic_merge)
