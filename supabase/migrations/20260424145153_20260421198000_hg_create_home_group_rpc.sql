-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424145153 "20260421198000_hg_create_home_group_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2a6872e9a296e1f0126d27911ed11cf5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Gap closure: no create_home_group RPC existed. Frontend was handling
-- creation as a direct INSERT, which means each frontend flow would need
-- to hand-roll: onboarding check, content-length validation, URL safety
-- check, profile_photo_url presence check, rate limit, and the initial
-- owner membership row.
--
-- Ship a single RPC that:
--   - Verifies caller is onboarded for HG
--   - Caller-identity check (fail-closed)
--   - Length caps (name 80, description 2000)
--   - Rate limit (3 new groups per hour per user)
--   - Creates group + owner membership atomically
--   - Returns group_id and slug for redirect to dashboard

CREATE OR REPLACE FUNCTION public.create_home_group(
  p_caller_user_id uuid,
  p_name           text,
  p_description    text DEFAULT NULL,
  p_is_private     boolean DEFAULT true,
  p_is_21_plus     boolean DEFAULT false,
  p_is_charity     boolean DEFAULT false,
  p_city           text DEFAULT NULL,
  p_state          text DEFAULT NULL,
  p_smoking_policy text DEFAULT NULL,
  p_timezone       text DEFAULT 'America/New_York',
  p_profile_photo_url text DEFAULT NULL
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_group_id uuid;
  v_slug     text;
  v_onboarded_at timestamptz;
BEGIN
  -- Caller identity (fail-closed)
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id THEN
      RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Required field validation
  IF p_name IS NULL OR length(TRIM(p_name)) < 3 THEN
    RAISE EXCEPTION 'NAME_REQUIRED' USING HINT = 'Group name must be 3+ characters';
  END IF;
  IF length(p_name) > 80 THEN
    RAISE EXCEPTION 'NAME_TOO_LONG' USING HINT = 'Max 80 chars';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 2000 THEN
    RAISE EXCEPTION 'DESCRIPTION_TOO_LONG' USING HINT = 'Max 2000 chars';
  END IF;

  -- Profile photo required (matches existing trigger enforcement)
  IF p_profile_photo_url IS NULL OR length(TRIM(p_profile_photo_url)) = 0 THEN
    RAISE EXCEPTION 'PROFILE_PHOTO_REQUIRED'
      USING HINT = 'Upload a group photo before creating';
  END IF;

  -- Onboarding check
  SELECT home_games_onboarded_at INTO v_onboarded_at
    FROM public.profiles WHERE id = p_caller_user_id;
  IF v_onboarded_at IS NULL THEN
    RAISE EXCEPTION 'NOT_ONBOARDED'
      USING HINT = 'Complete HG onboarding before creating a group';
  END IF;

  -- Rate limit (3 new groups per hour per user)
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.fn_try_consume_home_rate_limit(
           p_caller_user_id, 'home_group_create', 3, 60) THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED'
      USING HINT = 'Limit of 3 new groups per hour per user';
  END IF;

  -- Create group + initial owner membership atomically
  INSERT INTO public.commander_home_groups
    (name, description, owner_id, is_private, is_21_plus, is_charity,
     city, state, smoking_policy, timezone, profile_photo_url,
     member_count, is_active, created_at)
  VALUES
    (TRIM(p_name), NULLIF(TRIM(COALESCE(p_description, '')), ''),
     p_caller_user_id, p_is_private, p_is_21_plus, p_is_charity,
     NULLIF(TRIM(COALESCE(p_city, '')), ''),
     NULLIF(TRIM(COALESCE(p_state, '')), ''),
     p_smoking_policy, COALESCE(p_timezone, 'America/New_York'),
     p_profile_photo_url, 1, true, NOW())
  RETURNING id INTO v_group_id;

  INSERT INTO public.commander_home_members
    (group_id, user_id, role, status, joined_at, created_at)
  VALUES
    (v_group_id, p_caller_user_id, 'owner', 'approved', NOW(), NOW());

  -- social_pages row auto-creates via trg_fn_autocreate_home_group_social_page
  -- Read slug after trigger fires
  SELECT slug INTO v_slug FROM public.social_pages
   WHERE linked_entity_type='home_group'
     AND linked_entity_id = v_group_id::text
   LIMIT 1;

  -- Audit-log the creation
  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES
    (v_group_id, p_caller_user_id, 'group', v_group_id, 'group_created',
     jsonb_build_object('name', LEFT(p_name, 80),
                        'is_private', p_is_private,
                        'city', p_city));

  RETURN jsonb_build_object(
    'success',  true,
    'group_id', v_group_id,
    'slug',     v_slug,
    'redirect_to', '/hub/home-games/' || COALESCE(v_slug, v_group_id::text) || '/dashboard'
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.create_home_group(
  uuid, text, text, boolean, boolean, boolean, text, text, text, text, text)
 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_home_group(
  uuid, text, text, boolean, boolean, boolean, text, text, text, text, text)
 TO authenticated, service_role;
