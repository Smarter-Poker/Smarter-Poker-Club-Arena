-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506115034 "claim_social_profile_enforce_reserved_words"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d6c1af8a9437eabdee7513709387f5f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- claim_social_profile MUST enforce reserved-word check identically to
-- check_username_with_suggestions, otherwise a caller can bypass the UI
-- (or any client doing its own check) and grab @admin/@support/etc. directly.
-- Also: factor the reserved list and the format regex into the function so
-- both stay in lockstep.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_social_profile(
  p_full_name text,
  p_username  text,
  p_phone     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clean_username text;
  v_clean_phone    text;
  v_clean_name     text;
  v_phone_digits   text;
  v_profile        public.profiles;
  v_reserved text[] := ARRAY[
    'admin','root','support','help','smarter','smarterpoker','staff','owner',
    'system','official','moderator','mod','team','poker','jarvis','geeves',
    'bot','api','www','null','undefined','anonymous'
  ];
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  v_clean_name     := nullif(btrim(coalesce(p_full_name, '')), '');
  v_clean_username := lower(trim(both ' @' from coalesce(p_username, '')));
  v_clean_phone    := nullif(btrim(coalesce(p_phone, '')), '');

  IF v_clean_name IS NULL OR length(v_clean_name) < 2 OR length(v_clean_name) > 80
     OR v_clean_name !~ '[A-Za-zÀ-ÖØ-öø-ÿ]' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_name',
      'message', 'Please enter your full name (2–80 characters).');
  END IF;

  IF v_clean_username !~ '^[a-z0-9][a-z0-9_.]{2,19}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_username',
      'message', 'Username must be 3–20 characters using letters, numbers, underscores, or periods.');
  END IF;

  -- Reserved-word block (was missing — bug fix)
  IF v_clean_username = ANY(v_reserved) THEN
    RETURN jsonb_build_object('success', false, 'error', 'username_reserved',
      'message', 'That username is reserved. Pick a different one.');
  END IF;

  IF v_clean_phone IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phone',
      'message', 'Phone number is required.');
  END IF;
  v_phone_digits := regexp_replace(v_clean_phone, '[^0-9]', '', 'g');
  IF length(v_phone_digits) < 7 OR length(v_phone_digits) > 15 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phone',
      'message', 'Enter a valid phone number (7–15 digits).');
  END IF;

  BEGIN
    UPDATE public.profiles
       SET full_name                 = v_clean_name,
           username                  = v_clean_username,
           phone                     = v_clean_phone,
           social_profile_completed  = true,
           last_active               = now()
     WHERE id = v_uid
     RETURNING * INTO v_profile;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'error', 'username_taken',
        'message', 'That username was just claimed by someone else. Pick another.');
  END;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_missing',
      'message', 'Your profile row is missing — refresh and try again.');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'profile', jsonb_build_object(
      'id',        v_profile.id,
      'full_name', v_profile.full_name,
      'username',  v_profile.username,
      'phone',     v_profile.phone,
      'social_profile_completed', v_profile.social_profile_completed
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_social_profile(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_social_profile(text, text, text) TO authenticated;
