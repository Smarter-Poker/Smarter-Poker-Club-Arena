-- A MIGRATION THAT IS APPLIED BUT NOT COMMITTED IS HALF A MIGRATION
--
-- The law is that every migration is BOTH applied to production AND committed
-- to supabase/migrations/. Today's "Applied Migrations Are Recorded" check
-- found 428 of 820 migrations since 2026-08-24 with no file in the repo, so
-- the law is being broken at scale, and the reason is mechanical: an agent
-- that applies SQL through the Supabase MCP has no way to read back exactly
-- what ran, and reconstructing it by hand produces a file that DRIFTS from
-- production while looking authoritative.
--
-- supabase_migrations.schema_migrations already holds the answer. It is just
-- not reachable from anywhere an agent can call. This exposes it, read-only,
-- to service_role, so the committed file can be proven byte-identical to the
-- statements production actually executed rather than retyped and hoped over.
--
-- Deliberately service_role only, and deliberately no write path: migration
-- history is evidence, and evidence you can edit is not evidence.

CREATE OR REPLACE FUNCTION public.fn_ca_migration_text(p_version text)
RETURNS TABLE (
  version   text,
  name      text,
  body      text,
  md5       text,
  byte_len  integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  SELECT
    m.version,
    m.name,
    array_to_string(m.statements, E';\n'),
    md5(array_to_string(m.statements, E';\n')),
    octet_length(array_to_string(m.statements, E';\n'))
  FROM supabase_migrations.schema_migrations m
  WHERE m.version = p_version;
$fn$;

COMMENT ON FUNCTION public.fn_ca_migration_text(text) IS
  'The exact statements a migration executed, with an md5, so a committed file can be PROVEN identical to what production ran instead of reconstructed by hand. Read-only, service_role only. See the 428-uncommitted-migrations finding of 2026-08-31.';

REVOKE ALL ON FUNCTION public.fn_ca_migration_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_migration_text(text) TO service_role;