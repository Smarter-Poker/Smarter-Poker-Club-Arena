-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905005906; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905005906   (the stamp IS the apply time, UTC: 2026-09-05 00:59:06)
--   name        audit_diagnostics_are_not_anon_surface
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1078 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905005906 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- The two audit diagnostics this sweep touched were executable by `anon`:
-- SECURITY DEFINER, running as the owner past RLS, for a caller with no
-- account, and neither asks who is calling. They are operator telemetry -
-- fleet occupancy, brain-layer fire rates, tournament state - and nothing
-- pre-login has any business reading them. Verified first that neither backs
-- an RLS policy expression (pg_policy scan returned zero rows), because
-- revoking a policy helper denies every SELECT on the tables that call it.
-- PUBLIC is named as well as the roles: anon inherits whatever PUBLIC holds,
-- so revoking anon alone reads as a fix and does nothing.
-- GRANT/REVOKE do not fire pgrst_ddl_watch, so this costs no schema reload.

REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_audit_fleet_health(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_fleet_health(date) TO service_role;
