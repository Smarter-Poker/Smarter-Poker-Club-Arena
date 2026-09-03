-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902174223; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_spin_ladder_drift_check shipped SECURITY DEFINER with the default grant,
-- which means PUBLIC - so an unauthenticated caller could run it, past RLS,
-- and be told every Spin whose payout ladder disagrees with its multiplier.
-- Caught by the pre-push definer-authorization check before the branch landed;
-- closed here because the function was already live in production.
--
-- READ-ONLY IS NOT THE SAME AS HARMLESS. It is diagnostics for operators and
-- the nightly sweeps, and nothing a browser should be able to ask.
--
-- PUBLIC is named as well as the roles: anon inherits whatever PUBLIC holds,
-- so revoking anon alone reads as a fix and does nothing.
--
-- Verified this is not an RLS policy helper (it is new, and no policy
-- expression references it), so revoking it cannot deny a SELECT anywhere.
REVOKE ALL ON FUNCTION public.fn_spin_ladder_drift_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_ladder_drift_check(integer)
  TO service_role;
