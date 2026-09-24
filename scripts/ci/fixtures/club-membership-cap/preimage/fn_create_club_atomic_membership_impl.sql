CREATE OR REPLACE FUNCTION public.fn_create_club_atomic_membership_impl(p_request_id uuid, p_name text, p_description text DEFAULT NULL::text, p_color_theme text DEFAULT 'royal-blue'::text, p_is_public boolean DEFAULT true, p_requires_approval boolean DEFAULT false, p_logo_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(COALESCE(p_name, ''));
  v_description text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_existing uuid;
  v_club public.clubs%ROWTYPE;
  v_code integer;
  v_slug_root text;
  v_memberships integer;
  v_attempt integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A creation request ID is required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_entry_feature_flags f WHERE f.key = 'create_club'
      AND (NOT f.enabled OR ((hashtextextended(v_uid::text || ':' || f.key, 44119)
          & 9223372036854775807) % 100) >= f.rollout_percent)
  ) THEN
    RAISE EXCEPTION 'Club creation is temporarily unavailable.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_name) < 3 OR length(v_name) > 30 THEN
    RAISE EXCEPTION 'Club name must be between 3 and 30 characters' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 77431));
  PERFORM pg_advisory_xact_lock(77432);

  SELECT club_id INTO v_existing
    FROM public.club_creation_requests
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = v_existing;
    RETURN to_jsonb(v_club);
  END IF;

  IF EXISTS (SELECT 1 FROM public.clubs WHERE lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'A club with this name already exists' USING ERRCODE = '23505';
  END IF;

  SELECT count(*) INTO v_memberships
    FROM public.club_members
   WHERE user_id = v_uid AND status IN ('active', 'approved');
  IF v_memberships >= 10 THEN
    RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to create a new one.'
      USING ERRCODE = '23514';
  END IF;

  v_slug_root := trim(both '-' FROM regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_slug_root = '' THEN v_slug_root := 'club'; END IF;

  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 25 THEN
      RAISE EXCEPTION 'Could not allocate a unique club code. Please try again.';
    END IF;
    v_code := 10000 + floor(random() * 90000)::integer;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.clubs WHERE club_id = v_code);
  END LOOP;

  INSERT INTO public.clubs (
    club_id, name, slug, description, color_theme, is_public,
    requires_approval, owner_id, level, logo_url, avatar_url
  ) VALUES (
    v_code, v_name, left(v_slug_root, 42) || '-' || v_code::text,
    v_description, COALESCE(NULLIF(btrim(p_color_theme), ''), 'royal-blue'),
    COALESCE(p_is_public, true), COALESCE(p_requires_approval, false),
    v_uid, 1, NULLIF(p_logo_url, ''), NULLIF(p_logo_url, '')
  ) RETURNING * INTO v_club;

  INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance)
  VALUES (v_club.id, v_uid, 'owner', 'active', 0);

  INSERT INTO public.club_creation_requests (user_id, request_id, club_id)
  VALUES (v_uid, p_request_id, v_club.id);

  RETURN to_jsonb(v_club);
END;
$function$
