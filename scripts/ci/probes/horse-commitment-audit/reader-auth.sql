-- Isolated synthetic fixture only; no gateway, JWT or production authority proof.
-- Function body copied exactly from the owner's 2026-09-17 auth.role readback.
-- Its intentional space after SELECT differs from the historical excerpt:
-- prosrc MD5 f31486fed08a7402e89d4aa71b0ad273.
-- E-string preserves the installed body whitespace without trailing source spaces.
-- Schema/function grants below are explicit disposable fixture setup, not a
-- claim that these are the installed provider's complete effective privileges.
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS E'\n  select \n  coalesce(\n    nullif(current_setting(''request.jwt.claim.role'', true), ''''),\n    (nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb ->> ''role'')\n  )::text\n'
;

REVOKE ALL ON FUNCTION auth.role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO anon,authenticated,service_role;
