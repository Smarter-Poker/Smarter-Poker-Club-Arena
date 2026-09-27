-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506124104 "check_username_available_blocks_reserved_words"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8342cdb3f2740a2f2a8f04608363518d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Align the LEGACY check_username_available(text) -> boolean with the new
-- check_username_with_suggestions reserved-word block. Without this, the
-- email signup form can still hand out @admin / @support / @jarvis / etc.
--
-- Existing user 'SmarterPoker' is unaffected — this function only gates NEW
-- claims. Their row stays as-is.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_username_available(p_username text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean text;
  v_reserved text[] := ARRAY[
    'admin','root','support','help','smarter','smarterpoker','staff','owner',
    'system','official','moderator','mod','team','poker','jarvis','geeves',
    'bot','api','www','null','undefined','anonymous'
  ];
  v_self uuid := auth.uid();
BEGIN
  v_clean := lower(trim(both ' @' from coalesce(p_username, '')));
  IF v_clean = '' OR v_clean = ANY(v_reserved) THEN
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
