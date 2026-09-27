-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506124639 "all_username_paths_use_centralized_reserved_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a98cea2ae1bdff0ce40e3682e29e841b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Wire all 4 username code paths to the centralized is_reserved_username().
-- Eliminates drift between the curated lists.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. check_username_available (legacy, used by signup form) ──────────────
CREATE OR REPLACE FUNCTION public.check_username_available(p_username text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text;
  v_self uuid := auth.uid();
BEGIN
  v_clean := lower(trim(both ' @' from coalesce(p_username, '')));
  IF v_clean = '' OR public.is_reserved_username(v_clean) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE lower(username) = v_clean
      AND (v_self IS NULL OR id <> v_self)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.check_username_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_username_available(text) TO authenticated, anon;

-- 2. check_username_with_suggestions (gate modal availability + chips) ──
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
  v_self uuid := auth.uid();
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

  IF public.is_reserved_username(v_clean) THEN
    RETURN jsonb_build_object(
      'available', false,
      'reason', 'reserved',
      'message', 'That username is reserved. Pick a different one.',
      'suggestions', '[]'::jsonb
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE lower(username) = v_clean
      AND (v_self IS NULL OR id <> v_self)
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
    -- Skip suggestion if it's also reserved (e.g., "admin1", "support2" etc)
    IF public.is_reserved_username(v_candidate) THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE lower(username) = v_candidate
        AND (v_self IS NULL OR id <> v_self)
    ) THEN
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

-- 3. claim_social_profile (gate submit) ─────────────────────────────────
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

  IF public.is_reserved_username(v_clean_username) THEN
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

-- 4. handle_new_user trigger — strips reserved usernames at insert time ──
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    next_player_num BIGINT;
    generated_username TEXT;
    resolved_full_name TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
BEGIN
    resolved_full_name := COALESCE(
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'name', '')), ''),
        NULLIF(TRIM(
            COALESCE(NEW.raw_user_meta_data->>'given_name', '') || ' ' ||
            COALESCE(NEW.raw_user_meta_data->>'family_name', '')
        ), ''),
        ''
    );

    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', '');
    v_last_name  := COALESCE(NEW.raw_user_meta_data->>'last_name',  '');

    IF v_first_name = '' AND v_last_name = '' AND resolved_full_name <> '' THEN
        v_first_name := split_part(resolved_full_name, ' ', 1);
        v_last_name  := CASE
            WHEN position(' ' in resolved_full_name) > 0
            THEN substring(resolved_full_name from position(' ' in resolved_full_name) + 1)
            ELSE ''
        END;
    END IF;

    generated_username := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'poker_alias', ''),
        NULLIF(REGEXP_REPLACE(resolved_full_name, '[^a-zA-Z0-9]', '', 'g'), ''),
        SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
        'Player' || FLOOR(RANDOM() * 10000)::TEXT
    );
    generated_username := LEFT(generated_username, 15);

    -- If the derived username is reserved, fall back to Player<N> so the row
    -- never lands as @admin / @support / @smarterpoker / etc.
    IF public.is_reserved_username(generated_username) THEN
        generated_username := 'Player' || FLOOR(RANDOM() * 100000)::TEXT;
    END IF;

    SELECT nextval('public.profiles_player_number_seq') INTO next_player_num;

    INSERT INTO public.profiles (
        id, full_name, first_name, last_name, email, username, avatar_url,
        player_number, streak_count, diamonds, diamond_multiplier, skill_tier,
        access_tier, is_vip, vip_tier, vip_expires_at,
        created_at, updated_at, last_login, last_active, is_online
    ) VALUES (
        NEW.id, resolved_full_name, v_first_name, v_last_name,
        COALESCE(NEW.email, ''), generated_username,
        COALESCE(NEW.raw_user_meta_data->>'avatar_url',
                 NEW.raw_user_meta_data->>'picture', ''),
        next_player_num, 0, 500, 1.0, 'Newcomer',
        CASE
            WHEN NEW.raw_user_meta_data->>'state' IN ('WA','ID','MI','NV','CA') THEN 'Restricted_Tier'
            ELSE 'Full_Access'
        END,
        true, 'monthly', NOW() + INTERVAL '30 days',
        NOW(), NOW(), NOW(), NOW(), true
    )
    ON CONFLICT (id) DO UPDATE SET
        last_login    = NOW(),
        last_active   = NOW(),
        is_online     = true,
        full_name     = CASE WHEN COALESCE(profiles.full_name, '') = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
        first_name    = CASE WHEN COALESCE(profiles.first_name, '') = '' THEN EXCLUDED.first_name ELSE profiles.first_name END,
        last_name     = CASE WHEN COALESCE(profiles.last_name, '') = '' THEN EXCLUDED.last_name ELSE profiles.last_name END,
        avatar_url    = CASE WHEN COALESCE(profiles.avatar_url, '') = '' THEN EXCLUDED.avatar_url ELSE profiles.avatar_url END,
        player_number = COALESCE(profiles.player_number, EXCLUDED.player_number),
        diamonds      = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        is_vip        = CASE WHEN profiles.is_vip IS NULL OR profiles.is_vip = false THEN true ELSE profiles.is_vip END,
        vip_tier      = CASE WHEN profiles.vip_tier IS NULL THEN 'monthly' ELSE profiles.vip_tier END,
        vip_expires_at= CASE WHEN profiles.vip_expires_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE profiles.vip_expires_at END;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Defensive: never block auth.users INSERT, but DO leave a forensic trail.
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg, raw_meta)
      VALUES (NEW.id, NEW.email, 'handle_new_user', SQLSTATE, SQLERRM, NEW.raw_user_meta_data);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$$;
