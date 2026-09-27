-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506112348 "add_social_profile_completion_with_username_helpers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84b708ecd1fba0873cc887057f526435 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- SOCIAL PROFILE COMPLETION GATE
-- Keeps existing check_username_available(text) → boolean intact (signup.js
-- depends on it). Adds a new check_username_with_suggestions(text) → jsonb
-- for the completion modal that needs collision-aware alternatives.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Column ───────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS social_profile_completed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.social_profile_completed IS
  'TRUE once the user has confirmed their name, chosen a unique @username, and supplied a phone number. Gates first-time entry to /hub/social-media for OAuth signups.';

-- 2. Backfill ─────────────────────────────────────────────────────────────
UPDATE public.profiles
   SET social_profile_completed = true
 WHERE social_profile_completed = false;

-- 3. Lookup index for fast case-insensitive collision checks ─────────────
CREATE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON public.profiles (lower(username));

-- 4. NEW RPC: check_username_with_suggestions ─────────────────────────────
CREATE OR REPLACE FUNCTION public.check_username_with_suggestions(p_username text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text;
  v_taken boolean;
  v_suggestions text[] := ARRAY[]::text[];
  v_candidate text;
  v_i int := 0;
  v_reserved text[] := ARRAY[
    'admin','root','support','help','smarter','smarterpoker','staff','owner',
    'system','official','moderator','mod','team','poker','jarvis','geeves',
    'bot','api','www','null','undefined','anonymous'
  ];
BEGIN
  v_clean := lower(trim(both ' @' from coalesce(p_username, '')));

  IF v_clean !~ '^[a-z0-9][a-z0-9_.]{2,19}$' THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'invalid_format',
      'message', 'Username must be 3–20 characters using letters, numbers, underscores, or periods.',
      'suggestions', '[]'::jsonb
    );
  END IF;

  IF v_clean = ANY(v_reserved) THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'reserved',
      'message', 'That username is reserved. Pick a different one.',
      'suggestions', '[]'::jsonb
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE lower(username) = v_clean
  ) INTO v_taken;

  IF NOT v_taken THEN
    RETURN jsonb_build_object(
      'available', true,
      'normalized', v_clean,
      'suggestions', '[]'::jsonb
    );
  END IF;

  WHILE array_length(v_suggestions, 1) IS NULL OR array_length(v_suggestions, 1) < 3 LOOP
    v_i := v_i + 1;
    IF v_i > 50 THEN EXIT; END IF;
    v_candidate := CASE
      WHEN v_i <= 9        THEN v_clean || v_i::text
      WHEN v_i <= 15       THEN v_clean || (10 + (v_i - 10) * 7)::text
      WHEN v_i = 16        THEN v_clean || '_' || floor(random() * 9000 + 1000)::text
      WHEN v_i = 17        THEN v_clean || '.' || to_char(now(), 'YY')
      ELSE                       v_clean || '_' || floor(random() * 90000 + 10000)::text
    END;
    IF length(v_candidate) > 20 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = v_candidate) THEN
      IF NOT (v_candidate = ANY(v_suggestions)) THEN
        v_suggestions := v_suggestions || v_candidate;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'available', false,
    'reason', 'taken',
    'message', 'That username is already taken.',
    'suggestions', to_jsonb(v_suggestions)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_username_with_suggestions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_username_with_suggestions(text) TO authenticated, anon;

-- 5. NEW RPC: claim_social_profile ────────────────────────────────────────
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
