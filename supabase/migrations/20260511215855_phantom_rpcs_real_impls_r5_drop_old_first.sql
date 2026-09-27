-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511215855 "phantom_rpcs_real_impls_r5_drop_old_first"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 89c9569a4b669ebcb700157b96998caf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- DROP first (old stub had RETURNS void; new has RETURNS jsonb)
DROP FUNCTION IF EXISTS public.track_training_action(uuid, text, jsonb);

CREATE OR REPLACE FUNCTION public.track_training_action(
  p_user_id uuid, p_action_type text, p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_caller_role text; v_caller_uid uuid; v_event_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_action_type IS NULL OR length(p_action_type) = 0 THEN
    RETURN jsonb_build_object('rewards', '[]'::jsonb);
  END IF;
  v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_caller_uid := auth.uid();
  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR p_user_id <> v_caller_uid THEN
      RETURN jsonb_build_object('rewards', '[]'::jsonb);
    END IF;
  ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN
    RETURN jsonb_build_object('rewards', '[]'::jsonb);
  END IF;
  INSERT INTO public.training_events (user_id, event_type, event_data, created_at)
  VALUES (p_user_id, LEFT(p_action_type, 100), COALESCE(p_metadata, '{}'::jsonb), now())
  RETURNING id INTO v_event_id;
  RETURN jsonb_build_object('rewards', '[]'::jsonb, 'event_id', v_event_id);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'track_training_action failed for user %: % %', p_user_id, SQLERRM, SQLSTATE;
  RETURN jsonb_build_object('rewards', '[]'::jsonb);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.track_training_action(uuid, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.track_training_action(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.track_training_action(uuid, text, jsonb) TO authenticated;
