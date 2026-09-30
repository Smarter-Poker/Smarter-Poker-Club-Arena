-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260807033526 "20260807_staff_pin_hashing_additive"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d2d9ff9b6768e2a653dfd07d5f0bd746 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Staff PIN hashing — ADDITIVE phase (no application change yet).
-- commander_staff.pin_code is stored in plaintext and verifyPin() compares it
-- with a plain equality lookup. This adds a bcrypt hash alongside it plus a
-- verification RPC that checks the hash first and falls back to the plaintext
-- column, so the application can be cut over with zero risk of lockout.
-- pin_code is intentionally RETAINED for rollback safety; it is dropped in a
-- later migration once the app has been serving hash verification cleanly.
--
-- pgcrypto lives in the `extensions` schema on Supabase, so crypt/gen_salt are
-- schema-qualified and `extensions` is included in the function search_path.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_verify_staff_pin(text, text);
--   ALTER TABLE public.commander_staff DROP COLUMN IF EXISTS pin_hash;

ALTER TABLE public.commander_staff
  ADD COLUMN IF NOT EXISTS pin_hash text;

UPDATE public.commander_staff
   SET pin_hash = extensions.crypt(pin_code, extensions.gen_salt('bf', 10))
 WHERE pin_code IS NOT NULL
   AND pin_hash IS NULL;

CREATE OR REPLACE FUNCTION public.fn_verify_staff_pin(p_venue_id text, p_pin text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT s.id
    FROM public.commander_staff s
   WHERE s.venue_id::text = p_venue_id
     AND s.is_active
     AND p_pin IS NOT NULL
     AND (
          (s.pin_hash IS NOT NULL AND s.pin_hash = extensions.crypt(p_pin, s.pin_hash))
       OR (s.pin_hash IS NULL     AND s.pin_code = p_pin)
     )
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.fn_verify_staff_pin(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_verify_staff_pin(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_verify_staff_pin(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_verify_staff_pin(text, text) TO service_role;
