-- 20261005221203_dblink_leaves_the_schema_the_data_api_serves.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, blocker 4):
--
-- `dblink` WAS CALLABLE BY ANONYMOUS VISITORS THROUGH /rest/v1/rpc. Read on
-- production: the extension lived in the exposed `public` schema, and
-- dblink_connect, dblink_exec and 39 related functions carried EXECUTE for
-- PUBLIC, anon and authenticated. An unauthenticated request could make the
-- database open outbound connections, and with a known credential run SQL as
-- that credential's role.
--
-- Those grants were made by supabase_admin, the extension's owner, so a REVOKE
-- from here would be a silent no-op. The extension is relocatable, so it is
-- moved to the `extensions` schema, which the Data API does not serve. The one
-- caller, fn_ca_ledger_refusal_record (SECURITY DEFINER), is re-pointed at the
-- new schema in this same transaction and is otherwise byte for byte the
-- installed definition.
--
-- The transaction asserts its own result, so a step that silently did nothing
-- aborts instead of reading as applied.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── dblink leaves the schema the Data API serves ─────────────────────────
ALTER EXTENSION dblink SET SCHEMA extensions;

DO $do$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_ledger_refusal_record(jsonb)'::regprocedure);
  v_new := replace(v_def, 'public.dblink', 'extensions.dblink');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'fn_ca_ledger_refusal_record no longer names public.dblink; re-read it before moving the extension';
  END IF;
  IF v_new ~ '(^|[^.a-z_])dblink(_[a-z_]+)?\s*\(' THEN
    RAISE EXCEPTION 'fn_ca_ledger_refusal_record still carries an unqualified dblink call';
  END IF;
  EXECUTE v_new;
END
$do$;

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_extension e ON e.oid = d.refobjid AND e.extname = 'dblink'
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'dblink functions are still in the public schema';
  END IF;

  IF position('public.dblink' in pg_get_functiondef('public.fn_ca_ledger_refusal_record(jsonb)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'fn_ca_ledger_refusal_record still names public.dblink';
  END IF;
END
$do$;

COMMIT;
