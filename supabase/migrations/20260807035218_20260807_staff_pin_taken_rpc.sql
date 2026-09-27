-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807035218 "20260807_staff_pin_taken_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 92cb6d366a4b9c0860c67926453583d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Hash-aware duplicate-PIN check.
-- Staff create/update guard against duplicate PINs with `.eq('pin_code', pin)`.
-- That only works while the plaintext column is populated, which blocks removing
-- it. This RPC performs the same check against the bcrypt hash (falling back to
-- the legacy plaintext column while it still exists), so the routes can stop
-- reading plaintext and the column can then be emptied.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_staff_pin_taken(text, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_staff_pin_taken(
  p_venue_id text,
  p_pin text,
  p_exclude_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.commander_staff s
     WHERE s.venue_id::text = p_venue_id
       AND (p_exclude_id IS NULL OR s.id <> p_exclude_id)
       AND p_pin IS NOT NULL
       AND (
            (s.pin_hash IS NOT NULL AND s.pin_hash = extensions.crypt(p_pin, s.pin_hash))
         OR (s.pin_hash IS NULL     AND s.pin_code = p_pin)
       )
  );
$$;

REVOKE ALL ON FUNCTION public.fn_staff_pin_taken(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_staff_pin_taken(text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_staff_pin_taken(text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_staff_pin_taken(text, text, uuid) TO service_role;
