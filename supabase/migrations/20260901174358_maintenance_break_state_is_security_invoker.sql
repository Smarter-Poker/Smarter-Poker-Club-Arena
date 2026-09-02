-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901174358; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The first version shipped SECURITY DEFINER and the pre-push
-- definer-authorization guard refused it, correctly: a definer function a
-- browser can reach runs with the owner's rights and never asks who is
-- calling. It does not need them. engine_maintenance_break already carries an
-- RLS policy granting anon and authenticated a SELECT, so this reads exactly
-- what the caller could read for themselves. It exists to give the client one
-- stable shape and the self-expiry rule, not to lend it any rights.
--
-- CREATE OR REPLACE cannot change the security attribute, so this is an
-- ALTER. One statement, one transaction, per the production DDL policy.
ALTER FUNCTION public.fn_maintenance_break_state() SECURITY INVOKER;
