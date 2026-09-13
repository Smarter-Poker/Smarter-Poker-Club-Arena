CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA smarter_private;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$function$;
-- Only the columns actually read by the production request hook.
CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY,
  protocol_version integer NOT NULL,
  lease_generation uuid NOT NULL,
  heartbeat_at timestamptz NOT NULL
);
INSERT INTO public.engine_tournament_leases VALUES
  ('10000000-0000-4000-8000-000000000001',2,
   '50000000-0000-4000-8000-000000000001',clock_timestamp()),
  ('10000000-0000-4000-8000-000000000002',2,
   '50000000-0000-4000-8000-000000000002',clock_timestamp()-interval '10 minutes');
GRANT USAGE ON SCHEMA smarter_private TO anon,authenticated,service_role;
