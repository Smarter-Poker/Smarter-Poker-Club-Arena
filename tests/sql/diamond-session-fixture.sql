-- Exact deployed session helper body read September 10, 2026.
-- The engine marker is false for these authenticated end-user tests.
CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY, not_after timestamptz);
TRUNCATE auth.sessions;
INSERT INTO auth.sessions VALUES
 ('60000000-0000-0000-0000-000000000001', NULL),
 ('60000000-0000-0000-0000-000000000002', now() - interval '1 day');
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean
 LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_claims jsonb;
  v_sid    uuid;
BEGIN
  IF public.fn_caller_is_engine() THEN
    RETURN true;
  END IF;

  -- Malformed or absent claims are not a crash, they are a refusal.
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_claims IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    v_sid := (v_claims ->> 'session_id')::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_sid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM auth.sessions s
     WHERE s.id = v_sid
       AND (s.not_after IS NULL OR s.not_after > now())
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_caller_session_is_live() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_caller_session_is_live() TO authenticated,service_role;
