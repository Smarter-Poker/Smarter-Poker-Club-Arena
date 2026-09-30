-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429022820 "secure_fn_create_story_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fac98385ce0ce3d1a838eaa8dd9fba02 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

REVOKE EXECUTE ON FUNCTION public.fn_create_story(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_create_story(uuid, text, text, text, text, text) FROM anon;

CREATE OR REPLACE FUNCTION public.fn_create_story(
  p_user_id uuid, p_content text, p_media_url text DEFAULT NULL::text,
  p_media_type text DEFAULT NULL::text, p_background_color text DEFAULT NULL::text,
  p_link_url text DEFAULT NULL::text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_story_id uuid; v_caller_role text; v_caller_uid uuid;
BEGIN
  v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_caller_uid := auth.uid();
  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR p_user_id <> v_caller_uid THEN
      RAISE WARNING 'fn_create_story: forbidden author spoof attempt by % targeting %', v_caller_uid, p_user_id;
      RETURN NULL;
    END IF;
  ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN RETURN NULL; END IF;
  INSERT INTO social_stories (author_id, content, media_url, media_type, background_color, link_url, expires_at, created_at)
  VALUES (p_user_id, p_content, p_media_url, p_media_type, p_background_color, p_link_url, now() + interval '24 hours', now())
  RETURNING id INTO v_story_id;
  RETURN v_story_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_create_story failed for user %: % %', p_user_id, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$function$;
