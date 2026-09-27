-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506115145 "check_username_excludes_self"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f25671d183886841e14875f7868c6a2c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- check_username_with_suggestions must exclude the caller's own row.
-- Without this, every new OAuth signup whose profile was pre-populated with
-- a Google-derived username sees "your own username is taken" when the modal
-- pre-fills the input. auth.uid() is null for anon callers (signup form),
-- which is fine — the IS NULL OR comparison degrades safely.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_self uuid := auth.uid();  -- null for anon callers
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

  -- Exclude self when caller is authenticated
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
    -- Exclude self for suggestion uniqueness too
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
