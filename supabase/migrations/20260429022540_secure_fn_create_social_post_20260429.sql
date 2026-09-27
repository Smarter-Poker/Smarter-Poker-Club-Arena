-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429022540 "secure_fn_create_social_post_20260429"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 816137d5df99a1e65124357f9ebf97d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

REVOKE EXECUTE ON FUNCTION public.fn_create_social_post(uuid, text, text, text[], text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_create_social_post(uuid, text, text, text[], text, text, text) FROM anon;

CREATE OR REPLACE FUNCTION public.fn_create_social_post(
  p_author_id uuid,
  p_content text DEFAULT ''::text,
  p_content_type text DEFAULT 'text'::text,
  p_media_urls text[] DEFAULT '{}'::text[],
  p_visibility text DEFAULT 'public'::text,
  p_achievement_data text DEFAULT NULL::text,
  p_thumbnail_url text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_post_id uuid;
  v_media_jsonb jsonb;
  v_caller_role text;
  v_caller_uid uuid;
BEGIN
  v_caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_caller_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    IF v_caller_uid IS NULL OR p_author_id <> v_caller_uid THEN
      RETURN jsonb_build_object('success', false, 'error', 'forbidden: authenticated users may only post as themselves');
    END IF;
  ELSIF v_caller_role = 'anon' OR v_caller_role = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'forbidden: anonymous callers cannot create posts');
  END IF;

  v_media_jsonb := to_jsonb(p_media_urls);

  INSERT INTO social_posts (author_id, content, content_type, media_urls, visibility, metadata, thumbnail_url, created_at, updated_at)
  VALUES (p_author_id, p_content, p_content_type, v_media_jsonb, p_visibility,
    CASE WHEN p_achievement_data IS NOT NULL THEN p_achievement_data::jsonb ELSE NULL END,
    p_thumbnail_url, now(), now())
  RETURNING id INTO v_post_id;

  RETURN jsonb_build_object('success', true, 'id', v_post_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
